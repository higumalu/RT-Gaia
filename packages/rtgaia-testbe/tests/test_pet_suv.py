"""PET 換成 SUVbw（`loaders/pet_suv.py`）。

* 標籤齊（BQML、START／ADMIN、體重、劑量、半衰期、注射時間）→ 像素存 SUV×100、params 標 SUV、預設窗 SUV 0–5
* 衰變：START 衰變到取像參考時間；ADMIN 不衰變；SeriesTime 晚於最早的 AcquisitionTime → 用取像時間（QIBA）；跨午夜
* 標籤不齊 → 不猜：維持 Bq/ml，警告說缺什麼；不是 BQML（CNTS）→ 標單位、不警告
* 換算前留下的 Bq/ml 快取不會被當成 SUV 讀回（快取檔名帶存法）
"""

from __future__ import annotations

import shutil
from pathlib import Path

import numpy as np
import pydicom
import pytest
from pydicom.dataset import Dataset
from rtgaia_core.library.index import LibraryIndex
from rtgaia_core.loaders.case import CaseSelection, build_case_dataset
from rtgaia_core.loaders.dicom import read_pixels, series_geometry
from rtgaia_core.loaders.pet_suv import parse_dicom_datetime, pet_values, suv_factor
from rtgaia_testbe.fixtures import synth4d

DOSE = 350e6
HALF_LIFE = 6588.0
WEIGHT = 70.0


@pytest.fixture(scope="module")
def ct(tmp_path_factory: pytest.TempPathFactory) -> Path:
    root = tmp_path_factory.mktemp("b101")
    synth4d.build(root, ["ct1"])
    return root


def _pet(ct: Path, dst: Path, *, rp: dict[str, object] | None = None, **tags: object) -> Path:
    """synth4d 的第 0 相位改成一個 PET：Rescale 1／0、BQML、START、體重 70、
    注射 10:00、SeriesTime 11:49:48（＝ 一個半衰期）。"""
    shutil.copytree(ct / "ct1", dst, ignore=shutil.ignore_patterns("RS", "RD"))
    index = LibraryIndex.scan(dst, use_cache=False)
    entry = next(e for e in index.image_series() if e.series_description.endswith(" 0%"))
    keep = {Path(p) for p in entry.paths}
    for p in dst.rglob("*.dcm"):
        if p not in keep:
            p.unlink()
    info = {
        "Radiopharmaceutical": "FDG",
        "RadionuclideTotalDose": DOSE,
        "RadionuclideHalfLife": HALF_LIFE,
        "RadiopharmaceuticalStartTime": "100000",
        **(rp or {}),
    }
    base: dict[str, object] = {
        "Modality": "PT",
        "RescaleSlope": 1,
        "RescaleIntercept": 0,
        "Units": "BQML",
        "DecayCorrection": "START",
        "PatientWeight": WEIGHT,
        "SeriesDate": "20260101",
        "SeriesTime": "114948",  # 10:00 ＋ 6588 s
        "AcquisitionDate": "20260101",
        "AcquisitionTime": "114948",
        "WindowCenter": None,
        "WindowWidth": None,
        **tags,
    }
    for p in keep:
        ds = pydicom.dcmread(p)
        for k, v in base.items():
            if v is None:
                if k in ds:
                    delattr(ds, k)
            else:
                setattr(ds, k, v)
        item = Dataset()
        for k, v in info.items():
            if v is not None:
                setattr(item, k, v)
        ds.RadiopharmaceuticalInformationSequence = [item]
        ds.save_as(p)
    return dst


def _geometry(root: Path):  # type: ignore[no-untyped-def]
    index = LibraryIndex.scan(root, use_cache=False)
    entry = next(iter(index.image_series()))
    return entry, series_geometry(list(entry.instances))


def test_start_decay_correction_decays_the_dose_to_the_series_time(ct: Path, tmp_path: Path) -> None:
    _, g = _geometry(_pet(ct, tmp_path / "pet"))
    raw = read_pixels(g).astype(np.float64)
    scaled, params, warning = pet_values(g)
    assert warning is None
    assert params["value_unit"] == "SUV" and params["value_scale"] == pytest.approx(0.01)
    suv = params["suv"]
    assert suv["elapsed_s"] == pytest.approx(HALF_LIFE) and suv["decayed_dose_bq"] == pytest.approx(DOSE / 2, rel=1e-6)
    factor = WEIGHT * 1000 / (DOSE / 2)
    vol = read_pixels(scaled).astype(np.float64)
    assert np.allclose(vol / 100.0, raw * factor, atol=0.006)
    assert scaled.default_window == (250.0, 500.0)  # SUV 0–5（存 ×100）


def test_admin_decay_correction_does_not_decay(ct: Path, tmp_path: Path) -> None:
    _, g = _geometry(_pet(ct, tmp_path / "pet", DecayCorrection="ADMIN"))
    _units, info, reason = suv_factor([g.files[0].path])
    assert reason is None and info is not None
    assert info.factor == pytest.approx(WEIGHT * 1000 / DOSE) and info.elapsed_s == 0.0


def test_series_time_after_acquisition_uses_the_earliest_acquisition(ct: Path, tmp_path: Path) -> None:
    # 後處理把 SeriesTime 改成 13:00（晚於取像）→ QIBA：用最早的 AcquisitionTime 11:49:48
    _, g = _geometry(_pet(ct, tmp_path / "pet", SeriesTime="130000"))
    _units, info, _ = suv_factor(list(dict.fromkeys(f.path for f in g.files)))
    assert info is not None and info.elapsed_s == pytest.approx(HALF_LIFE)


def test_injection_before_midnight_without_a_date(ct: Path, tmp_path: Path) -> None:
    _, g = _geometry(
        _pet(
            ct,
            tmp_path / "pet",
            SeriesTime="002000",
            AcquisitionTime="002000",
            rp={"RadiopharmaceuticalStartTime": "233000"},
        )
    )
    _units, info, reason = suv_factor([g.files[0].path])
    assert reason is None and info is not None and info.elapsed_s == pytest.approx(50 * 60)


def test_injection_datetime_wins_over_the_time(ct: Path, tmp_path: Path) -> None:
    rp = {"RadiopharmaceuticalStartDateTime": "20260101103000.00+0800", "RadiopharmaceuticalStartTime": "000000"}
    _, g = _geometry(_pet(ct, tmp_path / "pet", rp=rp))
    _units, info, _ = suv_factor([g.files[0].path])
    assert info is not None and info.elapsed_s == pytest.approx(3600 + 19 * 60 + 48)


@pytest.mark.parametrize(
    ("tags", "rp", "needle"),
    [
        ({"PatientWeight": None}, None, "PatientWeight"),
        ({}, {"RadionuclideTotalDose": None}, "RadionuclideTotalDose"),
        ({}, {"RadionuclideHalfLife": None}, "RadionuclideHalfLife"),
        ({}, {"RadiopharmaceuticalStartTime": None}, "注射時間"),
        ({"DecayCorrection": "NONE"}, None, "DecayCorrection"),
    ],
)
def test_missing_tags_keep_bq_per_ml_and_say_why(
    ct: Path, tmp_path: Path, tags: dict, rp: dict | None, needle: str
) -> None:  # type: ignore[type-arg]
    _, g = _geometry(_pet(ct, tmp_path / "pet", rp=rp, **tags))
    same, params, warning = pet_values(g)
    assert same is g  # 像素原樣
    assert params["value_unit"] == "Bq/ml" and params["value_scale"] == 1.0
    assert warning is not None and needle in warning and needle in str(params["suv_unavailable"])


def test_non_bqml_units_are_labelled_without_a_warning(ct: Path, tmp_path: Path) -> None:
    _, g = _geometry(_pet(ct, tmp_path / "pet", Units="CNTS"))
    same, params, warning = pet_values(g)
    assert same is g and warning is None and params == {"value_unit": "counts", "value_scale": 1.0}


def test_ct_is_untouched(ct: Path) -> None:
    index = LibraryIndex.scan(ct / "ct1", use_cache=False)
    entry = next(e for e in index.image_series() if e.series_description.endswith(" 0%"))
    g = series_geometry(list(entry.instances))
    same, params, warning = pet_values(g)
    assert same is g and params == {} and warning is None


def test_parse_dicom_datetime_accepts_short_and_fractional_times() -> None:
    assert parse_dicom_datetime("20260101", "10").hour == 10  # type: ignore[union-attr]
    assert parse_dicom_datetime("20260101", "1015").minute == 15  # type: ignore[union-attr]
    assert parse_dicom_datetime("20260101", "101530.5").microsecond == 500000  # type: ignore[union-attr]
    assert parse_dicom_datetime("", "101530") is None and parse_dicom_datetime("20260101", "") is None
    assert parse_dicom_datetime("20260101", "256000") is None


def test_case_dataset_carries_suv_params_and_a_separate_cache_file(ct: Path, tmp_path: Path, monkeypatch) -> None:  # type: ignore[no-untyped-def]
    from rtgaia_core.dataset_io import volume

    root = _pet(ct, tmp_path / "pet")
    monkeypatch.setenv("RTGAIA_DATA_DIR", str(tmp_path / "data"))
    monkeypatch.delenv("RTGAIA_LIBRARY_ROOT", raising=False)
    index = LibraryIndex.scan(root, use_cache=False)
    entry = next(iter(index.image_series()))
    ds = build_case_dataset(index, CaseSelection(image_series_uids=(entry.series_instance_uid,)))
    s = ds.series[0]
    assert s.params["value_unit"] == "SUV" and s.params["voxel_encoding"] == "suv_x100"
    assert s.default_window == (250.0, 500.0)
    v = volume(ds, s, 0)
    files = sorted(p.name for p in (tmp_path / "data" / "cache" / "volumes").rglob("*.npy"))
    assert len(files) == 1 and files[0].endswith("_f0_suv_x100.npy")
    assert int(np.asarray(v).max()) > 0
