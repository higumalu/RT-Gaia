"""射束模型對射束資料：每一筆量測在同樣的條件下用模型模擬（`water`），逐點比 —— 擬合與驗證的量尺。

`plan_checks(model, dataset)` 把資料集的量測拆成「要模擬的條件」（同條件的量測共用一次模擬）與「每一點怎麼取值」；
`run_checks` 模擬並回報：每一點的量測值、模型值、差（絕對、%）、兩邊不確定度合成後的 z、是否在容許內。

* 不支援的量測（TPR／TMR 曲線、葉端偏移與 DLG 的掃描間隙、jaw 穿透…）照列，標 `unsupported` 與原因，不默默略過。
* 幾何規格（葉片高度、葉端半徑）直接跟模型參數比，不模擬。
* 容許（`TOLERANCE`）：劑量比 1%、位置 1 mm（比 TPS commissioning 常用的 2%／2 mm 嚴，roadmap 的起點門檻）；
  輸出因子 1%、穿透 0.1 個百分點、unflatness 1%、slope 10%。
* 輸出因子是「總散射因子」：量測含監測游離腔的反散射，模型目前沒有這一項 → 大射野的差會系統性地偏一邊。
"""

from __future__ import annotations

import math
import time
from dataclasses import dataclass, field
from typing import Any

import numpy as np

from . import water

LAYER_DEVICE = {"distal": "MLCX1", "lower": "MLCX1", "proximal": "MLCX2", "upper": "MLCX2"}
TOLERANCE = {
    "pdd": ("percent_points", 1.0),
    "dmax_mm": ("mm", 1.0),
    "tpr20_10": ("relative", 0.01),
    "pdd10x": ("percent_points", 1.0),
    "penumbra_80_20_mm": ("mm", 1.0),
    "fwhm_mm": ("mm", 1.0),
    "unflatness": ("relative", 0.01),
    "slope_percent_per_mm": ("relative", 0.10),
    "output_factor": ("relative", 0.01),
    "gy_per_mu": ("relative", 0.01),
    "mlc_transmission": ("absolute", 0.001),
    "leaf_height_mm": ("mm", 1.0),
    "leaf_end_radius_mm": ("mm", 5.0),
}
"""量值 → （容許的種類、大小）。percent_points：PDD 的百分點；relative：相對差；absolute：同單位的絕對差。"""
PROFILE_QUANTITIES = ("penumbra_80_20_mm", "fwhm_mm", "unflatness", "slope_percent_per_mm")
DEFAULT_SSD = 1000.0


@dataclass
class Check:
    """一個比較點。`setup` 為 None 的是不用模擬的（幾何規格）或不支援的。"""

    measurement_id: str
    label: str
    quantity: str
    x: float | None
    """深度、射野邊長或 None。"""
    measured: float
    u_measured: float | None
    setup: water.Setup | None = None
    reference: water.Setup | None = None
    """輸出因子的參考射野（同 SSD、深度）。"""
    depth: float | None = None
    unsupported: str = ""
    model_value: float | None = None
    u_model: float | None = None
    extra: dict[str, Any] = field(default_factory=dict)


def _field(cond: dict[str, Any]) -> tuple[float, float] | None:
    f = cond.get("field_mm")
    return (float(f[0]), float(f[1])) if f else None


def _collimation(model: dict[str, Any], cond: dict[str, Any]) -> str:
    has_jaws = "jaw_x" in model["params"]["collimators"]
    c = cond.get("collimation")
    if c == "mlc" or not has_jaws:
        return "mlc"
    return "jaw"


def _ssd(cond: dict[str, Any]) -> tuple[float, str]:
    """SSD；只給 SAD 的（等中心擺位）→ SSD ＝ SAD − 深度；都沒有 → 100 cm 並在備註寫出來。"""
    if "ssd_mm" in cond:
        return float(cond["ssd_mm"]), ""
    if "sad_mm" in cond:
        return float(cond["sad_mm"]) - float(cond.get("depth_mm") or 0.0), ""
    return DEFAULT_SSD, "條件沒寫 SSD：用 100 cm"


def plan_checks(model: dict[str, Any], dataset: dict[str, Any]) -> list[Check]:
    """資料集 → 比較點（還沒模擬）。"""
    out: list[Check] = []
    fff = model.get("fluence_mode") == "FFF"
    for m in dataset.get("measurements") or []:
        mid, kind, q = m["measurement_id"], m["kind"], m["quantity"]
        cond = m.get("conditions") or {}
        label = m.get("label") or mid
        cols = m.get("columns") or []
        vi = cols.index("value") if "value" in cols else 0
        ui = cols.index("uncertainty") if "uncertainty" in cols else None

        def unc(row: list[Any], scale: float = 1.0, ui: int | None = ui) -> float | None:
            v = row[ui] if ui is not None and len(row) > ui else None
            return None if v is None else float(v) * scale

        ssd, note = _ssd(cond)
        col = _collimation(model, cond)

        def base(mid: str = mid, label: str = label, note: str = note, **kw: Any) -> Check:
            c = Check(mid, label, **kw)
            if note:
                c.extra["note"] = note
            setup = kw.get("setup")
            if setup is not None and setup.collimation == "mlc":
                why = water.field_note(model, setup)
                if why:
                    c.extra["note"] = "；".join(x for x in (c.extra.get("note"), why) if x)
            return c

        if kind == "depth_dose":
            f = _field(cond)
            if q != "pdd" or f is None:
                for row in m["points"]:
                    out.append(
                        base(
                            quantity=q,
                            x=row[0],
                            measured=row[vi],
                            u_measured=unc(row),
                            unsupported="只支援 PDD（TPR／TMR 曲線之後加）",
                        )
                    )
                continue
            if cond.get("normalization") not in (None, "dmax"):
                for row in m["points"]:
                    out.append(
                        base(
                            quantity="pdd",
                            x=row[0],
                            measured=row[vi],
                            u_measured=unc(row),
                            unsupported="只支援以 dmax 正規化的 PDD",
                        )
                    )
                continue
            scale = 100.0 if m.get("unit") == "fraction" else 1.0
            s = water.Setup(f[0], f[1], ssd, col)
            for row in m["points"]:
                out.append(
                    base(
                        quantity="pdd",
                        x=float(row[0]),
                        measured=float(row[vi]) * scale,
                        u_measured=unc(row, scale),
                        setup=s,
                        depth=float(row[0]),
                    )
                )
        elif kind == "output_factor":
            depth = float(cond["depth_mm"])
            ref = _field({"field_mm": cond.get("reference_field_mm")}) or (100.0, 100.0)
            refs = water.Setup(ref[0], ref[1], ssd, col)
            rect = cols and cols[0] == "field_x_mm"
            for row in m["points"]:
                fx, fy = (float(row[0]), float(row[1])) if rect else (float(row[0]), float(row[0]))
                out.append(
                    base(
                        quantity="output_factor",
                        x=fx if not rect else None,
                        measured=float(row[vi]),
                        u_measured=unc(row),
                        setup=water.Setup(fx, fy, ssd, col),
                        reference=refs,
                        depth=depth,
                        extra={"field": [fx, fy]},
                    )
                )
        elif kind == "absolute":
            f = _field(cond) or (100.0, 100.0)
            depth = cond.get("depth_mm")
            out.append(
                base(
                    quantity="gy_per_mu",
                    x=None,
                    measured=float(m["points"][0][vi]),
                    u_measured=unc(m["points"][0]),
                    setup=water.Setup(f[0], f[1], ssd, col),
                    depth=float(depth) if depth is not None else None,
                )
            )
        elif kind == "scalar":
            row = m["points"][0]
            val, u = float(row[vi]), unc(row)
            f = _field(cond)
            if q in ("dmax_mm",) and f:
                out.append(
                    base(quantity=q, x=None, measured=val, u_measured=u, setup=water.Setup(f[0], f[1], ssd, col))
                )
            elif q == "tpr20_10" and f:
                out.append(
                    base(
                        quantity=q, x=None, measured=val, u_measured=u, setup=water.Setup(f[0], f[1], DEFAULT_SSD, col)
                    )
                )
            elif q == "pdd10x" and f:
                out.append(
                    base(
                        quantity=q,
                        x=100.0,
                        measured=val,
                        u_measured=u,
                        setup=water.Setup(f[0], f[1], DEFAULT_SSD, col),
                        depth=100.0,
                    )
                )
            elif q in PROFILE_QUANTITIES and f and "depth_mm" in cond:
                d = float(cond["depth_mm"])
                if cond.get("axis", "x") != "x":
                    out.append(
                        base(
                            quantity=q,
                            x=d,
                            measured=val,
                            u_measured=u,
                            unsupported="只支援 x 方向（jaw X／葉片移動方向）的側向分佈",
                        )
                    )
                    continue
                c = base(
                    quantity=q,
                    x=d,
                    measured=val,
                    u_measured=u,
                    setup=water.Setup(f[0], f[1], ssd, col, profile_depths=(d,)),
                    depth=d,
                )
                c.extra["fff"] = fff
                r = water.detector_radius(str(cond.get("detector") or ""))
                if r is None:
                    c.extra["note"] = "偵檢器不明：側向分佈沒有做體積平均"
                else:
                    c.extra["detector_r"] = r
                out.append(c)
            elif q == "mlc_transmission":
                layer = str(cond.get("layer") or "")
                devices = list(model.get("mlc_devices") or [])
                dev = LAYER_DEVICE.get(layer.lower(), layer) if len(devices) > 1 else (devices[0] if devices else "")
                if not dev or dev not in devices:
                    out.append(
                        base(
                            quantity=q,
                            x=None,
                            measured=val,
                            u_measured=u,
                            unsupported=f"模型沒有 MLC 層 {layer or '?'}",
                        )
                    )
                    continue
                depth = cond.get("depth_mm")
                f = f or (100.0, 100.0)
                closed = water.Setup(f[0], f[1], ssd, "closed", closed_layer=dev)
                open_ = water.Setup(f[0], f[1], ssd, col)
                out.append(
                    base(
                        quantity=q,
                        x=None,
                        measured=val,
                        u_measured=u,
                        setup=closed,
                        reference=open_,
                        depth=float(depth) if depth is not None else None,
                        extra={"layer": dev},
                    )
                )
            elif q in ("leaf_height_mm",):
                devices = list(model.get("mlc_devices") or [])
                spec = model["params"]["collimators"].get(devices[0]) if devices else None
                c = base(quantity=q, x=None, measured=val, u_measured=u)
                if spec is None:
                    c.unsupported = "模型沒有 MLC"
                else:
                    c.model_value = float(spec["thickness_mm"])
                out.append(c)
            else:
                why = {
                    "leaf_end_offset_mm": "葉端偏移要模擬掃描間隙（之後加）",
                    "dlg_mm": "DLG 要模擬掃描間隙（之後加）",
                    "leaf_end_radius_mm": "模型的葉端還沒有圓弧（之後加）",
                    "jaw_transmission": "jaw 穿透之後加",
                }.get(q, "這個量或條件還不支援")
                out.append(base(quantity=q, x=None, measured=val, u_measured=u, unsupported=why))
    return out


def _within(quantity: str, measured: float, model: float) -> tuple[float, float, bool]:
    """回 (差, 以容許為單位的差, 是否在容許內)。"""
    kind, tol = TOLERANCE.get(quantity, ("relative", 0.01))
    diff = model - measured
    scaled = diff / (tol * measured) if kind == "relative" and measured else diff / tol
    return diff, scaled, abs(scaled) <= 1.0


def _value(check: Check, curves: water.Curves, ref: water.Curves | None, hpm: float) -> float:
    q = check.quantity
    if q == "pdd":
        return water.pdd_at(curves.depth_mm, curves.cax, float(check.depth))
    if q == "dmax_mm":
        return water.dmax_mm(curves.depth_mm, curves.cax)
    if q == "tpr20_10":
        return water.tpr20_10(curves.depth_mm, curves.cax)
    if q == "pdd10x":
        return water.pdd_at(curves.depth_mm, curves.cax, 100.0)
    if q in PROFILE_QUANTITIES:
        prof = water.average_detector(
            curves.x_mm, curves.profiles[float(check.depth)], float(check.extra.get("detector_r") or 0.0)
        )
        return water.profile_metrics(curves.x_mm, prof, bool(check.extra.get("fff")))[q]
    if q in ("output_factor", "mlc_transmission"):
        assert ref is not None
        if check.depth is None:
            dm = water.dmax_mm(ref.depth_mm, ref.cax)
            a = water.dose_at(curves.depth_mm, curves.cax, dm)
            b = water.dose_at(ref.depth_mm, ref.cax, dm)
        else:
            a = water.dose_at(curves.depth_mm, curves.cax, float(check.depth))
            b = water.dose_at(ref.depth_mm, ref.cax, float(check.depth))
        return a / b
    if q == "gy_per_mu":
        d = check.depth if check.depth is not None else water.dmax_mm(curves.depth_mm, curves.cax)
        return water.dose_at(curves.depth_mm, curves.cax, float(d)) * hpm
    raise ValueError(q)


MAX_HISTORY_SCALE = 4.0
DEFAULT_HISTORIES = 1_000_000_000
"""每個 10 × 10 條件的歷史數：中心軸附近的統計不確定度約 0.2–0.4%（RTX 5090 上單層 MLC 約 10 秒，雙層約 3 倍）。"""


def histories_for(setup: water.Setup, base: int) -> int:
    """大射野的錐角大、中心軸附近分到的歷史少：歷史數跟射野面積（相對 10 × 10）走，最多 4 倍、最少 1 倍
    （大射野的中心軸平均範圍也比較大，所以不用完全照面積加）。"""
    scale = float(np.clip(setup.field_x * setup.field_y / 100.0**2, 1.0, MAX_HISTORY_SCALE))
    return int(base * scale)


def run_checks(
    model: dict[str, Any],
    dataset: dict[str, Any],
    tb: Any,
    hpm: float,
    *,
    histories: int = DEFAULT_HISTORIES,
    progress: Any = None,
) -> dict[str, Any]:
    """模擬每一個條件（同條件共用一次），逐點取值，回報告（JSON 可序列化）。`hpm`：模型的每 MU 歷史數（MU 校正）。"""
    t0 = time.time()
    checks = plan_checks(model, dataset)
    setups: dict[str, water.Setup] = {}
    for c in checks:
        for s in (c.setup, c.reference):
            if s is None:
                continue
            key = (s.field_x, s.field_y, s.ssd, s.collimation, s.closed_layer)
            prev = setups.get(str(key))
            depths = tuple(sorted(set((prev.profile_depths if prev else ()) + s.profile_depths)))
            setups[str(key)] = water.Setup(s.field_x, s.field_y, s.ssd, s.collimation, s.closed_layer, depths)
    sims: dict[str, water.Simulated] = {}
    for i, (key, s) in enumerate(setups.items()):
        if progress is not None:
            progress(i / max(1, len(setups)), s.key)
        sims[key] = water.simulate(model, s, tb, histories_for(s, histories), seed=1 + i)
    if progress is not None:
        progress(1.0, "")

    def sim_of(s: water.Setup | None) -> water.Simulated | None:
        return None if s is None else sims[str((s.field_x, s.field_y, s.ssd, s.collimation, s.closed_layer))]

    rows = []
    for c in checks:
        if not c.unsupported and c.setup is not None:
            sim, ref = sim_of(c.setup), sim_of(c.reference)
            assert sim is not None
            per = []
            for k, cur in enumerate(sim.batches):
                per.append(_value(c, cur, ref.batches[k] if ref else None, hpm))
            per_arr = np.asarray(per, dtype=np.float64)
            c.model_value = _value(c, sim.mean, ref.mean if ref else None, hpm)
            c.u_model = float(per_arr.std(ddof=1) / math.sqrt(len(per_arr))) if len(per_arr) > 1 else None
        row: dict[str, Any] = {
            "measurement_id": c.measurement_id,
            "label": c.label,
            "quantity": c.quantity,
            "x": c.x,
            "measured": c.measured,
            "u_measured": c.u_measured,
            "model": c.model_value,
            "u_model": c.u_model,
            "setup": c.setup.key if c.setup else None,
            **({"note": c.extra["note"]} if "note" in c.extra else {}),
        }
        if c.extra.get("field"):
            row["field_mm"] = c.extra["field"]
        if c.unsupported:
            row.update(status="unsupported", reason=c.unsupported)
        elif c.model_value is not None and math.isfinite(c.model_value):
            diff, scaled, ok = _within(c.quantity, c.measured, c.model_value)
            u = math.hypot(c.u_measured or 0.0, c.u_model or 0.0)
            row.update(
                diff=diff,
                diff_relative=diff / c.measured if c.measured else None,
                in_tolerance=scaled,
                z=diff / u if u > 0 else None,
                status="pass" if ok else "fail",
            )
        else:
            row.update(status="error", reason="取不到值（曲線不夠完整）")
        rows.append(row)
    counted = [r for r in rows if r["status"] in ("pass", "fail")]
    return {
        "model_id": model["model_id"],
        "dataset_id": dataset.get("dataset_id"),
        "histories_per_setup": histories,
        "setups": [
            {"key": s.setup.key, "histories": s.histories, "seconds": round(s.seconds, 1)} for s in sims.values()
        ],
        "checks": rows,
        "summary": {
            "points": len(rows),
            "compared": len(counted),
            "pass": sum(1 for r in counted if r["status"] == "pass"),
            "fail": sum(1 for r in counted if r["status"] == "fail"),
            "unsupported": sum(1 for r in rows if r["status"] == "unsupported"),
            "max_abs_in_tolerance": max((abs(r["in_tolerance"]) for r in counted), default=None),
        },
        "tolerance": {k: {"kind": v[0], "value": v[1]} for k, v in TOLERANCE.items()},
        "seconds": round(time.time() - t0, 1),
    }


def run_gpu(
    model: dict[str, Any], dataset: dict[str, Any], data_dir: Any, histories: int, *, progress: Any = None
) -> dict[str, Any]:
    """GPU 引擎：物理表與 MU 校正（快取在 `data_dir`）→ `run_checks`。報告多帶引擎版本、每 MU 歷史數、量測標籤。"""
    from pathlib import Path

    from . import beam_data
    from .engines import topas
    from .gpumc import engine, tables

    root = Path(data_dir)
    tb = tables.build(root / "gpumc", image=topas.IMAGE, g4data=topas.g4data())
    hpm = engine.calibration(model, root / "calibration", tb)
    labeled = {
        **dataset,
        "measurements": [{**m, "label": beam_data.measurement_label(m)} for m in dataset.get("measurements") or []],
    }
    report = run_checks(model, labeled, tb, hpm, histories=histories, progress=progress)
    report.update(engine_version=engine.ENGINE_VERSION, histories_per_mu=hpm)
    return report
