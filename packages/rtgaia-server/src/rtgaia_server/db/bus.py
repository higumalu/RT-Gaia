"""Postgres NOTIFY／outbox 匯流排（從 `rtgaia_core.bus` 搬來的 SQL 實作）。

`EventBus` Protocol 與 `LocalBus` 留在 core。"""

from __future__ import annotations

import asyncio
import logging
import time
import uuid
from datetime import UTC, datetime
from typing import Any

from rtgaia_core.bus import CHANNEL, OUTBOX_KEEP_SECONDS, Deliver, encode_size  # noqa: F401

log = logging.getLogger(__name__)

LISTEN_PING_SECONDS = 15.0
"""LISTEN 連線這麼久沒收到東西就 ping 一次：半開的 TCP（對方消失、沒送 FIN）不會觸發 termination。"""


class PgBus:
    """發布：outbox 列 ＋ NOTIFY。訂閱（`start()`）：LISTEN 連線 ＋ 讀列 ＋ deliver。

    worker 行程只發布不訂閱（`deliver=None`）。"""

    def __init__(self, engine: Any, dsn: str, deliver: Deliver | None) -> None:
        from sqlalchemy.ext.asyncio import async_sessionmaker

        self.sessions = async_sessionmaker(engine, expire_on_commit=False)
        self.dsn = dsn
        self.deliver = deliver
        self._task: asyncio.Task[None] | None = None
        self._conn: Any = None
        self.received = 0
        self.reconnects = 0
        self.listening = False
        """LISTEN 連線現在是不是活的（`/readyz` 看 `status()`）。"""
        self._down_since: float | None = None
        self.last_error: str | None = None
        self._last_seen_id = 0
        self._baseline_taken = False
        """第一次連上時記下 outbox 的位置（不重播歷史）；之後每次重連都從那裡補。"""
        self.origin = uuid.uuid4().hex[:12]
        """這個行程的身分：自己發的列從 LISTEN 收到時**跳過**
        （本地已在 publish() 同步送過 —— 不會送兩次，同行程的送達也因此是同步、可測的）。"""

    async def publish(self, target: str, message_type: str, payload: dict[str, Any]) -> None:
        from sqlalchemy import text

        from .models import PushOutboxRow

        # 本地連線先送（同步、可測）；其他行程靠 NOTIFY。
        # 本地送失敗：照樣寫 outbox（別的行程的連線還收得到），最後**把例外丟回去** —— 以前在這裡吞掉，
        # API 回 200、畫面卻沒更新，跟沒有 DB 的 LocalBus（直接丟出）行為不一致。
        failure: Exception | None = None
        if self.deliver is not None:
            try:
                await self.deliver(target, message_type, dict(payload))
            except Exception as exc:  # noqa: BLE001
                log.exception("Local push failed: %s → %s", message_type, target)
                failure = exc
        async with self.sessions() as s:
            async with s.begin():
                row = PushOutboxRow(
                    target=target,
                    message_type=message_type,
                    payload=payload,
                    origin=self.origin,
                    created_at=datetime.now(UTC).isoformat(timespec="seconds"),
                )
                s.add(row)
                await s.flush()
                await s.execute(text("SELECT pg_notify(:ch, :id)"), {"ch": CHANNEL, "id": str(row.id)})
                # 順手清舊的（每次一小段，不另開排程）
                cutoff = datetime.fromtimestamp(datetime.now(UTC).timestamp() - OUTBOX_KEEP_SECONDS, tz=UTC).isoformat(
                    timespec="seconds"
                )
                await s.execute(text("DELETE FROM push_outbox WHERE created_at < :cutoff"), {"cutoff": cutoff})
        if failure is not None:
            raise failure

    async def start(self) -> None:
        if self.deliver is None or self._task is not None:
            return
        self._down_since = time.time()
        self._task = asyncio.create_task(self._listen_forever())

    def status(self) -> dict[str, Any] | None:
        """訂閱的行程（API）才有：LISTEN 連線活著嗎、斷了多久、重連幾次。只發布的行程（worker）回 None。"""
        if self.deliver is None:
            return None
        down = 0.0 if self.listening or self._down_since is None else time.time() - self._down_since
        return {
            "listening": self.listening,
            "down_seconds": round(down, 1),
            "reconnects": self.reconnects,
            "last_error": self.last_error,
        }

    async def stop(self) -> None:
        if self._task is not None:
            self._task.cancel()
            try:
                await self._task
            except (asyncio.CancelledError, Exception):  # noqa: BLE001
                pass
            self._task = None
        if self._conn is not None:
            try:
                await self._conn.close()
            except Exception:  # noqa: BLE001
                pass
            self._conn = None

    async def _listen_forever(self) -> None:
        """LISTEN → 讀列 → deliver；連線斷了就退避重連，重連後補上斷線期間的列。

        🔴 以前只在 `queue.get()` 上等 —— Postgres 重啟關掉連線時沒有任何東西進佇列、
        也沒有例外，listener 就永遠卡在那裡：API 再也收不到 worker 的進度、完成、錯誤，`/readyz` 照樣 200。
        現在連線終止會放一個 None 進佇列，閒著的時候定期 ping。"""
        import asyncpg

        dsn = self.dsn.replace("postgresql+asyncpg://", "postgresql://")
        backoff = 0.5
        while True:
            queue: asyncio.Queue[str | None] = asyncio.Queue()
            try:
                self._conn = await asyncpg.connect(dsn)
                self._conn.add_termination_listener(lambda _conn, q=queue: q.put_nowait(None))
                await self._conn.add_listener(CHANNEL, lambda *args, q=queue: q.put_nowait(str(args[-1])))
                backoff = 0.5
                # 重連後把斷線期間漏掉的列補上（以最後看過的 id 為界）
                await self._catch_up()
                self.listening, self._down_since = True, None
                while True:
                    try:
                        outbox_id = await asyncio.wait_for(queue.get(), timeout=LISTEN_PING_SECONDS)
                    except TimeoutError:
                        await asyncio.wait_for(self._conn.fetchval("SELECT 1"), timeout=LISTEN_PING_SECONDS)
                        continue
                    if outbox_id is None:
                        raise ConnectionError("the LISTEN connection was closed")
                    await self._deliver_row(int(outbox_id))
            except asyncio.CancelledError:
                self.listening = False
                raise
            except Exception as exc:  # noqa: BLE001 - DB 斷了：退避重連
                if self.listening or self._down_since is None:
                    self._down_since = time.time()
                self.listening = False
                self.last_error = f"{type(exc).__name__}: {exc}".split("\n")[0]
                self.reconnects += 1
                log.warning("Event bus listener disconnected (%s); reconnecting in %.1f s", self.last_error, backoff)
                if self._conn is not None:
                    try:
                        await self._conn.close()
                    except Exception:  # noqa: BLE001
                        pass
                    self._conn = None
                await asyncio.sleep(backoff)
                backoff = min(backoff * 2, 10.0)

    async def _catch_up(self) -> None:
        from sqlalchemy import select

        from .models import PushOutboxRow

        async with self.sessions() as s:
            rows = (
                (
                    await s.execute(
                        select(PushOutboxRow).where(PushOutboxRow.id > self._last_seen_id).order_by(PushOutboxRow.id)
                    )
                )
                .scalars()
                .all()
            )
        if not self._baseline_taken:
            # 第一次啟動：不重播歷史，只記住位置。🔴 要用旗標，不能用「位置還是 0」判斷 —— outbox 空著時位置一直是 0，
            # 之後重連就又被當成第一次，斷線期間的列全部略過
            self._baseline_taken = True
            if rows:
                self._last_seen_id = rows[-1].id
            return
        for r in rows:
            await self._handle(r.id, r.target, r.message_type, r.payload, r.origin)

    async def _deliver_row(self, outbox_id: int) -> None:
        from .models import PushOutboxRow

        if outbox_id <= self._last_seen_id:
            return
        async with self.sessions() as s:
            r = await s.get(PushOutboxRow, outbox_id)
        if r is None:
            return
        await self._handle(r.id, r.target, r.message_type, r.payload, r.origin)

    async def _handle(
        self, outbox_id: int, target: str, message_type: str, payload: dict[str, Any], origin: str | None
    ) -> None:
        self._last_seen_id = max(self._last_seen_id, outbox_id)
        if origin == self.origin:
            return  # 自己發的：本地已在 publish() 同步送過
        self.received += 1
        if self.deliver is not None:
            try:
                await self.deliver(target, message_type, dict(payload))
            except Exception:  # noqa: BLE001 - 一則送不出去不能拖垮 listener
                log.exception("Push failed (from another process): %s → %s", message_type, target)
