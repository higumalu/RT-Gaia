"""結構集分層：多套 RTSTRUCT 進同一個病例時，結構清單／圖層以來源結構集分群；
新建與複製的結構掛到指定（或預設）的結構集；DB 持久化後重載仍在。合成病例有兩套 RS（計畫 CT 的 `CT_20260601`、
CBCT 的 `ART_20260605`）。
"""

from __future__ import annotations

import os
from pathlib import Path

import numpy as np
import pytest
from rtgaia_testbe import Session
from synth_dicom import SynthCase, write_synth_case

DB_URL = os.environ.get("RTGAIA_TEST_DB_URL", "")


@pytest.fixture(scope="module")
def synth(tmp_path_factory) -> SynthCase:
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


def test_two_structure_sets_are_separate_groups(synth: SynthCase, tmp_path: Path, monkeypatch) -> None:  # type: ignore[no-untyped-def]
    monkeypatch.setenv("RTGAIA_DATA_DIR", str(tmp_path / "data"))
    with Session(library_root=str(synth.root), user="dr") as s:
        out = s.load_case(_selection(synth))
        sets = out["scene"]["structureSets"]
        assert [x["label"] for x in sets] == ["CT_20260601", "ART_20260605"]  # primary 的那套排前面
        assert [x["role"] for x in sets] == ["primary", "secondary"]
        assert sets[0]["structure_set_id"] == synth.plan_rs_uid and sets[1]["structure_set_id"] == synth.cbct_rs_uid
        assert sets[0]["image_series_uid"] == synth.plan_ct.series_uid and sets[0]["roi_count"] == 2
        assert sets[1]["frame_of_reference_uid"] == synth.cbct.frame_of_reference_uid
        # 每個結構都說自己屬於哪一套；同名 BODY 各在自己那套
        structures = s.structures()
        by_set: dict[str, list[str]] = {}
        for st in structures:
            by_set.setdefault(st["structure_set_id"], []).append(st["name"])
        assert set(by_set) == {synth.plan_rs_uid, synth.cbct_rs_uid}
        assert "BODY" in by_set[synth.plan_rs_uid] and "BODY" in by_set[synth.cbct_rs_uid]
        # 圖層群組 = rs:<set id>（整套一起開關）
        masks = [x for x in out["scene"]["layers"] if x["kind"] == "mask"]
        assert {x["groupId"] for x in masks} == {f"rs:{synth.plan_rs_uid}", f"rs:{synth.cbct_rs_uid}"}
        # 新建：一律進**我的工作集**（該 FoR，自動建）；指定匯入集 → 422；不存在 → 422
        created = s._post(f"/api/v1/studies/{s.study_id}/structures", {"name": "PTV_new", "color_rgb": [1, 2, 3]})
        my_plan = created["structure_set_id"]
        assert my_plan.startswith("work:dr:")
        sets = {x["structure_set_id"]: x for x in s.structure_sets()}
        assert sets[my_plan]["kind"] == "work" and sets[my_plan]["owner"] == "dr" and sets[my_plan]["mine"] is True
        assert sets[my_plan]["frame_of_reference_uid"] == synth.plan_ct.frame_of_reference_uid
        assert sets[synth.plan_rs_uid]["kind"] == "import" and sets[synth.plan_rs_uid]["editable"] is False
        created2 = s._post(
            f"/api/v1/studies/{s.study_id}/structures",
            {"name": "GTV_cbct", "color_rgb": [1, 2, 3], "frame_of_reference_uid": synth.cbct.frame_of_reference_uid},
        )
        my_cbct = created2["structure_set_id"]
        assert my_cbct.startswith("work:dr:") and my_cbct != my_plan
        with pytest.raises(RuntimeError, match="IMPORT_READ_ONLY"):
            s._post(
                f"/api/v1/studies/{s.study_id}/structures",
                {"name": "x", "color_rgb": [1, 2, 3], "structure_set_id": synth.cbct_rs_uid},
            )
        with pytest.raises(RuntimeError, match="422"):
            s._post(
                f"/api/v1/studies/{s.study_id}/structures",
                {"name": "x", "color_rgb": [1, 2, 3], "structure_set_id": "nope"},
            )
        # 複製：進我的工作集（來源可以是匯入集）
        copied = s._post(f"/api/v1/structures/{created2['structure_id']}/copy", {})
        listed = {st["structure_id"]: st for st in s.structures()}
        assert listed[copied["structure_id"]]["structure_set_id"] == my_cbct
        assert listed[created["structure_id"]]["structure_set_id"] == my_plan
        mask_layer = next(x for x in s.state["layers"] if x["contentRef"] == created["structure_id"])
        assert mask_layer["groupId"] == f"rs:{my_plan}"
        # 場景推送帶工作集
        assert {x["structure_set_id"] for x in s.state["structureSets"]} >= {my_plan, my_cbct}


def test_auto_created_work_set_is_pushed_before_the_structure(synth: SynthCase, tmp_path: Path, monkeypatch) -> None:  # type: ignore[no-untyped-def]
    """新建／複製時自動建了工作集 → 先推 `structure_sets.changed` 再推 `layer.add`；以前沒推，
    清單收到新結構時還不認得它的集，放進「其他（沒有來源結構集）」直到重新整理。工作集已經在就不再推。"""
    monkeypatch.setenv("RTGAIA_DATA_DIR", str(tmp_path / "data"))
    with Session(library_root=str(synth.root), user="dr") as s:
        s.load_case(_selection(synth))

        def pushed_since(n: int) -> list[str]:
            return [m["type"] for m in s.state["push_history_tail"]][-n:]

        s._post(f"/api/v1/studies/{s.study_id}/structures", {"name": "cord", "color_rgb": [1, 2, 3]})
        assert pushed_since(2) == ["structure_sets.changed", "layer.add"]
        second = s._post(f"/api/v1/studies/{s.study_id}/structures", {"name": "PTV", "color_rgb": [1, 2, 3]})
        assert pushed_since(2) == ["layer.add", "layer.add"]
        # 複製到另一組影像（CBCT）的工作集 —— 那一套還沒有 → 也要先推
        cbct_roi = next(st for st in s.structures() if st["structure_set_id"] == synth.cbct_rs_uid)
        s._post(f"/api/v1/structures/{cbct_roi['structure_id']}/copy", {})
        assert pushed_since(2) == ["structure_sets.changed", "layer.add"]
        s._post(f"/api/v1/structures/{second['structure_id']}/copy", {})
        assert pushed_since(1) == ["layer.add"]


def test_phantom_without_rtstruct_has_no_sets(monkeypatch, tmp_path: Path) -> None:  # type: ignore[no-untyped-def]
    monkeypatch.setenv("RTGAIA_DATA_DIR", str(tmp_path / "data"))
    with Session(user="qa") as s:
        out = s.load("phantom:overlap_set")
        assert out["scene"]["structureSets"] == []
        assert all(st["structure_set_id"] is None for st in s.structures())
        assert all(x["groupId"] == "structures" for x in out["scene"]["layers"] if x["kind"] == "mask")
        created = s._post(f"/api/v1/studies/{s.study_id}/structures", {"name": "N", "color_rgb": [1, 2, 3]})
        assert created["structure_set_id"] is None


@pytest.mark.db
def test_structure_set_survives_persistence(synth: SynthCase, tmp_path: Path, monkeypatch) -> None:  # type: ignore[no-untyped-def]
    if not DB_URL:
        pytest.skip("RTGAIA_TEST_DB_URL 未設")
    from rtgaia_server.db.migrate import downgrade_base, upgrade_to_head

    monkeypatch.setenv("RTGAIA_DATA_DIR", str(tmp_path / "data"))
    downgrade_base(DB_URL)
    upgrade_to_head(DB_URL)
    with Session(library_root=str(synth.root), db_url=DB_URL, auth="off", user="dr") as s:
        first = s.load_case(_selection(synth))
        created = s._post(
            f"/api/v1/studies/{s.study_id}/structures",
            {"name": "GTV_cbct", "color_rgb": [1, 2, 3], "frame_of_reference_uid": synth.cbct.frame_of_reference_uid},
        )
        my_cbct = created["structure_set_id"]
        assert my_cbct.startswith("work:dr:")
        s._post(f"/api/v1/studies/{s.study_id}/review", {"statuses": {}, "note": "touch"})
    with Session(library_root=str(synth.root), db_url=DB_URL, auth="off", user="dr") as s2:
        again = s2.load_case(_selection(synth))
        assert again["case_id"] == first["case_id"]
        labels = [x["label"] for x in again["scene"]["structureSets"]]
        assert labels[:2] == ["CT_20260601", "ART_20260605"] and "dr 的結構集" in labels  # 工作集持久化
        listed = {st["structure_id"]: st for st in s2.structures()}
        assert listed[created["structure_id"]]["structure_set_id"] == my_cbct
        assert listed["BODY"]["structure_set_id"] == synth.plan_rs_uid
    # 升級前存的結構（欄位全空）→ 重載時從 RS 補回歸屬；新建的（RS 裡沒有）維持 None
    import asyncio

    from sqlalchemy import text
    from sqlalchemy.ext.asyncio import create_async_engine

    async def null_out() -> None:
        engine = create_async_engine(DB_URL)
        async with engine.begin() as conn:
            await conn.execute(text("UPDATE structure SET structure_set_id = NULL"))
        await engine.dispose()

    asyncio.run(null_out())
    with Session(library_root=str(synth.root), db_url=DB_URL, auth="off", user="dr") as s3:
        s3.load_case(_selection(synth))
        listed = {st["structure_id"]: st for st in s3.structures()}
        assert listed["BODY"]["structure_set_id"] == synth.plan_rs_uid
        assert all(st["structure_set_id"] for sid, st in listed.items() if sid != created["structure_id"])
        assert listed[created["structure_id"]]["structure_set_id"] is None


def test_import_sets_are_read_only_and_merge_into_mine(synth: SynthCase, tmp_path: Path, monkeypatch) -> None:  # type: ignore[no-untyped-def]
    """匯入集唯讀 → 合併到我的集才可改；別人的工作集唯讀；同名三種處理；
    跨 FoR 擋；presence。"""
    monkeypatch.setenv("RTGAIA_DATA_DIR", str(tmp_path / "data"))
    with Session(library_root=str(synth.root), user="wang") as wang:
        wang._headers["X-RTGaia-Role"] = "contourer"
        wang.load_case(_selection(synth))
        body = next(
            st for st in wang.structures() if st["name"] == "BODY" and st["structure_set_id"] == synth.plan_rs_uid
        )
        assert body["editable"] is False and body["structure_set_kind"] == "import"
        # 直接改匯入集 → 403 IMPORT_READ_ONLY（帶集的名稱）
        with pytest.raises(RuntimeError, match="IMPORT_READ_ONLY") as exc:
            wang.edit(body["structure_id"], offset_ijk=(0, 0, 0), array=np.ones((2, 2, 2), dtype=np.uint8))
        assert "CT_20260601" in str(exc.value)
        for call in (
            lambda: wang.delete_structure(body["structure_id"]),
            lambda: wang.update_structure(body["structure_id"], name="X"),
            lambda: wang.postprocess(body["structure_id"], "fill_holes", per_slice=True),
        ):
            with pytest.raises(RuntimeError, match="403"):
                call()
        # 合併到我的集：新 id、kind=merge、note 指向來源；可改
        out = wang.merge_into_mine([body["structure_id"]])
        assert out["target"]["mine"] is True and out["target"]["owner"] == "wang"
        mine_body = out["merged"][0]["structure_id"]
        assert out["merged"][0]["action"] == "add" and mine_body != body["structure_id"]
        v = wang.versions(mine_body)["versions"]
        assert v[0]["kind"] == "merge" and "CT_20260601" in v[0]["note"] and v[0]["created_by"] == "wang"
        listed = {st["structure_id"]: st for st in wang.structures()}
        assert listed[mine_body]["editable"] is True and listed[mine_body]["structure_set_owner"] == "wang"
        edited = wang.edit(mine_body, offset_ijk=(0, 0, 0), array=np.ones((2, 2, 2), dtype=np.uint8))
        assert edited["version_id"]
        # 合併「已在我的集」的結構 → already
        again = wang.merge_into_mine([mine_body])
        assert again["merged"][0]["action"] == "already"
    with Session(library_root=str(synth.root), user="wang") as wang:
        wang._headers["X-RTGaia-Role"] = "contourer"
        wang.load_case(_selection(synth))
        body = next(
            st for st in wang.structures() if st["name"] == "BODY" and st["structure_set_id"] == synth.plan_rs_uid
        )
        ptv = next(
            st for st in wang.structures() if st["name"] == "PTV" and st["structure_set_id"] == synth.plan_rs_uid
        )
        mine_body = wang.claim(body["structure_id"])
        # 同名衝突：沒給決定 → 409 列出
        with pytest.raises(RuntimeError, match="NAME_CONFLICT") as exc:
            wang.merge_into_mine([body["structure_id"], ptv["structure_id"]])
        assert body["structure_id"] in str(exc.value) and mine_body in str(exc.value)
        # skip：BODY 跳過、PTV 新增
        out = wang.merge_into_mine(
            [body["structure_id"], ptv["structure_id"]], on_conflict={body["structure_id"]: "skip"}
        )
        actions = {m["source_structure_id"]: m["action"] for m in out["merged"]}
        assert actions == {body["structure_id"]: "skip", ptv["structure_id"]: "add"}
        # replace：我的 BODY 多一版（kind merge）、內容＝來源
        before = len(wang.versions(mine_body)["versions"])
        out = wang.merge_into_mine([body["structure_id"]], on_conflict={body["structure_id"]: "replace"})
        assert out["merged"][0] == {
            "source_structure_id": body["structure_id"],
            "action": "replace",
            "structure_id": mine_body,
        }
        v = wang.versions(mine_body)["versions"]
        assert len(v) == before + 1 and v[-1]["kind"] == "merge" and v[-1]["note"].endswith("（覆蓋）")
        assert wang.mask(mine_body)[0]["content_hash"] == wang.mask(body["structure_id"])[0]["content_hash"]
        # rename：BODY_2
        out = wang.merge_into_mine([body["structure_id"]], on_conflict={body["structure_id"]: "rename"})
        assert out["merged"][0]["action"] == "rename" and out["merged"][0]["name"] == "BODY_2"
        # 跨 FoR：計畫 CT 的 PTV ＋ CBCT 的 BODY → 422
        cbct_body = next(st for st in wang.structures() if st["structure_set_id"] == synth.cbct_rs_uid)
        with pytest.raises(RuntimeError, match="FOR_MISMATCH"):
            wang.merge_into_mine([ptv["structure_id"], cbct_body["structure_id"]])
        # 別人（contourer）不能改我的；admin 可以
        lin = Session(client=wang._client, user="lin")
        lin._headers["X-RTGaia-Role"] = "contourer"
        lin.load_case(_selection(synth))
        with pytest.raises(RuntimeError, match="NOT_OWNER") as exc:
            lin.edit(mine_body, offset_ijk=(0, 0, 0), array=np.ones((1, 1, 1), dtype=np.uint8))
        assert "wang" in str(exc.value)
        assert {st["structure_id"]: st["editable"] for st in lin.structures()}[mine_body] is False
        # lin 把 wang 的 BODY 合併進自己的集 → 可改
        lin_body = lin.claim(mine_body)
        assert lin.versions(lin_body)["versions"][0]["note"].startswith("合併自 wang 的結構集")
        lin.edit(lin_body, offset_ijk=(0, 0, 0), array=np.ones((1, 1, 1), dtype=np.uint8))
        boss = Session(client=wang._client, user="boss")  # 預設 admin
        boss.load_case(_selection(synth))
        boss.update_structure(mine_body, name="BODY_by_admin")
        # 結構集清單：兩個匯入、wang 與 lin 的工作集；改名只有擁有者／admin；匯入集不能改名
        sets = wang.structure_sets()
        assert [x["kind"] for x in sets].count("import") == 2 and {x["owner"] for x in sets if x["kind"] == "work"} == {
            "wang",
            "lin",
        }
        renamed = wang._unwrap(
            wang._client.patch(
                f"/api/v1/cases/{wang.case_id}/structure-sets/{out['target_structure_set_id']}",
                json={"label": "王醫師 ART 第 1 版"},
                headers=wang._headers,
            )
        )
        assert renamed["label"] == "王醫師 ART 第 1 版"
        with pytest.raises(RuntimeError, match="422"):
            wang._unwrap(
                wang._client.patch(
                    f"/api/v1/cases/{wang.case_id}/structure-sets/{synth.plan_rs_uid}",
                    json={"label": "x"},
                    headers=wang._headers,
                )
            )
        # presence：開病例／連線時推 `presence`（case 頻道）
        assert any(t["type"] == "presence" for t in wang.state["push_history_tail"])


@pytest.mark.db
def test_pre_upgrade_edited_import_structures_move_to_editor_work_set(
    synth: SynthCase, tmp_path: Path, monkeypatch
) -> None:  # type: ignore[no-untyped-def]
    """過渡：升級前直接在匯入集裡改過的結構（第二版以上）→ 重載時搬進改動者的工作集；沒改過的留在匯入集。"""
    if not DB_URL:
        pytest.skip("RTGAIA_TEST_DB_URL 未設")
    import asyncio

    from rtgaia_server.db.migrate import downgrade_base, upgrade_to_head
    from sqlalchemy import text
    from sqlalchemy.ext.asyncio import create_async_engine

    monkeypatch.setenv("RTGAIA_DATA_DIR", str(tmp_path / "data"))
    downgrade_base(DB_URL)
    upgrade_to_head(DB_URL)
    with Session(library_root=str(synth.root), db_url=DB_URL, auth="off", user="dr.old") as s:
        s.load_case(_selection(synth))
        body = next(st for st in s.structures() if st["name"] == "BODY" and st["structure_set_id"] == synth.plan_rs_uid)
        mine = s.claim(body["structure_id"])
        s.edit(mine, offset_ijk=(0, 0, 0), array=np.ones((2, 2, 2), dtype=np.uint8), client_seq=1)

    async def fake_old_data() -> None:
        # 模擬舊資料：改過的結構掛在匯入集、沒有工作集列
        engine = create_async_engine(DB_URL)
        async with engine.begin() as conn:
            await conn.execute(
                text("UPDATE structure SET structure_set_id = :rs WHERE structure_id = :sid"),
                {"rs": synth.plan_rs_uid, "sid": mine},
            )
            await conn.execute(text("DELETE FROM structure_set"))
        await engine.dispose()

    asyncio.run(fake_old_data())
    with Session(library_root=str(synth.root), db_url=DB_URL, auth="off", user="dr.new") as s2:
        s2.load_case(_selection(synth))
        listed = {st["structure_id"]: st for st in s2.structures()}
        moved = listed[mine]["structure_set_id"]
        assert moved.startswith("work:dr.old:") and listed[mine]["structure_set_owner"] == "dr.old"
        assert listed[body["structure_id"]]["structure_set_id"] == synth.plan_rs_uid  # 沒改過的留在匯入集
        assert any(x["structure_set_id"] == moved and x["kind"] == "work" for x in s2.structure_sets())


def test_merge_cannot_overwrite_a_signed_off_structure(synth: SynthCase, tmp_path: Path, monkeypatch) -> None:  # type: ignore[no-untyped-def]
    """合併選「覆蓋」不能蓋掉已簽核的結構 —— 以前會覆寫遮罩並把狀態改成 edited，等於不經 reopen 就撤銷簽核。
    衝突清單帶目標的簽核狀態（對話框據此停用「覆蓋」）；改名照常。"""
    monkeypatch.setenv("RTGAIA_DATA_DIR", str(tmp_path / "data"))
    with Session(library_root=str(synth.root), user="wang") as wang:
        wang.load_case(_selection(synth))
        body = next(
            st for st in wang.structures() if st["name"] == "BODY" and st["structure_set_id"] == synth.plan_rs_uid
        )
        mine_body = wang.claim(body["structure_id"])
        wang.review({mine_body: "approved"})
        versions = len(wang.versions(mine_body)["versions"])
        with pytest.raises(RuntimeError, match="NAME_CONFLICT") as exc:
            wang.merge_into_mine([body["structure_id"]])
        assert "'existing_status': 'approved'" in str(exc.value)
        with pytest.raises(RuntimeError, match="APPROVED_LOCKED"):
            wang.merge_into_mine([body["structure_id"]], on_conflict={body["structure_id"]: "replace"})
        mine = next(st for st in wang.structures() if st["structure_id"] == mine_body)
        assert mine["status"] == "approved" and len(wang.versions(mine_body)["versions"]) == versions
        out = wang.merge_into_mine([body["structure_id"]], on_conflict={body["structure_id"]: "rename"})
        assert out["merged"][0]["action"] == "rename" and out["merged"][0]["name"] == "BODY_2"
