"""4D／動態影像的合成 DICOM 測資（CT ＋ MR）—— 零 PHI、完全確定性。

用法：``uv run python -m rtgaia_testbe.fixtures.synth4d --out data/test_4d``
（``--only ct1,mr1`` 只產部分、``--list`` 列出）。

真實的 4D 資料要等科部匯出；在那之前，這裡把整理到的**每一種編碼方式**各做一組小病例。
每組一個病人（`SYN4D-…`），目錄裡有 ``expected.json``：正確的分組應該長怎樣（哪些序列／幀是一條時間軸、
順序、軸的種類、哪些是衍生影像或別的軸、應該出現的警告），以及真值（腫瘤每一幀的中心）。
**編碼依據**寫在每組的 ``source``；標 ``anecdotal`` 的只有論壇或單一資料集佐證，拿到真實資料要回來核對。

| id | 編碼 | 依據 |
|---|---|---|
| ct1 | 4DCT 每相位一個序列（`0%…90%`）＋ Average／T-MIP／T-MinIP；RS 在 AVG、0%、50%；劑量在 AVG | Siemens Cookbook |
| ct2 | `…, Gated, 40.0%`、`AVG`、`MIP`、`Non-Gated`（網格不同）；z 遞減儲存；每相位一個 RS | Philips／4D-Lung |
| ct3 | 振幅分箱：`In 0%…In 100%`、`Ex 75%…Ex 25%` | Siemens Cookbook |
| ct4 | 每相位一個序列，描述全部相同、只有 SeriesNumber／SeriesTime 不同（沒有相位標籤） | 推測的最差情況 |
| ct5 | Enhanced CT 一個檔：10 相位，Respiratory Synchronization ＋ Dimension Index | PS3.3 C.7.6.16.2.17、C.7.6.17 |
| ct6 | 跟 ct2 一樣，但 30% 少一片、70% 的 z 位移 1.5 mm | Pinnacle 論壇（z 不一致會播放失敗） |
| mr1 | DCE 一個序列；TemporalPositionIdentifier ＋ TriggerTime；InstanceNumber 打亂 | Philips／GE；dcm2niix |
| mr2 | DCE 一個序列；只用 AcquisitionNumber 分 volume（沒有 TPI） | Siemens XA classic（dcm2niix #689） |
| mr3 | DCE 每個時間點一個序列（描述相同、SeriesNumber 遞增） | Siemens VE fldyn3d1（dcm2niix #689） |
| mr4 | DCE 一個序列；只有 AcquisitionTime 不同 | GE ISPY1（anecdotal） |
| mr5 | 多回波一個序列（EchoNumbers 1–4）—— **不是時間** | dcm2niix 拆 `_e2`；Slicer 當參數軸 |
| mr6 | DWI 一個序列（b 0／500／1000，Siemens (0019,100C)）＋ 同序列的 ADC | Slicer MVI；dcm2niix Philips |
| mr7 | DCE 一個序列，混了相位影像（ImageType …\\P\\…） | dcm2niix #463（anecdotal） |
| mr8 | Enhanced MR 一個檔：TemporalPositionIndex ＋ FrameAcquisitionDateTime ＋ Dimension Index | PS3.3 C.7.6.16.2.2 |
| mr9 | 4D-MRI 呼吸門控一個序列（ImageType RESP_GATED、TPI 1–8）—— 週期軸 | PS3.3 C.8.16.1 defined term |
| mr10 | cine：單一矢狀切面 150 幀、0.25 s，只有 AcquisitionTime ＋ InstanceNumber | MR-Linac 匯出（TrackRAD2025） |
"""

from __future__ import annotations

import argparse
import json
import math
import zlib
from collections.abc import Callable, Iterable
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import numpy as np
from pydicom.dataset import Dataset, FileDataset, FileMetaDataset
from pydicom.sequence import Sequence
from pydicom.uid import ExplicitVRLittleEndian

ROOT_UID = "1.2.826.0.1.3680043.8.498.778"
CT_SOP = "1.2.840.10008.5.1.4.1.1.2"
ENHANCED_CT_SOP = "1.2.840.10008.5.1.4.1.1.2.1"
MR_SOP = "1.2.840.10008.5.1.4.1.1.4"
ENHANCED_MR_SOP = "1.2.840.10008.5.1.4.1.1.4.1"
RTSTRUCT_SOP = "1.2.840.10008.5.1.4.1.1.481.3"
RTDOSE_SOP = "1.2.840.10008.5.1.4.1.1.481.2"

STUDY_DATE = "20261001"
AXIAL = (1.0, 0.0, 0.0, 0.0, 1.0, 0.0)
SAGITTAL = (0.0, 1.0, 0.0, 0.0, 0.0, -1.0)

# 呼吸：0% ＝ 吸氣末（橫膈最低、腫瘤最下面），50% ＝ 吐氣末 —— 4D-Lung／Philips 的慣例
RESP_AMPLITUDE_MM = 12.0


def uid(*parts: object) -> str:
    out = [ROOT_UID]
    for p in parts:
        text = str(p)
        out.append(text if text.isdigit() else str(zlib.crc32(text.encode("utf-8")) % 10**8))
    value = ".".join(out)
    assert len(value) <= 64, value
    return value


@dataclass(frozen=True)
class Geom:
    """`size` ＝ (i, j, k)；`origin` 是第 0 片左上角像素中心；切片沿 row × col 的法線。"""

    size: tuple[int, int, int]
    spacing: tuple[float, float, float]
    origin: tuple[float, float, float]
    iop: tuple[float, ...] = AXIAL

    @property
    def normal(self) -> np.ndarray:
        return np.cross(np.asarray(self.iop[:3]), np.asarray(self.iop[3:]))

    def ipp(self, k: int, shift_mm: float = 0.0) -> list[float]:
        o = np.asarray(self.origin) + self.normal * (k * self.spacing[2] + shift_mm)
        return [round(float(v), 4) for v in o]

    def world(self, k: int, shift_mm: float = 0.0) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
        """這一片每個像素的 LPS 座標（`(rows, cols)` 三張）。"""
        ni, nj, _ = self.size
        jj, ii = np.meshgrid(np.arange(nj), np.arange(ni), indexing="ij")
        r, c = np.asarray(self.iop[:3]), np.asarray(self.iop[3:])
        p0 = np.asarray(self.ipp(k, shift_mm))
        pts = [p0[a] + r[a] * ii * self.spacing[0] + c[a] * jj * self.spacing[1] for a in range(3)]
        return pts[0], pts[1], pts[2]


@dataclass
class Case:
    """一組測資：一個病人、一個 study；`expected` 寫進 expected.json。"""

    case_id: str
    title: str
    modality: str
    pattern: str
    source: list[str]
    root: Path
    patient_id: str = ""
    study_uid: str = ""
    series: list[dict[str, Any]] = field(default_factory=list)
    expected: dict[str, Any] = field(default_factory=dict)
    truth: dict[str, Any] = field(default_factory=dict)

    def __post_init__(self) -> None:
        self.patient_id = f"SYN4D-{self.case_id.upper()}"
        self.study_uid = uid("study", self.case_id)
        self.root.mkdir(parents=True, exist_ok=True)

    def write_expected(self) -> None:
        doc = {
            "id": self.case_id,
            "title": self.title,
            "modality": self.modality,
            "pattern": self.pattern,
            "source": self.source,
            "patient_id": self.patient_id,
            "study_instance_uid": self.study_uid,
            "series": self.series,
            "expected": self.expected,
            "truth": self.truth,
        }
        (self.root / "expected.json").write_text(json.dumps(doc, ensure_ascii=False, indent=2), encoding="utf-8")


def _base(
    case: Case,
    *,
    sop_class: str,
    sop_uid: str,
    modality: str,
    series_uid: str,
    series_number: int,
    description: str,
    for_uid: str | None,
    series_time: str = "100000",
    manufacturer: str = "RT-Gaia synth4d",
) -> FileDataset:
    meta = FileMetaDataset()
    meta.MediaStorageSOPClassUID = sop_class
    meta.MediaStorageSOPInstanceUID = sop_uid
    meta.TransferSyntaxUID = ExplicitVRLittleEndian
    meta.ImplementationClassUID = uid("impl")
    ds = FileDataset(None, {}, file_meta=meta, preamble=b"\0" * 128)
    ds.SOPClassUID = sop_class
    ds.SOPInstanceUID = sop_uid
    ds.Modality = modality
    ds.PatientID = case.patient_id
    ds.PatientName = f"Synth4D^{case.case_id.upper()}"
    ds.PatientBirthDate = "19700101"
    ds.PatientSex = "O"
    ds.PatientPosition = "HFS"
    ds.StudyInstanceUID = case.study_uid
    ds.StudyID = case.case_id
    ds.StudyDate = STUDY_DATE
    ds.StudyTime = "090000"
    ds.StudyDescription = f"synth4d {case.case_id} {case.pattern}"[:64]
    ds.AccessionNumber = ""
    ds.ReferringPhysicianName = ""
    ds.SeriesInstanceUID = series_uid
    ds.SeriesNumber = series_number
    ds.SeriesDate = STUDY_DATE
    ds.SeriesTime = series_time
    ds.SeriesDescription = description
    ds.Manufacturer = manufacturer
    ds.ManufacturerModelName = "synth4d"
    if for_uid:
        ds.FrameOfReferenceUID = for_uid
        ds.PositionReferenceIndicator = ""
    return ds


def _pixel_module(ds: Dataset, rows: int, cols: int) -> None:
    ds.Rows, ds.Columns = rows, cols
    ds.BitsAllocated, ds.BitsStored, ds.HighBit = 16, 16, 15
    ds.PixelRepresentation = 0
    ds.SamplesPerPixel = 1
    ds.PhotometricInterpretation = "MONOCHROME2"


def _tm(seconds: float) -> str:
    """從 10:00:00 起算的 DICOM TM（含小數秒）。"""
    total = 36000.0 + seconds
    h, rem = divmod(total, 3600)
    m, s = divmod(rem, 60)
    return f"{int(h):02d}{int(m):02d}{s:09.6f}"


# ── 影像內容 ────────────────────────────────────────────────────────────────


def _ellipse(x: np.ndarray, y: np.ndarray, cx: float, cy: float, rx: float, ry: float) -> np.ndarray:
    return ((x - cx) / rx) ** 2 + ((y - cy) / ry) ** 2 <= 1.0


def tumor_offset_mm(fraction: float) -> float:
    """呼吸週期 `fraction`（0–1）時腫瘤的 SI 位移（LPS z，+ ＝ 頭側）：0 ＝ 吸氣末最低。"""
    return -RESP_AMPLITUDE_MM * (1.0 + math.cos(2 * math.pi * fraction)) / 2.0


TUMOR_REST_LPS = (-70.0, 10.0, 20.0)
"""腫瘤在吐氣末（位移 0）的中心：右肺（LPS x 負 ＝ 病人右側）。"""
TUMOR_RADIUS_MM = 14.0


def thorax_hu(geom: Geom, k: int, dz_mm: float, shift_mm: float = 0.0) -> np.ndarray:
    """胸腔假體的一片（HU）：身體、雙肺、脊椎、橫膈（跟著呼吸）、右肺腫瘤（跟著呼吸）。"""
    x, y, z = geom.world(k, shift_mm)
    hu = np.full(x.shape, -1000.0)
    body = _ellipse(x, y, 0, 0, 170, 120)
    hu[body] = 20.0
    for cx in (-75.0, 75.0):
        lung = _ellipse(x, y, cx, -5, 60, 75) & (z > -40.0 + dz_mm * 0.8)
        hu[lung] = -820.0
    hu[_ellipse(x, y, 0, 85, 18, 18)] = 700.0
    t = TUMOR_REST_LPS
    tumor = (x - t[0]) ** 2 + (y - t[1]) ** 2 + (z - (t[2] + dz_mm)) ** 2 <= TUMOR_RADIUS_MM**2
    hu[tumor] = 40.0
    return hu


def _ct_slice_file(
    case: Case,
    geom: Geom,
    *,
    series_uid: str,
    series_number: int,
    description: str,
    for_uid: str,
    k: int,
    hu: np.ndarray,
    image_type: list[str],
    shift_mm: float = 0.0,
    series_time: str = "100000",
    instance_number: int | None = None,
    extra: dict[str, Any] | None = None,
) -> str:
    sop = uid("ct", series_uid[-10:], k)
    ds = _base(
        case,
        sop_class=CT_SOP,
        sop_uid=sop,
        modality="CT",
        series_uid=series_uid,
        series_number=series_number,
        description=description,
        for_uid=for_uid,
        series_time=series_time,
    )
    ds.ImageType = image_type
    ds.InstanceNumber = instance_number if instance_number is not None else k + 1
    ds.AcquisitionNumber = 1
    ds.KVP = 120
    ds.ImageOrientationPatient = list(geom.iop)
    ds.ImagePositionPatient = geom.ipp(k, shift_mm)
    ds.SliceLocation = ds.ImagePositionPatient[2]
    ds.PixelSpacing = [geom.spacing[1], geom.spacing[0]]
    ds.SliceThickness = geom.spacing[2]
    ds.RescaleIntercept, ds.RescaleSlope = -1024, 1
    ds.WindowCenter, ds.WindowWidth = -600, 1600
    _pixel_module(ds, geom.size[1], geom.size[0])
    for key, value in (extra or {}).items():
        setattr(ds, key, value)
    ds.PixelData = np.clip(hu + 1024, 0, 4095).astype(np.uint16).tobytes()
    return _save(ds, case.root / f"S{series_number:03d}" / f"IM{k:04d}.dcm")


def _save(ds: FileDataset, path: Path) -> str:
    path.parent.mkdir(parents=True, exist_ok=True)
    ds.save_as(str(path), enforce_file_format=True)
    return str(ds.SOPInstanceUID)


CT_GEOM = Geom(size=(128, 128, 40), spacing=(3.5, 3.5, 3.0), origin=(-222.25, -222.25, -60.0))


@dataclass
class WrittenSeries:
    series_uid: str
    sop_uids: list[str]
    description: str
    geom: Geom
    shift_mm: float = 0.0
    missing: frozenset[int] = frozenset()


def _write_ct_series(
    case: Case,
    *,
    key: str,
    number: int,
    description: str,
    for_uid: str,
    values: Callable[[int], np.ndarray],
    image_type: list[str],
    geom: Geom = CT_GEOM,
    shift_mm: float = 0.0,
    series_time: str = "100000",
    descending: bool = False,
    missing: Iterable[int] = (),
    role: str,
    frame_label: str | None = None,
) -> WrittenSeries:
    series_uid = uid("series", case.case_id, key)
    sops: list[str] = []
    skip = set(missing)
    nk = geom.size[2]
    for k in range(nk):
        if k in skip:
            continue
        inst = (nk - k) if descending else (k + 1)
        sops.append(
            _ct_slice_file(
                case,
                geom,
                series_uid=series_uid,
                series_number=number,
                description=description,
                for_uid=for_uid,
                k=k,
                hu=values(k),
                image_type=image_type,
                shift_mm=shift_mm,
                series_time=series_time,
                instance_number=inst,
            )
        )
    case.series.append(
        {
            "series_instance_uid": series_uid,
            "series_number": number,
            "description": description,
            "role": role,
            "frame_label": frame_label,
            "slices": len(sops),
        }
    )
    return WrittenSeries(series_uid, sops, description, geom, shift_mm, frozenset(skip))


# ── RTSTRUCT（球；ITV ＝ 每片取各相位圓的聯集外接圓）與 RTDOSE ──────────────────


def _write_rtstruct(
    case: Case,
    image: WrittenSeries,
    *,
    for_uid: str,
    key: str,
    label: str,
    rois: list[tuple[str, str, tuple[int, int, int], Callable[[float], tuple[float, float, float, float] | None]]],
) -> str:
    """`rois`：(名稱, 類型, 顏色, z → (cx, cy, z, r) 或 None)。"""
    series_uid = uid("rs", case.case_id, key)
    sop = uid("rs-sop", case.case_id, key)
    ds = _base(
        case,
        sop_class=RTSTRUCT_SOP,
        sop_uid=sop,
        modality="RTSTRUCT",
        series_uid=series_uid,
        series_number=900 + len([s for s in case.series if s["role"] == "rtstruct"]),
        description=f"RS {label}",
        for_uid=None,
    )
    ds.StructureSetLabel = label
    ds.StructureSetDate = STUDY_DATE
    ds.StructureSetTime = "120000"
    rf = Dataset()
    rf.FrameOfReferenceUID = for_uid
    st = Dataset()
    st.ReferencedSOPClassUID = "1.2.840.10008.3.1.2.3.1"
    st.ReferencedSOPInstanceUID = case.study_uid
    se = Dataset()
    se.SeriesInstanceUID = image.series_uid
    se.ContourImageSequence = Sequence([])
    for s in image.sop_uids:
        ci = Dataset()
        ci.ReferencedSOPClassUID = CT_SOP
        ci.ReferencedSOPInstanceUID = s
        se.ContourImageSequence.append(ci)
    st.RTReferencedSeriesSequence = Sequence([se])
    rf.RTReferencedStudySequence = Sequence([st])
    ds.ReferencedFrameOfReferenceSequence = Sequence([rf])
    roi_seq, contour_seq, obs_seq = [], [], []
    present = [k for k in range(image.geom.size[2]) if k not in image.missing]
    for n, (name, kind, color, circle) in enumerate(rois, start=1):
        roi = Dataset()
        roi.ROINumber = n
        roi.ReferencedFrameOfReferenceUID = for_uid
        roi.ROIName = name
        roi.ROIGenerationAlgorithm = "MANUAL"
        roi_seq.append(roi)
        rc = Dataset()
        rc.ReferencedROINumber = n
        rc.ROIDisplayColor = list(color)
        contours = []
        for idx, k in enumerate(present):
            z = image.geom.ipp(k, image.shift_mm)[2]
            got = circle(z)
            if got is None:
                continue
            cx, cy, cz, r = got
            ang = np.linspace(0, 2 * np.pi, 40, endpoint=False)
            pts = np.stack([cx + r * np.cos(ang), cy + r * np.sin(ang), np.full_like(ang, cz)], axis=1)
            c = Dataset()
            c.ContourGeometricType = "CLOSED_PLANAR"
            c.NumberOfContourPoints = len(pts)
            c.ContourData = [float(f"{v:.3f}") for v in pts.flatten()]
            ci = Dataset()
            ci.ReferencedSOPClassUID = CT_SOP
            ci.ReferencedSOPInstanceUID = image.sop_uids[idx]
            c.ContourImageSequence = Sequence([ci])
            contours.append(c)
        rc.ContourSequence = Sequence(contours)
        contour_seq.append(rc)
        ob = Dataset()
        ob.ObservationNumber = n
        ob.ReferencedROINumber = n
        ob.RTROIInterpretedType = kind
        ob.ROIInterpreter = ""
        obs_seq.append(ob)
    ds.StructureSetROISequence = Sequence(roi_seq)
    ds.ROIContourSequence = Sequence(contour_seq)
    ds.RTROIObservationsSequence = Sequence(obs_seq)
    _save(ds, case.root / "RS" / f"RS.{key}.dcm")
    case.series.append(
        {
            "series_instance_uid": series_uid,
            "description": f"RS {label}",
            "role": "rtstruct",
            "references_series": image.series_uid,
            "rois": [r[0] for r in rois],
        }
    )
    return series_uid


def _sphere_at(
    center: tuple[float, float, float], radius: float
) -> Callable[[float], tuple[float, float, float, float] | None]:
    def f(z: float) -> tuple[float, float, float, float] | None:
        r2 = radius**2 - (z - center[2]) ** 2
        return None if r2 <= 1.0 else (center[0], center[1], z, math.sqrt(r2))

    return f


def _itv(
    centers: list[tuple[float, float, float]], radius: float
) -> Callable[[float], tuple[float, float, float, float] | None]:
    """每片取各相位圓的聯集 —— 腫瘤只沿 z 動，聯集就是同心圓裡最大的那個。"""

    def f(z: float) -> tuple[float, float, float, float] | None:
        rs = [radius**2 - (z - c[2]) ** 2 for c in centers]
        best = max(rs)
        return None if best <= 1.0 else (centers[0][0], centers[0][1], z, math.sqrt(best))

    return f


def _write_dose(
    case: Case, *, for_uid: str, ref_series: WrittenSeries, key: str, center: tuple[float, float, float]
) -> str:
    series_uid = uid("dose", case.case_id, key)
    sop = uid("dose-sop", case.case_id, key)
    ds = _base(
        case,
        sop_class=RTDOSE_SOP,
        sop_uid=sop,
        modality="RTDOSE",
        series_uid=series_uid,
        series_number=950,
        description="Dose on Average CT",
        for_uid=for_uid,
    )
    ni, nj, nk = 48, 48, 24
    sp = 5.0
    origin = (center[0] - sp * (ni - 1) / 2, center[1] - sp * (nj - 1) / 2, center[2] - sp * (nk - 1) / 2)
    ds.ImageOrientationPatient = list(AXIAL)
    ds.ImagePositionPatient = [round(v, 3) for v in origin]
    ds.PixelSpacing = [sp, sp]
    ds.GridFrameOffsetVector = [k * sp for k in range(nk)]
    ds.NumberOfFrames = nk
    ds.FrameIncrementPointer = 0x3004000C
    ds.DoseUnits = "GY"
    ds.DoseType = "PHYSICAL"
    ds.DoseSummationType = "PLAN"
    _pixel_module(ds, nj, ni)
    ds.BitsAllocated, ds.BitsStored, ds.HighBit = 32, 32, 31
    kk, jj, ii = np.meshgrid(np.arange(nk), np.arange(nj), np.arange(ni), indexing="ij")
    x = origin[0] + ii * sp - center[0]
    y = origin[1] + jj * sp - center[1]
    z = origin[2] + kk * sp - center[2]
    gy = 60.0 * np.exp(-(x**2 + y**2 + z**2) / (2 * 25.0**2))
    scale = 60.0 / 4_000_000
    ds.DoseGridScaling = f"{scale:.10g}"
    ds.PixelData = np.round(gy / scale).astype(np.uint32).tobytes()
    rp = Dataset()
    rp.ReferencedSOPClassUID = "1.2.840.10008.5.1.4.1.1.481.5"
    rp.ReferencedSOPInstanceUID = uid("plan-not-in-library", case.case_id)
    ds.ReferencedRTPlanSequence = Sequence([rp])
    _save(ds, case.root / "RD" / f"RD.{key}.dcm")
    case.series.append(
        {"series_instance_uid": series_uid, "description": "Dose on Average CT", "role": "rtdose", "max_gy": 60.0}
    )
    return series_uid


# ── CT 組 ───────────────────────────────────────────────────────────────────


PHASES = [p * 10 for p in range(10)]


def _phase_volume(fraction: float, geom: Geom = CT_GEOM, shift_mm: float = 0.0) -> Callable[[int], np.ndarray]:
    dz = tumor_offset_mm(fraction)
    return lambda k: thorax_hu(geom, k, dz, shift_mm)


def _derived(op: str, geom: Geom = CT_GEOM) -> Callable[[int], np.ndarray]:
    fn = {"mean": np.mean, "max": np.max, "min": np.min}[op]
    return lambda k: fn(np.stack([thorax_hu(geom, k, tumor_offset_mm(p / 100)) for p in PHASES]), axis=0)


def _tumor_truth(fractions: list[float]) -> list[list[float]]:
    t = TUMOR_REST_LPS
    return [[t[0], t[1], round(t[2] + tumor_offset_mm(f), 3)] for f in fractions]


def _phase_group(
    case: Case, series: list[WrittenSeries], labels: list[str] | None, *, axis: str = "phase", confidence: str = "high"
) -> dict[str, Any]:
    return {
        "kind": "cyclic",
        "axis": axis,
        "frames": len(series),
        "series_order": [s.series_uid for s in series],
        "frame_labels": labels,
        "frame_times_s": None,
        "confidence": confidence,
    }


def build_ct1(root: Path) -> Case:
    case = Case(
        "ct1",
        "4DCT Siemens 風格：每相位一個序列（0%…90%）＋ Average／T-MIP／T-MinIP",
        "CT",
        "multi_series_phase_percent",
        ["Siemens SOMATOM go 4DCT Cookbook p.13-14（命名 0%…90%、Average CT、T-MaxIP、T-MinIP）"],
        root,
    )
    for_uid = uid("for", case.case_id)
    phases = []
    for n, p in enumerate(PHASES):
        phases.append(
            _write_ct_series(
                case,
                key=f"p{p}",
                number=2 + n,
                description=f"Thorax 4D 3.0 Br40 {p}%",
                for_uid=for_uid,
                values=_phase_volume(p / 100),
                image_type=["ORIGINAL", "PRIMARY", "AXIAL"],
                series_time=_tm(60 + n),
                role="phase",
                frame_label=f"{p}%",
            )
        )
    avg = _write_ct_series(
        case,
        key="avg",
        number=20,
        description="Average CT 3.0 Br40",
        for_uid=for_uid,
        values=_derived("mean"),
        image_type=["DERIVED", "SECONDARY", "AXIAL", "MEAN"],
        series_time=_tm(80),
        role="derived",
    )
    mip = _write_ct_series(
        case,
        key="mip",
        number=21,
        description="T-MIP 3.0 Br40",
        for_uid=for_uid,
        values=_derived("max"),
        image_type=["DERIVED", "SECONDARY", "AXIAL", "MAXIMUM"],
        series_time=_tm(81),
        role="derived",
    )
    minip = _write_ct_series(
        case,
        key="minip",
        number=22,
        description="T-MinIP 3.0 Br40",
        for_uid=for_uid,
        values=_derived("min"),
        image_type=["DERIVED", "SECONDARY", "AXIAL", "MINIMUM"],
        series_time=_tm(82),
        role="derived",
    )
    centers = [tuple(c) for c in _tumor_truth([p / 100 for p in PHASES])]
    _write_rtstruct(
        case,
        avg,
        for_uid=for_uid,
        key="avg",
        label="ITV on AVG",
        rois=[("ITV", "ITV", (255, 128, 0), _itv(centers, TUMOR_RADIUS_MM))],
    )
    for p in (0, 50):
        c = centers[PHASES.index(p)]
        _write_rtstruct(
            case,
            phases[PHASES.index(p)],
            for_uid=for_uid,
            key=f"gtv{p}",
            label=f"GTV {p}%",
            rois=[(f"GTV_{p:02d}", "GTV", (255, 0, 0), _sphere_at(c, TUMOR_RADIUS_MM))],
        )
    _write_dose(
        case,
        for_uid=for_uid,
        ref_series=avg,
        key="avg",
        center=(TUMOR_REST_LPS[0], TUMOR_REST_LPS[1], TUMOR_REST_LPS[2] - 6),
    )
    case.expected = {
        "groups": [_phase_group(case, phases, [f"{p}%" for p in PHASES])],
        "derived": [{"series": s.series_uid, "op": op} for s, op in ((avg, "mean"), (mip, "max"), (minip, "min"))],
        "standalone": [],
        "structures": "RS 0%、50% 的 GTV 屬於時間軸的第 0、5 幀（其他幀沒有）；ITV 掛在 AVG（同 FoR，不屬時間軸）",
        "dose": "RTDOSE 在 AVG 的 FoR（＝整組的 FoR）→ 每個相位都能疊",
        "warnings": [],
    }
    case.truth = {
        "tumor_center_lps_per_frame": centers,
        "tumor_radius_mm": TUMOR_RADIUS_MM,
        "breathing": "0% 吸氣末（最低）、50% 吐氣末",
    }
    return case


def build_ct2(root: Path, *, irregular: bool = False) -> Case:
    cid = "ct6" if irregular else "ct2"
    case = Case(
        cid,
        (
            "4DCT 不一致：30% 少一片、70% z 位移 1.5 mm"
            if irregular
            else "4DCT Philips 風格：`Gated, x.0%`、AVG、MIP、Non-Gated；z 遞減儲存"
        ),
        "CT",
        "multi_series_phase_percent_inconsistent" if irregular else "multi_series_phase_percent",
        [
            "4D-Lung 資料描述（Hugo 2017, PMC5912888）：SeriesDescription 帶 Gated x.0%、0% 吸氣末",
            "RayStation 腳本 KaleyWhite/med-phys-scripts prepare_exams.py"
            "（anecdotal：Gated, x.0%／AVG／MIP／Non-Gated）",
            *(["Pinnacle 使用者論壇（anecdotal：各相位 z 不一致或缺片 → cine 失敗）"] if irregular else []),
        ],
        root,
    )
    for_uid = uid("for", case.case_id)
    phases = []
    for n, p in enumerate(PHASES):
        shift = 1.5 if (irregular and p == 70) else 0.0
        missing = (17,) if (irregular and p == 30) else ()
        phases.append(
            _write_ct_series(
                case,
                key=f"p{p}",
                number=301 + n,
                description=f"Chest 3.0, Gated, {p:.1f}%",
                for_uid=for_uid,
                values=_phase_volume(p / 100, shift_mm=shift),
                image_type=["ORIGINAL", "PRIMARY", "AXIAL"],
                series_time=_tm(120 + n * 2),
                descending=True,
                shift_mm=shift,
                missing=missing,
                role="phase",
                frame_label=f"{p}%",
            )
        )
    avg = _write_ct_series(
        case,
        key="avg",
        number=320,
        description="AVG",
        for_uid=for_uid,
        values=_derived("mean"),
        image_type=["DERIVED", "SECONDARY", "AXIAL"],
        series_time=_tm(150),
        descending=True,
        role="derived",
    )
    mip = _write_ct_series(
        case,
        key="mip",
        number=321,
        description="MIP",
        for_uid=for_uid,
        values=_derived("max"),
        image_type=["DERIVED", "SECONDARY", "AXIAL"],
        series_time=_tm(151),
        descending=True,
        role="derived",
    )
    # 自由呼吸的掃描：同 FoR、範圍較大（z 多 6 片）、腫瘤在中間位置 → 不是相位
    ng_geom = Geom(size=(128, 128, 46), spacing=(3.5, 3.5, 3.0), origin=(-222.25, -222.25, -69.0))
    ng = _write_ct_series(
        case,
        key="ng",
        number=200,
        description="Chest 3.0, Non-Gated",
        for_uid=for_uid,
        values=lambda k: thorax_hu(ng_geom, k, -RESP_AMPLITUDE_MM / 2),
        geom=ng_geom,
        image_type=["ORIGINAL", "PRIMARY", "AXIAL"],
        series_time=_tm(0),
        descending=True,
        role="other",
    )
    centers = [tuple(c) for c in _tumor_truth([p / 100 for p in PHASES])]
    if not irregular:
        for p, s in zip(PHASES, phases, strict=True):
            c = centers[PHASES.index(p)]
            _write_rtstruct(
                case,
                s,
                for_uid=for_uid,
                key=f"gtv{p}",
                label=f"GTV_c{p:02d}",
                rois=[(f"GTV_c{p:02d}", "GTV", (255, 0, 0), _sphere_at(c, TUMOR_RADIUS_MM))],
            )
    group = _phase_group(case, phases, [f"{p}%" for p in PHASES])
    warnings: list[str] = []
    if irregular:
        group = _phase_group(
            case,
            [s for p, s in zip(PHASES, phases, strict=True) if p not in (30, 70)],
            [f"{p}%" for p in PHASES if p not in (30, 70)],
        )
        group["excluded"] = [
            {"series": phases[3].series_uid, "label": "30%", "reason": "slice_count", "detail": "39 片（其他 40 片）"},
            {"series": phases[7].series_uid, "label": "70%", "reason": "grid", "detail": "z 原點差 1.5 mm"},
        ]
        warnings = ["30% 少一片", "70% 網格不同"]
    case.expected = {
        "groups": [group],
        "derived": [{"series": avg.series_uid, "op": "mean"}, {"series": mip.series_uid, "op": "max"}],
        "standalone": [ng.series_uid],
        "structures": None if irregular else "每個相位一個 RS（GTV_c00…GTV_c90），各自屬於對應的幀",
        "warnings": warnings,
        "notes": "切片以 z 遞減儲存（InstanceNumber 1 在最上面）；Non-Gated 同 FoR 但網格不同 → 獨立影像",
    }
    case.truth = {"tumor_center_lps_per_frame": centers, "tumor_radius_mm": TUMOR_RADIUS_MM}
    return case


AMPLITUDE_BINS = [("In", 0), ("In", 25), ("In", 50), ("In", 75), ("In", 100), ("Ex", 75), ("Ex", 50), ("Ex", 25)]


def build_ct3(root: Path) -> Case:
    case = Case(
        "ct3",
        "4DCT 振幅分箱（Siemens 風格）：In 0%…In 100%、Ex 75%…Ex 25%",
        "CT",
        "multi_series_amplitude",
        ["Siemens SOMATOM go 4DCT Cookbook（振幅分箱命名 In x%／Ex x%）"],
        root,
    )
    for_uid = uid("for", case.case_id)
    series = []
    fractions = []
    # 振幅 0% ＝ 吐氣末（位移 0）、100% ＝ 吸氣末（位移 −A）
    for n, (side, amp) in enumerate(AMPLITUDE_BINS):
        dz = -RESP_AMPLITUDE_MM * amp / 100
        fractions.append(dz)
        series.append(
            _write_ct_series(
                case,
                key=f"{side}{amp}",
                number=40 + n,
                description=f"Thorax 4D Ampl {side} {amp}%",
                for_uid=for_uid,
                values=lambda k, _dz=dz: thorax_hu(CT_GEOM, k, _dz),
                image_type=["ORIGINAL", "PRIMARY", "AXIAL"],
                series_time=_tm(200 + n),
                role="phase",
                frame_label=f"{side} {amp}%",
            )
        )
    # 故意把 SeriesNumber 打亂（Ex 先存）不影響：順序靠標籤
    t = TUMOR_REST_LPS
    case.expected = {
        "groups": [_phase_group(case, series, [f"{s} {a}%" for s, a in AMPLITUDE_BINS], axis="amplitude")],
        "derived": [],
        "standalone": [],
        "warnings": [],
        "notes": "振幅分箱：順序是 In 遞增 → Ex 遞減（一個呼吸週期）；標籤不是相位百分比，軸要標『振幅』",
    }
    case.truth = {"tumor_center_lps_per_frame": [[t[0], t[1], round(t[2] + dz, 3)] for dz in fractions]}
    return case


def build_ct4(root: Path) -> Case:
    case = Case(
        "ct4",
        "4DCT 沒有相位標籤：10 個序列描述相同，只有 SeriesNumber／SeriesTime 遞增",
        "CT",
        "multi_series_unlabeled",
        ["推測的最差情況（MultiVolumeImporter 跨序列只試 SeriesTime／AcquisitionTime）"],
        root,
    )
    for_uid = uid("for", case.case_id)
    series = [
        _write_ct_series(
            case,
            key=f"p{p}",
            number=60 + n,
            description="4D Lung",
            for_uid=for_uid,
            values=_phase_volume(p / 100),
            image_type=["ORIGINAL", "PRIMARY", "AXIAL"],
            series_time=_tm(300 + n),
            role="phase",
            frame_label=None,
        )
        for n, p in enumerate(PHASES)
    ]
    case.expected = {
        "groups": [
            {**_phase_group(case, series, None, confidence="low"), "kind": "series", "axis": "time"}
        ],
        "derived": [],
        "standalone": [],
        "warnings": ["沒有相位標籤，依 SeriesNumber 排序 —— 要使用者確認"],
        "notes": "不該自動合併：當成候選，使用者確認後才變時間軸",
    }
    case.truth = {"tumor_center_lps_per_frame": _tumor_truth([p / 100 for p in PHASES])}
    return case


def build_ct5(root: Path) -> Case:
    case = Case(
        "ct5",
        "Enhanced CT 一個檔：10 個呼吸相位 × 40 片（Respiratory Synchronization ＋ Dimension Index）",
        "CT",
        "enhanced_multiframe_respiratory",
        [
            "PS3.3 C.7.6.16.2.17 Respiratory Synchronization Macro；C.7.6.17 Multi-frame Dimension；"
            "C.7.6.16.2.2 Frame Content"
        ],
        root,
    )
    for_uid = uid("for", case.case_id)
    series_uid = uid("series", case.case_id, "enh")
    sop = uid("enh-sop", case.case_id)
    g = CT_GEOM
    ds = _base(
        case,
        sop_class=ENHANCED_CT_SOP,
        sop_uid=sop,
        modality="CT",
        series_uid=series_uid,
        series_number=5,
        description="Thorax 4D Enhanced",
        for_uid=for_uid,
    )
    ds.ImageType = ["ORIGINAL", "PRIMARY", "VOLUME", "NONE"]
    ds.InstanceNumber = 1
    ds.ContentQualification = "RESEARCH"
    ds.AcquisitionNumber = 1
    ds.ContentDate, ds.ContentTime = STUDY_DATE, "100000"
    ds.AcquisitionDateTime = f"{STUDY_DATE}100000"
    ds.RespiratoryMotionCompensationTechnique = "RETROSPECTIVE"
    ds.RespiratorySignalSource = "BELT"
    _pixel_module(ds, g.size[1], g.size[0])
    ds.BurnedInAnnotation = "NO"
    ds.PresentationLUTShape = "IDENTITY"
    ds.LossyImageCompression = "00"
    dim_uid = uid("dimorg", case.case_id)
    dorg = Dataset()
    dorg.DimensionOrganizationUID = dim_uid
    ds.DimensionOrganizationSequence = Sequence([dorg])
    ds.DimensionOrganizationType = "3D_TEMPORAL"
    di = []
    for pointer, group, label in (
        (0x00209245, 0x00209253, "Respiratory phase %"),
        (0x00209057, 0x00209111, "In-Stack Position"),
    ):
        d = Dataset()
        d.DimensionOrganizationUID = dim_uid
        d.DimensionIndexPointer = pointer
        d.FunctionalGroupPointer = group
        d.DimensionDescriptionLabel = label
        di.append(d)
    ds.DimensionIndexSequence = Sequence(di)
    shared = Dataset()
    pm = Dataset()
    pm.PixelSpacing = [g.spacing[1], g.spacing[0]]
    pm.SliceThickness = g.spacing[2]
    shared.PixelMeasuresSequence = Sequence([pm])
    po = Dataset()
    po.ImageOrientationPatient = list(g.iop)
    shared.PlaneOrientationSequence = Sequence([po])
    pv = Dataset()
    pv.RescaleIntercept, pv.RescaleSlope, pv.RescaleType = -1024, 1, "HU"
    shared.PixelValueTransformationSequence = Sequence([pv])
    voi = Dataset()
    voi.WindowCenter, voi.WindowWidth = -600, 1600
    shared.FrameVOILUTSequence = Sequence([voi])
    ds.SharedFunctionalGroupsSequence = Sequence([shared])
    frames = []
    pixels = []
    period_s = 4.0
    for n, p in enumerate(PHASES):
        dz = tumor_offset_mm(p / 100)
        for k in range(g.size[2]):
            fg = Dataset()
            fc = Dataset()
            fc.StackID = "1"
            fc.InStackPositionNumber = k + 1
            fc.TemporalPositionIndex = n + 1
            fc.DimensionIndexValues = [n + 1, k + 1]
            fc.FrameAcquisitionDateTime = f"{STUDY_DATE}100000"
            fc.FrameReferenceDateTime = f"{STUDY_DATE}100000"
            fc.FrameAcquisitionDuration = 500.0
            fc.FrameLabel = f"{p}%"
            fg.FrameContentSequence = Sequence([fc])
            pp = Dataset()
            pp.ImagePositionPatient = g.ipp(k)
            fg.PlanePositionSequence = Sequence([pp])
            rs = Dataset()
            rs.NominalPercentageOfRespiratoryPhase = float(p)
            rs.NominalRespiratoryTriggerDelayTime = period_s * 1000 * p / 100
            rs.RespiratoryIntervalTime = period_s * 1000
            fg.RespiratorySynchronizationSequence = Sequence([rs])
            frames.append(fg)
            pixels.append(np.clip(thorax_hu(g, k, dz) + 1024, 0, 4095).astype(np.uint16))
    ds.PerFrameFunctionalGroupsSequence = Sequence(frames)
    ds.NumberOfFrames = len(frames)
    ds.PixelData = np.stack(pixels).tobytes()
    _save(ds, case.root / "S005" / "ENH.dcm")
    case.series.append(
        {
            "series_instance_uid": series_uid,
            "description": "Thorax 4D Enhanced",
            "role": "phase",
            "frames": len(frames),
            "file": "S005/ENH.dcm",
        }
    )
    case.expected = {
        "groups": [
            {
                "kind": "cyclic",
                "axis": "phase",
                "frames": 10,
                "single_series": series_uid,
                "frame_key": "(0020,9253)>(0020,9245) NominalPercentageOfRespiratoryPhase",
                "frame_labels": [f"{p}%" for p in PHASES],
                "frame_times_s": None,
                "confidence": "high",
            }
        ],
        "derived": [],
        "standalone": [],
        "warnings": [],
        "notes": "目前的影像載入器不支援 Enhanced 多幀（一個檔 400 幀）——這組留給日後支援時測試",
    }
    case.truth = {"tumor_center_lps_per_frame": _tumor_truth([p / 100 for p in PHASES])}
    return case


# ── MR 組 ───────────────────────────────────────────────────────────────────

MR_GEOM = Geom(size=(128, 128, 20), spacing=(2.5, 2.5, 5.0), origin=(-158.75, -158.75, -50.0))
DCE_TIMES_S = [0.0, 10.0, 20.0, 30.0, 40.0, 50.0, 60.0, 90.0, 120.0, 180.0, 240.0, 300.0]
LESION_LPS = (-60.0, 0.0, 0.0)
LESION_RADIUS_MM = 12.0
AORTA_LPS = (10.0, 40.0)


def dce_curve(t: float, *, kind: str) -> float:
    """相對增強：病灶快進慢出、主動脈快速尖峰、肝實質慢慢上升。注射在 t ＝ 15 s。"""
    s = max(0.0, t - 15.0)
    if kind == "lesion":
        return 1.6 * (1 - math.exp(-s / 20.0)) * math.exp(-s / 400.0)
    if kind == "aorta":
        return 3.0 * (s / 12.0) * math.exp(1 - s / 12.0) + 0.6 * (1 - math.exp(-s / 60.0)) if s > 0 else 0.0
    return 0.5 * (1 - math.exp(-s / 90.0))


def abdomen_mr(
    geom: Geom, k: int, t_s: float, *, lesion_dz: float = 0.0, contrast: str = "dce", param: float = 0.0
) -> np.ndarray:
    """腹部 MR 假體的一片。`contrast`：dce（t_s）／echo（TE ms）／dwi（b）／resp（lesion_dz）。"""
    x, y, z = geom.world(k)
    body = _ellipse(x, y, 0, 0, 150, 110)
    liver = _ellipse(x, y, -55, -5, 70, 60) & body
    fat = body & ~_ellipse(x, y, 0, 0, 138, 98)
    lz = LESION_LPS[2] + lesion_dz
    lesion = (x - LESION_LPS[0]) ** 2 + (y - LESION_LPS[1]) ** 2 + (z - lz) ** 2 <= LESION_RADIUS_MM**2
    aorta = _ellipse(x, y, AORTA_LPS[0], AORTA_LPS[1], 11, 11)
    liver &= ~lesion & ~aorta
    s0 = np.zeros(x.shape)
    s0[body] = 300.0
    s0[fat] = 650.0
    s0[liver] = 400.0
    s0[lesion] = 380.0
    s0[aorta] = 250.0
    if contrast == "dce":
        out = s0.copy()
        out[liver] *= 1 + dce_curve(t_s, kind="liver")
        out[lesion] *= 1 + dce_curve(t_s, kind="lesion")
        out[aorta] *= 1 + dce_curve(t_s, kind="aorta")
    elif contrast == "echo":  # T2*：脂肪 60 ms、肝 30 ms、病灶 80 ms
        t2 = np.full(x.shape, 45.0)
        t2[fat], t2[liver], t2[lesion] = 60.0, 30.0, 80.0
        out = s0 * 2.0 * np.exp(-param / t2)
    elif contrast == "dwi":  # ADC（mm²/s）
        adc = np.full(x.shape, 1.2e-3)
        adc[fat], adc[liver], adc[lesion], adc[aorta] = 0.2e-3, 1.1e-3, 0.7e-3, 3.0e-3
        out = s0 * 2.0 * np.exp(-param * adc)
    else:
        out = s0
    rng = np.random.default_rng(k * 7919 + int(t_s * 10) + int(param))
    out = out + rng.normal(0, 6.0, x.shape) * (s0 > 0)
    return np.clip(out, 0, 4095)


def _mr_file(
    case: Case,
    geom: Geom,
    *,
    series_uid: str,
    series_number: int,
    description: str,
    for_uid: str,
    k: int,
    pixels: np.ndarray,
    instance_number: int,
    sop_key: object,
    image_type: list[str],
    series_time: str = "100000",
    acquisition_time_s: float | None = None,
    extra: dict[str, Any] | None = None,
    private: Callable[[Dataset], None] | None = None,
    folder: str | None = None,
) -> str:
    sop = uid("mr", series_uid[-10:], sop_key)
    ds = _base(
        case,
        sop_class=MR_SOP,
        sop_uid=sop,
        modality="MR",
        series_uid=series_uid,
        series_number=series_number,
        description=description,
        for_uid=for_uid,
        series_time=series_time,
    )
    ds.ImageType = image_type
    ds.InstanceNumber = instance_number
    ds.ScanningSequence, ds.SequenceVariant = "GR", "SP"
    ds.ScanOptions, ds.MRAcquisitionType = "", "3D"
    ds.RepetitionTime, ds.EchoTime = 4.5, 2.1
    ds.EchoTrainLength = 1
    ds.MagneticFieldStrength = 1.5
    ds.ImageOrientationPatient = list(geom.iop)
    ds.ImagePositionPatient = geom.ipp(k)
    ds.PixelSpacing = [geom.spacing[1], geom.spacing[0]]
    ds.SliceThickness = geom.spacing[2]
    ds.WindowCenter, ds.WindowWidth = 600, 1200
    if acquisition_time_s is not None:
        ds.AcquisitionTime = _tm(acquisition_time_s)
        ds.ContentTime = _tm(acquisition_time_s)
    _pixel_module(ds, geom.size[1], geom.size[0])
    for key, value in (extra or {}).items():
        setattr(ds, key, value)
    if private is not None:
        private(ds)
    ds.PixelData = pixels.astype(np.uint16).tobytes()
    return _save(ds, case.root / (folder or f"S{series_number:03d}") / f"IM{instance_number:05d}.dcm")


def _volume_order(n_t: int, n_k: int, *, shuffle_seed: int | None) -> list[tuple[int, int]]:
    order = [(t, k) for t in range(n_t) for k in range(n_k)]
    if shuffle_seed is not None:
        rng = np.random.default_rng(shuffle_seed)
        rng.shuffle(order)  # type: ignore[arg-type]
    return order


def _single_series_dynamic(
    case: Case,
    *,
    number: int,
    description: str,
    values: list[float],
    pixels: Callable[[int, int], np.ndarray],
    per_volume: Callable[[int], dict[str, Any]],
    image_type: Callable[[int], list[str]] | list[str],
    acquisition_times: list[float] | None,
    shuffle_seed: int | None = None,
    geom: Geom = MR_GEOM,
    private: Callable[[int], Callable[[Dataset], None] | None] | None = None,
) -> str:
    for_uid = uid("for", case.case_id)
    series_uid = uid("series", case.case_id, number)
    n_t, n_k = len(values), geom.size[2]
    for inst, (t, k) in enumerate(_volume_order(n_t, n_k, shuffle_seed=shuffle_seed), start=1):
        _mr_file(
            case,
            geom,
            series_uid=series_uid,
            series_number=number,
            description=description,
            for_uid=for_uid,
            k=k,
            pixels=pixels(t, k),
            instance_number=inst,
            sop_key=f"{t}-{k}",
            image_type=image_type(t) if callable(image_type) else image_type,
            acquisition_time_s=acquisition_times[t] if acquisition_times is not None else None,
            extra=per_volume(t),
            private=private(t) if private is not None else None,
        )
    return series_uid


def _dce_group(series_uid: str, *, key: str, confidence: str = "high") -> dict[str, Any]:
    return {
        "kind": "series",
        "axis": "time",
        "frames": len(DCE_TIMES_S),
        "single_series": series_uid,
        "frame_key": key,
        "frame_labels": None,
        "frame_times_s": DCE_TIMES_S,
        "confidence": confidence,
    }


def _dce_truth() -> dict[str, Any]:
    return {
        "lesion_center_lps": list(LESION_LPS),
        "lesion_relative_enhancement": [round(dce_curve(t, kind="lesion"), 4) for t in DCE_TIMES_S],
        "aorta_relative_enhancement": [round(dce_curve(t, kind="aorta"), 4) for t in DCE_TIMES_S],
    }


def build_mr1(root: Path) -> Case:
    case = Case(
        "mr1",
        "DCE 一個序列：TemporalPositionIdentifier ＋ TriggerTime；InstanceNumber 打亂",
        "MR",
        "single_series_temporal_position",
        [
            "PS3.3 C.8.3.1 MR Image Module（0020,0100／0020,0105／0018,1060）",
            "dcm2niix Philips README（InstanceNumber 常亂序）",
        ],
        root,
    )
    s = _single_series_dynamic(
        case,
        number=7,
        description="DCE T1 FFE dyn",
        values=DCE_TIMES_S,
        pixels=lambda t, k: abdomen_mr(MR_GEOM, k, DCE_TIMES_S[t]),
        per_volume=lambda t: {
            "TemporalPositionIdentifier": t + 1,
            "NumberOfTemporalPositions": len(DCE_TIMES_S),
            "TriggerTime": DCE_TIMES_S[t] * 1000,
            "TemporalResolution": 10000.0,
        },
        image_type=["ORIGINAL", "PRIMARY", "M", "DYNAMIC"],
        acquisition_times=DCE_TIMES_S,
        shuffle_seed=11,
    )
    case.series.append(
        {"series_instance_uid": s, "description": "DCE T1 FFE dyn", "role": "dynamic", "volumes": 12, "slices": 20}
    )
    case.expected = {
        "groups": [_dce_group(s, key="TemporalPositionIdentifier")],
        "derived": [],
        "standalone": [],
        "warnings": [],
    }
    case.truth = _dce_truth()
    return case


def build_mr2(root: Path) -> Case:
    case = Case(
        "mr2",
        "DCE 一個序列：只有 AcquisitionNumber 分 volume（Siemens XA classic 風格）",
        "MR",
        "single_series_acquisition_number",
        ["dcm2niix issue #689（XA 同序列用 AcquisitionNumber 區分 volume）"],
        root,
    )
    s = _single_series_dynamic(
        case,
        number=12,
        description="t1_vibe_fs_tra_dyn",
        values=DCE_TIMES_S,
        pixels=lambda t, k: abdomen_mr(MR_GEOM, k, DCE_TIMES_S[t]),
        per_volume=lambda t: {"AcquisitionNumber": t + 1},
        image_type=["ORIGINAL", "PRIMARY", "M", "NORM", "DIS3D"],
        acquisition_times=DCE_TIMES_S,
    )
    case.series.append(
        {"series_instance_uid": s, "description": "t1_vibe_fs_tra_dyn", "role": "dynamic", "volumes": 12, "slices": 20}
    )
    case.expected = {
        "groups": [_dce_group(s, key="AcquisitionNumber")],
        "derived": [],
        "standalone": [],
        "warnings": [],
    }
    case.truth = _dce_truth()
    return case


def build_mr3(root: Path) -> Case:
    case = Case(
        "mr3",
        "DCE 每個時間點一個序列（Siemens VE 風格）：描述相同、SeriesNumber 遞增",
        "MR",
        "multi_series_timepoints",
        [
            "dcm2niix issue #689（VE fldyn3d1 每個時間點一個序列）",
            "dcm2niix issue #252（有些廠牌 DCE 每幀一個序列，可達上百個）",
        ],
        root,
    )
    for_uid = uid("for", case.case_id)
    uids = []
    for t, ts in enumerate(DCE_TIMES_S):
        series_uid = uid("series", case.case_id, t)
        for k in range(MR_GEOM.size[2]):
            _mr_file(
                case,
                MR_GEOM,
                series_uid=series_uid,
                series_number=20 + t,
                description="t1_fl3d_tra_dyn",
                for_uid=for_uid,
                k=k,
                pixels=abdomen_mr(MR_GEOM, k, ts),
                instance_number=k + 1,
                sop_key=k,
                image_type=["ORIGINAL", "PRIMARY", "M", "ND"],
                series_time=_tm(ts),
                acquisition_time_s=ts,
            )
        uids.append(series_uid)
        case.series.append(
            {
                "series_instance_uid": series_uid,
                "series_number": 20 + t,
                "description": "t1_fl3d_tra_dyn",
                "role": "timepoint",
                "time_s": ts,
                "slices": MR_GEOM.size[2],
            }
        )
    case.expected = {
        "groups": [
            {
                "kind": "series",
                "axis": "time",
                "frames": len(uids),
                "series_order": uids,
                "frame_key": "AcquisitionTime／SeriesTime",
                "frame_labels": None,
                "frame_times_s": DCE_TIMES_S,
                "confidence": "low",
            }
        ],
        "derived": [],
        "standalone": [],
        "warnings": [],
        "notes": "跨序列、描述相同、時間遞增 —— 有時間戳，但沒有標籤說它們是同一次動態掃描；建議當候選讓使用者確認",
    }
    case.truth = _dce_truth()
    return case


def build_mr4(root: Path) -> Case:
    times = [0.0, 75.0, 180.0]
    case = Case(
        "mr4",
        "DCE 一個序列：只有 AcquisitionTime 不同（3 個時相）",
        "MR",
        "single_series_acquisition_time",
        ["VTK discourse 11661（anecdotal：ISPY1 三個時相只能靠 AcquisitionTime）"],
        root,
    )
    s = _single_series_dynamic(
        case,
        number=3,
        description="Ax 3D Dyn",
        values=times,
        pixels=lambda t, k: abdomen_mr(MR_GEOM, k, times[t]),
        per_volume=lambda t: {},
        image_type=["ORIGINAL", "PRIMARY", "OTHER"],
        acquisition_times=times,
    )
    case.series.append(
        {"series_instance_uid": s, "description": "Ax 3D Dyn", "role": "dynamic", "volumes": 3, "slices": 20}
    )
    case.expected = {
        "groups": [
            {
                "kind": "series",
                "axis": "time",
                "frames": 3,
                "single_series": s,
                "frame_key": "AcquisitionTime",
                "frame_labels": None,
                "frame_times_s": times,
                "confidence": "medium",
            }
        ],
        "derived": [],
        "standalone": [],
        "warnings": [],
    }
    case.truth = {"lesion_relative_enhancement": [round(dce_curve(t, kind="lesion"), 4) for t in times]}
    return case


def build_mr5(root: Path) -> Case:
    tes = [2.4, 4.8, 7.2, 9.6]
    case = Case(
        "mr5",
        "多回波一個序列（EchoNumbers 1–4）—— 不是時間",
        "MR",
        "single_series_multi_echo",
        [
            "PS3.3 C.8.3.1（Echo Numbers、Echo Time）",
            "dcm2niix：TE 不同拆成 _e2…",
            "Slicer MultiVolumeImporter：EchoTime 當參數軸",
        ],
        root,
    )
    s = _single_series_dynamic(
        case,
        number=9,
        description="me_gre_tra",
        values=tes,
        pixels=lambda e, k: abdomen_mr(MR_GEOM, k, 0, contrast="echo", param=tes[e]),
        per_volume=lambda e: {"EchoNumbers": e + 1, "EchoTime": tes[e]},
        image_type=["ORIGINAL", "PRIMARY", "M", "ND"],
        acquisition_times=[0.0] * 4,
    )
    case.series.append(
        {"series_instance_uid": s, "description": "me_gre_tra", "role": "multi_echo", "volumes": 4, "slices": 20}
    )
    case.expected = {
        "groups": [],
        "parameter_axes": [
            {"kind": "series", "axis": "echo_time", "unit": "ms", "frames": 4, "single_series": s, "values": tes}
        ],
        "derived": [],
        "standalone": [],
        "warnings": [],
        "notes": "不能當時間播放；可當參數軸（T4）或拆成 4 組影像",
    }
    return case


def build_mr6(root: Path) -> Case:
    bs = [0, 500, 1000]
    case = Case(
        "mr6",
        "DWI 一個序列（b = 0／500／1000，Siemens 私有 b 值）＋ 同序列的 ADC",
        "MR",
        "single_series_diffusion",
        [
            "Slicer MultiVolumeImporter（Siemens (0019,100C) b 值）",
            "dcm2niix Philips README（衍生的 ADC 跟 DWI 同序列）",
        ],
        root,
    )
    for_uid = uid("for", case.case_id)
    series_uid = uid("series", case.case_id, "dwi")
    nk = MR_GEOM.size[2]

    def b_tag(b: int) -> Callable[[Dataset], None]:
        def f(ds: Dataset) -> None:
            block = ds.private_block(0x0019, "SIEMENS MR HEADER", create=True)
            block.add_new(0x0C, "IS", str(b))

        return f

    inst = 0
    for b in bs:
        for k in range(nk):
            inst += 1
            _mr_file(
                case,
                MR_GEOM,
                series_uid=series_uid,
                series_number=14,
                description="ep2d_diff_b0_500_1000",
                for_uid=for_uid,
                k=k,
                pixels=abdomen_mr(MR_GEOM, k, 0, contrast="dwi", param=b),
                instance_number=inst,
                sop_key=f"b{b}-{k}",
                image_type=["ORIGINAL", "PRIMARY", "DIFFUSION", "NONE"],
                acquisition_time_s=0.0,
                extra={"SequenceName": f"*ep_b{b}t"},
                private=b_tag(b),
            )
    for k in range(nk):
        inst += 1
        x = abdomen_mr(MR_GEOM, k, 0, contrast="dwi", param=0)
        _mr_file(
            case,
            MR_GEOM,
            series_uid=series_uid,
            series_number=14,
            description="ep2d_diff_b0_500_1000",
            for_uid=for_uid,
            k=k,
            pixels=np.clip(x * 1.5, 0, 4095),
            instance_number=inst,
            sop_key=f"adc-{k}",
            image_type=["DERIVED", "PRIMARY", "DIFFUSION", "ADC"],
            acquisition_time_s=0.0,
        )
    case.series.append(
        {
            "series_instance_uid": series_uid,
            "description": "ep2d_diff_b0_500_1000",
            "role": "diffusion",
            "volumes": "3 個 b 值 ＋ 1 個 ADC",
            "slices": nk,
        }
    )
    case.expected = {
        "groups": [],
        "parameter_axes": [
            {
                "kind": "series",
                "axis": "b_value",
                "unit": "s/mm²",
                "frames": 3,
                "single_series": series_uid,
                "values": bs,
                "frame_key": "(0019,100C) Siemens 私有",
            }
        ],
        "derived": [{"series": series_uid, "subset": "ImageType 含 ADC", "op": "adc"}],
        "standalone": [],
        "warnings": [],
        "notes": "ADC 跟 DWI 同一個 SeriesInstanceUID —— 要依 ImageType 拆開，不能混進 b 值軸",
    }
    return case


def build_mr7(root: Path) -> Case:
    case = Case(
        "mr7",
        "DCE 一個序列，混了相位影像（ImageType …\\P\\…）",
        "MR",
        "single_series_mixed_magnitude_phase",
        ["dcm2niix issue #463（anecdotal：DCE 序列裡混了相位影像）"],
        root,
    )
    times = DCE_TIMES_S[:6]
    for_uid = uid("for", case.case_id)
    series_uid = uid("series", case.case_id, "dce")
    nk = MR_GEOM.size[2]
    inst = 0
    for t, ts in enumerate(times):
        for kind in ("M", "P"):
            for k in range(nk):
                inst += 1
                px = (
                    abdomen_mr(MR_GEOM, k, ts)
                    if kind == "M"
                    else np.full((128, 128), 2048.0) + 800 * np.sin(np.arange(128) / 9.0)[None, :]
                )
                _mr_file(
                    case,
                    MR_GEOM,
                    series_uid=series_uid,
                    series_number=8,
                    description="DCE dyn M+P",
                    for_uid=for_uid,
                    k=k,
                    pixels=px,
                    instance_number=inst,
                    sop_key=f"{kind}{t}-{k}",
                    image_type=["ORIGINAL", "PRIMARY", kind, "DYNAMIC"],
                    acquisition_time_s=ts,
                    extra={"TemporalPositionIdentifier": t + 1, "NumberOfTemporalPositions": len(times)},
                )
    case.series.append(
        {
            "series_instance_uid": series_uid,
            "description": "DCE dyn M+P",
            "role": "dynamic",
            "volumes": "6 × (M＋P)",
            "slices": nk,
        }
    )
    case.expected = {
        "groups": [
            {
                "kind": "series",
                "axis": "time",
                "frames": 6,
                "single_series": series_uid,
                "subset": "ImageType 第 3 值 M",
                "frame_key": "TemporalPositionIdentifier",
                "frame_labels": None,
                "frame_times_s": times,
                "confidence": "high",
            }
        ],
        "derived": [],
        "standalone": [],
        "split": [{"series": series_uid, "subset": "ImageType 第 3 值 P", "as": "另一組影像（相位圖），預設不載入"}],
        "warnings": ["序列裡有相位影像，已分開"],
    }
    case.truth = {"lesion_relative_enhancement": [round(dce_curve(t, kind="lesion"), 4) for t in times]}
    return case


def build_mr8(root: Path) -> Case:
    case = Case(
        "mr8",
        "Enhanced MR 一個檔：12 個時間點 × 20 片（TemporalPositionIndex ＋ FrameAcquisitionDateTime）",
        "MR",
        "enhanced_multiframe_temporal",
        ["PS3.3 C.7.6.16.2.2 Frame Content Macro；C.7.6.17 Multi-frame Dimension"],
        root,
    )
    for_uid = uid("for", case.case_id)
    series_uid = uid("series", case.case_id, "enh")
    g = MR_GEOM
    ds = _base(
        case,
        sop_class=ENHANCED_MR_SOP,
        sop_uid=uid("enh-sop", case.case_id),
        modality="MR",
        series_uid=series_uid,
        series_number=15,
        description="DCE Enhanced",
        for_uid=for_uid,
    )
    ds.ImageType = ["ORIGINAL", "PRIMARY", "VOLUME", "NONE"]
    ds.InstanceNumber = 1
    ds.ContentQualification = "RESEARCH"
    ds.ContentDate, ds.ContentTime = STUDY_DATE, "100000"
    ds.AcquisitionDateTime = f"{STUDY_DATE}100000"
    _pixel_module(ds, g.size[1], g.size[0])
    ds.BurnedInAnnotation = "NO"
    ds.PresentationLUTShape = "IDENTITY"
    ds.LossyImageCompression = "00"
    ds.MagneticFieldStrength = 1.5
    dim_uid = uid("dimorg", case.case_id)
    dorg = Dataset()
    dorg.DimensionOrganizationUID = dim_uid
    ds.DimensionOrganizationSequence = Sequence([dorg])
    ds.DimensionOrganizationType = "3D_TEMPORAL"
    di = []
    for pointer, label in (
        (0x00209128, "Temporal Position Index"),
        (0x00209056, "Stack ID"),
        (0x00209057, "In-Stack Position"),
    ):
        d = Dataset()
        d.DimensionOrganizationUID = dim_uid
        d.DimensionIndexPointer = pointer
        d.FunctionalGroupPointer = 0x00209111
        d.DimensionDescriptionLabel = label
        di.append(d)
    ds.DimensionIndexSequence = Sequence(di)
    shared = Dataset()
    pm = Dataset()
    pm.PixelSpacing = [g.spacing[1], g.spacing[0]]
    pm.SliceThickness = g.spacing[2]
    shared.PixelMeasuresSequence = Sequence([pm])
    po = Dataset()
    po.ImageOrientationPatient = list(g.iop)
    shared.PlaneOrientationSequence = Sequence([po])
    voi = Dataset()
    voi.WindowCenter, voi.WindowWidth = 600, 1200
    shared.FrameVOILUTSequence = Sequence([voi])
    ds.SharedFunctionalGroupsSequence = Sequence([shared])
    frames, pixels = [], []
    for t, ts in enumerate(DCE_TIMES_S):
        for k in range(g.size[2]):
            fg = Dataset()
            fc = Dataset()
            fc.StackID = "1"
            fc.InStackPositionNumber = k + 1
            fc.TemporalPositionIndex = t + 1
            fc.DimensionIndexValues = [t + 1, 1, k + 1]
            stamp = 36000.0 + ts
            h, rem = divmod(stamp, 3600)
            m, s = divmod(rem, 60)
            fc.FrameAcquisitionDateTime = f"{STUDY_DATE}{int(h):02d}{int(m):02d}{s:09.6f}"
            fc.FrameReferenceDateTime = fc.FrameAcquisitionDateTime
            fc.FrameAcquisitionDuration = 8000.0
            fg.FrameContentSequence = Sequence([fc])
            pp = Dataset()
            pp.ImagePositionPatient = g.ipp(k)
            fg.PlanePositionSequence = Sequence([pp])
            tp = Dataset()
            tp.TemporalPositionTimeOffset = ts
            fg.TemporalPositionSequence = Sequence([tp])
            frames.append(fg)
            pixels.append(abdomen_mr(g, k, ts).astype(np.uint16))
    ds.PerFrameFunctionalGroupsSequence = Sequence(frames)
    ds.NumberOfFrames = len(frames)
    ds.PixelData = np.stack(pixels).tobytes()
    _save(ds, case.root / "S015" / "ENH.dcm")
    case.series.append(
        {"series_instance_uid": series_uid, "description": "DCE Enhanced", "role": "dynamic", "frames": len(frames)}
    )
    case.expected = {
        "groups": [{**_dce_group(series_uid, key="(0020,9111)>(0020,9128) TemporalPositionIndex")}],
        "derived": [],
        "standalone": [],
        "warnings": [],
        "notes": "目前的影像載入器不支援 Enhanced 多幀 —— 這組留給日後支援時測試",
    }
    case.truth = _dce_truth()
    return case


def build_mr9(root: Path) -> Case:
    n = 8
    case = Case(
        "mr9",
        "4D-MRI 呼吸門控一個序列（ImageType RESP_GATED、TPI 1–8）—— 週期軸",
        "MR",
        "single_series_resp_gated",
        ["PS3.3 C.8.16.1 Image Type Value 3 defined term RESP_GATED"],
        root,
    )
    fr = [i / n for i in range(n)]
    s = _single_series_dynamic(
        case,
        number=11,
        description="4D MRI resp sorted",
        values=fr,
        pixels=lambda t, k: abdomen_mr(MR_GEOM, k, 0, contrast="resp", lesion_dz=tumor_offset_mm(fr[t])),
        per_volume=lambda t: {"TemporalPositionIdentifier": t + 1, "NumberOfTemporalPositions": n},
        image_type=["ORIGINAL", "PRIMARY", "M", "RESP_GATED"],
        acquisition_times=[0.0] * n,
    )
    case.series.append(
        {"series_instance_uid": s, "description": "4D MRI resp sorted", "role": "dynamic", "volumes": n, "slices": 20}
    )
    case.expected = {
        "groups": [
            {
                "kind": "cyclic",
                "axis": "phase",
                "frames": n,
                "single_series": s,
                "frame_key": "TemporalPositionIdentifier",
                "frame_labels": [f"{round(100 * f)}%" for f in fr],
                "frame_times_s": None,
                "confidence": "high",
            }
        ],
        "derived": [],
        "standalone": [],
        "warnings": [],
        "notes": "AcquisitionTime 全部相同（重新排序過的）；ImageType RESP_GATED → 週期軸",
    }
    case.truth = {
        "lesion_center_lps_per_frame": [
            [LESION_LPS[0], LESION_LPS[1], round(LESION_LPS[2] + tumor_offset_mm(f), 3)] for f in fr
        ]
    }
    return case


def build_mr10(root: Path) -> Case:
    n = 150
    dt = 0.25
    geom = Geom(size=(128, 128, 1), spacing=(2.5, 2.5, 7.0), origin=(LESION_LPS[0], -158.75, 158.75), iop=SAGITTAL)
    case = Case(
        "mr10",
        "cine：單一矢狀切面 150 幀、0.25 s（只有 AcquisitionTime ＋ InstanceNumber）",
        "MR",
        "single_series_cine_2d",
        ["TrackRAD2025（arXiv 2503.19119）：MR-Linac cine 匯出成單一序列的幀，沒有其他標記"],
        root,
    )
    times = [round(i * dt, 3) for i in range(n)]
    period = 4.0
    s = _single_series_dynamic(
        case,
        number=30,
        description="cine sag bSSFP",
        values=times,
        pixels=lambda t, _k: abdomen_mr(
            geom, 0, 0, contrast="resp", lesion_dz=tumor_offset_mm((times[t] % period) / period)
        ),
        per_volume=lambda t: {},
        image_type=["ORIGINAL", "PRIMARY", "M", "ND"],
        acquisition_times=times,
        geom=geom,
    )
    case.series.append(
        {"series_instance_uid": s, "description": "cine sag bSSFP", "role": "cine", "frames": n, "slices": 1}
    )
    case.expected = {
        "groups": [
            {
                "kind": "series",
                "axis": "time",
                "frames": n,
                "single_series": s,
                "frame_key": "AcquisitionTime",
                "frame_labels": None,
                "frame_times_s": times,
                "confidence": "medium",
            }
        ],
        "derived": [],
        "standalone": [],
        "warnings": [],
        "notes": "只有一片（2D）：網格 k ＝ 1；呼吸週期 4 s；"
        "真實 MR-Linac 的 cine 多半不是 DICOM（Unity 存在 DSA 的專有格式）",
    }
    case.truth = {
        "period_s": period,
        "lesion_dz_mm_per_frame": [round(tumor_offset_mm((t % period) / period), 3) for t in times],
    }
    return case


BUILDERS: dict[str, Callable[[Path], Case]] = {
    "ct1": build_ct1,
    "ct2": build_ct2,
    "ct3": build_ct3,
    "ct4": build_ct4,
    "ct5": build_ct5,
    "ct6": lambda root: build_ct2(root, irregular=True),
    "mr1": build_mr1,
    "mr2": build_mr2,
    "mr3": build_mr3,
    "mr4": build_mr4,
    "mr5": build_mr5,
    "mr6": build_mr6,
    "mr7": build_mr7,
    "mr8": build_mr8,
    "mr9": build_mr9,
    "mr10": build_mr10,
}


def build(out: Path, only: Iterable[str] | None = None) -> list[Case]:
    cases = []
    for cid in only or BUILDERS:
        root = out / cid
        if root.exists():
            import shutil

            shutil.rmtree(root)
        case = BUILDERS[cid](root)
        case.write_expected()
        cases.append(case)
    index = [
        {"id": c.case_id, "modality": c.modality, "pattern": c.pattern, "title": c.title, "patient_id": c.patient_id}
        for c in (load_expected(out / cid) for cid in BUILDERS if (out / cid / "expected.json").exists())
    ]
    (out / "index.json").write_text(json.dumps(index, ensure_ascii=False, indent=2), encoding="utf-8")
    return cases


@dataclass
class _Loaded:
    case_id: str
    modality: str
    pattern: str
    title: str
    patient_id: str


def load_expected(root: Path) -> _Loaded:
    d = json.loads((root / "expected.json").read_text(encoding="utf-8"))
    return _Loaded(d["id"], d["modality"], d["pattern"], d["title"], d["patient_id"])


def main(argv: list[str] | None = None) -> None:
    ap = argparse.ArgumentParser(description="產生 4D／動態影像的合成 DICOM 測資（CT ＋ MR）")
    ap.add_argument("--out", type=Path, default=Path("data/test_4d"))
    ap.add_argument("--only", default="", help="逗號分隔，例：ct1,mr1")
    ap.add_argument("--list", action="store_true")
    args = ap.parse_args(argv)
    if args.list:
        print(" ".join(BUILDERS))
        return
    only = [s.strip() for s in args.only.split(",") if s.strip()] or None
    for case in build(args.out, only):
        files = sum(1 for _ in case.root.rglob("*.dcm"))
        print(f"{case.case_id:5s} {case.modality}  {files:5d} 檔  {case.title}")


if __name__ == "__main__":
    main()
