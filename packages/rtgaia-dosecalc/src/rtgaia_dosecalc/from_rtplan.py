"""RTPLAN（光子）→ `Delivery`。不支援的項目一律擋下並說明，不默默近似。

* 只算治療射束（`TreatmentDeliveryType = TREATMENT`）；SETUP 射束略過。
* 控制點只寫有變的欄位（PS3.3 C.8.8.14.5）→ 往後帶，每個控制點都是完整狀態。
* 射束的 MU ＝ 第一個 fraction group 的 `BeamMeterset`；累積 MU ＝ 累積權重 ÷ 最終權重 × MU。
* 沒有 X jaw → 用 MLC 的最外側葉片；沒有 Y jaw → 用葉片邊界的兩端；都沒有 → 擋。

**擋下的**：非光子；楔形板、擋塊、補償器、bolus、施照筒；機架俯仰、床 pitch／roll 不為 0；一個射束裡准直器或床角
會變；沒有 MU；擺位不是 HFS／HFP／FFS／FFP。
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

from .delivery import DEFAULT_SAD_MM, PATIENT_TO_LPS, Beam, ControlPoint, Delivery

JAW_X = frozenset({"X", "ASYMX"})
JAW_Y = frozenset({"Y", "ASYMY"})
MLC_X = frozenset({"MLCX"})
ANGLE_TOL = 1e-3


def _f(v: Any) -> float | None:
    try:
        return None if v is None or v == "" else float(v)
    except (TypeError, ValueError):
        return None


def _s(v: Any) -> str:
    return str(v).strip() if v is not None else ""


def read_delivery(path: str | Path, beam_numbers: list[int] | None = None) -> tuple[Delivery | None, list[str]]:
    """回 `(Delivery, 問題)`；有任何問題 → Delivery 是 None（整份計畫不算，避免算出缺射束的劑量還以為是完整的）。"""
    import pydicom

    ds = pydicom.dcmread(str(path), stop_before_pixels=True)
    problems: list[str] = []
    if _s(ds.get("Modality")) != "RTPLAN":
        return None, ["不是 RTPLAN"]
    fgs = list(ds.get("FractionGroupSequence") or [])
    if not fgs:
        return None, ["計畫沒有 fraction group"]
    fg = fgs[0]
    if len(fgs) > 1:
        problems.append("計畫有不只一個 fraction group：只支援一個")
    fractions = int(fg.get("NumberOfFractionsPlanned") or 0) or 1
    meterset = {
        int(rb.ReferencedBeamNumber): _f(rb.get("BeamMeterset"))
        for rb in fg.get("ReferencedBeamSequence") or []
        if rb.get("ReferencedBeamNumber") is not None
    }
    setups = {
        int(p.PatientSetupNumber): _s(p.get("PatientPosition"))
        for p in ds.get("PatientSetupSequence") or []
        if p.get("PatientSetupNumber") is not None
    }
    beams: list[Beam] = []
    for b in ds.get("BeamSequence") or []:
        number = int(b.BeamNumber) if b.get("BeamNumber") is not None else None
        name = _s(b.get("BeamName")) or f"beam {number}"
        if (_s(b.get("TreatmentDeliveryType")) or "TREATMENT") != "TREATMENT":
            continue
        if number is None or number not in meterset:
            continue  # 不在 fraction group 裡的射束不照
        if beam_numbers is not None and number not in beam_numbers:
            continue
        beam, why = _beam(b, number, name, meterset.get(number), setups)
        problems += [f"{name}：{w}" for w in why]
        if beam is not None:
            beams.append(beam)
    if not beams and not problems:
        problems.append("計畫裡沒有可以計算的治療射束")
    if problems:
        return None, problems
    return (
        Delivery(
            beams=beams,
            fractions=fractions,
            plan_label=_s(ds.get("RTPlanLabel")),
            plan_sop_uid=_s(ds.get("SOPInstanceUID")),
        ),
        [],
    )


def _beam(b: Any, number: int, name: str, mu: float | None, setups: dict[int, str]) -> tuple[Beam | None, list[str]]:
    why: list[str] = []
    rt = _s(b.get("RadiationType"))
    if rt != "PHOTON":
        why.append(f"射束種類 {rt or '(缺)'}：只支援光子")
    for attr, label in (
        ("NumberOfWedges", "楔形板"),
        ("NumberOfBlocks", "擋塊"),
        ("NumberOfCompensators", "補償器"),
        ("NumberOfBoli", "bolus"),
    ):
        if int(b.get(attr) or 0) > 0:
            why.append(f"有{label}：還不支援")
    if b.get("ApplicatorSequence"):
        why.append("有施照筒：還不支援")
    if mu is None or mu <= 0:
        why.append("沒有 MU（fraction group 的 BeamMeterset）")
    position = setups.get(int(b.get("ReferencedPatientSetupNumber") or 0), "") or (
        next(iter(setups.values())) if len(setups) == 1 else ""
    )
    if position not in PATIENT_TO_LPS:
        why.append(f"病人擺位 {position or '(缺)'}：只支援 HFS／HFP／FFS／FFP")
    devices = {_s(d.get("RTBeamLimitingDeviceType")): d for d in b.get("BeamLimitingDeviceSequence") or []}
    mlc_dev = next((d for k, d in devices.items() if k in MLC_X), None)
    if any(k.startswith("MLCY") for k in devices):
        why.append("MLCY（沿 Y 的 MLC）：還不支援")
    bounds = (
        [float(v) for v in mlc_dev.LeafPositionBoundaries]
        if mlc_dev is not None and mlc_dev.get("LeafPositionBoundaries")
        else None
    )
    final = _f(b.get("FinalCumulativeMetersetWeight"))
    if final is None or final <= 0:
        why.append("FinalCumulativeMetersetWeight 無效")
    fluence = "STANDARD"
    for fm in b.get("PrimaryFluenceModeSequence") or []:
        if _s(fm.get("FluenceMode")) == "NON_STANDARD":
            fluence = _s(fm.get("FluenceModeID")) or "NON_STANDARD"
    if fluence not in ("STANDARD", "FFF"):
        why.append(f"射束模式 {fluence}：只支援 STANDARD 與 FFF")
    state: dict[str, Any] = {
        "gantry": None,
        "coll": None,
        "couch": None,
        "weight": None,
        "x": None,
        "y": None,
        "mlc": None,
        "energy": None,
    }
    cps: list[ControlPoint] = []
    for cp in b.get("ControlPointSequence") or []:
        for attr, key in (
            ("GantryAngle", "gantry"),
            ("BeamLimitingDeviceAngle", "coll"),
            ("PatientSupportAngle", "couch"),
            ("CumulativeMetersetWeight", "weight"),
            ("NominalBeamEnergy", "energy"),
        ):
            if attr in cp:
                state[key] = _f(cp.get(attr))
        for attr, label in (
            ("GantryPitchAngle", "機架俯仰"),
            ("TableTopPitchAngle", "床的 pitch"),
            ("TableTopRollAngle", "床的 roll"),
        ):
            v = _f(cp.get(attr))
            if v is not None and abs(v) > ANGLE_TOL and f"{label} {v:g}°：還不支援" not in why:
                why.append(f"{label} {v:g}°：還不支援")
        for pos in cp.get("BeamLimitingDevicePositionSequence") or []:
            kind = _s(pos.get("RTBeamLimitingDeviceType"))
            values = [float(v) for v in pos.get("LeafJawPositions") or []]
            if kind in JAW_X and len(values) == 2:
                state["x"] = (values[0], values[1])
            elif kind in JAW_Y and len(values) == 2:
                state["y"] = (values[0], values[1])
            elif kind in MLC_X and values and len(values) % 2 == 0:
                n = len(values) // 2
                state["mlc"] = (values[:n], values[n:])
        if None in (state["gantry"], state["weight"]):
            why.append("控制點缺機架角或累積權重")
            break
        jaw_x, jaw_y = state["x"], state["y"]
        if jaw_x is None and state["mlc"] is not None:
            jaw_x = (min(state["mlc"][0]), max(state["mlc"][1]))
        if jaw_y is None and bounds is not None:
            jaw_y = (bounds[0], bounds[-1])
        if jaw_x is None or jaw_y is None:
            why.append("沒有 jaw 也沒有 MLC：不知道開口")
            break
        cps.append(
            ControlPoint(
                cumulative_mu=(state["weight"] / final * mu) if final and mu else 0.0,
                gantry_deg=float(state["gantry"]) % 360.0,
                collimator_deg=float(state["coll"] or 0.0),
                couch_deg=float(state["couch"] or 0.0),
                jaw_x=jaw_x,
                jaw_y=jaw_y,
                mlc_a=list(state["mlc"][0]) if state["mlc"] is not None else None,
                mlc_b=list(state["mlc"][1]) if state["mlc"] is not None else None,
            )
        )
    if len(cps) < 2 and not why:
        why.append("控制點少於兩個")
    if cps:
        if any(abs(c.collimator_deg - cps[0].collimator_deg) > ANGLE_TOL for c in cps):
            why.append("准直器角在射束裡會變：還不支援")
        if any(abs(c.couch_deg - cps[0].couch_deg) > ANGLE_TOL for c in cps):
            why.append("床角在射束裡會變：還不支援")
    iso = None
    for cp in b.get("ControlPointSequence") or []:
        if cp.get("IsocenterPosition") is not None:
            iso = tuple(float(v) for v in cp.IsocenterPosition)
            break
    if iso is None:
        why.append("沒有等中心（IsocenterPosition）")
    if why:
        return None, why
    assert iso is not None and mu is not None
    return (
        Beam(
            number=number,
            name=name,
            energy_mv=float(state["energy"] or 0.0),
            fluence_mode=fluence,
            sad_mm=_f(b.get("SourceAxisDistance")) or DEFAULT_SAD_MM,
            isocenter_lps=iso,  # type: ignore[arg-type]
            patient_position=position,
            mu=float(mu),
            control_points=cps,
            leaf_boundaries_mm=bounds,
            machine=_s(b.get("TreatmentMachineName")),
        ),
        [],
    )
