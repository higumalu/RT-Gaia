"""`audit_event` —— append-only 的操作紀錄。

誰（登入身分）、何時、做了什麼（method＋路徑樣板）、對哪個物件（路徑參數）、從哪個 client（`client_id`、remote_addr）、
結果（HTTP status）。內容層的「改成什麼」在版本鏈；這裡回答「誰做了什麼」。DB 層以 trigger 拒絕 UPDATE／DELETE。
"""

from __future__ import annotations

from datetime import UTC, datetime
from typing import Any

from rtgaia_core.audit_events import (
    new_event,  # noqa: F401  純函式在 core；這裡 re-export 給 `db.audit.new_event` 的呼叫端
)
from sqlalchemy import delete, func, select
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.ext.asyncio import AsyncEngine, async_sessionmaker

from .models import AuditEventRow, AuditOutboxRow

OUTBOX_MAX_ATTEMPTS = 10


class AuditStore:
    def __init__(self, engine: AsyncEngine) -> None:
        self.sessions = async_sessionmaker(engine, expire_on_commit=False)

    async def append(self, event: dict[str, Any]) -> None:
        async with self.sessions() as s:
            async with s.begin():
                s.add(AuditEventRow(**event))

    # ── outbox ────────────────────────────────────────────────
    async def enqueue(self, event: dict[str, Any], error: str) -> None:
        """`append` 失敗時落待送表（冪等：同一 event_id 只有一列）。這裡也失敗就讓呼叫端把請求變 503。"""
        async with self.sessions() as s:
            async with s.begin():
                stmt = pg_insert(AuditOutboxRow).values(
                    event_id=event["event_id"],
                    event=event,
                    created_at=datetime.now(UTC).isoformat(timespec="seconds"),
                    attempts=1,
                    last_error=error[:500],
                )
                await s.execute(stmt.on_conflict_do_nothing(index_elements=["event_id"]))

    async def flush(self, *, limit: int = 200) -> dict[str, int]:
        """把待送的補進 `audit_event`（每筆各自一個交易：一筆壞不擋其他）。回 `{sent, failed, gave_up}`。"""
        sent = failed = gave_up = 0
        columns = {c.name for c in AuditEventRow.__table__.columns}  # tail 上的旗標（persist_error／queued）不進主表
        async with self.sessions() as s:
            rows = (
                (await s.execute(select(AuditOutboxRow).order_by(AuditOutboxRow.created_at).limit(limit)))
                .scalars()
                .all()
            )
            pending = [(r.event_id, dict(r.event), int(r.attempts)) for r in rows]
        for event_id, event, attempts in pending:
            try:
                async with self.sessions() as s:
                    async with s.begin():
                        row_values = {k: v for k, v in event.items() if k in columns}
                        await s.execute(
                            pg_insert(AuditEventRow)
                            .values(**row_values)
                            .on_conflict_do_nothing(index_elements=["event_id"])
                        )
                        await s.execute(delete(AuditOutboxRow).where(AuditOutboxRow.event_id == event_id))
                sent += 1
            except Exception as exc:  # noqa: BLE001 - 記錄失敗原因，下一輪再試
                failed += 1
                try:
                    async with self.sessions() as s:
                        async with s.begin():
                            row = await s.get(AuditOutboxRow, event_id)
                            if row is not None:
                                row.attempts = attempts + 1
                                row.last_error = str(exc)[:500]
                                if row.attempts >= OUTBOX_MAX_ATTEMPTS:
                                    gave_up += 1  # 留在表裡給人看（不刪），但 lag 會一直顯示
                except Exception:  # noqa: BLE001
                    pass
        return {"sent": sent, "failed": failed, "gave_up": gave_up}

    async def lag(self) -> dict[str, Any]:
        """`/healthz` 與管理頁用：待送筆數、最舊一筆的年齡（秒）、放棄重送的筆數。"""
        async with self.sessions() as s:
            pending = int((await s.execute(select(func.count()).select_from(AuditOutboxRow))).scalar() or 0)
            oldest = (await s.execute(select(func.min(AuditOutboxRow.created_at)))).scalar()
            stuck = int(
                (
                    await s.execute(
                        select(func.count())
                        .select_from(AuditOutboxRow)
                        .where(AuditOutboxRow.attempts >= OUTBOX_MAX_ATTEMPTS)
                    )
                ).scalar()
                or 0
            )
        age = None
        if oldest:
            try:
                age = max(0.0, (datetime.now(UTC) - datetime.fromisoformat(str(oldest))).total_seconds())
            except ValueError:
                age = None
        return {"pending": pending, "oldest_age_s": age, "gave_up": stuck}

    async def list(
        self, *, case_id: str | None = None, user: str | None = None, limit: int = 100
    ) -> list[dict[str, Any]]:
        async with self.sessions() as s:
            q = select(AuditEventRow).order_by(AuditEventRow.at.desc()).limit(limit)
            if case_id:
                q = q.where(AuditEventRow.case_id == case_id)
            if user:
                q = q.where(AuditEventRow.user == user)
            return [_wire(r) for r in (await s.execute(q)).scalars().all()]


def _wire(r: AuditEventRow) -> dict[str, Any]:
    return {
        "event_id": r.event_id,
        "at": r.at,
        "user": r.user,
        "action": r.action,
        "status": r.status,
        "object_type": r.object_type,
        "object_id": r.object_id,
        "case_id": r.case_id,
        "client_id": r.client_id,
        "remote_addr": r.remote_addr,
        "detail": r.detail,
    }
