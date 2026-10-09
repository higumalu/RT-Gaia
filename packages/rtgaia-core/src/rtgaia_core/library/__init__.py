"""資料庫索引 —— 資料選取頁的後端。

* `scan.py`：DICOM 標頭掃描（索引與載入器共用）
* `index.py`：Patient › Study › Series 樹、參照關係、搜尋、快取
* `importer.py`：匯入管線 —— 暫存、驗證、去重（SOP UID ＋ sha256）、落地 blobs
* `catalog.py`：資料頁的四層目錄樹、反向參照、篩選命中、zip 串流
"""

from __future__ import annotations

from .catalog import Catalog, zip_stream
from .importer import ImportBatch, Importer
from .index import LibraryIndex, SeriesEntry
from .scan import IMAGE_MODALITIES, RT_MODALITIES, InstanceHeader, scan_tree

__all__ = [
    "Catalog",
    "IMAGE_MODALITIES",
    "ImportBatch",
    "Importer",
    "RT_MODALITIES",
    "InstanceHeader",
    "LibraryIndex",
    "SeriesEntry",
    "scan_tree",
    "zip_stream",
]
