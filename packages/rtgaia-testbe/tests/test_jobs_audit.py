"""job 佇列（Postgres、SKIP LOCKED、worker）、匯出結果進 blob store、append-only 稽核。
DB 測試需要 `RTGAIA_TEST_DB_URL`；沒設就 skip。記憶體模式的稽核尾巴不需要 DB。
"""

from __future__ import annotations

import asyncio
import os
import time
from pathlib import Path

import numpy as np
import pytest
from rtgaia_server.db.migrate import downgrade_base, upgrade_to_head
from rtgaia_testbe import Session
from synth_dicom import SynthCase, write_synth_case

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


def _selection(synth: SynthCase) -> dict:
    return {
        "primary_series_uid": synth.plan_ct.series_uid,
        "image_series_uids": [synth.plan_ct.series_uid, synth.cbct.series_uid],
        "structure_set_uids": [synth.plan_rs_uid, synth.cbct_rs_uid],
        "dose_uids": [synth.plan_dose_uid],
        "registration_uids": [synth.reg_uid],
        "plan_uids": [synth.plan_uid],
    }


def _wait(s: Session, job_id: str, timeout: float = 30.0) -> dict:
    deadline = time.time() + timeout
    while True:
        j = s._get(f"/api/v1/jobs/{job_id}")
        if j["status"] in ("done", "failed"):
            return j
        if time.time() > deadline:
            raise TimeoutError(j)
        time.sleep(0.05)


def test_memory_mode_export_still_works_and_audit_tail_records_writes(monkeypatch, tmp_path: Path) -> None:  # type: ignore[no-untyped-def]
    monkeypatch.setenv("RTGAIA_DATA_DIR", str(tmp_path / "data"))
    with Session(user="qa") as s:
        s.load("phantom:overlap_set")
        sid = s.structures()[0]["structure_id"]
        s.edit(sid, offset_ijk=(0, 0, 0), array=np.ones((2, 2, 2), dtype=np.uint8), client_seq=1)
        job = s._post(f"/api/v1/studies/{s.study_id}/export", {"format": "rtstruct"})
        done = _wait(s, job["job_id"])
        assert done["status"] == "done" and done["requested_by"] == "qa" and done["worker_id"]
        assert done["download_url"].endswith(f"/jobs/{job['job_id']}/download")
        blob = s._client.get(done["download_url"], headers=s._headers).content
        assert blob[128:132] == b"DICM" and len(blob) == done["bytes"]
        # 清單：這個病例的 job
        listed = s._get("/api/v1/jobs", case_id=done["case_id"])
        assert [j["job_id"] for j in listed] == [job["job_id"]]
        # 稽核尾巴（沒有 DB 也有）：edit 與 export 都在，帶使用者與物件
        tail = s.state["audit_tail"]
        actions = [(e["action"], e["object_type"], e["user"]) for e in tail]
        assert ("POST /api/v1/structures/{structure_id}/edit", "structure", "qa") in actions
        assert any(a[0].endswith("/export") for a in actions)
        # GET 與 _test 不記
        assert all(not e["action"].startswith("GET") and "/_test/" not in e["action"] for e in tail)


@pytest.mark.db
def test_db_queue_export_survives_restart_and_audit_is_immutable(db_url: str, synth: SynthCase) -> None:
    with Session(library_root=str(synth.root), db_url=db_url, auth="off", user="dr.a") as s:
        first = s.load_case(_selection(synth))
        sid = s.claim(s.structures()[0]["structure_id"])
        s.edit(sid, offset_ijk=(0, 0, 0), array=np.ones((2, 2, 2), dtype=np.uint8), client_seq=1)
        s.review({sid: "approved"}, note="ok")
        job = s._post(f"/api/v1/studies/{s.study_id}/export", {"format": "rtstruct", "structure_ids": [sid]})
        done = _wait(s, job["job_id"])
        assert done["status"] == "done" and done["attempts"] == 1 and done["exported_versions"][sid]
        blob1 = s._client.get(done["download_url"]).content
        assert blob1[128:132] == b"DICM"
        # 稽核：DB 裡有 edit／review／export，帶 user、物件、status
        audit = s._get("/api/v1/audit", case_id=None)
        actions = {e["action"] for e in audit}
        assert "POST /api/v1/structures/{structure_id}/edit" in actions
        assert "POST /api/v1/studies/{study_id}/review" in actions
        assert all(e["user"] == "dr.a" and e["status"] < 300 for e in audit)
        edit_ev = next(e for e in audit if e["action"].endswith("/edit"))
        assert edit_ev["object_type"] == "structure" and edit_ev["object_id"] == sid

    # 第二個行程：job 與結果都在（DB ＋ blob），清單與下載仍可
    with Session(library_root=str(synth.root), db_url=db_url, auth="off") as s2:
        again = s2._get(f"/api/v1/jobs/{job['job_id']}")
        assert again["status"] == "done" and again["requested_by"] == "dr.a"
        assert s2._client.get(again["download_url"]).content == blob1
        assert [j["job_id"] for j in s2._get("/api/v1/jobs", case_id=first["case_id"])] == [job["job_id"]]
        # 新 job 也走 DB 佇列（worker 在 app 裡）
        s2.load_case(_selection(synth))
        job2 = s2._post(f"/api/v1/studies/{s2.study_id}/export", {"format": "rtstruct"})
        assert _wait(s2, job2["job_id"])["status"] == "done"
        # append-only：UPDATE／DELETE 被 trigger 擋
        from sqlalchemy import text
        from sqlalchemy.ext.asyncio import create_async_engine

        async def try_mutate() -> tuple[str, str]:
            engine = create_async_engine(db_url)
            out = []
            for stmt in ("UPDATE audit_event SET \"user\" = 'x'", "DELETE FROM audit_event"):
                try:
                    async with engine.begin() as conn:
                        await conn.execute(text(stmt))
                    out.append("allowed")
                except Exception as exc:  # noqa: BLE001
                    out.append("append-only" if "append-only" in str(exc) else f"other:{exc}"[:60])
            await engine.dispose()
            return out[0], out[1]

        assert asyncio.run(try_mutate()) == ("append-only", "append-only")


@pytest.mark.db
def test_stale_running_job_is_requeued(db_url: str, synth: SynthCase) -> None:
    """以**租約**判斷：租約過期的 running 重排；沒有租約的（已派送給外部的 DEFERRED）
    即使 started_at 很久以前也不動 —— 以前 30 分鐘一到就重排，一小時的 plugin 會在第 30 分鐘被再派一次。"""
    from rtgaia_core.jobs import Job
    from rtgaia_server.db.jobs import DbJobQueue
    from sqlalchemy.ext.asyncio import create_async_engine

    async def main() -> tuple[tuple[str, int], str]:
        engine = create_async_engine(db_url)
        q = DbJobQueue(engine)
        old = Job(job_id="job_stale", case_id="c", kind="export", request={}, status="running", attempts=1)
        old.started_at = "2000-01-01T00:00:00+00:00"
        old.lease_until = "2000-01-01T00:02:00.000000+00:00"  # 租約早就過期（worker 死了）
        await q.enqueue(old)  # 直接放進這個狀態（`update` 不新增列）
        external = Job(job_id="job_ext", case_id="c", kind="plugin:x", request={}, status="running", attempts=1)
        external.started_at = "2000-01-01T00:00:00+00:00"  # 很久以前派出去的，但沒有租約
        external.requested_at = "2100-01-01T00:00:00+00:00"  # 排在後面，不會被 claim 挑到
        await q.enqueue(external)
        claimed = await q.claim("w2")
        ext = await q.get("job_ext")
        await engine.dispose()
        return ((claimed.job_id if claimed else "none"), (claimed.attempts if claimed else -1)), ext.status

    assert asyncio.run(main()) == (("job_stale", 2), "running")


# ── 稽核寫入失敗 → outbox → 重送；兩邊都失敗 → 503 ─────────────────────


def _outbox_counts(db_url: str) -> tuple[int, int]:
    from sqlalchemy import text
    from sqlalchemy.ext.asyncio import create_async_engine

    async def main() -> tuple[int, int]:
        engine = create_async_engine(db_url)
        async with engine.connect() as conn:
            outbox = int((await conn.execute(text("SELECT count(*) FROM audit_outbox"))).scalar() or 0)
            events = int((await conn.execute(text("SELECT count(*) FROM audit_event"))).scalar() or 0)
        await engine.dispose()
        return outbox, events

    return asyncio.run(main())


@pytest.mark.db
def test_audit_failure_goes_to_outbox_and_is_flushed(db_url: str, synth: SynthCase, monkeypatch) -> None:  # type: ignore[no-untyped-def]
    """先前 append 失敗只標 `persist_error`（記憶體 tail、最多 200 筆），業務成功而稽核永久缺一筆。
    現在：append 失敗 → `audit_outbox`（API 仍 200）→ flush 補進 `audit_event`、outbox 清空；重啟也補得回。"""
    from rtgaia_server.db.audit import AuditStore

    monkeypatch.setenv("RTGAIA_AUDIT_FLUSH_SECONDS", "0")  # 背景重送關掉，測試自己叫
    real_append = AuditStore.append
    state = {"fail": False, "calls": 0}

    async def flaky_append(self, event):  # type: ignore[no-untyped-def]
        state["calls"] += 1
        if state["fail"]:
            raise RuntimeError("injected audit_event failure")
        return await real_append(self, event)

    monkeypatch.setattr(AuditStore, "append", flaky_append)
    with Session(library_root=str(synth.root), db_url=db_url, auth="off", user="qa") as s:
        s.load_case(_selection(synth))
        sid = s.claim(s.structures()[0]["structure_id"])
        outbox0, events0 = _outbox_counts(db_url)
        assert outbox0 == 0 and events0 >= 1
        # 主表寫不進去：業務操作仍成功（200），事件進 outbox
        state["fail"] = True
        s.update_structure(sid, color_rgb=[1, 2, 3])
        outbox1, events1 = _outbox_counts(db_url)
        assert outbox1 == 1 and events1 == events0
        tail = s._app.state.rtgaia.audit_tail[-1]
        assert tail.get("persist_error") is True and tail.get("queued") is True
        lag = s._get("/api/v1/audit/status")["lag"]
        assert lag["pending"] == 1 and lag["oldest_age_s"] is not None and lag["gave_up"] == 0
        assert s.health()["audit_lag"]["pending"] == 1
        # 主表恢復 → flush 補上、outbox 清空、lag 歸零。flush 以**另一個引擎**跑（模擬背景 tick／獨立行程）
        state["fail"] = False
        from sqlalchemy.ext.asyncio import create_async_engine

        async def flush_elsewhere() -> dict[str, int]:
            engine = create_async_engine(db_url)
            try:
                return await AuditStore(engine).flush()
            finally:
                await engine.dispose()

        result = asyncio.run(flush_elsewhere())
        assert result["sent"] == 1 and result["failed"] == 0
        outbox2, events2 = _outbox_counts(db_url)
        assert outbox2 == 0 and events2 == events0 + 1
        assert s._get("/api/v1/audit/status")["lag"]["pending"] == 0

        # 兩邊都失敗 → 503 AUDIT_UNAVAILABLE（操作已執行，但不能當正常路徑回 200）
        state["fail"] = True
        monkeypatch.setattr(AuditStore, "enqueue", flaky_append)  # enqueue 也炸
        r = s._client.patch(f"/api/v1/structures/{sid}", json={"color_rgb": [4, 5, 6]}, headers=s._headers)
        assert r.status_code == 503 and r.json()["code"] == "AUDIT_UNAVAILABLE"
        # 業務變更確實發生了（顏色改了）——這正是為什麼要 503 而不是靜默 200
        assert next(x for x in s.structures() if x["structure_id"] == sid)["color_rgb"] == [4, 5, 6]


@pytest.mark.db
def test_audit_outbox_survives_restart_and_gives_up_after_max_attempts(db_url: str) -> None:
    """新行程（新 store）重送舊 outbox；永遠寫不進去的一筆計 attempts，到上限標 gave_up，不刪、不擋其他。"""
    from rtgaia_server.db.audit import OUTBOX_MAX_ATTEMPTS, AuditStore, new_event
    from sqlalchemy.ext.asyncio import create_async_engine

    async def main() -> dict:
        engine = create_async_engine(db_url)
        store = AuditStore(engine)
        good = new_event(
            user="u",
            action="POST /x",
            status=200,
            object_type=None,
            object_id=None,
            case_id=None,
            client_id=None,
            remote_addr=None,
        )
        bad = dict(good, event_id="aud_bad", action="x" * 500)  # action 欄位 128 字 → 永遠寫不進 audit_event
        await store.enqueue(good, "boom")
        await store.enqueue(bad, "boom")
        await store.enqueue(good, "again")  # 冪等：同 event_id 不重複
        lag0 = await store.lag()
        # 「重啟」：另一個 store 實例來 flush
        store2 = AuditStore(engine)
        first = await store2.flush()
        for _ in range(OUTBOX_MAX_ATTEMPTS):
            await store2.flush()
        lag1 = await store2.lag()
        listed = await store2.list(user="u")
        await engine.dispose()
        return {"lag0": lag0, "first": first, "lag1": lag1, "listed": [e["event_id"] for e in listed]}

    out = asyncio.run(main())
    assert out["lag0"]["pending"] == 2
    assert out["first"]["sent"] == 1 and out["first"]["failed"] == 1
    assert out["lag1"]["pending"] == 1 and out["lag1"]["gave_up"] == 1
    assert out["listed"] == [e for e in out["listed"] if e != "aud_bad"] and len(out["listed"]) == 1
