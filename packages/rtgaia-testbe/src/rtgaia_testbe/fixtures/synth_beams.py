"""射束劑量（`DoseSummationType=BEAM`）的合成測資 —— 零 PHI、完全確定性。

用法：``uv run python -m rtgaia_testbe.fixtures.synth_beams --out data/test_beams``

真實資料（科部、demo）裡沒有 BEAM 劑量（Eclipse 預設只匯出計畫劑量），這裡做一組：

* 一個 CT（synth4d 的靜態體模）
* 一個 RTPLAN：3 個治療射束（機架 0°／120°／240°）＋ 1 個 SETUP 射束；fraction group 1 引用 1–3、5 次
* 3 個 BEAM 劑量（各一個高斯，峰值 20／15／10 Gy、中心錯開），同一個網格，
  各自引用 plan ＋ fraction group 1 ＋ 自己的 beam
* 1 個 PLAN 劑量 ＝ 三個 BEAM 劑量**存的整數**相加（同一個 DoseGridScaling）—— 合成的結果應該跟它完全一樣

`expected.json` 寫 beam 與檔案的對應、PLAN 劑量的 Dmax。
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path

import numpy as np
from pydicom.dataset import Dataset
from pydicom.sequence import Sequence

from .synth4d import AXIAL, RTDOSE_SOP, Case, _base, _phase_volume, _pixel_module, _save, _write_ct_series, uid

RTPLAN_SOP = "1.2.840.10008.5.1.4.1.1.481.5"
BEAMS = (
    # (beam 號, 機架角, 峰值 Gy, 中心偏移 mm)
    (1, 0.0, 20.0, (-15.0, 0.0, 0.0)),
    (2, 120.0, 15.0, (10.0, -10.0, 5.0)),
    (3, 240.0, 10.0, (5.0, 15.0, -5.0)),
)
SETUP_BEAM = 4
FRACTIONS = 5
DOSE_SCALE = 1e-5
"""所有劑量同一個 DoseGridScaling：存的整數相加 ＝ PLAN 劑量的整數（合成結果可以逐點比對）。"""
ISO = (0.0, 0.0, 0.0)


def _plan(case: Case, for_uid: str, plan_sop: str) -> None:
    ds = _base(
        case,
        sop_class=RTPLAN_SOP,
        sop_uid=plan_sop,
        modality="RTPLAN",
        series_uid=uid("plan-series", case.case_id),
        series_number=900,
        description="synth beams plan",
        for_uid=for_uid,
    )
    ds.RTPlanLabel = "BEAMS3"
    ds.RTPlanName = "synth beams"
    ds.RTPlanGeometry = "PATIENT"
    setup = Dataset()
    setup.PatientSetupNumber = 1
    setup.PatientPosition = "HFS"
    ds.PatientSetupSequence = Sequence([setup])
    beams = []
    for number, gantry, _peak, _shift in (*BEAMS, (SETUP_BEAM, 0.0, 0.0, (0.0, 0.0, 0.0))):
        b = Dataset()
        b.BeamNumber = number
        b.BeamName = f"B{number}" if number != SETUP_BEAM else "SETUP"
        b.BeamType = "STATIC"
        b.RadiationType = "PHOTON"
        b.TreatmentDeliveryType = "SETUP" if number == SETUP_BEAM else "TREATMENT"
        b.TreatmentMachineName = "SYNTH1"
        b.PrimaryDosimeterUnit = "MU"
        b.SourceAxisDistance = 1000.0
        b.NumberOfControlPoints = 1
        b.FinalCumulativeMetersetWeight = 1.0
        cp = Dataset()
        cp.ControlPointIndex = 0
        cp.NominalBeamEnergy = 6.0
        cp.GantryAngle = gantry
        cp.GantryRotationDirection = "NONE"
        cp.BeamLimitingDeviceAngle = 0.0
        cp.PatientSupportAngle = 0.0
        cp.IsocenterPosition = list(ISO)
        cp.CumulativeMetersetWeight = 0.0
        b.ControlPointSequence = Sequence([cp])
        b.ReferencedPatientSetupNumber = 1
        beams.append(b)
    ds.BeamSequence = Sequence(beams)
    fg = Dataset()
    fg.FractionGroupNumber = 1
    fg.NumberOfFractionsPlanned = FRACTIONS
    fg.NumberOfBeams = len(BEAMS)
    refs = []
    for number, _gantry, peak, _shift in BEAMS:
        rb = Dataset()
        rb.ReferencedBeamNumber = number
        rb.BeamMeterset = 100.0 + number
        rb.BeamDose = peak / FRACTIONS
        refs.append(rb)
    fg.ReferencedBeamSequence = Sequence(refs)
    ds.FractionGroupSequence = Sequence([fg])
    _save(ds, case.root / "RP" / "RP.beams.dcm")


def _dose_grid() -> tuple[tuple[int, int, int], float, tuple[float, float, float]]:
    ni, nj, nk = 40, 40, 20
    sp = 4.0
    origin = (ISO[0] - sp * (ni - 1) / 2, ISO[1] - sp * (nj - 1) / 2, ISO[2] - sp * (nk - 1) / 2)
    return (ni, nj, nk), sp, origin


def beam_counts(peak: float, shift: tuple[float, float, float]) -> np.ndarray:
    """一個射束劑量存的整數 `(k, j, i)`（uint32）。"""
    (ni, nj, nk), sp, origin = _dose_grid()
    kk, jj, ii = np.meshgrid(np.arange(nk), np.arange(nj), np.arange(ni), indexing="ij")
    x = origin[0] + ii * sp - (ISO[0] + shift[0])
    y = origin[1] + jj * sp - (ISO[1] + shift[1])
    z = origin[2] + kk * sp - (ISO[2] + shift[2])
    gy = peak * np.exp(-(x**2 + y**2 + z**2) / (2 * 20.0**2))
    return np.round(gy / DOSE_SCALE).astype(np.uint32)


def _dose(
    case: Case,
    *,
    for_uid: str,
    plan_sop: str,
    key: str,
    description: str,
    summation: str,
    counts: np.ndarray,
    beam: int | None,
    number: int,
) -> str:
    series_uid = uid("dose", case.case_id, key)
    ds = _base(
        case,
        sop_class=RTDOSE_SOP,
        sop_uid=uid("dose-sop", case.case_id, key),
        modality="RTDOSE",
        series_uid=series_uid,
        series_number=number,
        description=description,
        for_uid=for_uid,
    )
    (ni, nj, nk), sp, origin = _dose_grid()
    ds.ImageOrientationPatient = list(AXIAL)
    ds.ImagePositionPatient = [round(v, 3) for v in origin]
    ds.PixelSpacing = [sp, sp]
    ds.GridFrameOffsetVector = [k * sp for k in range(nk)]
    ds.NumberOfFrames = nk
    ds.FrameIncrementPointer = 0x3004000C
    ds.DoseUnits = "GY"
    ds.DoseType = "PHYSICAL"
    ds.DoseSummationType = summation
    _pixel_module(ds, nj, ni)
    ds.BitsAllocated, ds.BitsStored, ds.HighBit = 32, 32, 31
    ds.DoseGridScaling = f"{DOSE_SCALE:.10g}"
    ds.PixelData = counts.astype(np.uint32).tobytes()
    rp = Dataset()
    rp.ReferencedSOPClassUID = RTPLAN_SOP
    rp.ReferencedSOPInstanceUID = plan_sop
    if beam is not None:
        rfg = Dataset()
        rfg.ReferencedFractionGroupNumber = 1
        rb = Dataset()
        rb.ReferencedBeamNumber = beam
        rfg.ReferencedBeamSequence = Sequence([rb])
        rp.ReferencedFractionGroupSequence = Sequence([rfg])
    ds.ReferencedRTPlanSequence = Sequence([rp])
    _save(ds, case.root / "RD" / f"RD.{key}.dcm")
    case.series.append(
        {
            "series_instance_uid": series_uid,
            "description": description,
            "role": "rtdose",
            "summation": summation,
            "beam": beam,
            "file": f"RD/RD.{key}.dcm",
            "max_gy": float(counts.max()) * DOSE_SCALE,
        }
    )
    return series_uid


def build_beams(root: Path) -> Case:
    case = Case(
        case_id="beams1",
        title="3 個射束劑量（BEAM）＋ 計畫劑量（PLAN）＋ RTPLAN",
        modality="CT",
        pattern="beam doses",
        source=["PS3.3 C.8.8.3 DoseSummationType BEAM；RT Dose ReferencedBeamSequence"],
        root=root,
    )
    case.patient_id = "SYNBEAM-1"
    for_uid = uid("for", case.case_id)
    _write_ct_series(
        case,
        key="ct",
        number=1,
        description="synth beams CT",
        for_uid=for_uid,
        values=_phase_volume(0.0),
        image_type=["ORIGINAL", "PRIMARY", "AXIAL"],
        role="ct",
    )
    plan_sop = uid("plan-sop", case.case_id)
    _plan(case, for_uid, plan_sop)
    total = np.zeros_like(beam_counts(1.0, (0.0, 0.0, 0.0)), dtype=np.uint64)
    for number, _gantry, peak, shift in BEAMS:
        counts = beam_counts(peak, shift)
        total += counts
        _dose(
            case,
            for_uid=for_uid,
            plan_sop=plan_sop,
            key=f"beam{number}",
            description=f"Beam B{number} dose",
            summation="BEAM",
            counts=counts,
            beam=number,
            number=950 + number,
        )
    _dose(
        case,
        for_uid=for_uid,
        plan_sop=plan_sop,
        key="plan",
        description="Plan dose",
        summation="PLAN",
        counts=total.astype(np.uint32),
        beam=None,
        number=960,
    )
    case.expected = {
        "plan_sop_instance_uid": plan_sop,
        "treatment_beams": [b[0] for b in BEAMS],
        "setup_beam": SETUP_BEAM,
        "fractions": FRACTIONS,
        "plan_max_gy": float(total.max()) * DOSE_SCALE,
    }
    return case


def build(out: Path) -> Case:
    root = out / "beams1"
    if root.exists():
        import shutil

        shutil.rmtree(root)
    case = build_beams(root)
    case.write_expected()
    return case


def main() -> None:
    ap = argparse.ArgumentParser(description="射束劑量（`DoseSummationType=BEAM`）的合成測資 —— 零 PHI、完全確定性")
    ap.add_argument("--out", type=Path, required=True)
    args = ap.parse_args()
    case = build(args.out)
    print(json.dumps({"patient_id": case.patient_id, "root": str(case.root), **case.expected}, ensure_ascii=False))


if __name__ == "__main__":
    main()
