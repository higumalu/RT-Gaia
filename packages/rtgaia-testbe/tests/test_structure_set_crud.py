"""結構集新增／刪除／編輯／搬移（一人一 FoR 可有多套、含簽核的拒刪）。"""

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
        "image_series_uids": [synth.plan_ct.series_uid, synth.cbct.series_uid],
        "structure_set_uids": [synth.plan_rs_uid, synth.cbct_rs_uid],
        "dose_uids": [],
        "registration_uids": [synth.reg_uid],
        "plan_uids": [],
    }


def _sets_url(s: Session) -> str:
    return f"/api/v1/cases/{s.case_id}/structure-sets"


def _delete(s: Session, set_id: str, **params: object) -> dict:
    return s._unwrap(s._client.delete(f"{_sets_url(s)}/{set_id}", headers=s._headers, params=params or None))


def _patch(s: Session, set_id: str, body: dict) -> dict:
    return s._unwrap(s._client.patch(f"{_sets_url(s)}/{set_id}", json=body, headers=s._headers))


def _new_structure(s: Session, name: str, set_id: str | None = None) -> dict:
    return s._post(
        f"/api/v1/studies/{s.study_id}/structures",
        {"name": name, "color_rgb": [1, 2, 3], **({"structure_set_id": set_id} if set_id else {})},
    )


def test_create_edit_move_delete(synth: SynthCase, tmp_path: Path, monkeypatch) -> None:  # type: ignore[no-untyped-def]
    monkeypatch.setenv("RTGAIA_DATA_DIR", str(tmp_path / "data"))
    with Session(library_root=str(synth.root), user="wang") as wang:
        wang._headers["X-RTGaia-Role"] = "approver"  # 非 admin、但能簽核
        wang.load_case(_selection(synth))
        # 新建：label 必填、同 label 409、FoR 不存在 422
        with pytest.raises(RuntimeError, match="422"):
            wang._post(_sets_url(wang), {"label": ""})
        made = wang._post(_sets_url(wang), {"label": "計畫 B", "description": "第二方案"})
        assert made["kind"] == "work" and made["owner"] == "wang" and made["mine"] and made["editable"]
        assert made["structure_set_id"].startswith("work:wang:") and made["description"] == "第二方案"
        assert made["frame_of_reference_uid"] == synth.plan_ct.frame_of_reference_uid
        with pytest.raises(RuntimeError, match="409"):
            wang._post(_sets_url(wang), {"label": "計畫 B"})
        with pytest.raises(RuntimeError, match="422"):
            wang._post(_sets_url(wang), {"label": "x", "frame_of_reference_uid": "1.2.3.nope"})
        set_b = made["structure_set_id"]
        assert set_b in {x["structure_set_id"] for x in wang.structure_sets()}
        # 預設工作集（mine）與新集並存：新建結構可以指定進新集
        gtv_b = _new_structure(wang, "GTV", set_b)
        assert gtv_b["structure_set_id"] == set_b
        ptv_mine = _new_structure(wang, "PTV")
        mine_id = ptv_mine["structure_set_id"]
        assert mine_id != set_b and mine_id.startswith("work:wang:")
        # 編輯：改描述、改名；什麼都沒給 422
        edited = _patch(wang, set_b, {"description": "改過的描述"})
        assert edited["description"] == "改過的描述" and edited["label"] == "計畫 B"
        assert _patch(wang, set_b, {"label": "計畫 B2"})["label"] == "計畫 B2"
        with pytest.raises(RuntimeError, match="422"):
            _patch(wang, set_b, {})
        # 搬：PTV 從 mine 搬進 B → 結構的集改了、版本鏈不動
        before = wang.versions(ptv_mine["structure_id"])["versions"]
        moved = wang._post(f"{_sets_url(wang)}/{set_b}/move", {"structure_ids": [ptv_mine["structure_id"]]})
        assert moved["moved"] == [ptv_mine["structure_id"]] and moved["target_structure_set_id"] == set_b
        listed = {st["structure_id"]: st for st in wang.structures()}
        assert listed[ptv_mine["structure_id"]]["structure_set_id"] == set_b
        assert wang.versions(ptv_mine["structure_id"])["versions"] == before
        # 同名衝突 409：mine 裡再建一個 GTV 搬進 B（B 已有 GTV）
        gtv_mine = _new_structure(wang, "GTV")
        with pytest.raises(RuntimeError, match="NAME_CONFLICT"):
            wang._post(f"{_sets_url(wang)}/{set_b}/move", {"structure_ids": [gtv_mine["structure_id"]]})
        # 匯入的結構不能搬（唯讀）
        imported = next(st for st in wang.structures() if st["structure_set_id"] == synth.plan_rs_uid)
        with pytest.raises(RuntimeError, match="IMPORT_READ_ONLY"):
            wang._post(f"{_sets_url(wang)}/{set_b}/move", {"structure_ids": [imported["structure_id"]]})
        # 別人：lin 不能改、不能搬、不能刪 wang 的集
        lin = Session(client=wang._client, user="lin")
        lin._headers["X-RTGaia-Role"] = "contourer"  # auth off 缺省 admin；這裡要一個非 admin
        lin.load_case(_selection(synth))
        with pytest.raises(RuntimeError, match="NOT_OWNER"):
            _patch(lin, set_b, {"label": "偷改"})
        with pytest.raises(RuntimeError, match="NOT_OWNER"):
            lin._post(f"{_sets_url(lin)}/mine/move", {"structure_ids": [gtv_b["structure_id"]]})
        with pytest.raises(RuntimeError, match="NOT_OWNER"):
            _delete(lin, set_b)
        # 刪：匯入集 422；含已簽核 409；admin force 才行
        with pytest.raises(RuntimeError, match="IMPORT_READ_ONLY"):
            _delete(wang, synth.plan_rs_uid)
        wang.edit(gtv_b["structure_id"], offset_ijk=(0, 0, 0), array=np.ones((1, 1, 1), dtype=np.uint8))
        wang._post(
            f"/api/v1/studies/{wang.study_id}/review",
            {"structure_statuses": {gtv_b["structure_id"]: "approved"}, "note": "ok"},
        )
        with pytest.raises(RuntimeError, match="SET_HAS_APPROVED"):
            _delete(wang, set_b)
        with pytest.raises(RuntimeError, match="SET_HAS_APPROVED"):
            _delete(wang, set_b, force=1)  # 非 admin 的 force 不算
        boss = Session(client=wang._client, user="boss")  # 預設 admin
        boss.load_case(_selection(synth))
        out = _delete(boss, set_b, force=1)
        assert set(out["removed_structure_ids"]) == {gtv_b["structure_id"], ptv_mine["structure_id"]}
        ids = {st["structure_id"] for st in wang.structures()}
        assert gtv_b["structure_id"] not in ids and ptv_mine["structure_id"] not in ids
        assert set_b not in {x["structure_set_id"] for x in wang.structure_sets()}
        deleted = next(
            e
            for e in wang.state["review_events"]
            if e["to_status"] == "deleted" and e["structure_id"] == gtv_b["structure_id"]
        )
        # 事件記下被刪結構的名稱（之後清單裡已經沒有它）；系統備註依請求語言（這裡沒帶 Accept-Language → 繁中）
        assert deleted["structure_name"] == "GTV" and deleted["note"].startswith("刪除結構集")
        # 沒有簽核的集：擁有者自己刪
        set_c = wang._post(_sets_url(wang), {"label": "C"})["structure_set_id"]
        _new_structure(wang, "X", set_c)
        assert len(_delete(wang, set_c)["removed_structure_ids"]) == 1
        # 刪不存在的 404
        with pytest.raises(RuntimeError, match="404"):
            _delete(wang, "work:nobody:deadbeef")


@pytest.mark.db
def test_structure_set_crud_persists(synth: SynthCase, tmp_path: Path, monkeypatch) -> None:  # type: ignore[no-untyped-def]
    if not DB_URL:
        pytest.skip("RTGAIA_TEST_DB_URL 未設")
    from rtgaia_server.db.migrate import downgrade_base, upgrade_to_head

    monkeypatch.setenv("RTGAIA_DATA_DIR", str(tmp_path / "data"))
    downgrade_base(DB_URL)
    upgrade_to_head(DB_URL)
    with Session(library_root=str(synth.root), db_url=DB_URL, auth="off", user="dr") as s:
        s.load_case(_selection(synth))
        keep = s._post(_sets_url(s), {"label": "留著", "description": "有描述"})
        gone = s._post(_sets_url(s), {"label": "會刪"})
        kept_st = _new_structure(s, "A", keep["structure_set_id"])
        _new_structure(s, "B", gone["structure_set_id"])
        _delete(s, gone["structure_set_id"])
        _patch(s, keep["structure_set_id"], {"description": "改了"})
    with Session(library_root=str(synth.root), db_url=DB_URL, auth="off", user="dr") as s2:
        again = s2.load_case(_selection(synth))
        sets = {x["structure_set_id"]: x for x in again["scene"]["structureSets"]}
        assert keep["structure_set_id"] in sets and sets[keep["structure_set_id"]]["description"] == "改了"
        assert gone["structure_set_id"] not in sets
        listed = {st["structure_id"]: st for st in s2.structures()}
        assert listed[kept_st["structure_id"]]["structure_set_id"] == keep["structure_set_id"]
        assert not any(st["name"] == "B" for st in listed.values())


def test_scene_structure_sets_carry_editable(synth: SynthCase, tmp_path: Path, monkeypatch) -> None:  # type: ignore[no-untyped-def]
    """2026-09-24：載入病例時（scene）結構集也要帶 mine／editable，否則檢視器重新整理後「編輯」選單不見。"""
    monkeypatch.setenv("RTGAIA_DATA_DIR", str(tmp_path / "data"))
    with Session(library_root=str(synth.root), user="wang") as wang:
        wang._headers["X-RTGaia-Role"] = "contourer"
        wang.load_case(_selection(synth))
        _new_structure(wang, "GTV")  # 建出 wang 的工作集
        lin = Session(client=wang._client, user="lin")
        lin._headers["X-RTGaia-Role"] = "contourer"
        out = lin.load_case(_selection(synth))
        sets = {s["structure_set_id"]: s for s in out["scene"]["structureSets"]}
        work = next(s for s in sets.values() if s["kind"] == "work" and s["owner"] == "wang")
        assert work["mine"] is False and work["editable"] is False and "structure_count" in work
        imported = sets[synth.plan_rs_uid]
        assert imported["editable"] is False and imported["mine"] is False
        again = wang.load_case(_selection(synth))
        mine = next(s for s in again["scene"]["structureSets"] if s["kind"] == "work" and s["owner"] == "wang")
        assert mine["mine"] is True and mine["editable"] is True and mine["structure_count"] == 1


def test_scene_says_whether_structure_sets_apply(synth: SynthCase, tmp_path: Path, monkeypatch) -> None:  # type: ignore[no-untyped-def]
    """回報的問題：只剩一套結構集時集名稱與編輯／刪除／只看都不見。前端原本用「至少有一套」推斷病例有沒有
    結構集，沒有 RS（或唯一那套是空的）時整個結構區與「＋ 新結構集」都消失 —— 現在 scene 直接帶 `usesStructureSets`。"""
    monkeypatch.setenv("RTGAIA_DATA_DIR", str(tmp_path / "data"))
    with Session(library_root=str(synth.root), user="wang") as wang:
        wang._headers["X-RTGaia-Role"] = "contourer"
        # 只有 CT、沒有 RS 的 library 病例：沒有任何集，但適用結構集規則（可以新建）
        bare = wang.load_case({**_selection(synth), "structure_set_uids": []})
        assert bare["scene"]["structureSets"] == [] and bare["scene"]["usesStructureSets"] is True
        assert wang._get("/api/v1/sessions/current")["usesStructureSets"] is True
    with Session(user="qa") as phantom:
        phantom.load("phantom:overlap_set")
        assert phantom._get("/api/v1/sessions/current")["usesStructureSets"] is False
