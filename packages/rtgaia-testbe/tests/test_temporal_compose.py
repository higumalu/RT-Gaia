"""檢視器裡把同一個病例的影像組成時間軸、拆回多張影像、攤開成每一幀一張影像。

用途：把左邊欄位多個相位的影像組成 4D 觀看；固定相位上畫的結構屬於那一相位；攤開／固定的狀態要記住。

答案來自合成測資（`synth4d`）：
* mr3：12 個時間點各一個序列、描述相同 → 預設**不**合併（12 張影像）→ 照 expected 的順序組成 → 一條 12 幀的時間軸，
  時間 ＝ expected 的 `frame_times_s`；同一個 `case_id`；組成前畫的結構原封不動（靜態）、組成後畫的只屬那一幀。
* ct6：拆開後 70% 那一幀的網格不同 → 組不進去（TA13）。
* ct1：資料頁自動合併、0%／50% 有各自的 RS → 拆開被擋（TA16，有只屬某一幀的結構）。
* ct3：自動合併、沒有 RS → 拆得開（跟資料頁取消「合併成時間軸」一樣）；攤開成 8 張固定幀的影像、收回。
* mr1：一個序列內分幀 → 攤開後每一張不帶整條時間軸的幀清單（推送大小跟幀數線性、每幀 < 2 KB）。
* mr10：cine 150 幀 → 攤開被擋（TA18），超過 `MAX_EXPANDED_FRAMES`。
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest
from rtgaia_core.case_temporal import MAX_EXPANDED_FRAMES
from rtgaia_core.library.index import LibraryIndex
from rtgaia_core.loaders.case import CaseSelection, assembly_key, select_all
from rtgaia_core.loaders.temporal import study_plans
from rtgaia_core.push import MAX_MESSAGE_BYTES
from rtgaia_testbe import Session
from rtgaia_testbe.fixtures import synth4d


@pytest.fixture(scope="module")
def data(tmp_path_factory: pytest.TempPathFactory) -> Path:
    root = tmp_path_factory.mktemp("v2c")
    synth4d.build(root, ["mr3", "ct6", "ct1", "ct3", "mr1", "mr10"])
    return root


def _expected(data: Path, cid: str) -> dict:
    return json.loads((data / cid / "expected.json").read_text(encoding="utf-8"))


def _selection(data: Path, cid: str, **overrides: str) -> dict:
    sel = select_all(LibraryIndex.scan(data / cid, use_cache=False))
    sel.temporal_overrides = dict(overrides)
    return sel.to_wire()


def _req(s: Session, method: str, path: str, body: dict | None = None):  # type: ignore[no-untyped-def]
    return s._client.request(method, path, json=body, headers=s._headers)


def _images(s: Session) -> list[dict]:
    return [layer for layer in s.state["layers"] if layer["kind"] == "image"]


def test_compose_dissolve_and_structures_follow(data: Path, tmp_path: Path, monkeypatch) -> None:  # type: ignore[no-untyped-def]
    monkeypatch.setenv("RTGAIA_DATA_DIR", str(tmp_path / "data"))
    exp = _expected(data, "mr3")
    order = exp["expected"]["groups"][0]["series_order"]
    with Session(library_root=str(data / "mr3"), user="dr") as s:
        out = s.load_case(_selection(data, "mr3"), webgl2=False, tier="C")
        case_id = out["case_id"]
        assert s.grid_set["temporal_groups"] == [] and len(_images(s)) == 12  # 預設不合併（信心不夠）
        # 組成前畫一個結構：FoR 的影像不是時間軸 → 靜態
        before = s._post(f"/api/v1/studies/{s.study_id}/structures", {"name": "Liver"})
        assert before["frame_index"] is None
        # 照 expected 的順序、以「時間」組成
        r = _req(s, "POST", f"/api/v1/studies/{s.study_id}/temporal-groups", {"series_uids": order, "axis": "time"})
        assert r.status_code == 200, r.text
        key = r.json()["temporal_group_id"]
        assert key == assembly_key(order) and key.startswith("tga_")
        (tg,) = s.grid_set["temporal_groups"]
        assert tg["temporal_group_id"] == key and tg["frame_count"] == 12 and tg["kind"] == "series"
        assert tg["frame_times"] == pytest.approx(exp["expected"]["groups"][0]["frame_times_s"])
        assert len(_images(s)) == 1 and _images(s)[0]["temporalGroupId"] == key
        assert s.state["caseId"] == case_id  # 同一個病例，原地重組
        listed = {e["name"]: e for e in s.structures()}
        assert (
            listed["Liver"]["structure_id"] == before["structure_id"] and listed["Liver"]["temporal_group_id"] is None
        )
        # 組成後新畫的只屬目前那一幀
        made = s._post(f"/api/v1/studies/{s.study_id}/structures", {"name": "Lesion", "frame_index": 4})
        assert made["frame_index"] == 4
        # 有只屬某一幀的結構 → 拆開被擋（409 TA16）
        r = _req(s, "DELETE", f"/api/v1/studies/{s.study_id}/temporal-groups/{key}")
        assert r.status_code == 409 and r.json()["detail"]["code"] == "TA16" and r.json()["detail"]["count"] == 1
        # 刪掉它就拆得開 → 回到 12 張影像，手動組成的那一條從選取拿掉
        assert _req(s, "DELETE", f"/api/v1/structures/{made['structure_id']}?frame_index=4").status_code == 204
        r = _req(s, "DELETE", f"/api/v1/studies/{s.study_id}/temporal-groups/{key}")
        assert r.status_code == 200, r.text
        assert s.grid_set["temporal_groups"] == [] and len(_images(s)) == 12
        assert s.state["caseId"] == case_id
        assert "Liver" in {e["name"] for e in s.structures()}


def test_compose_rules(data: Path, tmp_path: Path, monkeypatch) -> None:  # type: ignore[no-untyped-def]
    monkeypatch.setenv("RTGAIA_DATA_DIR", str(tmp_path / "data"))
    index = LibraryIndex.scan(data / "ct6", use_cache=False)
    (plan,) = study_plans(index.series.values())
    exp = _expected(data, "ct6")
    ex = {x["label"]: x["series"] for x in exp["expected"]["groups"][0]["excluded"]}
    with Session(library_root=str(data / "ct6"), user="dr") as s:
        s.load_case(_selection(data, "ct6", **{plan.key: "split"}), webgl2=False, tier="C")
        loaded = {layer["contentRef"] for layer in _images(s)}
        ok = [u for u in plan.frame_series_uids if u in loaded]  # 一致的相位（被排除的 30%／70% 不在候選的幀裡）
        assert len(ok) == 8 and ex["70%"] in loaded
        url = f"/api/v1/studies/{s.study_id}/temporal-groups"
        r = _req(s, "POST", url, {"series_uids": ok[:1]})
        assert r.status_code == 400 and r.json()["detail"]["code"] == "TA10"  # 至少兩張
        r = _req(s, "POST", url, {"series_uids": [ok[0], ex["70%"]]})
        assert r.status_code == 400 and r.json()["detail"]["code"] == "TA13"  # 網格不同（z 原點差 1.5 mm）
        r = _req(s, "POST", url, {"series_uids": [ok[0], "1.2.3.nope"]})
        assert r.status_code == 400 and r.json()["detail"]["code"] == "TA11"
        r = _req(s, "POST", url, {"series_uids": ok[:3], "labels": ["a", "b"]})
        assert r.status_code == 400 and r.json()["detail"]["code"] == "TA10"  # 名稱數量不對
        assert s.grid_set["temporal_groups"] == []  # 失敗不留半套
        grid_before = {fg["frame_of_reference_uid"]: fg["mask_grid_id"] for fg in s.grid_set["frame_groups"]}
        primary_before = next(fg["series_id"] for fg in s.grid_set["frame_groups"] if fg["role"] == "primary")
        r = _req(s, "POST", url, {"series_uids": ok[:3], "labels": ["0%", "10%", "20%"]})
        assert r.status_code == 200, r.text
        # 結構畫在 FoR 的 MaskGrid 上：組成後同一個（以前 primary 換成 4D 組 → 換網格 → I5／結構錯位）；primary 不變
        assert {fg["frame_of_reference_uid"]: fg["mask_grid_id"] for fg in s.grid_set["frame_groups"]} == grid_before
        assert next(fg["series_id"] for fg in s.grid_set["frame_groups"] if fg["role"] == "primary") == primary_before
        (tg,) = s.grid_set["temporal_groups"]
        assert tg["frame_labels"] == ["0%", "10%", "20%"] and tg["kind"] == "cyclic"
        # 已經在時間軸裡的不能再組
        r = _req(s, "POST", url, {"series_uids": [ok[0], ok[3]]})
        assert r.status_code == 400 and r.json()["detail"]["code"] == "TA11"


def test_dissolve_auto_group_and_expand(data: Path, tmp_path: Path, monkeypatch) -> None:  # type: ignore[no-untyped-def]
    monkeypatch.setenv("RTGAIA_DATA_DIR", str(tmp_path / "data"))
    with Session(library_root=str(data / "ct1"), user="dr") as s:
        s.load_case(_selection(data, "ct1"), webgl2=False, tier="C")
        (tg,) = s.grid_set["temporal_groups"]
        r = _req(s, "DELETE", f"/api/v1/studies/{s.study_id}/temporal-groups/{tg['temporal_group_id']}")
        assert r.status_code == 409 and r.json()["detail"]["code"] == "TA16"  # GTV 0%／50% 只屬那一幀
    with Session(library_root=str(data / "ct3"), user="dr") as s:
        s.load_case(_selection(data, "ct3"), webgl2=False, tier="C")
        (tg,) = s.grid_set["temporal_groups"]
        key = tg["temporal_group_id"]
        labels = tg["frame_labels"]
        # 攤開：每一幀一張影像（同一個序列、固定那一幀），第一幀顯示、其他隱藏
        r = _req(s, "POST", f"/api/v1/studies/{s.study_id}/temporal-groups/{key}/view", {"mode": "expanded"})
        assert r.status_code == 200, r.text
        frames = _images(s)
        assert [f["frameIndex"] for f in frames] == list(range(8)) and len({f["contentRef"] for f in frames}) == 1
        assert [f["visible"] for f in frames] == [True] + [False] * 7
        assert all(f["temporalGroupId"] == key for f in frames) and frames[3]["label"].endswith(labels[3])
        assert s.grid_set["temporal_groups"][0]["temporal_group_id"] == key  # 時間軸還在（結構跟著作用中的那一幀）
        r = _req(s, "POST", f"/api/v1/studies/{s.study_id}/temporal-groups/{key}/view", {"mode": "timeline"})
        assert r.status_code == 200 and len(_images(s)) == 1 and _images(s)[0].get("frameIndex") is None
        assert (
            _req(s, "POST", f"/api/v1/studies/{s.study_id}/temporal-groups/{key}/view", {"mode": "x"}).status_code
            == 400
        )
        # 自動合併、沒有只屬某一幀的結構 → 拆得開；跟資料頁取消「合併成時間軸」一樣（override split）
        r = _req(s, "DELETE", f"/api/v1/studies/{s.study_id}/temporal-groups/{key}")
        assert r.status_code == 200, r.text
        assert s.grid_set["temporal_groups"] == [] and len(_images(s)) == 8
        assert CaseSelection.from_wire(s.state.get("selection") or {}).temporal_overrides in ({}, {key: "split"})


def test_expand_stays_under_push_limit(data: Path, tmp_path: Path, monkeypatch) -> None:  # type: ignore[no-untyped-def]
    """2026-10-06 CCTH-A06（DCE 一個序列 62 幀）：每一張攤開的影像都帶一份整條時間軸的幀清單（5 KB）→
    scene.replace 385 KB 超過推送上限 → 按了沒反應、重新整理後連線推送也失敗、畫面整片黑。"""
    monkeypatch.setenv("RTGAIA_DATA_DIR", str(tmp_path / "data"))
    with Session(library_root=str(data / "mr1"), user="dr") as s:
        s.load_case(_selection(data, "mr1"), webgl2=False, tier="C")
        (tg,) = s.grid_set["temporal_groups"]
        assert "temporal" in (_images(s)[0].get("seriesMeta") or {})  # 收合時那一張照舊帶著（資料來源說明）
        view = f"/api/v1/studies/{s.study_id}/temporal-groups/{tg['temporal_group_id']}/view"
        r = _req(s, "POST", view, {"mode": "expanded"})
        assert r.status_code == 200, r.text
        frames = _images(s)
        assert len(frames) == tg["frame_count"] and len({f["contentRef"] for f in frames}) == 1
        assert all("temporal" not in (f.get("seriesMeta") or {}) for f in frames)
        per_frame = max(len(json.dumps(f, ensure_ascii=False).encode("utf-8")) for f in frames)
        assert per_frame < 2048 and per_frame * MAX_EXPANDED_FRAMES < MAX_MESSAGE_BYTES // 2, per_frame
    with Session(library_root=str(data / "mr10"), user="dr") as s:
        s.load_case(_selection(data, "mr10"), webgl2=False, tier="C")
        (tg,) = s.grid_set["temporal_groups"]
        assert tg["frame_count"] > MAX_EXPANDED_FRAMES
        view = f"/api/v1/studies/{s.study_id}/temporal-groups/{tg['temporal_group_id']}/view"
        r = _req(s, "POST", view, {"mode": "expanded"})
        assert r.status_code == 400 and r.json()["detail"]["code"] == "TA18", r.text
        assert r.json()["detail"]["count"] == tg["frame_count"] and len(_images(s)) == 1


def test_selection_wire_round_trip() -> None:
    sel = CaseSelection.from_wire(
        {
            "image_series_uids": ["a", "b", "c"],
            "temporal_assemblies": [
                {"series_uids": ["a", "b"], "labels": ["x", None], "axis": "time"},
                {"series_uids": ["a"]},  # 不到兩幀 → 丟掉
                {"series_uids": ["a", "a"]},  # 重複 → 丟掉
                {
                    "series_uids": ["b", "c"],
                    "labels": ["only one"],
                    "axis": "weird",
                },  # 名稱數不對 → 不帶名稱；軸 → phase
            ],
            "temporal_views": {"tg_x": "expanded", "tg_y": "bogus"},
        }
    )
    assert sel.temporal_assemblies == [
        {"series_uids": ["a", "b"], "labels": ["x", ""], "axis": "time"},
        {"series_uids": ["b", "c"], "labels": None, "axis": "phase"},
    ]
    assert sel.temporal_views == {"tg_x": "expanded"}
    assert CaseSelection.from_wire(sel.to_wire()).to_wire() == sel.to_wire()
    # 資料頁送的選取沒有這兩個欄位 → wire（也就是 selection hash 的輸入）跟以前一樣
    assert "temporal_assemblies" not in CaseSelection.from_wire({"image_series_uids": ["a"]}).to_wire()


@pytest.mark.db
def test_composed_case_survives_restart(data: Path, tmp_path: Path, monkeypatch) -> None:  # type: ignore[no-untyped-def]
    """組成之後重開（DB 重組）：同一個病例、時間軸還在、攤開的狀態還在、只屬某一幀的結構還在那一幀。"""
    import os

    db_url = os.environ.get("RTGAIA_TEST_DB_URL", "")
    if not db_url:
        pytest.skip("RTGAIA_TEST_DB_URL 未設")
    from rtgaia_server.db.migrate import downgrade_base, upgrade_to_head

    monkeypatch.setenv("RTGAIA_DATA_DIR", str(tmp_path / "data"))
    downgrade_base(db_url)
    upgrade_to_head(db_url)
    order = _expected(data, "mr3")["expected"]["groups"][0]["series_order"]
    sel = _selection(data, "mr3")
    with Session(library_root=str(data / "mr3"), db_url=db_url, auth="off", user="dr") as s:
        out = s.load_case(sel, webgl2=False, tier="C")
        key = _req(
            s, "POST", f"/api/v1/studies/{s.study_id}/temporal-groups", {"series_uids": order, "axis": "time"}
        ).json()["temporal_group_id"]
        s._post(f"/api/v1/studies/{s.study_id}/structures", {"name": "Lesion", "frame_index": 7})
        assert (
            _req(
                s, "POST", f"/api/v1/studies/{s.study_id}/temporal-groups/{key}/view", {"mode": "expanded"}
            ).status_code
            == 200
        )
    with Session(library_root=str(data / "mr3"), db_url=db_url, auth="off", user="dr") as s2:
        again = s2.load_case(sel, webgl2=False, tier="C")  # 資料頁同一組選取 → 回到組成後的這個病例
        assert again["case_id"] == out["case_id"]
        (tg,) = s2.grid_set["temporal_groups"]
        assert tg["temporal_group_id"] == key and tg["frame_count"] == 12
        assert len(_images(s2)) == 12 and all(f.get("frameIndex") is not None for f in _images(s2))  # 攤開的狀態記住
        lesion = next(e for e in s2.structures() if e["name"] == "Lesion")
        assert lesion["frames"] == [7] and lesion["temporal_group_id"] == key


def test_reassembly_keeps_the_same_case_object(data: Path, tmp_path: Path, monkeypatch) -> None:  # type: ignore[no-untyped-def]
    """重組以前換成一個新的 Case 物件、session 改指過去 —— 進行中的請求（合併、plugin 結果落地）
    手上拿的是舊物件，之後寫進去的東西就沒人看得到。現在原地換內容，物件不換。"""
    monkeypatch.setenv("RTGAIA_DATA_DIR", str(tmp_path / "data"))
    order = _expected(data, "mr3")["expected"]["groups"][0]["series_order"]
    with Session(library_root=str(data / "mr3"), user="dr") as s:
        s.load_case(_selection(data, "mr3"), webgl2=False, tier="C")
        rt = s._app.state.rtgaia
        held = rt.store.get(s.session_id).case  # 「進行中的請求」手上那一份
        r = _req(s, "POST", f"/api/v1/studies/{s.study_id}/temporal-groups", {"series_uids": order, "axis": "time"})
        assert r.status_code == 200, r.text
        assert rt.store.get(s.session_id).case is held
        assert [g.temporal_group_id for g in held.temporal_groups] == [r.json()["temporal_group_id"]]
        held.measurements["m_late"] = {"measurementId": "m_late", "kind": "distance"}  # 重組之後才寫進手上那一份
        assert "m_late" in rt.store.case(held.case_id).measurements
