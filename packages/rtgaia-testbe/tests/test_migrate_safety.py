"""🔴 2026-09-30 事故的回歸測試：測試夾具的 `downgrade_base(測試庫)` 在設了 `RTGAIA_DB_URL`（開發庫）的 shell 裡跑，
Alembic env.py 讓環境變數蓋過明確給的 URL → 開發庫整個被清空。

1. 明確給的 URL 優先於 `RTGAIA_DB_URL`（環境變數指向連不上的庫，升級照樣在測試庫成功）
2. `downgrade_base` 拒絕名稱不含 `test` 的庫（連線之前就拒絕）
"""

from __future__ import annotations

import os

import pytest
from rtgaia_server.db.migrate import RefusedDestructiveDowngrade, downgrade_base, upgrade_to_head

DB_URL = os.environ.get("RTGAIA_TEST_DB_URL", "")
UNREACHABLE = "postgresql+asyncpg://nobody:nothing@127.0.0.1:1/rtgaia"


def test_downgrade_refuses_non_test_database() -> None:
    with pytest.raises(RefusedDestructiveDowngrade, match="rtgaia"):
        downgrade_base(UNREACHABLE)  # 名稱是 rtgaia（開發庫）→ 連線之前就拒絕
    with pytest.raises(RefusedDestructiveDowngrade):
        downgrade_base("postgresql+asyncpg://u:p@127.0.0.1:1/production")


@pytest.mark.db
def test_explicit_url_wins_over_environment(monkeypatch: pytest.MonkeyPatch) -> None:
    if not DB_URL:
        pytest.skip("RTGAIA_TEST_DB_URL 未設")
    # 環境變數指向連不上的「開發庫」：以前 env.py 會拿它來連（這裡會連線失敗；事故當時則是真的清掉開發庫）
    monkeypatch.setenv("RTGAIA_DB_URL", UNREACHABLE)
    downgrade_base(DB_URL)
    upgrade_to_head(DB_URL)
