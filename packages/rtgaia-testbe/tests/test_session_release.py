"""關閉病例：`POST /sessions/{id}/release` 釋放 session 與記憶體裡的病例，重載從 DB 重建。"""

from __future__ import annotations

import os
from pathlib import Path

import numpy as np
import pytest
from rtgaia_testbe import Session
from synth_dicom import SynthCase, write_synth_case

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


def test_release_without_db_keeps_case_but_drops_session(synth: SynthCase, tmp_path: Path, monkeypatch) -> None:  # type: ignore[no-untyped-def]
    monkeypatch.setenv("RTGAIA_DATA_DIR", str(tmp_path / "data"))
    with Session(library_root=str(synth.root), user="dr") as s:
        out = s.load_case(_selection(synth))
        health = s._unwrap(s._client.get("/healthz"))
        assert health["memory"]["cases_in_memory"] == 1 and health["memory"]["sessions"] == 1
        assert health["memory"].get("rss_bytes", 1) > 0
        # 別人不能釋放我的
        other = Session(client=s._client, user="x")
        other._headers["X-RTGaia-Role"] = "contourer"
        with pytest.raises(RuntimeError, match="NOT_OWNER"):
            other._unwrap(other._client.post(f"/api/v1/sessions/{out['session_id']}/release", headers=other._headers))
        rel = s._post(f"/api/v1/sessions/{out['session_id']}/release", {})
        assert rel["released"] == out["session_id"] and rel["case_id"] == out["case_id"]
        assert rel["selection"]["primary_series_uid"] == synth.plan_ct.series_uid
        assert rel["case_evicted"] is False  # 沒有 DB：病例留著（淘汰了就沒了）
        health = s._unwrap(s._client.get("/healthz"))
        assert health["memory"]["sessions"] == 0 and health["memory"]["cases_in_memory"] == 1
        with pytest.raises(RuntimeError, match="404"):
            s._post(f"/api/v1/sessions/{out['session_id']}/release", {})
        # 用回傳的 selection 重載 → 同一個病例（記憶體那份）
        again = s.load_case(rel["selection"])
        assert again["case_id"] == out["case_id"] and again["case_reused"] is True


@pytest.mark.db
def test_release_with_db_evicts_case_and_reload_rebuilds(synth: SynthCase, tmp_path: Path, monkeypatch) -> None:  # type: ignore[no-untyped-def]
    if not DB_URL:
        pytest.skip("RTGAIA_TEST_DB_URL 未設")
    from rtgaia_server.db.migrate import downgrade_base, upgrade_to_head

    monkeypatch.setenv("RTGAIA_DATA_DIR", str(tmp_path / "data"))
    downgrade_base(DB_URL)
    upgrade_to_head(DB_URL)
    with Session(library_root=str(synth.root), db_url=DB_URL, auth="off", user="dr") as s:
        out = s.load_case(_selection(synth))
        made = s._post(f"/api/v1/studies/{s.study_id}/structures", {"name": "GTV_keep", "color_rgb": [1, 2, 3]})
        s.edit(made["structure_id"], offset_ijk=(1, 1, 1), array=np.ones((2, 2, 2), dtype=np.uint8))
        rel = s._post(f"/api/v1/sessions/{out['session_id']}/release", {})
        assert rel["case_evicted"] is True
        health = s._unwrap(s._client.get("/healthz"))
        assert health["memory"]["cases_in_memory"] == 0 and health["memory"]["sessions"] == 0
        again = s.load_case(rel["selection"])
        assert again["case_id"] == out["case_id"] and again["case_reused"] is True
        listed = {st["structure_id"]: st for st in s.structures()}
        assert made["structure_id"] in listed and listed[made["structure_id"]]["status"] == "edited"
        _header, arr = s.mask(made["structure_id"])
        assert int(arr.sum()) == 8  # 體素從 DB 重建回來
