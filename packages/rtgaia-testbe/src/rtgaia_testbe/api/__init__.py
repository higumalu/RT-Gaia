"""`rtgaia_testbe.api`：`create_app` ＝ 正式後端 ＋ `/api/v1/_test/*`（見 `..app`）；測試端點本體在 `routes_test.py`。
產品的路由與 `AppState` 在 `rtgaia_core.api`。"""

from __future__ import annotations

from ..app import create_app

__all__ = ["create_app"]
