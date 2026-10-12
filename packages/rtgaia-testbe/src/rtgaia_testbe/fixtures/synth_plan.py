"""劑量計算用的合成計畫 —— 零 PHI、完全確定性。

用法：``uv run python -m rtgaia_testbe.fixtures.synth_plan --out data/test_plan``

* CT：空氣裡一塊水（左右 260 mm、前後 180 mm、上下 180 mm），右側（病人右 ＝ LPS −x）有一塊肺（−700 HU），
  中線後方有一根骨（1000 HU）。2 × 2 × 3 mm。
* RTPLAN「SYNTH-6X」：HFS、等中心在原點、2 次；6 MV、Millennium 120 的葉片邊界（中間 40 片 5 mm、兩邊各 10 片 10 mm）
  * 1「AP」：機架 0°，jaw ±50 mm，MLC 開到 ±50 mm（靜態）
  * 2「LAT」：機架 90°（射源在病人左），jaw X ±40、Y ±60，MLC 圍成半徑 40 mm 的圓
  * 3「ARC」：VMAT 181° → 179° 順時針，61 個控制點，jaw ±60，MLC 開口寬度隨機架角變（測內插）
  * MU 200／150／400

`expected.json` 寫計畫與 CT 的 UID、射束、分次。
"""

from __future__ import annotations

import argparse
import json
import math
from pathlib import Path

import numpy as np
from pydicom.dataset import Dataset
from pydicom.sequence import Sequence

from .synth4d import Case, Geom, _base, _save, _write_ct_series, uid

RTPLAN_SOP = "1.2.840.10008.5.1.4.1.1.481.5"
FRACTIONS = 2
ISO = (0.0, 0.0, 0.0)
GEOM = Geom(size=(160, 120, 60), spacing=(2.0, 2.0, 3.0), origin=(-159.0, -119.0, -88.5))
WATER_HALF = (130.0, 90.0, 90.0)
LUNG = ((-120.0, -60.0), (-40.0, 40.0))  # x、y 範圍（mm）
BONE = ((-10.0, 10.0), (40.0, 60.0))
MU = {1: 200.0, 2: 150.0, 3: 400.0}


def leaf_boundaries() -> list[float]:
    """Millennium 120：−200 … −100 每 10 mm、−100 … 100 每 5 mm、100 … 200 每 10 mm（61 個邊界、60 對）。"""
    out = [float(v) for v in range(-200, -100, 10)]
    out += [float(v) for v in range(-100, 100, 5)]
    out += [float(v) for v in range(100, 201, 10)]
    return out


def _hu(k: int) -> np.ndarray:
    x, y, z = GEOM.world(k)
    hu = np.full(x.shape, -1000.0)
    water = (np.abs(x) <= WATER_HALF[0]) & (np.abs(y) <= WATER_HALF[1]) & (np.abs(z) <= WATER_HALF[2])
    hu[water] = 0.0
    lung = water & (x >= LUNG[0][0]) & (x <= LUNG[0][1]) & (y >= LUNG[1][0]) & (y <= LUNG[1][1])
    hu[lung] = -700.0
    bone = water & (x >= BONE[0][0]) & (x <= BONE[0][1]) & (y >= BONE[1][0]) & (y <= BONE[1][1])
    hu[bone] = 1000.0
    return hu


def _mlc_open(bounds: list[float], half_x: float, half_y: float) -> tuple[list[float], list[float]]:
    a, b = [], []
    for lo, hi in zip(bounds, bounds[1:], strict=False):
        mid = (lo + hi) / 2
        if abs(mid) < half_y:
            a.append(-half_x)
            b.append(half_x)
        else:
            a.append(0.0)
            b.append(0.0)
    return a, b


def _mlc_circle(bounds: list[float], r: float) -> tuple[list[float], list[float]]:
    a, b = [], []
    for lo, hi in zip(bounds, bounds[1:], strict=False):
        mid = (lo + hi) / 2
        w = math.sqrt(max(0.0, r * r - mid * mid))
        a.append(-round(w, 2))
        b.append(round(w, 2))
    return a, b


def _devices(bounds: list[float]) -> Sequence:
    seq = []
    for kind, n in (("ASYMX", 1), ("ASYMY", 1), ("MLCX", len(bounds) - 1)):
        d = Dataset()
        d.RTBeamLimitingDeviceType = kind
        d.NumberOfLeafJawPairs = n
        if kind == "MLCX":
            d.LeafPositionBoundaries = bounds
        seq.append(d)
    return Sequence(seq)


def _positions(jx: tuple[float, float], jy: tuple[float, float], mlc: tuple[list[float], list[float]]) -> Sequence:
    out = []
    for kind, values in (("ASYMX", list(jx)), ("ASYMY", list(jy)), ("MLCX", mlc[0] + mlc[1])):
        p = Dataset()
        p.RTBeamLimitingDeviceType = kind
        p.LeafJawPositions = values
        out.append(p)
    return Sequence(out)


def _beam(number: int, name: str, cps: list[dict], bounds: list[float], arc: bool) -> Dataset:
    b = Dataset()
    b.BeamNumber = number
    b.BeamName = name
    b.BeamType = "DYNAMIC" if arc else "STATIC"
    b.RadiationType = "PHOTON"
    b.TreatmentDeliveryType = "TREATMENT"
    b.TreatmentMachineName = "SYNTH-TB"
    b.Manufacturer = "Synthetic"
    b.PrimaryDosimeterUnit = "MU"
    b.SourceAxisDistance = 1000.0
    b.BeamLimitingDeviceSequence = _devices(bounds)
    b.NumberOfWedges = 0
    b.NumberOfCompensators = 0
    b.NumberOfBoli = 0
    b.NumberOfBlocks = 0
    fm = Dataset()
    fm.FluenceMode = "STANDARD"
    b.PrimaryFluenceModeSequence = Sequence([fm])
    b.FinalCumulativeMetersetWeight = 1.0
    b.NumberOfControlPoints = len(cps)
    seq = []
    for i, c in enumerate(cps):
        cp = Dataset()
        cp.ControlPointIndex = i
        cp.CumulativeMetersetWeight = c["weight"]
        if i == 0:
            cp.NominalBeamEnergy = 6.0
            cp.DoseRateSet = 600.0
            cp.GantryRotationDirection = "CW" if arc else "NONE"
            cp.BeamLimitingDeviceAngle = 0.0
            cp.BeamLimitingDeviceRotationDirection = "NONE"
            cp.PatientSupportAngle = 0.0
            cp.PatientSupportRotationDirection = "NONE"
            cp.TableTopEccentricAngle = 0.0
            cp.TableTopPitchAngle = 0.0
            cp.TableTopRollAngle = 0.0
            cp.IsocenterPosition = list(ISO)
        if i == 0 or arc:
            cp.GantryAngle = c["gantry"]
        if i == 0 or "mlc" in c:
            cp.BeamLimitingDevicePositionSequence = _positions(c["jx"], c["jy"], c["mlc"])
        seq.append(cp)
    b.ControlPointSequence = Sequence(seq)
    b.ReferencedPatientSetupNumber = 1
    return b


def _plan(case: Case, for_uid: str, plan_sop: str) -> None:
    ds = _base(
        case,
        sop_class=RTPLAN_SOP,
        sop_uid=plan_sop,
        modality="RTPLAN",
        series_uid=uid("plan-series", case.case_id),
        series_number=900,
        description="synth 6X plan",
        for_uid=for_uid,
    )
    ds.RTPlanLabel = "SYNTH-6X"
    ds.RTPlanName = "synth 6X"
    ds.RTPlanGeometry = "PATIENT"
    setup = Dataset()
    setup.PatientSetupNumber = 1
    setup.PatientPosition = "HFS"
    ds.PatientSetupSequence = Sequence([setup])
    bounds = leaf_boundaries()
    ap = _mlc_open(bounds, 50.0, 50.0)
    lat = _mlc_circle(bounds, 40.0)
    beams = [
        _beam(
            1,
            "AP",
            [
                {"weight": 0.0, "gantry": 0.0, "jx": (-50.0, 50.0), "jy": (-50.0, 50.0), "mlc": ap},
                {"weight": 1.0, "gantry": 0.0},
            ],
            bounds,
            False,
        ),
        _beam(
            2,
            "LAT",
            [
                {"weight": 0.0, "gantry": 90.0, "jx": (-40.0, 40.0), "jy": (-60.0, 60.0), "mlc": lat},
                {"weight": 1.0, "gantry": 90.0},
            ],
            bounds,
            False,
        ),
    ]
    arc_cps = []
    n = 61
    for i in range(n):
        gantry = (181.0 + i * 358.0 / (n - 1)) % 360.0
        half = 20.0 + 15.0 * (1 + math.sin(math.radians(i * 12)))  # 20–50 mm
        arc_cps.append(
            {
                "weight": i / (n - 1),
                "gantry": round(gantry, 3),
                "jx": (-60.0, 60.0),
                "jy": (-60.0, 60.0),
                "mlc": _mlc_open(bounds, half, 40.0),
            }
        )
    beams.append(_beam(3, "ARC", arc_cps, bounds, True))
    ds.BeamSequence = Sequence(beams)
    fg = Dataset()
    fg.FractionGroupNumber = 1
    fg.NumberOfFractionsPlanned = FRACTIONS
    fg.NumberOfBeams = len(beams)
    refs = []
    for number in (1, 2, 3):
        rb = Dataset()
        rb.ReferencedBeamNumber = number
        rb.BeamMeterset = MU[number]
        refs.append(rb)
    fg.ReferencedBeamSequence = Sequence(refs)
    ds.FractionGroupSequence = Sequence([fg])
    _save(ds, case.root / "RP" / "RP.synth6x.dcm")


def build_plan(root: Path) -> Case:
    case = Case(
        case_id="plan6x",
        title="水假體（肺、骨）＋ 6X 計畫（AP、LAT、VMAT）",
        modality="CT",
        pattern="dose calculation",
        source=["PS3.3 C.8.8.14 RT Beams Module"],
        root=root,
    )
    case.patient_id = "SYNPLAN-1"
    for_uid = uid("for", case.case_id)
    ct = _write_ct_series(
        case,
        key="ct",
        number=1,
        description="synth plan CT",
        for_uid=for_uid,
        values=_hu,
        image_type=["ORIGINAL", "PRIMARY", "AXIAL"],
        geom=GEOM,
        role="ct",
    )
    plan_sop = uid("plan-sop", case.case_id)
    _plan(case, for_uid, plan_sop)
    case.expected = {
        "plan_sop_instance_uid": plan_sop,
        "plan_series_instance_uid": uid("plan-series", case.case_id),
        "ct_series_instance_uid": ct.series_uid,
        "frame_of_reference_uid": for_uid,
        "beams": [1, 2, 3],
        "mu": MU,
        "fractions": FRACTIONS,
    }
    return case


def build(out: Path) -> Case:
    root = out / "plan6x"
    if root.exists():
        import shutil

        shutil.rmtree(root)
    case = build_plan(root)
    case.write_expected()
    return case


def main() -> None:
    ap = argparse.ArgumentParser(description="劑量計算用的合成計畫（水假體 ＋ 6X 計畫）—— 零 PHI、完全確定性")
    ap.add_argument("--out", type=Path, required=True)
    args = ap.parse_args()
    case = build(args.out)
    print(json.dumps({"patient_id": case.patient_id, "root": str(case.root), **case.expected}, ensure_ascii=False))


if __name__ == "__main__":
    main()
