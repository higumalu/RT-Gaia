"""目錄的持久層。

* `models.py`：SQLAlchemy 2.0 表 —— patient／study／series／instance／series_ref
* `store.py`：`CatalogStore` —— 以 `InstanceHeader` 為真相寫入與讀出；派生表（series／series_ref…）由
  `LibraryIndex` 重算後整批換掉
* `migrate.py`：Alembic 升級（`packages/rtgaia-server/migrations/`）

設計決定：**Postgres 是目錄的持久真相，
查詢仍在 Python 的 `LibraryIndex`／`Catalog` 上跑**（記憶體視圖從 DB 載入）。多行程一致性靠
NOTIFY；SQL 查詢留到資料量需要時 —— 派生表的欄位已為此準備好。
"""

from __future__ import annotations

from .migrate import upgrade_to_head
from .store import CatalogStore

__all__ = ["CatalogStore", "upgrade_to_head"]

# 註：`migrations/` 現在在 packages/rtgaia-server/
