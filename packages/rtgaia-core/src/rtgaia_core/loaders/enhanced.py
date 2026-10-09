"""Enhanced 多幀影像（Enhanced CT／MR、Legacy Converted）→ 每一幀一個「虛擬切片」。

Enhanced 物件把整個體積（或整個 4D）放在一個檔案裡：方向、間距、位置、Rescale 都在 Functional Group 裡
（Shared 或 Per-frame，PS3.3 C.7.6.16），而不是頂層 —— 以前影像載入器直接 `DL6 ImageOrientationPatient 必須有 6 個值`。

這裡把每一幀攤成一個 `InstanceHeader`（`frame_number` ＝ 第幾幀、1 起算；`refs["dyn"]` ＝ 這一幀的時間／相位欄位），
之後走跟傳統切片一樣的路：`series_geometry` 算網格與驗證、`analyze_series` 分幀（時間軸）、`read_pixels` 依幀讀。

每一幀的時間／相位（`refs["dyn"]`，跟 `temporal.dyn_tags` 同一組鍵）：
* Frame Content (0020,9111)：Temporal Position Index (0020,9128)、Frame Acquisition DateTime (0018,9074)
* Respiratory Synchronization (0020,9253) 的 Nominal % of Respiratory Phase (0020,9245)；
  Cardiac Synchronization (0018,9118) 的 (0020,9241)
* Temporal Position (0020,9310) 的 Temporal Position Time Offset (0020,930D)
* MR Echo (0018,9114) 的 Effective Echo Time；MR Diffusion (0018,9117) 的 b 值
* Frame Type（CT／MR Image Frame Type）→ `image_type`

Concatenation（一個物件拆成多個檔，C.7.6.16）：同一個 Concatenation UID 的各檔依 In-concatenation Number 接起來；
幀號仍是各檔自己的（讀像素用）。

虛擬切片的 SOP UID ＝ `{這個檔的 SOP Instance UID}#{這個檔裡的幀號}`（序列內不會重複）。匯出 RTSTRUCT 時拆回
Referenced SOP Instance UID ＋ Referenced Frame Number（PS3.3 C.10.1 Image SOP Instance Reference Macro）。
"""

from __future__ import annotations

from dataclasses import replace
from datetime import datetime
from typing import Any

from ..library.index import SeriesEntry
from ..library.scan import InstanceHeader


def _first(seq: Any) -> Any:
    try:
        return seq[0] if seq else None
    except (TypeError, IndexError):
        return None


def _group(fg: Any, shared: Any, name: str) -> Any:
    """Functional Group 的某個巨集：Per-frame 優先，沒有就 Shared。"""
    item = _first(getattr(fg, name, None)) if fg is not None else None
    if item is None and shared is not None:
        item = _first(getattr(shared, name, None))
    return item


def _floats(value: Any) -> list[float]:
    if value is None:
        return []
    try:
        return [float(v) for v in value]
    except TypeError:
        return [float(value)]


def _num(value: Any) -> float | None:
    try:
        return None if value is None or value == "" else float(value)
    except (TypeError, ValueError):
        return None


def _dt_seconds(value: Any) -> float | None:
    """DICOM DT（YYYYMMDDHHMMSS.FFFFFF）→ 當天的秒數；只用來排序與算相對時間。"""
    text = str(value or "").strip()
    if len(text) < 14:
        return None
    try:
        base = datetime.strptime(text[:14], "%Y%m%d%H%M%S")
    except ValueError:
        return None
    frac = float("0" + text[14:].split("+")[0].split("-")[0]) if len(text) > 14 and text[14] == "." else 0.0
    return base.hour * 3600 + base.minute * 60 + base.second + frac


def is_multiframe(entry: SeriesEntry) -> bool:
    return entry.is_image and any((h.number_of_frames or 1) > 1 for h in entry.instances)


def expand_multiframe(entry: SeriesEntry) -> SeriesEntry:
    """Enhanced 多幀的序列 → 每一幀一個虛擬切片的 `SeriesEntry`；不是多幀就原樣回。"""
    if not is_multiframe(entry):
        return entry
    import pydicom

    files: list[tuple[tuple[str, int, int], InstanceHeader, Any]] = []
    for h in entry.instances:
        ds = pydicom.dcmread(h.path, stop_before_pixels=True)
        concat = str(ds.get("ConcatenationUID", "") or "")
        order = (concat or ds.SOPInstanceUID, int(ds.get("InConcatenationNumber", 1) or 1), int(h.instance_number or 0))
        files.append((order, h, ds))
    files.sort(key=lambda x: x[0])
    frames: list[InstanceHeader] = []
    offsets: dict[str, int] = {}
    for (group_uid, _n, _inst), h, ds in files:
        shared = _first(ds.get("SharedFunctionalGroupsSequence"))
        per = ds.get("PerFrameFunctionalGroupsSequence") or []
        n_frames = int(ds.get("NumberOfFrames", 1) or 1)
        base = int(ds.get("ConcatenationFrameOffsetNumber", offsets.get(group_uid, 0)) or 0)
        offsets[group_uid] = base + n_frames
        top_type = [str(v).upper() for v in (ds.get("ImageType") or [])]
        for i in range(n_frames):
            fg = per[i] if i < len(per) else None
            measures = _group(fg, shared, "PixelMeasuresSequence")
            orient = _group(fg, shared, "PlaneOrientationSequence")
            position = _group(fg, shared, "PlanePositionSequence")
            rescale = _group(fg, shared, "PixelValueTransformationSequence")
            voi = _group(fg, shared, "FrameVOILUTSequence")
            content = _group(fg, None, "FrameContentSequence")
            resp = _group(fg, shared, "RespiratorySynchronizationSequence")
            cardiac = _group(fg, shared, "CardiacSynchronizationSequence")
            temporal = _group(fg, shared, "TemporalPositionSequence")
            echo = _group(fg, shared, "MREchoSequence")
            diffusion = _group(fg, shared, "MRDiffusionSequence")
            frame_type = _group(fg, shared, "CTImageFrameTypeSequence") or _group(
                fg, shared, "MRImageFrameTypeSequence"
            )
            offset = _num(getattr(temporal, "TemporalPositionTimeOffset", None)) if temporal is not None else None
            acquired = _dt_seconds(getattr(content, "FrameAcquisitionDateTime", None)) if content is not None else None
            dyn = {
                "image_type": [str(v).upper() for v in (getattr(frame_type, "FrameType", None) or top_type)],
                "tpi": _num(getattr(content, "TemporalPositionIndex", None)) if content is not None else None,
                "acquisition_number": None,
                "trigger_time": None,
                "acquisition_time": offset if offset is not None else acquired,
                "content_time": None,
                "echo_number": None,
                "echo_time": _num(getattr(echo, "EffectiveEchoTime", None)) if echo is not None else None,
                "b_value": _num(getattr(diffusion, "DiffusionBValue", None)) if diffusion is not None else None,
                "resp_phase": _num(getattr(resp, "NominalPercentageOfRespiratoryPhase", None)) if resp else None,
                "cardiac_phase": _num(getattr(cardiac, "NominalPercentageOfCardiacPhase", None)) if cardiac else None,
            }
            window = (_floats(getattr(voi, "WindowCenter", None)), _floats(getattr(voi, "WindowWidth", None)))
            frames.append(
                replace(
                    h,
                    sop_instance_uid=f"{ds.SOPInstanceUID}#{i + 1}",
                    instance_number=base + i + 1,
                    pixel_spacing=_floats(getattr(measures, "PixelSpacing", None)) or list(h.pixel_spacing),
                    slice_thickness=_num(getattr(measures, "SliceThickness", None)) or h.slice_thickness,
                    image_orientation_patient=_floats(getattr(orient, "ImageOrientationPatient", None))
                    or list(h.image_orientation_patient),
                    image_position_patient=_floats(getattr(position, "ImagePositionPatient", None))
                    or list(h.image_position_patient),
                    rescale_slope=(
                        _num(getattr(rescale, "RescaleSlope", None)) if rescale is not None else h.rescale_slope
                    ),
                    rescale_intercept=(
                        _num(getattr(rescale, "RescaleIntercept", None)) if rescale is not None else h.rescale_intercept
                    ),
                    window_center=window[0][0] if window[0] else h.window_center,
                    window_width=window[1][0] if window[1] else h.window_width,
                    number_of_frames=1,
                    frame_number=i + 1,
                    refs={**(h.refs or {}), "dyn": dyn},
                )
            )
    return replace(entry, instances=frames)
