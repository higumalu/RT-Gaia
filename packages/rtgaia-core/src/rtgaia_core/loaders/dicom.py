"""真實 DICOM 載入器。

> **真實 DICOM 用來抓意外**：真實資料的 direction、非等距切片、缺欄位、
> 重複 SOP UID 都會出現，而合成假體永遠乾淨。

⚠️ **真實案例一律先去識別化**才放進 fixtures，即使是內部機器。
本模組不做去識別化，也不檢查——它只負責讀取，責任在放檔案的人。

## 🔴 幾何一律自己從 DICOM 標頭算，不用 SimpleITK 的序列推論

架構上的順序是「**pydicom 幾何驗證** → SimpleITK 讀取」，這個順序不是
裝飾。實測（Philips CT，89 張，切片以 **z 遞減**順序儲存）：

| | z 範圍 |
|---|---|
| DICOM 實際 | −285 … +155（89 × 5 mm ✓） |
| `sitk.ImageSeriesReader` 推出來的 | origin −285、slice 方向 −1 → 涵蓋 −285 … **−725** |

兩者互相矛盾。症狀**不是報錯**，而是 RTSTRUCT 的輪廓算出的 k 全部落在範圍外，
於是每個 ROI 都塌成一層、多數變成空的 —— 「看起來像結構畫錯了」。

因此本模組自己做：
1. 由 `ImageOrientationPatient` 取列／欄方向，法線 = 列 × 欄
2. 依 `ImagePositionPatient` 在法線上的投影**排序**
3. origin = 排序後第一張的位置；`spacing_z` = 相鄰間距的中位數
4. **驗證間距均勻**（非等距切片必須報錯，不得默默取中位數）
5. 依排序後的順序讀像素，套 `RescaleSlope` / `RescaleIntercept`

SimpleITK 仍然是幾何核心（B-spline 重切、形態學），**只是不用它的序列
幾何推論**。
"""

from __future__ import annotations

from collections import Counter, defaultdict
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import numpy as np
import pydicom
from rtgaia_geom.errors import require
from rtgaia_geom.grid import Grid

from ..dataset import Dataset
from ..library.scan import InstanceHeader, scan_tree
from ..pixel_codecs import can_decode, undecodable_reason

# 切片間距的均勻性容差（mm）。
#
# 真實 CT 的 `ImagePositionPatient` 是十進位字串，間距 5 mm 的資料上相鄰差值的
# 抖動典型在 1e-4 以下。0.01 mm 足夠寬鬆，又能抓到「中間漏了一張」（差值會是
# 兩倍間距）與「兩個序列混在一起」。
SLICE_SPACING_TOL_MM = 0.01

# 超過 0.01 mm、但不到間距的這個比例 → 照常載入（以等距網格擺放）並警告。
# 真實資料：GE Discovery STE 的多床位 PET 每 36 張一個床位交界，間距 3.25／3.35 mm（其他 3.27 mm），
# 累積位置誤差 0.04 mm，遠小於 PET 的 4–5 mm 像素。漏一張（偏差 ＝ 一個間距）、兩個序列混在一起仍然擋。
SLICE_SPACING_REL_TOL = 0.05

# `ImageOrientationPatient` 的正交性容差。
IOP_ORTHOGONAL_TOL = 1e-4

# 序列內各片的 IOP／PixelSpacing 視為相同的容差。GE 每張只寫 6 位有效數字，
# 同一個方向在最後一位有捨入差異（差 ≤ 1e-7）—— 以前四捨五入到小數 8 位後要求完全相等，被當成非平行切片（DL6）。
IOP_SAME_TOL = 1e-4
PIXEL_SPACING_SAME_TOL_MM = 1e-4


@dataclass
class SeriesFile:
    path: Path
    sop_instance_uid: str
    position: np.ndarray
    projection: float
    frame_number: int | None = None
    """Enhanced 多幀的第幾幀（1 起算）；一般切片 None。"""
    rescale: tuple[float, float] | None = None
    """這一幀的 (slope, intercept)（Enhanced 的在 Functional Group 裡，頂層沒有）。"""


@dataclass(frozen=True)
class SeriesGeometry:
    """一個影像序列的幾何 ＋ 已排序的檔案清單。像素**還沒讀**（惰性）。"""

    grid: Grid
    files: tuple[SeriesFile, ...]
    meta: dict[str, str]
    default_window: tuple[float, float]
    warnings: tuple[str, ...] = ()
    """照常載入但要讓使用者知道的事（例：間距在相對容許值內的不等距）。"""
    value_scale: float = 1.0
    """套完 Rescale 之後再乘的比例（PET SUV：Bq/ml × SUV 係數 × 100 → 存 SUV×100）。"""


def _as_float_list(value: Any) -> list[float]:
    if value is None:
        return []
    if isinstance(value, (bytes, str)):
        return [float(value)]
    try:
        return [float(v) for v in value]
    except TypeError:
        return [float(value)]


def _scan_headers(directory: Path) -> dict[str, list[InstanceHeader]]:
    """讀目錄下所有**影像** DICOM 的標頭，依 SeriesInstanceUID 分組。

    RTSTRUCT／RTDOSE／RTPLAN／REG **不是**影像序列，這裡一律排除 —— 否則單一檔案
    的 RTDOSE 會被當成「一張切片的 CT」候選。
    """
    by_series: dict[str, list[InstanceHeader]] = defaultdict(list)
    for h in scan_tree(directory):
        if h.is_image:
            by_series[h.series_instance_uid].append(h)
    return by_series


def _same_vector(
    values: list[list[float]], tol: float, code: str, message: str, length: int, length_message: str
) -> list[float]:
    """序列內每片都要一樣的向量（IOP、PixelSpacing）：跟第一片差 ≤ `tol` 就算一樣，回第一片的值。"""
    ref = [float(v) for v in values[0]]
    require(len(ref) == length, code, length_message, value=ref)
    worst = 0.0
    for v in values[1:]:
        require(len(v) == length, code, message, count=len({tuple(x) for x in values}))
        worst = max(worst, max(abs(float(a) - b) for a, b in zip(v, ref, strict=True)))
    require(worst <= tol, code, message, worst_difference=worst, count=len({tuple(x) for x in values}))
    return ref


def check_spacing(projections: list[float]) -> tuple[float, str | None]:
    """排好序的切片位置（沿法線）→ (間距, 警告)；不夠均勻就 DL11／DL12。

    間距取中位數。每一個間距跟中位數的差、以及每一片跟等距網格的位置差（累積誤差）都要 ≤
    `max(SLICE_SPACING_TOL_MM, SLICE_SPACING_REL_TOL × 間距)`；超過 `SLICE_SPACING_TOL_MM` 的回警告。
    """
    p = np.asarray(projections, dtype=np.float64)
    diffs = np.diff(p)
    spacing = float(np.median(diffs))
    require(spacing > 0, "DL11", "切片間距必須為正", spacing_z=spacing)
    worst = float(np.max(np.abs(diffs - spacing)))
    drift = float(np.max(np.abs(p - (p[0] + spacing * np.arange(len(p))))))
    tol = max(SLICE_SPACING_TOL_MM, SLICE_SPACING_REL_TOL * spacing)
    require(
        worst <= tol and drift <= tol,
        "DL12",
        "切片間距不均勻 —— 不是規則網格，不得默默取中位數（可能漏了切片，或兩個序列混在一起）",
        spacing_z=round(spacing, 6),
        worst_deviation_mm=round(worst, 6),
        position_drift_mm=round(drift, 6),
        tolerance_mm=round(tol, 6),
        slice_count=len(p),
    )
    if max(worst, drift) <= SLICE_SPACING_TOL_MM:
        return spacing, None
    return spacing, (
        f"切片間距不完全均勻（間距 {spacing:.3f} mm，最大偏差 {worst:.3f} mm、位置最多差 {drift:.3f} mm），"
        "在容許值內，以等距網格載入"
    )


def series_geometry(headers: list[InstanceHeader]) -> SeriesGeometry:
    """由一個序列的標頭算出 `Grid`（見模組開頭的五個步驟），並驗證 DL4–DL12。"""
    require(bool(headers), "DL2", "序列沒有任何切片")
    chosen_uid = headers[0].series_instance_uid
    first = headers[0]

    # ── 全序列必須一致的欄位 ────────────────────────────────────────────────
    for field, code in (("rows", "DL4"), ("columns", "DL4"), ("frame_of_reference_uid", "DL5")):
        values = {str(getattr(h, field)) for h in headers}
        require(len(values) == 1, code, f"序列內的 {field} 不一致 —— 這不是單一序列", values=sorted(values))

    iop = _same_vector(
        [h.image_orientation_patient for h in headers],
        IOP_SAME_TOL,
        "DL6",
        "序列內的 ImageOrientationPatient 不一致（非平行切片，不是規則網格）",
        6,
        "ImageOrientationPatient 必須有 6 個值",
    )
    pixel_spacing = _same_vector(
        [h.pixel_spacing for h in headers],
        PIXEL_SPACING_SAME_TOL_MM,
        "DL7",
        "序列內的 PixelSpacing 不一致",
        2,
        "PixelSpacing 必須有 2 個值",
    )

    # ── 方向：法線 = 列 × 欄 ───────────────────────────────────────────────
    row_dir = np.asarray(iop[0:3], dtype=np.float64)
    col_dir = np.asarray(iop[3:6], dtype=np.float64)
    require(
        abs(float(np.dot(row_dir, col_dir))) <= IOP_ORTHOGONAL_TOL,
        "DL8",
        "ImageOrientationPatient 的兩個方向不正交",
        dot=float(np.dot(row_dir, col_dir)),
    )
    row_dir /= np.linalg.norm(row_dir)
    col_dir /= np.linalg.norm(col_dir)
    normal = np.cross(row_dir, col_dir)

    # ── 依法線投影排序 ────────────────────────────────────────────────────
    require(
        all(len(h.image_position_patient) == 3 for h in headers),
        "DL9",
        "有切片缺少 ImagePositionPatient —— 沒有位置就無法進入空間",
    )
    files = [
        SeriesFile(
            path=Path(h.path),
            sop_instance_uid=h.sop_instance_uid,
            position=np.asarray(h.image_position_patient, dtype=np.float64),
            projection=float(np.dot(np.asarray(h.image_position_patient), normal)),
            frame_number=h.frame_number,
            rescale=(
                (float(h.rescale_slope or 1.0), float(h.rescale_intercept or 0.0))
                if h.frame_number is not None
                else None
            ),
        )
        for h in headers
    ]
    files.sort(key=lambda f: f.projection)

    duplicates = [uid for uid, n in Counter(f.sop_instance_uid for f in files).items() if n > 1]
    require(not duplicates, "DL10", "序列內有重複的 SOPInstanceUID", duplicates=duplicates[:5])

    # ── 間距：必須均勻 ────────────────────────────────────────────────────
    warnings: list[str] = []
    if len(files) > 1:
        spacing_z, warning = check_spacing([f.projection for f in files])
        if warning:
            warnings.append(warning)
    else:
        spacing_z = first.slice_thickness or 1.0

    # ── 組出 Grid ─────────────────────────────────────────────────────────
    origin = files[0].position
    # direction 為 row-major，**第 c 欄是第 c 個索引軸的方向**
    direction = np.column_stack([row_dir, col_dir, normal]).flatten()
    frame_of_reference_uid = first.frame_of_reference_uid
    if not frame_of_reference_uid:
        # 🔴 沒有 FoR 就無法進入空間（P1）。合成一個並明確標示，
        # 而不是靜默用序列 UID 假冒——後者會讓兩個不同取像看起來同一個空間。
        frame_of_reference_uid = f"{chosen_uid}.SYNTHETIC_FOR"

    grid = Grid(
        size=(int(first.columns or 0), int(first.rows or 0), len(files)),
        spacing=(float(pixel_spacing[1]), float(pixel_spacing[0]), spacing_z),
        origin=(float(origin[0]), float(origin[1]), float(origin[2])),
        direction=tuple(float(v) for v in direction),  # type: ignore[arg-type]
        frame_of_reference_uid=frame_of_reference_uid,
    )
    window = next(
        ((h.window_center, h.window_width) for h in headers if h.window_center is not None and h.window_width),
        (40.0, 400.0),
    )
    meta = {
        "series_instance_uid": chosen_uid,
        "study_instance_uid": first.study_instance_uid,
        "modality": first.modality or "CT",
        "slice_count": str(len(files)),
        "synthetic_frame_of_reference": str(not first.frame_of_reference_uid),
        "geometry_source": "pydicom-headers",
        "handedness": str(grid.handedness),
        # 給 UI 的序列描述
        "patient_id": first.patient_id,
        "series_date": first.series_date,
        "series_time": first.series_time,
        "series_description": first.series_description,
        "study_date": first.study_date,
        "study_description": first.study_description,
        "manufacturer": first.manufacturer,
        "manufacturer_model_name": first.manufacturer_model_name,
    }
    return SeriesGeometry(
        grid=grid,
        files=tuple(files),
        meta=meta,  # type: ignore[arg-type]
        default_window=(float(window[0]), float(window[1])),
        warnings=tuple(warnings),
    )


_INT16_MIN, _INT16_MAX = -32768.0, 32767.0


def _read_slice(entry: SeriesFile, checked: set[Path]) -> np.ndarray:
    """一片（或 Enhanced 的一幀）套完 Rescale 的值（float32）。"""
    if entry.frame_number is not None:
        # Enhanced 多幀 —— 只解這一幀（pydicom 3 的 index），Rescale 用 Functional Group 的
        from pydicom.pixels import pixel_array

        if entry.path not in checked:
            meta = pydicom.dcmread(entry.path, stop_before_pixels=True)
            ts = str(getattr(meta.file_meta, "TransferSyntaxUID", "") or "")
            if not can_decode(ts):
                raise ValueError(undecodable_reason(ts))
            checked.add(entry.path)
        slope, intercept = entry.rescale or (1.0, 0.0)
        frame = pixel_array(str(entry.path), index=entry.frame_number - 1)
        return frame.astype(np.float32) * slope + intercept
    ds = pydicom.dcmread(entry.path)
    slope = (_as_float_list(ds.get("RescaleSlope")) or [1.0])[0]
    intercept = (_as_float_list(ds.get("RescaleIntercept")) or [0.0])[0]
    ts = str(getattr(ds.file_meta, "TransferSyntaxUID", "") or "")
    if not can_decode(ts):
        # 解不了就說是哪一種壓縮、為什麼（以前是 pydicom 的一長串 plugin 錯誤）
        raise ValueError(undecodable_reason(ts))
    return ds.pixel_array.astype(np.float32) * slope + intercept


def read_pixels(geometry: SeriesGeometry) -> np.ndarray:
    """依排序後的順序讀像素，套 `RescaleSlope` / `RescaleIntercept`，`(k, j, i)` int16。

    超出 int16 的值**飽和**在 ±32767（以前直接 astype 會繞回負數 —— PET 的 Bq/ml 熱點很容易超過 32767）。
    `geometry.value_scale` ≠ 1 → 先乘再取整（PET 存 SUV×100）。
    """
    grid = geometry.grid
    volume = np.empty((grid.size[2], grid.size[1], grid.size[0]), dtype=np.int16)
    checked: set[Path] = set()
    for k, entry in enumerate(geometry.files):
        values = _read_slice(entry, checked)
        if geometry.value_scale != 1.0:
            values = values * np.float32(geometry.value_scale)
        volume[k] = np.clip(np.rint(values), _INT16_MIN, _INT16_MAX).astype(np.int16)
    return volume


# 沒有 Window 標籤的非 CT 影像（PET 的 Bq/ml、部分 MR）以前一律用 CT 的 40／400 —— PET 整片白。
# 改成取樣幾片，用第 99.5 百分位當上界（下界 0）。CT 沒有標籤時 40／400 仍然合理（HU 是絕對的）。
WINDOW_SAMPLE_SLICES = 9


def with_estimated_window(geometry: SeriesGeometry, headers: list[InstanceHeader]) -> SeriesGeometry:
    """非 CT、而且整個序列都沒有 Window Center／Width → 從幾片像素估預設窗位；其他原樣。"""
    modality = str(geometry.meta.get("modality") or "")
    if modality == "CT" or any(h.window_center is not None and h.window_width for h in headers):
        return geometry
    files = geometry.files
    picks = sorted({int(round(x)) for x in np.linspace(0, len(files) - 1, min(len(files), WINDOW_SAMPLE_SLICES))})
    checked: set[Path] = set()
    try:
        values = np.concatenate([_read_slice(files[i], checked).ravel() for i in picks])
    except Exception:  # noqa: BLE001 - 估不出來就維持原本的預設；真正讀不到會在載入像素時報
        return geometry
    values = values[np.isfinite(values)]
    if values.size == 0:
        return geometry
    lo = float(min(0.0, np.percentile(values, 0.5)))
    hi = float(min(np.percentile(values, 99.5), _INT16_MAX))
    if hi <= lo:
        return geometry
    from dataclasses import replace

    return replace(geometry, default_window=((hi + lo) / 2.0, hi - lo))


def read_series(
    directory: str | Path, *, series_instance_uid: str | None = None
) -> tuple[np.ndarray, Grid, dict[str, str]]:
    """讀一個 DICOM 序列目錄，回傳 `(volume(k,j,i) int16, Grid, meta)`。

    幾何完全由標頭算出並驗證（見模組開頭）。多個序列共存時取張數最多的那個，
    或以 `series_instance_uid` 指定。**急切讀像素**；要惰性請用 `series_geometry`
    ＋ `read_pixels`（`loaders/case.py` 走那條）。
    """
    path = Path(directory)
    require(path.is_dir(), "DL1", "不是一個目錄", directory=str(path))
    by_series = _scan_headers(path)
    require(bool(by_series), "DL2", "目錄下沒有可讀的影像 DICOM", directory=str(path))

    if series_instance_uid is not None:
        require(
            series_instance_uid in by_series,
            "DL3",
            "指定的 SeriesInstanceUID 不在這個目錄裡",
            available=sorted(by_series),
        )
        chosen_uid = series_instance_uid
    else:
        chosen_uid = max(by_series, key=lambda uid: len(by_series[uid]))

    geometry = series_geometry(by_series[chosen_uid])
    meta = {**geometry.meta, "series_in_directory": str(len(by_series))}
    return read_pixels(geometry), geometry.grid, meta


def default_window(directory: str | Path) -> tuple[float, float]:
    """由 DICOM 的 `WindowCenter` / `WindowWidth` 取預設視窗。"""
    path = Path(directory)
    for candidate in sorted(path.rglob("*")):
        if not candidate.is_file():
            continue
        try:
            ds = pydicom.dcmread(candidate, stop_before_pixels=True, specific_tags=["WindowCenter", "WindowWidth"])
        except Exception:  # noqa: BLE001
            continue
        centers = _as_float_list(ds.get("WindowCenter"))
        widths = _as_float_list(ds.get("WindowWidth"))
        if centers and widths:
            return (centers[0], widths[0])
    return (40.0, 400.0)


def load_dicom_dataset(
    directory: str | Path,
    *,
    load_structures: bool = True,
    only_structures: set[str] | None = None,
) -> Dataset:
    """把一個目錄裡的**全部** DICOM 物件包成一個多序列 `Dataset`。

    以前它只吃「一個影像序列 ＋ 相鄰的 RTSTRUCT」；現在走
    `loaders/case.py`：目錄下的每個影像序列、RTSTRUCT、RTDOSE、REG 都會進來，
    RTSTRUCT 光柵化在**自己 FoR 的**影像網格上，REG 變成 `FrameGroup` 的變換。
    舊的 `case/CT/ ＋ case/RTSTRUCT/` 版型仍然支援（見 `case.select_all`）。

    **沒有解析的 `expected.json`**：真實資料沒有已知答案，這正是為何合成假體
    不能被它取代。
    """
    from ..library.index import LibraryIndex
    from .case import build_case_dataset, select_all

    index = LibraryIndex.scan(directory)
    selection = select_all(index, include_structures=load_structures, sibling_rtstruct_of=Path(directory))
    return build_case_dataset(index, selection, only_structures=only_structures)
