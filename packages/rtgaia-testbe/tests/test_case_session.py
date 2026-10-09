"""Case／Session 分家。

* `POST /grids` 重新協商只換 Session：結構的編輯、量測、transform 原地保留（不是抄欄位）
* `POST /sessions` 同一組選取 → 同一個 Case（編輯還在）、新的 session_id
* `_test/load` 同一個假體兩次 → 兩個不同的 Case（測試語意＝重置）
* `GET /cases`、`GET /cases/{id}`
"""

from __future__ import annotations

import numpy as np
import pytest
from rtgaia_testbe import Session
from synth_dicom import SynthCase, write_synth_case


@pytest.fixture(scope="module")
def synth(tmp_path_factory) -> SynthCase:
    return write_synth_case(tmp_path_factory.mktemp("synth"))


def _selection(synth: SynthCase) -> dict:
    return {
        "primary_series_uid": synth.plan_ct.series_uid,
        "image_series_uids": [synth.plan_ct.series_uid, synth.cbct.series_uid],
        "structure_set_uids": [synth.plan_rs_uid, synth.cbct_rs_uid],
        "dose_uids": [synth.plan_dose_uid],
        "registration_uids": [synth.reg_uid],
        "plan_uids": [synth.plan_uid],
    }


def test_renegotiation_keeps_case_state_in_place() -> None:
    with Session() as s:
        s.load("phantom:axial_clean")
        sid = s.structures()[0]["structure_id"]
        before = s.mask(sid)[0]["content_hash"]
        # 編輯一筆
        edited = s.edit(sid, offset_ijk=(0, 0, 0), array=np.ones((2, 2, 2), dtype=np.uint8))
        assert edited["content_hash"] != before
        s.push_measurement(kind="distance", points=[(0.0, 0.0, 0.0), (10.0, 0.0, 0.0)], label="d1")
        sessions_before = s._get("/api/v1/_test/sessions")
        case_id = sessions_before["sessions"][0]["case_id"]
        # 重新協商 Tier → 新的 display grid，同一個 session_id、同一個 case
        grids = s.grids(webgl2=False, tier="C")
        assert grids["session_id"] == sessions_before["current"]
        after = s._get("/api/v1/_test/sessions")
        assert after["sessions"][0]["case_id"] == case_id
        # 編輯與量測都還在，而且是同一個物件（不是抄出來的）
        assert s.mask(sid)[0]["content_hash"] == edited["content_hash"]
        assert len(s.measurements()) == 1
        case = s._get(f"/api/v1/cases/{case_id}")
        assert case["edited_count"] == 1 and case["measurement_count"] == 1 and case["sessions"] == 1


def test_same_selection_reuses_case_and_keeps_edits(synth: SynthCase) -> None:
    with Session(library_root=str(synth.root)) as s:
        first = s.load_case(_selection(synth))
        assert first["case_reused"] is False
        sid = s.claim(s.structures()[0]["structure_id"])
        edited = s.edit(sid, offset_ijk=(0, 0, 0), array=np.ones((2, 2, 2), dtype=np.uint8))
        second = s.load_case(_selection(synth))
        assert second["case_reused"] is True
        assert second["case_id"] == first["case_id"]
        assert second["session_id"] != first["session_id"]
        assert s.mask(sid)[0]["content_hash"] == edited["content_hash"], "同選取重開，編輯必須還在"
        # 選取不同（少一個 REG）→ 新 Case
        other = dict(_selection(synth), registration_uids=[])
        third = s.load_case(other)
        assert third["case_reused"] is False and third["case_id"] != first["case_id"]
        cases = s._get("/api/v1/cases")
        assert {c["case_id"] for c in cases} >= {first["case_id"], third["case_id"]}


def test_phantom_load_always_resets() -> None:
    with Session() as s:
        a = s.load("phantom:axial_clean")
        sid = s.structures()[0]["structure_id"]
        s.edit(sid, offset_ijk=(0, 0, 0), array=np.ones((2, 2, 2), dtype=np.uint8))
        edited_hash = s.mask(sid)[0]["content_hash"]
        b = s.load("phantom:axial_clean")
        assert b["session_id"] != a["session_id"]
        assert s.mask(sid)[0]["content_hash"] != edited_hash, "假體載入＝重置，編輯不該留下"
        sessions = s._get("/api/v1/_test/sessions")
        # 舊 session 與它的（不可重用的）Case 都被清掉
        assert len(sessions["sessions"]) == 1 and len(sessions["cases"]) == 1
        with pytest.raises(RuntimeError, match="404"):
            s._get("/api/v1/cases/case_nope")
