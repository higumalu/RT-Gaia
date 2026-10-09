"""事件匯流排（Postgres outbox ＋ NOTIFY）與獨立 worker 行程。需要 `RTGAIA_TEST_DB_URL`；沒設就 skip。"""

from __future__ import annotations

import asyncio
import os
import threading
import time
from pathlib import Path

import numpy as np
import pytest
from rtgaia_server.db.migrate import downgrade_base, upgrade_to_head
from rtgaia_testbe import Session
from synth_dicom import SynthCase, write_synth_case

pytestmark = pytest.mark.db
DB_URL = os.environ.get("RTGAIA_TEST_DB_URL", "")


@pytest.fixture(scope="module")
def synth(tmp_path_factory) -> SynthCase:
    return write_synth_case(tmp_path_factory.mktemp("synth"))


@pytest.fixture
def db_url(monkeypatch, tmp_path: Path) -> str:  # type: ignore[no-untyped-def]
    if not DB_URL:
        pytest.skip("RTGAIA_TEST_DB_URL 未設")
    monkeypatch.setenv("RTGAIA_DATA_DIR", str(tmp_path / "data"))
    downgrade_base(DB_URL)
    upgrade_to_head(DB_URL)
    return DB_URL


def test_pg_bus_delivers_across_instances_once_and_handles_large_payloads(db_url: str) -> None:
    from rtgaia_server.db.bus import PgBus
    from sqlalchemy.ext.asyncio import create_async_engine

    async def main() -> dict:
        engine = create_async_engine(db_url)
        got_a: list[tuple[str, str, int]] = []
        got_b: list[tuple[str, str, int]] = []

        async def deliver_a(target: str, t: str, payload: dict) -> int:
            got_a.append((target, t, len(str(payload))))
            return 1

        async def deliver_b(target: str, t: str, payload: dict) -> int:
            got_b.append((target, t, len(str(payload))))
            return 1

        a = PgBus(engine, db_url, deliver_a)  # API 行程 A（訂閱）
        b = PgBus(engine, db_url, deliver_b)  # API 行程 B（訂閱）
        w = PgBus(engine, db_url, None)  # worker（只發布）
        await a.start()
        await b.start()
        await asyncio.sleep(0.3)  # LISTEN 就位
        big = {"jobId": "j", "phase": "x" * 20000, "percent": 50}  # > NOTIFY 8000 bytes 上限
        await w.publish("sess_1", "job.progress", big)
        await a.publish("*", "catalog.changed", {"patient_ids": ["P1"]})
        for _ in range(50):
            if len(got_a) >= 2 and len(got_b) >= 2:
                break
            await asyncio.sleep(0.05)
        out = {
            "a": got_a,
            "b": got_b,
            "a_received_from_others": a.received,
            "b_received_from_others": b.received,
        }
        await a.stop()
        await b.stop()
        await engine.dispose()
        return out

    out = asyncio.run(main())
    # worker 發的：A、B 各收到一次，內容完整（大 payload 走 outbox 表）
    assert [x for x in out["a"] if x[1] == "job.progress"] == [
        ("sess_1", "job.progress", len(str({"jobId": "j", "phase": "x" * 20000, "percent": 50})))
    ]
    assert [x for x in out["b"] if x[1] == "job.progress"][0][0] == "sess_1"
    # A 自己發的：A 本地同步送**一次**（不會從 LISTEN 再送一次）；B 從 LISTEN 收到一次
    assert [x for x in out["a"] if x[1] == "catalog.changed"] == [
        ("*", "catalog.changed", len(str({"patient_ids": ["P1"]})))
    ]
    assert [x for x in out["b"] if x[1] == "catalog.changed"] == [
        ("*", "catalog.changed", len(str({"patient_ids": ["P1"]})))
    ]
    assert out["a_received_from_others"] == 1 and out["b_received_from_others"] == 2


def test_pg_bus_listener_reconnects_after_its_connection_is_killed(db_url: str) -> None:
    """Postgres 重啟（或連線被切）時，以前 listener 卡在 `queue.get()` 永遠不重連 ——
    API 再也收不到 worker 的進度與完成。現在連線終止會叫醒它，重連後補上斷線期間發布的列。"""
    from rtgaia_server.db.bus import PgBus
    from sqlalchemy import text
    from sqlalchemy.ext.asyncio import create_async_engine

    async def main() -> tuple[list[str], dict]:
        engine = create_async_engine(db_url)
        got: list[str] = []

        async def deliver(_target: str, message_type: str, _payload: dict) -> int:
            got.append(message_type)
            return 1

        api = PgBus(engine, db_url, deliver)
        worker = PgBus(engine, db_url, None)
        await api.start()
        for _ in range(100):
            if api._conn is not None:
                break
            await asyncio.sleep(0.05)
        await asyncio.sleep(0.3)  # LISTEN 就位、起點記下
        pid = api._conn.get_server_pid()
        async with engine.connect() as conn:
            await conn.execute(text("SELECT pg_terminate_backend(:pid)"), {"pid": pid})
        await worker.publish("sess_1", "job.done", {"jobId": "j"})  # 斷線期間別的行程發布
        for _ in range(200):
            if "job.done" in got:
                break
            await asyncio.sleep(0.05)
        after = dict(api.status() or {}) if hasattr(api, "status") else {}
        await api.stop()
        await engine.dispose()
        return got, after

    got, after = asyncio.run(main())
    assert got == ["job.done"]
    assert after["listening"] is True and after["reconnects"] >= 1 and after["last_error"]


class _ExternalWorker:
    """在另一條執行緒、另一個 event loop 跑 `worker_loop` —— 模擬獨立的 rtgaia-worker 行程。"""

    def __init__(self, db_url: str, library_root: str) -> None:
        from rtgaia_server.worker_main import make_worker_state

        self.state = make_worker_state(db_url=db_url, library_root=library_root)
        self.loop = asyncio.new_event_loop()
        self.task: asyncio.Task | None = None
        self.thread = threading.Thread(target=self._run, daemon=True)

    def _run(self) -> None:
        from rtgaia_core.jobs import worker_loop

        asyncio.set_event_loop(self.loop)

        async def go() -> None:
            await self.state.bus_async()
            self.task = asyncio.create_task(worker_loop(self.state, poll_seconds=0.1))
            try:
                await self.task
            except asyncio.CancelledError:
                pass
            if self.state.bus is not None:
                await self.state.bus.stop()
            if self.state.catalog_store is not None:
                await self.state.catalog_store.dispose()

        self.loop.run_until_complete(go())

    def start(self) -> None:
        self.thread.start()

    def stop(self) -> None:
        if self.task is not None:
            self.loop.call_soon_threadsafe(self.task.cancel)
        self.thread.join(timeout=10)


def test_external_worker_runs_export_and_progress_reaches_api_via_bus(
    db_url: str, synth: SynthCase, monkeypatch
) -> None:  # type: ignore[no-untyped-def]
    monkeypatch.setenv("RTGAIA_INPROCESS_WORKER", "0")  # API 行程不跑 worker
    worker = _ExternalWorker(db_url, str(synth.root))
    with Session(library_root=str(synth.root), db_url=db_url, auth="off", user="qa") as api:
        assert api._app.state.rtgaia.inprocess_worker is False
        api.load_case(
            {
                "primary_series_uid": synth.plan_ct.series_uid,
                "image_series_uids": [synth.plan_ct.series_uid],
                "structure_set_uids": [synth.plan_rs_uid],
                "dose_uids": [],
                "registration_uids": [],
                "plan_uids": [],
            }
        )
        sid = api.claim(api.structures()[0]["structure_id"])
        api.edit(sid, offset_ijk=(0, 0, 0), array=np.ones((2, 2, 2), dtype=np.uint8), client_seq=1)
        job = api._post(f"/api/v1/studies/{api.study_id}/export", {"format": "rtstruct"})
        # 沒有 worker：停在 queued
        time.sleep(0.5)
        assert api._get(f"/api/v1/jobs/{job['job_id']}")["status"] == "queued"
        worker.start()
        try:
            deadline = time.time() + 30
            while time.time() < deadline:
                j = api._get(f"/api/v1/jobs/{job['job_id']}")
                if j["status"] in ("done", "failed"):
                    break
                time.sleep(0.1)
            assert j["status"] == "done", j
            assert j["worker_id"] and j["worker_id"] != "" and j["requested_by"] == "qa"
            # 結果從 blob 下載（worker 寫、API 讀，同一個 RTGAIA_DATA_DIR）
            blob = api._client.get(j["download_url"]).content
            assert blob[128:132] == b"DICM"
            # worker 的 job.progress 經匯流排到 API 行程的 PushHub
            for _ in range(50):
                targets = [t for t in api.state["push_targets_tail"] if t["type"] == "job.progress"]
                if targets:
                    break
                time.sleep(0.1)
            assert targets and targets[-1]["sessionId"] == api.session_id
        finally:
            worker.stop()


def test_external_worker_exports_edits_made_after_its_first_job(db_url: str, synth: SynthCase, monkeypatch) -> None:  # type: ignore[no-untyped-def]
    """獨立 worker 第一個工作載入病例後就一直用那份 —— 之後在 API 改的輪廓，
    第二次匯出還是舊的。現在不擁有即時病例的行程每個工作都從 DB 重建。"""
    monkeypatch.setenv("RTGAIA_INPROCESS_WORKER", "0")
    worker = _ExternalWorker(db_url, str(synth.root))
    with Session(library_root=str(synth.root), db_url=db_url, auth="off", user="qa") as api:
        api.load_case(
            {
                "primary_series_uid": synth.plan_ct.series_uid,
                "image_series_uids": [synth.plan_ct.series_uid],
                "structure_set_uids": [synth.plan_rs_uid],
                "dose_uids": [],
                "registration_uids": [],
                "plan_uids": [],
            }
        )
        sid = api.claim(api.structures()[0]["structure_id"])
        worker.start()
        try:
            api.edit(sid, offset_ijk=(0, 0, 0), array=np.ones((2, 2, 2), dtype=np.uint8), client_seq=1)
            first_head = api.versions(sid)["head_version_id"]
            first = api.wait_for_job(api.export_rtstruct([sid])["job_id"])
            api.edit(sid, offset_ijk=(0, 0, 0), array=np.zeros((2, 2, 2), dtype=np.uint8), client_seq=2)
            second_head = api.versions(sid)["head_version_id"]
            second = api.wait_for_job(api.export_rtstruct([sid])["job_id"])
        finally:
            worker.stop()
    assert first["status"] == "done" and second["status"] == "done", (first, second)
    assert first["exported_versions"][sid] == first_head
    assert second_head != first_head
    assert second["exported_versions"][sid] == second_head
    assert worker.state.store.cases() == []  # worker 不留病例


def test_worker_reloads_the_library_after_another_process_imports(db_url: str, synth: SynthCase, tmp_path) -> None:  # type: ignore[no-untyped-def]
    """獨立 worker 不訂閱匯流排、收不到 `catalog.changed`：以前它的目錄停在第一次載入的樣子，
    之後從瀏覽器上傳的序列，匯出、送出都找不到。現在每次用之前比對目錄世代。"""
    import shutil

    from rtgaia_server.app import make_state
    from rtgaia_server.worker_main import make_worker_state

    root = tmp_path / "library"
    shutil.copytree(synth.plan_ct.directory, root / "ct")

    async def main() -> tuple[set[str], set[str], set[str]]:
        api = make_state()
        api.db_url, api.library_root = db_url, str(root)
        worker = make_worker_state(db_url=db_url, library_root=str(root))
        try:
            before = set((await worker.library_index_async()).series)
            shutil.copytree(synth.cbct.directory, root / "cbct")
            await api.library_index_async(rescan=True)  # API 行程匯入（上傳、伺服器目錄都走這裡）
            after = set((await worker.library_index_async()).series)
            again = set((await worker.library_index_async()).series)
        finally:
            for s in (api, worker):
                if s.catalog_store is not None:
                    await s.catalog_store.dispose()
        return before, after, again

    before, after, again = asyncio.run(main())
    assert synth.cbct.series_uid not in before
    assert synth.cbct.series_uid in after and after == again
