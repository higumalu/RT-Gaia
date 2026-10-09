"""結構版本鏈、身分與時間欄位、簽核事件、端點不再依賴「當前 session」、export skipped。"""

from __future__ import annotations

import numpy as np
import pytest
from rtgaia_testbe import Session


def _ones(shape=(2, 2, 2)):  # type: ignore[no-untyped-def]
    return np.ones(shape, dtype=np.uint8)


def test_every_accepted_change_is_a_version_and_parent_hash_is_retrievable() -> None:
    with Session(user="dr.wang") as s:
        s.load("phantom:axial_clean")
        sid = s.structures()[0]["structure_id"]
        v0 = s.versions(sid)
        assert len(v0["versions"]) == 1 and v0["versions"][0]["kind"] == "initial"
        assert v0["head_version_id"] == v0["versions"][0]["version_id"]
        h0 = v0["content_hash"]
        original_header, original_raw = s.mask(sid)

        e1 = s.edit(sid, offset_ijk=(0, 0, 0), array=_ones(), client_seq=1)
        e2 = s.edit(sid, offset_ijk=(2, 2, 2), array=_ones(), client_seq=2)
        v = s.versions(sid)
        kinds = [x["kind"] for x in v["versions"]]
        assert kinds == ["initial", "edit", "edit"]
        assert v["head_version_id"] == e2["version_id"] and e2["version_count"] == 3
        # 鏈：每一版的 parent 是前一版；provenance.parent_hash 等於前一版的 content_hash
        vs = v["versions"]
        assert vs[1]["parent_version_id"] == vs[0]["version_id"] and vs[2]["parent_version_id"] == vs[1]["version_id"]
        assert vs[1]["provenance"]["parent_hash"] == h0
        assert vs[2]["provenance"]["parent_hash"] == e1["content_hash"]
        # 誰改的、什麼時候
        assert vs[1]["created_by"] == "dr.wang" and vs[1]["created_at"] and vs[1]["client_seq"] == 1
        assert v["updated_by"] == "dr.wang"
        # parent_hash 指向的內容**真的取得到**，且逐位元組等於當初的 mask
        header, raw = s.version_mask(sid, vs[0]["version_id"])
        assert header["content_hash"] == h0 and bytes(raw) == original_raw.tobytes()
        assert header["offset_ijk"] == original_header["offset_ijk"]


def test_postprocess_copy_and_revert_are_versions() -> None:
    with Session(user="tech.lin") as s:
        s.load("phantom:overlap_set")
        sid = "gtv"
        h0 = s.versions(sid)["content_hash"]
        s.edit(sid, offset_ijk=(0, 0, 0), array=_ones(), client_seq=1)
        pp = s.postprocess(sid, "fill_holes", per_slice=True)
        assert pp["version_id"]
        v = s.versions(sid)
        assert [x["kind"] for x in v["versions"]] == ["initial", "edit", "post-process"]
        assert v["versions"][2]["note"] == "fill_holes"

        # revert 到第一版：內容回到 h0，但**多一版**而不是刪歷史
        first = v["versions"][0]["version_id"]
        out = s.revert(sid, first, note="改錯了")
        assert out["content_hash"] == h0 and out["reverted_to"] == first and out["version_count"] == 4
        v2 = s.versions(sid)
        assert v2["versions"][-1]["kind"] == "revert" and v2["versions"][-1]["created_by"] == "tech.lin"
        assert v2["versions"][-1]["provenance"]["parent_hash"] == v["content_hash"]
        assert s.mask(sid)[0]["content_hash"] == h0
        with pytest.raises(RuntimeError, match="404"):
            s.revert(sid, "v_nope")

        # 複製：新結構的第一版 kind=copy、note 指向來源
        copied = s.copy_structure(sid)
        cv = s.versions(copied["structure_id"])
        assert cv["versions"][0]["kind"] == "copy" and sid in cv["versions"][0]["note"]
        assert cv["created_by"] == "tech.lin"


def test_review_events_record_who_when_from_to_and_delete() -> None:
    with Session(user="dr.chen") as s:
        s.load("phantom:overlap_set")
        out = s.review({"gtv": "approved", "ctv": "rejected"}, note="第一輪")
        assert len(out["events"]) == 2
        ev = {e["structure_id"]: e for e in out["events"]}
        assert ev["gtv"]["from_status"] == "ai_generated" and ev["gtv"]["to_status"] == "approved"
        assert ev["gtv"]["user"] == "dr.chen" and ev["gtv"]["at"] and ev["gtv"]["note"] == "第一輪"
        s.delete_structure("ctv")
        state = s.state
        events = state["review_events"]
        assert [e["to_status"] for e in events] == ["approved", "rejected", "deleted"]
        assert events[-1]["user"] == "dr.chen"
        # 事件記下當下的結構名稱：刪掉之後清單裡沒有它，畫面還叫得出名字（不是內部 id）
        names = {s_["structure_id"]: s_["name"] for s_ in s.structures()} | {"ctv": events[-1].get("structure_name")}
        assert all(e.get("structure_name") == names[e["structure_id"]] for e in events)
        assert events[-1]["structure_name"]
        # 舊名仍在（相容），指向同一個清單
        assert state["review_notes"] == events
        case = s._get("/api/v1/cases")[0]
        assert case["review_event_count"] == 3 and case["version_count"] >= 1


def test_endpoints_locate_case_without_relying_on_current(tmp_path) -> None:  # type: ignore[no-untyped-def]
    import sys

    sys.path.insert(0, str(__import__("pathlib").Path(__file__).parent))
    from synth_dicom import write_synth_case

    synth = write_synth_case(tmp_path / "synth")
    with Session(library_root=str(synth.root)) as s:
        first = s.load_case(
            {
                "primary_series_uid": synth.plan_ct.series_uid,
                "image_series_uids": [synth.plan_ct.series_uid, synth.cbct.series_uid],
                "structure_set_uids": [synth.plan_rs_uid],
                "dose_uids": [synth.plan_dose_uid],
                "registration_uids": [synth.reg_uid],
                "plan_uids": [synth.plan_uid],
            }
        )
        rs_structures = s.structures()
        ms = s.create_measurement(
            {
                "kind": "distance",
                "points": [0, 0, 0, 10, 0, 0],
                "frameOfReferenceUid": synth.plan_ct.frame_of_reference_uid,
                "label": "d",
            }
        )
        # 換一個病例當 current
        s.load("phantom:axial_clean")
        # DVH 仍找得到 synth 的劑量（不依賴 current）
        dvh = s._get(
            f"/api/v1/dose/{synth.plan_dose_uid}/dvh",
            structure_ids=rs_structures[0]["structure_id"],
            bins=20,
        )
        assert dvh["series_id"] == synth.plan_dose_uid and dvh["structures"]
        # 量測以 id 定位；清單以 study_id 定位。不帶 X-RTGaia-Session 的 client：在這個人自己的 session 裡找
        # （帶了就只看那一個 session —— driver 現在綁的是假體那個，見 test_session_scoping.py）
        s._headers.pop("X-RTGaia-Session")
        mid = ms["measurement"]["measurementId"]
        s.update_measurement(mid, {"label": "renamed"})
        listed = s._get("/api/v1/measurements", study_id=first["study_id"])
        assert [m["label"] for m in listed] == ["renamed"] and listed[0]["updatedBy"] == "anonymous"
        assert s._get("/api/v1/measurements") == []  # current（假體）沒有量測
        # transform 以 series 定位
        out = s.create_transform(
            fixed_series_id=synth.plan_ct.series_uid,
            moving_series_id=synth.cbct.series_uid,
            matrix_column_major=[float(v) for v in np.eye(4).T.ravel()],
        )
        assert out["transform_id"]
        assert s._get(f"/api/v1/cases/{first['case_id']}")["transforms"]


def test_export_reports_skipped_cross_frame_structures() -> None:
    with Session(user="qa") as s:
        s.load("phantom:two_series")
        structures = s.structures()
        fors = {st["frame_of_reference_uid"] for st in structures}
        assert len(fors) >= 2, "two_series 應有兩個 FoR 的結構"
        job = s._post(f"/api/v1/studies/{s.study_id}/export", {"format": "rtstruct"})
        import time

        for _ in range(100):
            info = s._get(f"/api/v1/jobs/{job['job_id']}")
            if info["status"] in ("done", "failed"):
                break
            time.sleep(0.05)
        assert info["status"] == "done" and info["requested_by"] == "qa"
        primary_for = s.primary_frame_of_reference_uid
        expected_skipped = {st["structure_id"] for st in structures if st["frame_of_reference_uid"] != primary_for}
        assert {x["structure_id"] for x in info["skipped"]} == expected_skipped
        assert all(x["reason"] == "not_in_target_frame" for x in info["skipped"])
        assert set(info["exported_versions"]) == {st["structure_id"] for st in structures} - expected_skipped


def test_approved_structure_is_read_only_until_reopened() -> None:
    """approved 對所有人唯讀 —— edit／postprocess／revert／改名改色都 409 APPROVED_LOCKED；reopen 後恢復。
    刪除是允許的（進封存區）。"""
    with Session(user="dr") as s:
        s.load("phantom:overlap_set")
        sid = "gtv"
        first = s.versions(sid)["versions"][0]["version_id"]
        s.review({sid: "approved"})
        with pytest.raises(RuntimeError, match="APPROVED_LOCKED"):
            s.edit(sid, offset_ijk=(0, 0, 0), array=_ones(), client_seq=1)
        with pytest.raises(RuntimeError, match="APPROVED_LOCKED"):
            s.postprocess(sid, "fill_holes", per_slice=True)
        with pytest.raises(RuntimeError, match="APPROVED_LOCKED"):
            s.revert(sid, first)
        # 名稱、顏色會進匯出的 RTSTRUCT：一樣鎖（以前 PATCH 不擋）
        with pytest.raises(RuntimeError, match="APPROVED_LOCKED"):
            s.update_structure(sid, name="GTV renamed")
        with pytest.raises(RuntimeError, match="APPROVED_LOCKED"):
            s.update_structure(sid, color_rgb=[1, 2, 3])
        out = s.review({sid: "under_review"}, note="reopen")
        assert out["events"][0]["from_status"] == "approved" and out["events"][0]["to_status"] == "under_review"
        assert s.edit(sid, offset_ijk=(0, 0, 0), array=_ones(), client_seq=2)["version_id"]
        assert s.update_structure(sid, name="GTV renamed")["name"] == "GTV renamed"
        # 刪除已簽核的結構是允許的（進封存區）
        s.review({sid: "approved"})
        s.delete_structure(sid)
        assert sid not in {st["structure_id"] for st in s.structures()}


def test_version_numbers_keep_counting_after_the_in_memory_list_is_trimmed() -> None:
    """版本號以前是記憶體列表裡的位置 —— 列表滿 200 版後，新版一律記成 199。"""
    from rtgaia_core.structure_state import MAX_VERSIONS_IN_MEMORY, StructureState
    from rtgaia_geom import Provenance

    st = StructureState(
        structure_id="s",
        name="S",
        color_rgb=(1, 2, 3),
        frame_of_reference_uid="1.2.3",
        offset_ijk=(0, 0, 0),
        size_ijk=(1, 1, 1),
        block=np.ones((1, 1, 1), dtype=np.uint8),
        content_hash="h0",
        provenance=Provenance(source="import", module_version="test", parent_hash=None),
    )
    extra = 50
    for n in range(MAX_VERSIONS_IN_MEMORY + extra):
        st._record_version(kind="edit", user="u", client_id=None, client_seq=n, note="")
    seqs = [v.seq for v in st.versions]
    assert len(seqs) == MAX_VERSIONS_IN_MEMORY
    assert seqs == sorted(set(seqs)), "嚴格遞增、不重複"
    assert seqs[0] == 0 and st.head.seq == MAX_VERSIONS_IN_MEMORY + extra
    st.revert_to(st.versions[0].version_id, user="u")
    assert st.head.seq == MAX_VERSIONS_IN_MEMORY + extra + 1
