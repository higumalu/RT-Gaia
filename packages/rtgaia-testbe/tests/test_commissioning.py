"""射束模型對射束資料的比對（不用 GPU 的部分）：水箱條件 → 射束幾何、網格、取值（dmax、PDD、半影、FWHM、
FFF 正規化、unflatness、slope）對解析解、偵檢器體積平均、資料集 → 比較點、殘差與容許的計算（假的模擬器）。"""

from __future__ import annotations

import math

import numpy as np
import pytest
from rtgaia_dosecalc import beam_data, beam_models, commissioning, water
from rtgaia_dosecalc.engines import topas
from scipy.special import erf

MODELS = {m["model_id"]: m for m in beam_models.builtin_models()}
DATASETS = {d["dataset_id"]: d for d in beam_data.builtin_datasets()}


# ── 幾何 ──────────────────────────────────────────────────────────────────────


def test_mlc_opening_opens_leaves_that_overlap_the_field() -> None:
    # 錯開半片的那一層（邊界 −15、−5、5、15）：10 × 10 的 y ±50 要開到 ±55（跟射野重疊的葉片都開）
    bounds = [float(v) for v in range(-145, 146, 10)]
    a, b = topas.mlc_opening(bounds, -50, 50, -50, 50)
    opened = [(lo, hi) for lo, hi, aa in zip(bounds, bounds[1:], a, strict=False) if aa != 0.0]
    assert opened[0][0] == -55 and opened[-1][1] == 55
    assert all(x == -50 for x in a if x != 0.0) and all(x == 50 for x in b if x != 0.0)
    # 葉片邊界剛好在射野邊上：不開外面那一片
    a2, _ = topas.mlc_opening([float(v) for v in range(-140, 141, 10)], -50, 50, -50, 50)
    assert sum(1 for x in a2 if x != 0.0) == 10


def test_reference_beam_of_dual_layer_model_covers_the_reference_field() -> None:
    ref = topas.reference_beam(MODELS["demo-6xfff-dual"])
    cp = ref.control_points[0]
    for bounds, a in ((ref.leaf_boundaries_mm, cp.mlc_a), (ref.leaf2_boundaries_mm, cp.mlc2_a)):
        open_rows = [(lo, hi) for lo, hi, x in zip(bounds, bounds[1:], a, strict=False) if x != 0.0]
        assert open_rows[0][0] <= -50 and open_rows[-1][1] >= 50


def test_setup_beam_collimation() -> None:
    m6 = MODELS["demo-6x"]
    jaw = water.setup_beam(m6, water.Setup(100, 100, 900))
    assert jaw.isocenter_lps == (0.0, 100.0, 0.0) and jaw.leaf_boundaries_mm is None
    assert jaw.control_points[0].jaw_x == (-50, 50)
    mlc = water.setup_beam(m6, water.Setup(5, 5, 1000, "mlc"))
    cp = mlc.control_points[0]
    assert cp.jaw_x == (-4.0, 4.0) and mlc.mlc_devices == ["MLCX"]  # jaw 至少 8 mm
    # Millennium 的葉片邊界在 0、±5：5 mm 的射野開兩片 → y 由 8 mm 的 jaw 決定，比較時要說出來
    assert sum(1 for a in cp.mlc_a if a != 0.0) == 2
    assert "8 mm" in water.field_note(m6, water.Setup(5, 5, 1000, "mlc"))
    assert water.field_note(m6, water.Setup(40, 40, 1000, "mlc")) == ""
    mlc40 = water.setup_beam(m6, water.Setup(40, 40, 1000, "mlc"))
    assert mlc40.control_points[0].jaw_x == (-21.0, 21.0)  # MLC ＋ 2 mm
    closed = water.setup_beam(m6, water.Setup(100, 100, 1000, "closed"))
    assert set(closed.control_points[0].mlc_a) == {60.0} and closed.control_points[0].jaw_x == (-50, 50)
    dual = MODELS["demo-6xfff-dual"]
    c1 = water.setup_beam(dual, water.Setup(100, 100, 1000, "closed", closed_layer="MLCX1")).control_points[0]
    assert set(c1.mlc_a) == {60.0} and -50.0 in c1.mlc2_a  # 下層全關、上層照開
    with pytest.raises(ValueError):
        water.setup_beam({**m6, "mlc_devices": []}, water.Setup(10, 10, 1000, "mlc"))


def test_grid_follows_the_field() -> None:
    g = water.grid_for(water.Setup(100, 100, 1000), 1000)
    nz, ny, nx = g.shape
    assert nx % 2 == 1 and nz % 2 == 1 and ny == 150 and g.spacing == (1.0, 2.0, 5.0)
    assert abs(g.centers(0)[nx // 2]) < 1e-9 and abs(g.centers(2)[nz // 2]) < 1e-9
    small = water.grid_for(water.Setup(5, 5, 1000, "mlc"), 1000)
    assert small.spacing == (0.5, 2.0, 0.5)
    big = water.grid_for(water.Setup(400, 400, 1000), 1000)
    assert big.centers(0)[-1] <= 300.0 + 1e-6


# ── 取值 ──────────────────────────────────────────────────────────────────────


def _depth_curve(peak: float = 14.0) -> tuple[np.ndarray, np.ndarray]:
    """建成 × 衰減：(1 − e^{−1.8 d/peak}) e^{−0.005 d}，深度每 2 mm（跟模擬的網格一樣）。"""
    d = np.arange(1.0, 300.0, 2.0)
    return d, (1 - np.exp(-d / peak * 1.8)) * np.exp(-0.005 * d)


def test_dmax_pdd_and_tpr_on_a_smooth_curve() -> None:
    d, dose = _depth_curve()
    fine = np.linspace(1, 60, 20001)
    true_dmax = fine[np.argmax((1 - np.exp(-fine / 14 * 1.8)) * np.exp(-0.005 * fine))]
    assert water.dmax_mm(d, dose) == pytest.approx(true_dmax, abs=0.2)
    dm = true_dmax
    peak = (1 - np.exp(-dm / 14 * 1.8)) * np.exp(-0.005 * dm)
    exact10 = 100 * (1 - np.exp(-100 / 14 * 1.8)) * np.exp(-0.5) / peak
    assert water.pdd_at(d, dose, 100.0) == pytest.approx(exact10, abs=0.05)
    r = water.dose_at(d, dose, 200.0) / water.dose_at(d, dose, 100.0)
    assert water.tpr20_10(d, dose) == pytest.approx(1.2661 * r - 0.0595)
    # 雜訊 0.5% 時 dmax 還在 ±1 mm 內
    rng = np.random.default_rng(1)
    noisy = dose * (1 + 0.005 * rng.standard_normal(dose.shape))
    assert abs(water.dmax_mm(d, noisy) - true_dmax) < 1.0


def _edge_profile(half: float, sigma: float, dx: float = 0.5) -> tuple[np.ndarray, np.ndarray]:
    x = np.arange(0, half + 60, dx)
    return x, 0.5 * (1 + erf((half - x) / (sigma * math.sqrt(2))))


def test_profile_metrics_on_an_erf_edge() -> None:
    x, prof = _edge_profile(50.0, 2.0)
    m = water.profile_metrics(x, prof, fff=False)
    assert m["fwhm_mm"] == pytest.approx(100.0, abs=0.05)
    # 80–20% 的距離 ＝ (Φ⁻¹(0.8) − Φ⁻¹(0.2)) σ ＝ 1.6832 σ
    assert m["penumbra_80_20_mm"] == pytest.approx(1.6832 * 2.0, abs=0.05)
    assert m["unflatness"] == pytest.approx(1.0, abs=1e-6) and m["slope_percent_per_mm"] == pytest.approx(0.0, abs=1e-6)


def test_fff_profile_is_normalized_at_the_inflection_point() -> None:
    x, edge = _edge_profile(50.0, 2.0)
    cone = 1.0 - 0.003 * x  # 往外掉 0.3%/mm
    prof = cone * edge
    y = water.normalize_profile(x, prof, fff=True)
    fine = np.linspace(40, 60, 20001)
    f = (1.0 - 0.003 * fine) * 0.5 * (1 + erf((50.0 - fine) / (2.0 * math.sqrt(2))))
    xi = fine[int(np.argmax(-np.gradient(f, fine)))]  # 真正的反曲點（解析式、細格）
    assert np.interp(xi, x, y) == pytest.approx(50.0, abs=0.2)
    m = water.profile_metrics(x, prof, fff=True)
    assert m["fwhm_mm"] == pytest.approx(100.0, abs=0.3)
    assert m["unflatness"] > 1.1 and m["slope_percent_per_mm"] > 0.1


def test_detector_averaging_widens_the_penumbra() -> None:
    x, prof = _edge_profile(50.0, 1.5)
    base = water.profile_metrics(x, prof, fff=False)["penumbra_80_20_mm"]
    assert np.array_equal(water.average_detector(x, prof, 0.0), prof)
    widened = [
        water.profile_metrics(x, water.average_detector(x, prof, r), fff=False)["penumbra_80_20_mm"]
        for r in (0.5, 1.5, 3.0)
    ]
    assert base < widened[0] < widened[1] < widened[2]
    assert water.profile_metrics(x, water.average_detector(x, prof, 3.0), fff=False)["fwhm_mm"] == pytest.approx(
        100.0, abs=0.1
    )
    assert water.detector_radius("IBA CC13") == 3.0
    assert water.detector_radius("IBA CC13 or PTW 31010 chamber") == pytest.approx((3.0 + 2.75) / 2)
    assert water.detector_radius("something else") is None


def test_reduce_takes_the_central_axis_and_mirrors_profiles() -> None:
    s = water.Setup(100, 100, 1000, profile_depths=(100.0,))
    g = water.grid_for(s, 1000)
    xs, ys, zs = g.centers(0), g.centers(1), g.centers(2)
    X = xs[None, None, :]
    Y = ys[None, :, None]
    dose = np.exp(-Y / 200.0) * np.where(np.abs(X) <= 55, 1.0, 0.1) * np.ones((len(zs), 1, 1))
    cur = water.reduce(dose, g, s)
    assert cur.cax == pytest.approx(np.exp(-ys / 200.0))
    prof = cur.profiles[100.0]
    assert cur.x_mm[0] == 0.0 and prof[0] == pytest.approx(np.exp(-ys[np.argmin(abs(ys - 100))] / 200.0), rel=0.02)
    assert prof[int(60 / g.spacing[0])] == pytest.approx(0.1 * prof[0], rel=0.05)


# ── 資料集 → 比較點 ───────────────────────────────────────────────────────────


def test_plan_checks_for_public_datasets() -> None:
    checks = commissioning.plan_checks(MODELS["demo-6x"], DATASETS["pub-beyer2013-6x"])
    q = [c.quantity for c in checks]
    assert q.count("pdd") == 3 and q.count("output_factor") == 9 and q.count("penumbra_80_20_mm") == 4
    of = next(c for c in checks if c.quantity == "output_factor")
    assert of.setup.ssd == 950 and of.depth == 50 and of.reference.field_x == 100
    dmax = next(c for c in checks if c.quantity == "dmax_mm")
    assert dmax.extra.get("note")  # Beyer 沒寫 SSD
    pen = next(c for c in checks if c.quantity == "penumbra_80_20_mm")
    assert pen.extra["detector_r"] == 3.0 and pen.setup.profile_depths == (pen.depth,)
    lim = commissioning.plan_checks(MODELS["demo-6xfff-dual"], DATASETS["pub-lim2019-halcyon-mlc"])
    trans = [c for c in lim if c.quantity == "mlc_transmission"]
    assert {c.extra["layer"] for c in trans} == {"MLCX1", "MLCX2"} and all(
        c.setup.collimation == "closed" for c in trans
    )
    height = next(c for c in lim if c.quantity == "leaf_height_mm")
    assert height.model_value == 77.0 and height.measured == 77.0
    assert {c.quantity for c in lim if c.unsupported} == {"leaf_end_offset_mm", "leaf_end_radius_mm"}
    gao = commissioning.plan_checks(MODELS["demo-6xfff-dual"], DATASETS["pub-gao2019-halcyon"])
    rect = [c for c in gao if c.quantity == "output_factor" and c.x is None]
    assert [(c.setup.field_x, c.setup.field_y) for c in rect] == [(40.0, 200.0), (200.0, 40.0)]
    assert all(c.setup.collimation == "mlc" for c in gao if c.setup)


def test_histories_scale_with_field_area() -> None:
    assert commissioning.histories_for(water.Setup(30, 30, 1000), 1000) == 1000
    assert commissioning.histories_for(water.Setup(200, 200, 1000), 1000) == 4000
    assert commissioning.histories_for(water.Setup(400, 400, 1000), 1000) == 4000


def test_run_checks_residuals_with_a_fake_simulator(monkeypatch) -> None:  # type: ignore[no-untyped-def]
    """假的模擬器：深度曲線跟射野無關、中心軸劑量 ∝ 射野邊長的 0.05 次方 → 輸出因子、PDD 的殘差算得出來。"""
    d, dose = _depth_curve()

    def fake(model, setup, tb, histories, *, batches=10, seed=1):  # type: ignore[no-untyped-def]
        g = water.grid_for(setup, 1000)
        scale = (setup.field_x / 100.0) ** 0.05
        if setup.collimation == "closed":
            scale *= 0.004
        x, edge = _edge_profile(setup.field_x / 2, 2.0, g.spacing[0])
        cur = water.Curves(depth_mm=d, cax=dose * scale, x_mm=x, profiles={p: edge for p in setup.profile_depths})
        return water.Simulated(setup, g, [cur] * 3, cur, histories, 0.0, 1.0)

    monkeypatch.setattr(water, "simulate", fake)
    rep = commissioning.run_checks(MODELS["demo-6x"], DATASETS["pub-beyer2013-6x"], tb=None, hpm=1.0, histories=10)
    rows = {(r["measurement_id"], r["x"]): r for r in rep["checks"]}
    of30 = rows[("beyer2013-t2-of-6x", 30.0)]
    assert of30["model"] == pytest.approx(0.3**0.05) and of30["diff"] == pytest.approx(0.3**0.05 - 0.877)
    assert of30["status"] == "fail" and of30["in_tolerance"] == pytest.approx(of30["diff"] / (0.01 * 0.877))
    assert rows[("beyer2013-t2-of-6x", 100.0)]["status"] == "pass"
    pdd = rows[("beyer2013-t1-pdd10-6x-10x10", 100.0)]
    assert pdd["model"] == pytest.approx(water.pdd_at(d, dose, 100.0))
    assert pdd["u_model"] == 0.0  # 三批一樣
    s = rep["summary"]
    assert s["points"] == 26 and s["pass"] + s["fail"] == 26
    lim = commissioning.run_checks(
        MODELS["demo-6xfff-dual"], DATASETS["pub-lim2019-halcyon-mlc"], tb=None, hpm=1.0, histories=10
    )
    t = next(r for r in lim["checks"] if r["measurement_id"] == "lim2019-t3-transmission-distal-d10")
    assert t["model"] == pytest.approx(0.004) and t["status"] == "pass"
    assert {r["status"] for r in lim["checks"] if r["quantity"] == "leaf_end_offset_mm"} == {"unsupported"}
