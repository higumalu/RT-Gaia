"""OpenTOPAS（Geant4）Monte Carlo 引擎 —— 在 Docker 容器裡跑官方映像，每個射束一次。

## 病人

CT（HU）經 CT 校正曲線 → 每個 CT 體素的質量密度與材質（Schneider 25 段）→ 移到**劑量網格**：密度是劑量體素裡
2 × 2 × 2 個取樣點的平均，材質取體素中心最近的 CT 體素。交給 TOPAS 的影像值是「材質編號 × `DENSITY_BINS` ＋
密度格（`DENSITY_STEP` g/cm³ 一格）」，Schneider 換算器的 25 段各自是 ρ ＝ 格 × 步長、元素組成照那一段；
用「可變密度材質」（每段一個基礎材質、依密度縮放），不會因為密度格多就產生上萬個材質。
劑量直接計分在這個網格上（DoseToMedium）。劑量網格要跟 LPS 軸對齊（方向不是單位矩陣就拒算）。

## 射束

每個射束一個 TOPAS 參數檔、一次執行。世界座標 ＝ 病人 LPS（mm）。一個 Group 放在等中心，旋轉成這個控制點的
射束限制裝置座標（`delivery.bld_to_lps`），裡面：靶上的原射源與機頭散射的第二射源（往 −z 射）、Y jaw、X jaw
（都用只有一片葉片的 TsDivergingMLC，見 `jaw`）、TsDivergingMLC（葉寬與開口都是投影到等中心平面的值，跟 DICOM 同定義）。
控制點之間（VMAT）切成機架每 `ARC_STEP_DEG` 一小段，每段在中點內插機架、jaw、葉片；**每段的歷史數 ∝ 這一段的 MU**
（TOPAS 的循序時間 ＋ Step 時間序列）。

## 換成 Gy

TOPAS 算的是「N 個歷史的劑量」。MU 校正（`beam_models` 的 `calibration`）：參考條件的模擬求出每個歷史在 dmax 的劑量
→ 每 MU 幾個歷史（快取在資料目錄，模型一改就重算）。射束劑量 ＝ 模擬劑量 × MU × 每 MU 歷史數 ÷ N × 分次數。
不確定度：TOPAS 回報每個歷史的標準差 s（實測核對過），總和的 1σ ＝ s × √N；射束之間獨立，平方和開根號。
"""

from __future__ import annotations

import dataclasses
import json
import math
import os
import re
import shutil
import subprocess
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import numpy as np
from rtgaia_geom import Grid
from scipy.ndimage import map_coordinates

from .. import beam_models
from ..ct_calibration import _SCHNEIDER_MATERIAL_BOUNDS, _SCHNEIDER_WEIGHTS, ELEMENTS, convert
from ..delivery import Beam, ControlPoint, bld_to_lps, interpolate, segments
from ..package import CalcInput, CalcResult

IMAGE = os.environ.get("RTGAIA_TOPAS_IMAGE", "opentopas/opentopas:v4.3.0-geant4-11.4.2")
ENGINE_VERSION = f"opentopas {IMAGE.rsplit(':', 1)[-1]} / rtgaia-topas 5"
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
TOPAS_EC_NOTE = "OpenTOPAS 用實體機頭與空氣模擬，不加射束模型的虛擬電子污染（那是 GPU 引擎的擬合成分）"
AIR_NOTE = "體素中心是空氣（或密度 < 0.02 g/cm³）的地方不報劑量"
DEFAULT_HISTORIES = 20_000_000
MIN_HISTORIES_PER_BEAM = 100_000
CALIBRATION_HISTORIES = 10_000_000
CUT_MM = 0.5
JAW_LENGTH_MM = 400.0
"""jaw 沿移動方向的長度（等中心投影）：關到射野一邊，身後還擋得到另一邊（± 200 mm）。"""
JAW_WIDTH_MM = 500.0
"""jaw 垂直於移動方向的寬度（等中心投影）：蓋住整個射野（± 250 mm）。"""
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


def calc_grid(out: Grid, spacing_mm: float | None) -> Grid:
    """Monte Carlo 計分用的網格：跟輸出網格同一個範圍與方向、每軸 `spacing_mm` 的立方體素；
    沒指定或不比輸出粗就用輸出網格本身。"""
    if not spacing_mm or spacing_mm <= max(out.spacing) + 1e-6:
        return out
    size = np.asarray(out.size) * np.asarray(out.spacing)
    n = np.maximum(1, np.ceil(size / spacing_mm - 1e-6)).astype(int)
    center = np.asarray(out.origin) + (np.asarray(out.size) - 1) / 2 * np.asarray(out.spacing)
    origin = center - (n - 1) / 2 * spacing_mm
    return Grid(
        size=(int(n[0]), int(n[1]), int(n[2])),
        spacing=(float(spacing_mm),) * 3,
        origin=(float(origin[0]), float(origin[1]), float(origin[2])),
        direction=out.direction,
        frame_of_reference_uid=out.frame_of_reference_uid,
    )


def to_output(values: list[np.ndarray], src: Grid, out: Grid) -> list[np.ndarray]:
    """計分網格 (k, j, i) → 輸出網格的三線性內插；NaN（空氣）不參與 —— 權重只算有值的鄰居，
    鄰居全是 NaN 的點是 NaN。兩個網格都跟 LPS 軸對齊（`patient_on_grid` 已經擋過斜的）。"""
    ni, nj, nk = out.size
    pts = [np.asarray(out.origin[a]) + np.arange(out.size[a]) * out.spacing[a] for a in range(3)]
    fi, fj, fk = ((pts[a] - src.origin[a]) / src.spacing[a] for a in range(3))
    kk, jj, ii = np.meshgrid(fk, fj, fi, indexing="ij")
    coords = [kk.ravel(), jj.ravel(), ii.ravel()]
    valid = np.isfinite(values[0])
    w = map_coordinates(valid.astype(np.float32), coords, order=1, mode="nearest", prefilter=False)
    res = []
    for v in values:
        num = map_coordinates(
            np.where(valid, v, 0).astype(np.float32), coords, order=1, mode="nearest", prefilter=False
        )
        with np.errstate(invalid="ignore", divide="ignore"):
            res.append(np.where(w > 1e-6, num / w, np.nan).reshape(nk, nj, ni).astype(np.float32))
    return res


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


REFERENCE_FIELD_HALF_MM = 200.0
"""射源的「每個歷史」以等中心平面 40 × 40 cm 的參考錐角為準（MU 校正與計畫都換算到這個錐角）。"""


def _ellipse(ext_x: float, ext_y: float, z_mm: float) -> tuple[float, float]:
    """矩形 ±ext_x × ±ext_y（距射源 z_mm 的平面）在 TOPAS 的 Marsaglia 座標裡**外接**的橢圓半軸 (a, b)。

    TOPAS 的角度抽樣：在 Marsaglia 座標 m ＝ sin(θ／2) 上抽、只留橢圓內的（`TsGeneratorBeam::SetDirection`）。
    橢圓內切矩形會漏掉射野四角 → 半軸取 √2 倍，四角剛好在橢圓上。"""
    mx = math.sin(math.atan(ext_x / z_mm) / 2)
    my = math.sin(math.atan(ext_y / z_mm) / 2)
    return mx * math.sqrt(2.0), my * math.sqrt(2.0)


def _cutoff_deg(m: float) -> float:
    return math.degrees(2 * math.asin(min(m, 0.99)))


def _mass(a: float, b: float, sigma_deg: float | None) -> float:
    """角分佈落在 Marsaglia 橢圓 (a, b) 裡的機率質量（相對值）。均勻 ＝ 橢圓面積；高斯（σ 是角度）＝ 二維常態在橢圓內的
    積分：P ＝ ab／(2πσ²) ∫₀^{2π} (1 − e^{−k})／(2k) dφ，k ＝ (a²cos²φ ＋ b²sin²φ)／(2σ²)。"""
    if not sigma_deg:
        return a * b
    s = math.sin(math.radians(sigma_deg) / 2)
    phi = np.linspace(0, 2 * math.pi, 2049)[:-1]
    k = (a * a * np.cos(phi) ** 2 + b * b * np.sin(phi) ** 2) / (2 * s * s)
    f = np.where(k > 1e-12, (1 - np.exp(-k)) / (2 * k), 0.5)
    return float(a * b / (2 * math.pi * s * s) * f.mean() * 2 * math.pi)


def _extent(cp: ControlPoint, beam: Beam) -> tuple[float, float]:
    """這一小段會透光的範圍（等中心平面 mm，對稱的半寬）：jaw ∩ 每一層 MLC 打開的葉片。"""
    x = max(abs(cp.jaw_x[0]), abs(cp.jaw_x[1]))
    y = max(abs(cp.jaw_y[0]), abs(cp.jaw_y[1]))
    for bounds, a_, b_ in (
        (beam.leaf_boundaries_mm, cp.mlc_a, cp.mlc_b),
        (beam.leaf2_boundaries_mm, cp.mlc2_a, cp.mlc2_b),
    ):
        if not bounds or a_ is None or b_ is None:
            continue
        rows = [i for i, (u, v) in enumerate(zip(a_, b_, strict=True)) if v - u > 0.5]
        if not rows:
            continue
        x = min(x, max(max(abs(a_[i]), abs(b_[i])) for i in rows))
        y = min(y, max(max(abs(bounds[i]), abs(bounds[i + 1])) for i in rows))
    return x, y


@dataclass
class SourcePlan:
    """一個射束怎麼發射：每一小段（控制點之間切出來的）的狀態、錐角（Marsaglia 座標）、歷史數、換算 M。
    OpenTOPAS 與 GPU 引擎共用 —— 兩個引擎的射源一樣，MU 換算才能互相比。"""

    states: list[tuple[ControlPoint, float]]
    cones_p: list[tuple[float, float]]
    cones_e: list[tuple[float, float]]
    hist_pr: list[int]
    hist_ef: list[int]
    m_equiv: float
    z_ef: float
    """機頭散射射源的高度（距等中心平面，mm；跟 BLD 的 z 同向）。"""
    cones_c: list[tuple[float, float]] = field(default_factory=list)
    hist_ec: list[int] = field(default_factory=list)
    """電子污染（只有 GPU 引擎發射；OpenTOPAS 用實體機頭與空氣，不加這個虛擬射源）。"""
    z_ec: float = 0.0
    backscatter: list[float] = field(default_factory=list)
    """每一小段的監測游離腔訊號比 s（參考射野 ＝ 1）：每 MU 的粒子數 ∝ 1／s。"""


def backscatter_factor(model: dict[str, Any], cp: ControlPoint) -> float:
    """監測游離腔的反散射：jaw 越小、打回游離腔的越多 → 同樣的 MU 打出的粒子越少。
    s ＝ 1 ＋ b_x（X_ref − X）＋ b_y（Y_ref − Y），X、Y 是 jaw 開口（mm），參考射野 ＝ MU 校正的射野。沒有 jaw 或沒有
    這個參數 → 1。"""
    bs = model["params"].get("monitor_backscatter") or {}
    if not bs or "jaw_x" not in model["params"]["collimators"]:
        return 1.0
    ref = float(model["calibration"]["field_mm"])
    x = cp.jaw_x[1] - cp.jaw_x[0]
    y = cp.jaw_y[1] - cp.jaw_y[0]
    return 1.0 + float(bs.get("per_mm_x") or 0.0) * (ref - x) + float(bs.get("per_mm_y") or 0.0) * (ref - y)


def source_plan(beam: Beam, model: dict[str, Any], histories: int, *, engine: str = "gpu") -> SourcePlan:
    """原射源、機頭散射、電子污染各自的錐角只蓋到會透光的範圍（省歷史數）；每個射源的歷史數 ∝ 權重 × 錐角內的機率
    質量 ÷ 監測游離腔的反散射 s，M ＝ Σ 歷史數 × s ／ 質量比 —— 劑量 ÷ M 就跟錐角大小無關（MU 校正與計畫的錐角
    不同也能互換），反散射只改變每 MU 的粒子數。"""
    p = model["params"]
    states = _states(beam)
    ef = p.get("extra_focal") or {}
    ef_frac = float(ef.get("fraction") or 0.0)
    ec = p.get("electron_contamination") or {}
    ec_frac = float(ec.get("fraction") or 0.0)
    sad = beam.sad_mm
    margin = float(p.get("field_margin_mm", 10.0))
    sig = p.get("angular_sigma_deg")
    ref_p = _mass(*_ellipse(REFERENCE_FIELD_HALF_MM, REFERENCE_FIELD_HALF_MM, sad), sig)
    z_ef = sad - float(ef.get("distance_below_target_mm") or 0.0)
    # 機頭散射的錐角：GPU 從偏移的出發點瞄準開口（錐角只蓋開口）；OpenTOPAS 的 Beam 射源方向跟出發位置無關，
    # 要多蓋 3σ 才打得到開口（大部分被準直器吸收）
    sig_ef_mm = 3 * float(ef.get("sigma_mm") or 0.0) if engine == "topas" else 0.0
    ref_e = (
        _mass(*_ellipse(REFERENCE_FIELD_HALF_MM + sig_ef_mm, REFERENCE_FIELD_HALF_MM + sig_ef_mm, z_ef), None)
        if ef_frac > 0
        else 1.0
    )
    # 電子污染：方向只往開口（不加 3σ），射源的高斯 σ 把它在病人表面抹開 → 小射野抹出去的多、中心軸的電子少，
    # 大射野飽和 —— 量測上表面劑量隨射野變大的趨勢靠這個
    z_ec = sad - float(ec.get("distance_below_target_mm") or 0.0)
    ref_c = _mass(*_ellipse(REFERENCE_FIELD_HALF_MM, REFERENCE_FIELD_HALF_MM, z_ec), None) if ec_frac > 0 else 1.0
    # 每一小段自己的錐角（VMAT 的開口小、射束的包絡大 —— 用包絡的話大部分粒子打在 MLC 上）
    cones_p, cones_e, cones_c, shares_p, shares_e, shares_c = [], [], [], [], [], []
    for cp, _mu in states:
        ex, ey = _extent(cp, beam)
        ex, ey = ex + margin, ey + margin
        a_p, b_p = _ellipse(ex, ey, sad)
        cones_p.append((a_p, b_p))
        shares_p.append((1 - ef_frac - ec_frac) * _mass(a_p, b_p, sig) / ref_p)
        if ef_frac > 0:
            a_e, b_e = _ellipse(ex + sig_ef_mm, ey + sig_ef_mm, z_ef)
            cones_e.append((a_e, b_e))
            shares_e.append(ef_frac * _mass(a_e, b_e, None) / ref_e)
        else:
            cones_e.append((0.0, 0.0))
            shares_e.append(0.0)
        if ec_frac > 0:
            a_c, b_c = _ellipse(ex, ey, z_ec)
            cones_c.append((a_c, b_c))
            shares_c.append(ec_frac * _mass(a_c, b_c, None) / ref_c)
        else:
            cones_c.append((0.0, 0.0))
            shares_c.append(0.0)
    share = [a + b + c for a, b, c in zip(shares_p, shares_e, shares_c, strict=True)]
    bscat = [backscatter_factor(model, cp) for cp, _mu in states]
    # 每一小段的歷史數 ∝ MU ÷ s × 錐角內的質量 → 換算到參考錐角後每段的「每 MU 歷史數」只差反散射，總劑量可以一次換算
    hist = _split(histories, [mu / s * sh for (_cp, mu), sh, s in zip(states, share, bscat, strict=True)])
    hist_ef = [int(round(h * se / sh)) if sh > 0 else 0 for h, se, sh in zip(hist, shares_e, share, strict=True)]
    hist_ec = [int(round(h * sc / sh)) if sh > 0 else 0 for h, sc, sh in zip(hist, shares_c, share, strict=True)]
    hist_pr = [h - e - c for h, e, c in zip(hist, hist_ef, hist_ec, strict=True)]
    m_equiv = sum(h * s / sh for h, sh, s in zip(hist, share, bscat, strict=True) if sh > 0)
    return SourcePlan(states, cones_p, cones_e, hist_pr, hist_ef, m_equiv, z_ef, cones_c, hist_ec, z_ec, bscat)


def beam_parameters(
    beam: Beam, model: dict[str, Any], histories: int, *, iso: tuple[float, float, float], world_hl_mm: float
) -> tuple[str, int, float]:
    """一個射束的參數檔（不含病人與通用的部分）；回 (文字, 實際歷史數, 換算到參考錐角的歷史數 M)，見 `source_plan`。"""
    p = model["params"]
    plan = source_plan(beam, model, histories, engine="topas")
    states, cones_p, cones_e, hist_pr, hist_ef, m_equiv = (
        plan.states, plan.cones_p, plan.cones_e, plan.hist_pr, plan.hist_ef, plan.m_equiv,
    )  # fmt: skip
    n_steps = len(states)
    ef = p.get("extra_focal") or {}
    ef_frac = float(ef.get("fraction") or 0.0)
    sad = beam.sad_mm
    z_ef = plan.z_ef
    # 電子污染只給 GPU 引擎：OpenTOPAS 用實體機頭（含空氣），不再加這個虛擬射源（它的歷史數不發射，M 照算 → 劑量的
    # 換算不變，只是少了這一份）
    hist = [a + b for a, b in zip(hist_pr, hist_ef, strict=True)]
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
    # 最前面補一個權重 0 的能階：TOPAS 4.3 離散能譜抽樣在亂數落在第一格時會讀到陣列的第 −1 個值
    # （`TsVGenerator::SetEnergy` 的 while 先比較再檢查 j ≥ 0），讀到的垃圾值偶爾讓能量變負、整個執行中止
    # （2026-10-12 實測）。第一格權重 0 → 累積值 0 < 亂數，迴圈一定停在 j ＝ 0；抽到的分佈不變
    energies = [float(p["spectrum_mev"][0]), *p["spectrum_mev"]]
    weights = [0.0, *p["spectrum_weights"]]

    def source(
        name: str, z_mm: float, sigma_mm: float, cones: list[tuple[float, float]], counts: list[int]
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
        ]
        if n_steps == 1:
            out += [
                f"d:So/{name}/BeamAngularCutoffX = {_cutoff_deg(cones[0][0]):.6f} deg",
                f"d:So/{name}/BeamAngularCutoffY = {_cutoff_deg(cones[0][1]):.6f} deg",
            ]
        else:
            out += _step(f"{name}ConeX", [_cutoff_deg(c[0]) for c in cones], "deg")
            out += _step(f"{name}ConeY", [_cutoff_deg(c[1]) for c in cones], "deg")
            out += [
                f"d:So/{name}/BeamAngularCutoffX = Tf/{name}ConeX/Value deg",
                f"d:So/{name}/BeamAngularCutoffY = Tf/{name}ConeY/Value deg",
            ]
        if name == "Primary" and p.get("angular_sigma_deg"):
            # FFF：通量往外掉 —— 高斯角分佈（σ 是模型參數），範圍外截斷
            sig = float(p["angular_sigma_deg"])
            out += [
                f's:So/{name}/BeamAngularDistribution = "Gaussian"',
                f"d:So/{name}/BeamAngularSpreadX = {sig} deg",
                f"d:So/{name}/BeamAngularSpreadY = {sig} deg",
            ]
        else:
            out.append(f's:So/{name}/BeamAngularDistribution = "Flat"')
        if n_steps == 1:
            out.append(f"i:So/{name}/NumberOfHistoriesInRun = {counts[0]}")
        else:
            out += _step(f"{name}Count", [float(c) for c in counts], "", "iv")
            out[-1] = out[-1].replace(".000000", "")
            out.append(f"i:So/{name}/NumberOfHistoriesInRun = Tf/{name}Count/Value")
        return out

    L += source("Primary", sad, float(p["focal_spot_sigma_mm"]), cones_p, hist_pr)
    if ef_frac > 0:
        L += source("ExtraFocal", z_ef, float(ef["sigma_mm"]), cones_e, hist_ef)
    col = p["collimators"]

    def material(name: str, spec: dict[str, Any]) -> tuple[str, list[str]]:
        """準直器材質；`density_factor` ≠ 1（葉間漏射、鎢合金的有效密度）→ 同組成、密度乘上去的自訂材質。"""
        f = float(spec.get("density_factor") or 1.0)
        if abs(f - 1.0) < 1e-9 or spec["material"] != "G4_W":
            return str(spec["material"]), []
        mat = f"W{name}Eff"
        return mat, [
            f'sv:Ma/{mat}/Components = 1 "Tungsten"',
            f"uv:Ma/{mat}/Fractions = 1 1.0",
            f"d:Ma/{mat}/Density = {19.3 * f:.6g} g/cm3",
        ]

    def jaw(name: str, spec: dict[str, Any], axis: str, neg: list[float], pos: list[float]) -> list[str]:
        """一對 jaw ＝ 只有一片「葉片」的 TsDivergingMLC（沿 x 或 y 移動、端面對準射源）。

        不用 TOPAS 的 TsJaws：它的開口一變就整個重建，重建時用的是射束頭**上一步**的旋轉 —— 機架在轉、jaw 又在動
        （jaw tracking）時，jaw 落在錯的位置（2026-10-13 實測：PROTEAS 的 SRS 計畫只算出 TPS 的 1/4；同一段
        「動態」對「逐步靜態」0.41，jaw 固定就 0.99）。TsDivergingMLC 的葉片是就地移動，不重建，沒有這個問題。"""
        susd, thick = float(spec["source_to_upstream_mm"]), float(spec["thickness_mm"])
        mat, mat_lines = material(name, spec)
        out = [
            *mat_lines,
            f's:Ge/{name}/Type = "TsDivergingMLC"',
            f's:Ge/{name}/Parent = "Head"',
            f's:Ge/{name}/Material = "{mat}"',
            f"d:Ge/{name}/SAD = {sad} mm",
            f"d:Ge/{name}/SourceToUpstreamSurfaceDistance = {susd} mm",
            f"d:Ge/{name}/Thickness = {thick} mm",
            f"d:Ge/{name}/Length = {JAW_LENGTH_MM} mm",
            f"d:Ge/{name}/MaximumLeafOpen = 250 mm",
            f's:Ge/{name}/LeafTravelAxis = "{"Xb" if axis == "x" else "Yb"}"',
            f"d:Ge/{name}/RotZ = 0 deg",
            f"d:Ge/{name}/TransZ = {sad - susd - thick / 2} mm",
            f"dv:Ge/{name}/LeafWidths = 1 {JAW_WIDTH_MM} mm",
        ]
        if n_steps == 1 or (len(set(neg)) == 1 and len(set(pos)) == 1):
            out += [
                f"dv:Ge/{name}/NegativeFieldSetting = 1 {neg[0]} mm",
                f"dv:Ge/{name}/PositiveFieldSetting = 1 {pos[0]} mm",
            ]
        else:
            out += _step(f"{name}Neg", neg, "mm") + _step(f"{name}Pos", pos, "mm")
            out += [
                f"dv:Ge/{name}/NegativeFieldSetting = 1 Tf/{name}Neg/Value mm",
                f"dv:Ge/{name}/PositiveFieldSetting = 1 Tf/{name}Pos/Value mm",
            ]
        return out

    for key, axis in (("fixed_y", "y"), ("fixed_x", "x")):
        if key in col:  # 固定的主準直器：開口不跟控制點走
            h = float(col[key]["half_field_mm"])
            L += jaw("Fixed" + axis.upper(), col[key], axis, [-h] * n_steps, [h] * n_steps)
    if "jaw_y" in col:
        L += jaw("JawY", col["jaw_y"], "y", [cp.jaw_y[0] for cp, _ in states], [cp.jaw_y[1] for cp, _ in states])
    if "jaw_x" in col:
        L += jaw("JawX", col["jaw_x"], "x", [cp.jaw_x[0] for cp, _ in states], [cp.jaw_x[1] for cp, _ in states])

    def mlc(
        name: str, spec: dict[str, Any], bounds: list[float], rows_a: list[list[float]], rows_b: list[list[float]]
    ) -> list[str]:
        if abs(bounds[0] + bounds[-1]) > 1e-3:
            raise ValueError("MLC 葉片邊界不對稱：還不支援")
        widths = [b - a for a, b in zip(bounds, bounds[1:], strict=False)]
        n_leaves = len(widths)
        susd, thick = float(spec["source_to_upstream_mm"]), float(spec["thickness_mm"])
        mat, mat_lines = material(name, spec)
        out = [
            *mat_lines,
            f's:Ge/{name}/Type = "TsDivergingMLC"',
            f's:Ge/{name}/Parent = "Head"',
            f's:Ge/{name}/Material = "{mat}"',
            f"d:Ge/{name}/SAD = {sad} mm",
            f"d:Ge/{name}/SourceToUpstreamSurfaceDistance = {susd} mm",
            f"d:Ge/{name}/Thickness = {thick} mm",
            f"d:Ge/{name}/Length = {spec['leaf_length_mm']} mm",
            f"d:Ge/{name}/MaximumLeafOpen = 250 mm",
            f's:Ge/{name}/LeafTravelAxis = "Xb"',
            f"d:Ge/{name}/RotZ = 0 deg",
            f"d:Ge/{name}/TransZ = {sad - susd - thick / 2} mm",
            f"dv:Ge/{name}/LeafWidths = {n_leaves} " + " ".join(f"{w:g}" for w in widths) + " mm",
        ]
        neg_rows = [[min(a, b) for a, b in zip(ra, rb, strict=True)] for ra, rb in zip(rows_a, rows_b, strict=True)]
        pos_rows = [[max(a, b) for a, b in zip(ra, rb, strict=True)] for ra, rb in zip(rows_a, rows_b, strict=True)]
        if n_steps == 1:
            out += [
                f"dv:Ge/{name}/NegativeFieldSetting = {n_leaves} " + " ".join(f"{v:.4g}" for v in neg_rows[0]) + " mm",
                f"dv:Ge/{name}/PositiveFieldSetting = {n_leaves} " + " ".join(f"{v:.4g}" for v in pos_rows[0]) + " mm",
            ]
        else:
            neg_refs, pos_refs = [], []
            for leaf in range(n_leaves):
                out += _step(f"{name}N{leaf}", [r[leaf] for r in neg_rows], "mm")
                out += _step(f"{name}P{leaf}", [r[leaf] for r in pos_rows], "mm")
                neg_refs.append(f"Tf/{name}N{leaf}/Value")
                pos_refs.append(f"Tf/{name}P{leaf}/Value")
            out += [
                f"dv:Ge/{name}/NegativeFieldSetting = {n_leaves} " + " ".join(neg_refs) + " mm",
                f"dv:Ge/{name}/PositiveFieldSetting = {n_leaves} " + " ".join(pos_refs) + " mm",
            ]
        return out

    devices = beam.mlc_devices or (["MLCX"] if beam.leaf_boundaries_mm else [])
    if beam.leaf_boundaries_mm and states[0][0].mlc_a is not None:
        L += mlc(
            "MLC",
            col[devices[0]],
            beam.leaf_boundaries_mm,
            [cp.mlc_a for cp, _ in states],
            [cp.mlc_b for cp, _ in states],
        )  # type: ignore[misc]
    if beam.leaf2_boundaries_mm and states[0][0].mlc2_a is not None:
        L += mlc(
            "MLC2",
            col["MLCX2"],
            beam.leaf2_boundaries_mm,
            [cp.mlc2_a for cp, _ in states],
            [cp.mlc2_b for cp, _ in states],
        )  # type: ignore[misc]
    return "\n".join(L), sum(hist), m_equiv


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
    out_grid = inp.dose_grid
    grid = calc_grid(out_grid, inp.options.get("calc_spacing_mm"))
    inp = dataclasses.replace(inp, dose_grid=grid)
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
        text, n_hist, m_equiv = beam_parameters(
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
        scale = beam.mu * hpm / m_equiv * inp.delivery.fractions
        per_beam[beam.number] = (s * scale).astype(np.float32)
        var_total += (sd * math.sqrt(n_hist) * scale) ** 2
        done_before += n_hist
    # 中心是空氣（Schneider 第 1 段）的邊緣體素也不報：半空氣、質量小、雜訊大
    air = (rho < AIR_DENSITY_LIMIT) | (mat == 0)
    numbers = list(per_beam)
    dose = np.where(air, np.nan, np.sum(list(per_beam.values()), axis=0))
    sigma = np.where(air, np.nan, np.sqrt(var_total))
    per_list = [np.where(air, np.nan, per_beam[n]) for n in numbers]
    if grid is not out_grid:
        # 粗網格 → 輸出網格。σ 直接內插是保守的（相鄰體素的雜訊獨立，內插值的 σ 其實更小）；
        # 空氣再照輸出網格自己的密度判一次
        dose, sigma, *per_list = to_output([dose, sigma, *per_list], grid, out_grid)
        _c, rho_o, mat_o, _i = patient_on_grid(dataclasses.replace(inp, dose_grid=out_grid))
        air = (rho_o < AIR_DENSITY_LIMIT) | (mat_o == 0)
        dose = np.where(air, np.nan, dose)
        per_list = [np.where(air, np.nan, v) for v in per_list]
    with np.errstate(invalid="ignore", divide="ignore"):
        unc = np.where(dose > 0, sigma / dose, np.nan).astype(np.float32)
    unc = np.where(np.isnan(dose), np.nan, unc).astype(np.float32)
    per_beam = {n: v.astype(np.float32) for n, v in zip(numbers, per_list, strict=True)}
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
            "calc_grid": {"size": list(grid.size), "spacing_mm": list(grid.spacing)},
            "notes": [AIR_NOTE] + ([TOPAS_EC_NOTE] if "electron_contamination" in model["params"] else []),
        },
    )


# ── MU 校正 ───────────────────────────────────────────────────────────────────


def calibration_key(model: dict[str, Any]) -> str:
    """MU 校正快取的檔名：模型、模型雜湊、引擎版本 —— 任一個變了就重新校正。"""
    return f"{model['model_id']}-{beam_models.model_hash(model)}-{ENGINE_VERSION.replace(' ', '_').replace('/', '_')}"


def cached_calibration(model: dict[str, Any], cache_dir: Path) -> dict[str, Any] | None:
    """這個模型（這一版）已經做過的 MU 校正：每 MU 歷史數、dmax、參考條件的深度劑量；還沒做 → None。"""
    try:
        return dict(json.loads((Path(cache_dir) / f"{calibration_key(model)}.json").read_text(encoding="utf-8")))
    except (OSError, ValueError):
        return None


def reference_beam(model: dict[str, Any]) -> Beam:
    """MU 校正的參考射束：`model["calibration"]` 的射野（jaw；沒有 jaw 的機型用 MLC 開）、SSD ＝ SAD、機架 0°、HFS、
    等中心在原點（水面）、1 MU。OpenTOPAS 與 GPU 引擎共用。"""
    c = model["calibration"]
    half = float(c["field_mm"]) / 2
    ssd = float(c["ssd_mm"])
    ref_beam = Beam(
        number=1, name="calibration", energy_mv=model["energy_mv"], fluence_mode=model["fluence_mode"], sad_mm=ssd,
        isocenter_lps=(0.0, 0.0, 0.0), patient_position="HFS", mu=1.0,
        control_points=[
            ControlPoint(0.0, 0.0, 0.0, 0.0, (-half, half), (-half, half)),
            ControlPoint(1.0, 0.0, 0.0, 0.0, (-half, half), (-half, half)),
        ],
    )  # fmt: skip
    if "jaw_x" not in model["params"]["collimators"]:
        # 沒有 jaw 的機型（雙層 MLC）：參考射野用 MLC 開出來，兩層都開 ±half
        leaves = model["params"]["calibration_leaves"]
        ref_beam.mlc_devices = list(model.get("mlc_devices") or [])

        ref_beam.leaf_boundaries_mm = leaves["MLCX1"]
        ref_beam.leaf2_boundaries_mm = leaves["MLCX2"]
        for cp in ref_beam.control_points:
            cp.mlc_a, cp.mlc_b = mlc_opening(leaves["MLCX1"], -half, half, -half, half)
            cp.mlc2_a, cp.mlc2_b = mlc_opening(leaves["MLCX2"], -half, half, -half, half)
    return ref_beam


def mlc_opening(bounds: list[float], x1: float, x2: float, y1: float, y2: float) -> tuple[list[float], list[float]]:
    """矩形射野 [x1, x2] × [y1, y2]（等中心平面 mm）→ 一層 MLC 的 A、B 側位置：跟射野在 y 上**有重疊**的葉片打開到
    x1…x2，其他關在 0（gap 0）。只開中心點在射野內的葉片會讓錯開半片的那一層少開半片（Halcyon 上層在 10 × 10 只開
    到 9 cm）。"""
    a, b = [], []
    for lo, hi in zip(bounds, bounds[1:], strict=False):
        inside = hi > y1 + 1e-6 and lo < y2 - 1e-6
        a.append(x1 if inside else 0.0)
        b.append(x2 if inside else 0.0)
    return a, b


def calibration(model: dict[str, Any], cache_dir: Path, *, progress: Any = None, label: str = "calibration") -> float:
    """每 MU 幾個歷史：參考條件（`model["calibration"]`）水中 dmax 的劑量 ＝ `gy_per_mu`。快取。"""
    key = calibration_key(model)
    cache_dir.mkdir(parents=True, exist_ok=True)
    cached = cache_dir / f"{key}.json"
    if cached.exists():
        return float(json.loads(cached.read_text(encoding="utf-8"))["histories_per_mu"])
    c = model["calibration"]
    ssd = float(c["ssd_mm"])
    wd = cache_dir / key
    wd.mkdir(parents=True, exist_ok=True)
    ref_beam = reference_beam(model)
    text, n_hist, m_equiv = beam_parameters(
        ref_beam, model, CALIBRATION_HISTORIES, iso=(0.0, 0.0, 0.0), world_hl_mm=ssd + 600.0
    )
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
    d_per_hist = float(smooth[j]) / m_equiv  # 每個「參考錐角」歷史的劑量
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
        "depth_step_mm": 2.0,
    }
    cached.write_text(json.dumps(doc), encoding="utf-8")
    return hpm
