"""合成假體：**產生器**在這裡；資料集的讀取／光柵化／快取是產品邏輯，在 `rtgaia_core.dataset_io`。

拆層之後，這個模組只剩 `build()`／`list_phantoms()`／`BUILDERS`／`expected_json`；
資料集存取（`volume`／`mask_block`／`cache_root`…）re-export 自 `rtgaia_core.dataset_io`，讓驗證腳本一個 import 就夠。
"""

from __future__ import annotations

from pathlib import Path

from rtgaia_core import dataset_io as _io
from rtgaia_core.dataset import Dataset, DatasetMarker, DatasetSeries, DatasetStructure
from rtgaia_core.dataset_io import (
    FOUR_D_FRAMES,
    cache_max_bytes,
    cache_root,
    evict_cache,
    mask_block,
    mask_payload,
    phase_amplitude,
    volume,
)

from .expected import expected_json
from .library import BUILDERS

__all__ = [
    "BUILDERS",
    "CACHE_DIR",
    "FOUR_D_FRAMES",
    "Dataset",
    "DatasetMarker",
    "DatasetSeries",
    "DatasetStructure",
    "build",
    "cache_max_bytes",
    "cache_root",
    "evict_cache",
    "expected_json",
    "list_phantoms",
    "mask_block",
    "mask_payload",
    "phase_amplitude",
    "volume",
]

# 合成假體的預算體素在套件內的 fixtures/cache：沒有 RTGAIA_DATA_DIR／RTGAIA_LIBRARY_ROOT 時退回這裡（舊行為）
CACHE_DIR = Path(__file__).resolve().parent.parent / "fixtures" / "cache"
_io.CACHE_DIR = CACHE_DIR

_phantoms: dict[str, Dataset] = {}


def list_phantoms() -> list[dict[str, object]]:
    return [
        {
            "phantom_id": pid,
            "description": build(pid).description,
            "series_count": len(build(pid).series),
            "structure_count": len(build(pid).structures),
            "verifies": list(build(pid).verifies),
        }
        for pid in BUILDERS
    ]


def build(dataset_id: str) -> Dataset:
    """取得假體定義（惰性、快取）。**不產生任何體素。**"""
    if dataset_id not in _phantoms:
        if dataset_id not in BUILDERS:
            raise KeyError(f"未知的假體 {dataset_id!r}。可用：{', '.join(BUILDERS)}")
        _phantoms[dataset_id] = BUILDERS[dataset_id]()  # type: ignore[operator]
    return _phantoms[dataset_id]
