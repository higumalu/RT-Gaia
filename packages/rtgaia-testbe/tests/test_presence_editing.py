"""presence「正在編輯哪個結構」。

* `PUT /sessions/{id}/editing {structure_id}` → `presence` 推送與 `GET /cases/{id}` 帶 `editing`；變了才推
* 結構要是我看得到的（不存在 → 404）；不存在的 session → 404；`null` 清掉
"""

from __future__ import annotations

from pathlib import Path

import pytest
from rtgaia_testbe import Session
from synth_dicom import SynthCase, write_synth_case


@pytest.fixture(scope="module")
def synth(tmp_path_factory) -> SynthCase:
    return write_synth_case(tmp_path_factory.mktemp("synth-presence"))


def _presence(s: Session) -> list[dict]:
    return [m for m in s.state["push_history_tail"] if m["type"] == "presence"]


def test_editing_is_reported_in_presence(synth: SynthCase, tmp_path: Path, monkeypatch) -> None:  # type: ignore[no-untyped-def]
    monkeypatch.setenv("RTGAIA_DATA_DIR", str(tmp_path / "data"))
    with Session(library_root=str(synth.root), user="wang") as s:
        s.load_case({"image_series_uids": [synth.plan_ct.series_uid], "structure_set_uids": [synth.plan_rs_uid]})
        sid = s._scene["sessionId"]
        st = s.structures()[0]["structure_id"]
        before = len(_presence(s))
        out = s._put(f"/api/v1/sessions/{sid}/editing", {"structure_id": st})
        assert out == {"session_id": sid, "editing": st, "changed": True}
        msgs = _presence(s)
        assert len(msgs) == before + 1
        (me,) = [u for u in msgs[-1]["payload"]["users"] if u["sessionId"] == sid]
        assert me["editing"] == st and me["user"] == "wang"
        case = s._get(f"/api/v1/cases/{s.case_id}")
        assert [p["editing"] for p in case["presence"] if p["session_id"] == sid] == [st]
        # 一樣 → 不再推
        assert s._put(f"/api/v1/sessions/{sid}/editing", {"structure_id": st})["changed"] is False
        assert len(_presence(s)) == before + 1
        # 清掉
        assert s._put(f"/api/v1/sessions/{sid}/editing", {"structure_id": None})["editing"] is None
        (me,) = [u for u in _presence(s)[-1]["payload"]["users"] if u["sessionId"] == sid]
        assert me["editing"] is None
        # 不存在的結構、不存在的 session、型別不對
        with pytest.raises(RuntimeError, match="404"):
            s._put(f"/api/v1/sessions/{sid}/editing", {"structure_id": "nope"})
        with pytest.raises(RuntimeError, match="404"):
            s._put("/api/v1/sessions/nope/editing", {"structure_id": None})
        with pytest.raises(RuntimeError, match="422"):
            s._put(f"/api/v1/sessions/{sid}/editing", {"structure_id": 3})
