"""DVH：純 numpy 的解析驗證、跨 FoR 一致性、合成病例經 HTTP。"""

from __future__ import annotations

import sys
from pathlib import Path

import numpy as np
import pytest
from rtgaia_core.dvh import DvhTarget, compute_dvh, cumulative_dvh, trilinear_sample
from rtgaia_geom import Grid, rigid_matrix
from rtgaia_testbe.driver import Session

sys.path.insert(0, str(Path(__file__).parent))
from synth_dicom import SynthCase, write_synth_case  # noqa: E402

FOR_A = "1.2.3.A"
FOR_B = "1.2.3.B"


def _grid(size, spacing, origin, for_uid=FOR_A) -> Grid:
    return Grid(
        size=size, spacing=spacing, origin=origin, direction=(1, 0, 0, 0, 1, 0, 0, 0, 1), frame_of_reference_uid=for_uid
    )


def _sphere_target(grid: Grid, center_world, radius_mm, *, to_primary=None, sid="ptv") -> DvhTarget:
    nx, ny, nz = grid.size
    ii, jj, kk = np.meshgrid(np.arange(nx), np.arange(ny), np.arange(nz), indexing="ij")
    world = grid.index_to_world(np.stack([ii.ravel(), jj.ravel(), kk.ravel()], axis=1))
    inside = np.linalg.norm(world - np.asarray(center_world), axis=1) <= radius_mm
    block = inside.reshape(nx, ny, nz).transpose(2, 1, 0).astype(np.uint8)  # (k, j, i)
    return DvhTarget(
        structure_id=sid,
        name=sid.upper(),
        color_rgb=(255, 0, 0),
        block=block,
        offset_ijk=(0, 0, 0),
        grid=grid,
        to_primary=np.eye(4) if to_primary is None else to_primary,
    )


def _gaussian_dose(grid: Grid, center_world, sigma_mm, peak_gy) -> np.ndarray:
    nx, ny, nz = grid.size
    ii, jj, kk = np.meshgrid(np.arange(nx), np.arange(ny), np.arange(nz), indexing="ij")
    world = grid.index_to_world(np.stack([ii.ravel(), jj.ravel(), kk.ravel()], axis=1))
    r2 = ((world - np.asarray(center_world)) ** 2).sum(axis=1)
    dose = peak_gy * np.exp(-r2 / (2 * sigma_mm**2))
    return dose.reshape(nx, ny, nz).transpose(2, 1, 0).astype(np.float32)


def test_trilinear_sample_exact_at_voxel_centers_and_linear_between() -> None:
    vol = np.arange(2 * 2 * 2, dtype=np.float32).reshape(2, 2, 2)  # (k,j,i): v = 4k + 2j + i
    vals, inside = trilinear_sample(vol, np.array([[1.0, 0.0, 0.0], [0.5, 0.0, 0.0], [0.5, 0.5, 0.5], [3.0, 0, 0]]))
    assert vals[0] == 1.0 and vals[1] == 0.5 and vals[2] == 3.5
    assert inside.tolist() == [True, True, True, False] and vals[3] == 0.0


def test_cumulative_dvh_is_percent_volume_at_or_above_edge() -> None:
    d = np.array([1.0, 2.0, 3.0, 4.0])
    cum = cumulative_dvh(d, np.array([0.0, 1.0, 2.5, 4.0, 5.0]))
    assert cum.tolist() == [100.0, 100.0, 50.0, 25.0, 0.0]


def test_sphere_in_gaussian_dose_matches_analytic_bounds() -> None:
    """半徑 r 的球在 σ 的高斯劑量裡：Dmax ≈ peak、Dmin ≈ peak·exp(−r²/2σ²)、體積 ≈ 4/3πr³。"""
    grid = _grid((41, 41, 41), (1.0, 1.0, 1.0), (-20.0, -20.0, -20.0))
    center = (0.0, 0.0, 0.0)
    dose = _gaussian_dose(grid, center, sigma_mm=10.0, peak_gy=50.0)
    target = _sphere_target(grid, center, radius_mm=8.0)
    out = compute_dvh(
        dose_kji=dose, dose_grid=grid, dose_to_primary=np.eye(4), targets=[target], bins=100, reference_gy=45.0
    )
    s = out["structures"][0]
    assert abs(s["dmax_gy"] - 50.0) < 0.5
    expected_min = 50.0 * np.exp(-(8.0**2) / (2 * 10.0**2))
    assert abs(s["dmin_gy"] - expected_min) < 1.0
    assert abs(s["volume_cc"] - (4 / 3) * np.pi * 8.0**3 / 1000.0) / ((4 / 3) * np.pi * 8.0**3 / 1000.0) < 0.05
    assert s["outside_fraction"] == 0.0
    cum = s["cumulative_pct"]
    assert cum[0] == 100.0 and cum[-1] <= 1.0 and all(a >= b for a, b in zip(cum, cum[1:], strict=False))
    # V(45 Gy)：exp(−r²/200) ≥ 0.9 → r ≤ 4.59 mm → 體積比 (4.59/8)³ ≈ 0.189
    assert abs(s["v_ref_pct"] / 100.0 - (4.59 / 8.0) ** 3) < 0.03
    assert s["d95_gy"] <= s["d50_gy"] <= s["d2_gy"] <= s["dmax_gy"]


def test_cross_for_dvh_equals_aligned_when_frame_groups_are_right() -> None:
    """🔴 劑量在另一個 FoR（網格被搬走 ＋ 轉了 7°）而 FrameGroup 帶著同一個變換 → DVH 與對齊時相同。
    變換方向錯（用了逆）的症狀是 Dmax 掉一大截。"""
    grid_a = _grid((41, 41, 41), (1.0, 1.0, 1.0), (-20.0, -20.0, -20.0), FOR_A)
    center = (0.0, 0.0, 0.0)
    target = _sphere_target(grid_a, center, radius_mm=8.0)
    dose_a = _gaussian_dose(grid_a, center, sigma_mm=10.0, peak_gy=50.0)
    ref = compute_dvh(dose_kji=dose_a, dose_grid=grid_a, dose_to_primary=np.eye(4), targets=[target], bins=50)[
        "structures"
    ][0]

    # B FoR：B → primary 的變換 T；劑量網格在 B 座標裡描述同一個物理劑量 ⇒ 網格座標 = T⁻¹(world)
    t = rigid_matrix(translation_mm=(30.0, -12.0, 5.0), rotation_deg=(0, 0, 7))
    t_inv = np.linalg.inv(t)
    origin_b = (t_inv @ np.array([-20.0, -20.0, -20.0, 1.0]))[:3]
    grid_b = Grid(
        size=(41, 41, 41),
        spacing=(1.0, 1.0, 1.0),
        origin=tuple(origin_b.tolist()),
        direction=tuple(t_inv[:3, :3].flatten().tolist()),
        frame_of_reference_uid=FOR_B,
    )
    # 同一塊體素資料（每個體素的物理位置一樣，只是描述在 B 座標）
    out = compute_dvh(dose_kji=dose_a, dose_grid=grid_b, dose_to_primary=t, targets=[target], bins=50)["structures"][0]
    assert abs(out["dmax_gy"] - ref["dmax_gy"]) < 1e-3
    assert abs(out["dmean_gy"] - ref["dmean_gy"]) < 1e-3
    assert np.allclose(out["cumulative_pct"], ref["cumulative_pct"], atol=1e-3)
    # 用錯方向（逆）→ 球落到劑量網格外／低劑量區
    wrong = compute_dvh(dose_kji=dose_a, dose_grid=grid_b, dose_to_primary=t_inv, targets=[target], bins=50)[
        "structures"
    ][0]
    # 完全落到網格外 → 沒有網格內的體素，Dmax 也是 null
    assert wrong["partial"] is True
    assert wrong["dmax_gy"] is None or wrong["dmax_gy"] < ref["dmax_gy"] * 0.5


def test_partial_coverage_is_a_lower_bound_without_whole_structure_stats() -> None:
    """網格外的劑量未知 —— 曲線是下限、整體統計 null、Dmax 只看網格內。"""
    grid = _grid((21, 21, 21), (1.0, 1.0, 1.0), (-10.0, -10.0, -10.0))
    dose = np.full((21, 21, 21), 10.0, dtype=np.float32)
    # 球有一半在網格外
    target = _sphere_target(_grid((41, 41, 41), (1.0, 1.0, 1.0), (-20.0, -20.0, -20.0)), (10.0, 0.0, 0.0), 6.0)
    s = compute_dvh(
        dose_kji=dose, dose_grid=grid, dose_to_primary=np.eye(4), targets=[target], bins=10, reference_gy=5.0
    )["structures"][0]
    assert 0.3 < s["outside_fraction"] < 0.7
    assert s["partial"] is True
    assert s["dmax_gy"] == 10.0
    for key in ("dmin_gy", "dmean_gy", "d98_gy", "d95_gy", "d50_gy", "d2_gy", "v_ref_pct"):
        assert s[key] is None, key
    # 曲線：整個結構當分母；網格內全是 10 Gy → 0 < edge ≤ 10 的累積值 ＝ 網格內比例（下限）
    inside_pct = (1.0 - s["outside_fraction"]) * 100.0
    assert np.allclose(s["cumulative_pct"][1:], inside_pct, atol=1e-3)
    assert s["volume_cc"] > 0 and s["voxel_count"] > 0


def test_tiny_outside_fraction_within_tolerance_keeps_stats() -> None:
    """貼著網格邊緣（≤ 0.1% 在外）不算部分覆蓋。"""
    from rtgaia_core.dvh import PARTIAL_TOLERANCE

    grid = _grid((21, 21, 21), (1.0, 1.0, 1.0), (-10.0, -10.0, -10.0))
    dose = np.full((21, 21, 21), 10.0, dtype=np.float32)
    target = _sphere_target(grid, (0.0, 0.0, 0.0), 6.0)
    s = compute_dvh(dose_kji=dose, dose_grid=grid, dose_to_primary=np.eye(4), targets=[target], bins=10)["structures"][
        0
    ]
    assert s["outside_fraction"] <= PARTIAL_TOLERANCE
    assert s["partial"] is False
    assert s["dmin_gy"] == s["d98_gy"] == s["d2_gy"] == 10.0


def test_d98_is_second_percentile() -> None:
    grid = _grid((21, 21, 21), (1.0, 1.0, 1.0), (-10.0, -10.0, -10.0))
    xs = np.arange(21, dtype=np.float32)
    dose = np.broadcast_to(xs[None, None, :], (21, 21, 21)).copy()  # 劑量 ＝ i（Gy）
    target = _sphere_target(grid, (0.0, 0.0, 0.0), 8.0)
    s = compute_dvh(dose_kji=dose, dose_grid=grid, dose_to_primary=np.eye(4), targets=[target], bins=20)["structures"][
        0
    ]
    assert s["d98_gy"] <= s["d95_gy"] <= s["d50_gy"] <= s["d2_gy"]
    assert s["d98_gy"] < s["d95_gy"]


# ── 合成病例經 HTTP（含跨 FoR：CBCT 的 PTV 對計畫劑量）────────────────────────


@pytest.fixture(scope="module")
def synth(tmp_path_factory) -> SynthCase:
    return write_synth_case(tmp_path_factory.mktemp("synth-dvh"))


@pytest.fixture
def lib_driver(synth: SynthCase):
    with Session(library_root=str(synth.root)) as s:
        s.load_case(
            {
                "image_series_uids": [synth.plan_ct.series_uid, synth.cbct.series_uid],
                "structure_set_uids": [synth.plan_rs_uid, synth.cbct_rs_uid],
                "dose_uids": [synth.plan_dose_uid, synth.cbct_dose_uid],
                "registration_uids": [synth.reg_uid],
            },
            webgl2=False,
            tier="C",
        )
        yield s


def _structure_ids(driver: Session) -> dict[str, list[str]]:
    by_name: dict[str, list[str]] = {}
    for layer in driver.state["layers"]:
        if layer["kind"] == "mask":
            by_name.setdefault(layer["label"], []).append(layer["contentRef"])
    return by_name


def test_dvh_endpoint_plan_ptv_and_cross_for_cbct_ptv(lib_driver: Session, synth: SynthCase) -> None:
    names = _structure_ids(lib_driver)
    ptvs = names["PTV"]
    assert len(ptvs) == 2, "計畫 RS 與 CBCT RS 各一個 PTV"
    peak = synth.plan_dose_max_gy
    out = lib_driver.dvh(synth.plan_dose_uid, ptvs + names["BODY"][:1], bins=100, reference_gy=peak * 0.9)
    assert out["bins"] == 100 and len(out["edges_gy"]) == 101
    assert abs(out["dose_max_gy"] - peak) < 1e-3
    by_id = {s["structure_id"]: s for s in out["structures"]}
    for sid in ptvs:
        s = by_id[sid]
        # PTV 球心 ＝ 高斯中心：Dmax 接近 peak（2 mm 體素、4 mm 劑量網格的取樣誤差）
        assert s["dmax_gy"] > peak * 0.9, s
        # 半徑 ≤ 3.5 mm、σ = 7 mm → 理論 Dmin ≥ peak·exp(−0.125) ≈ 0.88 peak；取樣後放寬
        assert s["dmin_gy"] > peak * 0.75, s
        assert s["outside_fraction"] < 0.05
        assert s["v_ref_pct"] is not None
    # 🔴 跨 FoR：CBCT 的 PTV（FoR B，經 REG）與計畫 PTV（FoR A）都在高斯中心 → Dmax 相近
    d_plan, d_cbct = (by_id[s]["dmax_gy"] for s in ptvs)
    assert abs(d_plan - d_cbct) < peak * 0.1
    body = by_id[names["BODY"][0]]
    # BODY 超出劑量網格 → 部分覆蓋：整體統計不給，曲線（下限）在 PTV 之下
    assert body["partial"] is True and body["dmean_gy"] is None
    mid = len(out["edges_gy"]) // 2
    assert body["cumulative_pct"][mid] < by_id[ptvs[0]]["cumulative_pct"][mid]
    assert body["volume_cc"] > by_id[ptvs[0]]["volume_cc"]


def test_dvh_export_registers_audit_for_viewer(lib_driver: Session, synth: SynthCase) -> None:
    """DVH 匯出先登記稽核（格式、結構、是否匿名）；viewer 也能匯出（看得到 DVH 就能存）。"""
    names = _structure_ids(lib_driver)
    lib_driver._headers["X-RTGaia-Role"] = "viewer"
    out = lib_driver._post(
        f"/api/v1/dose/{synth.plan_dose_uid}/dvh/export",
        {"format": "csv-full", "structure_ids": names["PTV"][:1], "anonymized": False},
    )
    assert out == {"ok": True}
    ev = [e for e in lib_driver._app.state.rtgaia.audit_tail if e["action"].endswith("/dvh/export")][-1]
    assert ev["detail"]["dvh_export"] == {"format": "csv-full", "structure_ids": names["PTV"][:1], "anonymized": False}
    with pytest.raises(RuntimeError, match="422"):
        lib_driver._post(f"/api/v1/dose/{synth.plan_dose_uid}/dvh/export", {"format": "xls", "structure_ids": ["x"]})
    with pytest.raises(RuntimeError, match="404"):
        lib_driver._post(f"/api/v1/dose/{synth.plan_dose_uid}/dvh/export", {"format": "png", "structure_ids": ["nope"]})


def test_dose_max_point_in_primary_world(lib_driver: Session, synth: SynthCase) -> None:
    """「跳到 Dmax」：計畫劑量（高斯，中心在計畫 PTV）的最大點 → primary 座標，靠近計畫 PTV 的中心。"""
    out = lib_driver._get(f"/api/v1/dose/{synth.plan_dose_uid}/max")
    assert abs(out["max_gy"] - synth.plan_dose_max_gy) < 1e-3
    assert len(out["world_primary_mm"]) == 3 and len(out["index_ijk"]) == 3
    # 計畫劑量在 primary 的 FoR：世界座標就是 primary 座標
    assert np.allclose(out["world_mm"], out["world_primary_mm"])
    # CBCT 的劑量（另一個 FoR，經 REG）→ primary 座標與 FoR 自己的座標不同，但 Dmax 也在 PTV 附近
    cb = lib_driver._get(f"/api/v1/dose/{synth.cbct_dose_uid}/max")
    assert np.linalg.norm(np.subtract(cb["world_primary_mm"], out["world_primary_mm"])) < 10.0
    with pytest.raises(RuntimeError, match="422"):
        lib_driver._get(f"/api/v1/dose/{synth.plan_ct.series_uid}/max")
    with pytest.raises(RuntimeError, match="404"):
        lib_driver._get("/api/v1/dose/no-such/max")


def test_dvh_endpoint_errors(lib_driver: Session, synth: SynthCase) -> None:
    names = _structure_ids(lib_driver)
    with pytest.raises(RuntimeError, match="422"):
        lib_driver.dvh(synth.plan_ct.series_uid, names["PTV"][:1])  # 不是劑量
    with pytest.raises(RuntimeError, match="404"):
        lib_driver.dvh(synth.plan_dose_uid, ["nope"])
    with pytest.raises(RuntimeError, match="404"):
        lib_driver.dvh("no-such-series", names["PTV"][:1])


# ── DoseUnits 不是 GY 就不做 Gy 統計 ─────────────────────────────


def _case_with_dose_variant(tmp_path: Path, **dose_kwargs) -> tuple[SynthCase, Session]:  # type: ignore[no-untyped-def]
    """合成病例，但把計畫劑量改寫成指定的 DoseUnits／DoseGridScaling（其他檔不動）。"""
    import pydicom

    synth = write_synth_case(tmp_path / "synth")
    dose_path = synth.root / "plan_0" / "dose.dcm"
    ds = pydicom.dcmread(str(dose_path))
    for k, v in dose_kwargs.items():
        setattr(ds, k, v)
    ds.save_as(str(dose_path), enforce_file_format=True)
    s = Session(library_root=str(synth.root))
    s.__enter__()
    s.load_case(
        {
            "image_series_uids": [synth.plan_ct.series_uid],
            "structure_set_uids": [synth.plan_rs_uid],
            "dose_uids": [synth.plan_dose_uid],
        },
        webgl2=False,
        tier="C",
    )
    return synth, s


@pytest.mark.parametrize("units", ["RELATIVE", "relative", ""])
def test_dvh_rejects_non_gy_dose_units(tmp_path: Path, units: str) -> None:
    """重現：RELATIVE 的病例 DVH 回 200、`dose_max_gy≈47.89` → 現在 422 `DOSE_UNITS_UNSUPPORTED`。
    小寫 `relative` 也擋（正規化大寫再比）；缺值同樣擋 —— 不知道單位就不能標 Gy。"""
    synth, s = _case_with_dose_variant(tmp_path, DoseUnits=units)
    try:
        names = _structure_ids(s)
        # 病例仍可開、劑量 layer 在，params 標了 dose_scale，載入警告有一句
        dose_layer = next(x for x in s.state["layers"] if x["kind"] == "dose")
        assert dose_layer["params"]["dose_scale"] == ("relative" if units.upper() == "RELATIVE" else "unknown")
        with pytest.raises(RuntimeError, match="DOSE_UNITS_UNSUPPORTED"):
            s.dvh(synth.plan_dose_uid, names["PTV"][:1])
    finally:
        s.__exit__(None, None, None)


def test_dvh_gy_dose_reports_units_and_scale(tmp_path: Path) -> None:
    synth, s = _case_with_dose_variant(tmp_path, DoseUnits="GY")
    try:
        names = _structure_ids(s)
        dose_layer = next(x for x in s.state["layers"] if x["kind"] == "dose")
        assert dose_layer["params"]["dose_scale"] == "gy" and dose_layer["params"]["units"] == "GY"
        out = s.dvh(synth.plan_dose_uid, names["PTV"][:1])
        assert out["dose_units"] == "GY"
    finally:
        s.__exit__(None, None, None)


@pytest.mark.parametrize("scaling", ["0", "-1e-3", "nan"])
def test_dvh_rejects_non_positive_or_non_finite_scaling(tmp_path: Path, scaling: str) -> None:
    synth, s = _case_with_dose_variant(tmp_path, DoseGridScaling=scaling)
    try:
        names = _structure_ids(s)
        with pytest.raises(RuntimeError, match="DOSE_SCALING_INVALID"):
            s.dvh(synth.plan_dose_uid, names["PTV"][:1])
    finally:
        s.__exit__(None, None, None)
