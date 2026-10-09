"""4D 的結構 —— 各相位的結構合成一個時間結構、複製到其他相位、ITV。

答案來自合成測資（`synth4d`）：
* ct2：每個相位一份 RS（`GTV_c00`…`GTV_c90`，各只在自己那一幀、匯入集唯讀）→ 合成一個 10 幀的時間結構（進我的工作集、
  每一幀內容 ＝ 來源那一幀）；幀重疊、靜態來源、不同時間軸都擋；ITV ＝ 各幀聯集（靜態、`ITV`），選幾幀就只聯那幾幀。
* ct1：布林運算的另一個結構（`GTV_50`）這一幀沒有 → 422 `OTHER_NOT_IN_FRAME`。
* ct1：`GTV_00` 只在第 0 幀、匯入唯讀 → 複製到其他相位被擋（403）；複製到我的集之後 → 補齊其他 9 幀、內容同第 0 幀；
  再按一次全部略過；`overwrite` 只蓋指定的幀；`ITV`（在 AVG 上）是靜態 → 不能複製到其他相位、不能當時間結構的來源。
"""

from __future__ import annotations

from pathlib import Path

import numpy as np
import pytest
from rtgaia_core.library.index import LibraryIndex
from rtgaia_core.loaders.case import select_all
from rtgaia_testbe import Session
from rtgaia_testbe.fixtures import synth4d


@pytest.fixture(scope="module")
def data(tmp_path_factory: pytest.TempPathFactory) -> Path:
    root = tmp_path_factory.mktemp("b90")
    synth4d.build(root, ["ct1", "ct2"])
    return root


def _open(s: Session, data: Path, cid: str) -> None:
    s.load_case(select_all(LibraryIndex.scan(data / cid, use_cache=False)).to_wire(), webgl2=False, tier="C")


def _req(s: Session, method: str, path: str, body: dict | None = None):  # type: ignore[no-untyped-def]
    return s._client.request(method, path, json=body, headers=s._headers)


def _ids_by_name(s: Session) -> dict[str, str]:
    return {e["name"]: e["structure_id"] for e in s.structures()}


def _case(s: Session):  # type: ignore[no-untyped-def]
    return s._app.state.rtgaia.store.get(s.session_id).case


def _dense(s: Session, sid: str, frame: int | None) -> np.ndarray:
    case = _case(s)
    st = case.structures[(sid, frame)]
    return st.dense(case.grid_for_frame(st.frame_of_reference_uid))


def test_merge_phase_structures_into_one_and_itv(data: Path, tmp_path: Path, monkeypatch) -> None:  # type: ignore[no-untyped-def]
    monkeypatch.setenv("RTGAIA_DATA_DIR", str(tmp_path / "data"))
    with Session(library_root=str(data / "ct2"), user="dr") as s:
        _open(s, data, "ct2")
        by_name = _ids_by_name(s)
        phases = [by_name[f"GTV_c{p:02d}"] for p in range(0, 100, 10)]
        merge, itv_url = (f"/api/v1/studies/{s.study_id}/structures/{x}" for x in ("merge-frames", "itv"))
        r = _req(s, "POST", merge, {"structure_ids": phases, "name": "GTV"})
        assert r.status_code == 201, r.text
        out = r.json()
        gtv = out["structure_id"]
        assert out["frames"] == list(range(10)) and out["sources"]["3"] == phases[3]
        listed = {e["structure_id"]: e for e in s.structures()}
        assert listed[gtv]["name"] == "GTV" and listed[gtv]["frames"] == list(range(10))
        assert listed[gtv]["structure_set_kind"] == "work"  # 進我的工作集；來源（匯入集）不動
        assert all(p in listed for p in phases)
        for f in (0, 4, 9):
            assert np.array_equal(_dense(s, gtv, f), _dense(s, phases[f], f))
        layer = next(x for x in s.state["layers"] if x["contentRef"] == gtv)
        assert layer["frames"] == list(range(10)) and layer["temporalGroupId"]
        # 第 4 幀的 mask 走一般的 API 讀得到
        r = _req(s, "GET", f"/api/v1/structures/{gtv}/mask?mask_grid={s.grid_set['mask_grid']['mask_grid_id']}&frame=4")
        assert r.status_code == 200

        # 幀重疊、只選一個
        r = _req(s, "POST", merge, {"structure_ids": [gtv, phases[2]]})
        assert r.status_code == 422 and r.json()["detail"]["code"] == "FRAME_OVERLAP"
        r = _req(s, "POST", merge, {"structure_ids": [phases[0]]})
        assert r.status_code == 422

        # ITV：全部相位的聯集（靜態、ITV）；只選 0%、50% 兩幀 → 只有那兩幀
        r = _req(s, "POST", itv_url, {"structure_ids": [gtv]})
        assert r.status_code == 201, r.text
        itv = r.json()["structure_id"]
        union = np.zeros_like(_dense(s, gtv, 0))
        for f in range(10):
            union |= _dense(s, gtv, f)
        assert np.array_equal(_dense(s, itv, None), union)
        listed = {e["structure_id"]: e for e in s.structures()}
        assert listed[itv]["frames"] is None and listed[itv]["name"] == "ITV"
        assert listed[itv]["volume_cc"] > max(listed[gtv]["volume_cc"])
        assert _case(s).structures[(itv, None)].interpreted_type == "ITV"
        r = _req(s, "POST", itv_url, {"structure_ids": phases, "frames": [0, 5], "name": "ITV_0_50"})
        assert r.status_code == 201, r.text
        two = r.json()
        assert sorted(two["sources"]) == sorted([f"{phases[0]}@0", f"{phases[5]}@5"])
        assert np.array_equal(_dense(s, two["structure_id"], None), _dense(s, gtv, 0) | _dense(s, gtv, 5))
        r = _req(s, "POST", itv_url, {"structure_ids": [phases[0]], "frames": [3]})
        assert r.status_code == 422 and r.json()["detail"]["code"] == "EMPTY"


def test_propagate_to_other_phases(data: Path, tmp_path: Path, monkeypatch) -> None:  # type: ignore[no-untyped-def]
    monkeypatch.setenv("RTGAIA_DATA_DIR", str(tmp_path / "data"))
    with Session(library_root=str(data / "ct1"), user="dr") as s:
        _open(s, data, "ct1")
        by_name = _ids_by_name(s)
        gtv00, itv = by_name["GTV_00"], by_name["ITV"]
        # 匯入集唯讀
        r = _req(s, "POST", f"/api/v1/structures/{gtv00}/propagate-frames", {"source_frame": 0})
        assert r.status_code == 403
        # 靜態結構：不需要、也不能當時間結構的來源
        r = _req(s, "POST", f"/api/v1/structures/{itv}/propagate-frames", {"source_frame": 0})
        assert r.status_code == 422 and r.json()["detail"]["code"] == "STATIC_STRUCTURE"
        r = _req(s, "POST", f"/api/v1/studies/{s.study_id}/structures/merge-frames", {"structure_ids": [gtv00, itv]})
        assert r.status_code == 422 and r.json()["detail"]["code"] == "STATIC_SOURCE"

        mine = _req(s, "POST", f"/api/v1/structures/{gtv00}/copy", {}).json()["structure_id"]
        r = _req(s, "POST", f"/api/v1/structures/{mine}/propagate-frames", {"source_frame": 5})
        assert r.status_code == 422 and r.json()["detail"]["code"] == "NOT_IN_FRAME"
        r = _req(s, "POST", f"/api/v1/structures/{mine}/propagate-frames", {"source_frame": 0})
        assert r.status_code == 200, r.text
        assert r.json()["added"] == list(range(1, 10)) and r.json()["replaced"] == []
        listed = {e["structure_id"]: e for e in s.structures()}
        assert listed[mine]["frames"] == list(range(10))
        for f in (1, 7):
            assert np.array_equal(_dense(s, mine, f), _dense(s, mine, 0))
        assert next(x for x in s.state["layers"] if x["contentRef"] == mine)["frames"] == list(range(10))
        versions = _req(s, "GET", f"/api/v1/structures/{mine}/versions?frame=7").json()
        assert "從第 1 幀複製" in str(versions)
        # 再按一次：全部已有 → 略過；overwrite 只蓋指定的幀
        r = _req(s, "POST", f"/api/v1/structures/{mine}/propagate-frames", {"source_frame": 0})
        assert r.json()["added"] == [] and r.json()["skipped"] == list(range(1, 10))
        case = _case(s)
        before = case.structures[(mine, 3)].content_hash
        grid = case.grid_for_frame(case.structures[(mine, 3)].frame_of_reference_uid)
        changed = _dense(s, mine, 3)
        changed[:] = 0
        case.structures[(mine, 3)].replace_dense(changed, case.structures[(mine, 3)].provenance)
        assert case.structures[(mine, 3)].content_hash != before
        r = _req(
            s,
            "POST",
            f"/api/v1/structures/{mine}/propagate-frames",
            {"source_frame": 0, "target_frames": [3], "overwrite": True},
        )
        assert r.json()["replaced"] == [3] and r.json()["added"] == []
        assert case.structures[(mine, 3)].content_hash == before
        assert grid is not None
        # 過期的 base_content_hash → 409
        r = _req(
            s,
            "POST",
            f"/api/v1/structures/{mine}/propagate-frames",
            {"source_frame": 0, "base_content_hash": "mh_stale"},
        )
        assert r.status_code == 409
        # 布林運算的另一個結構這一幀沒有 → 422 說清楚（以前 404）
        r = _req(
            s,
            "POST",
            f"/api/v1/structures/{mine}/postprocess",
            {
                "op": "boolean",
                "params": {"operation": "union", "other_structure_id": by_name["GTV_50"]},
                "frame_index": 0,
            },
        )
        assert r.status_code == 422 and r.json()["detail"]["code"] == "OTHER_NOT_IN_FRAME", r.text


def test_merged_structures_survive_restart(data: Path, tmp_path: Path, monkeypatch) -> None:  # type: ignore[no-untyped-def]
    """合成的時間結構（10 幀）、複製到其他相位補出來的幀、ITV（靜態）重開之後都還在、內容一樣。"""
    import os

    db_url = os.environ.get("RTGAIA_TEST_DB_URL", "")
    if not db_url:
        pytest.skip("RTGAIA_TEST_DB_URL 未設")
    from rtgaia_server.db.migrate import downgrade_base, upgrade_to_head

    monkeypatch.setenv("RTGAIA_DATA_DIR", str(tmp_path / "data"))
    downgrade_base(db_url)
    upgrade_to_head(db_url)
    sel = select_all(LibraryIndex.scan(data / "ct2", use_cache=False)).to_wire()
    with Session(library_root=str(data / "ct2"), db_url=db_url, auth="off", user="dr") as s:
        out = s.load_case(sel, webgl2=False, tier="C")
        by_name = _ids_by_name(s)
        phases = [by_name[f"GTV_c{p:02d}"] for p in range(0, 100, 10)]
        base = f"/api/v1/studies/{s.study_id}/structures"
        gtv = _req(s, "POST", f"{base}/merge-frames", {"structure_ids": phases[:5], "name": "GTV"}).json()[
            "structure_id"
        ]
        assert _req(s, "POST", f"/api/v1/structures/{gtv}/propagate-frames", {"source_frame": 4}).json()["added"] == [
            5,
            6,
            7,
            8,
            9,
        ]
        itv = _req(s, "POST", f"{base}/itv", {"structure_ids": phases}).json()["structure_id"]
        want = {(sid, f): _dense(s, sid, f) for sid, f in [(gtv, 0), (gtv, 4), (gtv, 8), (itv, None)]}
    with Session(library_root=str(data / "ct2"), db_url=db_url, auth="off", user="dr") as s2:
        again = s2.load_case(sel, webgl2=False, tier="C")
        assert again["case_id"] == out["case_id"]
        listed = {e["structure_id"]: e for e in s2.structures()}
        assert listed[gtv]["frames"] == list(range(10)) and listed[itv]["frames"] is None
        for (sid, f), dense in want.items():
            assert np.array_equal(_dense(s2, sid, f), dense), (sid, f)
