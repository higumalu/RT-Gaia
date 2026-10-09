"""`rtgaia-core`：RT-Gaia 的產品邏輯 —— 領域模型（`state`、`dataset`）、載入器、目錄、
演算法（ops／rtstruct／dvh／mesh／reslice／render3d）、API 路由與 `create_app(adapters=…)`、plugin 宿主、DIMSE。

**不含**：任何 SQL（`rtgaia-server`）、合成假體產生器與 `/api/v1/_test/*`（`rtgaia-testbe`）。
"""

from __future__ import annotations

__version__ = "0.1.0"
