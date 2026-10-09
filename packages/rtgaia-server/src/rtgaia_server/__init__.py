"""`rtgaia-server`：正式後端的組裝 —— SQL adapters（`db/`、Alembic migrations）、`create_app()`、
`rtgaia-server`／`rtgaia-worker`／`rtgaia-scp` 三個行程進入點。
產品邏輯在 `rtgaia-core`；合成假體與測試端點在 `rtgaia-testbe`。"""

from __future__ import annotations

__version__ = "0.1.0"
