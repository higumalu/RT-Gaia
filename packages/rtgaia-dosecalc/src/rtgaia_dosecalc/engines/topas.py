"""OpenTOPAS（Geant4）Monte Carlo 引擎 —— 在 Docker 容器裡跑官方映像，每個射束一次。

## 病人

CT（HU）經 CT 校正曲線 → 每個 CT 體素的質量密度與材質（Schneider 25 段）→ 移到**劑量網格**：密度是劑量體素裡
2 × 2 × 2 個取樣點的平均，材質取體素中心最近的 CT 體素。交給 TOPAS 的影像值是「材質編號 × `DENSITY_BINS` ＋
密度格（`DENSITY_STEP` g/cm³ 一格）」，Schneider 換算器的 25 段各自是 ρ ＝ 格 × 步長、元素組成照那一段；
用「可變密度材質」（每段一個基礎材質、依密度縮放），不會因為密度格多就產生上萬個材質。
劑量直接計分在這個網格上（DoseToMedium）。劑量網格要跟 LPS 軸對齊（方向不是單位矩陣就拒算）。

## 射束

每個射束一個 TOPAS 參數檔、一次執行。世界座標 ＝ 病人 LPS（mm）。一個 Group 放在等中心，旋轉成這個控制點的
射束限制裝置座標（`delivery.bld_to_lps`），裡面：靶上的原射源與機頭散射的第二射源（往 −z 射）、Y jaw、X jaw、
TsDivergingMLC（葉寬與開口都是投影到等中心平面的值，跟 DICOM 同定義）。
控制點之間（VMAT）切成機架每 `ARC_STEP_DEG` 一小段，每段在中點內插機架、jaw、葉片；**每段的歷史數 ∝ 這一段的 MU**
（TOPAS 的循序時間 ＋ Step 時間序列）。

## 換成 Gy

TOPAS 算的是「N 個歷史的劑量」。MU 校正（`beam_models` 的 `calibration`）：參考條件的模擬求出每個歷史在 dmax 的劑量
→ 每 MU 幾個歷史（快取在資料目錄，模型一改就重算）。射束劑量 ＝ 模擬劑量 × MU × 每 MU 歷史數 ÷ N × 分次數。
不確定度：TOPAS 回報每個歷史的標準差 s（實測核對過），總和的 1σ ＝ s × √N；射束之間獨立，平方和開根號。
"""

from __future__ import annotations

import json
import math
import os
import re
import shutil
import subprocess
import time
from pathlib import Path
from typing import Any

import numpy as np
from scipy.ndimage import map_coordinates

from .. import beam_models
from ..ct_calibration import _SCHNEIDER_MATERIAL_BOUNDS, _SCHNEIDER_WEIGHTS, ELEMENTS, convert
from ..delivery import Beam, ControlPoint, bld_to_lps, interpolate, segments
from ..package import CalcInput, CalcResult

IMAGE = os.environ.get("RTGAIA_TOPAS_IMAGE", "opentopas/opentopas:v4.3.0-geant4-11.4.2")
ENGINE_VERSION = f"opentopas {IMAGE.rsplit(':', 1)[-1]} / rtgaia-topas 1"
DENSITY_STEP = 0.002
DENSITY_BINS = 2600
"""每段 2600 格 × 0.002 g/cm³ ＝ 0–5.2 g/cm³（鈦 4.54）；更密的夾到上限並計數。"""
CODE_OFFSET = -32768
"""影像值是 16 位元有號整數：TOPAS 的 Schneider 換算只做了 SHORT —— INT 的路徑不建材質、
一追蹤就當掉（2026-10-12 實測）。25 段 × 2600 ＝ 65000 個值，從 −32768 開始。"""
ARC_STEP_DEG = 2.0
AIR_DENSITY_LIMIT = 0.02
"""g/cm³：低於這個密度的體素（空氣）不報劑量（NaN）—— 質量太小，幾個粒子就讓「介質劑量」爆成雜訊（實測 2 百萬個歷史時
空氣裡出現 30 Gy 以上的點）；TPS 在體外的劑量也不拿來判讀。"""
AIR_NOTE = "體素中心是空氣（或密度 < 0.02 g/cm³）的地方不報劑量"
DEFAULT_HISTORIES = 20_000_000
MIN_HISTORIES_PER_BEAM = 100_000
CALIBRATION_HISTORIES = 10_000_000
CUT_MM = 0.5
LABEL = "rtgaia.dosecalc"
G4_ELEMENT = {
    "H": "Hydrogen", "C": "Carbon", "N": "Nitrogen", "O": "Oxygen", "Mg": "Magnesium", "P": "Phosphorus",
    "S": "Sulfur", "Cl": "Chlorine", "Ar": "Argon", "Ca": "Calcium", "Na": "Sodium", "K": "Potassium", "Ti": "Titanium",
}  # fmt: skip


def g4data() -> Path:
    return Path(os.environ.get("RTGAIA_G4DATA", str(Path.home() / ".geant4_pybind"))).expanduser()


def threads() -> int:
    return int(os.environ.get("RTGAIA_TOPAS_THREADS", str(os.cpu_count() or 4)))


def status() -> dict[str, Any]:
    if shutil.which("docker") is None:
        return {"ready": False, "reason": "這台機器沒有 docker（OpenTOPAS 在容器裡跑）"}
    r = subprocess.run(["docker", "image", "inspect", IMAGE], capture_output=True, text=True, timeout=30)
    if r.returncode != 0:
        return {"ready": False, "reason": f"沒有 OpenTOPAS 映像 {IMAGE}（docker pull {IMAGE}）"}
    if not any(g4data().glob("G4EMLOW*")):
        return {"ready": False, "reason": f"沒有 Geant4 物理資料（{g4data()}；設定 RTGAIA_G4DATA）"}
    return {"ready": True, "reason": "", "version": ENGINE_VERSION}


# ── 幾何 ──────────────────────────────────────────────────────────────────────


def topas_euler(m: np.ndarray) -> tuple[float, float, float]:
    """3×3（欄 ＝ 子座標的軸在父座標的方向）→ TOPAS 的 RotX、RotY、RotZ（度）。

    TOPAS 的旋轉矩陣是 Rz·Ry·Rx，交給 G4PVPlacement 當座標系旋轉（被動）→ 子元件實際的方向 ＝ 它的轉置。
    所以要找 Rz(c)·Ry(b)·Rx(a) ＝ mᵀ。"""
    r = np.asarray(m, dtype=np.float64).T
    b = -math.asin(max(-1.0, min(1.0, r[2, 0])))
    if abs(math.cos(b)) > 1e-9:
        a = math.atan2(r[2, 1], r[2, 2])
        c = math.atan2(r[1, 0], r[0, 0])
    else:  # 萬向節鎖：c 設 0
        a = math.atan2(-r[1, 2], r[1, 1])
        c = 0.0
    return math.degrees(a), math.degrees(b), math.degrees(c)


# ── 病人 ──────────────────────────────────────────────────────────────────────


def patient_on_grid(inp: CalcInput) -> tuple[np.ndarray, np.ndarray, np.ndarray, dict[str, Any]]:
    """`(影像值 int16, 密度 float32, 材質 uint8, 說明)`，都在劑量網格 (k, j, i)。"""
    g = inp.dose_grid
    if not np.allclose(g.direction_matrix, np.eye(3), atol=1e-6):
        raise ValueError("劑量網格不是跟 LPS 軸對齊的（斜的 CT）：還不支援")
    conv = convert(inp.calibration, inp.ct_hu)
    rho_ct = conv.density.astype(np.float32)
    ni, nj, nk = g.size
    w2i = inp.ct_grid.world_to_index_matrix
    sp = np.asarray(g.spacing)
    offs = [(-0.25, 0.25)] * 3
    acc = np.zeros((nk, nj, ni), dtype=np.float64)
    kk, jj, ii = np.meshgrid(np.arange(nk), np.arange(nj), np.arange(ni), indexing="ij")
    base = g.index_to_world(np.stack([ii, jj, kk], axis=-1).reshape(-1, 3).astype(np.float64))
    for dx in offs[0]:
        for dy in offs[1]:
            for dz in offs[2]:
                p = base + np.array([dx, dy, dz]) * sp
                idx = p @ w2i[:3, :3].T + w2i[:3, 3]
                v = map_coordinates(
                    rho_ct, [idx[:, 2], idx[:, 1], idx[:, 0]], order=1, mode="constant", cval=0.0012, prefilter=False
                )
                acc += v.reshape(nk, nj, ni)
    rho = (acc / 8).astype(np.float32)
    idx = base @ w2i[:3, :3].T + w2i[:3, 3]
    mat = map_coordinates(
        conv.material.astype(np.float32),
        [idx[:, 2], idx[:, 1], idx[:, 0]],
        order=0,
        mode="constant",
        cval=0.0,
        prefilter=False,
    )
    mat = np.rint(mat).astype(np.uint8).reshape(nk, nj, ni)
    bins = np.rint(rho / DENSITY_STEP).astype(np.int64)
    over = int((bins > DENSITY_BINS - 1).sum())
    bins = np.clip(bins, 1, DENSITY_BINS - 1)
    codes = (mat.astype(np.int64) * DENSITY_BINS + bins + CODE_OFFSET).astype(np.int16)
    info = {**conv.info, "density_over_limit": over, "dose_grid_voxels": int(codes.size)}
    return codes, rho, mat, info


def schneider_parameters(component: str = "Patient") -> str:
    n = len(_SCHNEIDER_WEIGHTS)
    bounds = [CODE_OFFSET + m * DENSITY_BINS for m in range(n + 1)]
    lines = [
        f's:Ge/{component}/ImagingToMaterialConverter = "Schneider"',
        f"i:Ge/{component}/MinImagingValue = {CODE_OFFSET}",
        f"iv:Ge/{component}/SchneiderHounsfieldUnitSections = {n + 1} " + " ".join(map(str, bounds)),
        f"uv:Ge/{component}/SchneiderDensityOffset = {n} " + " ".join(["0"] * n),
        f"uv:Ge/{component}/SchneiderDensityFactor = {n} " + " ".join([f"{DENSITY_STEP:g}"] * n),
        f"uv:Ge/{component}/SchneiderDensityFactorOffset = {n} " + " ".join(str(-b) for b in bounds[:-1]),
        f"dv:Ge/{component}/DensityCorrection = {bounds[-1] - bounds[0]} "
        + " ".join(["1"] * (bounds[-1] - bounds[0]))
        + " g/cm3",
        f"sv:Ge/{component}/SchneiderElements = {len(ELEMENTS)} " + " ".join(f'"{G4_ELEMENT[e]}"' for e in ELEMENTS),
        f"iv:Ge/{component}/SchneiderHUToMaterialSections = {n + 1} " + " ".join(map(str, bounds)),
        f'b:Ge/{component}/SchneiderUseVariableDensityMaterials = "True"',
    ]
    for i, w in enumerate(_SCHNEIDER_WEIGHTS):
        lines.append(f"uv:Ge/{component}/SchneiderMaterialsWeight{i + 1} = {len(w)} " + " ".join(f"{x:g}" for x in w))
    _ = _SCHNEIDER_MATERIAL_BOUNDS  # HU 的分段在 convert() 已經用過；這裡的分段是「材質編號」
    return "\n".join(lines)


# ── 參數檔 ────────────────────────────────────────────────────────────────────


def _common(nthreads: int, seed: int) -> str:
    return "\n".join(
        [
            'sv:Ph/Default/Modules = 1 "g4em-standard_opt4"',
            f"d:Ph/Default/CutForAllParticles = {CUT_MM} mm",
            f"i:Ts/NumberOfThreads = {nthreads}",
            f"i:Ts/Seed = {seed}",
            'b:Ts/PauseBeforeQuit = "False"',
            'b:Gr/Enable = "False"',
            'b:Ts/UseQT = "False"',
            "i:So/Demo/NumberOfHistoriesInRun = 0",
            "i:Ts/TrackingVerbosity = 0",
            "i:Ts/EventVerbosity = 0",
            "i:Ts/RunVerbosity = 0",
        ]
    )


def _states(beam: Beam) -> list[tuple[ControlPoint, float]]:
    """(這一小段中點的狀態, 這一小段的 MU)：VMAT 的段切成機架每 `ARC_STEP_DEG` 一小段。"""
    out: list[tuple[ControlPoint, float]] = []
    for a, b, mu in segments(beam):
        dg = abs(((b.gantry_deg - a.gantry_deg + 180.0) % 360.0) - 180.0)
        k = max(1, int(math.ceil(dg / ARC_STEP_DEG)))
        for s in range(k):
            out.append((interpolate(a, b, (s + 0.5) / k), mu / k))
    return out


def _split(total: int, weights: list[float]) -> list[int]:
    """整數歷史數 ∝ 權重（餘數給小數部分最大的；總和 ＝ total）。"""
    w = np.asarray(weights, dtype=np.float64)
    raw = w / w.sum() * total
    base = np.floor(raw).astype(np.int64)
    rest = int(total - base.sum())
    if rest > 0:
        base[np.argsort(-(raw - base))[:rest]] += 1
    return [int(x) for x in base]


def _step(name: str, values: list[float], unit: str, kind: str = "dv") -> list[str]:
    n = len(values)
    return [
        f's:Tf/{name}/Function = "Step"',
        f"dv:Tf/{name}/Times = {n} " + " ".join(str(i + 1) for i in range(n)) + " ms",
        f"{kind}:Tf/{name}/Values = {n} " + " ".join(f"{v:.6g}" for v in values) + (f" {unit}" if unit else ""),
    ]


def beam_parameters(
    beam: Beam, model: dict[str, Any], histories: int, *, iso: tuple[float, float, float], world_hl_mm: float
) -> tuple[str, int]:
    """一個射束的參數檔（不含病人與通用的部分）；回 (文字, 實際歷史數)。"""
    p = model["params"]
    states = _states(beam)
    n_steps = len(states)
    hist = _split(histories, [mu for _cp, mu in states])
    ef = p.get("extra_focal") or {}
    ef_frac = float(ef.get("fraction") or 0.0)
    hist_ef = [int(round(h * ef_frac)) for h in hist]
    hist_pr = [h - e for h, e in zip(hist, hist_ef, strict=True)]
    sad = beam.sad_mm
    margin = float(p.get("field_margin_mm", 10.0))
    ext_x = max(max(abs(cp.jaw_x[0]), abs(cp.jaw_x[1])) for cp, _ in states) + margin
    ext_y = max(max(abs(cp.jaw_y[0]), abs(cp.jaw_y[1])) for cp, _ in states) + margin
    rx, ry, rz = [], [], []
    for cp, _ in states:
        a, b, c = topas_euler(bld_to_lps(cp.gantry_deg, cp.collimator_deg, cp.couch_deg, beam.patient_position))
        rx.append(a)
        ry.append(b)
        rz.append(c)
    L: list[str] = [
        f"d:Ge/World/HLX = {world_hl_mm} mm",
        f"d:Ge/World/HLY = {world_hl_mm} mm",
        f"d:Ge/World/HLZ = {world_hl_mm} mm",
        's:Ge/World/Material = "G4_AIR"',
        f"i:Tf/NumberOfSequentialTimes = {n_steps}",
        "d:Tf/TimelineStart = 0 ms",
        f"d:Tf/TimelineEnd = {n_steps} ms",
        's:Ge/Head/Type = "Group"',
        's:Ge/Head/Parent = "World"',
        f"d:Ge/Head/TransX = {iso[0]} mm",
        f"d:Ge/Head/TransY = {iso[1]} mm",
        f"d:Ge/Head/TransZ = {iso[2]} mm",
    ]
    if n_steps == 1:
        L += [
            f"d:Ge/Head/RotX = {rx[0]:.6f} deg",
            f"d:Ge/Head/RotY = {ry[0]:.6f} deg",
            f"d:Ge/Head/RotZ = {rz[0]:.6f} deg",
        ]
    else:
        L += _step("HeadRotX", rx, "deg") + _step("HeadRotY", ry, "deg") + _step("HeadRotZ", rz, "deg")
        L += [
            "d:Ge/Head/RotX = Tf/HeadRotX/Value deg",
            "d:Ge/Head/RotY = Tf/HeadRotY/Value deg",
            "d:Ge/Head/RotZ = Tf/HeadRotZ/Value deg",
        ]
    energies, weights = p["spectrum_mev"], p["spectrum_weights"]

    def source(
        name: str, z_mm: float, sigma_mm: float, half_x_deg: float, half_y_deg: float, counts: list[int]
    ) -> list[str]:
        out = [
            f's:Ge/{name}Pos/Type = "Group"',
            f's:Ge/{name}Pos/Parent = "Head"',
            f"d:Ge/{name}Pos/TransZ = {z_mm} mm",
            f"d:Ge/{name}Pos/RotX = 180 deg",
            f's:So/{name}/Type = "Beam"',
            f's:So/{name}/Component = "{name}Pos"',
            f's:So/{name}/BeamParticle = "gamma"',
            f's:So/{name}/BeamEnergySpectrumType = "Discrete"',
            f"dv:So/{name}/BeamEnergySpectrumValues = {len(energies)} " + " ".join(f"{e:g}" for e in energies) + " MeV",
            f"uv:So/{name}/BeamEnergySpectrumWeights = {len(weights)} " + " ".join(f"{w:.6g}" for w in weights),
            f's:So/{name}/BeamPositionDistribution = "Gaussian"',
            f's:So/{name}/BeamPositionCutoffShape = "Ellipse"',
            f"d:So/{name}/BeamPositionCutoffX = {3 * sigma_mm} mm",
            f"d:So/{name}/BeamPositionCutoffY = {3 * sigma_mm} mm",
            f"d:So/{name}/BeamPositionSpreadX = {sigma_mm} mm",
            f"d:So/{name}/BeamPositionSpreadY = {sigma_mm} mm",
            f's:So/{name}/BeamAngularDistribution = "Flat"',
            f"d:So/{name}/BeamAngularCutoffX = {half_x_deg:.6f} deg",
            f"d:So/{name}/BeamAngularCutoffY = {half_y_deg:.6f} deg",
        ]
        if n_steps == 1:
            out.append(f"i:So/{name}/NumberOfHistoriesInRun = {counts[0]}")
        else:
            out += _step(f"{name}Count", [float(c) for c in counts], "", "iv")
            out[-1] = out[-1].replace(".000000", "")
            out.append(f"i:So/{name}/NumberOfHistoriesInRun = Tf/{name}Count/Value")
        return out

    deg = math.degrees
    L += source(
        "Primary",
        sad,
        float(p["focal_spot_sigma_mm"]),
        deg(math.atan(ext_x / sad)),
        deg(math.atan(ext_y / sad)),
        hist_pr,
    )
    if ef_frac > 0:
        z_ef = sad - float(ef["distance_below_target_mm"])
        L += source(
            "ExtraFocal",
            z_ef,
            float(ef["sigma_mm"]),
            deg(math.atan((ext_x + 3 * ef["sigma_mm"]) / z_ef)),
            deg(math.atan((ext_y + 3 * ef["sigma_mm"]) / z_ef)),
            hist_ef,
        )
    col = p["collimators"]

    def jaw(name: str, spec: dict[str, Any], axis: str, neg: list[float], pos: list[float]) -> list[str]:
        susd, thick = float(spec["source_to_upstream_mm"]), float(spec["thickness_mm"])
        out = [
            f's:Ge/{name}/Type = "TsJaws"',
            f's:Ge/{name}/Parent = "Head"',
            f's:Ge/{name}/Material = "{spec["material"]}"',
            f"d:Ge/{name}/LX = 200 mm",
            f"d:Ge/{name}/LY = 400 mm",
            f"d:Ge/{name}/LZ = {thick} mm",
            f"d:Ge/{name}/SourceToUpstreamSurfaceDistance = {susd} mm",
            f"d:Ge/{name}/SAD = {sad} mm",
            f"d:Ge/{name}/TransZ = {sad - susd - thick / 2} mm",
            f"d:Ge/{name}/RotZ = {0 if axis == 'x' else -90} deg",
        ]
        if n_steps == 1:
            out += [
                f"d:Ge/{name}/NegativeFieldSetting = {neg[0]} mm",
                f"d:Ge/{name}/PositiveFieldSetting = {pos[0]} mm",
            ]
        else:
            out += _step(f"{name}Neg", neg, "mm") + _step(f"{name}Pos", pos, "mm")
            out += [
                f"d:Ge/{name}/NegativeFieldSetting = Tf/{name}Neg/Value mm",
                f"d:Ge/{name}/PositiveFieldSetting = Tf/{name}Pos/Value mm",
            ]
        return out

    L += jaw("JawY", col["jaw_y"], "y", [cp.jaw_y[0] for cp, _ in states], [cp.jaw_y[1] for cp, _ in states])
    L += jaw("JawX", col["jaw_x"], "x", [cp.jaw_x[0] for cp, _ in states], [cp.jaw_x[1] for cp, _ in states])
    if beam.leaf_boundaries_mm and states[0][0].mlc_a is not None:
        spec = col["mlc"]
        bounds = beam.leaf_boundaries_mm
        if abs(bounds[0] + bounds[-1]) > 1e-3:
            raise ValueError("MLC 葉片邊界不對稱：還不支援")
        widths = [b - a for a, b in zip(bounds, bounds[1:], strict=False)]
        n_leaves = len(widths)
        susd, thick = float(spec["source_to_upstream_mm"]), float(spec["thickness_mm"])
        L += [
            's:Ge/MLC/Type = "TsDivergingMLC"',
            's:Ge/MLC/Parent = "Head"',
            f's:Ge/MLC/Material = "{spec["material"]}"',
            f"d:Ge/MLC/SAD = {sad} mm",
            f"d:Ge/MLC/SourceToUpstreamSurfaceDistance = {susd} mm",
            f"d:Ge/MLC/Thickness = {thick} mm",
            f"d:Ge/MLC/Length = {spec['leaf_length_mm']} mm",
            "d:Ge/MLC/MaximumLeafOpen = 250 mm",
            's:Ge/MLC/LeafTravelAxis = "Xb"',
            "d:Ge/MLC/RotZ = 0 deg",
            f"d:Ge/MLC/TransZ = {sad - susd - thick / 2} mm",
            f"dv:Ge/MLC/LeafWidths = {n_leaves} " + " ".join(f"{w:g}" for w in widths) + " mm",
        ]
        neg_rows = [[min(a, b) for a, b in zip(cp.mlc_a, cp.mlc_b, strict=True)] for cp, _ in states]  # type: ignore[arg-type]
        pos_rows = [[max(a, b) for a, b in zip(cp.mlc_a, cp.mlc_b, strict=True)] for cp, _ in states]  # type: ignore[arg-type]
        if n_steps == 1:
            L += [
                f"dv:Ge/MLC/NegativeFieldSetting = {n_leaves} " + " ".join(f"{v:.4g}" for v in neg_rows[0]) + " mm",
                f"dv:Ge/MLC/PositiveFieldSetting = {n_leaves} " + " ".join(f"{v:.4g}" for v in pos_rows[0]) + " mm",
            ]
        else:
            neg_refs, pos_refs = [], []
            for leaf in range(n_leaves):
                L += _step(f"LeafN{leaf}", [r[leaf] for r in neg_rows], "mm") + _step(
                    f"LeafP{leaf}", [r[leaf] for r in pos_rows], "mm"
                )
                neg_refs.append(f"Tf/LeafN{leaf}/Value")
                pos_refs.append(f"Tf/LeafP{leaf}/Value")
            L += [
                f"dv:Ge/MLC/NegativeFieldSetting = {n_leaves} " + " ".join(neg_refs) + " mm",
                f"dv:Ge/MLC/PositiveFieldSetting = {n_leaves} " + " ".join(pos_refs) + " mm",
            ]
    return "\n".join(L), sum(hist)


def patient_parameters(inp: CalcInput, data_file: str) -> str:
    g = inp.dose_grid
    ni, nj, nk = g.size
    sp = g.spacing
    center = np.asarray(g.origin) + (np.asarray(g.size) - 1) / 2 * np.asarray(sp)
    return "\n".join(
        [
            's:Ge/Patient/Type = "TsImageCube"',
            's:Ge/Patient/Parent = "World"',
            's:Ge/Patient/Material = "G4_AIR"',
            f"d:Ge/Patient/TransX = {center[0]:.6f} mm",
            f"d:Ge/Patient/TransY = {center[1]:.6f} mm",
            f"d:Ge/Patient/TransZ = {center[2]:.6f} mm",
            's:Ge/Patient/InputDirectory = "./"',
            f's:Ge/Patient/InputFile = "{data_file}"',
            's:Ge/Patient/DataType = "SHORT"',
            f"i:Ge/Patient/NumberOfVoxelsX = {ni}",
            f"i:Ge/Patient/NumberOfVoxelsY = {nj}",
            f"i:Ge/Patient/NumberOfVoxelsZ = {nk}",
            f"d:Ge/Patient/VoxelSizeX = {sp[0]} mm",
            f"d:Ge/Patient/VoxelSizeY = {sp[1]} mm",
            f"d:Ge/Patient/VoxelSizeZ = {sp[2]} mm",
            schneider_parameters(),
            's:Sc/Dose/Quantity = "DoseToMedium"',
            's:Sc/Dose/Component = "Patient"',
            's:Sc/Dose/OutputType = "binary"',
            's:Sc/Dose/IfOutputFileAlreadyExists = "Overwrite"',
            'sv:Sc/Dose/Report = 2 "Sum" "Standard_Deviation"',
        ]
    )


# ── 執行 ──────────────────────────────────────────────────────────────────────

_HISTORY = re.compile(r"History:\s*(\d+)")


def run_topas(workdir: Path, param_file: str, *, label: str, on_history: Any = None) -> str:
    """在容器裡跑一個參數檔；回 stdout。失敗 → RuntimeError（附最後幾行）。"""
    cmd = [
        "docker", "run", "--rm", "--label", f"{LABEL}={label}",
        "--user", f"{os.getuid()}:{os.getgid()}",
        "-v", f"{workdir}:/simulations",
        "-v", f"{g4data()}:/Applications/G4Data:ro",
        IMAGE, param_file,
    ]  # fmt: skip
    proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, bufsize=1)
    lines: list[str] = []
    assert proc.stdout is not None
    for line in proc.stdout:
        lines.append(line)
        if len(lines) > 4000:
            del lines[:2000]
        m = _HISTORY.search(line)
        if m and on_history is not None:
            on_history(int(m.group(1)))
    rc = proc.wait()
    out = "".join(lines)
    if rc != 0 or "Topas is exiting due to a serious error" in out:
        tail = "\n".join(x for x in out.splitlines() if x.strip())[-1500:]
        raise RuntimeError(f"OpenTOPAS 失敗（exit {rc}）：{tail}")
    return out


_UNSCORED = re.compile(r"total energy of affected hits was:\s*([0-9.eE+-]+)\s*MeV", re.IGNORECASE)
_UNSCORED_N = re.compile(r"total number of affected hits was:\s*(\d+)", re.IGNORECASE)


def unscored(stdout: str) -> tuple[int, float]:
    """TOPAS 回報「導航停在參數化的錯層、沒計到分」的步數與能量（MeV）。少量是 Geant4 的已知現象；量大要看。"""
    n = sum(int(x) for x in _UNSCORED_N.findall(stdout))
    e = sum(float(x) for x in _UNSCORED.findall(stdout))
    return n, e


def cancel(label: str) -> None:
    """把這個工作還在跑的容器停掉（API 取消工作時叫）。"""
    r = subprocess.run(
        ["docker", "ps", "-q", "--filter", f"label={LABEL}={label}"], capture_output=True, text=True, timeout=30
    )
    ids = r.stdout.split()
    if ids:
        subprocess.run(["docker", "rm", "-f", *ids], capture_output=True, timeout=60)


def read_dose(path: Path, shape: tuple[int, int, int]) -> tuple[np.ndarray, np.ndarray]:
    a = np.fromfile(path, dtype="<f8")
    n = int(np.prod(shape))
    if a.size != 2 * n:
        raise RuntimeError(f"OpenTOPAS 輸出大小不對：{a.size} 個值，要 {2 * n}")
    return a[0::2].reshape(shape), a[1::2].reshape(shape)


def run(inp: CalcInput, workdir: Any, progress: Any) -> CalcResult:
    t0 = time.time()
    out = Path(workdir)
    wd = out / "topas"
    wd.mkdir(parents=True, exist_ok=True)
    label = out.parent.name or "rtgaia"
    model = inp.beam_model
    histories = int(inp.options.get("histories") or DEFAULT_HISTORIES)
    seed = int(inp.options.get("seed") or 1)
    nthreads = threads()
    progress("preparing", 0.0, "patient")
    codes, rho, mat, pinfo = patient_on_grid(inp)
    codes.tofile(wd / "patient.dat")
    shape = codes.shape
    (wd / "patient.txt").write_text(
        patient_parameters(inp, "patient.dat") + "\n" + _common(nthreads, seed) + "\n", encoding="utf-8"
    )
    hpm = calibration(model, out.parent.parent / "calibration", progress=progress, label=label)
    beams = inp.delivery.beams
    total_mu = sum(b.mu for b in beams)
    per_beam_hist = {b.number: max(MIN_HISTORIES_PER_BEAM, int(round(histories * b.mu / total_mu))) for b in beams}
    grand = sum(per_beam_hist.values())
    done_before = 0
    per_beam: dict[int, np.ndarray] = {}
    var_total = np.zeros(shape, dtype=np.float64)
    corners = np.asarray(inp.dose_grid.corners_world)
    iso_all = np.asarray([b.isocenter_lps for b in beams], dtype=np.float64)
    world_hl = float(max(np.abs(corners).max(), np.abs(iso_all).max()) + max(b.sad_mm for b in beams) + 300.0)
    lost_hits, lost_mev = 0, 0.0
    for beam in beams:
        text, n_hist = beam_parameters(
            beam, model, per_beam_hist[beam.number], iso=tuple(beam.isocenter_lps), world_hl_mm=world_hl
        )
        name = f"beam_{beam.number}"
        (wd / f"{name}.txt").write_text(
            "includeFile = patient.txt\n"
            + text
            + f'\ns:Sc/Dose/OutputFile = "{name}"\ni:Ts/ShowHistoryCountAtInterval = {max(1000, n_hist // 200)}\n',
            encoding="utf-8",
        )

        def on_history(h: int, base: int = done_before, label_: str = beam.name) -> None:
            progress("calculating", 5.0 + 95.0 * min(grand, base + h) / grand, label_)

        log = run_topas(wd, f"{name}.txt", label=label, on_history=on_history)
        n_lost, e_lost = unscored(log)
        lost_hits += n_lost
        lost_mev += e_lost
        if not (wd / f"{name}.bin").exists():
            raise RuntimeError(f"OpenTOPAS 沒有寫出 {name} 的劑量")
        s, sd = read_dose(wd / f"{name}.bin", shape)
        scale = beam.mu * hpm / n_hist * inp.delivery.fractions
        per_beam[beam.number] = (s * scale).astype(np.float32)
        var_total += (sd * math.sqrt(n_hist) * scale) ** 2
        done_before += n_hist
    dose = np.sum(list(per_beam.values()), axis=0)
    with np.errstate(invalid="ignore", divide="ignore"):
        unc = np.where(dose > 0, np.sqrt(var_total) / dose, np.nan).astype(np.float32)
    # 中心是空氣（Schneider 第 1 段）的邊緣體素也不報：半空氣、質量小、雜訊大
    air = (rho < AIR_DENSITY_LIMIT) | (mat == 0)
    dose = np.where(air, np.nan, dose)
    unc = np.where(air, np.nan, unc)
    per_beam = {n: np.where(air, np.nan, v).astype(np.float32) for n, v in per_beam.items()}
    return CalcResult(
        dose_gy=dose.astype(np.float32),
        uncertainty=unc,
        per_beam_gy=per_beam,
        info={
            "engine": "topas",
            "engine_version": ENGINE_VERSION,
            "seconds": round(time.time() - t0, 1),
            "histories": int(grand),
            "histories_per_mu": hpm,
            "dose_quantity": "to medium",
            "calibration": pinfo,
            "physics": f"g4em-standard_opt4, production cut {CUT_MM} mm",
            "threads": nthreads,
            "unscored_hits": lost_hits,
            "unscored_mev": lost_mev,
            "air_voxels": int(air.sum()),
            "notes": [AIR_NOTE],
        },
    )


# ── MU 校正 ───────────────────────────────────────────────────────────────────


def calibration(model: dict[str, Any], cache_dir: Path, *, progress: Any = None, label: str = "calibration") -> float:
    """每 MU 幾個歷史：參考條件（`model["calibration"]`）水中 dmax 的劑量 ＝ `gy_per_mu`。快取。"""
    key = f"{model['model_id']}-{beam_models.model_hash(model)}-{ENGINE_VERSION.replace(' ', '_').replace('/', '_')}"
    cache_dir.mkdir(parents=True, exist_ok=True)
    cached = cache_dir / f"{key}.json"
    if cached.exists():
        return float(json.loads(cached.read_text(encoding="utf-8"))["histories_per_mu"])
    c = model["calibration"]
    field = float(c["field_mm"])
    ssd = float(c["ssd_mm"])
    wd = cache_dir / key
    wd.mkdir(parents=True, exist_ok=True)
    half = field / 2
    ref_beam = Beam(
        number=1, name="calibration", energy_mv=model["energy_mv"], fluence_mode=model["fluence_mode"], sad_mm=ssd,
        isocenter_lps=(0.0, 0.0, 0.0), patient_position="HFS", mu=1.0,
        control_points=[
            ControlPoint(0.0, 0.0, 0.0, 0.0, (-half, half), (-half, half)),
            ControlPoint(1.0, 0.0, 0.0, 0.0, (-half, half), (-half, half)),
        ],
    )  # fmt: skip
    text, n_hist = beam_parameters(ref_beam, model, CALIBRATION_HISTORIES, iso=(0.0, 0.0, 0.0), world_hl_mm=ssd + 600.0)
    # 水箱 40 × 40 × 30 cm，表面在等中心（SSD ＝ SAD）；射束往 LPS +y（機架 0°、HFS），深度沿 +y
    phantom = "\n".join(
        [
            's:Ge/Phantom/Type = "TsBox"',
            's:Ge/Phantom/Parent = "World"',
            's:Ge/Phantom/Material = "G4_WATER"',
            "d:Ge/Phantom/HLX = 200 mm",
            "d:Ge/Phantom/HLY = 150 mm",
            "d:Ge/Phantom/HLZ = 200 mm",
            "d:Ge/Phantom/TransY = 150 mm",
            "i:Ge/Phantom/XBins = 40",
            "i:Ge/Phantom/YBins = 150",
            "i:Ge/Phantom/ZBins = 40",
            's:Sc/Dose/Quantity = "DoseToMedium"',
            's:Sc/Dose/Component = "Phantom"',
            's:Sc/Dose/OutputType = "binary"',
            's:Sc/Dose/OutputFile = "calibration"',
            's:Sc/Dose/IfOutputFileAlreadyExists = "Overwrite"',
            'sv:Sc/Dose/Report = 2 "Sum" "Standard_Deviation"',
            f"i:Ts/ShowHistoryCountAtInterval = {max(1000, n_hist // 100)}",
        ]
    )
    (wd / "calibration.txt").write_text(
        phantom + "\n" + text + "\n" + _common(threads(), 12345) + "\n", encoding="utf-8"
    )

    def on_history(h: int) -> None:
        if progress is not None:
            progress("calibrating", 5.0 * min(1.0, h / n_hist), "MU calibration")

    run_topas(wd, "calibration.txt", label=label, on_history=on_history)
    s, sd = read_dose(wd / "calibration.bin", (40, 150, 40))  # (z, y, x)；中間 2 × 2 格（1 cm 一格 → 2 × 2 cm²）
    axis = s[19:21, :, 19:21].mean(axis=(0, 2))  # 每 2 mm 深度
    smooth = np.convolve(axis, np.ones(3) / 3, mode="same")
    j = int(np.argmax(smooth[1:-1])) + 1
    d_per_hist = float(smooth[j]) / n_hist
    hpm = float(c["gy_per_mu"]) / d_per_hist
    doc = {
        "model_id": model["model_id"],
        "model_hash": beam_models.model_hash(model),
        "engine_version": ENGINE_VERSION,
        "histories": n_hist,
        "dmax_mm": (j + 0.5) * 2.0,
        "dose_per_history_gy": d_per_hist,
        "histories_per_mu": hpm,
        "depth_dose_gy": [float(x) for x in axis],
    }
    cached.write_text(json.dumps(doc), encoding="utf-8")
    return hpm
