"""RTPLAN 的射束資訊（**只看不改、不算劑量**）。

只讀標頭（`stop_before_pixels`）。給 UI 的射束清單、治療機、等中心；不做照射模擬、不做碰撞檢查。

## 排序

治療射束（`TreatmentDeliveryType` 缺或 `TREATMENT`）在前，其他（`SETUP`、`VERIFICATION` …）在後；
同一群照原始 `BeamNumber`，畫面上保留原始編號。

## 等中心

每個射束取第一個 control point 的 `IsocenterPosition`（病人座標 mm，RTPLAN 的 FoR）。
相同位置（差 < 0.01 mm）合併成一個 ISO，列出哪些射束用它 —— 多數計畫只有一個。

## 治療技術

`technique`：`gamma_knife`（Elekta GammaPlan／Leksell：每個「射束」其實是一個 shot —— 192 個鈷 60 源聚焦在一點，
沒有機架、准直器、MLC，畫成直線加速器的射束和 BEV 是錯的；VS-SEG 實測 11 個 shots 被畫成 11 道射束）或
`external_beam`（其餘）。判斷看 RTPLAN 的 Manufacturer／ManufacturerModelName（`GammaPlan`、`Leksell`）或
治療機名稱（Perfexion `PFX`、`ICON`、`Esprit`）。
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import pydicom

ISO_MERGE_MM = 0.01

_GAMMA_KNIFE_TEXT = re.compile(r"gamma\s*plan|leksell|gamma\s*knife", re.IGNORECASE)
_GAMMA_KNIFE_MACHINE = re.compile(r"^(PFX|PERFEXION|ICON|ESPRIT|LGK)\b", re.IGNORECASE)


def plan_technique(ds: Any) -> str:
    """`gamma_knife` 或 `external_beam`（見模組說明）。"""
    text = " ".join(_s(ds.get(k)) for k in ("Manufacturer", "ManufacturerModelName"))
    if _GAMMA_KNIFE_TEXT.search(text):
        return "gamma_knife"
    machines = [_s(b.get("TreatmentMachineName")) for b in ds.get("BeamSequence") or []]
    if machines and all(_GAMMA_KNIFE_MACHINE.match(m) for m in machines):
        return "gamma_knife"
    return "external_beam"


def _f(v: Any) -> float | None:
    try:
        x = float(v)
    except (TypeError, ValueError):
        return None
    return x if x == x else None  # NaN → None


def _s(v: Any) -> str:
    return str(v).strip() if v is not None else ""


@dataclass(frozen=True)
class PlanHeader:
    series_instance_uid: str
    sop_instance_uid: str
    frame_of_reference_uid: str
    label: str
    name: str
    path: str


def read_plan_header(path: str | Path) -> PlanHeader:
    ds = pydicom.dcmread(str(path), stop_before_pixels=True)
    return PlanHeader(
        series_instance_uid=_s(ds.get("SeriesInstanceUID")),
        sop_instance_uid=_s(ds.get("SOPInstanceUID")),
        frame_of_reference_uid=_s(ds.get("FrameOfReferenceUID")),
        label=_s(ds.get("RTPlanLabel")),
        name=_s(ds.get("RTPlanName")),
        path=str(path),
    )


def _beam(b: Any, meterset: dict[int, float | None], energy_unit: str) -> dict[str, Any]:
    cps = list(b.get("ControlPointSequence") or [])

    def first(attr: str) -> Any:
        """第一個有這個欄位的 control point（後面的 CP 只寫有變的欄位）。"""
        for cp in cps:
            if attr in cp:
                return cp.get(attr)
        return None

    def last_value(attr: str) -> Any:
        for cp in reversed(cps):
            if attr in cp:
                return cp.get(attr)
        return None

    gantry_start = _f(first("GantryAngle"))
    gantry_end = _f(last_value("GantryAngle"))
    direction = _s(first("GantryRotationDirection")) or "NONE"
    number = int(b.get("BeamNumber")) if b.get("BeamNumber") is not None else None
    delivery = _s(b.get("TreatmentDeliveryType")) or "TREATMENT"
    iso = first("IsocenterPosition")
    return {
        "number": number,
        "name": _s(b.get("BeamName")),
        "description": _s(b.get("BeamDescription")),
        "beam_type": _s(b.get("BeamType")),  # STATIC／DYNAMIC
        "radiation_type": _s(b.get("RadiationType")),
        "delivery_type": delivery,
        "is_treatment": delivery == "TREATMENT",
        "machine_name": _s(b.get("TreatmentMachineName")),
        "manufacturer": _s(b.get("Manufacturer")),
        "model": _s(b.get("ManufacturerModelName")),
        "energy": _f(first("NominalBeamEnergy")),
        "energy_unit": energy_unit,
        "control_points": len(cps),
        "gantry_start_deg": gantry_start,
        "gantry_end_deg": gantry_end,
        "gantry_direction": direction,  # CW／CC／NONE
        "is_arc": direction in ("CW", "CC") and gantry_start is not None and gantry_end is not None,
        "collimator_deg": _f(first("BeamLimitingDeviceAngle")),
        "couch_deg": _f(first("PatientSupportAngle")),
        "isocenter_mm": [float(v) for v in iso] if iso is not None and len(iso) == 3 else None,
        "meterset": meterset.get(number) if number is not None else None,
        "meterset_unit": _s(b.get("PrimaryDosimeterUnit")) or "MU",
        "dose_rate": _f(first("DoseRateSet")),
        "sad_mm": _f(b.get("SourceAxisDistance")),
        "devices": [
            {"type": _s(d.get("RTBeamLimitingDeviceType")), "pairs": int(d.get("NumberOfLeafJawPairs") or 0)}
            for d in (b.get("BeamLimitingDeviceSequence") or [])
        ],
    }


def read_plan_beams(path: str | Path) -> dict[str, Any]:
    """計畫標頭 ＋ 射束清單 ＋ 合併後的等中心。座標是 RTPLAN 自己的 FoR（換到 primary 是 API 層的事）。"""
    ds = pydicom.dcmread(str(path), stop_before_pixels=True)
    meterset: dict[int, float | None] = {}
    beam_dose: dict[int, float | None] = {}
    fractions = None
    fraction_groups: list[dict[str, Any]] = []
    for fg in ds.get("FractionGroupSequence") or []:
        fractions = fractions if fractions is not None else fg.get("NumberOfFractionsPlanned")
        # BEAM 劑量合成計畫劑量時核對「這組 beam 剛好是這個 fraction group 的全部射束」
        fraction_groups.append(
            {
                "number": int(fg.get("FractionGroupNumber") or 1),
                "fractions_planned": int(fg.NumberOfFractionsPlanned) if fg.get("NumberOfFractionsPlanned") else None,
                "beam_numbers": [
                    int(rb.ReferencedBeamNumber)
                    for rb in fg.get("ReferencedBeamSequence") or []
                    if rb.get("ReferencedBeamNumber") is not None
                ],
            }
        )
        for rb in fg.get("ReferencedBeamSequence") or []:
            if rb.get("ReferencedBeamNumber") is not None:
                meterset[int(rb.ReferencedBeamNumber)] = _f(rb.get("BeamMeterset"))
                beam_dose[int(rb.ReferencedBeamNumber)] = _f(rb.get("BeamDose"))
    technique = plan_technique(ds)
    beams = [
        _beam(b, meterset, "MV" if _s(b.get("RadiationType")) in ("PHOTON", "") else "MeV")
        for b in ds.get("BeamSequence") or []
    ]
    for b in beams:
        # 射束在劑量參考點的劑量（Gy；Gamma Knife ＝ 這個 shot 在處方點的貢獻）
        b["beam_dose_gy"] = beam_dose.get(b["number"]) if b["number"] is not None else None
    if technique == "gamma_knife":
        _gamma_knife_shots(beams)
    beams.sort(key=lambda b: (not b["is_treatment"], b["number"] if b["number"] is not None else 1 << 30))
    isocenters: list[dict[str, Any]] = []
    for b in beams:
        pos = b["isocenter_mm"]
        if pos is None:
            continue
        hit = next(
            (
                i
                for i in isocenters
                if max(abs(p - q) for p, q in zip(i["position_mm"], pos, strict=True)) < ISO_MERGE_MM
            ),
            None,
        )
        if hit is None:
            isocenters.append({"position_mm": pos, "beam_numbers": [b["number"]]})
        else:
            hit["beam_numbers"].append(b["number"])
    machines = sorted({(b["machine_name"], b["manufacturer"], b["model"]) for b in beams if b["machine_name"]})
    prescriptions = [_f(r.get("TargetPrescriptionDose")) for r in ds.get("DoseReferenceSequence") or []]
    return {
        "label": _s(ds.get("RTPlanLabel")),
        "name": _s(ds.get("RTPlanName")),
        "frame_of_reference_uid": _s(ds.get("FrameOfReferenceUID")),
        "sop_instance_uid": _s(ds.get("SOPInstanceUID")),
        "technique": technique,
        "patient_positions": sorted(
            {_s(p.get("PatientPosition")) for p in ds.get("PatientSetupSequence") or []} - {""}
        ),
        "fractions_planned": int(fractions) if fractions is not None else None,
        "fraction_groups": fraction_groups,
        "prescription_gy": [p for p in prescriptions if p is not None],
        "machines": [{"name": n, "manufacturer": m, "model": mo} for n, m, mo in machines],
        "beams": beams,
        "isocenters": isocenters,
    }


def _gamma_knife_shots(beams: list[dict[str, Any]]) -> None:
    """Gamma Knife 每個 shot 的照射時間與相對權重（就地加欄位）。

    * `meterset` 是照射時間（`PrimaryDosimeterUnit = MINUTE`）；`weight` ＝ 這個 shot 的時間 ÷ 最長的那個（0–1；
      GammaPlan 的「權重」也是相對值）。
    * **准直器不在 DICOM 裡**：GammaPlan 匯出的 RTPLAN 每個 shot 的 jaw 都是同一組佔位值（VS-SEG 全部 ±10 mm），
      Perfexion／Icon 八個扇區各自的 4／8／16 mm／遮蔽沒有標準欄位 —— `collimator_mm` 一律 None，不從 jaw 推。
    """
    times = [b["meterset"] for b in beams if b["is_treatment"] and b["meterset"] is not None and b["meterset"] > 0]
    longest = max(times) if times else None
    for b in beams:
        t = b["meterset"]
        b["shot"] = {
            "beam_on_min": t if b["meterset_unit"].upper() == "MINUTE" else None,
            "weight": round(t / longest, 4) if longest and t is not None and b["is_treatment"] else None,
            "dose_rate": b.get("dose_rate"),
            "collimator_mm": None,
        }


# ── 一個射束的控制點（BEV／MLC 開口、控制點時間軸）──────────────────────────

JAW_X = frozenset({"X", "ASYMX"})
JAW_Y = frozenset({"Y", "ASYMY"})


def _gantry_step(a: float | None, b: float | None) -> float | None:
    """機架從 a 轉到 b 的角度（取 −180…180 的最短方向，取絕對值）；缺一個 → None。"""
    if a is None or b is None:
        return None
    return abs(((b - a + 540.0) % 360.0) - 180.0)


def read_beam_control_points(path: str | Path, beam_number: int) -> dict[str, Any]:
    """一個射束每個控制點的機架／准直器／床角、累積 MU、jaw 與 MLC 位置。

    * DICOM 的控制點**只寫有變的欄位**（PS3.3 C.8.8.14.5）：這裡往後帶（carry forward），每個 CP 都是完整的狀態。
    * `LeafJawPositions`：jaw 是 `[1, 2]` 兩個值；MLC 是 `2N` 個值，前 N 個是 A 側（X1／Y1），後 N 個是 B 側。
    * `CumulativeMetersetWeight` ÷ `FinalCumulativeMetersetWeight` × 射束 MU ＝ 這個 CP 的累積 MU；
      `mu_per_deg` ＝ 這一段的 ΔMU ÷ 機架轉的角度（弧才有意義；固定射野是 None）。
    * 只是「看計畫內容」—— 不推算葉片實際的運動、不考慮葉片速度或劑量率限制。
    """
    ds = pydicom.dcmread(str(path), stop_before_pixels=True)
    beam = next(
        (
            b
            for b in ds.get("BeamSequence") or []
            if b.get("BeamNumber") is not None and int(b.BeamNumber) == beam_number
        ),
        None,
    )
    if beam is None:
        raise KeyError(f"計畫裡沒有射束 {beam_number}")
    meterset = None
    for fg in ds.get("FractionGroupSequence") or []:
        for rb in fg.get("ReferencedBeamSequence") or []:
            if rb.get("ReferencedBeamNumber") is not None and int(rb.ReferencedBeamNumber) == beam_number:
                meterset = _f(rb.get("BeamMeterset"))
    devices = []
    for d in beam.get("BeamLimitingDeviceSequence") or []:
        bounds = d.get("LeafPositionBoundaries")
        devices.append(
            {
                "type": _s(d.get("RTBeamLimitingDeviceType")),
                "pairs": int(d.get("NumberOfLeafJawPairs") or 0),
                "boundaries_mm": [float(v) for v in bounds] if bounds is not None else None,
            }
        )
    final = _f(beam.get("FinalCumulativeMetersetWeight"))
    state: dict[str, Any] = {
        "gantry_deg": None,
        "collimator_deg": None,
        "couch_deg": None,
        "weight": None,
        "dose_rate": None,
        "table_vertical_mm": None,
        "table_pitch_deg": None,
        "table_roll_deg": None,
        "gantry_pitch_deg": None,
        "jaws": {"x": None, "y": None},
        "mlc": {},
    }
    cps: list[dict[str, Any]] = []
    for i, cp in enumerate(beam.get("ControlPointSequence") or []):
        if "GantryAngle" in cp:
            state["gantry_deg"] = _f(cp.GantryAngle)
        if "BeamLimitingDeviceAngle" in cp:
            state["collimator_deg"] = _f(cp.BeamLimitingDeviceAngle)
        if "PatientSupportAngle" in cp:
            state["couch_deg"] = _f(cp.PatientSupportAngle)
        if "CumulativeMetersetWeight" in cp:
            state["weight"] = _f(cp.CumulativeMetersetWeight)
        if "DoseRateSet" in cp:
            state["dose_rate"] = _f(cp.DoseRateSet)
        # 機架／治療床示意：床面相對等中心的高度（IEC，負 ＝ 在等中心下方）、俯仰、側傾（只拿來畫示意）
        if "TableTopVerticalPosition" in cp:
            state["table_vertical_mm"] = _f(cp.TableTopVerticalPosition)
        if "TableTopPitchAngle" in cp:
            state["table_pitch_deg"] = _f(cp.TableTopPitchAngle)
        if "TableTopRollAngle" in cp:
            state["table_roll_deg"] = _f(cp.TableTopRollAngle)
        if "GantryPitchAngle" in cp:
            state["gantry_pitch_deg"] = _f(cp.GantryPitchAngle)  # DRR 不支援機架俯仰
        for pos in cp.get("BeamLimitingDevicePositionSequence") or []:
            kind = _s(pos.get("RTBeamLimitingDeviceType"))
            values = [float(v) for v in pos.get("LeafJawPositions") or []]
            if kind in JAW_X and len(values) == 2:
                state["jaws"] = {**state["jaws"], "x": values}
            elif kind in JAW_Y and len(values) == 2:
                state["jaws"] = {**state["jaws"], "y": values}
            elif values and len(values) % 2 == 0:
                n = len(values) // 2
                state["mlc"] = {**state["mlc"], kind: {"a": values[:n], "b": values[n:]}}
        weight = state["weight"]
        mu = (
            weight / final * meterset
            if weight is not None and final not in (None, 0.0) and meterset is not None
            else None
        )
        cps.append(
            {
                "index": i,
                "gantry_deg": state["gantry_deg"],
                "collimator_deg": state["collimator_deg"],
                "couch_deg": state["couch_deg"],
                "weight": weight,
                "mu": mu,
                "dose_rate": state["dose_rate"],
                "table_vertical_mm": state["table_vertical_mm"],
                "table_pitch_deg": state["table_pitch_deg"],
                "table_roll_deg": state["table_roll_deg"],
                "gantry_pitch_deg": state["gantry_pitch_deg"],
                "jaws": dict(state["jaws"]),
                "mlc": dict(state["mlc"]),
            }
        )
    for prev, cur in zip(cps, cps[1:], strict=False):
        d_mu = cur["mu"] - prev["mu"] if cur["mu"] is not None and prev["mu"] is not None else None
        step = _gantry_step(prev["gantry_deg"], cur["gantry_deg"])
        cur["delta_mu"] = d_mu
        cur["mu_per_deg"] = d_mu / step if d_mu is not None and step is not None and step > 1e-6 else None
    if cps:
        cps[0]["delta_mu"] = 0.0 if cps[0]["mu"] is not None else None
        cps[0]["mu_per_deg"] = None
    direction = "NONE"
    first = (beam.get("ControlPointSequence") or [None])[0]
    if first is not None and "GantryRotationDirection" in first:
        direction = _s(first.GantryRotationDirection) or "NONE"
    return {
        "number": beam_number,
        "name": _s(beam.get("BeamName")),
        "machine_name": _s(beam.get("TreatmentMachineName")),
        "manufacturer": _s(beam.get("Manufacturer")),
        "model": _s(beam.get("ManufacturerModelName")),
        "beam_type": _s(beam.get("BeamType")),
        "is_treatment": (_s(beam.get("TreatmentDeliveryType")) or "TREATMENT") == "TREATMENT",
        "meterset": meterset,
        "meterset_unit": _s(beam.get("PrimaryDosimeterUnit")) or "MU",
        "sad_mm": _f(beam.get("SourceAxisDistance")),
        "gantry_direction": direction,
        "final_weight": final,
        "devices": devices,
        "control_points": cps,
    }
