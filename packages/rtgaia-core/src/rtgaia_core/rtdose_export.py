"""劑量運算結果存成 RTDOSE（DICOM PS3.3 2026d C.8.8.3、PS3.16 CID 7220）。

* **負值只能是 `DoseType=ERROR`**（C.8.8.3.4.6：`PixelRepresentation=0001H` 只在 ERROR 時允許）；RTDOSE 沒有
  Rescale Intercept，只有乘法的 `DoseGridScaling`，所以不能用位移把負值藏起來。
* 像素一律 32 位元（`BitsAllocated` 只能 16／32；32 位元讓 Dmax 的量化誤差 < 1e-9 倍）。
* 沒有資料的點（NaN，B 沒蓋到）寫 0 —— DICOM 沒有「無資料」的劑量值；`DerivationDescription` 寫明。
* 衍生紀錄用標準欄位：`DerivationCodeSequence`（DCM 121370 加減、121378 乘除權重）、
  `ReferencedInstanceSequence`（每個來源劑量，用途 DCM 121372）、B 經 REG 重取樣時
  `SpatialTransformOfDose=RIGID` ＋ `ReferencedSpatialRegistrationSequence`。運算鏈寫在 `DerivationDescription`
  （ST，1024）與 `DoseComment`（LO，64，截短）。
* `DoseType`、`DoseUnits`、`DoseSummationType` 由運算決定、不在可改標籤裡。
"""

from __future__ import annotations

import datetime as dt
from typing import Any

import numpy as np
from pydicom.dataset import Dataset, FileDataset, FileMetaDataset
from pydicom.uid import UID, ExplicitVRLittleEndian
from rtgaia_geom.grid import Grid

from .dicom_uid import IMPLEMENTATION_VERSION_NAME, implementation_class_uid, new_uid
from .rtstruct import ANONYMOUS_IDENTITY, EDITABLE_TAGS, PHI_TAGS, _has_non_ascii

RTDOSE_SOP_CLASS = UID("1.2.840.10008.5.1.4.1.1.481.2")
RTPLAN_SOP_CLASS = UID("1.2.840.10008.5.1.4.1.1.481.5")
SPATIAL_REGISTRATION_SOP_CLASS = UID("1.2.840.10008.5.1.4.1.1.66.1")

DOSE_EDITABLE_TAGS: dict[str, tuple[str, int]] = {
    k: v for k, v in EDITABLE_TAGS.items() if not k.startswith("StructureSet")
}
"""沿用 RS 匯出那份白名單，去掉只屬於結構集的欄位。"""

CODE_COMPOSED = ("121370", "Composed from prior doses")
CODE_WEIGHTED = ("121378", "Composed with weighting for fractions delivered")
CODE_SOURCE_DOSE = ("121372", "Source dose for composing current dose")

UINT32_MAX = 2**32 - 1
INT32_MAX = 2**31 - 1


def validate_dose_tags(tags: dict[str, Any]) -> dict[str, str]:
    """同 `rtstruct.validate_tags`，白名單換成 `DOSE_EDITABLE_TAGS`。"""
    from .rtstruct import validate_tags

    bad = [k for k in tags if k not in DOSE_EDITABLE_TAGS]
    if bad:
        raise ValueError("；".join(f"{k} 不在可改的標籤清單" for k in bad))
    return validate_tags(tags)


def _ds(x: float) -> str:
    """DS 最多 16 字元。"""
    s = f"{float(x):.10g}"
    return s if len(s) <= 16 else f"{float(x):.6e}"


def encode_dose(values_kji: np.ndarray, *, signed: bool) -> tuple[np.ndarray, float]:
    """Gy（float，可能有 NaN）→ (32 位元像素, DoseGridScaling)。`signed=False` 時不得有負值。"""
    v = np.nan_to_num(np.asarray(values_kji, dtype=np.float64), nan=0.0, posinf=0.0, neginf=0.0)
    if not signed and v.size and float(v.min()) < 0:
        raise ValueError("有負值的劑量只能存成 DoseType=ERROR（有號像素）")
    peak = float(np.abs(v).max()) if v.size else 0.0
    limit = INT32_MAX if signed else UINT32_MAX
    if peak <= 0:
        scaling = 1.0
    else:
        # DS 會被格式化（有效位數有限）→ 用格式化之後的值算像素，並確保 peak/scaling 不超過上限
        scaling = float(_ds(peak / limit * (1 + 1e-6)))
        while peak / scaling > limit:
            scaling = float(_ds(scaling * (1 + 1e-5)))
    pixels = np.rint(v / scaling)
    if signed:
        return np.clip(pixels, -INT32_MAX, INT32_MAX).astype(np.int32), scaling
    return np.clip(pixels, 0, UINT32_MAX).astype(np.uint32), scaling


def _code(value: tuple[str, str]) -> Dataset:
    c = Dataset()
    c.CodeValue = value[0]
    c.CodingSchemeDesignator = "DCM"
    c.CodeMeaning = value[1]
    return c


def build_rtdose(
    *,
    values_kji: np.ndarray,
    grid: Grid,
    study_uid: str,
    dose_type: str,
    summation_type: str,
    plan_sop_uids: list[str],
    source_dose_sop_uids: list[str],
    registration_sop_uids: list[str],
    weighted: bool,
    composed: bool,
    derivation_description: str,
    dose_comment: str,
    series_description: str,
    identity: dict[str, str] | None = None,
    tags: dict[str, str] | None = None,
    operator: str = "",
) -> FileDataset:
    """組出 RTDOSE。`values_kji` 是 Gy（`(k, j, i)`，NaN ＝ 沒資料 → 寫 0）。`identity` None ＝ 匿名。"""
    signed = dose_type == "ERROR"
    pixels, scaling = encode_dose(values_kji, signed=signed)
    now = dt.datetime.now()
    file_meta = FileMetaDataset()
    file_meta.MediaStorageSOPClassUID = RTDOSE_SOP_CLASS
    file_meta.MediaStorageSOPInstanceUID = new_uid()
    file_meta.TransferSyntaxUID = ExplicitVRLittleEndian
    file_meta.ImplementationClassUID = implementation_class_uid()
    file_meta.ImplementationVersionName = IMPLEMENTATION_VERSION_NAME

    ds = FileDataset("", {}, file_meta=file_meta, preamble=b"\0" * 128)
    ds.SOPClassUID = RTDOSE_SOP_CLASS
    ds.SOPInstanceUID = file_meta.MediaStorageSOPInstanceUID
    ds.InstanceCreationDate = now.strftime("%Y%m%d")
    ds.InstanceCreationTime = now.strftime("%H%M%S")
    ds.Modality = "RTDOSE"
    ds.Manufacturer = "RT-Gaia"
    ds.ManufacturerModelName = "RT-Gaia"
    ds.SoftwareVersions = "0.1.0"

    who = identity if identity is not None else ANONYMOUS_IDENTITY
    for tag in PHI_TAGS:
        setattr(ds, tag, who.get(tag, ""))
    ds.StudyInstanceUID = study_uid
    ds.StudyID = ""
    ds.ReferringPhysicianName = ""
    ds.AccessionNumber = ""
    if identity is not None:
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
        ds.StudyDate = now.strftime("%Y%m%d")
    if not getattr(ds, "StudyTime", ""):
        ds.StudyTime = now.strftime("%H%M%S")
    ds.SeriesInstanceUID = new_uid()
    ds.SeriesNumber = 1
    ds.SeriesDate = now.strftime("%Y%m%d")
    ds.SeriesTime = now.strftime("%H%M%S")
    ds.SeriesDescription = series_description[:64]
    ds.ContentDate = now.strftime("%Y%m%d")
    ds.ContentTime = now.strftime("%H%M%S")
    ds.InstanceNumber = 1
    if operator:
        ds.OperatorsName = operator[:64]
    ds.FrameOfReferenceUID = grid.frame_of_reference_uid
    ds.PositionReferenceIndicator = ""

    # ── 幾何（Image Plane ＋ Multi-frame）──────────────────────────────────────
    d = np.asarray(grid.direction, dtype=np.float64).reshape(3, 3)
    row_dir, col_dir, k_dir = d[:, 0], d[:, 1], d[:, 2]
    ni, nj, nk = (int(v) for v in grid.size)
    ds.ImagePositionPatient = [_ds(v) for v in grid.origin]
    ds.ImageOrientationPatient = [_ds(v) for v in (*row_dir, *col_dir)]
    ds.PixelSpacing = [_ds(grid.spacing[1]), _ds(grid.spacing[0])]
    ds.SliceThickness = _ds(grid.spacing[2])
    # 相對編碼（首項 0）；第三軸與 row×col 反向時位移是負的（loaders/rtdose 會把它翻回來）
    sign = 1.0 if float(np.dot(np.cross(row_dir, col_dir), k_dir)) >= 0 else -1.0
    ds.GridFrameOffsetVector = [_ds(sign * k * float(grid.spacing[2])) for k in range(nk)]
    ds.NumberOfFrames = nk
    ds.FrameIncrementPointer = 0x3004000C
    ds.Rows = nj
    ds.Columns = ni
    ds.SamplesPerPixel = 1
    ds.PhotometricInterpretation = "MONOCHROME2"
    ds.BitsAllocated = 32
    ds.BitsStored = 32
    ds.HighBit = 31
    ds.PixelRepresentation = 1 if signed else 0

    # ── RT Dose ────────────────────────────────────────────────────────────────
    ds.DoseUnits = "GY"
    ds.DoseType = dose_type
    ds.DoseSummationType = summation_type
    ds.DoseGridScaling = _ds(scaling)
    ds.DoseComment = dose_comment[:64]
    if plan_sop_uids:
        items = []
        for u in plan_sop_uids:
            it = Dataset()
            it.ReferencedSOPClassUID = RTPLAN_SOP_CLASS
            it.ReferencedSOPInstanceUID = u
            items.append(it)
        ds.ReferencedRTPlanSequence = items
    if registration_sop_uids:
        ds.SpatialTransformOfDose = "RIGID"
        regs = []
        for u in registration_sop_uids:
            it = Dataset()
            it.ReferencedSOPClassUID = SPATIAL_REGISTRATION_SOP_CLASS
            it.ReferencedSOPInstanceUID = u
            regs.append(it)
        ds.ReferencedSpatialRegistrationSequence = regs
    else:
        ds.SpatialTransformOfDose = "NONE"

    # ── 衍生紀錄 ───────────────────────────────────────────────────────────────
    codes = []
    if composed:
        codes.append(_code(CODE_COMPOSED))
    if weighted:
        codes.append(_code(CODE_WEIGHTED))
    if codes:
        ds.DerivationCodeSequence = codes
    ds.DerivationDescription = derivation_description[:1024]
    refs = []
    for u in source_dose_sop_uids:
        if not u:
            continue
        it = Dataset()
        it.ReferencedSOPClassUID = RTDOSE_SOP_CLASS
        it.ReferencedSOPInstanceUID = u
        it.PurposeOfReferenceCodeSequence = [_code(CODE_SOURCE_DOSE)]
        refs.append(it)
    if refs:
        ds.ReferencedInstanceSequence = refs

    for key, value in (tags or {}).items():
        if key == "SeriesNumber":
            ds.SeriesNumber = int(value) if value else 1
        else:
            setattr(ds, key, value)
    if _has_non_ascii(ds):
        ds.SpecificCharacterSet = "ISO_IR 192"

    ds.PixelData = np.ascontiguousarray(pixels).astype(pixels.dtype.newbyteorder("<")).tobytes()
    return ds
