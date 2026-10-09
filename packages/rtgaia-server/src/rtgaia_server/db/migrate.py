"""Alembic 升級。

`upgrade_to_head(url)` 是同步函式、內部由 Alembic 的 async env 用 `asyncio.run()` 跑，因此**不能**在已有
event loop 的執行緒呼叫 —— app 啟動時用 `asyncio.to_thread(upgrade_to_head, url)`。
"""

from __future__ import annotations

from pathlib import Path

from alembic import command
from alembic.config import Config

MIGRATIONS_DIR = Path(__file__).resolve().parents[3] / "migrations"
"""`packages/rtgaia-server/migrations/`（與 `alembic.ini` 同層）。"""


def alembic_config(url: str) -> Config:
    cfg = Config(str(MIGRATIONS_DIR.parent / "alembic.ini"))
    cfg.set_main_option("script_location", str(MIGRATIONS_DIR))
    cfg.set_main_option("sqlalchemy.url", url)
    # env.py：程式明確給的 URL 優先於 `RTGAIA_DB_URL` 環境變數（2026-09-30 事故）
    cfg.attributes["rtgaia_explicit_url"] = True
    return cfg


def upgrade_to_head(url: str) -> None:
    command.upgrade(alembic_config(url), "head")


class RefusedDestructiveDowngrade(RuntimeError):
    """拒絕把非測試庫降到 base（會刪掉所有資料表）。"""


def downgrade_base(url: str, *, allow_non_test: bool = False) -> None:
    """降到 base ＝ **刪掉全部資料表**。只給測試用：資料庫名稱要含 `test`，否則拒絕。

    🔴 2026-09-30 事故：測試夾具在設了 `RTGAIA_DB_URL` 的 shell 裡跑，env.py 讓環境變數蓋過這裡給的測試庫 URL，
    開發庫整個被清空（帳號、病例、結構版本、稽核、目錄）。env.py 已改成明確 URL 優先；這裡再加一道：
    名稱不含 `test` 的庫一律拒絕，除非呼叫端明講 `allow_non_test=True`。
    """
    from sqlalchemy.engine import make_url

    name = make_url(url).database or ""
    if "test" not in name.lower() and not allow_non_test:
        raise RefusedDestructiveDowngrade(
            f"拒絕把資料庫「{name}」降到 base（會刪掉所有資料表）：只允許名稱含 test 的測試庫"
        )
    command.downgrade(alembic_config(url), "base")
