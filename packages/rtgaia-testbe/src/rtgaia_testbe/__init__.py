"""RT-Gaia 測試後端（拆層後：合成假體、chaos、`/api/v1/_test/*`、driver）。

產品邏輯在 `rtgaia-core`，SQL 與正式進入點在 `rtgaia-server`。

四個職責：

1. **解除前端阻塞** —— 實作完整的 API
2. **契約的參考實作** —— 不變式在 `rtgaia-geom` 有唯一一份可執行定義
3. **測試資料來源** —— 真實 DICOM ＋ **有已知答案的合成假體**
4. 🔴 **故障注入** —— 能夠故意違反契約，否則前端強制不變式的程式碼永遠是死碼
"""

from __future__ import annotations

__version__ = "0.1.0"

from .driver import Session  # noqa: E402  `from rtgaia_testbe import Session`

__all__ = ["Session", "__version__"]
