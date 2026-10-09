"""佇列的條件查詢 `find`（DB 端篩、舊到新、keyset 分頁）與 plugin 輪詢不再只看最近 500 筆。

重現：一筆較舊的 running plugin ＋ 500 筆較新的 done export → PluginManager 查到 0 筆 running（實際 1 筆）。
Memory 與 Postgres 兩種佇列跑同一組斷言；Postgres 需要 `RTGAIA_TEST_DB_URL`。
"""

from __future__ import annotations

import asyncio
import os
from typing import Any

import pytest
from rtgaia_core.jobs import FIND_PAGE, Job, MemoryJobQueue, find_all, new_job

DB_URL = os.environ.get("RTGAIA_TEST_DB_URL", "")


def _job(kind: str, status: str, at: str, *, finished: str | None = None) -> Job:
    j = new_job("case_1", kind, {}, requested_by="u")  # type: ignore[arg-type]
    j.requested_at = at
    j.status = status  # type: ignore[assignment]
    j.finished_at = finished
    return j


async def _fill(queue: Any) -> tuple[Job, list[Job]]:
    old_plugin = await queue.enqueue(_job("plugin:seg", "running", "2026-09-30T00:00:00+00:00"))
    newer = []
    # 1000 筆較新的完成工作（同一秒 → 靠 job_id 決定順序，也順便驗 keyset 的平手處理）
    for i in range(1000):
        newer.append(await queue.enqueue(_job("export", "done", f"2026-09-30T01:{i // 60:02d}:{i % 60:02d}+00:00")))
    return old_plugin, newer


async def _assertions(queue: Any) -> None:
    old_plugin, _ = await _fill(queue)
    # 以前的寫法：最近 500 筆再在 Python 篩 → 0 筆
    legacy = [j for j in await queue.list(limit=500) if str(j.kind).startswith("plugin:") and j.status == "running"]
    assert legacy == []
    running = await find_all(queue, status="running", kinds=["service.call"], kind_prefixes=["plugin:"])
    assert [j.job_id for j in running] == [old_plugin.job_id]
    # 分頁：1000 筆 done export 跨好幾頁，無重複、無遺漏、舊到新
    done = await find_all(queue, status="done", kinds=["export"])
    ids = [j.job_id for j in done]
    assert len(ids) == 1000 and len(set(ids)) == 1000
    assert [j.requested_at for j in done] == sorted(j.requested_at for j in done)
    # 一頁剛好 FIND_PAGE
    first = await queue.find(status="done", limit=FIND_PAGE)
    assert len(first) == FIND_PAGE
    # finished_after（service.call 等回傳用）
    imp_old = await queue.enqueue(
        _job("import", "done", "2026-09-30T02:00:00+00:00", finished="2026-09-30T02:00:05+00:00")
    )
    imp_new = await queue.enqueue(
        _job("import", "done", "2026-09-30T02:10:00+00:00", finished="2026-09-30T02:10:05+00:00")
    )
    got = await find_all(queue, status="done", kinds=["import"], finished_after="2026-09-30T02:05:00+00:00")
    assert [j.job_id for j in got] == [imp_new.job_id] and imp_old.job_id not in [j.job_id for j in got]


def test_memory_queue_find_and_pagination() -> None:
    asyncio.run(_assertions(MemoryJobQueue()))


@pytest.mark.db
def test_db_queue_find_and_pagination() -> None:
    if not DB_URL:
        pytest.skip("RTGAIA_TEST_DB_URL 未設")
    from rtgaia_server.db.jobs import DbJobQueue
    from rtgaia_server.db.migrate import downgrade_base, upgrade_to_head
    from sqlalchemy.ext.asyncio import create_async_engine

    downgrade_base(DB_URL)
    upgrade_to_head(DB_URL)

    async def main() -> None:
        engine = create_async_engine(DB_URL)
        try:
            await _assertions(DbJobQueue(engine))
        finally:
            await engine.dispose()

    asyncio.run(main())


def test_plugin_manager_polls_old_running_job_behind_500_newer(monkeypatch: pytest.MonkeyPatch) -> None:
    """重現的原樣：真的 PluginManager．`_running_plugin_jobs()` 要找得到被 500 筆新工作蓋過的舊 running plugin。"""
    from rtgaia_core.plugins import PluginManager

    queue = MemoryJobQueue()

    class _App:
        async def job_queue_async(self) -> MemoryJobQueue:
            return queue

    async def main() -> list[Any]:
        old = await queue.enqueue(_job("plugin:seg", "running", "2026-09-30T00:00:00+00:00"))
        for i in range(500):
            await queue.enqueue(_job("export", "done", f"2026-09-30T01:{i // 60:02d}:{i % 60:02d}+00:00"))
        pm = PluginManager.__new__(PluginManager)
        pm.app = _App()  # type: ignore[attr-defined]
        found = await pm._running_plugin_jobs()
        assert [j.job_id for j in found] == [old.job_id]
        return found

    asyncio.run(main())
