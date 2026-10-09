"""合成的迷你 DICOM 病例 —— CI 用，**零 PHI、完全確定性**。

用 pydicom 產生一個典型放療病例的迷你版（計畫 ＋ 一次治療的 CBCT）：

* 計畫 CT（FoR A，16×16×6，2 mm）＋ RTSTRUCT（球）＋ RTPLAN ＋ RTDOSE（自己的 4 mm 網格）
* CBCT（FoR B，12×12×5，2 mm，不同原點）＋ RTSTRUCT ＋ RTDOSE
* REG（FoR A 為參考）：B→A 為**非對稱平移 ＋ 繞 z 5°**（轉錯 row/column-major 必 fail）

每個物件的真值（球心、矩陣、劑量最大值）都回傳給測試斷言。
"""

from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path

import numpy as np
import pydicom
from pydicom.dataset import Dataset, FileDataset, FileMetaDataset
from pydicom.sequence import Sequence
from pydicom.uid import ExplicitVRLittleEndian

CT_SOP = "1.2.840.10008.5.1.4.1.1.2"
RTSTRUCT_SOP = "1.2.840.10008.5.1.4.1.1.481.3"
RTDOSE_SOP = "1.2.840.10008.5.1.4.1.1.481.2"
RTPLAN_SOP = "1.2.840.10008.5.1.4.1.1.481.5"
REG_SOP = "1.2.840.10008.5.1.4.1.1.66.1"

PATIENT_ID = "SYNTH-0001"
ROOT_UID = "1.2.826.0.1.3680043.8.498.777"


@dataclass
class SynthImage:
    series_uid: str
    frame_of_reference_uid: str
    study_uid: str
    origin: tuple[float, float, float]
    spacing: tuple[float, float, float]
    size: tuple[int, int, int]
    """`(cols, rows, slices)` ＝ `(i, j, k)`。"""
    series_date: str
    description: str
    sphere_center_world: tuple[float, float, float]
    sphere_radius_mm: float
    directory: Path
    sop_uids: list[str] = field(default_factory=list)


@dataclass
class SynthCase:
    root: Path
    plan_ct: SynthImage
    cbct: SynthImage
    plan_rs_uid: str
    cbct_rs_uid: str
    plan_dose_uid: str
    cbct_dose_uid: str
    plan_uid: str
    plan_sop_uid: str
    reg_uid: str
    reg_sop_uid: str
    matrix_b_to_a: np.ndarray
    """row-major 4×4，CBCT（B）→ 計畫 CT（A）。"""
    plan_dose_max_gy: float
    cbct_dose_max_gy: float
    plan_dose_grid: dict[str, object]


def _uid(*parts: object) -> str:
    """合法的 UID：只有數字與點（VR UI）。非數字的名稱部件以 crc32 轉成穩定的數字（同名同號、可讀性靠 `_uid_names`）。

    先前直接串字串（`…777.series.planct`），每個合成檔都讓 pydicom 警告一次，
    全套測試累積數千則，真正的新警告就被埋掉了。
    """
    import zlib

    out = [ROOT_UID]
    for p in parts:
        text = str(p)
        # 數字部件去掉前導 0（`series_uid[-6:]` 可能是 `024035` → 不合法的 UI 元件）
        out.append(str(int(text)) if text.isdigit() else str(zlib.crc32(text.encode("utf-8")) % 10**8))
    uid = ".".join(out)
    assert len(uid) <= 64, uid
    return uid


def _file(
    sop_class: str,
    sop_uid: str,
    modality: str,
    image: SynthImage | None,
    *,
    series_uid: str,
    series_date: str,
    description: str,
) -> FileDataset:
    meta = FileMetaDataset()
    meta.MediaStorageSOPClassUID = sop_class
    meta.MediaStorageSOPInstanceUID = sop_uid
    meta.TransferSyntaxUID = ExplicitVRLittleEndian
    meta.ImplementationClassUID = _uid("impl")
    ds = FileDataset(None, {}, file_meta=meta, preamble=b"\0" * 128)
    ds.SOPClassUID = sop_class
    ds.SOPInstanceUID = sop_uid
    ds.Modality = modality
    ds.PatientID = PATIENT_ID
    ds.PatientName = "Synthetic^Case"
    ds.StudyInstanceUID = image.study_uid if image else _uid("study")
    ds.StudyDate = "20260601"
    ds.StudyDescription = "Synthetic pelvis"
    ds.SeriesInstanceUID = series_uid
    ds.SeriesDate = series_date
    ds.SeriesTime = "120000"
    ds.SeriesDescription = description
    ds.SeriesNumber = "1"
    ds.Manufacturer = "RT-Gaia"
    ds.ManufacturerModelName = "synth"
    return ds


def _write_ct(image: SynthImage, *, model_name: str, value_fn) -> None:
    image.directory.mkdir(parents=True, exist_ok=True)
    ni, nj, nk = image.size
    for k in range(nk):
        sop = _uid("ct", image.series_uid[-6:], k)
        image.sop_uids.append(sop)
        ds = _file(
            CT_SOP,
            sop,
            "CT",
            image,
            series_uid=image.series_uid,
            series_date=image.series_date,
            description=image.description,
        )
        ds.ManufacturerModelName = model_name
        ds.FrameOfReferenceUID = image.frame_of_reference_uid
        ds.InstanceNumber = k + 1
        ds.Rows, ds.Columns = nj, ni
        ds.PixelSpacing = [image.spacing[1], image.spacing[0]]
        ds.SliceThickness = image.spacing[2]
        ds.ImageOrientationPatient = [1, 0, 0, 0, 1, 0]
        ds.ImagePositionPatient = [image.origin[0], image.origin[1], image.origin[2] + k * image.spacing[2]]
        ds.RescaleIntercept = -1024
        ds.RescaleSlope = 1
        ds.BitsAllocated, ds.BitsStored, ds.HighBit = 16, 16, 15
        ds.PixelRepresentation = 0
        ds.SamplesPerPixel = 1
        ds.PhotometricInterpretation = "MONOCHROME2"
        ds.WindowCenter, ds.WindowWidth = 40, 400
        jj, ii = np.meshgrid(np.arange(nj), np.arange(ni), indexing="ij")
        hu = value_fn(ii, jj, k)
        ds.PixelData = (hu + 1024).astype(np.uint16).tobytes()
        ds.save_as(str(image.directory / f"CT.{k:03d}.dcm"), enforce_file_format=True)


def _write_rtstruct(path: Path, image: SynthImage, *, series_uid: str, label: str, roi_names: list[str]) -> str:
    sop = _uid("rs", series_uid[-6:])
    ds = _file(
        RTSTRUCT_SOP,
        sop,
        "RTSTRUCT",
        image,
        series_uid=series_uid,
        series_date=image.series_date,
        description="Structure Sets",
    )
    ds.StructureSetLabel = label
    ds.StructureSetDate = image.series_date
    ds.FrameOfReferenceUID = image.frame_of_reference_uid
    rf = Dataset()
    rf.FrameOfReferenceUID = image.frame_of_reference_uid
    st = Dataset()
    st.ReferencedSOPClassUID = "1.2.840.10008.3.1.2.3.1"
    st.ReferencedSOPInstanceUID = image.study_uid
    se = Dataset()
    se.SeriesInstanceUID = image.series_uid
    se.ContourImageSequence = Sequence([])
    st.RTReferencedSeriesSequence = Sequence([se])
    rf.RTReferencedStudySequence = Sequence([st])
    ds.ReferencedFrameOfReferenceSequence = Sequence([rf])

    rois, contours, obs = [], [], []
    cx, cy, cz = image.sphere_center_world
    for n, name in enumerate(roi_names, start=1):
        radius = image.sphere_radius_mm if n == 1 else image.sphere_radius_mm * 0.5
        roi = Dataset()
        roi.ROINumber = n
        roi.ReferencedFrameOfReferenceUID = image.frame_of_reference_uid
        roi.ROIName = name
        roi.ROIGenerationAlgorithm = "MANUAL"
        rois.append(roi)
        rc = Dataset()
        rc.ReferencedROINumber = n
        rc.ROIDisplayColor = [255, 0, 0] if n == 1 else [0, 255, 0]
        seq = []
        for k in range(image.size[2]):
            z = image.origin[2] + k * image.spacing[2]
            r2 = radius**2 - (z - cz) ** 2
            if r2 <= 0:
                continue
            r = float(np.sqrt(r2))
            ang = np.linspace(0, 2 * np.pi, 48, endpoint=False)
            pts = np.stack([cx + r * np.cos(ang), cy + r * np.sin(ang), np.full_like(ang, z)], axis=1)
            c = Dataset()
            c.ContourGeometricType = "CLOSED_PLANAR"
            c.NumberOfContourPoints = len(pts)
            c.ContourData = [float(f"{v:.4f}") for v in pts.flatten()]
            ci = Dataset()
            ci.ReferencedSOPClassUID = CT_SOP
            ci.ReferencedSOPInstanceUID = image.sop_uids[k]
            c.ContourImageSequence = Sequence([ci])
            seq.append(c)
        rc.ContourSequence = Sequence(seq)
        contours.append(rc)
        ob = Dataset()
        ob.ObservationNumber = n
        ob.ReferencedROINumber = n
        ob.RTROIInterpretedType = "EXTERNAL" if n == 1 else "PTV"
        obs.append(ob)
    ds.StructureSetROISequence = Sequence(rois)
    ds.ROIContourSequence = Sequence(contours)
    ds.RTROIObservationsSequence = Sequence(obs)
    ds.save_as(str(path), enforce_file_format=True)
    return sop


def _bld_positions(
    *, a: float, jaw_x: tuple[float, float] | None = None, jaw_y: tuple[float, float] | None = None
) -> Sequence:
    """控制點的 jaw ＋ MLC 位置（60 對 MLCX；|y| < 20 mm 的 8 對開在 [a, 30]，其餘關在 0）。"""
    items = []
    for kind, values in (("X", jaw_x), ("Y", jaw_y)):
        if values is not None:
            it = Dataset()
            it.RTBeamLimitingDeviceType = kind
            it.LeafJawPositions = list(values)
            items.append(it)
    centers = [-150 + 5 * i + 2.5 for i in range(60)]
    open_ = [abs(c) < 20 for c in centers]
    mlc = Dataset()
    mlc.RTBeamLimitingDeviceType = "MLCX"
    mlc.LeafJawPositions = [a if o else 0.0 for o in open_] + [30.0 if o else 0.0 for o in open_]
    items.append(mlc)
    return Sequence(items)


def _write_plan(path: Path, image: SynthImage, *, series_uid: str, rs_sop: str, label: str) -> str:
    sop = _uid("plan", series_uid[-6:])
    ds = _file(
        RTPLAN_SOP, sop, "RTPLAN", image, series_uid=series_uid, series_date=image.series_date, description=label
    )
    ds.RTPlanLabel = label
    ds.RTPlanDate = image.series_date
    ds.FrameOfReferenceUID = image.frame_of_reference_uid
    rs = Dataset()
    rs.ReferencedSOPClassUID = RTSTRUCT_SOP
    rs.ReferencedSOPInstanceUID = rs_sop
    ds.ReferencedStructureSetSequence = Sequence([rs])
    dr = Dataset()
    dr.DoseReferenceNumber = 1
    dr.DoseReferenceStructureType = "SITE"
    dr.DoseReferenceType = "TARGET"
    dr.TargetPrescriptionDose = 50.0
    ds.DoseReferenceSequence = Sequence([dr])
    fg = Dataset()
    fg.FractionGroupNumber = 1
    fg.NumberOfFractionsPlanned = 25
    # 射束 —— Eclipse 的習慣是 setup 射野排第一個（BeamNumber 1），治療射束 2、3；等中心 ＝ 球心
    iso = [float(v) for v in image.sphere_center_world]
    setup = Dataset()
    setup.PatientSetupNumber = 1
    setup.PatientPosition = "HFS"
    ds.PatientSetupSequence = Sequence([setup])

    def beam(number: int, name: str, delivery: str, kind: str, cps: list[dict[str, object]]) -> Dataset:
        b = Dataset()
        b.BeamNumber = number
        b.BeamName = name
        b.BeamType = kind
        b.RadiationType = "PHOTON"
        b.TreatmentDeliveryType = delivery
        b.TreatmentMachineName = "SYNTH_LINAC"
        b.Manufacturer = "Synthetic"
        b.ManufacturerModelName = "SynthBeam"
        b.PrimaryDosimeterUnit = "MU"
        b.SourceAxisDistance = 1000.0
        devs = []
        for t, n in (("X", 1), ("Y", 1), ("MLCX", 60)):
            d = Dataset()
            d.RTBeamLimitingDeviceType = t
            d.NumberOfLeafJawPairs = n
            if t == "MLCX":
                d.LeafPositionBoundaries = [float(v) for v in range(-150, 151, 5)]  # 60 對、5 mm
            devs.append(d)
        b.BeamLimitingDeviceSequence = Sequence(devs)
        items = []
        for i, cp in enumerate(cps):
            c = Dataset()
            c.ControlPointIndex = i
            for k, v in cp.items():
                setattr(c, k, v)
            items.append(c)
        b.ControlPointSequence = Sequence(items)
        b.NumberOfControlPoints = len(items)
        b.FinalCumulativeMetersetWeight = 1.0
        return b

    first = {
        "NominalBeamEnergy": 6,
        "BeamLimitingDeviceAngle": 30.0,
        "PatientSupportAngle": 0.0,
        "IsocenterPosition": iso,
    }
    ds.BeamSequence = Sequence(
        [
            beam(1, "kV CBCT", "SETUP", "STATIC", [{**first, "GantryAngle": 0.0, "GantryRotationDirection": "NONE"}]),
            beam(
                2,
                "ARC1",
                "TREATMENT",
                "DYNAMIC",
                [
                    # jaw ＋ MLC 位置只寫在有變的 CP（第三個沿用第二個的）；累積權重 0 → 0.5 → 1
                    {
                        **first,
                        "GantryAngle": 181.0,
                        "GantryRotationDirection": "CW",
                        "CumulativeMetersetWeight": 0.0,
                        "BeamLimitingDevicePositionSequence": _bld_positions(
                            jaw_x=(-50.0, 50.0), jaw_y=(-40.0, 40.0), a=-20.0
                        ),
                    },
                    {
                        "GantryAngle": 0.0,
                        "CumulativeMetersetWeight": 0.5,
                        "BeamLimitingDevicePositionSequence": _bld_positions(a=-10.0),
                    },
                    {"GantryAngle": 179.0, "CumulativeMetersetWeight": 1.0},
                ],
            ),
            beam(
                3,
                "AP",
                "TREATMENT",
                "STATIC",
                [{**first, "GantryAngle": 0.0, "GantryRotationDirection": "NONE", "BeamLimitingDeviceAngle": 0.0}, {}],
            ),
        ]
    )
    refs = []
    for number, mu in ((2, 250.5), (3, 120.0)):
        rb = Dataset()
        rb.ReferencedBeamNumber = number
        rb.BeamMeterset = mu
        refs.append(rb)
    fg.ReferencedBeamSequence = Sequence(refs)
    ds.FractionGroupSequence = Sequence([fg])
    ds.save_as(str(path), enforce_file_format=True)
    return sop


def _write_dose(
    path: Path,
    image: SynthImage,
    *,
    series_uid: str,
    plan_sop: str | None,
    origin: tuple[float, float, float],
    spacing: tuple[float, float, float],
    size: tuple[int, int, int],
    peak_gy: float,
    decreasing_z: bool = False,
    units: str = "GY",
    scaling_override: str | None = None,
) -> tuple[str, float, dict[str, object]]:
    sop = _uid("dose", series_uid[-6:])
    ds = _file(
        RTDOSE_SOP,
        sop,
        "RTDOSE",
        image,
        series_uid=series_uid,
        series_date=image.series_date,
        description="Synthetic Doses",
    )
    ni, nj, nk = size
    ds.FrameOfReferenceUID = image.frame_of_reference_uid
    ds.Rows, ds.Columns, ds.NumberOfFrames = nj, ni, nk
    ds.PixelSpacing = [spacing[1], spacing[0]]
    ds.ImageOrientationPatient = [1, 0, 0, 0, 1, 0]
    ds.ImagePositionPatient = list(origin)
    offsets = [(-k if decreasing_z else k) * spacing[2] for k in range(nk)]
    ds.GridFrameOffsetVector = offsets
    ds.FrameIncrementPointer = (0x3004, 0x000C)
    ds.DoseUnits = units
    ds.DoseType = "PHYSICAL"
    ds.DoseSummationType = "PLAN"
    ds.BitsAllocated, ds.BitsStored, ds.HighBit = 32, 32, 31
    ds.PixelRepresentation = 0
    ds.SamplesPerPixel = 1
    ds.PhotometricInterpretation = "MONOCHROME2"
    if plan_sop:
        rp = Dataset()
        rp.ReferencedSOPClassUID = RTPLAN_SOP
        rp.ReferencedSOPInstanceUID = plan_sop
        ds.ReferencedRTPlanSequence = Sequence([rp])
    # 高斯劑量團，中心在球心；以 scaling 量化成 uint32
    kk, jj, ii = np.meshgrid(np.arange(nk), np.arange(nj), np.arange(ni), indexing="ij")
    x = origin[0] + ii * spacing[0]
    y = origin[1] + jj * spacing[1]
    z = origin[2] + (np.asarray(offsets)[kk])
    cx, cy, cz = image.sphere_center_world
    dose = peak_gy * np.exp(-((x - cx) ** 2 + (y - cy) ** 2 + (z - cz) ** 2) / (2 * (image.sphere_radius_mm) ** 2))
    scaling = float(peak_gy) / (2**31)
    ds.DoseGridScaling = scaling_override if scaling_override is not None else f"{scaling:.9e}"  # DS ≤ 16 字
    quant = np.rint(dose / scaling).astype(np.uint32)
    ds.PixelData = quant.tobytes()
    ds.save_as(str(path), enforce_file_format=True)
    grid_truth = {"origin": origin, "spacing": spacing, "size": size, "decreasing_z": decreasing_z}
    return sop, float(quant.max()) * scaling, grid_truth


def _write_reg(
    path: Path, *, target: SynthImage, source: SynthImage, matrix_b_to_a: np.ndarray, series_uid: str
) -> str:
    sop = _uid("reg", series_uid[-6:])
    ds = _file(REG_SOP, sop, "REG", target, series_uid=series_uid, series_date=source.series_date, description="")
    ds.FrameOfReferenceUID = target.frame_of_reference_uid
    ds.ContentLabel = "SYNTH_REG"

    def item(for_uid: str, m: np.ndarray, image: SynthImage) -> Dataset:
        it = Dataset()
        it.FrameOfReferenceUID = for_uid
        mreg = Dataset()
        mseq = Dataset()
        mseq.FrameOfReferenceTransformationMatrixType = "RIGID"
        mseq.FrameOfReferenceTransformationMatrix = [float(f"{v:.10f}") for v in m.flatten()]
        mreg.MatrixSequence = Sequence([mseq])
        it.MatrixRegistrationSequence = Sequence([mreg])
        refs = []
        for s in image.sop_uids:
            r = Dataset()
            r.ReferencedSOPClassUID = CT_SOP
            r.ReferencedSOPInstanceUID = s
            refs.append(r)
        it.ReferencedImageSequence = Sequence(refs)
        return it

    ds.RegistrationSequence = Sequence(
        [
            item(source.frame_of_reference_uid, matrix_b_to_a, source),
            item(target.frame_of_reference_uid, np.eye(4), target),
        ]
    )
    rs = []
    for image in (source, target):
        r = Dataset()
        r.SeriesInstanceUID = image.series_uid
        rs.append(r)
    ds.ReferencedSeriesSequence = Sequence(rs)
    ds.save_as(str(path), enforce_file_format=True)
    return sop


def write_synth_case(root: str | Path) -> SynthCase:
    """在 `root` 下寫出 `plan_0/`、`fx_1/` 兩個目錄（計畫與一次治療，同真實匯出的目錄版型）。"""
    root = Path(root)
    study = _uid("study", 1)
    for_a, for_b = _uid("for", "A"), _uid("for", "B")

    plan_ct = SynthImage(
        series_uid=_uid("series", "planct"),
        frame_of_reference_uid=for_a,
        study_uid=study,
        origin=(-16.0, -16.0, -6.0),
        spacing=(2.0, 2.0, 2.0),
        size=(16, 16, 6),
        series_date="20260601",
        description="Pelvis 2.0 synthetic",
        sphere_center_world=(0.0, 2.0, 0.0),
        sphere_radius_mm=7.0,
        directory=root / "plan_0" / "CT",
    )
    # B 相對 A：平移 (5, -8, 3) ＋ 繞 z 5°；CBCT 的球心在 B 座標下 ＝ inv(M) · A 座標的球心
    theta = np.deg2rad(5.0)
    m = np.eye(4)
    m[:3, :3] = [[np.cos(theta), -np.sin(theta), 0], [np.sin(theta), np.cos(theta), 0], [0, 0, 1]]
    m[:3, 3] = [5.0, -8.0, 3.0]
    center_a = np.array([*plan_ct.sphere_center_world, 1.0])
    center_b = np.linalg.inv(m) @ center_a
    cbct = SynthImage(
        series_uid=_uid("series", "cbct1"),
        frame_of_reference_uid=for_b,
        study_uid=study,
        origin=(float(center_b[0]) - 12.0, float(center_b[1]) - 12.0, float(center_b[2]) - 4.0),
        spacing=(2.0, 2.0, 2.0),
        size=(12, 12, 5),
        series_date="20260605",
        description="ART iCBCT synthetic",
        sphere_center_world=(float(center_b[0]), float(center_b[1]), float(center_b[2])),
        sphere_radius_mm=6.0,
        directory=root / "fx_1" / "CT",
    )

    def plan_values(ii, jj, k):
        # 軟組織底 ＋ 一個亮方塊，讓 Rescale 有東西可驗
        v = np.full(ii.shape, 40, dtype=np.int32)
        v[(ii >= 4) & (ii < 8) & (jj >= 4) & (jj < 8)] = 300 + k
        return v

    def cbct_values(ii, jj, k):
        v = np.full(ii.shape, 20, dtype=np.int32)
        v[(ii + jj + k) % 3 == 0] = 60
        return v

    _write_ct(plan_ct, model_name="SOMATOM synthetic", value_fn=plan_values)
    _write_ct(cbct, model_name="Halcyon synthetic", value_fn=cbct_values)

    plan_rs_uid = _uid("series", "planrs")
    plan_rs_sop = _write_rtstruct(
        root / "plan_0" / "rs.dcm", plan_ct, series_uid=plan_rs_uid, label="CT_20260601", roi_names=["BODY", "PTV"]
    )
    cbct_rs_uid = _uid("series", "cbctrs")
    _write_rtstruct(
        root / "fx_1" / "rs.dcm",
        cbct,
        series_uid=cbct_rs_uid,
        label="ART_20260605",
        roi_names=["BODY", "PTV", "Bladder"],
    )

    plan_uid = _uid("series", "plan")
    plan_sop = _write_plan(
        root / "plan_0" / "plan.dcm", plan_ct, series_uid=plan_uid, rs_sop=plan_rs_sop, label="SYNTH-ART1"
    )

    plan_dose_uid = _uid("series", "plandose")
    _, plan_max, plan_dose_grid = _write_dose(
        root / "plan_0" / "dose.dcm",
        plan_ct,
        series_uid=plan_dose_uid,
        plan_sop=plan_sop,
        origin=(-14.0, -12.0, -5.0),
        spacing=(4.0, 4.0, 2.0),
        size=(8, 7, 6),
        peak_gy=52.5,
    )
    cbct_dose_uid = _uid("series", "cbctdose")
    _, cbct_max, _ = _write_dose(
        root / "fx_1" / "dose.dcm",
        cbct,
        series_uid=cbct_dose_uid,
        plan_sop=None,
        origin=(cbct.origin[0] + 2.0, cbct.origin[1] + 2.0, cbct.origin[2] + 8.0),
        spacing=(4.0, 4.0, 2.0),
        size=(6, 6, 5),
        peak_gy=2.1,
        decreasing_z=True,
    )
    reg_uid = _uid("series", "reg1")
    reg_sop = _write_reg(
        root / "fx_1" / "registration.dcm", target=plan_ct, source=cbct, matrix_b_to_a=m, series_uid=reg_uid
    )

    return SynthCase(
        root=root,
        plan_ct=plan_ct,
        cbct=cbct,
        plan_rs_uid=plan_rs_uid,
        cbct_rs_uid=cbct_rs_uid,
        plan_dose_uid=plan_dose_uid,
        cbct_dose_uid=cbct_dose_uid,
        plan_uid=plan_uid,
        plan_sop_uid=plan_sop,
        reg_uid=reg_uid,
        reg_sop_uid=reg_sop,
        matrix_b_to_a=m,
        plan_dose_max_gy=plan_max,
        cbct_dose_max_gy=cbct_max,
        plan_dose_grid=plan_dose_grid,
    )


if __name__ == "__main__":  # pragma: no cover - 手動檢視用
    import sys

    case = write_synth_case(sys.argv[1] if len(sys.argv) > 1 else "/tmp/rtgaia-synth")
    print(case.root, pydicom.__version__)
