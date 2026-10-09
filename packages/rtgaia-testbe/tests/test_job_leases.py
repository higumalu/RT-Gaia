"""工作租約、心跳、attempt。Memory 與 Postgres 兩種佇列跑同一組情境（租約縮到 0.3 秒）。

以前 `claim()` 把「started_at 超過 30 分鐘」的 running 一律重排 —— 活著的長工作（plugin 推論、DEFERRED 等回呼）
會被再派一次；`update()` 也不看是誰寫的，舊 worker 可以蓋掉新一輪的結果。

1. 持續心跳的長工作（遠長於租約）在兩個 worker 下只執行一次
2. worker 死掉（心跳停）→ 租約到期後才被另一個 worker 接手（attempts ＝ 2）
3. 舊 attempt 的結果寫不回去（`StaleAttempt`），新 attempt 可以
4. 派送給外部的 DEFERRED 工作沒有租約，過了好幾個租約長度也不會被回收
"""

from __future__ import annotations

import asyncio
import os
from collections.abc import Awaitable, Callable
from typing import Any

import pytest
from rtgaia_core import jobs
from rtgaia_core.jobs import DEFERRED, MemoryJobQueue, StaleAttempt, new_job, worker_loop

DB_URL = os.environ.get("RTGAIA_TEST_DB_URL", "")
LEASE = 0.3


class _App:
    def __init__(self, queue: Any) -> None:
        self.queue = queue
        self.worker_health: dict[str, Any] = {}

    async def job_queue_async(self) -> Any:
        return self.queue

    async def job_queue_async_update(self, job: Any) -> None:
        await self.queue.update(job)

    async def mutate_job(self, job_id: str, change: Any, *, release_lease: bool = False) -> Any:
        return await jobs.mutate_job(self.queue, job_id, change, release_lease=release_lease)

    async def notify_case(self, case_id: str, kind: str, payload: dict[str, Any]) -> None:
        return None


def _queues() -> list[Any]:
    return ["memory", pytest.param("db", marks=pytest.mark.db)]


async def _with_queue(kind: str, body: Callable[[Any], Awaitable[None]]) -> None:
    if kind == "memory":
        await body(MemoryJobQueue())
        return
    if not DB_URL:
        pytest.skip("RTGAIA_TEST_DB_URL 未設")
    from rtgaia_server.db.jobs import DbJobQueue
    from sqlalchemy.ext.asyncio import create_async_engine

    engine = create_async_engine(DB_URL)
    try:
        await body(DbJobQueue(engine))
    finally:
        await engine.dispose()


@pytest.fixture(autouse=True)
def _short_lease(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(jobs, "LEASE_SECONDS", LEASE)
    monkeypatch.setattr(jobs, "RECLAIM_EVERY_SECONDS", 0.0)
    monkeypatch.setattr(jobs, "WORKER_BACKOFF_MAX_SECONDS", 0.05)


@pytest.fixture(scope="module", autouse=True)
def _db_schema() -> None:
    if DB_URL:
        from rtgaia_server.db.migrate import downgrade_base, upgrade_to_head

        downgrade_base(DB_URL)
        upgrade_to_head(DB_URL)


async def _until(pred: Callable[[], Awaitable[bool]], timeout: float = 8.0) -> None:
    deadline = asyncio.get_running_loop().time() + timeout
    while asyncio.get_running_loop().time() < deadline:
        if await pred():
            return
        await asyncio.sleep(0.02)
    raise AssertionError("等不到條件成立")


async def _stop(*tasks: asyncio.Task[Any]) -> None:
    for t in tasks:
        t.cancel()
    await asyncio.gather(*tasks, return_exceptions=True)


@pytest.mark.parametrize("kind", _queues())
def test_long_job_with_heartbeat_runs_once_on_two_workers(kind: str, monkeypatch: pytest.MonkeyPatch) -> None:
    runs = {"n": 0}

    async def long_job(app: Any, job: Any) -> None:
        runs["n"] += 1
        await asyncio.sleep(LEASE * 5)  # 遠長於租約；靠心跳續約

    monkeypatch.setitem(jobs.HANDLERS, "t_long", long_job)

    async def body(queue: Any) -> None:
        app = _App(queue)
        job = await queue.enqueue(new_job("case_1", "t_long", {}, requested_by="u"))  # type: ignore[arg-type]
        w1 = asyncio.create_task(worker_loop(app, poll_seconds=0.02))
        w2 = asyncio.create_task(worker_loop(app, poll_seconds=0.02))
        try:
            await _until(lambda: _status(queue, job.job_id, "done"))
            assert runs["n"] == 1, f"持續心跳的長工作被執行了 {runs['n']} 次"
            got = await queue.get(job.job_id)
            assert got.attempts == 1
        finally:
            await _stop(w1, w2)

    asyncio.run(_with_queue(kind, body))


@pytest.mark.parametrize("kind", _queues())
def test_dead_worker_job_is_reclaimed_only_after_lease_expires(kind: str, monkeypatch: pytest.MonkeyPatch) -> None:
    calls = {"n": 0}
    started = asyncio.Event()

    async def hangs_first_time(app: Any, job: Any) -> None:
        calls["n"] += 1
        if calls["n"] == 1:
            started.set()
            await asyncio.sleep(3600)  # 第一個 worker 卡在這裡，然後「死掉」

    monkeypatch.setitem(jobs.HANDLERS, "t_hang", hangs_first_time)

    async def body(queue: Any) -> None:
        app = _App(queue)
        job = await queue.enqueue(new_job("case_1", "t_hang", {}, requested_by="u"))  # type: ignore[arg-type]
        w1 = asyncio.create_task(worker_loop(app, poll_seconds=0.02))
        await asyncio.wait_for(started.wait(), timeout=5)
        await _stop(w1)  # worker 死了：心跳跟著停
        died_at = asyncio.get_running_loop().time()
        w2 = asyncio.create_task(worker_loop(app, poll_seconds=0.02))
        try:
            await _until(lambda: _status(queue, job.job_id, "done"))
            waited = asyncio.get_running_loop().time() - died_at
            assert waited >= LEASE * 0.8, f"租約還沒到期就被接手了（{waited:.2f}s）"
            got = await queue.get(job.job_id)
            assert got.attempts == 2 and calls["n"] == 2
        finally:
            await _stop(w2)

    asyncio.run(_with_queue(kind, body))


@pytest.mark.parametrize("kind", _queues())
def test_old_attempt_cannot_commit(kind: str) -> None:
    async def body(queue: Any) -> None:
        job = await queue.enqueue(new_job("case_1", "export", {}, requested_by="u"))
        first = await queue.claim("w1")
        assert first is not None and first.job_id == job.job_id and first.attempt_id
        await asyncio.sleep(LEASE * 1.5)  # w1 沒心跳 → 租約過期
        assert await queue.reclaim_expired() == 1
        second = await queue.claim("w2")
        assert second is not None and second.attempt_id != first.attempt_id
        # 舊的 w1 回來了，想寫它的結果
        first.status, first.error = "failed", "w1 的舊結果"
        with pytest.raises(StaleAttempt):
            await queue.update(first)
        assert not await queue.heartbeat(first.job_id, first.attempt_id)
        second.status = "done"
        await queue.update(second)
        final = await queue.get(job.job_id)
        assert final.status == "done" and final.error is None

    asyncio.run(_with_queue(kind, body))


@pytest.mark.parametrize("kind", _queues())
def test_deferred_external_job_is_not_reclaimed(kind: str, monkeypatch: pytest.MonkeyPatch) -> None:
    async def dispatch(app: Any, job: Any) -> Any:
        return DEFERRED  # 已派送給 plugin；之後靠回呼／輪詢與自己的 deadline

    monkeypatch.setitem(jobs.HANDLERS, "t_deferred", dispatch)

    async def body(queue: Any) -> None:
        app = _App(queue)
        job = await queue.enqueue(new_job("case_1", "t_deferred", {}, requested_by="u"))  # type: ignore[arg-type]
        w = asyncio.create_task(worker_loop(app, poll_seconds=0.02))
        try:
            await _until(lambda: _lease_cleared(queue, job.job_id))
            await asyncio.sleep(LEASE * 4)
            assert await queue.reclaim_expired() == 0
            got = await queue.get(job.job_id)
            assert got.status == "running" and got.attempts == 1 and got.lease_until is None
        finally:
            await _stop(w)

    asyncio.run(_with_queue(kind, body))


async def _status(queue: Any, job_id: str, status: str) -> bool:
    got = await queue.get(job_id)
    return got is not None and got.status == status


async def _lease_cleared(queue: Any, job_id: str) -> bool:
    got = await queue.get(job_id)
    return got is not None and got.status == "running" and got.attempts == 1 and got.lease_until is None


# ── 工作列的寫入 ───────────────────────────────────────────────────────────────────


@pytest.mark.parametrize("kind", _queues())
def test_update_rejects_unknown_jobs_and_stale_copies(kind: str) -> None:
    """`update` 不再新增沒排入過的列（子步驟以前因此變成新的 queued 工作）；讀出後被別人寫過的副本寫不回去，
    `mutate_job` 重讀重套。"""

    async def body(queue: Any) -> None:
        with pytest.raises(KeyError):
            await queue.update(new_job("case_1", "export", {}, requested_by="u"))
        job = await queue.enqueue(new_job("case_1", "export", {}, requested_by="u"))
        a, b = await queue.get(job.job_id), await queue.get(job.job_id)
        a.phase = "by-a"
        await queue.update(a)
        b.result = {"by": "b"}
        with pytest.raises(jobs.JobChanged):
            await queue.update(b)

        def change(fresh: Any) -> bool:
            fresh.result = {"by": "b"}
            return True

        await jobs.mutate_job(queue, job.job_id, change)
        got = await queue.get(job.job_id)
        assert got.phase == "by-a" and got.result == {"by": "b"}

    asyncio.run(_with_queue(kind, body))


@pytest.mark.parametrize("kind", _queues())
def test_progress_does_not_shorten_a_renewed_lease(kind: str) -> None:
    """worker 以前每寫一次進度就把領取當下的租約寫回去 → 心跳延長的被縮短，長工作被回收、別的 worker 重跑。"""

    async def body(queue: Any) -> None:
        app = _App(queue)
        await queue.enqueue(new_job("case_1", "export", {}, requested_by="u"))
        job = await queue.claim("w1")
        assert await queue.heartbeat(job.job_id, job.attempt_id, LEASE * 20)
        renewed = (await queue.get(job.job_id)).lease_until
        await asyncio.sleep(LEASE * 1.5)  # 領取時的租約已經過期
        await jobs._progress(app, job, "work", 50)
        got = await queue.get(job.job_id)
        assert got.phase == "work" and got.percent == 50 and got.lease_until == renewed
        assert await queue.reclaim_expired() == 0

    asyncio.run(_with_queue(kind, body))


@pytest.mark.parametrize("kind", _queues())
def test_worker_does_not_overwrite_a_job_finished_while_it_ran(kind: str, monkeypatch: pytest.MonkeyPatch) -> None:
    """跑到一半被取消（或逾時）的工作：worker 收尾時不能把它寫回 done、也不能把它的結果寫進去。"""
    gate = asyncio.Event()

    async def slow(app: Any, job: Any) -> None:
        await gate.wait()
        job.result = {"late": True}

    monkeypatch.setitem(jobs.HANDLERS, "t_slow", slow)

    async def body(queue: Any) -> None:
        app = _App(queue)
        job = await queue.enqueue(new_job("case_1", "t_slow", {}, requested_by="u"))  # type: ignore[arg-type]
        w = asyncio.create_task(worker_loop(app, poll_seconds=0.02))
        try:
            await _until(lambda: _status(queue, job.job_id, "running"))

            def cancel(fresh: Any) -> bool:
                fresh.status, fresh.phase, fresh.error = "failed", "failed", "cancelled"
                return True

            await jobs.mutate_job(queue, job.job_id, cancel)
            gate.set()
            await asyncio.sleep(0.3)
            got = await queue.get(job.job_id)
            assert got.status == "failed" and got.error == "cancelled" and "late" not in got.result
        finally:
            await _stop(w)

    asyncio.run(_with_queue(kind, body))


def test_heartbeat_keeps_renewing_after_a_transient_error() -> None:
    """心跳出一次錯（DB 重啟）以前整個續約就停了，租約到期後工作被回收重跑。"""
    calls: list[int] = []

    class _Queue:
        async def heartbeat(self, job_id: str, attempt_id: str, lease_seconds: float | None = None) -> bool:
            calls.append(1)
            if len(calls) == 1:
                raise ConnectionError("DB 重啟中（模擬）")
            return True

    job = new_job("case_1", "export", {}, requested_by="u")
    job.attempt_id, job.lease_until = "a1", "2099-01-01T00:00:00.000000+00:00"

    async def main() -> None:
        task = asyncio.create_task(jobs._keep_lease(_Queue(), job, {}))
        await asyncio.sleep(LEASE / 3 * 3.6)
        task.cancel()
        await asyncio.gather(task, return_exceptions=True)

    asyncio.run(main())
    assert len(calls) >= 3


@pytest.mark.parametrize("kind", _queues())
def test_lease_failure_records_finish_time_and_notifies(kind: str) -> None:
    """租約過期、重試用完被判失敗：以前沒有結束時間、也沒推通知，畫面一直顯示執行中。"""

    async def body(queue: Any) -> None:
        failed: list[str] = []

        async def on_failed(gone: list[Any]) -> None:
            failed.extend(j.job_id for j in gone)

        queue.on_lease_failed = on_failed
        job = await queue.enqueue(new_job("case_1", "export", {}, requested_by="u"))
        for _ in range(jobs.MAX_ATTEMPTS):
            assert await queue.claim("w") is not None  # 每次領之前先回收上一輪過期的
            await asyncio.sleep(LEASE * 1.5)
        await queue.reclaim_expired()
        got = await queue.get(job.job_id)
        assert got.status == "failed" and got.phase == "failed" and got.finished_at
        assert failed == [job.job_id]

    asyncio.run(_with_queue(kind, body))


def test_sub_steps_do_not_write_the_queue() -> None:
    """子步驟（匯出後存進資料庫的匯入、C-GET 後的匯入、service.call 的送出）以前自己寫回：同一個 job_id 的
    把執行中的那一列改成 kind=import／queued，`-send` 變成一筆新的 queued 工作被再跑一次。"""
    queue = MemoryJobQueue()
    app = _App(queue)
    parent = new_job("case_1", "export", {}, requested_by="u")
    child = jobs.Job(job_id=parent.job_id, case_id="case_1", kind="import", request={}, parent=parent)
    send = jobs.Job(job_id=f"{parent.job_id}-send", case_id="case_1", kind="send", request={}, parent=parent)
    asyncio.run(jobs._progress(app, child, "stage", 5))
    asyncio.run(jobs._progress(app, send, "associate", 5))
    assert queue.jobs == {}
