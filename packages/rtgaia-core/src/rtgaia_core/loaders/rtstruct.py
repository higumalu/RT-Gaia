"""RTSTRUCT 載入：輪廓（F3）→ labelmap（F1）。

已定案：**輪廓一律以 mask（labelmap）在前後端之間傳遞，不傳多邊形。**
因此載入真實 RTSTRUCT 時必須在後端就轉成 mask —— 這是匯出方向的反向操作
（匯出是 labelmap → 在取像平面重抽輪廓）。

## 三件真實資料才會遇到的事

1. **一個 slice 上可能有多條輪廓。** 可能是多連通分量（左右肺），也可能是洞
   （環狀結構）。RTSTRUCT **不標示哪一條是洞**，慣例是巢狀者為洞。
   實務上最穩的做法是 **XOR**：巢狀輪廓自然互相挖空，並列輪廓自然聯集。

2. **輪廓的 z 不會恰好落在體素中心。** 取最近的 slice，但**必須檢查偏差**——
   偏差超過半個 slice 厚度就代表這個 RTSTRUCT 不屬於這組影像（常見於
   「拿了另一次取像的結構集」），此時要明確報錯而不是默默貼到最近的一層。

3. **`ContourGeometricType` 不只有 `CLOSED_PLANAR`。** `POINT` 用於標記點、
   `OPEN_PLANAR` 用於開放曲線。硬當多邊形光柵化會產生垃圾，因此分開處理。
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Any

import numpy as np
import pydicom
from rtgaia_geom.errors import require
from rtgaia_geom.grid import Grid, Int3

# 輪廓的 z 與最近 slice 的容差，以 slice 厚度的比例表示。
#
# 0.5 = 半個 slice。超過就代表輪廓落在兩層之間，通常意味著這份 RTSTRUCT
# 不是針對這組影像畫的。
SLICE_TOLERANCE_RATIO = 0.5

MIN_POLYGON_POINTS = 3


@dataclass
class LoadedStructure:
    """從 RTSTRUCT 讀出、已裁切到 bbox 的一個結構。"""

    structure_id: str
    name: str
    color_rgb: tuple[int, int, int]
    roi_number: int
    interpreted_type: str | None
    offset_ijk: Int3
    size_ijk: Int3
    block: np.ndarray
    """`(k, j, i)` uint8。"""
    contour_count: int
    slice_count: int
    geometric_types: tuple[str, ...]
    skipped_contours: int = 0
    """落在網格外或退化而未光柵化的輪廓數。**不得靜默丟棄。**"""
    empty: bool = False
    """2026-09-18：RTSTRUCT 裡有這個 ROI 但沒有任何輪廓（例：AI 找不到的器官以 allow_empty 匯出）。
    保留為空結構讓使用者看得到「這個 ROI 存在但是空的」，而不是匯入時默默少一個。"""

    @property
    def voxel_count(self) -> int:
        return int(np.count_nonzero(self.block))

    def volume_cc(self, grid: Grid) -> float:
        return self.voxel_count * grid.voxel_volume_mm3 / 1000.0


def find_rtstruct(directory: str | Path) -> Path | None:
    """在目錄或其相鄰目錄裡找 RTSTRUCT。

    臨床匯出的常見版型是 `case/CT/*.dcm` ＋ `case/RTSTRUCT/*.dcm`，因此往上一層
    也要找 —— 只看傳進來的那個目錄會找不到。
    """
    path = Path(directory)
    candidates = [path, *path.parent.iterdir()] if path.parent.exists() else [path]
    for candidate in candidates:
        # RTSTRUCT 也可能直接是相鄰的**檔案**（`case/CT/` ＋ `case/rs.dcm`），
        # 先前只看目錄，這種版型會找不到。
        files = [candidate] if candidate.is_file() else sorted(candidate.glob("*.dcm")) if candidate.is_dir() else []
        for dcm in files:
            try:
                ds = pydicom.dcmread(dcm, stop_before_pixels=True, specific_tags=["Modality"])
            except Exception:  # noqa: BLE001 - 不是 DICOM 就跳過
                continue
            if str(getattr(ds, "Modality", "")) == "RTSTRUCT":
                return dcm
    return None


def fill_polygon(xs: np.ndarray, ys: np.ndarray, shape: tuple[int, int]) -> np.ndarray:
    """多邊形 → `(rows, cols)` 的 bool 平面，**even-odd 掃描線**，向量化。

    慣例：像素 `(j, i)` 的中心在連續索引座標的整數點上；中心落在多邊形內即為
    內部（邊界上的點依半開區間規則只算一側，因此相鄰共邊的兩個輪廓不會重疊
    也不會漏一列）。

    取代 `skimage.draw.polygon`：真實病例 3350 條輪廓要 10.9 s，這裡 <0.5 s，
    而且不再需要為了一個函式拉整個 scikit-image。
    """
    nj, ni = shape
    out = np.zeros((nj, ni), dtype=bool)
    if len(xs) < 3:
        return out
    x0, y0 = np.asarray(xs, dtype=np.float64), np.asarray(ys, dtype=np.float64)
    x1, y1 = np.roll(x0, -1), np.roll(y0, -1)
    j_lo = max(int(np.ceil(y0.min())), 0)
    j_hi = min(int(np.floor(y0.max())), nj - 1)
    if j_hi < j_lo:
        return out
    yc = np.arange(j_lo, j_hi + 1, dtype=np.float64)[:, None]  # (M, 1)
    # 半開規則：邊在 y 方向跨過掃描線才算交點（水平邊自然排除）
    crosses = (y0[None, :] <= yc) != (y1[None, :] <= yc)  # (M, N)
    with np.errstate(divide="ignore", invalid="ignore"):
        x_at = x0[None, :] + (yc - y0[None, :]) * (x1 - x0)[None, :] / (y1 - y0)[None, :]
    x_at = np.where(crosses, x_at, np.inf)
    x_at.sort(axis=1)
    n_cross = crosses.sum(axis=1)
    max_pairs = int(n_cross.max()) // 2 if len(n_cross) else 0
    if max_pairs == 0:
        return out
    starts = x_at[:, 0 : 2 * max_pairs : 2]
    ends = x_at[:, 1 : 2 * max_pairs : 2]
    valid = np.isfinite(starts) & np.isfinite(ends)
    starts = np.where(valid, starts, 0.0)
    ends = np.where(valid, ends, -1.0)
    # 中心 i 在 (xa, xb] 內 → i 從 floor(xa)+1 到 floor(xb)
    i_from = np.floor(starts).astype(np.int64) + 1
    i_to = np.floor(ends).astype(np.int64)  # inclusive
    i_from = np.clip(i_from, 0, ni)
    i_to = np.clip(i_to, -1, ni - 1)
    valid &= i_to >= i_from
    rows = np.broadcast_to(np.arange(j_lo, j_hi + 1)[:, None], starts.shape)[valid]
    diff = np.zeros((nj, ni + 1), dtype=np.int32)
    np.add.at(diff, (rows, i_from[valid]), 1)
    np.add.at(diff, (rows, i_to[valid] + 1), -1)
    out[:] = np.cumsum(diff, axis=1)[:, :ni] > 0
    return out


def _contour_points(contour: Any) -> np.ndarray:
    """`ContourData` → `(N, 3)` float64。

    直接解析原始 bytes：pydicom 對每個 DS 值做驗證，1.9M 個值要 4 s；
    `np.array(raw.split(b"\\"))` 是 C 速度。找不到原始元素時退回 pydicom 的值。
    """
    raw = contour.get_item(0x30060050) if hasattr(contour, "get_item") else None
    value = getattr(raw, "value", None)
    if isinstance(value, bytes):
        text = value.strip().rstrip(b"\x00")
        if not text:
            return np.zeros((0, 3), dtype=np.float64)
        return np.array(text.split(b"\\"), dtype=np.float64).reshape(-1, 3)
    return np.asarray(contour.ContourData, dtype=np.float64).reshape(-1, 3)


def _safe_id(name: str, used: set[str], prefix: str = "") -> str:
    """ROI 名稱 → 可放進 URL 的 structure_id。

    真實 ROI 名稱有空白、`+`、`/`、中文。**不能直接當 path 參數**。
    `prefix` 讓多套 RTSTRUCT 的同名 ROI（每套都有 BODY）在同一個 session 裡不撞。
    """
    base = "".join(ch if (ch.isalnum() or ch in "-_") else "_" for ch in name).strip("_")
    base = prefix + (base or "roi")
    candidate = base
    n = 1
    while candidate in used:
        n += 1
        candidate = f"{base}_{n}"
    used.add(candidate)
    return candidate


def read_rtstruct(
    rtstruct_path: str | Path,
    grid: Grid,
    *,
    only: set[str] | None = None,
    strict_frame_of_reference: bool = True,
    id_prefix: str = "",
    used_ids: set[str] | None = None,
) -> list[LoadedStructure]:
    """把 RTSTRUCT 的每個 ROI 光柵化成 mask。

    `only` 給定時只載入那些 ROI 名稱（86 個結構全載很慢，除錯時常只要幾個）。
    `id_prefix`／`used_ids`：多套 RTSTRUCT 進同一個 session 時讓 structure_id 唯一。
    """
    ds = pydicom.dcmread(str(rtstruct_path))
    rois = list(getattr(ds, "StructureSetROISequence", []))
    contours_by_roi = {int(c.ReferencedROINumber): c for c in getattr(ds, "ROIContourSequence", [])}
    types_by_roi = {
        int(o.ReferencedROINumber): str(getattr(o, "RTROIInterpretedType", "") or "")
        for o in getattr(ds, "RTROIObservationsSequence", [])
    }

    if strict_frame_of_reference:
        declared = {str(getattr(roi, "ReferencedFrameOfReferenceUID", "")) for roi in rois} - {""}
        require(
            not declared or grid.frame_of_reference_uid in declared,
            "RS1",
            "RTSTRUCT 的 Frame of Reference 與影像不符 —— 這份結構集不是針對這組影像畫的",
            rtstruct=sorted(declared),
            image=grid.frame_of_reference_uid,
        )

    nk, nj, ni = int(grid.size[2]), int(grid.size[1]), int(grid.size[0])
    slice_tolerance = SLICE_TOLERANCE_RATIO
    used_ids = set() if used_ids is None else used_ids
    out: list[LoadedStructure] = []

    for roi in rois:
        name = str(roi.ROIName)
        if only is not None and name not in only:
            continue
        roi_number = int(roi.ROINumber)
        contour_seq = getattr(contours_by_roi.get(roi_number), "ContourSequence", [])
        structure_id = _safe_id(name, used_ids, id_prefix)
        color = getattr(contours_by_roi.get(roi_number), "ROIDisplayColor", [255, 255, 0])

        # 只配置**觸及的切片**：64 個 ROI × 512²×192 的密集體積要 54 s，
        # 逐切片則 <2 s；bbox 最後再從觸及的切片算。
        planes: dict[int, np.ndarray] = {}
        geometric_types: set[str] = set()
        rasterized = 0
        skipped = 0

        for contour in contour_seq:
            geometric_type = str(getattr(contour, "ContourGeometricType", "CLOSED_PLANAR"))
            geometric_types.add(geometric_type)
            data = _contour_points(contour)
            if geometric_type == "POINT" or len(data) < MIN_POLYGON_POINTS:
                # 標記點與退化輪廓不光柵化成面（會產生零面積 ROI）
                skipped += 1
                continue

            ijk = grid.world_to_index(data)
            k_float = ijk[:, 2]
            k = int(np.rint(np.median(k_float)))
            drift = float(np.max(np.abs(k_float - k)))
            require(
                drift <= slice_tolerance,
                "RS2",
                "輪廓的 z 偏離最近的 slice 超過半層 —— 不得默默貼到最近的一層",
                roi=name,
                drift_slices=round(drift, 4),
                nearest_slice=k,
            )
            if k < 0 or k >= nk:
                # 🔴 不靜默丟棄：計數並回報。全部落在範圍外通常代表幾何算錯了
                # （這正是 SimpleITK 序列推論那個 bug 的症狀，見 loaders/dicom.py）。
                skipped += 1
                continue

            filled = fill_polygon(ijk[:, 0], ijk[:, 1], (nj, ni))
            if not filled.any():
                skipped += 1
                continue
            # 🔴 XOR：巢狀輪廓自然成為洞，並列輪廓自然聯集。
            # 用 `|=` 的話環狀結構（例如帶管腔的器官）會被填實。
            plane = planes.get(k)
            if plane is None:
                planes[k] = filled
            else:
                plane ^= filled
            rasterized += 1

        touched_slices = {k for k, plane in planes.items() if plane.any()}
        if not touched_slices:
            if contour_seq:
                continue  # 有輪廓但全落在網格外／退化：仍視為載入失敗（skipped_contours 會說）
            out.append(
                LoadedStructure(
                    structure_id=structure_id,
                    name=name,
                    color_rgb=(int(color[0]), int(color[1]), int(color[2])),
                    roi_number=roi_number,
                    interpreted_type=types_by_roi.get(roi_number) or None,
                    offset_ijk=(0, 0, 0),
                    size_ijk=(1, 1, 1),
                    block=np.zeros((1, 1, 1), dtype=np.uint8),
                    contour_count=0,
                    slice_count=0,
                    geometric_types=(),
                    empty=True,
                )
            )
            continue
        offset, size, block = _crop_planes(planes, touched_slices)
        out.append(
            LoadedStructure(
                structure_id=structure_id,
                name=name,
                color_rgb=(int(color[0]), int(color[1]), int(color[2])),
                roi_number=roi_number,
                interpreted_type=types_by_roi.get(roi_number) or None,
                offset_ijk=offset,
                size_ijk=size,
                block=np.ascontiguousarray(block, dtype=np.uint8),
                contour_count=rasterized,
                slice_count=len(touched_slices),
                geometric_types=tuple(sorted(geometric_types)),
                skipped_contours=skipped,
            )
        )
    return out


def _crop_planes(planes: dict[int, np.ndarray], touched: set[int]) -> tuple[Int3, Int3, np.ndarray]:
    """由「觸及的切片」直接算 bbox 並組出 `(k, j, i)` 區塊 —— 不經過整個密集體積。

    與 `crop_to_bbox` 的結果**逐位元相同**（測試鎖住），只是不配置 nk×nj×ni。
    """
    ks = sorted(touched)
    k0, k1 = ks[0], ks[-1]
    any_j = np.zeros(planes[ks[0]].shape[0], dtype=bool)
    any_i = np.zeros(planes[ks[0]].shape[1], dtype=bool)
    for k in ks:
        any_j |= planes[k].any(axis=1)
        any_i |= planes[k].any(axis=0)
    js = np.flatnonzero(any_j)
    is_ = np.flatnonzero(any_i)
    j0, j1 = int(js[0]), int(js[-1])
    i0, i1 = int(is_[0]), int(is_[-1])
    block = np.zeros((k1 - k0 + 1, j1 - j0 + 1, i1 - i0 + 1), dtype=np.uint8)
    for k in ks:
        block[k - k0] = planes[k][j0 : j1 + 1, i0 : i1 + 1]
    offset: Int3 = (i0, j0, k0)
    size: Int3 = (i1 - i0 + 1, j1 - j0 + 1, k1 - k0 + 1)
    return offset, size, np.ascontiguousarray(block)


def summarize(structures: list[LoadedStructure], grid: Grid) -> list[dict[str, Any]]:
    """給 `_test/state` 與除錯用的摘要。"""
    return [
        {
            "structure_id": s.structure_id,
            "name": s.name,
            "roi_number": s.roi_number,
            "interpreted_type": s.interpreted_type,
            "volume_cc": round(s.volume_cc(grid), 3),
            "slice_count": s.slice_count,
            "contour_count": s.contour_count,
            "geometric_types": list(s.geometric_types),
            "skipped_contours": s.skipped_contours,
            "bbox_size_ijk": list(s.size_ijk),
        }
        for s in structures
    ]
