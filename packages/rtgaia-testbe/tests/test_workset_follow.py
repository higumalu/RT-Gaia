"""2026-09-18 工作集跟著影像走：同一組 CT、不同選取（多勾一套 RS）→ 新病例帶著我保存過的結構；舊病例不留過期副本。"""

from __future__ import annotations

import os
from pathlib import Path

import numpy as np
import pytest
from rtgaia_testbe import Session
from synth_dicom import SynthCase, write_synth_case
from test_jobs_audit import _selection

DB_URL = os.environ.get("RTGAIA_TEST_DB_URL", "")


@pytest.fixture(scope="module")
def synth(tmp_path_factory) -> SynthCase:  # type: ignore[no-untyped-def]
    return write_synth_case(tmp_path_factory.mktemp("synth"))


def _ct_only(synth: SynthCase) -> dict:
    return {"primary_series_uid": synth.plan_ct.series_uid, "image_series_uids": [synth.plan_ct.series_uid]}


def _run(s: Session, synth: SynthCase) -> None:
    a = s.load_case(_ct_only(synth))
    case_a = a["case_id"]
    made = s.create_structure("Liver_AI", color_rgb=(1, 2, 3)) if hasattr(s, "create_structure") else None
    sid = made["structure_id"] if isinstance(made, dict) else made
    s.edit(sid, offset_ijk=(0, 0, 0), array=np.ones((2, 2, 2), dtype=np.uint8), client_seq=1)
    assert next(e for e in s.structures() if e["structure_id"] == sid)["structure_set_kind"] == "work"
    # 換一個選取：多勾一套 RS → 新病例
    s2 = Session(base_url=s.base_url, user="dr.a") if s.base_url else s
    b = s2.load_case(_selection(synth))
    assert b["case_id"] != case_a and b["case_reused"] is False
    assert [m["structure_set_id"] for m in b["adopted_work_sets"]], "工作集要跟過來"
    mine = [e for e in s2.structures() if e["structure_set_kind"] == "work"]
    assert [e["structure_id"] for e in mine] == [sid] and mine[0]["editable"] is True
    h, arr = s2.mask(sid)
    assert int(arr.sum()) == 8  # 版本鏈與體素原樣
    # 舊病例不留副本
    old = s2._get(f"/api/v1/cases/{case_a}")
    assert sid not in [e["structure_id"] for e in old["structures"]]
    # 回到舊選取：跟回來
    s3 = Session(base_url=s.base_url, user="dr.a") if s.base_url else s
    c = s3.load_case(_ct_only(synth))
    assert c["case_id"] == case_a and [m["structure_set_id"] for m in c["adopted_work_sets"]]
    assert sid in [e["structure_id"] for e in s3.structures()]


def test_work_set_follows_image_in_memory(synth: SynthCase, tmp_path: Path, monkeypatch) -> None:  # type: ignore[no-untyped-def]
    monkeypatch.setenv("RTGAIA_DATA_DIR", str(tmp_path / "data"))
    with Session(library_root=str(synth.root), user="dr.a") as s:
        _run(s, synth)
        assert "workset.adopt" in [e["action"] for e in s._app.state.rtgaia.audit_tail]


@pytest.mark.db
def test_work_set_follows_image_with_db(synth: SynthCase, tmp_path: Path, monkeypatch) -> None:  # type: ignore[no-untyped-def]
    if not DB_URL:
        pytest.skip("RTGAIA_TEST_DB_URL 未設")
    from test_jobs_audit import downgrade_base, upgrade_to_head

    monkeypatch.setenv("RTGAIA_DATA_DIR", str(tmp_path / "data"))
    downgrade_base(DB_URL)
    upgrade_to_head(DB_URL)
    with Session(library_root=str(synth.root), db_url=DB_URL, auth="off", user="dr.a") as s:
        _run(s, synth)
