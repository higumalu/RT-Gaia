"""檢視器進場的正式端點 `GET /sessions/current`。

背景：檢視器原本只認測試端點 `_test/state`；生產 app 不掛測試端點之後，正式配置的後端沒有任何一條路讓它拿到 session。
這裡用**正式** app（`rtgaia_server.app.create_app`，沒有 `_test/*`）驗：POST /sessions 之後 current 拿得到同一個場景。
"""

from __future__ import annotations

from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from rtgaia_server.app import create_app
from synth_dicom import SynthCase, write_synth_case


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


def test_production_app_serves_current_session(synth: SynthCase, tmp_path: Path, monkeypatch) -> None:  # type: ignore[no-untyped-def]
    monkeypatch.setenv("RTGAIA_DATA_DIR", str(tmp_path / "data"))
    monkeypatch.setenv("RTGAIA_TEST_API", "1")  # 正式 app 就算被設了也不掛
    app = create_app(auth="off", library_root=str(synth.root), db_url="")
    with TestClient(app) as c:
        assert c.get("/api/v1/_test/state").status_code == 404
        dr = {"X-RTGaia-User": "dr"}
        r = c.get("/api/v1/sessions/current", headers=dr)
        assert r.status_code == 404 and r.json()["detail"]["code"] == "NO_SESSION"
        made = c.post("/api/v1/sessions", json=_selection(synth), headers=dr)
        assert made.status_code == 201
        cur = c.get("/api/v1/sessions/current", headers=dr)
        assert cur.status_code == 200
        scene = cur.json()
        # 檢視器要的欄位一個都不能少（App.load 全部取自同一個回應）
        assert scene["sessionId"] == made.json()["session_id"]
        assert scene["caseId"] == made.json()["case_id"] and scene["studyId"] == made.json()["study_id"]
        assert scene["source"] == made.json()["source"]
        assert scene["gridSet"]["display_grid"]["display_grid_id"] and len(scene["layers"]) >= 2
        assert isinstance(scene["structureSets"], list) and scene["structures"]
        # 別人沒有自己的 session：auth off 退回全域 current（開發便利）；required 模式下見 test_auth
        assert c.get("/api/v1/sessions/current", headers={"X-RTGaia-User": "lin"}).status_code == 200
