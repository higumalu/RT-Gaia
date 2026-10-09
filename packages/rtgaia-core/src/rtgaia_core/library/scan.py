"""DICOM 標頭掃描 —— **索引（資料選取頁）與載入器共用的同一份**。

只讀標頭（`stop_before_pixels=True`），570 個檔案約 1–2 s。每個檔案變成一個
`InstanceHeader`，帶著該模態需要的**參照關係**（RTSTRUCT 參照哪個序列、RTDOSE
參照哪個 RTPLAN、REG 描述哪兩個 FoR 之間的矩陣），之後不必再開檔。

🔴 這裡**不解讀**幾何、不做任何驗證 —— 那是各載入器的事（`loaders/dicom.py`
的 DL1–DL12、`loaders/rtdose.py`、`loaders/registration.py`）。掃描器只負責
「這個檔案是什麼、它指向誰」。
"""

from __future__ import annotations

import os
from collections.abc import Iterable
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any

import pydicom

from ..phi import hash_patient_name

IMAGE_MODALITIES = frozenset({"CT", "MR", "PT", "CBCT", "NM", "US"})
RT_MODALITIES = frozenset({"RTSTRUCT", "RTDOSE", "RTPLAN", "REG"})

# 掃描時一次讀完的標籤。序列類標籤（RTSTRUCT／RTDOSE／RTPLAN／REG 的參照）也在
# 這裡，因此索引建好之後**不必再開任何檔案**就能畫出參照圖。
_TAGS = [
    "SOPInstanceUID",
    "SOPClassUID",
    "Modality",
    "SeriesInstanceUID",
    "StudyInstanceUID",
    "FrameOfReferenceUID",
    "PatientID",
    "PatientName",
    "StudyDate",
    "StudyDescription",
    "SeriesDate",
    "SeriesTime",
    "SeriesDescription",
    "SeriesNumber",
    "InstanceNumber",
    "Manufacturer",
    "ManufacturerModelName",
    # 影像幾何（載入器用）
    "Rows",
    "Columns",
    "PixelSpacing",
    "ImageOrientationPatient",
    "ImagePositionPatient",
    "SliceThickness",
    "RescaleSlope",
    "RescaleIntercept",
    "WindowCenter",
    "WindowWidth",
    "NumberOfFrames",
    # RTSTRUCT
    "StructureSetLabel",
    "StructureSetDate",
    "StructureSetROISequence",
    "ReferencedFrameOfReferenceSequence",
    # RTDOSE
    "DoseUnits",
    "DoseType",
    "DoseSummationType",
    "DoseGridScaling",
    "GridFrameOffsetVector",
    "ReferencedRTPlanSequence",
    "DerivationCodeSequence",
    "DerivationDescription",
    "DoseComment",
    # RTPLAN
    "RTPlanLabel",
    "RTPlanDate",
    "ReferencedStructureSetSequence",
    "DoseReferenceSequence",
    "FractionGroupSequence",
    # REG
    "RegistrationSequence",
    "DeformableRegistrationSequence",
    "ReferencedSeriesSequence",
    "StudiesContainingOtherReferencedInstancesSequence",
]


@dataclass(frozen=True)
class InstanceHeader:
    """一個 DICOM 檔案的標頭摘要。**可 JSON 化**（索引快取用）。"""

    path: str
    mtime_ns: int
    size: int
    sop_instance_uid: str
    sop_class_uid: str
    modality: str
    series_instance_uid: str
    study_instance_uid: str
    frame_of_reference_uid: str
    patient_id: str
    patient_name_hash: str
    """PatientName 的 HMAC（`phi.hash_patient_name`）；**明文不進任何快取或 DB**。"""
    study_date: str
    study_description: str
    series_date: str
    series_time: str
    series_description: str
    series_number: str
    instance_number: int | None
    manufacturer: str
    manufacturer_model_name: str
    # 影像幾何（只有影像才有）
    rows: int | None = None
    columns: int | None = None
    pixel_spacing: list[float] = field(default_factory=list)
    image_orientation_patient: list[float] = field(default_factory=list)
    image_position_patient: list[float] = field(default_factory=list)
    slice_thickness: float | None = None
    rescale_slope: float | None = None
    rescale_intercept: float | None = None
    window_center: float | None = None
    window_width: float | None = None
    number_of_frames: int | None = None
    # 模態專屬的參照關係（見 `_refs_for`）
    refs: dict[str, Any] = field(default_factory=dict)
    # file meta 的 TransferSyntaxUID（壓縮格式決定解不解得了）；舊快取／舊 DB 列沒有 ＝ ""
    transfer_syntax_uid: str = ""
    # Enhanced 多幀攤開後的虛擬切片 ＝ 第幾幀（1 起算）；一般切片 None。只在開病例時出現，不進快取
    frame_number: int | None = None

    @property
    def is_image(self) -> bool:
        return self.modality in IMAGE_MODALITIES

    def to_json(self) -> dict[str, Any]:
        return asdict(self)

    @classmethod
    def from_json(cls, d: dict[str, Any]) -> InstanceHeader:
        d = dict(d)
        # 舊快取／舊 DB 列帶明文 `patient_name` → 當場換成雜湊，明文不留在記憶體
        legacy = d.pop("patient_name", None)
        if "patient_name_hash" not in d:
            from ..phi import hash_patient_name

            d["patient_name_hash"] = hash_patient_name(legacy)
        return cls(**d)


# ── 讀取 ─────────────────────────────────────────────────────────────────────


def _floats(value: Any) -> list[float]:
    if value is None:
        return []
    if isinstance(value, (bytes, str, int, float)):
        try:
            return [float(value)]
        except ValueError:
            return []
    try:
        return [float(v) for v in value]
    except (TypeError, ValueError):
        return []


def _first_float(value: Any) -> float | None:
    vs = _floats(value)
    return vs[0] if vs else None


def _str(ds: pydicom.Dataset, name: str) -> str:
    v = ds.get(name)
    return "" if v is None else str(v)


def _int(ds: pydicom.Dataset, name: str) -> int | None:
    v = ds.get(name)
    try:
        return None if v is None or v == "" else int(v)
    except (TypeError, ValueError):
        return None


def _refs_for(ds: pydicom.Dataset, modality: str) -> dict[str, Any]:
    """該模態「指向誰」。全部是 UID 與純量，不含幾何。"""
    refs: dict[str, Any] = {}
    if modality == "RTSTRUCT":
        series_uids: list[str] = []
        fors: list[str] = []
        for rf in ds.get("ReferencedFrameOfReferenceSequence", []) or []:
            fors.append(_str(rf, "FrameOfReferenceUID"))
            for st in rf.get("RTReferencedStudySequence", []) or []:
                for se in st.get("RTReferencedSeriesSequence", []) or []:
                    uid = _str(se, "SeriesInstanceUID")
                    if uid:
                        series_uids.append(uid)
        rois = list(ds.get("StructureSetROISequence", []) or [])
        refs.update(
            {
                "referenced_series_uids": series_uids,
                "referenced_frame_of_reference_uids": [f for f in fors if f],
                "structure_set_label": _str(ds, "StructureSetLabel"),
                "structure_set_date": _str(ds, "StructureSetDate"),
                "roi_count": len(rois),
                "roi_names": [str(r.get("ROIName", "")) for r in rois],
                "roi_frame_of_reference_uids": sorted(
                    {str(r.get("ReferencedFrameOfReferenceUID", "")) for r in rois} - {""}
                ),
            }
        )
    elif modality == "RTDOSE":
        gfov = _floats(ds.get("GridFrameOffsetVector"))
        refs.update(
            {
                "referenced_plan_sop_uids": [
                    _str(x, "ReferencedSOPInstanceUID") for x in ds.get("ReferencedRTPlanSequence", []) or []
                ],
                "dose_units": _str(ds, "DoseUnits"),
                "dose_type": _str(ds, "DoseType"),
                "dose_summation_type": _str(ds, "DoseSummationType"),
                "dose_grid_scaling": _first_float(ds.get("DoseGridScaling")),
                "frame_count": len(gfov) if gfov else _int(ds, "NumberOfFrames"),
                # RT-Gaia 劑量運算存的 RTDOSE（CID 7220 衍生碼）—— 資料頁掛在影像底下、標「衍生劑量」
                "derived": any(
                    _str(c, "CodeValue") in ("121370", "121378") for c in ds.get("DerivationCodeSequence", []) or []
                ),
                "derivation_description": _str(ds, "DerivationDescription"),
                "dose_comment": _str(ds, "DoseComment"),
            }
        )
    elif modality == "RTPLAN":
        prescriptions = [
            _first_float(dr.get("TargetPrescriptionDose")) for dr in ds.get("DoseReferenceSequence", []) or []
        ]
        fractions = [_int(fg, "NumberOfFractionsPlanned") for fg in ds.get("FractionGroupSequence", []) or []]
        refs.update(
            {
                "plan_label": _str(ds, "RTPlanLabel"),
                "plan_date": _str(ds, "RTPlanDate"),
                "referenced_structure_set_sop_uids": [
                    _str(x, "ReferencedSOPInstanceUID") for x in ds.get("ReferencedStructureSetSequence", []) or []
                ],
                "prescription_gy": [p for p in prescriptions if p is not None],
                "fractions_planned": [f for f in fractions if f is not None],
            }
        )
    elif modality == "REG":
        items: list[dict[str, Any]] = []
        for reg in ds.get("RegistrationSequence", []) or []:
            matrices: list[dict[str, Any]] = []
            for mreg in reg.get("MatrixRegistrationSequence", []) or []:
                for m in mreg.get("MatrixSequence", []) or []:
                    matrices.append(
                        {
                            "type": _str(m, "FrameOfReferenceTransformationMatrixType"),
                            "matrix_row_major": _floats(m.get("FrameOfReferenceTransformationMatrix")),
                        }
                    )
            items.append(
                {
                    "frame_of_reference_uid": _str(reg, "FrameOfReferenceUID"),
                    "matrices": matrices,
                    "referenced_image_count": len(reg.get("ReferencedImageSequence", []) or []),
                }
            )
        refs.update(
            {
                "registration_items": items,
                "deformable": bool(ds.get("DeformableRegistrationSequence")),
                "referenced_series_uids": [
                    _str(x, "SeriesInstanceUID") for x in ds.get("ReferencedSeriesSequence", []) or []
                ],
            }
        )
    return refs


def read_header(path: Path) -> InstanceHeader | None:
    """讀一個檔案的標頭；不是 DICOM 或沒有 SeriesInstanceUID 就回 None。"""
    try:
        ds = pydicom.dcmread(str(path), stop_before_pixels=True, specific_tags=_TAGS, force=False)
    except Exception:  # noqa: BLE001 - 不是 DICOM 就跳過
        return None
    series_uid = _str(ds, "SeriesInstanceUID")
    if not series_uid:
        return None
    modality = _str(ds, "Modality")
    stat = path.stat()
    return InstanceHeader(
        path=str(path),
        mtime_ns=stat.st_mtime_ns,
        size=stat.st_size,
        sop_instance_uid=_str(ds, "SOPInstanceUID"),
        sop_class_uid=_str(ds, "SOPClassUID"),
        modality=modality,
        series_instance_uid=series_uid,
        study_instance_uid=_str(ds, "StudyInstanceUID"),
        frame_of_reference_uid=_str(ds, "FrameOfReferenceUID"),
        patient_id=_str(ds, "PatientID"),
        patient_name_hash=hash_patient_name(_str(ds, "PatientName")),
        study_date=_str(ds, "StudyDate"),
        study_description=_str(ds, "StudyDescription"),
        series_date=_str(ds, "SeriesDate"),
        series_time=_str(ds, "SeriesTime"),
        series_description=_str(ds, "SeriesDescription"),
        series_number=_str(ds, "SeriesNumber"),
        instance_number=_int(ds, "InstanceNumber"),
        manufacturer=_str(ds, "Manufacturer"),
        manufacturer_model_name=_str(ds, "ManufacturerModelName"),
        rows=_int(ds, "Rows"),
        columns=_int(ds, "Columns"),
        pixel_spacing=_floats(ds.get("PixelSpacing")),
        image_orientation_patient=_floats(ds.get("ImageOrientationPatient")),
        image_position_patient=_floats(ds.get("ImagePositionPatient")),
        slice_thickness=_first_float(ds.get("SliceThickness")),
        rescale_slope=_first_float(ds.get("RescaleSlope")),
        rescale_intercept=_first_float(ds.get("RescaleIntercept")),
        window_center=_first_float(ds.get("WindowCenter")),
        window_width=_first_float(ds.get("WindowWidth")),
        number_of_frames=_int(ds, "NumberOfFrames"),
        refs=_refs_for(ds, modality),
        transfer_syntax_uid=str(getattr(getattr(ds, "file_meta", None), "TransferSyntaxUID", "") or ""),
    )


def iter_files(root: Path) -> Iterable[Path]:
    """遞迴列出檔案，跳過隱藏目錄與我們自己的快取。"""
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = sorted(d for d in dirnames if not d.startswith(".") and d != "__pycache__")
        for name in sorted(filenames):
            if name.startswith("."):
                continue
            yield Path(dirpath) / name


def scan_tree(
    root: str | Path,
    *,
    previous: dict[str, InstanceHeader] | None = None,
) -> list[InstanceHeader]:
    """掃描一棵目錄樹。`previous`（path → header）讓沒變動的檔案不必重讀。"""
    root = Path(root)
    if root.is_file():
        h = read_header(root)
        return [h] if h else []
    out: list[InstanceHeader] = []
    for path in iter_files(root):
        cached = previous.get(str(path)) if previous else None
        if cached is not None:
            try:
                stat = path.stat()
            except OSError:
                continue
            # 這個欄位加進來之前快取的影像標頭沒有 TransferSyntax → 重讀一次（之後就有了）
            stale = cached.is_image and not cached.transfer_syntax_uid
            if stat.st_mtime_ns == cached.mtime_ns and stat.st_size == cached.size and not stale:
                out.append(cached)
                continue
        h = read_header(path)
        if h is not None:
            out.append(h)
    return out
