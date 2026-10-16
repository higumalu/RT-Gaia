"""GPU Monte Carlo 引擎：`run(input, workdir, progress) -> CalcResult`，跟 OpenTOPAS 引擎同一個介面、同一個射源模型。

* 病人：`topas.patient_on_grid`（同一份密度與材質、同一個計算網格與內插、同一套空氣規則）。
* 射源：`topas.source_plan`（每一小段的錐角、歷史數、換算 M 都一樣）；準直器在 GPU 上算鎢的衰減、不模擬散射。
* MU 校正：跟 TOPAS 同一個參考條件（10 × 10、SSD 100、水中 dmax、水箱 40 × 30 × 40 cm、1 cm × 2 mm × 1 cm 計分），
  快取在資料目錄（模型或引擎一改就重算；GPU 上約十秒）。
* 不確定度：批次法（`BATCHES` 批）。
"""

from __future__ import annotations

import dataclasses
import json
import math
import time
from pathlib import Path
from typing import Any

import numpy as np

from .. import beam_models
from ..delivery import Beam, bld_to_lps
from ..engines import topas
from ..package import CalcInput, CalcResult
from . import tables, transport

ENGINE_VERSION = "rtgaia-gpumc 3"
BATCHES = 10
DEFAULT_HISTORIES = 200_000_000
CALIBRATION_HISTORIES = 100_000_000
JAW_HALF_WIDTH_MM = topas.JAW_WIDTH_MM / 2


EC_LINES = 40
"""電子污染能譜的離散線數（指數分佈切在標稱能量）。"""


def electron_spectrum(mean_mev: float, max_mev: float, lines: int = EC_LINES) -> tuple[np.ndarray, np.ndarray]:
    """電子污染的能譜：exp(−E／平均)，0.1 MeV 到標稱能量，`lines` 段的中點與機率。"""
    edges = np.linspace(0.1, max(0.2, max_mev), lines + 1)
    mids = (edges[:-1] + edges[1:]) / 2
    w = np.exp(-mids / max(mean_mev, 1e-3)) * np.diff(edges)
    return mids, w / w.sum()


def _device(
    axis: int, spec: dict[str, Any], bounds: list[float], neg: list[list[float]], pos: list[list[float]]
) -> dict:
    return {
        "axis": axis,
        "top": float(spec["source_to_upstream_mm"]),
        "thick": float(spec["thickness_mm"]),
        "dens": float(spec.get("density_factor") or 1.0),
        "bounds": bounds,
        "neg": neg,
        "pos": pos,
    }


def beam_source(beam: Beam, model: dict[str, Any], histories: int) -> tuple[transport.BeamSource, float]:
    """`topas.source_plan` → kernel 的陣列；回 (射源, 換算 M)。"""
    p = model["params"]
    plan = topas.source_plan(beam, model, histories)
    states = plan.states
    col = p["collimators"]
    devs: list[dict] = []
    jaw_rows = [-JAW_HALF_WIDTH_MM, JAW_HALF_WIDTH_MM]
    for key, axis in (("fixed_y", 1), ("fixed_x", 0)):
        if key in col:
            h = float(col[key]["half_field_mm"])
            devs.append(_device(axis, col[key], jaw_rows, [[-h]] * len(states), [[h]] * len(states)))
    if "jaw_y" in col:
        devs.append(
            _device(1, col["jaw_y"], jaw_rows, [[cp.jaw_y[0]] for cp, _ in states], [[cp.jaw_y[1]] for cp, _ in states])
        )
    if "jaw_x" in col:
        devs.append(
            _device(0, col["jaw_x"], jaw_rows, [[cp.jaw_x[0]] for cp, _ in states], [[cp.jaw_x[1]] for cp, _ in states])
        )
    names = beam.mlc_devices or (["MLCX"] if beam.leaf_boundaries_mm else [])
    for bounds, a_attr, b_attr, name in (
        (beam.leaf_boundaries_mm, "mlc_a", "mlc_b", names[0] if names else None),
        (beam.leaf2_boundaries_mm, "mlc2_a", "mlc2_b", "MLCX2"),
    ):
        if not bounds or name is None or getattr(states[0][0], a_attr) is None:
            continue
        rows_a = [getattr(cp, a_attr) for cp, _ in states]
        rows_b = [getattr(cp, b_attr) for cp, _ in states]
        # DLG（dosimetric leaf gap，等中心平面 mm）：圓弧葉端的透光 → 每對葉片的開口兩側各放大 DLG／2
        half_dlg = float(col[name].get("dlg_mm") or 0.0) / 2
        neg = [
            [min(a, b) - half_dlg for a, b in zip(ra, rb, strict=True)] for ra, rb in zip(rows_a, rows_b, strict=True)
        ]
        pos = [
            [max(a, b) + half_dlg for a, b in zip(ra, rb, strict=True)] for ra, rb in zip(rows_a, rows_b, strict=True)
        ]
        devs.append(_device(0, col[name], list(bounds), neg, pos))
    dev_i, dev_f, bnd, posv = [], [], [], []
    for d in devs:
        nleaf = len(d["bounds"]) - 1
        dev_i.append([d["axis"], nleaf, len(bnd), len(posv)])
        dev_f.append([d["top"], d["thick"], d["dens"]])
        bnd.extend(d["bounds"])
        for neg_row, pos_row in zip(d["neg"], d["pos"], strict=True):
            for lo, hi in zip(neg_row, pos_row, strict=True):
                posv.extend([lo, hi])
    hist_ec = plan.hist_ec or [0] * len(states)
    counts = np.asarray(
        [a + b + c for a, b, c in zip(plan.hist_pr, plan.hist_ef, hist_ec, strict=True)], dtype=np.uint64
    )
    cum = np.concatenate([[0], np.cumsum(counts)]).astype(np.uint64)
    rot = np.asarray(
        [bld_to_lps(cp.gantry_deg, cp.collimator_deg, cp.couch_deg, beam.patient_position).ravel() for cp, _ in states]
    )
    cones_c = plan.cones_c or [(0.0, 0.0)] * len(states)
    cone = np.asarray([[*cpm, *cem, *ccm] for cpm, cem, ccm in zip(plan.cones_p, plan.cones_e, cones_c, strict=True)])
    ef = p.get("extra_focal") or {}
    ec = p.get("electron_contamination") or {}
    ec_e, ec_w = electron_spectrum(float(ec.get("mean_energy_mev") or 1.0), float(model["energy_mv"]))
    sig = p.get("angular_sigma_deg")
    src = transport.BeamSource(
        cum=cum,
        nef=np.asarray(plan.hist_ef, dtype=np.int32),
        rot=rot,
        cone=cone,
        iso=tuple(float(v) for v in beam.isocenter_lps),
        sad=float(beam.sad_mm),
        z_ef=float(plan.z_ef),
        sigma_focal=float(p["focal_spot_sigma_mm"]),
        sigma_ef=float(ef.get("sigma_mm") or 0.0),
        m_spread=math.sin(math.radians(float(sig)) / 2) if sig else 0.0,
        dev_i=np.asarray(dev_i, dtype=np.int32).reshape(-1, 4),
        dev_f=np.asarray(dev_f, dtype=np.float32).reshape(-1, 3),
        bounds=np.asarray(bnd if bnd else [0.0], dtype=np.float32),
        positions=np.asarray(posv if posv else [0.0, 0.0], dtype=np.float32),
        energies_mev=np.asarray(p["spectrum_mev"], dtype=np.float64),
        weights=np.asarray(p["spectrum_weights"], dtype=np.float64),
        nec=np.asarray(hist_ec, dtype=np.int32),
        z_ec=float(plan.z_ec),
        sigma_ec=float(ec.get("sigma_mm") or 0.0),
        ec_energies_mev=ec_e,
        ec_weights=ec_w,
    )
    radial = topas.radial_profile(model)
    if radial is not None:
        src.radial_r_mm, src.radial_w = radial
    return src, plan.m_equiv


def calibration_key(model: dict[str, Any]) -> str:
    return f"gpu-{model['model_id']}-{beam_models.model_hash(model)}-{ENGINE_VERSION.replace(' ', '_')}"


def calibration(model: dict[str, Any], cache_dir: Path, tb: tables.Tables, *, progress: Any = None) -> float:
    """每 MU 幾個歷史（同 `topas.calibration` 的定義與參考條件）。快取。"""
    cache_dir.mkdir(parents=True, exist_ok=True)
    cached = cache_dir / f"{calibration_key(model)}.json"
    if cached.exists():
        return float(json.loads(cached.read_text(encoding="utf-8"))["histories_per_mu"])
    c = model["calibration"]
    ref = topas.reference_beam(model)
    nb = max(1, CALIBRATION_HISTORIES // BATCHES)
    src, m_equiv = beam_source(ref, model, nb)
    # 水箱：x −200…200（40 格）、y 0…300（150 格，2 mm）、z −200…200（40 格）；表面在等中心（y ＝ 0）
    mat = np.full((40, 150, 40), tables.WATER, dtype=np.uint8)
    rho = np.ones(mat.shape, dtype=np.float32)
    spacing, corner = (10.0, 2.0, 10.0), (-200.0, 0.0, -200.0)

    def prog(f: float) -> None:
        if progress is not None:
            progress("calibrating", 5.0 * f, "MU calibration")

    mean, _sd, info = transport.simulate_beam(
        tb, mat, rho, spacing, corner, src, batches=BATCHES, seed=12345, progress=prog
    )
    dose = transport.dose_gy_per_history(mean, rho, spacing)  # nb 個歷史的總和
    axis = dose[19:21, :, 19:21].mean(axis=(0, 2))
    smooth = np.convolve(axis, np.ones(3) / 3, mode="same")
    j = int(np.argmax(smooth[1:-1])) + 1
    d_per_hist = float(smooth[j]) / m_equiv
    hpm = float(c["gy_per_mu"]) / d_per_hist
    doc = {
        "model_id": model["model_id"],
        "model_hash": beam_models.model_hash(model),
        "engine_version": ENGINE_VERSION,
        "histories": nb * BATCHES,
        "dmax_mm": (j + 0.5) * 2.0,
        "dose_per_history_gy": d_per_hist,
        "histories_per_mu": hpm,
        "depth_dose_gy": [float(x) for x in axis],
        "depth_step_mm": 2.0,
        "seconds": info["seconds"],
    }
    cached.write_text(json.dumps(doc), encoding="utf-8")
    return hpm


def run(inp: CalcInput, workdir: Any, progress: Any) -> CalcResult:
    t0 = time.time()
    out = Path(workdir)
    data_dir = out.parent.parent
    model = inp.beam_model
    histories = int(inp.options.get("histories") or DEFAULT_HISTORIES)
    seed = int(inp.options.get("seed") or 1)
    progress("preparing", 0.0, "physics tables")
    tb = tables.build(data_dir / "gpumc", image=topas.IMAGE, g4data=topas.g4data())
    progress("preparing", 1.0, "patient")
    out_grid = inp.dose_grid
    grid = topas.calc_grid(out_grid, inp.options.get("calc_spacing_mm"))
    inp = dataclasses.replace(inp, dose_grid=grid)
    _codes, rho, mat, pinfo = topas.patient_on_grid(inp)
    corner = tuple(float(o - s / 2) for o, s in zip(grid.origin, grid.spacing, strict=True))
    hpm = calibration(model, data_dir / "calibration", tb, progress=progress)
    alternatives = (
        list((model.get("fit") or {}).get("alternatives") or []) if inp.options.get("model_sensitivity") else []
    )
    # 敏感度要多算幾次：進度條把主計算放在前面、每個變體各一段
    span = 95.0 / (1 + len(alternatives))

    def run_plan(
        m: dict[str, Any], h: float, base: float, label: str
    ) -> tuple[dict[int, np.ndarray], np.ndarray, dict[str, Any]]:
        return _simulate_plan(inp, m, h, tb, mat, rho, grid, corner, histories, seed, base, span, label, progress)

    per_beam, var_total, stats = run_plan(model, hpm, 5.0, "")
    air = (rho < topas.AIR_DENSITY_LIMIT) | (mat == 0)
    numbers = list(per_beam)
    dose = np.where(air, np.nan, np.sum(list(per_beam.values()), axis=0))
    sensitivity = []
    for i, alt in enumerate(alternatives):
        variant = beam_models.with_overrides(model, alt["overrides"], f"~alt{i + 1}")
        h = calibration(variant, data_dir / "calibration", tb)
        alt_beams, _v, _s = run_plan(variant, h, 5.0 + span * (i + 1), f"{alt['stage']} {i + 1}")
        alt_dose = np.where(air, np.nan, np.sum(list(alt_beams.values()), axis=0))
        sensitivity.append({**alt, **dose_ratio(dose, alt_dose)})
    sigma = np.where(air, np.nan, np.sqrt(var_total))
    per_list = [np.where(air, np.nan, per_beam[n]) for n in numbers]
    if grid is not out_grid:
        dose, sigma, *per_list = topas.to_output([dose, sigma, *per_list], grid, out_grid)
        _c, rho_o, mat_o, _i = topas.patient_on_grid(dataclasses.replace(inp, dose_grid=out_grid))
        air = (rho_o < topas.AIR_DENSITY_LIMIT) | (mat_o == 0)
        dose = np.where(air, np.nan, dose)
        per_list = [np.where(air, np.nan, v) for v in per_list]
    with np.errstate(invalid="ignore", divide="ignore"):
        unc = np.where(dose > 0, sigma / dose, np.nan).astype(np.float32)
    unc = np.where(np.isnan(dose), np.nan, unc).astype(np.float32)
    return CalcResult(
        dose_gy=np.asarray(dose, dtype=np.float32),
        uncertainty=unc,
        per_beam_gy={n: v.astype(np.float32) for n, v in zip(numbers, per_list, strict=True)},
        info={
            "engine": "gpu",
            "engine_version": ENGINE_VERSION,
            "seconds": round(time.time() - t0, 1),
            "seconds_transport": round(stats["seconds"], 1),
            "histories": stats["histories"],
            "histories_per_mu": hpm,
            "dose_quantity": "to medium",
            "calibration": pinfo,
            "physics": "rtgaia-gpumc: Geant4 opt4 tables, class II condensed history, mixed elastic scattering",
            "collimator_absorbed_fraction": float(np.mean(stats["absorbed"])) if stats["absorbed"] else 0.0,
            "air_voxels": int(air.sum()),
            "calc_grid": {"size": list(grid.size), "spacing_mm": list(grid.spacing)},
            "notes": [topas.AIR_NOTE, GPU_NOTE if "electron_contamination" not in model["params"] else GPU_NOTE_EC]
            + sensitivity_notes(inp.options.get("model_sensitivity"), sensitivity),
            **({"model_sensitivity": sensitivity} if inp.options.get("model_sensitivity") else {}),
        },
    )


def _simulate_plan(
    inp: CalcInput,
    model: dict[str, Any],
    hpm: float,
    tb: tables.Tables,
    mat: np.ndarray,
    rho: np.ndarray,
    grid: Any,
    corner: tuple[float, ...],
    histories: int,
    seed: int,
    base: float,
    span: float,
    label: str,
    progress: Any,
) -> tuple[dict[int, np.ndarray], np.ndarray, dict[str, Any]]:
    """一個模型算整份計畫（計算網格上，每個射束的 Gy 與合成的變異數）。種子只跟射束編號有關 → 同一份計畫換模型
    （敏感度的變體）時雜訊高度相關，比值的雜訊小。"""
    beams = inp.delivery.beams
    total_mu = sum(b.mu for b in beams)
    per_beam: dict[int, np.ndarray] = {}
    var_total = np.zeros(mat.shape)
    stats: dict[str, Any] = {"seconds": 0.0, "histories": 0, "absorbed": []}
    done = 0.0
    for beam in beams:
        n_beam = max(topas.MIN_HISTORIES_PER_BEAM, int(round(histories * beam.mu / total_mu)))
        nb = max(1, n_beam // BATCHES)
        src, m_equiv = beam_source(beam, model, nb)
        share = beam.mu / total_mu
        name = f"{label} · {beam.name}" if label else beam.name

        def prog(f: float, done: float = done, w: float = share, name: str = name) -> None:
            progress("calculating", base + span * (done + w * f), name)

        mean, sd, info = transport.simulate_beam(
            tb, mat, rho, tuple(grid.spacing), corner, src, batches=BATCHES, seed=seed * 1000 + beam.number,
            progress=prog,
        )  # fmt: skip
        stats["seconds"] += info["seconds"]
        stats["histories"] += info["histories"]
        stats["absorbed"].append(info["absorbed_fraction"])
        scale = beam.mu * hpm / m_equiv * inp.delivery.fractions
        dose = transport.dose_gy_per_history(mean, rho, tuple(grid.spacing))
        sigma = transport.dose_gy_per_history(sd, rho, tuple(grid.spacing))
        per_beam[beam.number] = (dose * scale).astype(np.float32)
        var_total += (sigma * scale) ** 2
        done += share
    return per_beam, var_total, stats


SENSITIVITY_HIGH_DOSE = 0.5
"""敏感度比的是劑量 ≥ 參考最大值（第 99.5 百分位）50% 的體素 —— 跟不確定度摘要、γ 的高劑量區一致。"""


def dose_ratio(dose: np.ndarray, other: np.ndarray) -> dict[str, float | None]:
    """變體 ÷ 主計算在高劑量區的比值：中位數與 5／95 百分位（同一組種子，雜訊大部分相消）。"""
    ok = np.isfinite(dose) & np.isfinite(other) & (dose > 0)
    if not ok.any():
        return {"median_ratio": None, "p5_ratio": None, "p95_ratio": None}
    hi = ok & (dose >= SENSITIVITY_HIGH_DOSE * float(np.percentile(dose[ok], 99.5)))
    r = other[hi] / dose[hi]
    return {
        "median_ratio": float(np.median(r)),
        "p5_ratio": float(np.percentile(r, 5)),
        "p95_ratio": float(np.percentile(r, 95)),
    }


def sensitivity_notes(requested: Any, sensitivity: list[dict[str, Any]]) -> list[str]:
    if not requested:
        return []
    if not sensitivity:
        return [SENSITIVITY_NONE]
    worst = max(abs(float(x["median_ratio"]) - 1.0) for x in sensitivity if x.get("median_ratio") is not None)
    pct = f"{100 * worst:.1f}"
    return [f"射束模型擬合裡一樣好的其他參數，讓高劑量區的劑量最多差 {pct}%（中位數；見模型敏感度）"]


SENSITIVITY_NONE = "射束模型沒有弱約束的參數（或不是擬合出來的模型）：沒有算模型敏感度"


GPU_NOTE = "GPU Monte Carlo：機頭只算鎢的衰減，沒有準直器散射與電子污染（跟 OpenTOPAS 的機頭模擬比，絕對劑量約高 1.5%）"
GPU_NOTE_EC = "GPU Monte Carlo：機頭只算鎢的衰減（不模擬準直器散射）；電子污染用射束模型的虛擬射源"
