"""水箱裡的「虛擬量測」：射束模型在量測條件下的深度劑量、側向分佈、中心軸劑量，以及從它們導出的量。

射束模型的擬合與驗證都要拿模型跟量測比：同一個條件（射野、SSD、深度、準直方式）在水箱裡模擬，再用跟量測
**同一套定義**取出 dmax、PDD、半影、FWHM、unflatness、輸出因子…。這裡分兩半：

* **幾何與取值**（純 numpy，CI 也測）：`Setup` → `setup_beam`（模型的參考射束同一套規則）、`grid_for`（體素大小跟
  射野走）、`reduce`（每一批的劑量 → 中心軸深度曲線、指定深度的側向分佈）、`dmax_mm`／`pdd_at`／`profile_metrics`。
* **模擬**（`simulate`，要 GPU）：GPU 引擎在水箱裡跑，**逐批**取值 → 每個導出量都有自己的批次不確定度。

## 定義

* 座標：機架 0°、HFS，射束往 LPS +y；水面在 y ＝ 0，深度沿 +y。等中心在深度 SAD − SSD（射野一律定義在等中心平面，
  跟 DICOM 與多數量測習慣一致）。側向分佈的「x」是 jaw X／葉片移動方向。
* 中心軸劑量：|x|、|z| ≤ `r_avg` 的平均（`r_avg` ＝ 射野的 1/20，0.25–5 mm）。
* dmax：中心軸深度曲線在峰值前後（−10…+14 mm）四次多項式擬合的最大值。PDD 以 dmax 的劑量正規化（%）。
* TPR20,10：`1.2661 × PDD20/PDD10 − 0.0595`（TRS-398 的經驗式，SSD 100、10 × 10）—— 跟文獻從 PDD 換算的方法一樣。
* 側向分佈：在那個深度前後一格平均、|z| ≤ `r_avg`、左右鏡射平均。整平射束以中心軸正規化；**FFF** 以反曲點
  （梯度最大處）為 50% 重新正規化（Fogliata 2012 的概念、Lim 2019 的做法）。
* **偵檢器的體積平均**：側向分佈先跟量測用的偵檢器做卷積（`DETECTOR_RADIUS_MM`；圓柱游離腔的軸垂直於掃描方向 →
  核 ∝ √(r² − x²)）—— 6 mm 的游離腔會把 80–20% 半影拉寬 2–3 mm，不算進去就是拿兩種東西比。偵檢器不明 → 不卷積、
  在結果備註。
* 半影（80–20%）、FWHM（50%）：兩側線性內插的位置。unflatness ＝ D(0)／D(0.8 × FWHM/2)；
  slope（%/mm）＝ 1/3 與 2/3 半寬之間的斜率（Tanaka 2020 式 2），取絕對值。
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field
from typing import Any

import numpy as np

from .delivery import Beam, ControlPoint
from .engines.topas import mlc_opening

DEPTH_STEP_MM = 2.0
DEPTH_MAX_MM = 300.0
LATERAL_MARGIN_MM = 60.0
JAW_MARGIN_MM = 2.0
JAW_MIN_MM = 8.0
"""MLC 定義的射野：jaw ＝ MLC ＋ 2 mm、至少 8 mm（Akino 2020 的設定）。"""
MILLENNIUM_120 = [float(v) for v in [*range(-200, -100, 10), *range(-100, 100, 5), *range(100, 201, 10)]]
"""單層 MLC 沒寫葉片邊界時用的 Millennium 120：外側各 10 對 10 mm、中間 40 對 5 mm（共 60 對）。"""


@dataclass(frozen=True)
class Setup:
    """一個水箱量測條件。`field_x`、`field_y` 在等中心平面（mm）。"""

    field_x: float
    field_y: float
    ssd: float
    collimation: str = "jaw"
    """`jaw`（MLC 退開）／`mlc`（MLC 定義、jaw 稍大）／`closed`（`closed_layer` 那層整片關上：穿透）。"""
    closed_layer: str = ""
    profile_depths: tuple[float, ...] = ()
    """要取側向分佈的深度（mm）。"""

    @property
    def key(self) -> str:
        d = ",".join(f"{v:g}" for v in self.profile_depths)
        return f"{self.field_x:g}x{self.field_y:g}@{self.ssd:g}/{self.collimation}{self.closed_layer}[{d}]"

    @property
    def r_avg(self) -> float:
        return float(np.clip(min(self.field_x, self.field_y) / 20.0, 0.25, 5.0))


@dataclass
class Grid:
    shape: tuple[int, int, int]
    """(nz, ny, nx)。"""
    spacing: tuple[float, float, float]
    """(sx, sy, sz) mm。"""
    corner: tuple[float, float, float]

    def centers(self, axis: int) -> np.ndarray:
        n = self.shape[2 - axis]
        return self.corner[axis] + (np.arange(n) + 0.5) * self.spacing[axis]


def grid_for(setup: Setup, sad: float) -> Grid:
    """體素跟射野走：x（側向分佈的方向）0.5–1 mm、z 0.5–5 mm、深度 2 mm；側向範圍包住最深處的射野 ＋ 60 mm。
    兩個側向軸的格數都是奇數 → 中心軸落在一格的正中央。"""
    small = min(setup.field_x, setup.field_y)
    sx = float(np.clip(small / 20.0, 0.5, 1.0))
    sz = float(np.clip(small / 10.0, 0.5, 5.0))
    grow = (setup.ssd + DEPTH_MAX_MM) / sad
    hx = min(300.0, setup.field_x / 2 * grow + LATERAL_MARGIN_MM)
    hz = min(300.0, setup.field_y / 2 * grow + LATERAL_MARGIN_MM)
    nx = 2 * int(math.ceil(hx / sx)) + 1
    nz = 2 * int(math.ceil(hz / sz)) + 1
    ny = int(round(DEPTH_MAX_MM / DEPTH_STEP_MM))
    return Grid((nz, ny, nx), (sx, DEPTH_STEP_MM, sz), (-nx * sx / 2, 0.0, -nz * sz / 2))


def _boundaries(model: dict[str, Any], device: str) -> list[float]:
    p = model["params"]
    spec = p["collimators"].get(device) or {}
    if spec.get("leaf_boundaries_mm"):
        return [float(v) for v in spec["leaf_boundaries_mm"]]
    if (p.get("calibration_leaves") or {}).get(device):
        return [float(v) for v in p["calibration_leaves"][device]]
    return list(MILLENNIUM_120)


def setup_beam(model: dict[str, Any], setup: Setup, sad: float = 1000.0) -> Beam:
    """量測條件 → 1 MU 的射束（機架 0°、HFS，等中心在 (0, SAD − SSD, 0)）。

    * 有 jaw 的機型：`jaw` → jaw 開到射野、沒有 MLC；`mlc` → MLC 開到射野、jaw 稍大；`closed` → jaw 開到射野、
      MLC 整片關在射野外。
    * 沒有 jaw 的機型（雙層 MLC）：兩層都照射野開（`mlc_opening`）；`closed` → `closed_layer` 那層關在射野外、
      另一層照開。"""
    hx, hy = setup.field_x / 2, setup.field_y / 2
    col = model["params"]["collimators"]
    has_jaws = "jaw_x" in col
    jx, jy = (hx, hy)
    if has_jaws and setup.collimation == "mlc":
        jx = max(JAW_MIN_MM / 2, hx + JAW_MARGIN_MM / 2)
        jy = max(JAW_MIN_MM / 2, hy + JAW_MARGIN_MM / 2)
    if not has_jaws:
        jx, jy = hx, hy  # 虛擬值（沒有 jaw），引擎不用
    cps = [
        ControlPoint(0.0, 0.0, 0.0, 0.0, (-jx, jx), (-jy, jy)),
        ControlPoint(1.0, 0.0, 0.0, 0.0, (-jx, jx), (-jy, jy)),
    ]
    beam = Beam(
        number=1, name=setup.key, energy_mv=model["energy_mv"], fluence_mode=model["fluence_mode"], sad_mm=sad,
        isocenter_lps=(0.0, sad - setup.ssd, 0.0), patient_position="HFS", mu=1.0, control_points=cps,
    )  # fmt: skip
    devices = list(model.get("mlc_devices") or [])
    if setup.collimation == "jaw" and has_jaws:
        return beam
    if not devices:
        raise ValueError(f"射束模型 {model.get('model_id')} 沒有 MLC：不能做 MLC 定義或關閉的射野")
    beam.mlc_devices = devices
    layers = []
    for dev in devices:
        bounds = _boundaries(model, dev)
        if setup.collimation == "closed" and (dev == setup.closed_layer or len(devices) == 1):
            # 整片關：A、B 兩側都在射野外的同一點（gap 0）→ 射野全被這一層的葉片擋住
            park = hx + 10.0
            a, b = [park] * (len(bounds) - 1), [park] * (len(bounds) - 1)
        else:
            a, b = mlc_opening(bounds, -hx, hx, -hy, hy)
        layers.append((bounds, a, b))
    beam.leaf_boundaries_mm = layers[0][0]
    for cp in cps:
        cp.mlc_a, cp.mlc_b = layers[0][1], layers[0][2]
    if len(layers) > 1:
        beam.leaf2_boundaries_mm = layers[1][0]
        for cp in cps:
            cp.mlc2_a, cp.mlc2_b = layers[1][1], layers[1][2]
    return beam


def field_note(model: dict[str, Any], setup: Setup) -> str:
    """MLC 定義的射野做不出來時（葉片寬度不是射野的整數倍）說明實際的 y 範圍；做得出來 → 空字串。"""
    beam = setup_beam(model, setup)
    cp = beam.control_points[0]
    extents = []
    for bounds, a in ((beam.leaf_boundaries_mm, cp.mlc_a), (beam.leaf2_boundaries_mm, cp.mlc2_a)):
        if bounds and a is not None:
            rows = [(lo, hi) for lo, hi, x in zip(bounds, bounds[1:], a, strict=False) if x != 0.0]
            if rows:
                extents.append(rows[-1][1] - rows[0][0])
    y = min([*extents, cp.jaw_y[1] - cp.jaw_y[0]] if "jaw_y" in model["params"]["collimators"] else extents or [0.0])
    if abs(y - setup.field_y) <= 0.1:
        return ""
    return f"模型的葉片做不出 y {setup.field_y:g} mm：實際 y {y:g} mm（MLC 葉寬與 jaw 決定）"


# ── 每一批的劑量 → 曲線 ──────────────────────────────────────────────────────


@dataclass
class Curves:
    """一批（或平均）的取值：中心軸深度曲線與各深度的側向分佈（劑量 ÷ 換算 M：每個「參考錐角歷史」的 Gy）。"""

    depth_mm: np.ndarray
    cax: np.ndarray
    x_mm: np.ndarray
    """側向分佈的位置（≥ 0，鏡射後）。"""
    profiles: dict[float, np.ndarray] = field(default_factory=dict)


def reduce(dose: np.ndarray, grid: Grid, setup: Setup) -> Curves:
    """(nz, ny, nx) 劑量 → 中心軸深度曲線（|x|、|z| ≤ r_avg 平均）與 `profile_depths` 的側向分佈（前後一格、
    |z| ≤ r_avg、左右鏡射平均）。"""
    xs, ys, zs = grid.centers(0), grid.centers(1), grid.centers(2)
    r = setup.r_avg + 1e-6
    ix = np.abs(xs) <= max(r, grid.spacing[0] / 2 + 1e-6)
    iz = np.abs(zs) <= max(r, grid.spacing[2] / 2 + 1e-6)
    band = dose[iz].mean(axis=0)  # (ny, nx)
    cax = band[:, ix].mean(axis=1)
    nx = band.shape[1]
    c = nx // 2
    right = band[:, c:]
    left = band[:, c::-1]
    mirrored = (right + left) / 2  # (ny, nx//2+1)，x ＝ 0 起
    profiles = {}
    for d in setup.profile_depths:
        j = int(np.clip(np.searchsorted(ys, d), 1, len(ys) - 1))
        lo = j - 1 if abs(ys[j - 1] - d) <= abs(ys[j] - d) else j
        rows = [max(0, lo - 1), lo, min(len(ys) - 1, lo + 1)]
        w = np.array([0.25, 0.5, 0.25])
        profiles[float(d)] = (mirrored[rows] * w[:, None]).sum(axis=0)
    return Curves(depth_mm=ys, cax=cax, x_mm=xs[c:] - xs[c], profiles=profiles)


# ── 取值 ──────────────────────────────────────────────────────────────────────


def dmax_mm(depth: np.ndarray, cax: np.ndarray) -> float:
    """峰值（5 點平滑的最大值）前後 −10…+14 mm 四次多項式擬合，取擬合曲線的最大值 —— 峰頂很平，只用頂點附近
    幾點的二次擬合對雜訊太敏感。"""
    s = np.convolve(cax, np.ones(5) / 5, mode="same")
    j = int(np.argmax(s[2:-2])) + 2
    g = float(depth[j])
    sel = (depth >= g - 10.0) & (depth <= g + 14.0) & (depth > 0)
    if sel.sum() < 6:
        return g
    xs, ys = depth[sel], cax[sel]
    coef = np.polyfit(xs - g, ys, 4)
    fine = np.linspace(xs[0], xs[-1], 2001)
    return float(fine[int(np.argmax(np.polyval(coef, fine - g)))])


def dose_at(depth: np.ndarray, cax: np.ndarray, d: float) -> float:
    """深度 `d` 的中心軸劑量：附近 5 點的二次擬合（比線性內插抗雜訊）。"""
    j = int(np.clip(np.searchsorted(depth, d), 2, len(depth) - 3))
    sl = slice(j - 2, j + 3)
    coef = np.polyfit(depth[sl], cax[sl], 2)
    return float(np.polyval(coef, d))


def pdd_at(depth: np.ndarray, cax: np.ndarray, d: float) -> float:
    """以 dmax 正規化的 PDD（%）。"""
    dm = dmax_mm(depth, cax)
    return 100.0 * dose_at(depth, cax, d) / dose_at(depth, cax, dm)


def tpr20_10(depth: np.ndarray, cax: np.ndarray) -> float:
    """TRS-398 的經驗式（SSD 100 的 PDD20/PDD10）。"""
    return 1.2661 * dose_at(depth, cax, 200.0) / dose_at(depth, cax, 100.0) - 0.0595


def _crossing(x: np.ndarray, y: np.ndarray, level: float) -> float:
    """y 從中心往外第一次低於 level 的位置（線性內插）。"""
    below = np.nonzero(y < level)[0]
    if len(below) == 0 or below[0] == 0:
        return float("nan")
    k = int(below[0])
    x0, x1, y0, y1 = x[k - 1], x[k], y[k - 1], y[k]
    return float(x0 + (level - y0) * (x1 - x0) / (y1 - y0))


DETECTOR_RADIUS_MM = {
    # 偵檢器 → 掃描方向上的有效半徑（mm）：游離腔是內徑的一半；二極體、鑽石、EDGE 是靈敏區的一半
    # （Akino 2020 表 1 的靈敏區大小；游離腔是廠商標示的內徑）
    "cc13": 3.0,
    "cc04": 2.0,
    "cc01": 1.0,
    "31010": 2.75,
    "31016": 1.45,
    "30013": 3.05,
    "farmer": 3.05,
    "edge": 0.4,
    "60017": 0.565,
    "60018": 0.565,
    "60019": 1.1,
    "sfd": 0.3,
    "diode": 0.5,
}


def detector_radius(name: str) -> float | None:
    """偵檢器名稱（自由文字）→ 有效半徑；認不出來 → None。名稱裡有好幾種（「CC13 or PTW 31010」）→ 取平均。"""
    text = name.lower().replace(" ", "")
    hits = [r for key, r in DETECTOR_RADIUS_MM.items() if key in text]
    return float(np.mean(hits)) if hits else None


def average_detector(x: np.ndarray, prof: np.ndarray, radius: float) -> np.ndarray:
    """鏡射後的半邊側向分佈（x ≥ 0、等間距）跟偵檢器的核卷積：核 ∝ √(r² − u²)（圓柱腔的截面弦長）。"""
    if radius <= 0 or len(x) < 3:
        return prof
    dx = float(x[1] - x[0])
    n = int(math.ceil(radius / dx + 0.5))
    # 每一格的權重 ＝ 弦長在那一格裡的積分（細分 21 點）—— 半徑跟格寬差不多時點取樣會退化成恆等
    sub = (np.arange(21) + 0.5) / 21 - 0.5
    u = (np.arange(-n, n + 1)[:, None] + sub[None, :]) * dx
    k = np.sqrt(np.clip(radius**2 - u**2, 0.0, None)).sum(axis=1)
    if k.sum() <= 0:
        return prof
    k /= k.sum()
    full = np.concatenate([prof[:0:-1], prof])
    pad = np.concatenate([np.full(n, full[0]), full, np.full(n, full[-1])])
    out = np.convolve(pad, k, mode="valid")
    return out[len(prof) - 1 :]


def normalize_profile(x: np.ndarray, prof: np.ndarray, fff: bool) -> np.ndarray:
    """整平射束：中心軸 ＝ 100%。FFF：反曲點（梯度最大處，二次擬合）的劑量 ＝ 50%。"""
    if not fff:
        return 100.0 * prof / prof[0]
    g = -np.gradient(np.convolve(prof, np.ones(3) / 3, mode="same"), x)
    k = int(np.argmax(g[2:-2])) + 2
    sl = slice(k - 2, k + 3)
    a, b, _c = np.polyfit(x[sl], g[sl], 2)
    xi = float(np.clip(-b / (2 * a), x[k - 2], x[k + 2])) if a < 0 else float(x[k])
    di = float(np.interp(xi, x, prof))
    return 50.0 * prof / di


def profile_metrics(x: np.ndarray, prof: np.ndarray, fff: bool) -> dict[str, float]:
    """半影（80–20%）、FWHM、unflatness、slope（%/mm）；x 是鏡射後 ≥ 0 的位置。"""
    y = normalize_profile(x, prof, fff)
    x50, x80, x20 = (_crossing(x, y, v) for v in (50.0, 80.0, 20.0))
    half = x50
    out = {"fwhm_mm": 2 * half, "penumbra_80_20_mm": x20 - x80}
    if math.isfinite(half):
        out["unflatness"] = float(np.interp(0.0, x, y) / np.interp(0.8 * half, x, y))
        x1, x2 = half / 3, 2 * half / 3
        out["slope_percent_per_mm"] = float(abs(np.interp(x2, x, y) - np.interp(x1, x, y)) / (x2 - x1))
    return out


# ── 模擬（GPU）────────────────────────────────────────────────────────────────


@dataclass
class Simulated:
    setup: Setup
    grid: Grid
    batches: list[Curves]
    mean: Curves
    histories: int
    seconds: float
    m_equiv: float
    """每個「參考錐角歷史」的換算（劑量 ÷ M × 每 MU 歷史數 ＝ Gy/MU）。"""


def simulate(
    model: dict[str, Any], setup: Setup, tb: Any, histories: int, *, batches: int = 10, seed: int = 1
) -> Simulated:
    """GPU 引擎在水箱裡跑一個條件；逐批取值。劑量單位：每個參考錐角歷史的 Gy（× 每 MU 歷史數 ＝ Gy/MU）。"""
    from .gpumc import engine, tables, transport

    sad = 1000.0
    beam = setup_beam(model, setup, sad)
    grid = grid_for(setup, sad)
    nb = max(1, histories // batches)
    src, m_equiv = engine.beam_source(beam, model, nb)
    mat = np.full(grid.shape, tables.WATER, dtype=np.uint8)
    rho = np.ones(grid.shape, dtype=np.float32)
    per: list[Curves] = []

    def on_batch(e: np.ndarray) -> None:
        # 一批 nb 個歷史的總劑量 ÷ M（同一批的換算）＝ 每個參考錐角歷史的劑量（同 MU 校正）
        per.append(reduce(transport.dose_gy_per_history(e, rho, grid.spacing) / m_equiv, grid, setup))

    mean, _sd, info = transport.simulate_beam(
        tb, mat, rho, grid.spacing, grid.corner, src, batches=batches, seed=seed, on_batch=on_batch
    )
    avg = Curves(
        depth_mm=per[0].depth_mm,
        cax=np.mean([c.cax for c in per], axis=0),
        x_mm=per[0].x_mm,
        profiles={d: np.mean([c.profiles[d] for c in per], axis=0) for d in setup.profile_depths},
    )
    return Simulated(setup, grid, per, avg, info["histories"], info["seconds"], m_equiv)
