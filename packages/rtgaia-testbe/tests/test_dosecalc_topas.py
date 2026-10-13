"""OpenTOPAS 引擎（真的 Monte Carlo；要 docker、映像與 Geant4 物理資料 —— 沒有就整檔略過，CI 也是）。

驗的是**整條鏈**有沒有接對，不是射束模型準不準（示範模型不代表實機）：
* MU 校正自洽：10 × 10、SSD 100、水中 dmax 的劑量 ≈ 1 cGy／MU（校正用的就是這個條件）
* 深度劑量：dmax 在 1–2.5 cm、10 cm 深處約 dmax 的 60–72%（6 MV 典型值）
* 射野邊緣：10 cm 深處的 50% 在幾何投影 ±55 mm（±1 個 5 mm 體素）
* 方向：機架 0° 從前（−y）、90° 從病人左（+x）；X1 −50、X2 0 只照病人右（−x）；Y1 −50、Y2 0 只照下方（−z）
* 不確定度：總和的 1σ 由 TOPAS 的每歷史標準差 × √N 換算，數量級對
* 計畫：合成 6X 計畫（MLC 圓、VMAT 61 個控制點）每個射束的 50% 範圍跟幾何測試引擎重疊 ≥ 0.8
* 錐角：MU 換算跟發射錐角大小無關；沒有 jaw 的雙層 MLC，MLC 總寬度外面由固定的主準直器擋住
* 動態：機架在轉、jaw 又在動時，動態算一次 ＝ 逐步靜態加總

跑法：`uv run pytest packages/rtgaia-testbe/tests/test_dosecalc_topas.py`（約 6 分鐘，24 核）。
"""

from __future__ import annotations

from pathlib import Path

import numpy as np
import pytest
from rtgaia_dosecalc import beam_models, phantoms
from rtgaia_dosecalc.ct_calibration import builtin_calibration
from rtgaia_dosecalc.delivery import Beam, ControlPoint, Delivery
from rtgaia_dosecalc.engines import pipeline_test, topas
from rtgaia_dosecalc.from_rtplan import read_delivery
from rtgaia_dosecalc.package import CalcInput
from rtgaia_geom import Grid
from rtgaia_testbe.fixtures import synth_plan

_STATUS = topas.status()
pytestmark = pytest.mark.skipif(not _STATUS["ready"], reason=f"OpenTOPAS 不能用：{_STATUS.get('reason')}")

WATER = {
    "calibration_id": "water",
    "name": "water",
    "demo": False,
    "density": {"type": "points", "points": [[-1000, 0.0012], [0, 1.0], [3000, 2.8]]},
    "materials": {"type": "schneider2000"},
}
GRID5 = Grid(
    size=(60, 60, 60),
    spacing=(5.0,) * 3,
    origin=(-147.5,) * 3,
    direction=(1, 0, 0, 0, 1, 0, 0, 0, 1),
    frame_of_reference_uid="w",
)


def _water_beam(gantry: float, jaw_x: tuple[float, float] = (-50.0, 50.0)) -> Beam:
    iso = {0.0: (0.0, -150.0, 0.0), 90.0: (150.0, 0.0, 0.0)}[gantry]  # 等中心在水面（SSD ＝ SAD）
    cps = [
        ControlPoint(0.0, gantry, 0.0, 0.0, jaw_x, (-50.0, 50.0)),
        ControlPoint(100.0, gantry, 0.0, 0.0, jaw_x, (-50.0, 50.0)),
    ]
    return Beam(1, "B", 6.0, "STANDARD", 1000.0, iso, "HFS", 100.0, cps)


def _water(tmp: Path, beam: Beam, histories: int) -> np.ndarray:
    hu, g = phantoms.water_box((300.0, 300.0, 300.0), 5.0, air_margin_mm=20.0)
    grid = Grid(
        size=GRID5.size,
        spacing=GRID5.spacing,
        origin=GRID5.origin,
        direction=GRID5.direction,
        frame_of_reference_uid=g.frame_of_reference_uid,
    )
    inp = CalcInput(
        engine="topas", delivery=Delivery([beam], fractions=1), ct_hu=hu, ct_grid=g, dose_grid=grid,
        calibration=WATER, beam_model=beam_models.demo_6x(), options={"histories": histories},
    )  # fmt: skip
    out = tmp / "job" / "out"
    out.mkdir(parents=True, exist_ok=True)
    res = topas.run(inp, out, lambda *_a: None)
    assert res.info["engine"] == "topas" and res.info["histories_per_mu"] > 0
    return res.dose_gy, res.uncertainty


@pytest.fixture(scope="module")
def ap(tmp_path_factory):  # type: ignore[no-untyped-def]
    return _water(tmp_path_factory.mktemp("topas-ap"), _water_beam(0.0), 4_000_000)


def test_mu_calibration_and_depth_dose(ap) -> None:  # type: ignore[no-untyped-def]
    dose, unc = ap
    axis = dose[29:31, :, 29:31].mean(axis=(0, 2))  # 中心 1 × 1 cm²、沿深度（j；表面在 y ＝ −150）
    smooth = np.convolve(axis, np.ones(3) / 3, mode="same")
    j = int(np.argmax(smooth[1:-1])) + 1
    depth = 2.5 + 5 * j
    assert 10 <= depth <= 25, f"dmax {depth} mm"
    assert smooth[j] == pytest.approx(1.0, rel=0.06), "100 MU、SSD 100、10 × 10 的 dmax ≈ 1 Gy"
    assert 0.60 <= axis[20] / smooth[j] <= 0.72, f"PDD(10 cm) {axis[20] / smooth[j]:.3f}"
    u = unc[29:31, 2:8, 29:31]
    assert np.all(np.isfinite(u)) and 0.005 < float(np.median(u)) < 0.2


def test_dose_does_not_depend_on_the_emission_cone(tmp_path: Path, monkeypatch, ap) -> None:  # type: ignore[no-untyped-def]
    """同一個 10 × 10 射野，MU 校正用預設的錐角、射束的錐角邊界從 10 mm 放到 60 mm（多出來的粒子打在 jaw 上）
    → dmax 劑量不變。以前每個歷史的通量跟錐角大小成反比、MU 換算卻沒有扣回來 —— 科部的 Halcyon 計畫因此只算出一半。"""
    default = beam_models.demo_6x()
    hpm = topas.calibration(default, tmp_path / "calibration")
    monkeypatch.setattr(topas, "calibration", lambda *_a, **_k: hpm)
    wide = beam_models.demo_6x()
    wide["params"]["field_margin_mm"] = 60.0
    monkeypatch.setattr(beam_models, "demo_6x", lambda: wide)
    dose, _ = _water(tmp_path, _water_beam(0.0), 4_000_000)
    axis = dose[29:31, :, 29:31].mean(axis=(0, 2))
    smooth = np.convolve(axis, np.ones(3) / 3, mode="same")
    assert smooth[1:8].max() == pytest.approx(1.0, rel=0.06)


def test_field_edges(ap) -> None:  # type: ignore[no-untyped-def]
    dose, _ = ap
    prof = dose[29:31, 20, :].mean(axis=0)  # 深度 102.5 mm、沿 x
    x = -147.5 + 5 * np.arange(60)
    half = prof[29:31].mean() / 2
    right = x[30:][np.argmax(prof[30:] < half)]
    left = x[:30][::-1][np.argmax(prof[:30][::-1] < half)]
    assert abs(right - 55) <= 5 and abs(left + 55) <= 5, (left, right)
    assert prof[np.abs(x) > 80].max() < 0.1 * prof.max(), "開口外只剩散射與穿透"


def test_gantry_90_enters_from_patient_left(tmp_path: Path) -> None:
    dose, _ = _water(tmp_path, _water_beam(90.0), 1_000_000)
    prof = dose[29:31, 29:31, :].mean(axis=(0, 1))
    assert prof[45:55].mean() > 1.5 * prof[5:15].mean(), "+x（病人左）的劑量比 −x 高"


def test_asymmetric_jaw_opens_patient_right(tmp_path: Path) -> None:
    dose, _ = _water(tmp_path, _water_beam(0.0, (-50.0, 0.0)), 1_000_000)
    row = dose[29:31, 10, :].mean(axis=0)
    x = -147.5 + 5 * np.arange(60)
    assert row[(x > -40) & (x < -10)].mean() > 10 * row[(x > 15) & (x < 45)].mean()


def test_asymmetric_y_jaw_opens_patient_inferior(tmp_path: Path) -> None:
    """Y1 −50、Y2 0：HFS、機架 0° 時 BLD −y ＝ 病人下方（−z）。"""
    beam = _water_beam(0.0)
    beam.control_points = [
        ControlPoint(cp.cumulative_mu, 0.0, 0.0, 0.0, (-50.0, 50.0), (-50.0, 0.0)) for cp in beam.control_points
    ]
    dose, _ = _water(tmp_path, beam, 1_000_000)
    col = dose[:, 10, 29:31].mean(axis=1)
    z = -147.5 + 5 * np.arange(60)
    assert col[(z > -40) & (z < -10)].mean() > 10 * col[(z > 15) & (z < 45)].mean()


def test_synth_plan_field_shapes_match_geometry(tmp_path: Path) -> None:
    case = synth_plan.build(tmp_path / "case")
    d, problems = read_delivery(next((case.root / "RP").glob("*.dcm")))
    assert d is not None, problems
    geom = synth_plan.GEOM
    ct = np.stack([synth_plan._hu(k) for k in range(geom.size[2])]).astype(np.float32)
    ct_grid = Grid(
        size=geom.size,
        spacing=geom.spacing,
        origin=geom.origin,
        direction=(1, 0, 0, 0, 1, 0, 0, 0, 1),
        frame_of_reference_uid="x",
    )
    dose_grid = Grid(
        size=(64, 48, 36),
        spacing=(5.0,) * 3,
        origin=(-157.5, -117.5, -87.5),
        direction=(1, 0, 0, 0, 1, 0, 0, 0, 1),
        frame_of_reference_uid="x",
    )
    inp = CalcInput(
        engine="topas", delivery=d, ct_hu=ct, ct_grid=ct_grid, dose_grid=dose_grid, calibration=builtin_calibration(),
        beam_model=beam_models.demo_6x(), options={"histories": 4_000_000},
    )  # fmt: skip
    mc = topas.run(inp, tmp_path / "job" / "out", lambda *_a: None)
    geo = pipeline_test.run(inp, tmp_path, lambda *_a: None)
    for n in (1, 2, 3):
        a, b = np.nan_to_num(mc.per_beam_gy[n]), geo.per_beam_gy[n]  # 空氣裡 MC 不報劑量（NaN）
        ma, mb = a > 0.5 * np.percentile(a, 99.5), b > 0.5 * np.percentile(b, 99.5)
        dice = 2 * (ma & mb).sum() / (ma.sum() + mb.sum())
        assert dice >= 0.8, f"射束 {n} 的 50% 範圍重疊 {dice:.2f}"
    assert np.allclose(mc.dose_gy, sum(mc.per_beam_gy.values()), rtol=1e-5, equal_nan=True)
    assert mc.info["air_voxels"] > 0 and np.isnan(mc.dose_gy[0, 0, 0]), "角落是空氣：不報劑量"
    assert mc.info["unscored_mev"] < 1e-3, "沒計到分的能量應該可以忽略"


def test_dual_layer_blocks_outside_the_mlc(tmp_path: Path) -> None:
    """沒有 jaw 的雙層 MLC：細長射野（x ± 20、y ± 130）的發射錐角是外接橢圓，沿 y 會超出 MLC 的總寬度（± 145）——
    那裡要靠固定的主準直器擋。以前沒有模型，這段粒子直接打進病人：科部的 Halcyon 計畫在射野兩端多算了 40–60%。"""
    hu, g = phantoms.water_box((200.0, 200.0, 440.0), 5.0, air_margin_mm=20.0)
    b1 = [float(v) for v in range(-140, 141, 10)]
    b2 = [float(v) for v in range(-145, 146, 10)]

    def bank(bounds: list[float]) -> tuple[list[float], list[float]]:
        rows = [(lo + hi) / 2 for lo, hi in zip(bounds, bounds[1:], strict=False)]
        return [-20.0 if abs(c) < 130 else 0.0 for c in rows], [20.0 if abs(c) < 130 else 0.0 for c in rows]

    a1, c1 = bank(b1)
    a2, c2 = bank(b2)
    cps = [
        ControlPoint(0.0, 0.0, 0.0, 0.0, (-140.0, 140.0), (-140.0, 140.0), a1, c1, a2, c2),
        ControlPoint(100.0, 0.0, 0.0, 0.0, (-140.0, 140.0), (-140.0, 140.0), a1, c1, a2, c2),
    ]
    beam = Beam(
        1, "LONG", 6.0, "FFF", 1000.0, (0.0, -100.0, 0.0), "HFS", 100.0, cps,
        leaf_boundaries_mm=b1, mlc_devices=["MLCX1", "MLCX2"], leaf2_boundaries_mm=b2,
    )  # fmt: skip
    inp = CalcInput(
        engine="topas", delivery=Delivery([beam], fractions=1), ct_hu=hu, ct_grid=g, dose_grid=g,
        calibration=WATER, beam_model=beam_models.demo_6xfff_dual(), options={"histories": 2_000_000},
    )  # fmt: skip
    res = topas.run(inp, tmp_path / "job" / "out", lambda *_a: None)
    dose = np.nan_to_num(res.dose_gy)
    z = np.asarray(g.origin[2]) + 5.0 * np.arange(g.size[2])
    i0 = g.size[0] // 2
    depth = int(round((-100.0 + 50.0 - g.origin[1]) / 5.0))  # 水下 5 cm
    prof = dose[:, depth - 1 : depth + 2, i0 - 1 : i0 + 1].mean(axis=(1, 2))
    inside, outside = prof[np.abs(z) < 100].mean(), prof[(np.abs(z) > 165) & (np.abs(z) < 195)].mean()
    assert outside < 0.05 * inside, f"MLC 範圍外 {outside:.3f} Gy，射野內 {inside:.3f} Gy"


def test_jaws_follow_the_gantry_while_they_move(tmp_path: Path) -> None:
    """機架在轉、jaw 又在動（jaw tracking）：動態算一次 ＝ 每一小段拆成靜態射野分開算再加總。
    以前用 TOPAS 的 TsJaws：開口一變就整個重建、重建時用射束頭上一步的旋轉 → jaw 落在錯的位置，
    PROTEAS 的 SRS 計畫只算出 TPS 的 1/4（同一段動態對靜態 0.41）。"""
    import dataclasses

    hu, g = phantoms.water_box((200.0, 200.0, 200.0), 5.0, air_margin_mm=10.0)
    jaws = [((-30.0, -5.0), (-20.0, 10.0)), ((-20.0, 5.0), (-10.0, 20.0)), ((-10.0, 15.0), (0.0, 30.0))]
    cps = [ControlPoint(50.0 * i, 170.0 + 10.0 * i, 0.0, 0.0, jx, jy) for i, (jx, jy) in enumerate(jaws)]
    beam = Beam(1, "JT", 6.0, "STANDARD", 1000.0, (0.0, 0.0, 0.0), "HFS", 100.0, cps)

    def dose(b: Beam, tag: str, histories: int) -> np.ndarray:
        inp = CalcInput(
            engine="topas", delivery=Delivery([b], fractions=1), ct_hu=hu, ct_grid=g, dose_grid=g,
            calibration=WATER, beam_model=beam_models.demo_6x(), options={"histories": histories},
        )  # fmt: skip
        return np.nan_to_num(topas.run(inp, tmp_path / tag / "job" / "out", lambda *_a: None).dose_gy)

    dynamic = dose(beam, "dynamic", 1_500_000)
    states = topas._states(beam)
    static = np.zeros_like(dynamic)
    for n, (cp, mu) in enumerate(states):
        cps_n = [dataclasses.replace(cp, cumulative_mu=0.0), dataclasses.replace(cp, cumulative_mu=mu)]
        static += dose(dataclasses.replace(beam, control_points=cps_n, mu=mu), f"s{n}", 300_000)
    assert len(states) == 10
    assert dynamic.sum() == pytest.approx(static.sum(), rel=0.05), "動態跟逐步靜態的總劑量一樣"
    hot = static > 0.5 * static.max()
    assert float(np.median(dynamic[hot] / static[hot])) == pytest.approx(1.0, abs=0.08)
