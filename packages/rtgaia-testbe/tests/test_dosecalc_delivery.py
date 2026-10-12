"""劑量計算的照射描述：幾何跟顯示用的射束幾何同一套、射源在哪一側、開口判斷、機架跨 0° 的內插、
讀 RTPLAN（MU、控制點往後帶）與各種拒算、計算封包來回、流程測試引擎的方向性與命令列。"""

from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

import numpy as np
import pydicom
import pytest
from rtgaia_core import beam_geometry
from rtgaia_dosecalc import phantoms
from rtgaia_dosecalc.ct_calibration import builtin_calibration
from rtgaia_dosecalc.delivery import ControlPoint, aperture_open, bld_to_lps, interpolate, segments
from rtgaia_dosecalc.from_rtplan import read_delivery
from rtgaia_dosecalc.package import CalcInput, CalcResult
from rtgaia_geom import Grid
from rtgaia_testbe.fixtures import synth_plan


@pytest.fixture(scope="module")
def plan_case(tmp_path_factory) -> Path:  # type: ignore[no-untyped-def]
    return synth_plan.build(tmp_path_factory.mktemp("synth-plan")).root


def _plan_path(root: Path) -> Path:
    return next((root / "RP").glob("*.dcm"))


# ── 幾何 ──────────────────────────────────────────────────────────────────────


@pytest.mark.parametrize("position", ["HFS", "FFS", "HFP", "FFP"])
@pytest.mark.parametrize(("g", "c", "t"), [(0, 0, 0), (90, 0, 0), (180, 30, 0), (270, 0, 45), (33, 350, 315)])
def test_geometry_matches_display_geometry(position: str, g: float, c: float, t: float) -> None:
    assert np.allclose(bld_to_lps(g, c, t, position), beam_geometry.bld_to_lps(g, c, t, position))


def test_source_side_hfs() -> None:
    """HFS：機架 0° 射源在病人前（LPS −y）、90° 在病人左（+x）、180° 在後、270° 在右。"""
    iso = np.zeros(3)
    for g, axis, sign in ((0, 1, -1), (90, 0, 1), (180, 1, 1), (270, 0, -1)):
        src = iso + bld_to_lps(g, 0, 0, "HFS") @ np.array([0, 0, 1000.0])
        assert np.sign(src[axis]) == sign and abs(src[axis]) == pytest.approx(1000.0), g


def test_aperture_jaws_and_mlc() -> None:
    from rtgaia_dosecalc.delivery import Beam

    bounds = [-10.0, 0.0, 10.0]
    beam = Beam(1, "b", 6, "STANDARD", 1000, (0, 0, 0), "HFS", 100, [], leaf_boundaries_mm=bounds)
    cp = ControlPoint(0, 0, 0, 0, (-20, 20), (-10, 10), mlc_a=[-5, -15], mlc_b=[5, 0])
    x = np.array([0.0, 10.0, -10.0, -10.0, 1.0, 25.0, 0.0])
    y = np.array([-5.0, -5.0, 5.0, -5.0, 5.0, 5.0, 15.0])
    assert aperture_open(beam, cp, x, y).tolist() == [True, False, True, False, False, False, False]


def test_interpolation_takes_short_way_across_zero() -> None:
    a = ControlPoint(0, 350, 0, 0, (-10, 10), (-10, 10), [0.0], [10.0])
    b = ControlPoint(10, 10, 0, 0, (-20, 20), (-10, 10), [-10.0], [20.0])
    m = interpolate(a, b, 0.5)
    assert m.gantry_deg == pytest.approx(0.0, abs=1e-9)
    assert m.cumulative_mu == pytest.approx(5.0)
    assert m.jaw_x == (-15.0, 15.0) and m.mlc_a == [-5.0] and m.mlc_b == [15.0]


# ── RTPLAN ────────────────────────────────────────────────────────────────────


def test_read_synth_plan(plan_case: Path) -> None:
    d, problems = read_delivery(_plan_path(plan_case))
    assert problems == [] and d is not None
    assert [b.number for b in d.beams] == [1, 2, 3] and d.fractions == 2
    ap, lat, arc = d.beams
    assert ap.mu == 200 and ap.control_points[-1].mlc_a == ap.control_points[0].mlc_a, "控制點往後帶"
    assert lat.control_points[0].gantry_deg == 90 and len(lat.leaf_boundaries_mm or []) == 61
    assert len(arc.control_points) == 61 and arc.control_points[-1].cumulative_mu == pytest.approx(400)
    assert sum(mu for _a, _b, mu in segments(arc)) == pytest.approx(400)
    assert d.total_mu == pytest.approx(750)


@pytest.mark.parametrize(
    ("edit", "message"),
    [
        (lambda b, cp: setattr(b, "RadiationType", "ELECTRON"), "只支援光子"),
        (lambda b, cp: setattr(b, "NumberOfWedges", 1), "楔形板"),
        (lambda b, cp: setattr(b, "NumberOfBoli", 1), "bolus"),
        (lambda b, cp: setattr(cp, "TableTopPitchAngle", 2.0), "床的 pitch"),
        (lambda b, cp: setattr(cp, "GantryPitchAngle", 5.0), "機架俯仰"),
    ],
)
def test_unsupported_items_are_refused(plan_case: Path, tmp_path: Path, edit, message: str) -> None:  # type: ignore[no-untyped-def]
    ds = pydicom.dcmread(_plan_path(plan_case))
    b = ds.BeamSequence[0]
    edit(b, b.ControlPointSequence[0])
    p = tmp_path / "edited.dcm"
    ds.save_as(p)
    d, problems = read_delivery(p)
    assert d is None and any(message in x for x in problems), problems
    assert all(x.startswith("AP：") for x in problems)


def test_setup_beams_and_beam_filter(plan_case: Path, tmp_path: Path) -> None:
    ds = pydicom.dcmread(_plan_path(plan_case))
    ds.BeamSequence[1].TreatmentDeliveryType = "SETUP"
    p = tmp_path / "setup.dcm"
    ds.save_as(p)
    d, _ = read_delivery(p)
    assert d is not None and [b.number for b in d.beams] == [1, 3]
    d2, _ = read_delivery(_plan_path(plan_case), beam_numbers=[3])
    assert d2 is not None and [b.number for b in d2.beams] == [3]


# ── 封包與流程測試引擎 ────────────────────────────────────────────────────────


def _input(plan_case: Path, engine: str = "pipeline-test") -> CalcInput:
    d, _ = read_delivery(_plan_path(plan_case), beam_numbers=[1])
    assert d is not None
    hu, g = phantoms.water_box((300.0, 300.0, 300.0), 10.0, air_margin_mm=30.0)
    dose_grid = Grid(
        size=(24, 24, 24),
        spacing=(10.0,) * 3,
        origin=(-115.0,) * 3,
        direction=g.direction,
        frame_of_reference_uid=g.frame_of_reference_uid,
    )
    return CalcInput(
        engine=engine,
        delivery=d,
        ct_hu=hu,
        ct_grid=g,
        dose_grid=dose_grid,
        calibration=builtin_calibration(),
        beam_model={"name": "test"},
    )


def test_package_roundtrip(plan_case: Path, tmp_path: Path) -> None:
    inp = _input(plan_case)
    inp.write(tmp_path / "in")
    back = CalcInput.read(tmp_path / "in")
    assert back.delivery.beams[0].control_points[0].jaw_x == (-50.0, 50.0)
    assert np.array_equal(back.ct_hu, inp.ct_hu) and back.dose_grid == inp.dose_grid


def test_pipeline_engine_beam_enters_from_the_front(plan_case: Path, tmp_path: Path) -> None:
    """AP（機架 0°、HFS）：劑量從前面（−y）進來、往後遞減；左右的半影在 ±50 mm（投影到等中心）。"""
    from rtgaia_dosecalc.engines.pipeline_test import run

    inp = _input(plan_case)
    res = run(inp, tmp_path, lambda *_a: None)
    d = res.dose_gy  # (k, j, i)；網格 −115 … 115，每 10 mm
    k_mid = 11  # z ≈ −5
    i_mid = 11
    axis = d[k_mid, :, i_mid]
    j_front, j_back = 3, 19  # y ≈ −85、75（水在 ±150 以內）
    assert axis[j_front] > axis[j_back] > 0
    row = d[k_mid, 11, :]  # y ≈ −5（靠近等中心深度）
    x = -115 + 10 * np.arange(24)
    inside = row[np.abs(x) <= 35]
    outside = row[np.abs(x) >= 65]
    assert inside.min() > 10 * outside.max(), "開口外只剩穿透"
    assert set(res.per_beam_gy) == {1} and np.allclose(res.per_beam_gy[1], d)


def test_cli_runs_a_package(plan_case: Path, tmp_path: Path) -> None:
    _input(plan_case).write(tmp_path / "in")
    r = subprocess.run(
        [
            sys.executable,
            "-m",
            "rtgaia_dosecalc",
            "run",
            "--input",
            str(tmp_path / "in"),
            "--output",
            str(tmp_path / "out"),
        ],
        capture_output=True,
        text=True,
        timeout=300,
    )
    assert r.returncode == 0, r.stderr
    res = CalcResult.read(tmp_path / "out")
    assert res.dose_gy.shape == (24, 24, 24) and res.info["engine"] == "pipeline-test"
    assert json.loads((tmp_path / "out" / "progress.json").read_text())["phase"] == "done"
    bad = subprocess.run(
        [
            sys.executable,
            "-m",
            "rtgaia_dosecalc",
            "run",
            "--input",
            str(tmp_path / "nope"),
            "--output",
            str(tmp_path / "out2"),
        ],
        capture_output=True,
        text=True,
        timeout=60,
    )
    assert bad.returncode == 2 and "讀不了計算封包" in (tmp_path / "out2" / "error.json").read_text()
