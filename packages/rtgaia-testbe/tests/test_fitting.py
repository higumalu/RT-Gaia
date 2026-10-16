"""射束模型擬合的流程（不用 GPU）：假的解析「模擬器」—— 劑量對成分線性、深度曲線隨能譜變硬、電子污染抬高表面、
半影隨焦點變寬、機頭散射隨射野變大 —— 用一組已知的「真」參數造出量測，從示範模型出發擬合，要找回真值。
驗的是分段、基底組合、快取鍵、殘差、反散射的解析式、報告與 `finalize`，不是物理（物理在 GPU 的測試）。"""

from __future__ import annotations

import copy
import math

import numpy as np
import pytest
from rtgaia_dosecalc import beam_models, commissioning, fitting, water
from scipy.special import erf

DEPTH = np.arange(1.0, 300.0, 2.0)


def _component(model: dict) -> tuple[str, dict]:  # type: ignore[type-arg]
    p = model["params"]
    if (p.get("electron_contamination") or {}).get("fraction") == 1.0:
        return "ec", p["electron_contamination"]
    if (p.get("extra_focal") or {}).get("fraction") == 1.0:
        return "ef", p["extra_focal"]
    return "primary", p


def _fake_curves(model: dict, setup: water.Setup) -> water.Curves:  # type: ignore[type-arg]
    kind, q = _component(model)
    p = model["params"]
    e = np.asarray(p["spectrum_mev"])
    w = np.asarray(p["spectrum_weights"])
    mean_e = float((e * w).sum() / w.sum())
    field = math.sqrt(setup.field_x * setup.field_y)
    g = water.grid_for(setup, 1000.0)
    x = np.arange(0, g.spacing[0] * (g.shape[2] // 2 + 1), g.spacing[0])[: g.shape[2] // 2 + 1]
    half = setup.field_x / 2 * (setup.ssd + 100) / 1000
    shape = (1 - np.exp(-DEPTH / (6 + 3 * mean_e))) * np.exp(-0.012 / mean_e * DEPTH)
    if kind == "primary":
        cax = shape * (1 + 0.03 * math.log(field / 100.0))
        sigma = math.hypot(float(p["focal_spot_sigma_mm"]) * 2, 2.0)
    elif kind == "ef":
        cax = shape * 0.8 * (field / 100.0) ** 0.5 * (1 - math.exp(-field / float(q["sigma_mm"])))
        sigma = 8.0
    else:
        s = float(q["sigma_mm"])
        cax = 40.0 * np.exp(-DEPTH / (2.5 * float(q["mean_energy_mev"]))) * field**2 / (field**2 + s**2)
        sigma = 10.0
    if setup.collimation == "closed":
        cax = cax * 0.004 / float(p["collimators"][setup.closed_layer or "MLCX"].get("density_factor", 1.0)) ** 6
    edge = 0.5 * (1 + erf((half - x) / (sigma * math.sqrt(2))))
    return water.Curves(
        DEPTH, np.asarray(cax, dtype=float), x, {d: edge * np.interp(d, DEPTH, cax) for d in setup.profile_depths}
    )


@pytest.fixture
def fake(monkeypatch):  # type: ignore[no-untyped-def]
    calls = []

    def simulate(model, setup, tb, histories, *, batches=10, seed=1):  # type: ignore[no-untyped-def]
        calls.append((model["model_id"], setup.key))
        c = _fake_curves(model, setup)
        return water.Simulated(setup, water.grid_for(setup, 1000.0), [c, c, c], c, histories, 0.0, 1.0)

    monkeypatch.setattr(water, "simulate", simulate)
    return calls


def _truth(prior: dict) -> dict:  # type: ignore[type-arg]
    t = copy.deepcopy(prior)
    p = t["params"]
    masks = fitting.spectrum_groups(prior)
    w = np.asarray(p["spectrum_weights"], dtype=float)
    for m, f in zip(masks, (0.85, 1.05, 1.1, 1.2), strict=False):
        w[m] *= f
    p["spectrum_weights"] = list(w / w.sum())
    p["focal_spot_sigma_mm"] = 1.0
    p["extra_focal"] = {**p["extra_focal"], "fraction": 0.1, "sigma_mm": 25.0}
    p["electron_contamination"] = {
        "fraction": 0.004,
        "mean_energy_mev": 1.5,
        "sigma_mm": 80.0,
        "distance_below_target_mm": 500.0,
    }
    p["monitor_backscatter"] = {"per_mm_x": 5e-5, "per_mm_y": 1e-4}
    p["collimators"]["MLCX"]["density_factor"] = 0.9
    return t


def _dataset(truth: dict) -> dict:  # type: ignore[type-arg]
    """真模型在每個條件下的值 → 量測（PDD、dmax、半影、輸出因子、穿透）。"""
    pts_pdd = [
        {
            "kind": "depth_dose",
            "quantity": "pdd",
            "conditions": {"field_mm": [f, f], "ssd_mm": 1000.0, "normalization": "dmax"},
            "columns": ["depth_mm", "value"],
            "points": [[50.0, 0.0], [100.0, 0.0], [200.0, 0.0]],
            "measurement_id": f"pdd{f:g}",
        }
        for f in (40.0, 100.0, 300.0)
    ]
    dmax = [
        {
            "kind": "scalar",
            "quantity": "dmax_mm",
            "conditions": {"field_mm": [f, f], "ssd_mm": 1000.0},
            "columns": ["value"],
            "points": [[0.0]],
            "measurement_id": f"dmax{f:g}",
        }
        for f in (40.0, 100.0, 300.0)
    ]
    pen = [
        {
            "kind": "scalar",
            "quantity": "penumbra_80_20_mm",
            "conditions": {
                "field_mm": [100.0, 100.0],
                "ssd_mm": 1000.0,
                "depth_mm": 100.0,
                "axis": "x",
                "detector": "EDGE",
            },
            "columns": ["value"],
            "points": [[0.0]],
            "measurement_id": "pen",
        }
    ]
    of = [
        {
            "kind": "output_factor",
            "conditions": {"ssd_mm": 900.0, "depth_mm": 100.0, "reference_field_mm": [100.0, 100.0]},
            "columns": ["field_mm", "value"],
            "points": [[f, 0.0] for f in (30.0, 60.0, 100.0, 200.0, 400.0)],
            "measurement_id": "of",
        }
    ]
    tr = [
        {
            "kind": "scalar",
            "quantity": "mlc_transmission",
            "conditions": {"ssd_mm": 1000.0, "depth_mm": 100.0, "layer": "MLCX"},
            "columns": ["value"],
            "points": [[0.0]],
            "measurement_id": "tr",
        }
    ]
    from rtgaia_dosecalc import beam_data

    normalized = [beam_data.check_measurement(m) for m in pts_pdd + dmax + pen + of + tr]
    assert all(not problems for _m, problems in normalized), normalized
    ds = {"dataset_id": "synthetic", "measurements": [m for m, _p in normalized]}
    # 量測值 ＝ 真模型的值（反散射用解析式）
    checks = commissioning.plan_checks(truth, ds)
    st = fitting.State(truth, np.array([1.0]), [np.ones(len(truth["params"]["spectrum_weights"]), bool)])
    basis = fitting.Basis(None, 1)
    bs = truth["params"]["monitor_backscatter"]
    for c in checks:
        curves = {
            fitting._key(s): fitting.combine(st.parts(basis, s))[0] for s in (c.setup, c.reference) if s is not None
        }
        v = commissioning._value(
            c, curves[fitting._key(c.setup)], curves.get(fitting._key(c.reference)) if c.reference else None, 1.0
        )
        if c.quantity == "output_factor":
            v /= 1 + bs["per_mm_x"] * (100 - c.setup.field_x) + bs["per_mm_y"] * (100 - c.setup.field_y)
        if c.quantity == "mlc_transmission":
            continue
        m = next(m for m in ds["measurements"] if m["measurement_id"] == c.measurement_id)
        if m["kind"] in ("depth_dose", "output_factor"):
            row = next(r for r in m["points"] if r[0] == c.x)
            row[1] = v
        else:
            m["points"][0][0] = v
    ds["measurements"][-1]["points"][0][0] = 0.004 / 0.9**6
    return ds


def test_spectrum_groups_partition_the_lines() -> None:
    m = beam_models.demo_6x()
    masks = fitting.spectrum_groups(m)
    assert len(masks) == 4 and np.all(sum(x.astype(int) for x in masks) == 1)


def test_component_models_emit_one_source() -> None:
    from rtgaia_dosecalc.engines import topas

    m = beam_models.demo_6x()
    beam = water.setup_beam(m, water.Setup(100, 100, 1000))
    p = topas.source_plan(beam, fitting.primary_component(m), 10_000)
    assert p.hist_ef == [0] and p.hist_ec == [0]
    e = topas.source_plan(beam, fitting.extra_focal_component(m, 25.0), 10_000)
    assert e.hist_pr == [0] and e.hist_ef == [10_000]
    c = topas.source_plan(beam, fitting.contamination_component(m, 1.5, 80.0), 10_000)
    assert c.hist_pr == [0] and c.hist_ec == [10_000]
    # 只留一組能量：其他組的權重是 0、總和 1
    masks = fitting.spectrum_groups(m)
    g = fitting.primary_component(m, masks[0])
    w = np.asarray(g["params"]["spectrum_weights"])
    assert w.sum() == pytest.approx(1.0) and np.all(w[~masks[0]] == 0)


def test_basis_cache_is_keyed_by_the_component_parameters(fake) -> None:  # type: ignore[no-untyped-def]
    m = beam_models.demo_6x()
    basis = fitting.Basis(None, 10)
    s = water.Setup(100, 100, 1000)
    a = basis.get(fitting.primary_component(m), s)
    assert basis.get(fitting.primary_component(m), s) is a and basis.count == 1
    m2 = copy.deepcopy(m)
    m2["params"]["focal_spot_sigma_mm"] = 1.3
    assert basis.get(fitting.primary_component(m2), s) is not a and basis.count == 2


def test_fit_recovers_the_truth(fake) -> None:  # type: ignore[no-untyped-def]
    prior = beam_models.demo_6x()
    truth = _truth(prior)
    ds = _dataset(truth)
    fitted, report = fitting.fit(prior, [ds], tb=None, histories=10)
    p = fitted["params"]
    names = [(s["round"], s["name"]) for s in report["stages"]]
    seq = ["spectrum", "electron_contamination", "focal_spot", "head_scatter", "collimator_density"]
    assert names == [(r, n) for r in (1, 2) for n in seq]
    assert report["unconstrained"] == []
    last = {s["name"]: s for s in report["stages"] if s["round"] == 2}
    # 資料約束得到的：找回真值
    assert p["focal_spot_sigma_mm"] == 1.0
    assert p["extra_focal"]["sigma_mm"] == 25.0 and p["extra_focal"]["fraction"] == pytest.approx(0.1, rel=0.05)
    bs = p["monitor_backscatter"]
    assert bs["per_mm_x"] == bs["per_mm_y"] and bs["per_mm_x"] + bs["per_mm_y"] == pytest.approx(1.5e-4, rel=0.1)
    assert "b_x ＋ b_y" in last["head_scatter"]["note"]  # 只有正方形射野：只約束總和
    assert p["collimators"]["MLCX"]["density_factor"] == pytest.approx(0.9, abs=0.01)
    # 電子污染只有三個 dmax：資料約束不了平均能量與 σ（跟真的公開資料一樣）→ 只要求 dmax 在容許內
    ec = last["electron_contamination"]
    assert ec["cost_after"] < 1.0 and p["electron_contamination"]["fraction"] > 1e-4
    for s in report["stages"]:
        assert s["cost_after"] <= s["cost_before"] + 1e-9 and s["measurements"]
    assert last["focal_spot"]["measurements"] == ["of", "pen"]  # 半影 ＋ 小射野的輸出因子
    assert last["head_scatter"]["measurements"] == ["of"]
    final = fitting.finalize(fitted, prior, report, demo=True)
    assert final["model_id"] == "demo-6x-fit" and final["fit"]["datasets"] == ["synthetic"] and final["demo"] is True
    lim = final["limitations"]
    # 擬合過的成分：示範模型「沒有電子污染」「沒有反散射」那兩句拿掉，改寫擬合的說明；弱約束的段列出來
    assert not any(x.startswith("沒有電子污染的模型") or x.startswith("監測游離腔的反散射沒有模型") for x in lim)
    assert "電子污染是擬合出來的虛擬射源（只有 GPU 引擎發射）" in lim


def test_grid_alternatives_flag_weak_constraints() -> None:
    st = fitting.Stage(
        "x", {}, [], 5.0, 1.0, grid=[{"a": 1, "cost": 1.0}, {"a": 2, "cost": 1.6}, {"a": 3, "cost": 4.0}]
    )
    assert st.alternatives == [{"a": 2, "cost": 1.6}] and st.to_json()["weakly_constrained"] is True
    assert (
        fitting.Stage("y", {}, [], 1.0, 0.5, grid=[{"cost": 0.5}, {"cost": 3.0}]).to_json()["weakly_constrained"]
        is False
    )


def test_unconstrained_parameters_keep_the_prior(fake) -> None:  # type: ignore[no-untyped-def]
    prior = beam_models.demo_6x()
    ds = _dataset(_truth(prior))
    ds["measurements"] = [m for m in ds["measurements"] if m["kind"] == "output_factor"]
    fitted, report = fitting.fit(prior, [ds], tb=None, histories=10)
    # 3 cm 的輸出因子約束得到焦點（小射野）；能譜、電子污染、準直器密度沒有資料
    assert set(report["unconstrained"]) == {"spectrum", "electron_contamination", "collimator_density"}
    assert "electron_contamination" not in fitted["params"]
    assert fitted["params"]["spectrum_weights"] == pytest.approx(prior["params"]["spectrum_weights"])
    final = fitting.finalize(fitted, prior, report, demo=False)
    assert any("未約束" in x and "能譜" in x for x in final["limitations"])
    assert not any(x.startswith("示範模型") for x in final["limitations"]) and final["demo"] is False
    demo = fitting.finalize(fitted, prior, report, demo=True)["limitations"]
    assert demo[0].startswith("示範模型：擬合自") and sum(x.startswith("示範模型") for x in demo) == 1


def test_parameters_at_the_search_bounds_are_flagged() -> None:
    assert fitting._edge("f", 0.3, 0.0, 0.3) == ["f"] and fitting._edge("f", 0.0, 0.0, 0.3) == ["f"]
    assert fitting._edge("f", 0.15, 0.0, 0.3) == []
    st = fitting.Stage("head_scatter", {}, [], 2.0, 1.0, at_bounds=["extra_focal.fraction"])
    assert st.to_json()["at_bounds"] == ["extra_focal.fraction"]


def test_fff_angular_spread_needs_off_axis_profiles(fake) -> None:  # type: ignore[no-untyped-def]
    """FFF 的角分佈只在有 FWHM／unflatness／slope 時擬合；只有輸出因子 → 照先驗、列未約束（Halcyon 的教訓：只靠輸出因子
    會把角分佈推到格點邊上，臨床計畫整體高 3.6%）。"""
    prior = beam_models.demo_6xfff()
    ds = _dataset(_truth(beam_models.demo_6x()))
    ds["measurements"] = [m for m in ds["measurements"] if m["kind"] == "output_factor"]
    fitted, report = fitting.fit(prior, [ds], tb=None, histories=10)
    assert "angular_spread" in report["unconstrained"]
    assert fitted["params"]["angular_sigma_deg"] == prior["params"]["angular_sigma_deg"]
    final = fitting.finalize(fitted, prior, report, demo=True)
    assert any("FFF 角分佈" in x for x in final["limitations"])


def test_large_detector_profiles_weigh_less_in_the_fit() -> None:
    from rtgaia_dosecalc import commissioning as cm

    pen = cm.Check("p", "p", "penumbra_80_20_mm", 100.0, 5.6, None, extra={"detector_r": 3.0})
    diode = cm.Check("d", "d", "penumbra_80_20_mm", 100.0, 4.1, None, extra={"detector_r": 0.4})
    assert fitting._tol_abs(pen) == pytest.approx(math.hypot(1.0, 1.5))  # 1 mm 容許 ⊕ 0.5 × 3 mm
    assert fitting._tol_abs(diode) == pytest.approx(math.hypot(1.0, 0.2))
    of = cm.Check("o", "o", "output_factor", 30.0, 0.877, None, extra={"detector_r": 3.0})
    assert fitting._tol_abs(of) == pytest.approx(0.01 * 0.877)  # 偵檢器的項只用在側向分佈量


PROFILE_AT_10CM = {"ssd_mm": 1000.0, "depth_mm": 100.0, "axis": "x", "detector": "EDGE"}


def _user_curves(truth: dict) -> dict:  # type: ignore[type-arg]
    """使用者自家量測的形式：完整的 PDD（含建成區）、兩個射野的完整側向分佈（兩側、量測自己的正規化）、輸出因子。
    值來自「真」模型（假模擬器）。"""
    from rtgaia_dosecalc import beam_data

    raw = [
        {"kind": "depth_dose", "quantity": "pdd", "measurement_id": "pdd100",
         "conditions": {"field_mm": [100.0, 100.0], "ssd_mm": 1000.0, "normalization": "dmax", "detector": "PTW 31010"},
         "points": [[d, 1.0] for d in (3.0, 7.0, 11.0, 15.0, 20.0, 50.0, 100.0, 150.0, 200.0, 250.0)]},
        {"kind": "profile", "measurement_id": "prof100",
         "conditions": {**PROFILE_AT_10CM, "field_mm": [100.0, 100.0]},
         "points": [[x, 1.0] for x in range(-80, 81, 4)]},
        {"kind": "profile", "measurement_id": "prof300",
         "conditions": {**PROFILE_AT_10CM, "field_mm": [300.0, 300.0]},
         "points": [[x, 1.0] for x in range(-200, 201, 8)]},
        {"kind": "output_factor", "measurement_id": "of",
         "conditions": {"ssd_mm": 900.0, "depth_mm": 100.0, "reference_field_mm": [100.0, 100.0]},
         "points": [[f, 1.0] for f in (30.0, 60.0, 100.0, 200.0, 400.0)]},
    ]  # fmt: skip
    ms = [beam_data.check_measurement(m)[0] for m in raw]
    assert all(ms), [beam_data.check_measurement(m)[1] for m in raw]
    ds = {"dataset_id": "user", "measurements": ms}
    st = fitting.State(truth, np.array([1.0]), [np.ones(len(truth["params"]["spectrum_weights"]), bool)])
    basis = fitting.Basis(None, 1)
    bs = truth["params"]["monitor_backscatter"]
    checks = commissioning.plan_checks(truth, ds)
    by_id = {m["measurement_id"]: m for m in ms}
    for c in checks:
        curves = {fitting._key(s): fitting.combine(st.parts(basis, s))[0] for s in (c.setup, c.reference) if s}
        v = commissioning._value(
            c, curves[fitting._key(c.setup)], curves.get(fitting._key(c.reference)) if c.reference else None, 1.0
        )
        if c.quantity == "output_factor":
            v /= 1 + bs["per_mm_x"] * (100 - c.setup.field_x) + bs["per_mm_y"] * (100 - c.setup.field_y)
        row = next(r for r in by_id[c.measurement_id]["points"] if r[0] == c.x)
        row[1] = v
    return ds


def test_user_full_curves_drive_the_fit(fake) -> None:  # type: ignore[no-untyped-def]
    """使用者的完整曲線：每一點都比得到（側向分佈以中心軸正規化），建成區的 PDD 進電子污染那段、小射野的側向分佈
    進焦點那段、大射野的進機頭散射那段；擬合後焦點找回真值、每段成本下降。"""
    prior = beam_models.demo_6x()
    truth = _truth(prior)
    ds = _user_curves(truth)
    checks = commissioning.plan_checks(prior, ds)
    prof = [c for c in checks if c.quantity == "profile"]
    assert len(prof) == 41 + 51 and not any(c.unsupported for c in checks)
    assert all(c.extra["detector_r"] == 0.4 for c in prof)
    fitted, report = fitting.fit(prior, [ds], tb=None, histories=10)
    last = {s["name"]: s for s in report["stages"] if s["round"] == 2}
    assert "pdd100" in last["electron_contamination"]["measurements"]  # 建成區的點
    assert "prof100" in last["focal_spot"]["measurements"] and "prof300" not in last["focal_spot"]["measurements"]
    assert "prof300" in last["head_scatter"]["measurements"]
    assert fitted["params"]["focal_spot_sigma_mm"] == 1.0
    assert fitted["params"]["extra_focal"]["fraction"] == pytest.approx(0.1, rel=0.2)
    for s in report["stages"]:
        assert s["cost_after"] <= s["cost_before"] + 1e-9


def test_curve_points_use_a_composite_tolerance() -> None:
    # 1 個百分點 ⊕ 梯度 × 1 mm：平坦處 1 個百分點、陡的地方（例如 10 %/mm）約 10 個百分點
    assert commissioning.tolerance("pdd", 66.0, 0.0) == pytest.approx(1.0)
    assert commissioning.tolerance("profile", 50.0, 10.0) == pytest.approx(math.hypot(1.0, 10.0))
    assert commissioning.tolerance("output_factor", 0.8, 5.0) == pytest.approx(0.008)  # 不是曲線點
