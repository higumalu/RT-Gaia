"""L0 `service.call`：把病例影像送到 DICOM 節點，等同 study 的 RT 物件回到我方
→ job done ＋ `service.received`。

對方以 `FakeNode` 假扮（收 C-STORE）；「回傳」以直接把 synth 的 RTSTRUCT 丟進匯入管線模擬
（真實情境是對方 C-STORE 到我方 SCP，接收端本來就走同一條匯入管線）。
"""

from __future__ import annotations

import asyncio
import shutil
import time
from pathlib import Path

import pytest
from rtgaia_testbe import Session
from synth_dicom import SynthCase, write_synth_case
from test_dimse import FakeNode, _wait_job
from test_jobs_audit import _selection


@pytest.fixture(scope="module")
def synth(tmp_path_factory) -> SynthCase:  # type: ignore[no-untyped-def]
    return write_synth_case(tmp_path_factory.mktemp("synth"))


@pytest.fixture
def fake(synth: SynthCase, tmp_path: Path) -> FakeNode:  # type: ignore[misc]
    node = FakeNode(sorted(synth.root.rglob("*.dcm")), tmp_path / "fake_received")
    yield node  # type: ignore[misc]
    node.stop()


def test_service_call_waits_for_returned_rtstruct(
    fake: FakeNode, synth: SynthCase, tmp_path: Path, monkeypatch
) -> None:  # type: ignore[no-untyped-def]
    monkeypatch.setenv("RTGAIA_DATA_DIR", str(tmp_path / "data"))
    monkeypatch.setenv("RTGAIA_PLUGIN_TICK_SECONDS", "0")
    with Session(library_root=str(synth.root), user="dr.a") as s:
        s.load_case(_selection(synth))
        node = s._post(
            "/api/v1/dimse/nodes", {"name": "AI box", "ae_title": fake.ae_title, "host": "127.0.0.1", "port": fake.port}
        )
        job = s._post(f"/api/v1/dimse/nodes/{node['node_id']}/service-call", {"study_id": s.study_id, "timeout_s": 120})
        assert job["status"] == "queued" and job["study_instance_uid"] == synth.plan_ct.study_uid
        assert synth.plan_ct.series_uid in job["series_uids"]
        # worker 送出後 job 停在 running（等回傳）
        deadline = time.time() + 30
        while time.time() < deadline:
            j = s._get(f"/api/v1/jobs/{job['job_id']}")
            if j["phase"] == "waiting-for-node":
                break
            time.sleep(0.1)
        assert j["status"] == "running" and j["phase"] == "waiting-for-node", j
        assert len(fake.received) >= synth.plan_ct.size[2]  # 影像真的送到對方了
        rt = s._app.state.rtgaia
        # 送出的子步驟以前被寫成一筆新的 queued 工作（`<id>-send`），worker 又送一次
        time.sleep(1.0)
        assert len(fake.received) == len(set(fake.received)), "每個 instance 只送一次"
        queue = asyncio.run_coroutine_threadsafe(rt.job_queue_async(), rt.loop).result(10)
        listed = asyncio.run_coroutine_threadsafe(queue.list(limit=200), rt.loop).result(10)
        assert [x.job_id for x in listed if x.job_id.startswith(job["job_id"])] == [job["job_id"]]
        # 模擬對方回傳：同 study 的 RTSTRUCT 進匯入管線
        staging = tmp_path / "returned"
        staging.mkdir()
        rs_files = [p for p in synth.root.rglob("*.dcm") if _modality(p) == "RTSTRUCT"]
        assert rs_files
        for p in rs_files[:1]:
            shutil.copy(p, staging / p.name)
        loop = rt.loop  # 走內部 enqueue（與接收端同路）
        fut = asyncio.run_coroutine_threadsafe(
            rt.enqueue_import(str(staging), source="dimse", detail={"calling_aet": fake.ae_title}), loop
        )
        imp_job = fut.result(timeout=10)
        done = _wait_job(s, imp_job.job_id)
        assert done["status"] == "done" and any(
            x["modality"] == "RTSTRUCT" and x["study_instance_uid"] == synth.plan_ct.study_uid for x in done["series"]
        )
        # tick → service.call 收工
        asyncio.run_coroutine_threadsafe(_tick(rt), loop).result(timeout=30)
        final = s._get(f"/api/v1/jobs/{job['job_id']}")
        assert final["status"] == "done", final
        assert (
            final["received"][0]["modality"] == "RTSTRUCT" and final["received"][0]["import_job_id"] == imp_job.job_id
        )
        assert "service.received" in [e["action"] for e in rt.audit_tail]


async def _tick(rt) -> None:  # type: ignore[no-untyped-def]
    pm = await rt.plugins_async()
    await pm.tick(force=True)


def _modality(path: Path) -> str:
    import pydicom

    return str(pydicom.dcmread(str(path), stop_before_pixels=True).get("Modality", ""))


def test_import_series_summary_counts_new_series(synth: SynthCase, tmp_path: Path, monkeypatch) -> None:  # type: ignore[no-untyped-def]
    """🔴 `series_summary` 原本比對 outcome "stored"（不存在），新匯入的序列永遠不在摘要裡 → L0 等不到回傳。"""
    monkeypatch.setenv("RTGAIA_DATA_DIR", str(tmp_path / "data"))
    empty_root = tmp_path / "lib"
    empty_root.mkdir()
    with Session(library_root=str(empty_root), user="dr.a") as s:
        staging = tmp_path / "in"
        staging.mkdir()
        rs = next(p for p in synth.root.rglob("*.dcm") if _modality(p) == "RTSTRUCT")
        shutil.copy(rs, staging / rs.name)
        rt = s._app.state.rtgaia
        job = asyncio.run_coroutine_threadsafe(
            rt.enqueue_import(str(staging), source="dimse", detail={}), rt.loop
        ).result(10)
        done = _wait_job(s, job.job_id)
        assert done["counts"]["accepted"] == 1
        assert done["series"] == [
            {
                "study_instance_uid": synth.plan_ct.study_uid,
                "series_instance_uid": pydicom_series_uid(rs),
                "modality": "RTSTRUCT",
                "count": 1,
            }
        ]


def pydicom_series_uid(path: Path) -> str:
    import pydicom

    return str(pydicom.dcmread(str(path), stop_before_pixels=True).SeriesInstanceUID)
