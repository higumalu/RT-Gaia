"""射束劑量（BEAM）合成計畫劑量。

測資：`rtgaia_testbe.fixtures.synth_beams`（3 個治療射束的 BEAM 劑量 ＋ 一個 SETUP 射束
＋ 它們整數相加的 PLAN 劑量 ＋ RTPLAN）。

* 齊全 → 合成結果逐點等於 PLAN 劑量；`DoseSummationType` 存成 PLAN、引用那份計畫；能再當運算元
* 缺一個射束、重複、多出不在 fraction group 的、計畫不在病例裡、沒寫射束 → 不能合成，說原因
* 射束劑量本身仍不能直接當運算元（說要先合成）
"""

from __future__ import annotations

import io
import shutil
import time
from pathlib import Path

import numpy as np
import pydicom
import pytest
from rtgaia_core import dose_ops
from rtgaia_core.library.index import LibraryIndex
from rtgaia_testbe import Session
from rtgaia_testbe.fixtures import synth_beams


@pytest.fixture(scope="module")
def beams(tmp_path_factory: pytest.TempPathFactory) -> Path:
    root = tmp_path_factory.mktemp("b102")
    synth_beams.build(root)
    return root / "beams1"


def _index(root: Path) -> LibraryIndex:
    return LibraryIndex.scan(root, use_cache=False)


def _selection(root: Path, *, plan: bool = True, drop: tuple[str, ...] = ()) -> dict:
    index = _index(root)
    ct = next(e for e in index.image_series())
    doses = [
        e.series_instance_uid
        for e in index.series.values()
        if e.modality == "RTDOSE" and not any(d in e.series_description for d in drop)
    ]
    plans = [e.series_instance_uid for e in index.series.values() if e.modality == "RTPLAN"]
    return {"image_series_uids": [ct.series_instance_uid], "dose_uids": doses, **({"plan_uids": plans} if plan else {})}


def _uid_of(root: Path, description: str) -> str:
    return next(e.series_instance_uid for e in _index(root).series.values() if e.series_description == description)


def _wait(s: Session, job_id: str, timeout: float = 60.0) -> dict:
    deadline = time.time() + timeout
    while True:
        j = s._get(f"/api/v1/jobs/{job_id}")
        if j["status"] in ("done", "failed"):
            return j
        if time.time() > deadline:
            raise TimeoutError(j)
        time.sleep(0.05)


def test_chain_helpers_understand_beam_sum() -> None:
    part = lambda n: {  # noqa: E731
        "series_id": f"b{n}",
        "label": f"B{n}",
        "dose_type": "PHYSICAL",
        "summation_type": "BEAM",
        "plan_sop_uids": ["p1"],
    }
    node = {
        "op": "beam_sum",
        "parts": [part(1), part(2)],
        "beams": [1, 2],
        "plan_label": "P",
        "result_dose_type": "PHYSICAL",
    }
    assert dose_ops.chain_text(node) == "Σ beams 1,2 (P)"
    assert [x["series_id"] for x in dose_ops.leaves(node)] == ["b1", "b2"]
    assert dose_ops.summation_type_for_save(node) == "PLAN"  # 合成後是計畫劑量
    assert dose_ops.chain_text({"op": "mul", "a": node, "b": None, "k": 2.0}) == "(Σ beams 1,2 (P)) × 2"
    assert not dose_ops.has_sub(node)


def test_beam_sum_equals_the_plan_dose_and_saves_as_plan(beams: Path, tmp_path: Path, monkeypatch) -> None:  # type: ignore[no-untyped-def]
    monkeypatch.setenv("RTGAIA_DATA_DIR", str(tmp_path / "data"))
    with Session(library_root=str(beams), user="dr") as s:
        s.load_case(_selection(beams), webgl2=False, tier="C")
        out = s._get(f"/api/v1/studies/{s.study_id}/dose-ops/sources")
        src = {x["series_id"]: x for x in out["sources"]}
        b1 = _uid_of(beams, "Beam B1 dose")
        assert not src[b1]["eligible"] and any("射束劑量要先合成" in p for p in src[b1]["problems"])
        (group,) = out["beam_groups"]
        assert group["eligible"], group
        assert (
            group["plan_label"] == "BEAMS3" and group["expected_beams"] == [1, 2, 3] and group["fractions_planned"] == 5
        )
        assert [d["beams"] for d in group["doses"]] == [[1], [2], [3]]
        # 射束劑量預設隱藏（N 層 colorwash 疊在一起）；計畫劑量照舊顯示
        shown = {x["contentRef"]: x["visible"] for x in s._scene["layers"] if x["kind"] == "dose"}
        assert shown[b1] is False and shown[_uid_of(beams, "Plan dose")] is True
        # 同一個計畫標籤的射束劑量要分得出來
        assert [d["label"] for d in group["doses"]] == [f"BEAMS3 beam {n} 10-01" for n in (1, 2, 3)]
        # 射束劑量本身不能直接運算
        with pytest.raises(RuntimeError, match="422"):
            s._post(f"/api/v1/studies/{s.study_id}/dose-ops", {"op": "mul", "a": b1, "k": 2})
        res = s._post(
            f"/api/v1/studies/{s.study_id}/dose-ops", {"op": "beam_sum", "plan_sop_uid": group["plan_sop_uid"]}
        )
        assert res["text"] == "Σ beams 1,2,3 (BEAMS3)" and res["summation_type_for_save"] == "PLAN"
        assert [x["series_id"] for x in res["sources"]] == [d["series_id"] for d in group["doses"]]
        assert res["plan_sop_uids"] == [group["plan_sop_uid"]]
        # 最大值等於 PLAN 劑量（同一個 DoseGridScaling、整數相加）；逐點比對在下面存成 RTDOSE 之後
        plan_uid = _uid_of(beams, "Plan dose")
        assert abs(res["summary"]["max_gy"] - src[plan_uid]["max_gy"]) < 1e-4
        # 合成結果可以再當運算元（計畫劑量 − 合成 ＝ 0）
        diff = s._post(f"/api/v1/studies/{s.study_id}/dose-ops", {"op": "sub", "a": plan_uid, "b": res["series_id"]})
        assert abs(diff["summary"]["max_gy"]) < 1e-4 and abs(diff["summary"]["min_gy"]) < 1e-4
        # 存成 RTDOSE：PLAN、引用計畫、衍生碼「由先前劑量組成」
        job = s._post(f"/api/v1/dose/{res['series_id']}/save", {})
        done = _wait(s, job["job_id"])
        assert done["status"] == "done", done
        ds = pydicom.dcmread(io.BytesIO(s._client.get(done["download_url"], headers=s._headers).content))
        assert ds.DoseSummationType == "PLAN" and ds.DoseType == "PHYSICAL"
        assert ds.ReferencedRTPlanSequence[0].ReferencedSOPInstanceUID == group["plan_sop_uid"]
        assert ds.DerivationCodeSequence[0].CodeValue == "121370"
        assert "Σ beams 1,2,3" in ds.DoseComment
        px = ds.pixel_array.astype(np.float64) * float(ds.DoseGridScaling)
        plan_px = pydicom.dcmread(next(beams.rglob("RD.plan.dcm")))
        plan_gy = plan_px.pixel_array.astype(np.float64) * float(plan_px.DoseGridScaling)
        assert np.allclose(px, plan_gy, atol=2e-4)


@pytest.mark.parametrize(
    ("variant", "needle", "key"),
    [
        ("missing", "缺射束 2", "missing"),
        ("duplicate", "射束 1 有不只一個劑量", "duplicates"),
        ("extra", "射束 4 不在計畫的 fraction group 1 裡", "extra"),
        ("no_plan", "引用的計畫不在病例裡", None),
        ("no_beam", "沒有寫是哪個射束", None),
    ],
)
def test_incomplete_beam_sets_are_refused_with_a_reason(
    beams: Path, tmp_path: Path, monkeypatch, variant: str, needle: str, key: str | None
) -> None:  # type: ignore[no-untyped-def]
    monkeypatch.setenv("RTGAIA_DATA_DIR", str(tmp_path / "data"))
    root = tmp_path / "case"
    shutil.copytree(beams, root)
    drop: tuple[str, ...] = ("Plan dose",)
    if variant == "no_plan":
        # 開病例時劑量引用的計畫會自動帶進來 —— 要「不在病例裡」就得資料庫裡沒有那份 RTPLAN
        shutil.rmtree(root / "RP")
    if variant == "missing":
        drop = ("Plan dose", "Beam B2 dose")
    elif variant in ("duplicate", "extra", "no_beam"):
        src = next(root.rglob("RD.beam1.dcm"))
        ds = pydicom.dcmread(src)
        ds.SOPInstanceUID = ds.file_meta.MediaStorageSOPInstanceUID = ds.SOPInstanceUID + ".9"
        ds.SeriesInstanceUID = ds.SeriesInstanceUID + ".9"
        ds.SeriesDescription = "Beam extra dose"
        rfg = ds.ReferencedRTPlanSequence[0].ReferencedFractionGroupSequence[0]
        if variant == "extra":
            rfg.ReferencedBeamSequence[0].ReferencedBeamNumber = 4  # SETUP 射束：不在 fraction group 裡
        if variant == "no_beam":
            del ds.ReferencedRTPlanSequence[0].ReferencedFractionGroupSequence
        ds.save_as(src.with_name("RD.extra.dcm"), enforce_file_format=True)
    with Session(library_root=str(root), user="dr") as s:
        s.load_case(_selection(root, plan=variant != "no_plan", drop=drop), webgl2=False, tier="C")
        (group,) = s._get(f"/api/v1/studies/{s.study_id}/dose-ops/sources")["beam_groups"]
        assert not group["eligible"]
        assert any(needle in p for p in group["problems"]), group["problems"]
        if key is not None:
            assert group[key]
        with pytest.raises(RuntimeError, match="422"):
            s._post(f"/api/v1/studies/{s.study_id}/dose-ops", {"op": "beam_sum", "plan_sop_uid": group["plan_sop_uid"]})


def test_case_without_beam_doses_has_no_groups(beams: Path, tmp_path: Path, monkeypatch) -> None:  # type: ignore[no-untyped-def]
    monkeypatch.setenv("RTGAIA_DATA_DIR", str(tmp_path / "data"))
    with Session(library_root=str(beams), user="dr") as s:
        s.load_case(_selection(beams, drop=("Beam",)), webgl2=False, tier="C")
        out = s._get(f"/api/v1/studies/{s.study_id}/dose-ops/sources")
        assert out["beam_groups"] == [] and len(out["sources"]) == 1
        with pytest.raises(RuntimeError, match="404"):
            s._post(f"/api/v1/studies/{s.study_id}/dose-ops", {"op": "beam_sum", "plan_sop_uid": "1.2.3"})
