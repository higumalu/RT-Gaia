"""真實 DICOM 的 4D／動態影像。

答案在合成測資的 `expected.json`（`rtgaia_testbe.fixtures.synth4d`，`test_synth4d.py` 保證測資本身是對的）：
* 分組（`loaders/temporal.py`）：每一組的幀數、順序、標籤、時間、軸、信心、衍生影像、排除的相位 ＝ 答案。
* 開病例：4D 組是一個時間軸 `DatasetSeries`、每一幀讀到的是那個相位的影像（腫瘤 z ＝ 真值）、
  畫在某相位上的 RS 只屬於那一幀、AVG 上的 ITV 是靜態、primary 是 4D 組、不一致的相位排除、
  低信心候選要使用者說合併才合併、高信心的也能拆。
* API：資料頁的列標出角色、新畫的結構只屬於目前那一幀、匯出 RS 引用那一幀的序列與切片。
"""

from __future__ import annotations

import io
import json
import time
from pathlib import Path

import numpy as np
import pydicom
import pytest
from rtgaia_core.library.index import LibraryIndex
from rtgaia_core.loaders.case import CaseSelection, build_case_dataset, select_all
from rtgaia_core.loaders.temporal import study_plans
from rtgaia_core.state import build_case
from rtgaia_geom import ContractViolation
from rtgaia_testbe import Session
from rtgaia_testbe.fixtures import synth4d

CLASSIC = ["ct1", "ct2", "ct3", "ct4", "ct6", "mr1", "mr2", "mr3", "mr4", "mr5", "mr6", "mr7", "mr9", "mr10"]
ENHANCED = ["ct5", "mr8"]


@pytest.fixture(scope="module")
def data(tmp_path_factory: pytest.TempPathFactory) -> Path:
    root = tmp_path_factory.mktemp("v2b")
    synth4d.build(root, CLASSIC + ENHANCED)
    return root


def _expected(data: Path, cid: str) -> dict:
    return json.loads((data / cid / "expected.json").read_text(encoding="utf-8"))


def _index(data: Path, cid: str) -> LibraryIndex:
    return LibraryIndex.scan(data / cid, use_cache=False)


def _open(data: Path, cid: str, **overrides: str):  # type: ignore[no-untyped-def]
    index = _index(data, cid)
    sel = select_all(index)
    sel.temporal_overrides = dict(overrides)
    ds = build_case_dataset(index, sel)
    return index, ds, build_case(dataset=ds)


@pytest.mark.parametrize("cid", CLASSIC)
def test_grouping_matches_expected(data: Path, cid: str) -> None:
    exp = _expected(data, cid)["expected"]
    want = exp["groups"] + exp.get("parameter_axes", [])
    plans = study_plans(_index(data, cid).series.values())
    assert len(plans) == len(want), [p.wire() for p in plans]
    for g, p in zip(want, plans, strict=True):
        w = p.wire()
        assert w["frame_count"] == g["frames"]
        assert w["kind"] == g["kind"]
        assert w["axis"] == g["axis"]
        if "series_order" in g:
            assert w["frame_series_uids"] == g["series_order"]
        if "confidence" in g:
            assert w["confidence"] == g["confidence"]
        if g.get("frame_labels") is not None:
            assert w["frame_labels"] == g["frame_labels"]
        if g.get("frame_times_s"):
            assert w["frame_times"] == pytest.approx(g["frame_times_s"], abs=1e-3)
        if "values" in g:  # 參數軸
            assert w["unit"] == g["unit"]
        assert sorted(x["label"] for x in w["excluded"]) == sorted(x["label"] for x in g.get("excluded", []))
    derived = sorted(
        d["op"].replace("mean", "avg").replace("max", "mip").replace("min", "minip")
        for d in exp.get("derived", [])
        if "series" in d and "subset" not in d
    )
    got = sorted(op for p in plans for _, op in p.derived)
    assert got == derived


def _tumor_z(volume: np.ndarray, ds_series) -> float:  # type: ignore[no-untyped-def]
    """腫瘤（右肺內 HU 30–60）的 z 重心；體積是 (k, j, i) 的 HU。"""
    g = ds_series.grid
    nk, nj, ni = volume.shape
    kk, jj, ii = np.meshgrid(np.arange(nk), np.arange(nj), np.arange(ni), indexing="ij")
    x = g.origin[0] + ii * g.spacing[0]
    y = g.origin[1] + jj * g.spacing[1]
    z = g.origin[2] + kk * g.spacing[2]
    t = synth4d.TUMOR_REST_LPS
    m = ((x - t[0]) ** 2 + (y - t[1]) ** 2 < 25**2) & (volume > 30) & (volume < 60)
    return float(z[m].mean())


def test_ct1_opens_as_one_timeline_with_frames_rs_and_dose(data: Path) -> None:
    exp = _expected(data, "ct1")
    _index_, ds, case = _open(data, "ct1")
    (tg,) = ds.temporal_groups
    assert tg.kind == "cyclic" and tg.frame_count == 10 and tg.frame_labels[5] == "50%"
    prim = ds.primary
    assert prim.temporal_group_id == tg.temporal_group_id
    assert list(prim.frame_series_uids) == exp["expected"]["groups"][0]["series_order"]
    truth = exp["truth"]["tumor_center_lps_per_frame"]
    for k in (0, 3, 5, 8):
        assert abs(_tumor_z(np.asarray(prim.image(prim.grid, k)), prim) - truth[k][2]) < 1.6
    # 衍生影像是同 FoR 的次要影像；RS：GTV 只在自己的相位、ITV（在 AVG）靜態
    others = {s.meta["series_description"] for s in ds.image_series if s.role == "secondary"}
    assert others == {"Average CT 3.0 Br40", "T-MIP 3.0 Br40", "T-MinIP 3.0 Br40"}
    frames = {}
    for (_sid, fi), st in case.structures.items():
        frames.setdefault(st.name, []).append(fi)
    assert frames == {"GTV_00": [0], "GTV_50": [5], "ITV": [None]}
    gtv50 = next(st for (sid, fi), st in case.structures.items() if st.name == "GTV_50")
    zc = (
        case.grid_for_frame(gtv50.frame_of_reference_uid).origin[2]
        + (gtv50.offset_ijk[2] + gtv50.size_ijk[2] / 2 - 0.5) * 3.0
    )
    assert abs(zc - truth[5][2]) < 3.1
    listed = {e["name"]: e for e in case.structure_list()}
    assert listed["GTV_50"]["frames"] == [5] and listed["ITV"]["frames"] is None
    assert [s.kind for s in ds.series].count("dose") == 1
    # 每一幀的切片 SOP 是那個相位的
    assert len(prim.frame_slice_sop_uids) == 10 and prim.frame_slice_sop_uids[5] != prim.frame_slice_sop_uids[0]


def test_ct2_primary_is_the_4d_group_and_each_phase_rs_is_its_frame(data: Path) -> None:
    _i, ds, case = _open(data, "ct2")
    assert ds.primary.temporal_group_id is not None  # 不是片數最多的 Non-Gated
    names = {st.name: fi for (sid, fi), st in case.structures.items()}
    assert names == {f"GTV_c{p:02d}": n for n, p in enumerate(range(0, 100, 10))}


def test_ct6_inconsistent_phases_are_excluded_with_warnings(data: Path) -> None:
    _i, ds, _case = _open(data, "ct6")
    (tg,) = ds.temporal_groups
    assert tg.frame_count == 8 and "30%" not in tg.frame_labels and "70%" not in tg.frame_labels
    warnings = " ".join(ds.notes["case"]["warnings"])
    assert "30%" in warnings and "70%" in warnings
    assert not any("Gated, 30.0%" in str(s.meta.get("series_description")) for s in ds.image_series)


def test_overrides_merge_low_confidence_and_split_high_confidence(data: Path) -> None:
    index = _index(data, "ct4")
    (plan,) = study_plans(index.series.values())
    _i, ds, _c = _open(data, "ct4")
    assert ds.temporal_groups == () and len(ds.image_series) == 10  # 低信心：預設不合併
    _i, ds, _c = _open(data, "ct4", **{plan.key: "merge"})
    assert ds.temporal_groups[0].frame_count == 10 and len(ds.image_series) == 1
    index1 = _index(data, "ct1")
    (p1,) = study_plans(index1.series.values())
    _i, ds, _c = _open(data, "ct1", **{p1.key: "split"})
    assert ds.temporal_groups == () and len(ds.image_series) == 13
    # 只選幾個相位 → 照樣成組，提示只選了幾幀
    sel = select_all(index1)
    sel.image_series_uids = [f.series_uid for f in p1.frames[:3]]
    ds = build_case_dataset(index1, sel)
    assert ds.temporal_groups[0].frame_count == 3
    assert any("3／10" in w for w in ds.notes["case"]["warnings"])
    assert CaseSelection.from_wire(
        {**sel.to_wire(), "temporal_overrides": {p1.key: "split", "x": "bad"}}
    ).temporal_overrides == {p1.key: "split"}


def test_mr_single_series_dynamics_open_with_times_and_parameter_axes(data: Path) -> None:
    exp = _expected(data, "mr1")
    _i, ds, _c = _open(data, "mr1")
    (tg,) = ds.temporal_groups
    assert tg.kind == "series" and list(tg.frame_times) == synth4d.DCE_TIMES_S
    prim = ds.primary
    g = synth4d.MR_GEOM
    i = round((synth4d.LESION_LPS[0] - g.origin[0]) / g.spacing[0])
    j = round((synth4d.LESION_LPS[1] - g.origin[1]) / g.spacing[1])
    k = round((synth4d.LESION_LPS[2] - g.origin[2]) / g.spacing[2])
    vals = [float(np.asarray(prim.image(prim.grid, f))[k, j - 1 : j + 2, i - 1 : i + 2].mean()) for f in range(12)]
    rel = [v / vals[0] - 1 for v in vals]
    assert rel == pytest.approx(exp["truth"]["lesion_relative_enhancement"], abs=0.06)
    _i, ds, _c = _open(data, "mr5")
    (tg,) = ds.temporal_groups
    assert (tg.axis_label, tg.unit, tg.frame_labels[1]) == ("echo_time", "ms", "TE 4.8 ms")
    _i, ds, _c = _open(data, "mr6")
    assert ds.temporal_groups[0].axis_label == "b_value"
    assert any("ADC" in w for w in ds.notes["case"]["warnings"])
    _i, ds, _c = _open(data, "mr7")
    assert ds.temporal_groups[0].frame_count == 6 and any("相位影像" in w for w in ds.notes["case"]["warnings"])
    _i, ds, _c = _open(data, "mr9")
    assert ds.temporal_groups[0].kind == "cyclic"
    _i, ds, _c = _open(data, "mr10")
    assert ds.temporal_groups[0].frame_count == 150 and ds.primary.grid.size[2] == 1


def test_enhanced_multiframe_ct_and_mr_open_as_timelines(data: Path) -> None:
    """Enhanced 一個檔 → 每一幀一個虛擬切片；呼吸相位 % 當幀名、TemporalPositionTimeOffset 當時間。"""
    exp = _expected(data, "ct5")
    _i, ds, _c = _open(data, "ct5")
    (tg,) = ds.temporal_groups
    assert (tg.kind, tg.frame_count, tg.frame_labels[3]) == ("cyclic", 10, "30%")
    prim = ds.primary
    assert prim.grid.size == (128, 128, 40) and prim.grid.spacing == pytest.approx((3.5, 3.5, 3.0))
    truth = exp["truth"]["tumor_center_lps_per_frame"]
    for k in (0, 5, 7):
        vol = np.asarray(prim.image(prim.grid, k))
        assert abs(_tumor_z(vol, prim) - truth[k][2]) < 1.6
    assert int(np.asarray(prim.image(prim.grid, 0)).min()) == -1000  # Rescale 來自 Functional Group（-1024 ＋ 24）
    # 虛擬切片是 `檔案的 SOP UID#幀號`（匯出 RS 時拆成 Referenced Frame Number）
    assert len(prim.slice_sop_uids) == 40 and all("#" in u for u in prim.slice_sop_uids)
    assert len({u.partition("#")[0] for u in prim.slice_sop_uids}) == 1
    _i, ds, _c = _open(data, "mr8")
    (tg,) = ds.temporal_groups
    assert tg.kind == "series" and list(tg.frame_times) == synth4d.DCE_TIMES_S


def _rewrite_enhanced(src: Path, dst_dir: Path, *, keep: range | None = None, split_at: int | None = None) -> None:
    """把 ct5 的 Enhanced 檔改寫成：只留某些幀（靜態 3D）或拆成兩個 Concatenation 檔。"""
    from pydicom.sequence import Sequence
    from pydicom.uid import generate_uid

    ds = pydicom.dcmread(src)
    frames = ds.pixel_array
    per = list(ds.PerFrameFunctionalGroupsSequence)
    dst_dir.mkdir(parents=True, exist_ok=True)
    if keep is not None:
        ds.PerFrameFunctionalGroupsSequence = Sequence([per[i] for i in keep])
        ds.NumberOfFrames = len(keep)
        ds.PixelData = frames[list(keep)].tobytes()
        ds.SeriesInstanceUID = generate_uid()
        ds.SOPInstanceUID = generate_uid()
        ds.file_meta.MediaStorageSOPInstanceUID = ds.SOPInstanceUID
        ds.save_as(dst_dir / "ENH-static.dcm", enforce_file_format=True)
        return
    assert split_at is not None
    concat, source = generate_uid(), ds.SOPInstanceUID
    for n, (lo, hi) in enumerate(((0, split_at), (split_at, len(per))), start=1):
        part = pydicom.dcmread(src)
        part.PerFrameFunctionalGroupsSequence = Sequence(per[lo:hi])
        part.NumberOfFrames = hi - lo
        part.PixelData = frames[lo:hi].tobytes()
        part.SOPInstanceUID = generate_uid()
        part.file_meta.MediaStorageSOPInstanceUID = part.SOPInstanceUID
        part.ConcatenationUID = concat
        part.InConcatenationNumber = n
        part.InConcatenationTotalNumber = 2
        part.ConcatenationFrameOffsetNumber = lo
        part.SOPInstanceUIDOfConcatenationSource = source
        part.save_as(dst_dir / f"ENH-part{n}.dcm", enforce_file_format=True)


def test_enhanced_static_volume_and_concatenation(data: Path, tmp_path: Path) -> None:
    src = next((data / "ct5").rglob("ENH.dcm"))
    _rewrite_enhanced(src, tmp_path / "static", keep=range(50, 90))  # 第 2 個相位的 40 片
    index = LibraryIndex.scan(tmp_path / "static", use_cache=False)
    ds = build_case_dataset(index, select_all(index))
    assert ds.temporal_groups == () and ds.primary.grid.size == (128, 128, 40)  # 以前 DL6 打不開
    # Concatenation：拆在 210（相位 5 的中間）→ 照樣是 10 個相位、跟一個檔的一樣
    _rewrite_enhanced(src, tmp_path / "concat", split_at=210)
    index = LibraryIndex.scan(tmp_path / "concat", use_cache=False)
    ds = build_case_dataset(index, select_all(index))
    (tg,) = ds.temporal_groups
    assert tg.frame_count == 10
    _i, whole, _c = _open(data, "ct5")
    for k in (4, 5, 6):
        a = np.asarray(ds.primary.image(ds.primary.grid, k))
        b = np.asarray(whole.primary.image(whole.primary.grid, k))
        assert np.array_equal(a, b)


def test_mixed_counts_per_position_is_a_clear_error(data: Path, tmp_path: Path) -> None:
    import shutil

    src = data / "mr4"
    dst = tmp_path / "mr4-broken"
    shutil.copytree(src, dst)
    next(iter(sorted((dst / "S003").glob("*.dcm")))).unlink()  # 一個位置少一個時間點
    index = LibraryIndex.scan(dst, use_cache=False)
    with pytest.raises(ContractViolation, match="TA1"):
        build_case_dataset(index, select_all(index))


def _wait(s: Session, job_id: str, timeout: float = 60.0) -> dict:
    deadline = time.time() + timeout
    while True:
        j = s._get(f"/api/v1/jobs/{job_id}")
        if j["status"] in ("done", "failed"):
            return j
        if time.time() > deadline:
            raise TimeoutError(j)
        time.sleep(0.05)


def test_api_catalog_roles_new_structure_on_current_frame_and_export_references_that_phase(
    data: Path, tmp_path: Path, monkeypatch
) -> None:  # type: ignore[no-untyped-def]
    monkeypatch.setenv("RTGAIA_DATA_DIR", str(tmp_path / "data"))
    exp = _expected(data, "ct1")
    order = exp["expected"]["groups"][0]["series_order"]
    index = _index(data, "ct1")
    with Session(library_root=str(data / "ct1"), user="dr") as s:
        cat = s.catalog_series(exp["study_instance_uid"])
        (cand,) = cat["temporal"]
        assert cand["auto"] and cand["frame_labels"][0] == "0%" and len(cand["derived"]) == 3
        roles = {r["series_instance_uid"]: r.get("temporal") for r in cat["images"]}
        assert roles[order[4]] == {"key": cand["key"], "role": "frame", "index": 4, "label": "40%"}
        sel = select_all(index).to_wire()
        out = s.load_case(sel, webgl2=False, tier="C")
        tgs = out["scene"]["grid_set"]["temporal_groups"] if "grid_set" in out["scene"] else None
        if tgs is not None:
            assert tgs[0]["frame_labels"][5] == "50%"
        # 新結構只屬於目前那一幀（3 ＝ 30%）
        made = s._post(f"/api/v1/studies/{s.study_id}/structures", {"name": "GTV_new", "frame_index": 3})
        assert made["frame_index"] == 3
        listed = {e["name"]: e for e in s.structures()}
        assert listed["GTV_new"]["frames"] == [3]
        # 匯出：引用 30% 那個序列的真實切片；GTV_50（別的相位）略過、ITV（靜態）一起出
        job = s._post(
            f"/api/v1/studies/{s.study_id}/export",
            {
                "format": "rtstruct",
                "structure_ids": [
                    made["structure_id"],
                    listed["GTV_50"]["structure_id"],
                    listed["ITV"]["structure_id"],
                ],
            },
        )
        done = _wait(s, job["job_id"])
        assert done["status"] == "done", done
        assert done["frame_index"] == 3 and done["referenced_series_uid"] == order[3]
        assert [x["reason"] for x in done["skipped"]] == ["not_in_frame"]
        rs = pydicom.dcmread(io.BytesIO(s._client.get(done["download_url"], headers=s._headers).content))
        ref = rs.ReferencedFrameOfReferenceSequence[0].RTReferencedStudySequence[0].RTReferencedSeriesSequence[0]
        assert ref.SeriesInstanceUID == order[3]
        phase30 = {i.sop_instance_uid for i in index.series[order[3]].instances}
        assert {c.ReferencedSOPInstanceUID for c in ref.ContourImageSequence} == phase30
        # 3D：GTV_00 只在 0% → 在 50% 那一幀出圖時略過它（以前整張 404 NOT_FOUND）
        camera = s.view_reference(view_plane_normal=(1.0, 0.0, 0.0), view_up=(0.0, 0.0, 1.0))
        gtv00 = listed["GTV_00"]["structure_id"]
        mesh = {"renderer": "mesh", "structure_id": gtv00, "color": [1, 0, 0], "opacity": 1.0}
        _h, png = s.render3d(output_size_px=(48, 48), layers=[{**mesh, "frame_index": 5}], camera=camera)
        assert png[:4] == b"\x89PNG"
