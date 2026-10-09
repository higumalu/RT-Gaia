"""合成 4D 測資（`rtgaia_testbe.fixtures.synth4d`）本身是對的：真值、編碼、DICOM 合法性。

分組邏輯還沒做；這裡只保證「拿來當答案的測資」沒有寫錯 —— 之後分組的測試才能信任 expected.json。
"""

from __future__ import annotations

import json
import warnings
from pathlib import Path

import numpy as np
import pydicom
import pytest
from rtgaia_testbe.fixtures import synth4d


@pytest.fixture(scope="module")
def out(tmp_path_factory: pytest.TempPathFactory) -> Path:
    root = tmp_path_factory.mktemp("synth4d")
    with warnings.catch_warnings():
        warnings.simplefilter("error")  # pydicom 對 VR 長度、UID 格式的警告一律當錯
        synth4d.build(root, ["ct1", "ct2", "ct3", "ct5", "mr1", "mr3", "mr5", "mr6", "mr7", "mr8", "mr10"])
    return root


def _expected(out: Path, cid: str) -> dict:
    return json.loads((out / cid / "expected.json").read_text(encoding="utf-8"))


def _series_files(out: Path, cid: str) -> dict[str, list[pydicom.Dataset]]:
    by: dict[str, list[pydicom.Dataset]] = {}
    for f in sorted((out / cid).rglob("*.dcm")):
        ds = pydicom.dcmread(f)
        by.setdefault(ds.SeriesInstanceUID, []).append(ds)
    return by


def _tumor_z(slices: list[pydicom.Dataset]) -> float:
    """腫瘤（右肺內 HU 30–60 的體素；軟組織是 20）的 z 重心。"""
    zs, ws = [], []
    for ds in slices:
        hu = ds.pixel_array.astype(float) + float(ds.RescaleIntercept)
        x0, y0 = float(ds.ImagePositionPatient[0]), float(ds.ImagePositionPatient[1])
        sp = float(ds.PixelSpacing[0])
        jj, ii = np.meshgrid(np.arange(ds.Rows), np.arange(ds.Columns), indexing="ij")
        x, y = x0 + ii * sp, y0 + jj * sp
        near = (x - synth4d.TUMOR_REST_LPS[0]) ** 2 + (y - synth4d.TUMOR_REST_LPS[1]) ** 2 < 25**2
        n = int(np.count_nonzero(near & (hu > 30) & (hu < 60)))
        if n:
            zs.append(float(ds.ImagePositionPatient[2]))
            ws.append(n)
    return float(np.average(zs, weights=ws))


def test_every_file_is_valid_and_uids_are_unique(out: Path) -> None:
    sops: set[str] = set()
    for f in out.rglob("*.dcm"):
        ds = pydicom.dcmread(f)
        assert ds.SOPInstanceUID not in sops, f
        sops.add(ds.SOPInstanceUID)
        for value in (ds.SOPInstanceUID, ds.SeriesInstanceUID, ds.StudyInstanceUID):
            assert len(value) <= 64 and all(c.isdigit() or c == "." for c in value)
        assert str(ds.PatientID).startswith("SYN4D-")
    index = json.loads((out / "index.json").read_text(encoding="utf-8"))
    assert {e["id"] for e in index} >= {"ct1", "mr1"}


def test_ct1_phase_series_carry_the_breathing_truth(out: Path) -> None:
    exp = _expected(out, "ct1")
    by = _series_files(out, "ct1")
    group = exp["expected"]["groups"][0]
    assert group["frames"] == 10 and group["frame_labels"][5] == "50%"
    truth = exp["truth"]["tumor_center_lps_per_frame"]
    for n, series_uid in enumerate(group["series_order"]):
        slices = by[series_uid]
        assert len(slices) == 40
        assert slices[0].SeriesDescription.endswith(f"{n * 10}%")
        assert abs(_tumor_z(slices) - truth[n][2]) < 1.6  # 3 mm 切片的重心誤差
    # 0% 吸氣末最低、50% 吐氣末最高
    assert truth[0][2] < truth[5][2]
    derived = {d["op"]: d["series"] for d in exp["expected"]["derived"]}
    assert list(by[derived["mean"]][0].ImageType)[-1] == "MEAN"
    # 同一個 FoR：相位、衍生、RS、劑量
    fors = {ds.FrameOfReferenceUID for slices in by.values() for ds in slices if "FrameOfReferenceUID" in ds}
    assert len(fors) == 1
    rs = [s for s in exp["series"] if s["role"] == "rtstruct"]
    assert {r["rois"][0] for r in rs} == {"ITV", "GTV_00", "GTV_50"}


def test_ct2_stores_slices_top_down_and_ct3_labels_amplitude(out: Path) -> None:
    exp = _expected(out, "ct2")
    by = _series_files(out, "ct2")
    first = by[exp["expected"]["groups"][0]["series_order"][0]]
    top = max(first, key=lambda ds: float(ds.ImagePositionPatient[2]))
    assert top.InstanceNumber == 1
    assert "Gated, 0.0%" in top.SeriesDescription
    ng = by[exp["expected"]["standalone"][0]]
    assert len(ng) == 46 and "Non-Gated" in ng[0].SeriesDescription
    labels = _expected(out, "ct3")["expected"]["groups"][0]["frame_labels"]
    assert labels[0] == "In 0%" and labels[4] == "In 100%" and labels[-1] == "Ex 25%"


def test_enhanced_ct_and_mr_dimensions(out: Path) -> None:
    ct = pydicom.dcmread(next((out / "ct5").rglob("ENH.dcm")))
    assert ct.NumberOfFrames == 400 and ct.DimensionOrganizationType == "3D_TEMPORAL"
    assert ct.pixel_array.shape == (400, 128, 128)
    pointers = [int(d.DimensionIndexPointer) for d in ct.DimensionIndexSequence]
    assert pointers == [0x00209245, 0x00209057]
    f = ct.PerFrameFunctionalGroupsSequence[41]  # 第 2 個相位的第 2 片
    assert f.RespiratorySynchronizationSequence[0].NominalPercentageOfRespiratoryPhase == 10.0
    assert list(f.FrameContentSequence[0].DimensionIndexValues) == [2, 2]
    mr = pydicom.dcmread(next((out / "mr8").rglob("ENH.dcm")))
    assert mr.NumberOfFrames == 240
    last = mr.PerFrameFunctionalGroupsSequence[-1]
    assert last.FrameContentSequence[0].TemporalPositionIndex == 12
    assert last.TemporalPositionSequence[0].TemporalPositionTimeOffset == 300.0


def test_mr1_dce_curve_matches_truth_through_temporal_position(out: Path) -> None:
    exp = _expected(out, "mr1")
    (slices,) = _series_files(out, "mr1").values()
    assert len(slices) == 240
    numbers = [int(ds.InstanceNumber) for ds in slices]
    assert sorted(numbers) == list(range(1, 241))
    # InstanceNumber 打亂：照 InstanceNumber 排，時間不是單調
    by_inst = sorted(slices, key=lambda ds: int(ds.InstanceNumber))
    assert [int(ds.TemporalPositionIdentifier) for ds in by_inst[:20]] != [1] * 20
    i = round((synth4d.LESION_LPS[0] - synth4d.MR_GEOM.origin[0]) / synth4d.MR_GEOM.spacing[0])
    j = round((synth4d.LESION_LPS[1] - synth4d.MR_GEOM.origin[1]) / synth4d.MR_GEOM.spacing[1])
    center = {int(ds.TemporalPositionIdentifier): ds for ds in slices if abs(float(ds.ImagePositionPatient[2])) < 0.1}
    base = float(center[1].pixel_array[j - 1 : j + 2, i - 1 : i + 2].mean())
    for t, rel in enumerate(exp["truth"]["lesion_relative_enhancement"], start=1):
        got = float(center[t].pixel_array[j - 1 : j + 2, i - 1 : i + 2].mean()) / base - 1
        assert abs(got - rel) < 0.06, (t, got, rel)
    assert [float(center[t].TriggerTime) / 1000 for t in sorted(center)] == synth4d.DCE_TIMES_S


def test_not_time_axes_are_marked(out: Path) -> None:
    (echo,) = _series_files(out, "mr5").values()
    assert sorted({int(ds.EchoNumbers) for ds in echo}) == [1, 2, 3, 4]
    assert _expected(out, "mr5")["expected"]["groups"] == []
    (dwi,) = _series_files(out, "mr6").values()
    adc = [ds for ds in dwi if "ADC" in ds.ImageType]
    assert len(adc) == 20
    bvals = {int(ds[0x0019, 0x100C].value) for ds in dwi if "ADC" not in ds.ImageType}
    assert bvals == {0, 500, 1000}
    (mixed,) = _series_files(out, "mr7").values()
    assert sorted({ds.ImageType[2] for ds in mixed}) == ["M", "P"]


def test_mr3_one_series_per_timepoint_and_mr10_single_slice(out: Path) -> None:
    exp = _expected(out, "mr3")
    by = _series_files(out, "mr3")
    order = exp["expected"]["groups"][0]["series_order"]
    assert len(order) == 12 and len({by[u][0].SeriesDescription for u in order}) == 1
    assert [int(by[u][0].SeriesNumber) for u in order] == list(range(20, 32))
    (cine,) = _series_files(out, "mr10").values()
    assert len(cine) == 150 and len({tuple(ds.ImagePositionPatient) for ds in cine}) == 1
    assert list(cine[0].ImageOrientationPatient) == list(synth4d.SAGITTAL)
