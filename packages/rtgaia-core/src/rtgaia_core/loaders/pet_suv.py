"""PET 的 SUV 換算（SUVbw，體重標準化）。

PET 影像的像素套完 Rescale 是活度濃度（`Units = BQML`，Bq/ml）。臨床讀 PET 看的是 SUV：

    SUVbw = 活度濃度（Bq/ml）× 體重（g）÷ 衰變到取像參考時間的注射劑量（Bq）

## 什麼時候換算 —— 標籤不齊就**不猜**

* `Units` 是 `BQML`（`CNTS`、`GML` 等其他單位不換）
* `DecayCorrection` 是 `START`（影像已衰變校正到取像開始 → 劑量也衰變到那一刻）
  或 `ADMIN`（已校正到注射時 → 劑量不衰變）。
  `NONE`（每片各自的時間）不換：要每片自己的衰變，先不做
* `PatientWeight` > 0、`RadionuclideTotalDose` > 0、`RadionuclideHalfLife` > 0、
  注射時間（`RadiopharmaceuticalStartDateTime`，或 `SeriesDate` ＋ `RadiopharmaceuticalStartTime`）都要有

缺一個 → 不換，像素維持 Bq/ml，`reason` 說缺什麼（前端讀數單位標 `Bq/ml`，不是 SUV）。

## 取像參考時間（QIBA 的做法）

`START` 的參考時間是 `SeriesDate`／`SeriesTime`；但有些機器後處理會把 `SeriesTime` 改成重建時間（晚於取像）——
`SeriesTime` 比最早的 `AcquisitionTime` 晚 → 改用最早的 `AcquisitionTime`。

## 存法

SUV × 100 存成 int16（0.01 SUV 的精度，上限 327 SUV）；layer `params` 標 `value_unit: 'SUV'`、`value_scale: 0.01`，
前端讀數與 W/L 欄位乘回來。沒有換算的 PET 標 `value_unit: 'Bq/ml'`（`value_scale` 1）。
"""

from __future__ import annotations

import math
from dataclasses import dataclass, replace
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any

import pydicom

from .dicom import SeriesGeometry

SUV_STORE_SCALE = 100.0
"""SUV 以 ×100 存成 int16（0.01 SUV 精度）。"""

SUV_DEFAULT_WINDOW = (2.5, 5.0)
"""SUV 的預設窗（中心、寬）：SUV 0–5，FDG 讀片的常用範圍。"""


@dataclass(frozen=True)
class SuvInfo:
    factor: float
    """Bq/ml × factor ＝ SUVbw。"""
    weight_kg: float
    injected_dose_bq: float
    decayed_dose_bq: float
    half_life_s: float
    decay_correction: str
    injection_time: str
    reference_time: str
    elapsed_s: float
    radiopharmaceutical: str

    def wire(self) -> dict[str, Any]:
        return {
            "kind": "SUVbw",
            "weight_kg": self.weight_kg,
            "injected_dose_bq": self.injected_dose_bq,
            "decayed_dose_bq": round(self.decayed_dose_bq, 1),
            "half_life_s": self.half_life_s,
            "decay_correction": self.decay_correction,
            "injection_time": self.injection_time,
            "reference_time": self.reference_time,
            "elapsed_s": round(self.elapsed_s, 1),
            "radiopharmaceutical": self.radiopharmaceutical,
        }


def _float(value: Any) -> float | None:
    try:
        v = float(value)
    except (TypeError, ValueError):
        return None
    return v if math.isfinite(v) else None


def parse_dicom_datetime(date: str | None, time: str | None) -> datetime | None:
    """DA ＋ TM（或 DT 拆好的兩段）→ datetime；格式不對 → None。TM 可以只有 HH、HHMM，帶小數秒。"""
    d = (date or "").strip()
    t = (time or "").strip().replace(":", "")
    if len(d) < 8 or len(t) < 2 or not d[:8].isdigit():
        return None
    try:
        base = datetime(int(d[0:4]), int(d[4:6]), int(d[6:8]))
        hh = int(t[0:2])
        mm = int(t[2:4]) if len(t) >= 4 else 0
        ss = float(t[4:]) if len(t) > 4 else 0.0
    except ValueError:
        return None
    if not (0 <= hh < 24 and 0 <= mm < 60 and 0 <= ss < 61):
        return None
    return base + timedelta(hours=hh, minutes=mm, seconds=ss)


def _parse_dt(value: str | None) -> datetime | None:
    """DT（YYYYMMDDHHMMSS.FFFFFF&ZZXX）→ datetime；時區後綴忽略（同一台機器的時間互相比較）。"""
    v = (value or "").strip()
    for sign in ("+", "-"):
        if sign in v[8:]:
            v = v[: 8 + v[8:].index(sign)]
    if len(v) < 10:
        return None
    return parse_dicom_datetime(v[:8], v[8:])


def suv_factor(paths: list[Path]) -> tuple[str, SuvInfo | None, str | None]:
    """讀 PET 序列的標頭算 SUVbw 係數。回 `(Units, info, None)` 或 `(Units, None, 為什麼不換)`；
    `Units` 不是 BQML → `(Units, None, None)`。"""
    if not paths:
        return "", None, None
    ds = pydicom.dcmread(paths[0], stop_before_pixels=True)
    units = str(ds.get("Units", "") or "").strip().upper()
    if units != "BQML":
        return units, None, None
    decay = str(ds.get("DecayCorrection", "") or "").strip().upper()
    if decay not in ("START", "ADMIN"):
        why = f"DecayCorrection 是「{decay}」（只換 START／ADMIN）" if decay else "沒有 DecayCorrection"
        return units, None, why
    weight = _float(ds.get("PatientWeight"))
    if weight is None or weight <= 0:
        return units, None, "沒有病人體重（PatientWeight）"
    seq = ds.get("RadiopharmaceuticalInformationSequence")
    if not seq:
        return units, None, "沒有放射性藥物資訊（RadiopharmaceuticalInformationSequence）"
    rp = seq[0]
    dose = _float(rp.get("RadionuclideTotalDose"))
    if dose is None or dose <= 0:
        return units, None, "沒有注射劑量（RadionuclideTotalDose）"
    half_life = _float(rp.get("RadionuclideHalfLife"))
    if half_life is None or half_life <= 0:
        return units, None, "沒有半衰期（RadionuclideHalfLife）"
    series_date = str(ds.get("SeriesDate", "") or "") or str(ds.get("AcquisitionDate", "") or "")
    injection = _parse_dt(str(rp.get("RadiopharmaceuticalStartDateTime", "") or "")) or parse_dicom_datetime(
        series_date, str(rp.get("RadiopharmaceuticalStartTime", "") or "")
    )
    if injection is None:
        return units, None, "沒有注射時間（RadiopharmaceuticalStartDateTime／StartTime）"
    name = str(rp.get("Radiopharmaceutical", "") or "")
    if decay == "ADMIN":
        return (
            units,
            SuvInfo(
                factor=weight * 1000.0 / dose,
                weight_kg=weight,
                injected_dose_bq=dose,
                decayed_dose_bq=dose,
                half_life_s=half_life,
                decay_correction=decay,
                injection_time=injection.isoformat(),
                reference_time=injection.isoformat(),
                elapsed_s=0.0,
                radiopharmaceutical=name,
            ),
            None,
        )
    reference = parse_dicom_datetime(series_date, str(ds.get("SeriesTime", "") or ""))
    # QIBA：SeriesTime 晚於最早的 AcquisitionTime（後處理改寫過）→ 用最早的取像時間
    acquisitions = []
    for p in paths:
        try:
            h = pydicom.dcmread(p, stop_before_pixels=True, specific_tags=["AcquisitionDate", "AcquisitionTime"])
        except Exception:  # noqa: BLE001 - 讀不到的片在載入像素時才報
            continue
        a = parse_dicom_datetime(
            str(h.get("AcquisitionDate", "") or "") or series_date, str(h.get("AcquisitionTime", "") or "")
        )
        if a is not None:
            acquisitions.append(a)
    earliest = min(acquisitions) if acquisitions else None
    if reference is None or (earliest is not None and reference > earliest):
        reference = earliest
    if reference is None:
        return units, None, "沒有取像時間（SeriesTime／AcquisitionTime）"
    elapsed = (reference - injection).total_seconds()
    if elapsed < 0 and rp.get("RadiopharmaceuticalStartDateTime") is None:
        # 只有 StartTime（沒有日期）而且晚於取像 → 注射在前一天（跨午夜）
        elapsed += 86400.0
    if elapsed < 0 or elapsed > 7 * 86400:
        return units, None, f"注射到取像的時間不合理（{elapsed / 3600:.1f} 小時）"
    decayed = dose * 2.0 ** (-elapsed / half_life)
    return (
        units,
        SuvInfo(
            factor=weight * 1000.0 / decayed,
            weight_kg=weight,
            injected_dose_bq=dose,
            decayed_dose_bq=decayed,
            half_life_s=half_life,
            decay_correction=decay,
            injection_time=injection.isoformat(),
            reference_time=reference.isoformat(),
            elapsed_s=elapsed,
            radiopharmaceutical=name,
        ),
        None,
    )


UNIT_LABELS = {"BQML": "Bq/ml", "CNTS": "counts", "GML": "g/ml", "PROPCNTS": "counts", "CM2": "cm²", "PCNT": "%"}


def pet_values(geometry: SeriesGeometry) -> tuple[SeriesGeometry, dict[str, Any], str | None]:
    """PT 影像 → `(換好比例的 geometry, layer params, 警告)`；其他模態原樣、params 空。

    能換 SUV：`value_scale` ＝ 係數 × 100（像素存 SUV×100）、預設窗 SUV 0–5、params 帶 `suv` 明細。
    不能換：像素原樣，params 只標單位（BQML → Bq/ml），警告說為什麼沒有 SUV。
    """
    if str(geometry.meta.get("modality") or "") != "PT":
        return geometry, {}, None
    paths = list(dict.fromkeys(f.path for f in geometry.files))
    try:
        units, info, reason = suv_factor(paths)
    except Exception as exc:  # noqa: BLE001 - 標頭讀不到就維持原值；像素讀不到會在載入時報
        return geometry, {}, f"SUV 換算的標頭讀不到：{exc}"
    if info is None:
        params: dict[str, Any] = {"value_unit": UNIT_LABELS.get(units, units or "a.u."), "value_scale": 1.0}
        if reason:
            params["suv_unavailable"] = reason
        return geometry, params, (f"沒有換算 SUV：{reason}" if reason else None)
    c, w = SUV_DEFAULT_WINDOW
    scaled = replace(
        geometry,
        value_scale=info.factor * SUV_STORE_SCALE,
        default_window=(c * SUV_STORE_SCALE, w * SUV_STORE_SCALE),
    )
    return (
        scaled,
        {"value_unit": "SUV", "value_scale": 1.0 / SUV_STORE_SCALE, "voxel_encoding": "suv_x100", "suv": info.wire()},
        None,
    )
