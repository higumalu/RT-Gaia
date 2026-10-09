"""worker 迴圈不因單一工作的收尾失敗而結束；`/readyz` 看得到 worker 死掉。

重現：handler 失敗 → 收尾的 `job_queue_async_update()` 丟 ConnectionError → 以前 `worker_loop`
只 claim 一次就把例外往外丟，獨立 worker 行程活著卻不再領工作。
"""

from __future__ import annotations

import asyncio
from typing import Any

import pytest
from fastapi.testclient import TestClient
from rtgaia_core import jobs
from rtgaia_core.jobs import MemoryJobQueue, new_job, worker_loop
from rtgaia_testbe.api import create_app


class _FlakyApp:
    """最小的 app 替身：佇列用真的 MemoryJobQueue；第一次「收尾寫回」丟 ConnectionError（DB 暫時斷線）。"""

    def __init__(self) -> None:
        self.queue = MemoryJobQueue()
        self.worker_health: dict[str, Any] = {}
        self.fail_final_updates = 1
        self.notified: list[str] = []

    async def job_queue_async(self) -> MemoryJobQueue:
        return self.queue

    async def job_queue_async_update(self, job: Any) -> None:
        if job.finished_at and self.fail_final_updates > 0:
            self.fail_final_updates -= 1
            raise ConnectionError("DB 暫時斷線（模擬）")
        await self.queue.update(job)

    async def mutate_job(self, job_id: str, change: Any, *, release_lease: bool = False) -> Any:
        async def flaky_get(jid: str) -> Any:
            return await self.queue.get(jid)

        class _Flaky:
            get = staticmethod(flaky_get)

            @staticmethod
            async def update(job: Any, *, release_lease: bool = False) -> None:
                await self.job_queue_async_update(job)

        return await jobs.mutate_job(_Flaky, job_id, change, release_lease=release_lease)

    async def notify_case(self, case_id: str, kind: str, payload: dict[str, Any]) -> None:
        self.notified.append(kind)

    async def record_export(self, job: Any) -> None:  # pragma: no cover - 這裡用不到
        return None


async def _run_until(app: _FlakyApp, done: Any, timeout: float = 5.0) -> asyncio.Task[None]:
    task = asyncio.create_task(worker_loop(app, poll_seconds=0.01))
    deadline = asyncio.get_running_loop().time() + timeout
    while not done() and asyncio.get_running_loop().time() < deadline:
        await asyncio.sleep(0.01)
    return task


def test_worker_keeps_claiming_after_result_save_fails(monkeypatch: pytest.MonkeyPatch) -> None:
    async def failing(app: Any, job: Any) -> None:
        raise RuntimeError("handler 失敗")

    async def ok(app: Any, job: Any) -> None:
        return None

    monkeypatch.setitem(jobs.HANDLERS, "t_fail", failing)
    monkeypatch.setitem(jobs.HANDLERS, "t_ok", ok)
    monkeypatch.setattr(jobs, "WORKER_BACKOFF_MAX_SECONDS", 0.05)

    async def scenario() -> None:
        app = _FlakyApp()
        first = await app.queue.enqueue(new_job("case_1", "t_fail", {}, requested_by="u"))  # type: ignore[arg-type]
        await asyncio.sleep(0.001)
        second = await app.queue.enqueue(new_job("case_1", "t_ok", {}, requested_by="u"))  # type: ignore[arg-type]
        task = await _run_until(app, lambda: app.queue.jobs[second.job_id].status == "done")
        try:
            assert not task.done(), f"worker 迴圈結束了：{task.exception() if task.done() else ''}"
            assert app.queue.jobs[second.job_id].status == "done", "第一個工作收尾失敗後，第二個工作沒被領"
            # 第一個的結果沒寫進去 → 留在 running（交給佇列的回收規則），不是被當成成功
            assert app.queue.jobs[first.job_id].status in ("running", "failed")
            h = app.worker_health
            assert h["errors"] == 1 and first.job_id in h["last_error"] and "ConnectionError" in h["last_error"]
            assert h["jobs"] == 1 and h["busy_job"] is None and h["last_tick"] > 0
        finally:
            task.cancel()
            with pytest.raises(asyncio.CancelledError):
                await task  # 正常關機：CancelledError 照常往外丟

    asyncio.run(scenario())


def test_worker_survives_claim_errors_with_backoff(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(jobs, "WORKER_BACKOFF_MAX_SECONDS", 0.02)

    async def scenario() -> None:
        app = _FlakyApp()
        calls = {"n": 0}
        real = app.queue.claim

        async def flaky_claim(worker_id: str) -> Any:
            calls["n"] += 1
            if calls["n"] <= 3:
                raise OSError("連不上 DB（模擬）")
            return await real(worker_id)

        app.queue.claim = flaky_claim  # type: ignore[method-assign]
        task = await _run_until(app, lambda: calls["n"] > 5)
        try:
            assert not task.done()
            assert app.worker_health["errors"] == 3 and "OSError" in app.worker_health["last_error"]
        finally:
            task.cancel()
            with pytest.raises(asyncio.CancelledError):
                await task

    asyncio.run(scenario())


def test_readyz_reports_dead_inprocess_worker() -> None:
    """`/healthz` 是存活＋診斷（永遠 200）；`/readyz` 在行程內 worker 死掉時回 503。"""
    app = create_app(test_api=True)
    with TestClient(app) as c:
        ready = c.get("/readyz")
        assert ready.status_code == 200 and ready.json()["checks"]["worker"]["alive"] is True
        state = app.state.rtgaia
        state.worker_task.cancel()
        for _ in range(50):
            if state.worker_task.done():
                break
            c.get("/healthz")  # 讓 event loop 跑一下
        not_ready = c.get("/readyz")
        assert not_ready.status_code == 503
        assert not_ready.json()["checks"]["worker"]["alive"] is False
        health = c.get("/healthz")
        assert health.status_code == 200 and health.json()["worker"]["alive"] is False


def test_readyz_reports_a_bus_listener_that_stays_down() -> None:
    """事件匯流排的 LISTEN 連線斷了（收不到別的行程的推送）
    → 超過 `BUS_DOWN_SECONDS` 就 503。"""
    from rtgaia_core.api import BUS_DOWN_SECONDS

    class _Bus:
        def __init__(self) -> None:
            self.state = {"listening": True, "down_seconds": 0.0, "reconnects": 0, "last_error": None}

        def status(self) -> dict[str, Any]:
            return self.state

        async def stop(self) -> None:
            pass

    app = create_app(test_api=True)
    with TestClient(app) as c:
        bus = _Bus()
        app.state.rtgaia.bus = bus
        assert c.get("/readyz").status_code == 200
        bus.state = {"listening": False, "down_seconds": 3.0, "reconnects": 1, "last_error": "ConnectionError"}
        assert c.get("/readyz").status_code == 200  # 剛斷：重連中
        bus.state = {**bus.state, "down_seconds": BUS_DOWN_SECONDS + 1}
        down = c.get("/readyz")
        assert down.status_code == 503 and down.json()["checks"]["bus"]["listening"] is False


def test_standalone_worker_exits_nonzero_when_loop_dies(monkeypatch: pytest.MonkeyPatch) -> None:
    """獨立 worker：迴圈意外結束 → 行程 SystemExit(1)（讓 compose 的 restart 重啟），不是活著等 stop 訊號。"""
    from rtgaia_server import worker_main

    async def dying_loop(state: Any, **_: Any) -> None:
        raise RuntimeError("迴圈死了（模擬）")

    monkeypatch.setattr(jobs, "worker_loop", dying_loop)

    class _State:
        bus = None
        catalog_store = None

        async def bus_async(self) -> None:
            return None

    with pytest.raises(SystemExit) as info:
        asyncio.run(asyncio.wait_for(worker_main._run(_State()), timeout=5))  # type: ignore[arg-type]
    assert info.value.code == 1
