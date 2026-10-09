"""病例狀態與工作清單：狀態從結構簽核、匯出紀錄、更新時間推出。"""

from __future__ import annotations

import os
from pathlib import Path

import numpy as np
import pytest
from rtgaia_core.worklist import case_status, counts_from_structures
from rtgaia_testbe import Session
from synth_dicom import PATIENT_ID, SynthCase, write_synth_case

DB_URL = os.environ.get("RTGAIA_TEST_DB_URL", "")


@pytest.fixture(scope="module")
def synth(tmp_path_factory) -> SynthCase:  # type: ignore[no-untyped-def]
    return write_synth_case(tmp_path_factory.mktemp("synth"))


def _selection(synth: SynthCase) -> dict:
    return {
        "primary_series_uid": synth.plan_ct.series_uid,
        "image_series_uids": [synth.plan_ct.series_uid],
        "structure_set_uids": [synth.plan_rs_uid],
        "dose_uids": [],
        "registration_uids": [],
        "plan_uids": [],
    }


def test_status_rules() -> None:
    k = dict(last_export_at=None, updated_at="2026-09-24T10:00:00")
    assert case_status(work_total=0, approved=0, under_review=0, **k) == "none"
    assert case_status(work_total=2, approved=0, under_review=0, **k) == "in_progress"
    assert case_status(work_total=2, approved=1, under_review=1, **k) == "review"
    assert case_status(work_total=2, approved=2, under_review=0, **k) == "approved"
    # 匯出在最後更新之後 → exported；匯出後又改 → 掉回原狀態
    assert (
        case_status(
            work_total=2,
            approved=1,
            under_review=0,
            last_export_at="2026-09-24T11:00:00",
            updated_at="2026-09-24T10:00:00",
        )
        == "exported"
    )
    assert (
        case_status(
            work_total=2,
            approved=1,
            under_review=0,
            last_export_at="2026-09-24T09:00:00",
            updated_at="2026-09-24T10:00:00",
        )
        == "in_progress"
    )
    c = counts_from_structures(
        [
            ("1.2.3.rs", "ai_generated"),
            ("work:dr:abc", "approved"),
            ("work:dr:abc:1f2e", "under_review"),
            ("transient:dr:x", "edited"),
        ]
    )
    assert c == {"work_total": 2, "approved": 1, "under_review": 1, "edited": 0, "rejected": 0, "import_total": 2}


def test_worklist_memory(synth: SynthCase, tmp_path: Path, monkeypatch) -> None:  # type: ignore[no-untyped-def]
    monkeypatch.setenv("RTGAIA_DATA_DIR", str(tmp_path / "data"))
    with Session(library_root=str(synth.root), user="dr") as s:
        s._headers["X-RTGaia-Role"] = "approver"
        out = s.load_case(_selection(synth))
        wl = s._unwrap(s._client.get("/api/v1/cases/worklist", headers=s._headers))
        me = next(e for e in wl if e["case_id"] == out["case_id"])
        assert me["status"] == "none" and me["counts"]["import_total"] >= 1 and me["open_users"] == ["dr"]
        assert me["selection"]["primary_series_uid"] == synth.plan_ct.series_uid
        made = s._post(f"/api/v1/studies/{s.study_id}/structures", {"name": "GTV", "color_rgb": [1, 2, 3]})
        s.edit(made["structure_id"], offset_ijk=(0, 0, 0), array=np.ones((1, 1, 1), dtype=np.uint8))
        wl = s._unwrap(s._client.get("/api/v1/cases/worklist", headers=s._headers))
        me = next(e for e in wl if e["case_id"] == out["case_id"])
        assert me["status"] == "in_progress" and me["counts"]["work_total"] == 1
        s._post(
            f"/api/v1/studies/{s.study_id}/review",
            {"structure_statuses": {made["structure_id"]: "under_review"}, "note": ""},
        )
        assert (
            next(
                e
                for e in s._unwrap(s._client.get("/api/v1/cases/worklist", headers=s._headers))
                if e["case_id"] == out["case_id"]
            )["status"]
            == "review"
        )
        s._post(
            f"/api/v1/studies/{s.study_id}/review",
            {"structure_statuses": {made["structure_id"]: "approved"}, "note": "ok"},
        )
        assert (
            next(
                e
                for e in s._unwrap(s._client.get("/api/v1/cases/worklist", headers=s._headers))
                if e["case_id"] == out["case_id"]
            )["status"]
            == "approved"
        )


@pytest.mark.db
def test_worklist_db_joins_study(synth: SynthCase, tmp_path: Path, monkeypatch) -> None:  # type: ignore[no-untyped-def]
    if not DB_URL:
        pytest.skip("RTGAIA_TEST_DB_URL 未設")
    from rtgaia_server.db.migrate import downgrade_base, upgrade_to_head

    monkeypatch.setenv("RTGAIA_DATA_DIR", str(tmp_path / "data"))
    downgrade_base(DB_URL)
    upgrade_to_head(DB_URL)
    with Session(library_root=str(synth.root), db_url=DB_URL, auth="off", user="dr") as s:
        out = s.load_case(_selection(synth))
        made = s._post(f"/api/v1/studies/{s.study_id}/structures", {"name": "GTV", "color_rgb": [1, 2, 3]})
        s.edit(made["structure_id"], offset_ijk=(0, 0, 0), array=np.ones((1, 1, 1), dtype=np.uint8))
        s._post(f"/api/v1/sessions/{out['session_id']}/release", {})  # 病例出記憶體 → 走 DB 路徑
        wl = s._unwrap(s._client.get("/api/v1/cases/worklist", headers=s._headers))
        me = next(e for e in wl if e["case_id"] == out["case_id"])
        assert me["status"] == "in_progress" and me["counts"]["work_total"] == 1 and me["open_users"] == []
        assert me["patient_id"] == PATIENT_ID and me["study_date"]


def test_reslice_outside_nan(synth: SynthCase, tmp_path: Path, monkeypatch) -> None:  # type: ignore[no-untyped-def]
    """hybrid 高品質重切帶 outside="nan" → 體積外是 NaN（前端當透明），不帶 → -1024。"""
    monkeypatch.setenv("RTGAIA_DATA_DIR", str(tmp_path / "data"))
    with Session(library_root=str(synth.root), user="dr") as s:
        s.load_case(_selection(synth))
        view = s.view_reference()
        # 平面拉得很大（px_mm 大）→ 一定有體積外的像素
        body = {
            "display_grid_id": s.display_grid_id,
            "view_reference": view,
            "output_size_px": [32, 32],
            "px_mm": 50.0,
            "interpolator": "linear",
        }
        _h, raw = s._post(f"/api/v1/studies/{s._study}/reslice", body)
        plane = np.frombuffer(raw, dtype=np.float32)
        assert plane.size == 32 * 32 and not np.isnan(plane).any() and (plane == -1024).any()
        _h2, raw2 = s._post(f"/api/v1/studies/{s._study}/reslice", {**body, "outside": "nan"})
        plane2 = np.frombuffer(raw2, dtype=np.float32)
        assert np.isnan(plane2).any() and not (plane2 == -1024).any()
        # 體積內的值兩次一樣
        inside = ~np.isnan(plane2)
        assert np.allclose(plane[inside], plane2[inside])


def test_review_event_records_viewer_tier(synth: SynthCase, tmp_path: Path, monkeypatch) -> None:  # type: ignore[no-untyped-def]
    """Tier C 允許簽核，簽核事件記下當時的 Tier。"""
    monkeypatch.setenv("RTGAIA_DATA_DIR", str(tmp_path / "data"))
    with Session(library_root=str(synth.root), user="dr") as s:
        s._headers["X-RTGaia-Role"] = "approver"
        s.load_case(_selection(synth))
        # 同一個人同一個選取再開一次、指定 Tier C（driver.load_case 的額外參數會進 client_capability，所以直接打）
        again = s._post("/api/v1/sessions", {**_selection(synth), "manual_tier": "C"})
        s._bind_session(again["session_id"])  # 舊的 session 被同一個人同一個 study 的新 session 取代
        s.study_id = again["study_id"]
        assert again["scene"]["tier"]["assigned_tier"] == "C"
        made = s._post(f"/api/v1/studies/{s.study_id}/structures", {"name": "GTV", "color_rgb": [1, 2, 3]})
        s.edit(made["structure_id"], offset_ijk=(0, 0, 0), array=np.ones((1, 1, 1), dtype=np.uint8))
        out = s._post(
            f"/api/v1/studies/{s.study_id}/review",
            {"structure_statuses": {made["structure_id"]: "approved"}, "note": "ok"},
        )
        assert out["events"] and out["events"][-1]["tier"] == "C"
        assert next(st for st in s.structures() if st["structure_id"] == made["structure_id"])["status"] == "approved"


def test_review_event_records_device(synth: SynthCase, tmp_path: Path, monkeypatch) -> None:  # type: ignore[no-untyped-def]
    """手機可以簽核；簽核事件記下裝置類型，不認識的值 422，舊前端不送就不記。"""
    monkeypatch.setenv("RTGAIA_DATA_DIR", str(tmp_path / "data"))
    with Session(library_root=str(synth.root), user="dr") as s:
        s._headers["X-RTGaia-Role"] = "approver"
        s.load_case(_selection(synth))
        made = s._post(f"/api/v1/studies/{s.study_id}/structures", {"name": "CTV", "color_rgb": [1, 2, 3]})
        sid = made["structure_id"]
        s.edit(sid, offset_ijk=(0, 0, 0), array=np.ones((1, 1, 1), dtype=np.uint8))
        bad = s._client.post(
            f"/api/v1/studies/{s.study_id}/review",
            json={"structure_statuses": {sid: "approved"}, "device": "watch"},
            headers=s._headers,
        )
        assert bad.status_code == 422 and bad.json()["detail"]["code"] == "BAD_DEVICE"
        # 422 之前什麼都沒改
        assert next(st for st in s.structures() if st["structure_id"] == sid)["status"] != "approved"
        out = s._post(
            f"/api/v1/studies/{s.study_id}/review",
            {"structure_statuses": {sid: "approved"}, "note": "phone", "device": "phone"},
        )
        assert out["events"][-1]["device"] == "phone"
        again = s._post(f"/api/v1/studies/{s.study_id}/review", {"structure_statuses": {sid: "under_review"}})
        assert "device" not in again["events"][-1]
        case = s._get(f"/api/v1/cases/{s.case_id}")
        events = case.get("review_events") or case.get("review_notes") or []
        assert [e.get("device") for e in events if e["structure_id"] == sid][-2:] == ["phone", None]
