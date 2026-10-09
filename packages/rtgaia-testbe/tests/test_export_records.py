"""匯出紀錄 —— 每次下載 RTSTRUCT／存入資料庫／C-STORE 送出各一筆（成功與失敗都記），
可依病例／病人／人查；重送：送出紀錄同內容再送（可換節點）、RTSTRUCT 紀錄把當時那份檔案送出；`resend_of` 串起來。
記憶體版走完整流程（對方以 pynetdicom 假扮）；DB 版驗持久化與 migration 0019 從既有 job 回填。
"""

from __future__ import annotations

import os
import time
from pathlib import Path

import pytest
from rtgaia_core.export_records import record_from_job, resend_problem
from rtgaia_testbe import Session
from synth_dicom import SynthCase, write_synth_case
from test_dimse import FakeNode, _free_port

DB_URL = os.environ.get("RTGAIA_TEST_DB_URL", "")


@pytest.fixture(scope="module")
def synth(tmp_path_factory) -> SynthCase:  # type: ignore[no-untyped-def]
    return write_synth_case(tmp_path_factory.mktemp("synth"))


@pytest.fixture
def fake(synth: SynthCase, tmp_path: Path) -> FakeNode:  # type: ignore[misc]
    node = FakeNode(sorted(synth.root.rglob("*.dcm")), tmp_path / "fake_received")
    yield node  # type: ignore[misc]
    node.stop()


def _wait(s: Session, job_id: str, timeout: float = 60.0) -> dict:
    deadline = time.time() + timeout
    while True:
        j = s._get(f"/api/v1/jobs/{job_id}")
        if j["status"] in ("done", "failed"):
            time.sleep(0.1)  # 紀錄在 job 狀態寫回之後才寫
            return j
        if time.time() > deadline:
            raise TimeoutError(j)
        time.sleep(0.05)


def _selection(synth: SynthCase) -> dict:
    return {
        "primary_series_uid": synth.plan_ct.series_uid,
        "image_series_uids": [synth.plan_ct.series_uid],
        "structure_set_uids": [synth.plan_rs_uid],
        "dose_uids": [],
        "registration_uids": [],
        "plan_uids": [],
    }


def test_record_from_job_shapes() -> None:
    """純函式：migration 回填吃的是 job 表的列（plain dict）。"""
    export = {
        "job_id": "job_a",
        "case_id": "c1",
        "kind": "export",
        "status": "done",
        "requested_by": "wang",
        "requested_at": "2026-09-24T01:00:00+00:00",
        "finished_at": "2026-09-24T01:00:03+00:00",
        "request": {"save_to_library": True},
        "result": {
            "result_uid": "1.2.3",
            "series_instance_uid": "1.2.4",
            "structure_set_label": "ART fx1",
            "exported_versions": {"s1": "v9"},
            "structure_count": 1,
            "bytes": 1234,
            "profile": "varian",
            "anonymized": False,
            "source_patient_id": "P1",
            "sha256": "ab" * 32,
        },
        "result_blob_key": "exports/job_a",
    }
    rec = record_from_job(export)
    assert rec is not None and rec.kind == "rtstruct" and rec.target == "library" and rec.patient_ids == ["P1"]
    assert rec.version_ids == {"s1": "v9"} and rec.sop_uids_out == ["1.2.3"] and rec.counts["bytes"] == 1234
    assert resend_problem(rec) is None and rec.to_wire()["download_url"] == "/api/v1/jobs/job_a/download"
    failed = record_from_job({**export, "status": "failed", "result": {}, "result_blob_key": None, "error": "x"})
    assert failed is not None and failed.error == "x" and resend_problem(failed) is not None
    assert failed.to_wire()["resendable"] is False and failed.to_wire()["download_url"] is None
    send = {
        "job_id": "job_b",
        "case_id": "",
        "kind": "send",
        "status": "done",
        "requested_by": "lin",
        "requested_at": "2026-09-24T02:00:00+00:00",
        "request": {"node_id": "n1", "study_uids": ["9.9"], "series_uids": []},
        "result": {"sent": 10, "failed": [{"path": "a"}], "total": 11, "series_count": 3, "patient_ids": ["P2"]},
    }
    rec2 = record_from_job(send)
    assert rec2 is not None and rec2.kind == "push" and rec2.target == "c-store" and rec2.node_id == "n1"
    assert rec2.counts == {"sent": 10, "failed": 1, "series_count": 3} and rec2.label == "3 個序列"
    assert rec2.resend_spec == {"study_uids": ["9.9"]} and resend_problem(rec2) is None
    # 不是匯出類、或還沒結束 → 不記
    assert record_from_job({**send, "kind": "import"}) is None
    assert record_from_job({**send, "status": "running"}) is None


def test_export_records_flow(fake: FakeNode, synth: SynthCase, tmp_path: Path, monkeypatch) -> None:  # type: ignore[no-untyped-def]
    monkeypatch.setenv("RTGAIA_DATA_DIR", str(tmp_path / "data"))
    with Session(library_root=str(synth.root), user="wang") as s:
        node = s._post(
            "/api/v1/dimse/nodes",
            {"name": "Eclipse", "ae_title": fake.ae_title, "host": "127.0.0.1", "port": fake.port},
        )
        nid = node["node_id"]
        other = s._post(
            "/api/v1/dimse/nodes", {"name": "PACS2", "ae_title": fake.ae_title, "host": "127.0.0.1", "port": fake.port}
        )
        dead = s._post(
            "/api/v1/dimse/nodes", {"name": "Dead", "ae_title": "NOBODY", "host": "127.0.0.1", "port": _free_port()}
        )
        s.load_case(_selection(synth))
        case_id = s._get("/api/v1/sessions/current")["caseId"]

        # 1) 下載 RTSTRUCT → 一筆 rtstruct／download，帶版本、SOP、hash、病人（匿名匯出也記得是誰的）
        export = _wait(s, s._post(f"/api/v1/studies/{s.study_id}/export", {"format": "rtstruct"})["job_id"])
        assert export["status"] == "done"
        rec = s._get(f"/api/v1/export-records/{export['job_id']}")
        assert rec["kind"] == "rtstruct" and rec["target"] == "download" and rec["status"] == "done"
        assert rec["case_id"] == case_id and rec["requested_by"] == "wang" and rec["anonymized"] is True
        assert rec["patient_ids"] == ["SYNTH-0001"] and rec["sop_uids_out"] == [export["result_uid"]]
        assert rec["version_ids"] == export["exported_versions"] and len(rec["blob_sha256"]) == 64
        assert rec["download_url"] and rec["resendable"] is True and rec["label"] == export["structure_set_label"]

        # 2) 送出這份匯出檔 → push 紀錄，source_export_id 指回匯出
        push = _wait(
            s,
            s._post(f"/api/v1/dimse/nodes/{nid}/send", {"export_job_id": export["job_id"], "case_id": case_id})[
                "job_id"
            ],
        )
        assert push["status"] == "done" and push["sent"] == 1
        prec = s._get(f"/api/v1/export-records/{push['job_id']}")
        assert prec["kind"] == "push" and prec["source_export_id"] == export["job_id"] and prec["node_id"] == nid
        assert "Eclipse" in prec["node_label"] and prec["counts"]["sent"] == 1 and prec["patient_ids"] == ["SYNTH-0001"]

        # 3) 資料頁送一整個序列（沒有病例）→ push 紀錄，病人由目錄帶出
        series_push = _wait(
            s, s._post(f"/api/v1/dimse/nodes/{nid}/send", {"series_uids": [synth.plan_ct.series_uid]})["job_id"]
        )
        srec = s._get(f"/api/v1/export-records/{series_push['job_id']}")
        assert (
            srec["case_id"] == "" and srec["series_uids"] == [synth.plan_ct.series_uid] and srec["label"] == "1 個序列"
        )
        assert srec["patient_ids"] == ["SYNTH-0001"] and srec["counts"]["sent"] == synth.plan_ct.size[2]

        # 4) 送到打不到的節點 → 失敗也有紀錄（帶錯誤）；重試＝重送到可用的節點
        bad = _wait(
            s,
            s._post(f"/api/v1/dimse/nodes/{dead['node_id']}/send", {"series_uids": [synth.plan_ct.series_uid]})[
                "job_id"
            ],
        )
        assert bad["status"] == "failed"
        brec = s._get(f"/api/v1/export-records/{bad['job_id']}")
        assert brec["status"] == "failed" and brec["error"] and brec["resendable"] is True

        # 5) 重送：push 紀錄預設原節點；可換節點；RTSTRUCT 紀錄要指定節點、送的是當時那份檔
        before = len(fake.received)
        again = _wait(s, s._post(f"/api/v1/export-records/{series_push['job_id']}/resend")["job_id"])
        assert again["status"] == "done" and len(fake.received) - before == synth.plan_ct.size[2]
        arec = s._get(f"/api/v1/export-records/{again['job_id']}")
        assert arec["resend_of"] == series_push["job_id"] and arec["node_id"] == nid and arec["requested_by"] == "wang"
        retry = _wait(
            s, s._post(f"/api/v1/export-records/{bad['job_id']}/resend", {"node_id": other["node_id"]})["job_id"]
        )
        assert (
            retry["status"] == "done"
            and s._get(f"/api/v1/export-records/{retry['job_id']}")["node_id"] == other["node_id"]
        )
        with pytest.raises(RuntimeError, match="NODE_REQUIRED"):
            s._post(f"/api/v1/export-records/{export['job_id']}/resend")
        rs = _wait(s, s._post(f"/api/v1/export-records/{export['job_id']}/resend", {"node_id": nid})["job_id"])
        rsrec = s._get(f"/api/v1/export-records/{rs['job_id']}")
        assert (
            rs["status"] == "done"
            and rsrec["source_export_id"] == export["job_id"]
            and rsrec["resend_of"] == export["job_id"]
        )
        with pytest.raises(RuntimeError, match="404"):
            s._post("/api/v1/export-records/job_nope/resend", {"node_id": nid})
        with pytest.raises(RuntimeError, match="404"):
            s._post(f"/api/v1/export-records/{export['job_id']}/resend", {"node_id": "node_nope"})

        # 6) 查詢：病例、病人、人、種類、狀態；新到舊
        allr = s._get("/api/v1/export-records")["items"]
        # 匯出、送匯出檔、送序列、失敗、重送、重試、RTSTRUCT 重送 ＝ 7 筆；新到舊（同一秒內的順序不保證）
        assert len(allr) == 7 and [r["requested_at"] for r in allr] == sorted(
            (r["requested_at"] for r in allr), reverse=True
        )
        by_case = s._get("/api/v1/export-records", case_id=case_id)["items"]
        assert {r["export_id"] for r in by_case} == {export["job_id"], push["job_id"], rs["job_id"]}
        assert len(s._get("/api/v1/export-records", patient_id="SYNTH-0001")["items"]) == 7
        assert s._get("/api/v1/export-records", patient_id="NOBODY")["items"] == []
        assert len(s._get("/api/v1/export-records", kind="rtstruct")["items"]) == 1
        assert [r["export_id"] for r in s._get("/api/v1/export-records", status="failed")["items"]] == [bad["job_id"]]
        assert s._get("/api/v1/export-records", user="someone-else")["items"] == []
        with pytest.raises(RuntimeError, match="422"):
            s._get("/api/v1/export-records", kind="zip")


@pytest.mark.db
def test_export_records_persist_and_backfill(synth: SynthCase, tmp_path: Path, monkeypatch) -> None:  # type: ignore[no-untyped-def]
    if not DB_URL:
        pytest.skip("RTGAIA_TEST_DB_URL 未設")
    import asyncio

    import asyncpg
    from alembic import command
    from rtgaia_server.db.migrate import alembic_config, downgrade_base, upgrade_to_head

    monkeypatch.setenv("RTGAIA_DATA_DIR", str(tmp_path / "data"))
    downgrade_base(DB_URL)
    # 回填：升級前就有的 export／send job
    command.upgrade(alembic_config(DB_URL), "0018_user_password_policy")
    dsn = DB_URL.replace("postgresql+asyncpg://", "postgresql://")

    async def seed() -> None:
        c = await asyncpg.connect(dsn)
        await c.execute(
            "INSERT INTO job (job_id, case_id, kind, status, phase, percent, request, result, result_blob_key, "
            "requested_by, requested_at, attempts) VALUES "
            "('job_old1', 'c_old', 'export', 'done', 'done', 100, '{}', "
            '\'{"result_uid": "1.2.9", "structure_set_label": "OLD", "exported_versions": {"s1": "v1"}}\', '
            "'exports/job_old1', 'lin', '2026-09-01T00:00:00+00:00', 1), "
            "('job_old2', '', 'send', 'failed', 'failed', 0, '{\"node_id\": \"n9\", \"series_uids\": [\"1.2.8\"]}', "
            "'{}', NULL, 'lin', '2026-09-02T00:00:00+00:00', 1), "
            "('job_old3', 'c_old', 'import', 'done', 'done', 100, '{}', '{}', NULL, 'lin', "
            "'2026-09-03T00:00:00+00:00', 1)"
        )
        await c.close()

    asyncio.run(seed())
    upgrade_to_head(DB_URL)
    with Session(library_root=str(synth.root), db_url=DB_URL, auth="off", user="wang") as s:
        old = {r["export_id"]: r for r in s._get("/api/v1/export-records")["items"]}
        assert set(old) == {"job_old1", "job_old2"}
        assert old["job_old1"]["label"] == "OLD" and old["job_old1"]["version_ids"] == {"s1": "v1"}
        assert old["job_old2"]["status"] == "failed" and old["job_old2"]["resendable"] is True
        # 新匯出寫進 DB
        s.load_case(_selection(synth))
        export = _wait(s, s._post(f"/api/v1/studies/{s.study_id}/export", {"format": "rtstruct"})["job_id"])
        assert export["status"] == "done"
    # 新的 app（重啟）仍查得到，病人查詢走 JSONB
    with Session(library_root=str(synth.root), db_url=DB_URL, auth="off", user="wang") as s2:
        rows = s2._get("/api/v1/export-records", patient_id="SYNTH-0001")["items"]
        assert [r["export_id"] for r in rows] == [export["job_id"]] and rows[0]["blob_sha256"]
