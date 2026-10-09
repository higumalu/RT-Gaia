"""網格跟第一幀不同的相位 —— 重新取樣補進時間軸（預設仍是排除＋警告；使用者可以改）。

答案來自合成測資 `synth4d` 的 ct6（ct2 的十個相位，但 30% 少一片、70% 的 z 位移 1.5 mm）：
* 預設：8 幀（30%、70% 排除）；時間軸列打開「重新取樣」→ 同一個病例、同一個 key、10 幀，順序照相位
  （被排除的相位不在選取裡也補得進來）；30%、70% 那一幀的腫瘤 z ＝ 真值（已取樣到第一幀的網格）；
  匯出引用：70%（位移半片）每一片對得到、30%（缺片）→ 合成參照。
* 已經畫好的結構依序列 UID 換幀號（60% 從第 6 幀變第 7 幀）；畫在補進來的那一幀上的結構 → 改回排除被擋
  （409 TA19，什麼都沒變）。
* 組成 4D：網格不同 → 400 TA13（缺片的那張自己開不起來 → TA11）；勾「重新取樣」→ 10 幀
  （開不起來的那張也逐片內插進來）。
"""

from __future__ import annotations

import json
from pathlib import Path

import numpy as np
import pytest
from rtgaia_core.library.index import LibraryIndex
from rtgaia_core.loaders.case import select_all
from rtgaia_testbe import Session
from rtgaia_testbe.fixtures import synth4d


@pytest.fixture(scope="module")
def data(tmp_path_factory: pytest.TempPathFactory) -> Path:
    root = tmp_path_factory.mktemp("b91")
    synth4d.build(root, ["ct6"])
    return root


def _req(s: Session, method: str, path: str, body: dict | None = None):  # type: ignore[no-untyped-def]
    return s._client.request(method, path, json=body, headers=s._headers)


def _case(s: Session):  # type: ignore[no-untyped-def]
    return s._app.state.rtgaia.store.get(s.session_id).case


def _tumor_z(volume: np.ndarray, grid) -> float:  # type: ignore[no-untyped-def]
    nk, nj, ni = volume.shape
    kk, jj, ii = np.meshgrid(np.arange(nk), np.arange(nj), np.arange(ni), indexing="ij")
    x = grid.origin[0] + ii * grid.spacing[0]
    y = grid.origin[1] + jj * grid.spacing[1]
    z = grid.origin[2] + kk * grid.spacing[2]
    t = synth4d.TUMOR_REST_LPS
    m = ((x - t[0]) ** 2 + (y - t[1]) ** 2 < 25**2) & (volume > 30) & (volume < 60)
    return float(z[m].mean())


def _frames(s: Session, name: str) -> list[int] | None:
    return next(e["frames"] for e in s.structures() if e["name"] == name)


def test_resample_inconsistent_phases(data: Path, tmp_path: Path, monkeypatch) -> None:  # type: ignore[no-untyped-def]
    monkeypatch.setenv("RTGAIA_DATA_DIR", str(tmp_path / "data"))
    truth = json.loads((data / "ct6" / "expected.json").read_text(encoding="utf-8"))["truth"]
    centers = truth["tumor_center_lps_per_frame"]
    with Session(library_root=str(data / "ct6"), user="dr") as s:
        index = LibraryIndex.scan(data / "ct6", use_cache=False)
        sel = select_all(index)
        # 資料頁勾一組時被排除的相位不一定在選取裡（量測堆疊實際踩到：補不進來）→ 這裡故意拿掉
        skip = {
            e.series_instance_uid for e in index.image_series() if e.series_description.endswith(("30.0%", "70.0%"))
        }
        assert len(skip) == 2
        sel.image_series_uids = [u for u in sel.image_series_uids if u not in skip]
        out = s.load_case(sel.to_wire(), webgl2=False, tier="C")
        (tg,) = s.grid_set["temporal_groups"]
        key = tg["temporal_group_id"]
        assert tg["frame_count"] == 8 and "30%" not in tg["frame_labels"]
        # 60%（第 6 幀，index 5）上畫一個
        r = _req(s, "POST", f"/api/v1/studies/{s.study_id}/structures", {"name": "Lesion60", "frame_index": 5})
        assert r.status_code == 201, r.text
        url = f"/api/v1/studies/{s.study_id}/temporal-groups/{key}/resample"

        r = _req(s, "POST", url, {"enabled": True})
        assert r.status_code == 200, r.text
        assert r.json()["frame_count"] == 10
        (tg,) = s.grid_set["temporal_groups"]
        assert tg["temporal_group_id"] == key and s.state["caseId"] == out["case_id"]
        assert tg["frame_labels"] == [f"{p}%" for p in range(0, 100, 10)]
        assert _frames(s, "Lesion60") == [6]  # 依序列 UID 換幀號
        case = _case(s)
        prim = case.dataset.primary
        for k in (0, 3, 7, 9):
            vol = np.asarray(prim.image(prim.grid, k))
            assert vol.shape == (prim.grid.size[2], prim.grid.size[1], prim.grid.size[0])
            assert abs(_tumor_z(vol, prim.grid) - centers[k][2]) < 1.6, k
        assert len(prim.frame_slice_sop_uids[7]) == prim.grid.size[2]  # 位移半片：每一片對得到最近的
        assert prim.frame_slice_sop_uids[3] == ()  # 缺片：匯出改用合成參照
        meta = prim.meta["temporal"]
        assert meta["resample"] is True and {x["label"] for x in meta["resampled"]} == {"30%", "70%"}
        assert not any("30%" in w and "已排除" in w for w in case.dataset.notes["case"]["warnings"])

        # 畫在補進來的 30% 上 → 改回排除會讓它沒有幀可以掛 → 409、什麼都沒改
        r = _req(s, "POST", f"/api/v1/studies/{s.study_id}/structures", {"name": "Lesion30", "frame_index": 3})
        assert r.status_code == 201
        r = _req(s, "POST", url, {"enabled": False})
        assert r.status_code == 409 and r.json()["detail"]["code"] == "TA19", r.text
        assert s.grid_set["temporal_groups"][0]["frame_count"] == 10 and _frames(s, "Lesion30") == [3]
        sid30 = next(e["structure_id"] for e in s.structures() if e["name"] == "Lesion30")
        assert _req(s, "DELETE", f"/api/v1/structures/{sid30}").status_code == 204
        r = _req(s, "POST", url, {"enabled": False})
        assert r.status_code == 200 and r.json()["frame_count"] == 8
        assert _frames(s, "Lesion60") == [5]


def test_compose_with_different_grids_needs_resample(data: Path, tmp_path: Path, monkeypatch) -> None:  # type: ignore[no-untyped-def]
    monkeypatch.setenv("RTGAIA_DATA_DIR", str(tmp_path / "data"))
    index = LibraryIndex.scan(data / "ct6", use_cache=False)
    sel = select_all(index)
    with Session(library_root=str(data / "ct6"), user="dr") as s:
        s.load_case(sel.to_wire(), webgl2=False, tier="C")
        (tg,) = s.grid_set["temporal_groups"]
        assert (
            _req(s, "DELETE", f"/api/v1/studies/{s.study_id}/temporal-groups/{tg['temporal_group_id']}").status_code
            == 200
        )
        gated = sorted(
            (e for e in index.image_series() if "Gated" in e.series_description and "Non" not in e.series_description),
            key=lambda e: float(e.series_description.rsplit(",", 1)[-1].strip(" %")),
        )
        uids = [e.series_instance_uid for e in gated]
        assert len(uids) == 10
        base = f"/api/v1/studies/{s.study_id}/temporal-groups"
        r = _req(s, "POST", base, {"series_uids": uids, "axis": "phase"})
        # 沒勾重新取樣：30%（缺片）自己都開不起來 → TA11；70%（位移）網格不同 → TA13
        assert r.status_code == 400 and r.json()["detail"]["code"] in ("TA11", "TA13"), r.text
        no30 = [u for n, u in enumerate(uids) if n != 3]
        r = _req(s, "POST", base, {"series_uids": no30, "axis": "phase"})
        assert r.status_code == 400 and r.json()["detail"]["code"] == "TA13", r.text
        r = _req(s, "POST", base, {"series_uids": uids, "axis": "phase", "resample": True})
        assert r.status_code == 200, r.text
        new = next(g for g in s.grid_set["temporal_groups"] if g["temporal_group_id"] == r.json()["temporal_group_id"])
        assert new["frame_count"] == 10
