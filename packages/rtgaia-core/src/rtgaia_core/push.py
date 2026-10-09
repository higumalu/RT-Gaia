"""Push 通道。

> **這不是測試專用機制。** 正式後端同樣需要它（背景推論完成後推送結構、
> 多人協作、長時間工作進度），因此協定現在就要照正式需求設計。

🔴 **推送只送 metadata 與小訊息；體素資料一律走 HTTP GET 取回。**
理由：可利用 HTTP 快取、可續傳、可平行下載，且 WS 訊息保持在幾 KB 以內。
`MAX_MESSAGE_BYTES` 把這條規則變成執行期斷言，不是註解。
"""

from __future__ import annotations

import asyncio
import json
import logging
from collections import deque
from dataclasses import dataclass, field
from typing import Any

from fastapi import WebSocket

log = logging.getLogger(__name__)

MAX_MESSAGE_BYTES = 256 * 1024
"""單一 WS 訊息的上限。

⚠️ **舊版寫 64 KB 並估「182 個結構約 40 KB」，那個估計是錯的。**
實測（真實案例，85 個 ROI）：每個結構條目含 provenance、bbox、hash 約 950 bytes，
85 個就 80 KB，182 個會到 170 KB —— 於是載入真實案例時 `scene.replace` 直接
撞穿上限。

修法有兩層，兩層都做了：
1. **`scene.replace` 不再帶結構清單**（結構清單本來就走 HTTP）。
   這讓推送大小與結構數脫鉤。
2. 上限訂在 256 KB —— 對 182 個圖層的 metadata 有餘裕，對體素仍然遠遠不夠
   （單一 512² uint8 切片就 262 KB）。**任何想從 WS 塞體素的改動仍會在這裡失敗。**
"""

SCENE_REFETCH = "refetch"
"""`scene.replace` 太大時改送的**小訊息**的旗標：`{sessionId, caseId, refetch: true, bytes, limit}`
→ 前端改走 `GET /sessions/{session_id}/scene`（HTTP 沒有這個上限）。

2026-10-06 CCTH-A06：攤開 62 幀的 `scene.replace` 385 KB 撞上限 → 以前是丟例外：
開發環境（PgBus）在 API 裡被吞掉 → 回 200、畫面不動；WS 連上時的那一則也是 → 連線一直斷、畫面整片黑。
場景是 metadata，大小隨圖層數成長（結構、攤開的幀），撞上限不是程式寫錯，不該讓畫面停住；
**其他訊息**撞上限仍然丟例外（那才是把不該推的東西塞進來）。"""

SERVER_MESSAGES = (
    "scene.replace",
    "layer.add",
    "layer.update",
    "layer.remove",
    "mask.updated",
    "camera.set",
    "job.progress",
    "error",
    # 目錄變了（匯入完成）—— 資料頁重抓；誰在看哪個病例
    "catalog.changed",
    "presence",
    # 結構集清單變了（建了工作集、改名、合併）—— 前端重抓 structure-sets 與結構清單
    "structure_sets.changed",
    "plugins.changed",  # plugin 登錄／版本／停用變了（* 廣播）
    "service.received",  # DICOM 節點回傳了 RT 物件
)


SEND_TIMEOUT_S = 10.0
"""一則訊息送一個連線最多等多久；超過 ＝ 這個接收端太慢 → 斷線
（前端重連、連上就拿完整場景）。"""
MAX_QUEUED_MESSAGES = 256
MAX_QUEUED_BYTES = 8 * 1024 * 1024
"""每個連線排隊中的訊息上限（則數、位元組）；超過一樣斷線 —— 記憶體有上限，不會因為一個慢的接收端一直長。"""
SLOW_PEER_CLOSE_CODE = 1013
"""WebSocket 1013 Try Again Later：伺服器端過載／這個連線跟不上。前端的 `PushChannel` 照常退避重連。"""


def coalesce_key(message_type: str, payload: dict[str, Any]) -> str | None:
    """還在排隊、還沒送出的同一類訊息可以只留最新的：`scene.replace` 是完整場景（新的完全取代舊的）、
    同一個工作的 `job.progress` 只要最新進度。其他訊息（layer.*、mask.updated…）每一則都要送，順序不變。"""
    if message_type == "scene.replace":
        return "scene"
    if message_type == "job.progress" and payload.get("jobId") is not None:
        return f"job:{payload['jobId']}"
    return None


@dataclass(eq=False)
class Connection:
    """一條 WS 連線。**每條連線自己一個佇列 ＋ 一個送出的 task**：送不出去的接收端只卡住自己，
    `PushHub.send` 只排隊、不等網路 —— 以前逐個 `await send_text`，一個慢的接收端會拖住其他人和發布推送的請求。"""

    websocket: WebSocket
    session_id: str
    hello: dict[str, Any] | None = None
    sent: int = 0
    pending: deque[tuple[str, str | None, str]] = field(default_factory=deque)
    """排隊中的 `(訊息種類, 合併 key, 編好的 JSON)`。"""
    pending_bytes: int = 0
    coalesced: int = 0
    closed: bool = False
    wake: asyncio.Event = field(default_factory=asyncio.Event)
    task: asyncio.Task[None] | None = None


@dataclass
class PushHub:
    """每個 session 一組連線。單一行程，不需要 pub/sub。"""

    connections: dict[str, list[Connection]] = field(default_factory=dict)
    history: list[dict[str, Any]] = field(default_factory=list)
    targets: list[dict[str, Any]] = field(default_factory=list)
    keep_history: int = 200
    chaos: Any = None
    """`ChaosConfig`（`AppState` 接上）：`push_limit` 把上限調小，驗前端走 HTTP 重抓場景的路。"""
    oversized: int = 0
    """改送「重抓」小訊息的次數（`_test/state` 與記錄看得到）。"""

    def limit(self) -> int:
        override = int(getattr(self.chaos, "push_limit_bytes", 0) or 0)
        return override if override > 0 else MAX_MESSAGE_BYTES

    evicted: int = 0
    """因為太慢（送出逾時、排隊超過上限）被斷線的連線數。"""
    send_timeout_s: float = SEND_TIMEOUT_S
    max_queued_messages: int = MAX_QUEUED_MESSAGES
    max_queued_bytes: int = MAX_QUEUED_BYTES

    async def connect(self, session_id: str, websocket: WebSocket) -> Connection:
        await websocket.accept()
        conn = Connection(websocket=websocket, session_id=session_id)
        self.connections.setdefault(session_id, []).append(conn)
        conn.task = asyncio.create_task(self._pump(conn))
        return conn

    def disconnect(self, conn: Connection) -> None:
        conn.closed = True
        peers = self.connections.get(conn.session_id, [])
        if conn in peers:
            peers.remove(conn)
        task = conn.task
        if task is not None and task is not asyncio.current_task() and not task.done():
            task.cancel()

    async def _pump(self, conn: Connection) -> None:
        """這條連線唯一的送出者：照排隊順序一則一則送；送不出去（逾時、連線斷了）→ 斷線。"""
        try:
            while not conn.closed:
                await conn.wake.wait()
                conn.wake.clear()
                while conn.pending and not conn.closed:
                    _kind, _key, encoded = conn.pending.popleft()
                    conn.pending_bytes -= len(encoded)
                    try:
                        await asyncio.wait_for(conn.websocket.send_text(encoded), timeout=self.send_timeout_s)
                    except TimeoutError:
                        self._evict(conn, f"送出逾時（{self.send_timeout_s:g} s）")
                        return
                    except Exception:  # noqa: BLE001 - 連線已斷，清掉即可
                        self.disconnect(conn)
                        return
                    conn.sent += 1
        except asyncio.CancelledError:
            pass

    def _evict(self, conn: Connection, reason: str) -> None:
        """太慢的接收端：斷線（1013）、丟掉它的佇列。前端重連後伺服器會先送完整場景，不會漏東西。"""
        log.warning("Push receiver too slow, disconnected: session %s (%s)", conn.session_id, reason)
        self.evicted += 1
        conn.pending.clear()
        conn.pending_bytes = 0
        self.disconnect(conn)

        async def close() -> None:
            try:
                await conn.websocket.close(code=SLOW_PEER_CLOSE_CODE)
            except Exception:  # noqa: BLE001 - 已經斷了
                pass

        asyncio.get_running_loop().create_task(close())

    def _enqueue(self, conn: Connection, message_type: str, key: str | None, encoded: str) -> bool:
        if conn.closed:
            return False
        if key is not None:
            kept = deque(x for x in conn.pending if not (x[0] == message_type and x[1] == key))
            dropped = len(conn.pending) - len(kept)
            if dropped:
                conn.coalesced += dropped
                conn.pending = kept
                conn.pending_bytes = sum(len(x[2]) for x in kept)
        conn.pending.append((message_type, key, encoded))
        conn.pending_bytes += len(encoded)
        if len(conn.pending) > self.max_queued_messages or conn.pending_bytes > self.max_queued_bytes:
            self._evict(conn, f"排隊 {len(conn.pending)} 則、{conn.pending_bytes} bytes")
            return False
        conn.wake.set()
        return True

    async def send_to(self, conn: Connection, message_type: str, payload: dict[str, Any]) -> bool:
        """只送這一條連線（hello 的回覆、看不懂的客戶端訊息）—— 一樣走這條連線的佇列，順序跟其他推送一致。"""
        if message_type not in SERVER_MESSAGES:
            raise ValueError(f"未定義的 Server→Client 訊息 {message_type!r}")
        encoded = json.dumps({"type": message_type, "payload": payload}, ensure_ascii=False)
        return self._enqueue(conn, message_type, coalesce_key(message_type, payload), encoded)

    def count(self, session_id: str) -> int:
        return len(self.connections.get(session_id, []))

    async def send(self, session_id: str, message_type: str, payload: dict[str, Any]) -> int:
        """推一則訊息給該 session 的所有連線（排進各自的佇列，不等網路），回傳排進幾條連線。"""
        if message_type not in SERVER_MESSAGES:
            raise ValueError(f"未定義的 Server→Client 訊息 {message_type!r}")
        message = {"type": message_type, "payload": payload}
        encoded = json.dumps(message, ensure_ascii=False)
        size = len(encoded.encode("utf-8"))
        limit = self.limit()
        if size > limit and message_type == "scene.replace":
            stub = {
                "sessionId": payload.get("sessionId", session_id),
                "caseId": payload.get("caseId"),
                SCENE_REFETCH: True,
                "bytes": size,
                "limit": limit,
            }
            log.warning(
                "scene.replace %s bytes > %s: sent a refetch notice instead (session %s)", size, limit, session_id
            )
            self.oversized += 1
            message = {"type": message_type, "payload": stub}
            encoded = json.dumps(message, ensure_ascii=False)
        elif size > limit:
            raise ValueError(
                f"WS 訊息 {message_type} 為 {size} bytes，超過 {limit}。推送只送 metadata；體素資料一律走 HTTP GET"
            )
        self.history.append(message)
        del self.history[: max(0, len(self.history) - self.keep_history)]
        # 另外記「送到哪個 session」——多使用者測試要斷言 A 的編輯推到了 B（history 本身形狀不變）
        self.targets.append({"sessionId": session_id, "type": message_type})
        del self.targets[: max(0, len(self.targets) - self.keep_history)]
        key = coalesce_key(message_type, message["payload"])
        delivered = 0
        for conn in list(self.connections.get(session_id, [])):
            if self._enqueue(conn, message_type, key, encoded):
                delivered += 1
        return delivered

    async def broadcast(self, message_type: str, payload: dict[str, Any]) -> int:
        total = 0
        for session_id in list(self.connections):
            total += await self.send(session_id, message_type, payload)
        return total

    async def job_progress(
        self, session_id: str, job_id: str, phases: list[tuple[str, int]], *, delay: float = 0.05
    ) -> None:
        """模擬長時間工作的進度（先做最小可用版本）。"""
        for phase, percent in phases:
            await self.send(session_id, "job.progress", {"jobId": job_id, "phase": phase, "percent": percent})
            await asyncio.sleep(delay)
