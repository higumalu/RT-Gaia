"""後端運算註冊表。

> **`op` 由後端註冊表決定，不是固定 enum。** `GET /api/v1/ops` 回傳可用運算與
> 參數 schema，**前端據此動態產生參數 UI** —— 新增運算不必改前端。

## `x-ui-widget` 詞彙表

JSON Schema 表達不了「這個欄位要用結構選擇器」或「這個範圍要在視圖上選」。
因此每個參數可帶一個 `x-ui-widget`，值域是**這張封閉清單**：

| widget | 前端該長出什麼 | 用在 |
|---|---|---|
| `number` | 數字輸入 ＋ 單位 | `sigma_mm`、`min_volume_cc` |
| `integer` | 整數 stepper | `keep_largest_n` |
| `boolean` | 開關 | `per_slice` |
| `enum` | 下拉 | `mode` |
| `structure-picker` | **結構清單選擇器**（同 FoR、排除自己） | `other_structure_id` |
| `slice-range` | **在視圖上拖出範圍**（回傳兩個索引） | `slice_range` |
| `hu-range` | HU 區間（兩個數字，帶預設集） | `hu_range` |
| `seed` | **以十字線所在體素當種子**（回傳 ijk） | `seed_ijk` |
| `bbox` | 以目前 3D 裁切方框當範圍（回傳 offset／size，可省略） | `bbox_ijk` |

清單封閉是刻意的：開放字串會讓前端出現 `if (widget === ...)` 的長鏈，而那正是
「核心不得認識任何模組專屬型別」這條原則要避免的。
"""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass
from typing import Any

import numpy as np
import SimpleITK as sitk
from rtgaia_geom.grid import Grid

OpFn = Callable[[np.ndarray, Grid, dict[str, Any], "OpContext"], np.ndarray]


@dataclass
class OpContext:
    """運算能取得的 session 側資料（`boolean` 需要另一個結構的 mask；`threshold`／`region_grow` 需要影像）。"""

    other_mask: Callable[[str], np.ndarray]
    image: Callable[[], np.ndarray | None] = lambda: None
    """該結構 FoR 的影像體素 `(k, j, i)`（HU）；與 mask grid 同一個網格（I5）。沒有影像回 None。"""


@dataclass(frozen=True)
class Op:
    op_id: str
    label: str
    params_schema: dict[str, Any]
    fn: OpFn
    description: str = ""

    def to_wire(self) -> dict[str, Any]:
        return {
            "op": self.op_id,
            "label": self.label,
            "description": self.description,
            "params_schema": self.params_schema,
        }


_REGISTRY: dict[str, Op] = {}


def register_op(
    op_id: str, *, label: str, params_schema: dict[str, Any], description: str = ""
) -> Callable[[OpFn], OpFn]:
    def deco(fn: OpFn) -> OpFn:
        _REGISTRY[op_id] = Op(op_id, label, params_schema, fn, description)
        return fn

    return deco


def registry() -> list[dict[str, Any]]:
    return [op.to_wire() for op in _REGISTRY.values()]


def get_op(op_id: str) -> Op:
    if op_id not in _REGISTRY:
        raise KeyError(f"未註冊的運算 {op_id!r}。可用：{', '.join(_REGISTRY)}")
    return _REGISTRY[op_id]


# ── 只看結構附近的運算在外接方塊上跑 ───────────────────────────────
#
# CI 效能門檻（`scripts/perf/ci_gate.py`）在 GitHub runner 上量到「單結構後處理往返」1.67 s，超過效能目標的 1.5 s：
# `smooth` 對整個 512×512×160 的 mask 網格做高斯（結構只佔 40×40×16）。這三個運算的結果只取決於結構附近：
#
# * `fill_holes`、`remove_islands`：洞與連通分量都在外接方塊裡；留 1 格背景，方塊邊界就是「連到外面的背景」，
#   結果與整個網格相同
# * `smooth`：高斯後閾值 0.5 —— 方塊外的點，結構全在它的一側，模糊後 ≤ 0.5，所以結果不會長出方塊；
#   每側留 4σ（換成各軸的體素數）＋ 1，遞迴高斯在裁切邊界的處理碰不到結構
#
# `threshold`、`region_grow`、`boolean`、`interpolate` 要看影像或別的結構、會長到方塊外，照舊整個網格。

_LOCAL_MARGIN_MM: dict[str, Callable[[dict[str, Any]], float]] = {
    "fill_holes": lambda p: 0.0,
    "remove_islands": lambda p: 0.0,
    "smooth": lambda p: 4.0 * float(p.get("sigma_mm", 1.5)),
}


def run_op(op: Op, mask: np.ndarray, grid: Grid, params: dict[str, Any], ctx: OpContext) -> np.ndarray:
    """跑一個運算；只看結構附近的（`_LOCAL_MARGIN_MM`）在外接方塊 ＋ 邊距上跑，貼回整個網格。全零照舊整個網格。"""
    margin_fn = _LOCAL_MARGIN_MM.get(op.op_id)
    m = np.asarray(mask)
    if margin_fn is None:
        return op.fn(m, grid, params, ctx)
    nz = np.nonzero(m)
    if nz[0].size == 0:
        return op.fn(m, grid, params, ctx)
    from dataclasses import replace

    mm = margin_fn(params)
    # mask 是 (k, j, i)；spacing 是 (i, j, k)
    pad = [int(np.ceil(mm / float(grid.spacing[a]))) + 1 for a in (2, 1, 0)]
    lo = [max(0, int(nz[d].min()) - pad[d]) for d in range(3)]
    hi = [min(int(m.shape[d]), int(nz[d].max()) + 1 + pad[d]) for d in range(3)]
    crop = np.ascontiguousarray(m[lo[0] : hi[0], lo[1] : hi[1], lo[2] : hi[2]])
    lo_ijk = (lo[2], lo[1], lo[0])
    origin = tuple(
        float(grid.origin[a])
        + sum(float(grid.direction[a * 3 + r]) * float(grid.spacing[r]) * lo_ijk[r] for r in range(3))
        for a in range(3)
    )
    sub = replace(grid, size=(hi[2] - lo[2], hi[1] - lo[1], hi[0] - lo[0]), origin=origin)
    out = np.zeros(m.shape, dtype=np.uint8)
    out[lo[0] : hi[0], lo[1] : hi[1], lo[2] : hi[2]] = op.fn(crop, sub, params, ctx)
    return out


# ── numpy ↔ SimpleITK ───────────────────────────────────────────────────────


def to_sitk(mask: np.ndarray, grid: Grid) -> sitk.Image:
    """numpy `(k, j, i)` → `sitk.Image`，**幾何完整帶過去**。

    🔴 忘記 `SetDirection` 是這裡最常見的錯誤：形態學運算本身不看幾何，所以
    測試會過，但 `interpolate` 這種**與方向有關**的運算就會在 `gantry_tilt` 上
    出錯——而且只在傾斜資料上出錯。
    """
    img = sitk.GetImageFromArray(np.ascontiguousarray(mask, dtype=np.uint8))
    img.SetSpacing([float(v) for v in grid.spacing])
    img.SetOrigin([float(v) for v in grid.origin])
    img.SetDirection([float(v) for v in grid.direction])
    return img


def from_sitk(img: sitk.Image) -> np.ndarray:
    return sitk.GetArrayFromImage(img).astype(np.uint8)


# ── 核心內建運算 ─────────────────────────────────────────


@register_op(
    "fill_holes",
    label="填洞",
    description="BinaryFillhole。per_slice=true 為 2D 逐層，否則 3D。",
    params_schema={
        "type": "object",
        "properties": {
            "per_slice": {
                "type": "boolean",
                "default": False,
                "title": "逐層處理（2D）",
                "x-ui-widget": "boolean",
            }
        },
    },
)
def fill_holes(mask: np.ndarray, grid: Grid, params: dict[str, Any], ctx: OpContext) -> np.ndarray:
    if params.get("per_slice"):
        out = np.zeros_like(mask)
        for k in range(mask.shape[0]):
            sl = sitk.GetImageFromArray(mask[k])
            out[k] = sitk.GetArrayFromImage(sitk.BinaryFillhole(sl))
        return out
    return from_sitk(sitk.BinaryFillhole(to_sitk(mask, grid)))


@register_op(
    "remove_islands",
    label="去離島",
    description="ConnectedComponent ＋ RelabelComponent。keep_largest_n 與 min_volume_cc 二擇一。",
    params_schema={
        "type": "object",
        "properties": {
            "keep_largest_n": {
                "type": "integer",
                "minimum": 1,
                "default": 1,
                "title": "保留最大的 N 個分量",
                "x-ui-widget": "integer",
            },
            "min_volume_cc": {
                "type": "number",
                "minimum": 0,
                "title": "最小體積（cc）",
                "x-ui-widget": "number",
                "x-unit": "cc",
            },
        },
    },
)
def remove_islands(mask: np.ndarray, grid: Grid, params: dict[str, Any], ctx: OpContext) -> np.ndarray:
    labeled = sitk.RelabelComponent(sitk.ConnectedComponent(to_sitk(mask, grid)), sortByObjectSize=True)
    arr = sitk.GetArrayFromImage(labeled)
    if params.get("min_volume_cc") is not None:
        min_voxels = float(params["min_volume_cc"]) * 1000.0 / grid.voxel_volume_mm3
        keep = [lab for lab in range(1, int(arr.max()) + 1) if np.count_nonzero(arr == lab) >= min_voxels]
    else:
        n = int(params.get("keep_largest_n", 1))
        keep = list(range(1, min(n, int(arr.max())) + 1))
    return np.isin(arr, keep).astype(np.uint8)


@register_op(
    "smooth",
    label="平滑",
    description="高斯平滑後閾值。sigma 以 mm 為單位，因此非等向資料上行為正確。",
    params_schema={
        "type": "object",
        "properties": {
            "sigma_mm": {
                "type": "number",
                "minimum": 0.1,
                "default": 1.5,
                "title": "σ（mm）",
                "x-ui-widget": "number",
                "x-unit": "mm",
            }
        },
    },
)
def smooth(mask: np.ndarray, grid: Grid, params: dict[str, Any], ctx: OpContext) -> np.ndarray:
    sigma = float(params.get("sigma_mm", 1.5))
    img = sitk.Cast(to_sitk(mask, grid), sitk.sitkFloat32)
    # 🔴 useImageSpacing=True：σ 是 mm 不是體素。非等向資料（1×1×5 mm）上
    # 兩者差 5 倍，而在等向假體上完全看不出來。
    blurred = sitk.SmoothingRecursiveGaussian(img, sigma, True)
    return (sitk.GetArrayFromImage(blurred) >= 0.5).astype(np.uint8)


@register_op(
    "boolean",
    label="布林運算",
    description="與另一個結構做聯集／交集／相減。",
    params_schema={
        "type": "object",
        "required": ["other_structure_id", "mode"],
        "properties": {
            "other_structure_id": {
                "type": "string",
                "title": "另一個結構",
                "x-ui-widget": "structure-picker",
                "x-same-frame-of-reference": True,
                "x-exclude-self": True,
            },
            "mode": {
                "type": "string",
                "enum": ["union", "intersect", "subtract"],
                "default": "union",
                "title": "運算",
                "x-ui-widget": "enum",
            },
        },
    },
)
def boolean(mask: np.ndarray, grid: Grid, params: dict[str, Any], ctx: OpContext) -> np.ndarray:
    other = ctx.other_mask(str(params["other_structure_id"]))
    mode = params.get("mode", "union")
    a = mask.astype(bool)
    b = other.astype(bool)
    if mode == "union":
        out = a | b
    elif mode == "intersect":
        out = a & b
    elif mode == "subtract":
        out = a & ~b
    else:
        raise ValueError(f"未知的 boolean mode {mode!r}")
    return out.astype(np.uint8)


@register_op(
    "interpolate",
    label="層間內插",
    description="在指定軸的兩層之間形態學內插（勾畫每隔幾層後補齊）。",
    params_schema={
        "type": "object",
        "required": ["slice_range"],
        "properties": {
            "axis": {
                "type": "string",
                "enum": ["i", "j", "k"],
                "default": "k",
                "title": "軸",
                "x-ui-widget": "enum",
            },
            "slice_range": {
                "type": "array",
                "items": {"type": "integer"},
                "minItems": 2,
                "maxItems": 2,
                "title": "範圍",
                "x-ui-widget": "slice-range",
            },
        },
    },
)
def interpolate(mask: np.ndarray, grid: Grid, params: dict[str, Any], ctx: OpContext) -> np.ndarray:
    """以帶符號距離場做線性內插 —— 形態學內插的標準做法。

    比「逐層 morph」穩定得多：距離場的線性混合對凹形與多連通分量都成立。
    """
    axis_name = params.get("axis", "k")
    axis = {"k": 0, "j": 1, "i": 2}[axis_name]
    lo, hi = (int(v) for v in params["slice_range"])
    if hi < lo:
        lo, hi = hi, lo
    out = mask.copy()
    moved = np.moveaxis(out, axis, 0)
    if hi - lo < 2:
        return out
    a = moved[lo].astype(np.uint8)
    b = moved[hi].astype(np.uint8)
    if not a.any() or not b.any():
        return out
    da = sitk.GetArrayFromImage(
        sitk.SignedMaurerDistanceMap(sitk.GetImageFromArray(a), insideIsPositive=True, useImageSpacing=False)
    )
    db = sitk.GetArrayFromImage(
        sitk.SignedMaurerDistanceMap(sitk.GetImageFromArray(b), insideIsPositive=True, useImageSpacing=False)
    )
    for n in range(lo + 1, hi):
        t = (n - lo) / (hi - lo)
        moved[n] = ((da * (1 - t) + db * t) >= 0).astype(np.uint8)
    return np.moveaxis(moved, 0, axis)


# ── 以影像為依據的兩個運算 ────────────────────────────────────────


def _require_image(ctx: OpContext) -> np.ndarray:
    img = ctx.image()
    if img is None:
        raise ValueError("這個運算需要該結構 FoR 的影像，但 session 裡沒有")
    return np.asarray(img)


def _apply_mode(current: np.ndarray, new: np.ndarray, mode: str) -> np.ndarray:
    if mode == "union":
        return ((current > 0) | (new > 0)).astype(np.uint8)
    if mode == "subtract":
        return ((current > 0) & ~(new > 0)).astype(np.uint8)
    if mode == "intersect":
        return ((current > 0) & (new > 0)).astype(np.uint8)
    return (new > 0).astype(np.uint8)


@register_op(
    "threshold",
    label="閾值分割",
    description="影像 HU 在區間內的體素進 mask；可限定在方框內；取代／聯集／相減／交集。",
    params_schema={
        "type": "object",
        "required": ["hu_range"],
        "properties": {
            "hu_range": {
                "type": "array",
                "items": {"type": "number"},
                "minItems": 2,
                "maxItems": 2,
                "default": [-200, 300],
                "title": "HU 區間",
                "x-ui-widget": "hu-range",
            },
            "bbox_ijk": {
                "type": "object",
                "title": "只在方框內（省略＝整個影像）",
                "properties": {
                    "offset": {"type": "array", "items": {"type": "integer"}, "minItems": 3, "maxItems": 3},
                    "size": {"type": "array", "items": {"type": "integer"}, "minItems": 3, "maxItems": 3},
                },
                "x-ui-widget": "bbox",
            },
            "mode": {
                "type": "string",
                "enum": ["replace", "union", "subtract", "intersect"],
                "default": "replace",
                "title": "套用方式",
                "x-ui-widget": "enum",
            },
        },
    },
)
def threshold(mask: np.ndarray, grid: Grid, params: dict[str, Any], ctx: OpContext) -> np.ndarray:
    img = _require_image(ctx)
    lo, hi = (float(v) for v in params["hu_range"])
    if hi < lo:
        lo, hi = hi, lo
    sel = (img >= lo) & (img <= hi)
    bbox = params.get("bbox_ijk")
    if bbox:
        o = [int(v) for v in bbox["offset"]]
        sz = [int(v) for v in bbox["size"]]
        box = np.zeros_like(sel)
        box[o[2] : o[2] + sz[2], o[1] : o[1] + sz[1], o[0] : o[0] + sz[0]] = True
        sel &= box
    return _apply_mode(mask, sel.astype(np.uint8), str(params.get("mode", "replace")))


@register_op(
    "region_grow",
    label="區域生長",
    description="從種子出發，把 HU 在區間內且相連的體素長成一個區域（ConnectedThreshold）。",
    params_schema={
        "type": "object",
        "required": ["seed_ijk", "hu_range"],
        "properties": {
            "seed_ijk": {
                "type": "array",
                "items": {"type": "integer"},
                "minItems": 3,
                "maxItems": 3,
                "title": "種子（ijk）",
                "x-ui-widget": "seed",
            },
            "hu_range": {
                "type": "array",
                "items": {"type": "number"},
                "minItems": 2,
                "maxItems": 2,
                "default": [-200, 300],
                "title": "HU 區間",
                "x-ui-widget": "hu-range",
            },
            "connectivity": {
                "type": "integer",
                "enum": [6, 26],
                "default": 26,
                "title": "鄰接",
                "x-ui-widget": "enum",
            },
            "per_slice": {
                "type": "boolean",
                "default": False,
                "title": "只在種子那一層（2D）",
                "x-ui-widget": "boolean",
            },
            "mode": {
                "type": "string",
                "enum": ["replace", "union", "subtract"],
                "default": "union",
                "title": "套用方式",
                "x-ui-widget": "enum",
            },
        },
    },
)
def region_grow(mask: np.ndarray, grid: Grid, params: dict[str, Any], ctx: OpContext) -> np.ndarray:
    img = _require_image(ctx)
    i, j, k = (int(v) for v in params["seed_ijk"])
    nk, nj, ni = img.shape
    if not (0 <= i < ni and 0 <= j < nj and 0 <= k < nk):
        raise ValueError(f"種子 {(i, j, k)} 在影像外（size {(ni, nj, nk)}）")
    lo, hi = (float(v) for v in params["hu_range"])
    if hi < lo:
        lo, hi = hi, lo
    if not (lo <= float(img[k, j, i]) <= hi):
        raise ValueError(f"種子體素的值 {float(img[k, j, i]):.0f} 不在區間 [{lo:.0f}, {hi:.0f}] 內")
    conn = int(params.get("connectivity", 26))
    if params.get("per_slice"):
        sl = sitk.GetImageFromArray(img[k].astype(np.float32))
        grown2d = sitk.ConnectedThreshold(sl, seedList=[(i, j)], lower=lo, upper=hi, connectivity=0 if conn == 6 else 1)
        grown = np.zeros_like(mask)
        grown[k] = sitk.GetArrayFromImage(grown2d).astype(np.uint8)
    else:
        vol = sitk.GetImageFromArray(img.astype(np.float32))
        vol.SetSpacing([float(v) for v in grid.spacing])
        out = sitk.ConnectedThreshold(vol, seedList=[(i, j, k)], lower=lo, upper=hi, connectivity=0 if conn == 6 else 1)
        grown = sitk.GetArrayFromImage(out).astype(np.uint8)
    return _apply_mode(mask, grown, str(params.get("mode", "union")))
