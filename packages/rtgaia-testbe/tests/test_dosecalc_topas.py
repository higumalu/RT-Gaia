"""OpenTOPAS 引擎（真的 Monte Carlo；要 docker、映像與 Geant4 物理資料 —— 沒有就整檔略過，CI 也是）。

驗的是**整條鏈**有沒有接對，不是射束模型準不準（示範模型不代表實機）：
* MU 校正自洽：10 × 10、SSD 100、水中 dmax 的劑量 ≈ 1 cGy／MU（校正用的就是這個條件）
* 深度劑量：dmax 在 1–2.5 cm、10 cm 深處約 dmax 的 60–72%（6 MV 典型值）
* 射野邊緣：10 cm 深處的 50% 在幾何投影 ±55 mm（±1 個 5 mm 體素）
* 方向：機架 0° 從前（−y）、90° 從病人左（+x）；X1 −50、X2 0 只照病人右（−x）
* 不確定度：總和的 1σ 由 TOPAS 的每歷史標準差 × √N 換算，數量級對
* 計畫：合成 6X 計畫（MLC 圓、VMAT 61 個控制點）每個射束的 50% 範圍跟幾何測試引擎重疊 ≥ 0.8

跑法：`uv run pytest packages/rtgaia-testbe/tests/test_dosecalc_topas.py`（約 4 分鐘，24 核）。
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
