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


# ── 雙層 MLC、FFF 模型 ────────────────────────────────────────────────────────


def _dual_plan(src: Path, dst: Path) -> Path:
    """把合成計畫改成 Halcyon 類：MLCX1（28 對、−140…140）＋ MLCX2（29 對、−145…145）、6 MV FFF。"""
    from pydicom.dataset import Dataset
    from pydicom.sequence import Sequence

    ds = pydicom.dcmread(_plan_path(src))
    b1 = [float(v) for v in range(-140, 141, 10)]
    b2 = [float(v) for v in range(-145, 146, 10)]
    for b in ds.BeamSequence:
        devs = []
        for kind, n, bounds in (("ASYMX", 1, None), ("ASYMY", 1, None), ("MLCX1", 28, b1), ("MLCX2", 29, b2)):
            d = Dataset()
            d.RTBeamLimitingDeviceType = kind
            d.NumberOfLeafJawPairs = n
            if bounds:
                d.LeafPositionBoundaries = bounds
            devs.append(d)
        b.BeamLimitingDeviceSequence = Sequence(devs)
        fm = Dataset()
        fm.FluenceMode = "NON_STANDARD"
        fm.FluenceModeID = "FFF"
        b.PrimaryFluenceModeSequence = Sequence([fm])
        for cp in b.ControlPointSequence:
            seq = cp.get("BeamLimitingDevicePositionSequence")
            if not seq:
                continue
            out = []
            for kind, values in (
                ("ASYMX", [-140.0, 140.0]),
                ("ASYMY", [-140.0, 140.0]),
                ("MLCX1", [-30.0] * 28 + [30.0] * 28),
                ("MLCX2", [-20.0] * 29 + [40.0] * 29),
            ):
                p = Dataset()
                p.RTBeamLimitingDeviceType = kind
                p.LeafJawPositions = values
                out.append(p)
            cp.BeamLimitingDevicePositionSequence = Sequence(out)
    path = dst / "dual.dcm"
    ds.save_as(path)
    return path


def test_dual_layer_mlc_and_fff_model(plan_case: Path, tmp_path: Path) -> None:
    from rtgaia_dosecalc import beam_models
    from rtgaia_dosecalc.delivery import Beam

    d, problems = read_delivery(_dual_plan(plan_case, tmp_path))
    assert problems == [] and d is not None
    beam = d.beams[0]
    assert beam.mlc_devices == ["MLCX1", "MLCX2"] and beam.fluence_mode == "FFF"
    assert len(beam.leaf_boundaries_mm or []) == 29 and len(beam.leaf2_boundaries_mm or []) == 30
    cp = beam.control_points[0]
    assert cp.mlc_a == [-30.0] * 28 and cp.mlc2_b == [40.0] * 29
    # 兩層都開才透光：MLCX1 開 −30…30、MLCX2 開 −20…40 → −20…30
    x = np.array([-25.0, -15.0, 25.0, 35.0])
    assert aperture_open(beam, cp, x, np.zeros(4)).tolist() == [False, True, True, False]
    m, why = beam_models.model_for(6.0, "FFF", mlc_devices=beam.mlc_devices)
    assert why is None and m["model_id"] == "demo-6xfff-dual" and "jaw_x" not in m["params"]["collimators"]
    single, _ = beam_models.model_for(6.0, "FFF", mlc_devices=["MLCX"])
    assert single["model_id"] == "demo-6xfff"
    assert beam_models.model_for(6.0, "STANDARD", mlc_devices=["MLCX1", "MLCX2"])[0] is None
    assert isinstance(beam, Beam)


def test_fff_spectrum_is_softer() -> None:
    from rtgaia_dosecalc import beam_models

    e, w = beam_models.spectrum_lines()
    ef, wf = beam_models.fff_lines()
    mean = sum(a * b for a, b in zip(e, w, strict=True))
    mean_f = sum(a * b for a, b in zip(ef, wf, strict=True))
    assert sum(wf) == pytest.approx(1.0) and 0.8 < mean_f / mean < 0.9


def test_topas_parameters_dual_layer_without_jaws(plan_case: Path, tmp_path: Path) -> None:
    """沒有 jaw 的模型 → 參數檔沒有會動的 jaw、只有固定的主準直器，有兩個 TsDivergingMLC；FFF 原射源是高斯角分佈。
    （不用跑 TOPAS）"""
    from rtgaia_dosecalc import beam_models
    from rtgaia_dosecalc.engines.topas import beam_parameters

    d, _ = read_delivery(_dual_plan(plan_case, tmp_path))
    assert d is not None
    text, n, _m = beam_parameters(
        d.beams[2], beam_models.demo_6xfff_dual(), 100_000, iso=(0.0, 0.0, 0.0), world_hl_mm=2000.0
    )
    assert "Ge/JawX/" not in text and "Ge/JawY/" not in text and text.count('Type = "TsDivergingMLC"') == 2
    # 固定的主準直器：兩組 TsJaws、開口 ± 140 不跟控制點走（沒有時間序列）
    assert text.count('Type = "TsJaws"') == 2 and "d:Ge/FixedY/NegativeFieldSetting = -140.0 mm" in text
    assert "Tf/FixedX" not in text and "d:Ge/FixedX/PositiveFieldSetting = 140.0 mm" in text
    assert "Ge/MLC2/LeafWidths = 29" in text and "Ge/MLC/LeafWidths = 28" in text
    assert 's:So/Primary/BeamAngularDistribution = "Gaussian"' in text and n == 100_000
    text6, _, _ = beam_parameters(
        read_delivery(_plan_path(plan_case))[0].beams[0],
        beam_models.demo_6x(),
        1000,
        iso=(0.0, 0.0, 0.0),
        world_hl_mm=2000.0,
    )
    assert text6.count('Type = "TsJaws"') == 2 and '"Flat"' in text6


def test_cone_geometry_and_mass() -> None:
    """外接橢圓碰到射野四角；高斯在圓裡的質量 ＝ 1 − exp(−a²／2σ²)；均勻 ＝ 面積。"""
    import math

    from rtgaia_dosecalc.engines.topas import _ellipse, _mass

    a, b = _ellipse(50.0, 30.0, 1000.0)
    corner = (math.sin(math.atan(50 / 1000) / 2) / a) ** 2 + (math.sin(math.atan(30 / 1000) / 2) / b) ** 2
    assert corner == pytest.approx(1.0)
    s = math.sin(math.radians(7.6) / 2)
    for r in (0.01, 0.05, 0.1):
        assert _mass(r, r, 7.6) == pytest.approx(1 - math.exp(-(r * r) / (2 * s * s)), rel=1e-6)
    assert _mass(0.1, 0.05, None) == pytest.approx(0.005)


def test_spectrum_starts_with_a_zero_weight_bin(plan_case: Path) -> None:
    """TOPAS 的離散能譜抽樣在亂數落在第一格時會越界讀取 → 參數檔的第一個能階權重是 0，其餘照模型。"""
    from rtgaia_dosecalc import beam_models
    from rtgaia_dosecalc.engines.topas import beam_parameters

    model = beam_models.demo_6x()
    text, _, _ = beam_parameters(
        read_delivery(_plan_path(plan_case))[0].beams[0], model, 1000, iso=(0.0, 0.0, 0.0), world_hl_mm=2000.0
    )
    line = next(x for x in text.splitlines() if x.startswith("uv:So/Primary/BeamEnergySpectrumWeights"))
    weights = [float(v) for v in line.split("=")[1].split()[1:]]
    assert weights[0] == 0.0 and len(weights) == len(model["params"]["spectrum_weights"]) + 1
    assert sum(weights) == pytest.approx(1.0, abs=1e-4)


def test_calc_grid_covers_the_output_and_resamples_back() -> None:
    """粗的計分網格包住輸出網格、中心相同；內插回去時線性場不變，NaN（空氣）不混進來。"""
    from rtgaia_dosecalc.engines.topas import calc_grid, to_output

    out = Grid(
        size=(40, 30, 20), spacing=(2.5, 2.5, 3.0), origin=(-50.0, -30.0, 10.0),
        direction=(1, 0, 0, 0, 1, 0, 0, 0, 1), frame_of_reference_uid="x",
    )  # fmt: skip
    assert calc_grid(out, None) is out and calc_grid(out, 3.0) is out, "不比輸出粗就直接用輸出網格"
    g = calc_grid(out, 4.0)
    assert g.spacing == (4.0, 4.0, 4.0) and g.size == (25, 19, 15)
    lo_o = np.asarray(out.origin) - np.asarray(out.spacing) / 2
    hi_o = lo_o + np.asarray(out.size) * np.asarray(out.spacing)
    lo_g = np.asarray(g.origin) - 2.0
    hi_g = lo_g + np.asarray(g.size) * 4.0
    assert np.all(lo_g <= lo_o + 1e-9) and np.all(hi_g >= hi_o - 1e-9)
    assert np.allclose((lo_g + hi_g) / 2, (lo_o + hi_o) / 2)
    gk, gj, gi = np.meshgrid(*(np.asarray(g.origin[a]) + np.arange(g.size[a]) * 4.0 for a in (2, 1, 0)), indexing="ij")
    field = (1.0 + 0.01 * gi + 0.02 * gj - 0.03 * gk).astype(np.float32)
    field[:, :, :3] = np.nan  # 最左邊三排是空氣
    (res,) = to_output([field], g, out)
    ok, oj, oi = np.meshgrid(
        *(np.asarray(out.origin[a]) + np.arange(out.size[a]) * out.spacing[a] for a in (2, 1, 0)), indexing="ij"
    )
    expect = 1.0 + 0.01 * oi + 0.02 * oj - 0.03 * ok
    inside = [
        (o >= g.origin[a] - 1e-9) & (o <= g.origin[a] + (g.size[a] - 1) * 4.0 + 1e-9)
        for a, o in enumerate((oi, oj, ok))
    ]
    inner = inside[0] & inside[1] & inside[2] & (oi > g.origin[0] + 3 * 4.0)
    assert inner.sum() > 1000 and np.allclose(res[inner], expect[inner], atol=1e-4), "線性場三線性內插不變"
    assert np.isnan(res[oi < g.origin[0] + 2 * 4.0]).all(), "鄰居全是空氣 → NaN"
    edge = (oi > g.origin[0] + 2 * 4.0) & (oi < g.origin[0] + 3 * 4.0)
    assert np.isfinite(res[edge]).all(), "一邊空氣一邊有值 → 只用有值的那邊"


def test_leaves_are_long_enough_to_shield_the_far_edge() -> None:
    """TOPAS 的葉片長度是投影到等中心平面的值：葉片在射野一邊關起來，身後還要擋得到另一邊的射野邊緣 ——
    否則葉片後面漏光（沒有 jaw 的雙層 MLC 直接打進病人；曾經因此在 Halcyon 計畫的中線附近多算約 15%）。"""
    from rtgaia_dosecalc import beam_models

    for model in (beam_models.demo_6x(), beam_models.demo_6xfff(), beam_models.demo_6xfff_dual()):
        for name, spec in model["params"]["collimators"].items():
            if name.startswith("MLC"):
                assert spec["leaf_length_mm"] >= 280.0, (model["model_id"], name)
