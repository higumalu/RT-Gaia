"""RTSTRUCT 產生與輸出。

> 「TPS 整合」不在範圍內，**但「產生 RTSTRUCT」是核心**——沒有它產品
> 迴路不閉合。

做法是「從 labelmap 在**取像平面**重抽輪廓」：這是唯一與 RTSTRUCT
原生語意相容的方向。輪廓是平面上的曲線（型態 F3），而 mask 是體素場（F1）；
在斜面上抽輪廓再存進 RTSTRUCT 是錯的，因為 RTSTRUCT 的每個 contour 都隱含
「共面」。

⚠️ 假體沒有真的 DICOM 影像檔，因此 `ReferencedSOPInstanceUID` 由序列 UID ＋ slice 序號**確定性地合成**；
library 病例給 `slice_sop_uids` 就引用**真實的** SOP Instance UID，並可帶真實病人識別（`identity`，
關閉匿名化時）—— 這樣 TPS 才會把它掛到正確的病人與影像上。
"""

from __future__ import annotations

import datetime as dt
from typing import Any

import numpy as np
from pydicom.dataset import Dataset, FileDataset, FileMetaDataset
from pydicom.uid import UID, ExplicitVRLittleEndian
from rtgaia_geom.grid import Grid
from skimage import measure

from .dicom_uid import IMPLEMENTATION_VERSION_NAME, as_dicom_uid, implementation_class_uid, new_uid

RTSTRUCT_SOP_CLASS = UID("1.2.840.10008.5.1.4.1.1.481.3")
CT_IMAGE_SOP_CLASS = UID("1.2.840.10008.5.1.4.1.1.2")

MIN_CONTOUR_POINTS = 3
"""少於 3 點的輪廓不寫出。

RTSTRUCT 的 CLOSED_PLANAR 需要一個多邊形；1–2 點的殘渣是體素邊緣的雜訊，
寫進去會讓 TPS 端出現零面積 ROI。
"""


def slice_sop_uid(series_uid: str, k: int) -> str:
    """確定性合成的 SOP Instance UID（見模組開頭的警告）。
    結果一定是合法 UID（太長、不是數字 → `as_dicom_uid`）。"""
    return as_dicom_uid(f"{series_uid}.{k + 1}")


def extract_contours(mask_dense: np.ndarray, grid: Grid) -> list[tuple[int, np.ndarray]]:
    """在**取像平面（k 固定）**上抽輪廓，回傳 `[(k, (N, 3) 世界座標), ...]`。"""
    out: list[tuple[int, np.ndarray]] = []
    for k in range(mask_dense.shape[0]):
        plane = mask_dense[k]
        if not plane.any():
            continue
        for contour in measure.find_contours(plane.astype(np.float32), 0.5):
            if len(contour) < MIN_CONTOUR_POINTS:
                continue
            # find_contours 回傳 (row, col) = (j, i)
            ijk = np.stack([contour[:, 1], contour[:, 0], np.full(len(contour), float(k))], axis=1)
            out.append((k, grid.index_to_world(ijk)))
    return out


ANONYMOUS_IDENTITY: dict[str, str] = {
    "PatientName": "PHANTOM^RTGAIA",
    "PatientID": "RTGAIA-TESTBE",
    "PatientBirthDate": "",
    "PatientSex": "",
}
"""匿名化（預設）時寫進 RTSTRUCT 的病人欄位。"""

IDENTITY_TAGS = (
    "PatientName",
    "PatientID",
    "PatientBirthDate",
    "PatientSex",
    "StudyID",
    "StudyDate",
    "StudyTime",
    "StudyDescription",
    "AccessionNumber",
    "ReferringPhysicianName",
)
"""關閉匿名化時從影像第一片帶過來的欄位（病人識別 ＋ study 層描述）。"""


EDITABLE_TAGS: dict[str, tuple[str, int]] = {
    # keyword: (VR, 最大長度)。匯出時使用者可改的 DICOM 標籤（白名單；其餘一律由系統寫）
    "StructureSetLabel": ("SH", 16),
    "StructureSetName": ("LO", 64),
    "StructureSetDescription": ("ST", 1024),
    "SeriesDescription": ("LO", 64),
    "SeriesNumber": ("IS", 12),
    "OperatorsName": ("PN", 64),
    "ReferringPhysicianName": ("PN", 64),
    "InstitutionName": ("LO", 64),
    "StationName": ("SH", 16),
    "StudyDescription": ("LO", 64),
    "AccessionNumber": ("SH", 16),
    "PatientName": ("PN", 64),
    "PatientID": ("LO", 64),
    "PatientBirthDate": ("DA", 8),
    "PatientSex": ("CS", 1),
}
PHI_TAGS = ("PatientName", "PatientID", "PatientBirthDate", "PatientSex")


def validate_tags(tags: dict[str, Any]) -> dict[str, str]:
    """白名單、長度、VR 形狀（DA 八位數字、CS 性別 M/F/O、IS 整數）。錯了 `ValueError`（路由轉 422）。"""
    out: dict[str, str] = {}
    problems: list[str] = []
    for key, raw in tags.items():
        if key not in EDITABLE_TAGS:
            problems.append(f"{key} 不在可改的標籤清單")
            continue
        vr, max_len = EDITABLE_TAGS[key]
        value = "" if raw is None else str(raw).strip()
        if len(value) > max_len:
            problems.append(f"{key} 最多 {max_len} 個字元")
            continue
        if vr == "DA" and value and not (len(value) == 8 and value.isdigit()):
            problems.append(f"{key} 要 YYYYMMDD")
            continue
        if vr == "CS" and key == "PatientSex" and value.upper() not in ("", "M", "F", "O"):
            problems.append("PatientSex 只能是 M／F／O 或空")
            continue
        if vr == "IS" and value and not value.lstrip("-").isdigit():
            problems.append(f"{key} 要整數")
            continue
        if vr == "PN":
            value = value.replace(" ", "^") if "^" not in value and " " in value else value
        out[key] = value.upper() if vr == "CS" else value
    if problems:
        raise ValueError("；".join(problems))
    return out


def read_identity(path: str) -> dict[str, str]:
    """從一張影像讀 `IDENTITY_TAGS`（只讀標頭）。缺的欄位給空字串。"""
    import pydicom

    ds = pydicom.dcmread(path, stop_before_pixels=True, specific_tags=list(IDENTITY_TAGS))
    return {tag: str(getattr(ds, tag, "") or "") for tag in IDENTITY_TAGS}


def build_rtstruct(
    *,
    structures: list[dict[str, Any]],
    grid: Grid,
    series_uid: str,
    study_uid: str,
    frame_of_reference_uid: str,
    label: str = "RT-Gaia testbe",
    description: str | None = None,
    identity: dict[str, str] | None = None,
    slice_sop_uids: list[str] | tuple[str, ...] | None = None,
    image_sop_class_uid: str | None = None,
    tags: dict[str, str] | None = None,
    operator: str = "",
    charset: str | None = "ISO_IR 192",
    series_description: str = "",
) -> FileDataset:
    """組出一份最小但可被 pydicom 讀回的 RTSTRUCT。

    `structures` 的每一項：`{structure_id, name, color_rgb, mask_dense, interpreted_type}`。
    `identity`：None ＝ 匿名（`ANONYMOUS_IDENTITY`）；給了就寫真實病人識別與 study 描述（可關閉匿名化）。
    `slice_sop_uids`：每一片（k 順序）真實的 SOP Instance UID；None 或長度不符 → 合成。
    `tags`：使用者改的標籤（`validate_tags` 過的白名單），最後套、蓋過預設與 identity；`operator` → OperatorsName 預設。
    """
    now = dt.datetime.now()
    file_meta = FileMetaDataset()
    file_meta.MediaStorageSOPClassUID = RTSTRUCT_SOP_CLASS
    file_meta.MediaStorageSOPInstanceUID = new_uid()  # 前綴來自 RTGAIA_UID_ROOT（預設 pydicom）
    file_meta.TransferSyntaxUID = ExplicitVRLittleEndian
    file_meta.ImplementationClassUID = implementation_class_uid()
    file_meta.ImplementationVersionName = IMPLEMENTATION_VERSION_NAME

    ds = FileDataset("", {}, file_meta=file_meta, preamble=b"\0" * 128)
    ds.SOPClassUID = RTSTRUCT_SOP_CLASS
    ds.SOPInstanceUID = file_meta.MediaStorageSOPInstanceUID
    # UTF-8：標籤／描述可含中文（例：「王醫師 的結構集」）；沒設會寫成 ????
    # Varian profile 把結構層的文字轉成 ASCII 後傳 charset=None → 不寫（預設字元集）；
    # 病人識別若仍含非 ASCII 就退回 UTF-8（見檔尾 `_has_non_ascii`）
    if charset:
        ds.SpecificCharacterSet = charset
    ds.Modality = "RTSTRUCT"
    # 假體的內部 id 不是合法 UID → 寫進 DICOM 前換成確定性的 2.25 UID（真實病例原樣）
    study_uid = as_dicom_uid(study_uid)
    frame_of_reference_uid = as_dicom_uid(frame_of_reference_uid)
    referenced_series_uid = as_dicom_uid(series_uid)
    ds.StudyInstanceUID = study_uid
    ds.SeriesInstanceUID = new_uid()
    ds.StructureSetLabel = label[:16]
    ds.StructureSetDate = now.strftime("%Y%m%d")
    ds.StructureSetTime = now.strftime("%H%M%S")
    ds.SeriesDescription = (series_description or description or label)[:64]
    if description:
        ds.StructureSetDescription = description[:1024]
    if operator:
        ds.OperatorsName = operator[:64]
    who = identity if identity is not None else ANONYMOUS_IDENTITY
    for tag in ("PatientName", "PatientID", "PatientBirthDate", "PatientSex"):
        setattr(ds, tag, who.get(tag, ""))
    if identity is not None:
        # study 層跟著原影像（TPS 以 StudyInstanceUID 掛，但描述也一致比較不會讓人以為是另一個 study）
        for tag in (
            "StudyID",
            "StudyDate",
            "StudyTime",
            "StudyDescription",
            "AccessionNumber",
            "ReferringPhysicianName",
        ):
            if identity.get(tag):
                setattr(ds, tag, identity[tag])
    if not getattr(ds, "StudyDate", ""):
        ds.StudyDate = ds.StructureSetDate
    ds.SeriesNumber = 1
    image_sop_class = UID(image_sop_class_uid) if image_sop_class_uid else CT_IMAGE_SOP_CLASS
    n_slices = int(grid.size[2])
    real = list(slice_sop_uids) if slice_sop_uids and len(slice_sop_uids) == n_slices else None

    def sop_for(k: int) -> str:
        return real[k] if real is not None else slice_sop_uid(series_uid, k)

    def image_ref(k: int) -> Dataset:
        """一片的 Image SOP Instance Reference（C.10.1）。

        Enhanced 多幀的虛擬切片 `UID#幀號` → 拆成 Referenced SOP Instance UID ＋ Referenced Frame Number。"""
        item = Dataset()
        item.ReferencedSOPClassUID = image_sop_class
        uid, _, frame = sop_for(k).partition("#")
        item.ReferencedSOPInstanceUID = uid
        if frame:
            item.ReferencedFrameNumber = int(frame)
        return item

    ds.Manufacturer = "RT-Gaia"
    ds.ManufacturerModelName = "RT-Gaia"
    ds.SoftwareVersions = "0.1.0"

    # ReferencedFrameOfReferenceSequence
    contour_image_seq = []
    for k in range(n_slices):
        contour_image_seq.append(image_ref(k))
    rt_series = Dataset()
    rt_series.SeriesInstanceUID = referenced_series_uid
    rt_series.ContourImageSequence = contour_image_seq
    study_item = Dataset()
    study_item.ReferencedSOPClassUID = UID("1.2.840.10008.3.1.2.3.1")
    study_item.ReferencedSOPInstanceUID = study_uid
    study_item.RTReferencedSeriesSequence = [rt_series]
    frame_item = Dataset()
    frame_item.FrameOfReferenceUID = frame_of_reference_uid
    frame_item.RTReferencedStudySequence = [study_item]
    ds.ReferencedFrameOfReferenceSequence = [frame_item]

    roi_seq: list[Dataset] = []
    contour_seq: list[Dataset] = []
    obs_seq: list[Dataset] = []

    for n, st in enumerate(structures, start=1):
        roi = Dataset()
        roi.ROINumber = n
        roi.ReferencedFrameOfReferenceUID = frame_of_reference_uid
        roi.ROIName = st["name"]
        if st.get("roi_description"):
            roi.ROIDescription = st["roi_description"]  # profile 改過名時保留原名
        roi.ROIGenerationAlgorithm = st.get("generation_algorithm") or "SEMIAUTOMATIC"
        roi_seq.append(roi)

        contours: list[Dataset] = []
        for k, world in extract_contours(st["mask_dense"], grid):
            c = Dataset()
            c.ContourGeometricType = "CLOSED_PLANAR"
            c.NumberOfContourPoints = len(world)
            c.ContourData = [float(v) for v in world.flatten()]
            c.ContourImageSequence = [image_ref(k)]
            contours.append(c)

        roi_contour = Dataset()
        roi_contour.ReferencedROINumber = n
        roi_contour.ROIDisplayColor = [int(v) for v in st["color_rgb"]]
        roi_contour.ContourSequence = contours
        contour_seq.append(roi_contour)

        obs = Dataset()
        obs.ObservationNumber = n
        obs.ReferencedROINumber = n
        obs.RTROIInterpretedType = st.get("interpreted_type") or "ORGAN"
        obs.ROIInterpreter = ""
        obs_seq.append(obs)

    ds.StructureSetROISequence = roi_seq
    ds.ROIContourSequence = contour_seq
    ds.RTROIObservationsSequence = obs_seq
    # 使用者改的標籤最後套（白名單；空字串＝清空該欄）
    for key, value in (tags or {}).items():
        if key == "SeriesNumber":
            ds.SeriesNumber = int(value) if value else 1
        else:
            setattr(ds, key, value)
    # 字元集要涵蓋最後寫進去的全部文字（病人識別、使用者改的標籤）：有非 ASCII 就一定要宣告 UTF-8
    if not charset and _has_non_ascii(ds):
        ds.SpecificCharacterSet = "ISO_IR 192"
    return ds


_TEXT_VRS = frozenset({"PN", "LO", "SH", "ST", "LT", "UT", "UC"})


def _has_non_ascii(ds: Dataset) -> bool:
    found = False

    def visit(d: Dataset) -> None:
        nonlocal found
        for elem in d:
            if found:
                return
            if elem.VR == "SQ":
                for item in elem.value:
                    visit(item)
            elif elem.VR in _TEXT_VRS and elem.value is not None and any(ord(c) > 126 for c in str(elem.value)):
                found = True

    visit(ds)
    return found
