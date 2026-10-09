"""事件匯流排。

`PushHub` 只認**這個行程**的 WS 連線。多行程（API ＋ 獨立 worker、之後多個 API）時，worker 算完的
`job.progress`、匯入完成的 `catalog.changed` 要送到別的行程的 WS 連線 —— 走 Postgres：

    publish(target, type, payload)
      → INSERT push_outbox（payload 放表裡：NOTIFY 的 payload 上限 8000 bytes，scene.replace 會超過）
      → NOTIFY rtgaia_events, '<outbox id>'
    每個 API 行程一條 LISTEN 連線 → 讀那一列 → 交給本地 PushHub（或本地處理，如 catalog.changed 讓索引失效）

* `LocalBus`：沒有 DB（或單行程）時直接 `hub.send`。
* `PgBus`：發布者只需要 DB；訂閱者（API）另開一條 asyncpg 連線 LISTEN。**發布者自己也是從 LISTEN 收到才送本地連線**，
  所以同一則不會送兩次。LISTEN 斷線會重連，重連後補推 `scene.replace`（前端本來就會重新同步）。
* target：`session_id`；`"*"` ＝ 廣播給所有連線；`"case:<id>"` 由訂閱端展開成該病例的 session（每個行程自己展）。
"""

from __future__ import annotations

import json
from collections.abc import Awaitable, Callable
from typing import Any, Protocol

CHANNEL = "rtgaia_events"
OUTBOX_KEEP_SECONDS = 3600

Deliver = Callable[[str, str, dict[str, Any]], Awaitable[int]]
"""(target, type, payload) → 送達數；由 AppState 提供（展開 case:/*、交給 PushHub、處理 catalog.changed）。"""


class EventBus(Protocol):
    async def publish(self, target: str, message_type: str, payload: dict[str, Any]) -> None: ...
    async def start(self) -> None: ...
    async def stop(self) -> None: ...


class LocalBus:
    def __init__(self, deliver: Deliver) -> None:
        self.deliver = deliver

    async def publish(self, target: str, message_type: str, payload: dict[str, Any]) -> None:
        await self.deliver(target, message_type, payload)

    async def start(self) -> None:
        return None

    async def stop(self) -> None:
        return None


def encode_size(payload: dict[str, Any]) -> int:
    return len(json.dumps(payload, ensure_ascii=False).encode("utf-8"))
