"""Postgres job 佇列（從 `rtgaia_core.jobs` 搬來的 SQL 實作）。

`Job`、handlers、`MemoryJobQueue`、`worker_loop` 留在 core。"""

from __future__ import annotations

import time
import uuid
from collections.abc import Sequence
from typing import Any

from rtgaia_core import jobs as core_jobs
from rtgaia_core.jobs import (
    FIND_PAGE,
    MAX_ATTEMPTS,
    TERMINAL,
    Job,
    JobChanged,
    StaleAttempt,
    _now,
    lease_deadline,
    now_precise,
)


class DbJobQueue:
    """Postgres 佇列：`SELECT … FOR UPDATE SKIP LOCKED LIMIT 1` 領工作，多個 worker 不會領到同一筆。

    租約（`lease_until`）＋心跳＋`attempt_id`。回收只動租約真的過期的列，低頻、每批最多
    `RECLAIM_BATCH`、在 DB 端以條件式 UPDATE 完成（`FOR UPDATE SKIP LOCKED` 的子查詢）；`update` 只接受目前的 attempt。
    """

    def __init__(self, engine: Any) -> None:
        from sqlalchemy.ext.asyncio import async_sessionmaker

        self.sessions = async_sessionmaker(engine, expire_on_commit=False)
        self._last_reclaim = 0.0
        self.on_lease_failed: Any = None
        """租約過期、重試用完被判失敗的工作（推通知用；AppState 設）。"""

    async def enqueue(self, job: Job) -> Job:
        from .models import JobRow

        async with self.sessions() as s:
            async with s.begin():
                s.add(JobRow(**_to_row(job)))
        return job

    async def claim(self, worker_id: str) -> Job | None:
        from sqlalchemy import select

        from .models import JobRow

        if time.monotonic() - self._last_reclaim >= core_jobs.RECLAIM_EVERY_SECONDS:
            self._last_reclaim = time.monotonic()
            await self.reclaim_expired()
        async with self.sessions() as s:
            async with s.begin():
                row = (
                    await s.execute(
                        select(JobRow)
                        .where(JobRow.status == "queued")
                        .order_by(JobRow.requested_at)
                        .limit(1)
                        .with_for_update(skip_locked=True)
                    )
                ).scalar_one_or_none()
                if row is None:
                    return None
                row.status = "running"
                row.worker_id = worker_id
                row.started_at = _now()
                row.attempts = int(row.attempts or 0) + 1
                row.attempt_id = uuid.uuid4().hex[:16]
                row.lease_until = lease_deadline()
                row.version = int(row.version or 0) + 1
                return _from_row(row)

    async def reclaim_expired(self) -> int:
        """租約過期的 running → queued（還能試）或 failed。一批最多 `RECLAIM_BATCH`，被別人鎖住的列跳過。"""
        from sqlalchemy import case, select, update

        from .models import JobRow

        now = now_precise()
        async with self.sessions() as s:
            async with s.begin():
                expired = (
                    select(JobRow.job_id)
                    .where(JobRow.status == "running", JobRow.lease_until.is_not(None), JobRow.lease_until < now)
                    .order_by(JobRow.lease_until)
                    .limit(core_jobs.RECLAIM_BATCH)
                    .with_for_update(skip_locked=True)
                    .scalar_subquery()
                )
                retry = JobRow.attempts < MAX_ATTEMPTS
                result = await s.execute(
                    update(JobRow)
                    .where(JobRow.job_id.in_(expired))
                    .values(
                        status=case((retry, "queued"), else_="failed"),
                        phase=case((retry, JobRow.phase), else_="failed"),
                        error=case((retry, None), else_="worker 租約過期，已達重試上限"),
                        finished_at=case((retry, None), else_=_now()),
                        attempt_id=None,
                        lease_until=None,
                        version=JobRow.version + 1,
                    )
                    .returning(JobRow.job_id, JobRow.status)
                    .execution_options(synchronize_session=False)
                )
                rows = result.all()
            failed = [job_id for job_id, status in rows if status == "failed"]
            if failed and self.on_lease_failed is not None:
                got = (await s.execute(select(JobRow).where(JobRow.job_id.in_(failed)))).scalars().all()
                await self.on_lease_failed([_from_row(r) for r in got])
        return len(rows)

    async def heartbeat(self, job_id: str, attempt_id: str, lease_seconds: float | None = None) -> bool:
        from sqlalchemy import update

        from .models import JobRow

        async with self.sessions() as s:
            async with s.begin():
                got = await s.execute(
                    update(JobRow)
                    .where(
                        JobRow.job_id == job_id,
                        JobRow.attempt_id == attempt_id,
                        JobRow.status == "running",
                        JobRow.lease_until.is_not(None),
                    )
                    .values(lease_until=lease_deadline(lease_seconds))
                    .returning(JobRow.job_id)
                )
                return got.scalar_one_or_none() is not None

    async def update(self, job: Job, *, release_lease: bool = False) -> None:
        """寫回這一份。鎖住那一列再比對，跟回收／心跳不會交錯：

        * 列不存在 → KeyError（以前會新增 —— 子步驟因此變成一筆新的 queued 工作被再跑一次）；
        * 帶 `attempt_id` 的（worker 那一份）必須是目前的 attempt，否則 `StaleAttempt`；
        * 版本要跟讀出時一樣，否則 `JobChanged`（讀出後別人寫過 → 呼叫端重讀重套，`jobs.mutate_job`）；
        * 租約不從這一份寫回（領取與心跳管）：終態或 `release_lease`（派送給外部）清掉，其他時候維持原值。
        """
        from sqlalchemy import select

        from .models import JobRow

        async with self.sessions() as s:
            async with s.begin():
                row = (
                    await s.execute(select(JobRow).where(JobRow.job_id == job.job_id).with_for_update())
                ).scalar_one_or_none()
                if row is None:
                    raise KeyError(f"沒有 job {job.job_id}")
                if job.attempt_id is not None and row.attempt_id != job.attempt_id:
                    raise StaleAttempt(f"{job.job_id}：attempt {job.attempt_id} 已不是目前的（{row.attempt_id}）")
                if int(row.version or 0) != job.version:
                    raise JobChanged(f"{job.job_id}：讀出時是第 {job.version} 版，現在是第 {row.version} 版")
                for k, v in _to_row(job).items():
                    if k not in ("lease_until", "version"):
                        setattr(row, k, v)
                if release_lease or job.status in TERMINAL:
                    row.lease_until = None
                row.version = int(row.version or 0) + 1
                job.version, job.lease_until = row.version, row.lease_until

    async def get(self, job_id: str) -> Job | None:
        from .models import JobRow

        async with self.sessions() as s:
            row = await s.get(JobRow, job_id)
            return None if row is None else _from_row(row)

    async def list(self, case_id: str | None = None, *, limit: int = 50) -> list[Job]:
        from sqlalchemy import select

        from .models import JobRow

        async with self.sessions() as s:
            q = select(JobRow).order_by(JobRow.requested_at.desc()).limit(limit)
            if case_id:
                q = q.where(JobRow.case_id == case_id)
            return [_from_row(r) for r in (await s.execute(q)).scalars().all()]

    async def find(
        self,
        *,
        status: str | None = None,
        kinds: Sequence[str] = (),
        kind_prefixes: Sequence[str] = (),
        finished_after: str | None = None,
        after: tuple[str, str] | None = None,
        limit: int = FIND_PAGE,
    ) -> list[Job]:
        """DB 端篩選，**舊到新**、keyset 分頁 `after=(requested_at, job_id)`。"""
        from sqlalchemy import or_, select, tuple_

        from .models import JobRow

        q = select(JobRow)
        if status is not None:
            q = q.where(JobRow.status == status)
        kind_terms = [JobRow.kind.in_(list(kinds))] if kinds else []
        kind_terms += [JobRow.kind.startswith(p, autoescape=True) for p in kind_prefixes]
        if kind_terms:
            q = q.where(or_(*kind_terms))
        if finished_after is not None:
            q = q.where(JobRow.finished_at >= finished_after)
        if after is not None:
            q = q.where(tuple_(JobRow.requested_at, JobRow.job_id) > tuple_(*after))
        q = q.order_by(JobRow.requested_at, JobRow.job_id).limit(limit)
        async with self.sessions() as s:
            return [_from_row(r) for r in (await s.execute(q)).scalars().all()]


def _to_row(job: Job) -> dict[str, Any]:
    return {
        "job_id": job.job_id,
        "case_id": job.case_id,
        "kind": job.kind,
        "status": job.status,
        "phase": job.phase,
        "percent": job.percent,
        "request": job.request,
        "result": job.result,
        "result_blob_key": job.result_blob_key,
        "error": job.error,
        "requested_by": job.requested_by,
        "requested_at": job.requested_at,
        "started_at": job.started_at,
        "finished_at": job.finished_at,
        "worker_id": job.worker_id,
        "attempts": job.attempts,
        "lease_until": job.lease_until,
        "attempt_id": job.attempt_id,
        "version": job.version,
    }


def _from_row(r: Any) -> Job:
    return Job(
        job_id=r.job_id,
        case_id=r.case_id,
        kind=r.kind,
        request=dict(r.request or {}),
        requested_by=r.requested_by,
        requested_at=r.requested_at,
        status=r.status,
        phase=r.phase,
        percent=int(r.percent or 0),
        result=dict(r.result or {}),
        result_blob_key=r.result_blob_key,
        error=r.error,
        started_at=r.started_at,
        finished_at=r.finished_at,
        worker_id=r.worker_id,
        attempts=int(r.attempts or 0),
        lease_until=r.lease_until,
        attempt_id=r.attempt_id,
        version=int(r.version or 0),
    )
