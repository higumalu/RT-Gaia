"""第一次拿真實多廠資料（TCIA／IDC 的 CC BY demo 病例，2026-10-04）測出來的問題。

* DL6／DL7：GE 每張 IOP 只寫 6 位有效數字 → 同一個方向在最後一位不同，不能當成非平行切片（CCTH AX T2 等）。
* DL12：GE 多床位 PET 的床位交界間距 3.25／3.35 mm（其他 3.27 mm）→ 在相對容許值內照常載入並警告；
  漏一張、累積位置誤差太大照樣擋。
* 4D 分組：描述裡帶每個相位不同的編號（4D-Lung／Pinnacle `P4^P113^S303^I10350, Gated, 50.0%A`）。
* DWI 的 b 值被去識別化刪掉 → 「b 值未知」的參數軸，不是時間點。
* 資料頁「動態 ×N」：拆掉相位圖／ADC 之後的幀數。
* 副序列開不起來 → 排除並警告，不是整個病例 400；primary 開不起來才擋。
* Gamma Knife 計畫：shot 不是直線加速器射束。
* Enhanced 多幀匯出 RS：Referenced SOP Instance UID ＋ Referenced Frame Number。
"""

from __future__ import annotations

import shutil
from dataclasses import replace
from pathlib import Path

import numpy as np
import pydicom
import pytest
from pydicom.dataset import Dataset, FileMetaDataset
from pydicom.uid import ExplicitVRLittleEndian, generate_uid
from rtgaia_core.library.index import LibraryIndex
from rtgaia_core.loaders.case import CaseSelection, build_case_dataset, select_all
from rtgaia_core.loaders.dicom import series_geometry
from rtgaia_core.loaders.rtplan import read_plan_beams
from rtgaia_core.loaders.temporal import cross_series_plans, study_plans
from rtgaia_core.rtstruct import build_rtstruct
from rtgaia_geom import ContractViolation
from rtgaia_geom.grid import Grid
from rtgaia_testbe import Session
from rtgaia_testbe.fixtures import synth4d


@pytest.fixture(scope="module")
def data(tmp_path_factory: pytest.TempPathFactory) -> Path:
    root = tmp_path_factory.mktemp("b86")
    synth4d.build(root, ["ct1", "ct5", "mr6", "mr7"])
    return root


def _phase0_headers(data: Path) -> list:  # type: ignore[type-arg]
    index = LibraryIndex.scan(data / "ct1", use_cache=False)
    entry = next(e for e in index.image_series() if e.series_description.endswith(" 0%"))
    return sorted(entry.instances, key=lambda h: h.image_position_patient[2])


def _rewrite(paths: list[Path], **tags: object) -> None:
    for p in paths:
        ds = pydicom.dcmread(p)
        for k, v in tags.items():
            if v is None:
                if k in ds:
                    delattr(ds, k)
            else:
                setattr(ds, k, v)
        ds.save_as(p)


# ── DL6／DL7／DL12 ─────────────────────────────────────────────────────────────


def test_iop_rounding_in_the_last_digit_is_the_same_orientation(data: Path) -> None:
    hs = _phase0_headers(data)
    jitter = [
        replace(h, image_orientation_patient=[1.0, 1e-7 * (i % 3), 0.0, -1e-7 * (i % 2), 1.0, 0.0])
        for i, h in enumerate(hs)
    ]
    assert series_geometry(jitter).grid.size[2] == len(hs)  # 以前：DL6 非平行切片
    tilted = [replace(h, image_orientation_patient=[1.0, 0.0, 0.0, 0.0, 0.999, 0.044]) for h in hs[:5]] + hs[5:]
    with pytest.raises(ContractViolation, match="DL6"):
        series_geometry(tilted)
    spacing = [replace(h, pixel_spacing=[3.5 + 1e-7 * (i % 2), 3.5]) for i, h in enumerate(hs)]
    assert series_geometry(spacing).grid.spacing[0] == pytest.approx(3.5)


def _at(hs: list, zs: list[float]) -> list:  # type: ignore[type-arg]
    return [
        replace(h, image_position_patient=[h.image_position_patient[0], h.image_position_patient[1], z])
        for h, z in zip(hs, zs, strict=True)
    ]


def test_pet_bed_boundaries_within_relative_tolerance_load_with_a_warning(data: Path) -> None:
    hs = _phase0_headers(data)
    n = len(hs)
    # 每 10 片一個床位交界：3.35 接著 3.19（位置回到等距網格上 → 累積誤差只有 0.08）
    gaps = [3.35 if i % 10 == 9 else 3.19 if i % 10 == 0 and i > 0 else 3.27 for i in range(n - 1)]
    g = series_geometry(_at(hs, list(np.concatenate([[0.0], np.cumsum(gaps)]))))
    assert g.grid.spacing[2] == pytest.approx(3.27)
    assert len(g.warnings) == 1 and "不完全均勻" in g.warnings[0]
    # 完全等距 → 沒有警告
    assert series_geometry(_at(hs, [3.27 * i for i in range(n)])).warnings == ()
    # 漏一張（一個間距的偏差）→ 照樣 DL12
    with pytest.raises(ContractViolation, match="DL12"):
        series_geometry(_at(hs[:-1], [3.27 * i for i in range(n) if i != 20]))
    # 每個交界都多 0.08、不回來 → 單一間距在容許值內，但累積位置誤差超過 → DL12
    drift = [3.35 if i % 10 == 9 else 3.27 for i in range(n - 1)]
    with pytest.raises(ContractViolation, match="DL12"):
        series_geometry(_at(hs, list(np.concatenate([[0.0], np.cumsum(drift)]))))


# ── 4D 分組與 DWI ───────────────────────────────────────────────────────────────


def test_pinnacle_descriptions_with_per_phase_numbers_still_group(data: Path, tmp_path: Path) -> None:
    dst = tmp_path / "lung"
    shutil.copytree(data / "ct1", dst, ignore=shutil.ignore_patterns("RS", "RD"))
    index = LibraryIndex.scan(dst, use_cache=False)
    phases = [e for e in index.image_series() if e.series_description.rstrip().endswith("%")]
    assert len(phases) == 10
    for n, e in enumerate(sorted(phases, key=lambda e: int(e.series_number))):
        pct = int(e.series_description.split()[-1].rstrip("%"))
        _rewrite([Path(p) for p in e.paths], SeriesDescription=f"P4^P113^S303^I1{n:04d}, Gated, {pct}.0%A")
    index = LibraryIndex.scan(dst, use_cache=False)
    (plan,) = [p for p in cross_series_plans(index.image_series()) if p.axis == "phase"]
    assert len(plan.frames) == 10 and plan.labels == [f"{10 * i}%" for i in range(10)]
    # 同一個相位出現兩次（寬鬆比對時多半是兩次不同的掃描）→ 不湊成組
    two = sorted(phases, key=lambda e: int(e.series_number))[:2]
    _rewrite([Path(p) for p in two[1].paths], SeriesDescription="P4^P113^S303^I19999, Gated, 0.0%A")
    index = LibraryIndex.scan(dst, use_cache=False)
    assert [p for p in cross_series_plans(index.image_series()) if p.axis == "phase"] == []


def _dwi_without_b(data: Path, dst: Path, description: str) -> list[Path]:
    shutil.copytree(data / "mr6", dst)
    files = sorted(dst.rglob("*.dcm"))
    for p in files:  # 去識別化把廠商私有的 b 值刪掉
        ds = pydicom.dcmread(p)
        if (0x0019, 0x100C) in ds:
            del ds[0x0019, 0x100C]
        ds.SeriesDescription = description
        ds.save_as(p)
    return files


@pytest.mark.parametrize("description", ["SAG DWI", "SAG DWI B100/600/1000/1500/2000", "SAG DWI B5000/20000"])
def test_dwi_without_b_value_tags_is_a_b_value_axis_with_unknown_values(
    data: Path, tmp_path: Path, description: str
) -> None:
    """描述沒寫 b 值、或寫的個數對不上組數（3 組）→ 不猜。"""
    _dwi_without_b(data, tmp_path / "dwi", description)
    (plan,) = study_plans(LibraryIndex.scan(tmp_path / "dwi", use_cache=False).series.values())
    assert plan.axis == "b_value" and plan.labels is None and plan.unit is None and len(plan.frames) == 3
    assert any("b 值未知" in w for w in plan.warnings) and plan.b_guess == ()
    assert plan.times is None


@pytest.mark.parametrize(
    ("description", "labels"),
    [
        ("SAG DWI B500/1000", ["b 0?", "b 500?", "b 1000?"]),  # 少一個、沒寫 0 → 補 b0
        ("DWI b=0,500,1000", ["b 0?", "b 500?", "b 1000?"]),
        ("ep2d_diff b0 b500 b1000", ["b 0?", "b 500?", "b 1000?"]),
    ],
)
def test_dwi_b_values_inferred_from_the_description_carry_a_question_mark(
    data: Path, tmp_path: Path, description: str, labels: list[str]
) -> None:
    from rtgaia_core.loaders.case import CaseSelection, build_case_dataset

    _dwi_without_b(data, tmp_path / "dwi", description)
    index = LibraryIndex.scan(tmp_path / "dwi", use_cache=False)
    (plan,) = study_plans(index.series.values())
    assert plan.labels == labels and plan.unit == "s/mm²" and plan.b_guess == (0.0, 500.0, 1000.0)
    assert any("依描述推定 b 值 0/500/1000" in w for w in plan.warnings)
    assert ("依慣例補上" in " ".join(plan.warnings)) == description.endswith("B500/1000")
    # 開病例：訊號 b 越大越暗 → 推定留著
    dwi = next(e for e in index.image_series() if e.series_description == description)
    ds = build_case_dataset(index, CaseSelection(image_series_uids=[dwi.series_instance_uid]))
    assert list(ds.temporal_groups[0].frame_labels or []) == labels


def test_dwi_guess_that_contradicts_the_signal_is_dropped(data: Path, tmp_path: Path) -> None:
    from rtgaia_core.loaders.temporal import check_b_guess

    _dwi_without_b(data, tmp_path / "dwi", "SAG DWI B500/1000")
    (plan,) = study_plans(LibraryIndex.scan(tmp_path / "dwi", use_cache=False).series.values())
    means = iter([100.0, 120.0, 90.0])  # 第二組比第一組亮 → 順序不對
    checked = check_b_guess(plan, lambda _h: next(means))
    assert checked.labels is None and checked.b_guess == () and checked.unit is None
    assert not any("依描述推定" in w for w in checked.warnings)
    assert any("順序不符" in w for w in checked.warnings)
    assert check_b_guess(plan, lambda _h: 1 / 0) is plan  # 讀不到 → 不核對


def test_b_values_from_description() -> None:
    from rtgaia_core.loaders.temporal import b_values_from_description as f

    assert f("SAG DWI B100/600/1000", 4) == ((0.0, 100.0, 600.0, 1000.0), True)
    assert f("SAG DWI B100/600/1000", 3) == ((100.0, 600.0, 1000.0), False)
    assert f("SAG DWI B100/600/1000", 5) is None
    assert f("DWI b0 b800", 2) == ((0.0, 800.0), False)
    assert f("DWI b0 b800", 3) is None  # 寫了 0 就不再補
    assert f("T2 BLADE", 2) is None and f("", 2) is None


def test_catalog_dynamic_badge_counts_frames_after_splitting(data: Path) -> None:
    for cid, frames, axis in (("mr6", 3, "b_value"), ("mr7", 6, "time")):
        index = LibraryIndex.scan(data / cid, use_cache=False)
        study = next(iter(index.series.values())).study_instance_uid
        with Session(library_root=str(data / cid), user="dr") as s:
            (row,) = s.catalog_series(study)["images"]
        dyn = row["dynamic"]
        assert dyn["repeats"] == frames * 2 if cid == "mr7" else dyn["repeats"] == 4
        assert dyn["frames"] == frames and dyn["axis"] == axis
        assert dyn["split_off"][0]["count"] > 0


# ── 副序列開不起來 ──────────────────────────────────────────────────────────────


def test_a_broken_secondary_series_is_left_out_with_a_warning(data: Path, tmp_path: Path) -> None:
    dst = tmp_path / "ct1"
    shutil.copytree(data / "ct1", dst)
    index = LibraryIndex.scan(dst, use_cache=False)
    mip = next(e for e in index.image_series() if "MIP" in e.series_description and "MinIP" not in e.series_description)
    victim = sorted(mip.paths, key=lambda p: pydicom.dcmread(p, stop_before_pixels=True).ImagePositionPatient[2])[20]
    Path(victim).unlink()  # 中間漏一張 → DL12
    index = LibraryIndex.scan(dst, use_cache=False)
    ds = build_case_dataset(index, select_all(index))
    assert ds.temporal_groups and ds.primary.temporal_group_id is not None  # 4D 組照樣開
    assert mip.series_instance_uid not in {s.series_id for s in ds.series}
    assert any("沒有載入" in w and "DL12" in w for w in ds.notes["case"]["warnings"])
    # 使用者指定它當 primary → 擋
    sel = select_all(index)
    sel = CaseSelection.from_wire({**sel.to_wire(), "primary_series_uid": mip.series_instance_uid})
    with pytest.raises(ContractViolation, match="DL12"):
        build_case_dataset(index, sel)


# ── Gamma Knife ────────────────────────────────────────────────────────────────


def _plan(path: Path, *, manufacturer: str, model: str, machine: str) -> Path:
    meta = FileMetaDataset()
    meta.MediaStorageSOPClassUID = "1.2.840.10008.5.1.4.1.1.481.5"
    meta.MediaStorageSOPInstanceUID = generate_uid()
    meta.TransferSyntaxUID = ExplicitVRLittleEndian
    ds = pydicom.FileDataset(str(path), {}, file_meta=meta, preamble=b"\0" * 128)
    ds.SOPClassUID = meta.MediaStorageSOPClassUID
    ds.SOPInstanceUID = meta.MediaStorageSOPInstanceUID
    ds.Modality = "RTPLAN"
    ds.Manufacturer = manufacturer
    ds.ManufacturerModelName = model
    ds.FrameOfReferenceUID = generate_uid()
    beams = []
    for n, iso in enumerate(([-35.1, -23.7, -33.0], [-33.4, -23.3, -35.2]), start=1):
        b = Dataset()
        b.BeamNumber = n
        b.BeamName = f"A{n}"
        b.TreatmentMachineName = machine
        b.BeamType = "STATIC"
        b.RadiationType = "PHOTON"
        cp = Dataset()
        cp.GantryAngle = 0
        cp.IsocenterPosition = iso
        cp.NominalBeamEnergy = 1.25
        b.ControlPointSequence = [cp]
        b.PrimaryDosimeterUnit = "MINUTE"
        cp.DoseRateSet = 2.0
        beams.append(b)
    ds.BeamSequence = beams
    fg = Dataset()
    fg.NumberOfFractionsPlanned = 1
    refs = []
    for n, (minutes, gy) in enumerate(((6.0, 1.7), (1.5, 0.1)), start=1):
        rb = Dataset()
        rb.ReferencedBeamNumber = n
        rb.BeamMeterset = minutes
        rb.BeamDose = gy
        refs.append(rb)
    fg.ReferencedBeamSequence = refs
    ds.FractionGroupSequence = [fg]
    ds.save_as(path, enforce_file_format=True)
    return path


def test_gamma_knife_plans_are_recognised(tmp_path: Path) -> None:
    gk = read_plan_beams(_plan(tmp_path / "gk.dcm", manufacturer="Elekta", model="GammaPlan", machine="PFX"))
    assert gk["technique"] == "gamma_knife" and len(gk["isocenters"]) == 2
    anon = read_plan_beams(_plan(tmp_path / "gk2.dcm", manufacturer="", model="", machine="ICON"))
    assert anon["technique"] == "gamma_knife"
    linac = read_plan_beams(
        _plan(tmp_path / "tb.dcm", manufacturer="Varian Medical Systems", model="ARIA RadOnc", machine="TrueBeam1")
    )
    assert linac["technique"] == "external_beam" and "shot" not in linac["beams"][0]
    assert linac["beams"][0]["beam_dose_gy"] == pytest.approx(1.7)


def test_gamma_knife_shots_carry_beam_on_time_and_relative_weight(tmp_path: Path) -> None:
    """照射時間（MINUTE）、權重 ＝ ÷ 最長的、處方點貢獻；准直器 DICOM 沒有 → None。"""
    gk = read_plan_beams(_plan(tmp_path / "gk.dcm", manufacturer="Elekta", model="GammaPlan", machine="PFX"))
    a1, a2 = gk["beams"]
    assert a1["shot"] == {"beam_on_min": 6.0, "weight": 1.0, "dose_rate": 2.0, "collimator_mm": None}
    assert a2["shot"]["weight"] == pytest.approx(0.25) and a2["shot"]["beam_on_min"] == 1.5
    assert a2["beam_dose_gy"] == pytest.approx(0.1)


# ── Enhanced 多幀的 RS 參照 ──────────────────────────────────────────────────────


def test_enhanced_rtstruct_references_carry_the_frame_number(data: Path) -> None:
    index = LibraryIndex.scan(data / "ct5", use_cache=False)
    ds = build_case_dataset(index, select_all(index))
    prim = ds.primary
    sops = prim.frame_slice_sop_uids[3]
    uid = next(iter(index.image_series())).instances[0].sop_instance_uid
    assert {s.partition("#")[0] for s in sops} == {uid}
    assert [int(s.partition("#")[2]) for s in sops] == list(range(121, 161))  # 第 4 個相位 ＝ 第 121–160 幀
    g = prim.grid
    mask = np.zeros(tuple(reversed(g.size)), dtype=bool)
    mask[18:22, 60:70, 60:70] = True
    rs = build_rtstruct(
        structures=[{"structure_id": "s", "name": "GTV", "color_rgb": [255, 0, 0], "mask_dense": mask}],
        grid=Grid(
            size=g.size,
            spacing=g.spacing,
            origin=g.origin,
            direction=g.direction,
            frame_of_reference_uid=g.frame_of_reference_uid,
        ),
        series_uid=prim.series_id,
        study_uid="1.2.3",
        frame_of_reference_uid=g.frame_of_reference_uid,
        slice_sop_uids=sops,
        image_sop_class_uid=prim.sop_class_uid,
    )
    refs = rs.ReferencedFrameOfReferenceSequence[0].RTReferencedStudySequence[0].RTReferencedSeriesSequence[0]
    assert {c.ReferencedSOPInstanceUID for c in refs.ContourImageSequence} == {uid}
    assert sorted(int(c.ReferencedFrameNumber) for c in refs.ContourImageSequence) == list(range(121, 161))
    contour = rs.ROIContourSequence[0].ContourSequence[0].ContourImageSequence[0]
    assert contour.ReferencedSOPInstanceUID == uid and 121 <= int(contour.ReferencedFrameNumber) <= 160
    assert str(contour.ReferencedSOPClassUID) == "1.2.840.10008.5.1.4.1.1.2.1"  # Enhanced CT


def test_a_phase_with_broken_geometry_is_excluded_from_the_timeline(data: Path, tmp_path: Path) -> None:
    """時間軸某一幀的幾何壞了（這裡：幾片斜了 → DL6）→ 那一幀排除並警告（以前 `exc.message` AttributeError）。"""
    dst = tmp_path / "ct1"
    shutil.copytree(data / "ct1", dst)
    index = LibraryIndex.scan(dst, use_cache=False)
    p50 = next(e for e in index.image_series() if e.series_description.endswith(" 50%"))
    first = p50.instances[0].path  # 分組看第一片的方向：斜的放在中間，才會走到「組成了、算幾何時才失敗」那條路
    middle = [Path(h.path) for h in p50.instances[10:13] if h.path != first]
    _rewrite(middle, ImageOrientationPatient=[1, 0, 0, 0, 0.999, 0.0447])
    index = LibraryIndex.scan(dst, use_cache=False)
    ds = build_case_dataset(index, select_all(index))
    (tg,) = ds.temporal_groups
    assert tg.frame_count == 9 and "50%" not in (tg.frame_labels or ())
    assert any("50%" in w and "已排除" in w for w in ds.notes["case"]["warnings"])


# ── PET：Bq/ml 超過 int16、沒有窗位標籤 ─────────────────────────────────────────


def test_values_beyond_int16_saturate_instead_of_wrapping(data: Path, tmp_path: Path) -> None:
    from rtgaia_core.loaders.dicom import read_pixels

    dst = tmp_path / "hot"
    shutil.copytree(data / "ct1", dst, ignore=shutil.ignore_patterns("RS", "RD"))
    index = LibraryIndex.scan(dst, use_cache=False)
    p0 = next(e for e in index.image_series() if e.series_description.endswith(" 0%"))
    _rewrite([Path(p) for p in p0.paths], RescaleSlope=60, RescaleIntercept=0)  # 原始值 × 60 → 遠超過 32767
    index = LibraryIndex.scan(dst, use_cache=False)
    hs = next(e for e in index.image_series() if e.series_description.endswith(" 0%")).instances
    vol = read_pixels(series_geometry(list(hs)))
    assert int(vol.max()) == 32767 and int(vol.min()) >= 0  # 以前繞回負數


def test_pet_without_window_tags_gets_a_window_from_its_pixels(data: Path) -> None:
    from rtgaia_core.loaders.dicom import with_estimated_window

    hs = [replace(h, modality="PT", window_center=None, window_width=None) for h in _phase0_headers(data)]
    g = series_geometry(hs)
    assert g.default_window == (40.0, 400.0)  # 只看標頭時退回 CT 的預設
    est = with_estimated_window(g, hs)
    lo, hi = est.default_window[0] - est.default_window[1] / 2, est.default_window[0] + est.default_window[1] / 2
    assert lo <= -900 and hi > 0 and est.default_window != (40.0, 400.0)
    ct = [replace(h, window_center=None, window_width=None) for h in _phase0_headers(data)]
    assert with_estimated_window(series_geometry(ct), ct).default_window == (40.0, 400.0)  # CT 的 HU 是絕對的，不估


# ── 開發庫：同一個 FoR 有好幾組影像 ──────────────────────────────────────────────


@pytest.mark.db
def test_case_with_several_images_in_one_frame_of_reference_persists(data: Path, tmp_path: Path, monkeypatch) -> None:  # type: ignore[no-untyped-def]
    """4D 組 ＋ AVG／MIP／MinIP 同一個 FoR：以前每組影像一個 FrameGroup → 存進 `case_frame_group`（主鍵 case＋FoR）
    UniqueViolation，開發庫上開 4DCT 500（量測堆疊沒有 DB 所以沒踩到）。FrameGroup 依 FoR 一個、primary 那組留下。"""
    import os

    db_url = os.environ.get("RTGAIA_TEST_DB_URL", "")
    if not db_url:
        pytest.skip("RTGAIA_TEST_DB_URL 未設")
    from rtgaia_server.db.migrate import downgrade_base, upgrade_to_head

    monkeypatch.setenv("RTGAIA_DATA_DIR", str(tmp_path / "data"))
    downgrade_base(db_url)
    upgrade_to_head(db_url)
    sel = select_all(LibraryIndex.scan(data / "ct1", use_cache=False)).to_wire()
    with Session(library_root=str(data / "ct1"), db_url=db_url, auth="off", user="dr") as s:
        out = s.load_case(sel, webgl2=False, tier="C")  # 以前：500 UniqueViolation case_frame_group_pkey
        before = [(fg["series_id"], fg["role"]) for fg in s.grid_set["frame_groups"]]
    assert len(before) == 4 and [r for _, r in before].count("primary") == 1  # 4D 組 ＋ AVG／MIP／MinIP，同一個 FoR
    with Session(library_root=str(data / "ct1"), db_url=db_url, auth="off", user="dr") as s2:
        again = s2.load_case(sel, webgl2=False, tier="C")  # 從 DB 重組：每組影像保留自己的 series_id 與角色
        assert again["case_id"] == out["case_id"]
        assert [(fg["series_id"], fg["role"]) for fg in s2.grid_set["frame_groups"]] == before
