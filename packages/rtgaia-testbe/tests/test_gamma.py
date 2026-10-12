"""3D gamma：解析解（均勻偏差、線性梯度平移）、門檻、局部正規化、不同網格、沒資料、提早停止不改結果。"""

from __future__ import annotations

import numpy as np
import pytest
from rtgaia_core import gamma as gm
from rtgaia_geom import Grid


def _grid(
    size=(30, 20, 16), spacing=(1.0, 1.0, 1.0), origin=(0.0, 0.0, 0.0), direction=(1, 0, 0, 0, 1, 0, 0, 0, 1)
) -> Grid:
    return Grid(size=size, spacing=spacing, origin=origin, direction=direction, frame_of_reference_uid="1.2.3")


def _world_x(g: Grid) -> np.ndarray:
    ni, nj, nk = g.size
    kk, jj, ii = np.meshgrid(np.arange(nk), np.arange(nj), np.arange(ni), indexing="ij")
    ijk = np.stack([ii.ravel(), jj.ravel(), kk.ravel()], axis=1).astype(np.float64)
    return g.index_to_world(ijk)[:, 0].reshape(nk, nj, ni)


def _interior(g: Grid, margin: int = 6) -> tuple[slice, slice, slice]:
    ni, nj, nk = g.size
    return slice(margin, nk - margin), slice(margin, nj - margin), slice(margin, ni - margin)


def test_identical_is_zero_and_all_pass() -> None:
    g = _grid()
    ref = (2.0 + 0.1 * _world_x(g)).astype(np.float32)
    r = gm.gamma_3d(ref, g, ref, g, np.eye(4), gm.GammaCriteria())
    assert r.stats["pass_rate"] == 1.0
    assert np.nanmax(r.gamma_kji) == 0.0
    assert r.stats["failures"]["count"] == 0


def test_uniform_offset_matches_dose_term() -> None:
    """平坦場整片高 2%（全域 3%）→ 移動沒有幫助，γ ＝ 2／3。"""
    g = _grid()
    ref = np.full((16, 20, 30), 2.0, dtype=np.float32)
    ev = ref * 1.02
    r = gm.gamma_3d(ref, g, ev, g, np.eye(4), gm.GammaCriteria(dose_pct=3, dta_mm=2))
    assert np.allclose(r.gamma_kji[_interior(g)], 2 / 3, atol=1e-5)
    # 高 4% → γ ＝ 4／3，失敗、而且全在平坦區、偏高
    r2 = gm.gamma_3d(ref, g, ref * 1.04, g, np.eye(4), gm.GammaCriteria(dose_pct=3, dta_mm=2))
    f = r2.stats["failures"]
    assert r2.stats["pass_rate"] == 0.0
    assert f["count"] == f["flat"] == f["flat_hot"] == r2.stats["evaluated"]
    assert f["high_gradient"] == 0


@pytest.mark.parametrize("shift_mm", [0.5, 1.0, 2.0])
@pytest.mark.parametrize("resolution", [5, 10])
def test_shifted_ramp_matches_analytic(shift_mm: float, resolution: int) -> None:
    """D(x) ＝ a + s·x，E(x) ＝ D(x − δ)。1D 的解析解：γ² ＝ δ² ／ (DTA² + ΔD²／s²)。
    格點化只會高估，上限 1／(2·resolution)。"""
    g = _grid()
    slope = 0.2  # Gy/mm
    x = _world_x(g)
    ref = (1.0 + slope * x).astype(np.float32)
    ev = (1.0 + slope * (x - shift_mm)).astype(np.float32)
    c = gm.GammaCriteria(dose_pct=3, dta_mm=2, threshold_pct=0, norm_gy=10.0, resolution=resolution)
    dd = 0.03 * 10.0
    expected = shift_mm / np.sqrt(c.dta_mm**2 + (dd / slope) ** 2)
    got = gm.gamma_3d(ref, g, ev, g, np.eye(4), c).gamma_kji[_interior(g)]
    assert got.min() >= expected - 1e-4, "格點化的搜尋不能低估"
    assert got.max() <= expected + 1 / (2 * resolution) + 1e-6


def test_ramp_on_different_rotated_grid() -> None:
    """被評估劑量在另一個網格（間距 2.5 mm、繞 z 轉 90°）—— 線性場三線性內插是精確的，結果不變。"""
    g = _grid()
    slope = 0.2
    ref = (1.0 + slope * _world_x(g)).astype(np.float32)
    # 繞 z 90°：i 軸 → +y、j 軸 → −x；包住參考網格
    ge = Grid(
        size=(16, 16, 10),
        spacing=(2.5, 2.5, 2.5),
        origin=(35.0, -5.0, -5.0),
        direction=(0, -1, 0, 1, 0, 0, 0, 0, 1),
        frame_of_reference_uid="1.2.3",
    )
    ev = (1.0 + slope * (_world_x(ge) - 1.0)).astype(np.float32)
    c = gm.GammaCriteria(dose_pct=3, dta_mm=2, threshold_pct=0, norm_gy=10.0, resolution=10)
    expected = 1.0 / np.sqrt(4 + (0.3 / slope) ** 2)
    got = gm.gamma_3d(ref, g, ev, ge, np.eye(4), c).gamma_kji[_interior(g)]
    assert np.all(np.isfinite(got))
    assert got.min() >= expected - 1e-4 and got.max() <= expected + 0.05 + 1e-6


def test_rigid_eval_to_ref_transform() -> None:
    """E 在另一個空間（世界座標差 +3 mm）：經 eval_to_ref 換回來就是同一個場 → γ ＝ 0。"""
    g = _grid()
    ref = (1.0 + 0.2 * _world_x(g)).astype(np.float32)
    ge = Grid(
        size=g.size, spacing=g.spacing, origin=(3.0, 0.0, 0.0), direction=g.direction, frame_of_reference_uid="9.9"
    )
    ev = (1.0 + 0.2 * (_world_x(ge) - 3.0)).astype(np.float32)  # eval 世界 x' ＝ ref x ＋ 3
    m = np.eye(4)
    m[0, 3] = -3.0  # eval world → ref world
    got = gm.gamma_3d(ref, g, ev, ge, m, gm.GammaCriteria(threshold_pct=0, norm_gy=10.0))
    inner = got.gamma_kji[:, :, 4:-4]
    assert np.nanmax(inner) < 1e-4


def test_threshold_excludes_low_dose() -> None:
    g = _grid()
    ref = np.full((16, 20, 30), 10.0, dtype=np.float32)
    ref[:, :, :10] = 0.5  # 5% 的最大值
    r = gm.gamma_3d(ref, g, ref, g, np.eye(4), gm.GammaCriteria(threshold_pct=10))
    assert np.isnan(r.gamma_kji[:, :, :10]).all()
    assert r.stats["candidates"] == 16 * 20 * 20


def test_local_normalization_uses_point_dose() -> None:
    """局部：ΔD ＝ 3% × R(r) → 整片高 2% 不論劑量高低都是 2／3；全域時低劑量區更小。"""
    g = _grid()
    ref = np.full((16, 20, 30), 10.0, dtype=np.float32)
    ref[:, :, :15] = 5.0
    ev = ref * 1.02
    loc = gm.gamma_3d(ref, g, ev, g, np.eye(4), gm.GammaCriteria(normalization="local", threshold_pct=0))
    assert np.allclose(loc.gamma_kji[3:-3, 3:-3, 3:9], 2 / 3, atol=1e-5)
    assert np.allclose(loc.gamma_kji[3:-3, 3:-3, 21:27], 2 / 3, atol=1e-5)
    glo = gm.gamma_3d(ref, g, ev, g, np.eye(4), gm.GammaCriteria(normalization="global", threshold_pct=0))
    assert np.allclose(glo.gamma_kji[3:-3, 3:-3, 3:9], 0.1 / 0.3, atol=1e-5)


def test_no_data_is_not_failure() -> None:
    """E 在一半的範圍是 NaN（沒資料）→ 那些點不評估、計入 no_data，不算失敗。"""
    g = _grid()
    ref = np.full((16, 20, 30), 2.0, dtype=np.float32)
    ev = ref.copy()
    ev[:, :, 15:] = np.nan
    r = gm.gamma_3d(ref, g, ev, g, np.eye(4), gm.GammaCriteria(threshold_pct=0))
    assert r.stats["pass_rate"] == 1.0
    assert r.stats["no_data"] > 0
    assert np.isnan(r.gamma_kji[:, :, 25:]).all()


def test_cap_at_max_gamma() -> None:
    g = _grid()
    ref = np.full((16, 20, 30), 2.0, dtype=np.float32)
    r = gm.gamma_3d(ref, g, ref * 1.5, g, np.eye(4), gm.GammaCriteria(max_gamma=2))
    assert np.nanmax(r.gamma_kji) == pytest.approx(2.0)
    assert r.stats["capped"] == r.stats["evaluated"]


def test_early_stop_equals_exhaustive_and_refinement_only_lowers(monkeypatch) -> None:  # type: ignore[no-untyped-def]
    """不細找時，提早停止的結果跟「全部格點都搜」一樣；細找只會更低（更接近連續的最小值），不會更高。"""
    rng = np.random.default_rng(0)
    g = _grid(size=(14, 12, 10))
    ref = rng.uniform(1.0, 3.0, size=(10, 12, 14)).astype(np.float32)
    ev = (ref + rng.normal(0, 0.08, size=ref.shape)).astype(np.float32)
    c = gm.GammaCriteria(threshold_pct=0, resolution=3)
    refined = gm.gamma_3d(ref, g, ev, g, np.eye(4), c).gamma_kji
    monkeypatch.setattr(gm, "REFINE_ROUNDS", 0)
    fast = gm.gamma_3d(ref, g, ev, g, np.eye(4), c).gamma_kji
    from scipy.ndimage import map_coordinates

    offs = gm.search_offsets_mm(c)
    kk, jj, ii = np.nonzero(np.ones_like(ref, bool))
    norm = float(ref.max())
    best = np.full(kk.size, np.inf)
    for o in offs:
        e = map_coordinates(
            ev, [kk + o[2], jj + o[1], ii + o[0]], order=1, mode="constant", cval=np.nan, prefilter=False
        )
        g2 = (np.linalg.norm(o) / c.dta_mm) ** 2 + (e - ref[kk, jj, ii]) ** 2 / (0.03 * norm) ** 2
        best = np.fmin(best, g2)
    slow = np.sqrt(np.minimum(best, c.max_gamma**2)).reshape(ref.shape)
    assert np.allclose(fast, slow, atol=1e-5)
    assert np.all(refined <= slow + 1e-6)
    assert (refined < slow - 1e-3).mean() > 0.3, "雜訊場裡細找應該常常找到更好的點"


def test_high_gradient_failure_classified() -> None:
    """陡梯度（1 Gy/mm、ΔD 0.3 Gy）平移 4 mm → 失敗、而且算在高梯度區。"""
    g = _grid()
    x = _world_x(g)
    ref = (5.0 + 1.0 * x).astype(np.float32)
    ev = (5.0 + 1.0 * (x - 4.0)).astype(np.float32)
    r = gm.gamma_3d(ref, g, ev, g, np.eye(4), gm.GammaCriteria(threshold_pct=0, norm_gy=10.0))
    f = r.stats["failures"]
    assert f["count"] > 0 and f["high_gradient"] == f["count"]


def test_check_criteria_rejects_bad_input() -> None:
    assert gm.check_criteria({})[0] == gm.GammaCriteria()
    assert gm.check_criteria({"dose_pct": 0})[1]
    assert gm.check_criteria({"dta_mm": "2"})[1]
    assert gm.check_criteria({"normalization": "x"})[1]
    assert gm.check_criteria({"resolution": 4})[1]
    assert gm.check_criteria({"max_gamma": 3, "resolution": 10, "dta_mm": 2})[1], "搜尋格點太多"
    assert gm.check_criteria({"norm_gy": -1})[1]
