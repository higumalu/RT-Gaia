"""資料集（`Dataset`）的體素／mask 存取與快取（從 `rtgaia_testbe.phantoms` 搬來的產品邏輯）。

* `volume()`：序列體素（磁碟 `.npy` 快取、mmap 讀回、LRU 逐出）
* `mask_block()`／`mask_payload()`：結構在其 FoR 取像網格上的 mask（DICOM 來的用 `preloaded`；合成的用 `shape` 光柵化）
* `cache_root()`：快取根目錄（`RTGAIA_DATA_DIR/cache` → `RTGAIA_LIBRARY_ROOT/.cache` → `CACHE_DIR`）

合成假體的**產生器**（builders、影像合成、預期答案）留在 `rtgaia_testbe.phantoms`；這裡只有讀取與光柵化。
"""

from __future__ import annotations

import os
import uuid
from pathlib import Path

import numpy as np
from rtgaia_geom import MaskGrid, MaskPayload, Provenance
from rtgaia_geom.grid import Grid, Int3

from .dataset import Dataset, DatasetSeries, DatasetStructure
from .shapes import Sphere, rasterize

__all__ = [
    "CACHE_DIR",
    "FOUR_D_FRAMES",
    "cache_root",
    "cache_max_bytes",
    "evict_cache",
    "mask_block",
    "mask_payload",
    "phase_amplitude",
    "volume",
]

FOUR_D_FRAMES = 10
"""帶時間軸的資料集預設相位數（合成 4D-CT 假體與 `per_frame_shift_mm` 的相位位移共用）。"""

BREATHING_HYSTERESIS = 0.15


def phase_amplitude(frame_index: int, frame_count: int) -> float:
    """相位 → 位移比例。`frame_index=0` 恆為 0，且 N 個相位彼此互異。"""
    theta = 2.0 * np.pi * frame_index / max(1, frame_count)
    return float((1.0 - np.cos(theta)) / 2.0 + BREATHING_HYSTERESIS * np.sin(theta))


CACHE_DIR = Path(os.environ.get("RTGAIA_PHANTOM_CACHE", Path.home() / ".cache" / "rtgaia"))
"""最後退路（沒有 `RTGAIA_DATA_DIR`／`RTGAIA_LIBRARY_ROOT`）。**不可**指到套件目錄：部署時 site-packages 是唯讀的。
`rtgaia_testbe.phantoms` import 時把它改指到 testbe 套件內的 `fixtures/cache`（合成假體的預算體素）。"""

DEFAULT_CACHE_MAX_BYTES = 20 * 1024**3
"""體素快取的大小上限（`RTGAIA_CACHE_MAX_GB`，預設 20 GB）；超過就從最久沒用的 `.npy` 開始刪。"""


def cache_root() -> Path:
    """體素／索引快取的根目錄。優先序：

    1. `RTGAIA_DATA_DIR/cache`
    2. `RTGAIA_LIBRARY_ROOT/.cache`（隱藏目錄，索引掃描會跳過）
    3. 舊的 `CACHE_DIR`（套件目錄內；只剩純假體、沒有資料庫的情況）

    每次呼叫都讀環境變數：測試與 CLI 在 import 之後才設定它。刪掉整個目錄不會壞任何東西，只是下次載入變慢。
    """
    data_dir = os.environ.get("RTGAIA_DATA_DIR", "").strip()
    if data_dir:
        return Path(data_dir).expanduser() / "cache"
    library_root = os.environ.get("RTGAIA_LIBRARY_ROOT", "").strip()
    if library_root:
        return Path(library_root).expanduser() / ".cache"
    return CACHE_DIR


def cache_max_bytes() -> int:
    raw = os.environ.get("RTGAIA_CACHE_MAX_GB", "").strip()
    try:
        return int(float(raw) * 1024**3) if raw else DEFAULT_CACHE_MAX_BYTES
    except ValueError:
        return DEFAULT_CACHE_MAX_BYTES


def evict_cache(root: Path | None = None, *, max_bytes: int | None = None, keep: Path | None = None) -> list[Path]:
    """LRU：`.npy` 總量超過上限就從**最久沒被讀**（atime，退回 mtime）的開始刪，直到低於上限。回傳刪掉的檔。

    `keep` 是剛寫好的那一份，永不刪。Linux 上刪掉正被 mmap 的檔是安全的（inode 留到解除映射）。
    """
    root = cache_root() if root is None else root
    limit = cache_max_bytes() if max_bytes is None else max_bytes
    files: list[tuple[float, int, Path]] = []
    total = 0
    for p in root.rglob("*.npy"):
        if p.name.startswith("."):
            continue
        try:
            st = p.stat()
        except OSError:
            continue
        total += st.st_size
        files.append((max(st.st_atime, 0.0) or st.st_mtime, st.st_size, p))
    removed: list[Path] = []
    if total <= limit:
        return removed
    for _, size, p in sorted(files):
        if keep is not None and p.resolve() == keep.resolve():
            continue
        try:
            p.unlink()
        except OSError:
            continue
        removed.append(p)
        total -= size
        if total <= limit:
            break
    return removed


def volume(dataset: Dataset, series: DatasetSeries, frame_index: int = 0) -> np.ndarray:
    """序列的體素，`(k, j, i)`，dtype 依 `series.dtype`（影像 int16、劑量 float32）。

    經磁碟快取，`huge` 用 mmap 讀回。
    """
    if isinstance((series.params or {}).get("derived"), dict):
        # 劑量運算的暫存結果本來就在記憶體裡、session 關掉就丟 —— 不寫磁碟快取（寫了也只會留下孤兒檔）
        return np.asarray(series.image(series.grid, frame_index))
    # 像素的存法不同（PET 存 SUV×100）→ 快取檔名不同，換算前留下的 Bq/ml 快取不會被當成 SUV 讀回
    encoding = (series.params or {}).get("voxel_encoding")
    suffix = f"_{_safe(str(encoding))}" if encoding else ""
    path = cache_root() / "volumes" / dataset.dataset_id / f"{_safe(series.series_id)}_f{frame_index}{suffix}.npy"
    if path.exists():
        return np.load(path, mmap_mode="r")
    path.parent.mkdir(parents=True, exist_ok=True)
    data = series.image(series.grid, frame_index)
    # np.save 會自動補上 .npy，因此暫存檔名本身就要以 .npy 結尾。
    # 🔴 暫存檔名每次唯一：同一個序列第一次被兩個請求同時讀（lod 0 ＋ 3D）時，共用一個暫存檔名會讓後到的
    # `replace` 找不到檔（先到的已經改名）→ 500（驗證劑量運算時踩到）
    tmp = path.with_name(f".{path.stem}.{uuid.uuid4().hex[:8]}.partial.npy")
    np.save(tmp, data)
    try:
        tmp.replace(path)
    except FileNotFoundError:
        if not path.exists():
            raise
    # 寫完就檢查上限（剛寫的這份不刪）
    evict_cache(keep=path)
    return np.load(path, mmap_mode="r")


def _shifted(structure: DatasetStructure, frame_index: int | None) -> object:
    """帶時間軸的結構：依相位平移形狀（呼吸位移的最小模型）。"""
    if structure.temporal_group_id is None or frame_index is None:
        return structure.shape
    if all(v == 0.0 for v in structure.per_frame_shift_mm):
        return structure.shape
    amp = phase_amplitude(frame_index, FOUR_D_FRAMES)
    shift = np.asarray(structure.per_frame_shift_mm, dtype=np.float64) * amp
    shape = structure.shape
    if isinstance(shape, Sphere):
        return Sphere(
            center=tuple(float(v) for v in np.asarray(shape.center) + shift),  # type: ignore[arg-type]
            radius_mm=shape.radius_mm,
        )
    raise NotImplementedError(f"帶相位位移的形狀型別尚未支援: {type(shape)!r}")


def mask_block(
    dataset: Dataset,
    structure: DatasetStructure,
    *,
    frame_index: int | None = None,
) -> tuple[Int3, Int3, np.ndarray] | None:
    """結構在其 FoR 的取像網格上的 mask，**已裁切到 bbox**。"""
    if structure.preloaded is not None:
        # 真實 RTSTRUCT：體素在載入時就光柵化好了，沒有解析形狀可重算
        return structure.preloaded
    if structure.shape is None:
        return None
    grid = _grid_of(dataset, structure.frame_of_reference_uid)
    return rasterize(_shifted(structure, frame_index), grid)  # type: ignore[arg-type]


def mask_payload(
    dataset: Dataset,
    structure: DatasetStructure,
    *,
    mask_grid: MaskGrid,
    frame_index: int | None = None,
    module_version: str,
) -> MaskPayload | None:
    from rtgaia_geom.hashing import payload_content_hash

    block = mask_block(dataset, structure, frame_index=frame_index)
    if block is None:
        return None
    offset, size, data = block
    raw = np.ascontiguousarray(data, dtype=np.uint8).tobytes()
    return MaskPayload(
        structure_id=structure.structure_id,
        mask_grid_id=mask_grid.mask_grid_id,
        frame_of_reference_uid=structure.frame_of_reference_uid,
        offset_ijk=offset,
        size_ijk=size,
        data=raw,
        content_hash=payload_content_hash(offset_ijk=offset, size_ijk=size, data=raw, prefix="mh_"),
        # 結構自己宣告來源；真實 RTSTRUCT 是 "import"
        provenance=Provenance(source=structure.provenance_source, module_version=module_version),
        temporal_group_id=structure.temporal_group_id,
        frame_index=frame_index if structure.temporal_group_id else None,
    )


def _grid_of(dataset: Dataset, frame_of_reference_uid: str) -> Grid:
    """結構所在的網格 ＝ 該 FoR 的**影像**序列的取像網格（不是劑量網格）。"""
    return dataset.image_series_for(frame_of_reference_uid).grid


def _safe(uid: str) -> str:
    return uid.replace(".", "_")[-48:]
