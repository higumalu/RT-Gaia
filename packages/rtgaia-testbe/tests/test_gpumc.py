"""GPU Monte Carlo 輸運核心 —— 跟 OpenTOPAS（參考引擎）在同一個體素假體、同一個射源下逐項比對。

要 NVIDIA GPU ＋ CuPy（`uv sync --all-packages --extra gpu`）、docker 與 OpenTOPAS 映像（物理表在它裡面的 Geant4 產生，
TOPAS 是對照）；缺一樣就整檔略過（CI 也是）。驗的是：
* 物理表：水的 λ1 跟屏蔽 Rutherford（Molière）差 < 10%；全阻擋本領在 NIST ESTAR 的範圍
* 結果可重現：同一個種子逐位元相同、換種子不同
* 光子（2 MeV 平行光束 10 × 10、水、5 mm）：建成區之後的深度劑量跟 TOPAS 差 ≤ 1.5%；總沉積能量差 ≤ 0.5%
* 光子（6 MV 能譜、水裡 3–9 cm 是肺）：2 cm 之後在 ±3%（肺裡 GPU 高 1–3%，已知限制）
* 電子（2 MeV 筆形束、均勻水）：側向積分深度曲線的 R50 跟 TOPAS 差 ≤ 0.2 mm
已知限制（寫在 gpumc 的說明）：建成區前 1 cm 比 TOPAS 低 3–4%；肺裡高 1–3%；薄的高密度層後面的電子射程差約 0.4 mm。

跑法：`uv run pytest packages/rtgaia-testbe/tests/test_gpumc.py`（約 5 分鐘，大部分是 TOPAS）。
"""

from __future__ import annotations

import dataclasses
from pathlib import Path

import numpy as np
import pytest
from rtgaia_dosecalc import beam_models, gpumc, phantoms
from rtgaia_dosecalc.ct_calibration import builtin_calibration
from rtgaia_dosecalc.delivery import Delivery
from rtgaia_dosecalc.engines import topas
from rtgaia_dosecalc.package import CalcInput

_GPU = gpumc.status()
_TOPAS = topas.status()
pytestmark = pytest.mark.skipif(
    not (_GPU["ready"] and _TOPAS["ready"]),
    reason=f"GPU Monte Carlo 不能用：{_GPU.get('reason') or _TOPAS.get('reason')}",
)


@pytest.fixture(scope="module")
def tb(tmp_path_factory):  # type: ignore[no-untyped-def]
    from rtgaia_dosecalc.gpumc import tables

    return tables.build(tmp_path_factory.mktemp("gpumc"), image=topas.IMAGE, g4data=topas.g4data())


def _phantom(insert_hu: float | None, spacing: float) -> tuple[np.ndarray, object, np.ndarray, np.ndarray, CalcInput]:
    hu, g = phantoms.water_box((300.0, 300.0, 300.0), spacing, air_margin_mm=0.0)
    if insert_hu is not None:
        zc = g.origin[2] + spacing * np.arange(g.size[2]) + 150.0
        hu[(zc >= 30.0) & (zc < 90.0)] = insert_hu
    inp = CalcInput(
        engine="topas", delivery=Delivery([], fractions=1), ct_hu=hu, ct_grid=g, dose_grid=g,
        calibration=builtin_calibration(), beam_model=beam_models.demo_6x(),
    )  # fmt: skip
    codes, rho, mat, _ = topas.patient_on_grid(inp)
    return codes, g, rho, mat, inp


def _topas_parallel(
    tmp: Path, codes: np.ndarray, inp: CalcInput, z0: float, energies: list[float], weights: list[float], n: int
) -> np.ndarray:
    """TOPAS：沿 +z 的平行光束 10 × 10、從 z0 出發、真空世界；回每個歷史的劑量（Gy）。"""
    tmp.mkdir(parents=True, exist_ok=True)
    codes.tofile(tmp / "patient.dat")
    w = np.asarray(weights) / np.sum(weights)
    spec = [
        's:So/B/BeamEnergySpectrumType = "Discrete"',
        f"dv:So/B/BeamEnergySpectrumValues = {len(energies) + 1} {energies[0]:g} "
        + " ".join(f"{e:g}" for e in energies)
        + " MeV",
        f"uv:So/B/BeamEnergySpectrumWeights = {len(w) + 1} 0 " + " ".join(f"{x:.6g}" for x in w),
    ]
    text = [
        topas.patient_parameters(inp, "patient.dat"), topas._common(topas.threads(), 7),
        "d:Ge/World/HLX = 1000 mm", "d:Ge/World/HLY = 1000 mm", "d:Ge/World/HLZ = 1000 mm",
        's:Ge/World/Material = "G4_Galactic"',
        's:Ge/BeamPos/Type = "Group"', 's:Ge/BeamPos/Parent = "World"', f"d:Ge/BeamPos/TransZ = {z0} mm",
        's:So/B/Type = "Beam"', 's:So/B/Component = "BeamPos"', 's:So/B/BeamParticle = "gamma"',
        's:So/B/BeamPositionDistribution = "Flat"', 's:So/B/BeamPositionCutoffShape = "Rectangle"',
        "d:So/B/BeamPositionCutoffX = 50 mm", "d:So/B/BeamPositionCutoffY = 50 mm",
        's:So/B/BeamAngularDistribution = "None"',
        f"i:So/B/NumberOfHistoriesInRun = {n}", 's:Sc/Dose/OutputFile = "dose"', *spec,
    ]  # fmt: skip
    (tmp / "run.txt").write_text("\n".join(text) + "\n")
    topas.run_topas(tmp, "run.txt", label="test-gpumc")
    s, _ = topas.read_dose(tmp / "dose.bin", codes.shape)
    return s / n


def _gpu_parallel(tb, rho, mat, g, z0, energies, weights, n, seed=1):  # type: ignore[no-untyped-def]
    from rtgaia_dosecalc.gpumc import transport

    corner = tuple(float(o - s / 2) for o, s in zip(g.origin, g.spacing, strict=True))
    src = transport.Source(
        "parallel", origin=(0.0, 0.0, z0), direction=(0.0, 0.0, 1.0), ex=(1.0, 0.0, 0.0), ey=(0.0, 1.0, 0.0),
        hx=50.0, hy=50.0, energies_mev=list(energies), weights=list(weights),
    )  # fmt: skip
    r = transport.simulate(tb, mat, rho, tuple(g.spacing), corner, src, n, seed=seed)
    return r, transport.dose_gy_per_history(r.edep_mev, rho, tuple(g.spacing))


def _cax(d: np.ndarray, spacing: float) -> np.ndarray:
    c, hw = d.shape[2] // 2, int(round(20 / spacing))
    return d[:, c - hw : c + hw, c - hw : c + hw].mean(axis=(1, 2))


def test_tables_are_physical(tb) -> None:  # type: ignore[no-untyped-def]
    from rtgaia_dosecalc.gpumc import tables

    q = tables.QUANTITIES
    m = 5  # 水樣軟組織
    i = int(np.argmin(np.abs(tb.energies - 1.0)))
    lam1 = 1.0 / tb.values[q.index("tr_e"), m, i] * tb.rho_ref[m]  # mm，在 1 g/cm³
    assert 4.8 < lam1 < 6.2, f"1 MeV 的 λ1 {lam1:.2f} mm（屏蔽 Rutherford 5.1 mm）"
    s_tot = tb.se_total[m, i] / tb.rho_ref[m] * 10  # MeV cm²/g
    assert 1.80 < s_tot < 1.90, f"1 MeV 全阻擋本領 {s_tot:.3f}（ESTAR 水 1.849）"
    assert np.all(tb.values[q.index("xc_e"), m] >= 0) and np.all(tb.values[q.index("trs_e"), m] >= 0)


def test_reproducible(tb) -> None:  # type: ignore[no-untyped-def]
    codes, g, rho, mat, _ = _phantom(None, 5.0)
    z0 = g.origin[2] - 2.5 - 100.0
    a, _ = _gpu_parallel(tb, rho, mat, g, z0, [2.0], [1.0], 2_000_000, seed=3)
    b, _ = _gpu_parallel(tb, rho, mat, g, z0, [2.0], [1.0], 2_000_000, seed=3)
    c, _ = _gpu_parallel(tb, rho, mat, g, z0, [2.0], [1.0], 2_000_000, seed=4)
    assert np.array_equal(a.edep_mev, b.edep_mev), "同一個種子逐位元相同（整數計分跟執行順序無關）"
    assert not np.array_equal(a.edep_mev, c.edep_mev)
    assert a.lost == 0


@pytest.mark.parametrize(("insert", "energy"), [(None, "2"), (-700.0, "6x")])
def test_photon_depth_dose_matches_topas(tb, tmp_path: Path, insert, energy) -> None:  # type: ignore[no-untyped-def]
    codes, g, rho, mat, inp = _phantom(insert, 5.0)
    z0 = g.origin[2] - 2.5 - 100.0
    e, w = ([2.0], [1.0]) if energy == "2" else beam_models.spectrum_lines()
    dt = _topas_parallel(tmp_path / "topas", codes, inp, z0, list(e), list(w), 10_000_000)
    r, dg = _gpu_parallel(tb, rho, mat, g, z0, e, w, 100_000_000)
    at, ag = _cax(dt, 5.0), _cax(dg, 5.0)
    depth = 5.0 * (np.arange(len(at)) + 0.5)
    deep = (depth > (12 if energy == "2" else 20)) & (depth < 280)
    ratio = ag[deep] / at[deep]
    tol = 0.015 if insert is None else 0.03  # 肺裡 GPU 高 1–3%（已知限制）
    assert np.all(np.abs(ratio - 1) < tol), f"建成區之後 GPU/TOPAS {np.round(ratio, 3)}"
    vox_kg = rho.astype(np.float64) * 1e-3 * 125e-3  # 5 mm 體素
    eg = (np.nan_to_num(dg) * vox_kg).sum()
    et = (np.nan_to_num(dt) * vox_kg).sum()
    assert eg == pytest.approx(et, rel=0.005), "總沉積能量"
    assert r.histories / r.seconds > 5e6, f"速度 {r.histories / r.seconds:.2e} 歷史／秒"


def test_electron_range_matches_topas(tb, tmp_path: Path) -> None:  # type: ignore[no-untyped-def]
    from rtgaia_dosecalc.gpumc import transport

    nb, depth_mm, n_t = 120, 18.0, 1_000_000
    dz = depth_mm / nb
    text = [
        topas._common(topas.threads(), 3),
        "d:Ge/World/HLX = 500 mm", "d:Ge/World/HLY = 500 mm", "d:Ge/World/HLZ = 500 mm",
        's:Ge/World/Material = "G4_Galactic"', 's:Ge/Box/Type = "TsBox"', 's:Ge/Box/Parent = "World"',
        's:Ge/Box/Material = "G4_WATER"', "d:Ge/Box/HLX = 200 mm", "d:Ge/Box/HLY = 200 mm",
        f"d:Ge/Box/HLZ = {depth_mm / 2} mm",
        f"i:Ge/Box/ZBins = {nb}", 's:Ge/BeamPos/Type = "Group"', 's:Ge/BeamPos/Parent = "World"',
        f"d:Ge/BeamPos/TransZ = {-depth_mm / 2 - 0.01} mm", 's:So/B/Type = "Beam"', 's:So/B/Component = "BeamPos"',
        's:So/B/BeamParticle = "e-"', "d:So/B/BeamEnergy = 2.0 MeV", "u:So/B/BeamEnergySpread = 0",
        's:So/B/BeamPositionDistribution = "None"', 's:So/B/BeamAngularDistribution = "None"',
        f"i:So/B/NumberOfHistoriesInRun = {n_t}", 's:Sc/E/Quantity = "EnergyDeposit"', 's:Sc/E/Component = "Box"',
        's:Sc/E/OutputType = "csv"', 's:Sc/E/OutputFile = "edep"', 's:Sc/E/IfOutputFileAlreadyExists = "Overwrite"',
    ]  # fmt: skip
    (tmp_path / "run.txt").write_text("\n".join(text) + "\n")
    topas.run_topas(tmp_path, "run.txt", label="test-gpumc")
    et = np.loadtxt(tmp_path / "edep.csv", comments="#", delimiter=",")[:, -1] / n_t
    nx = 41
    mat = np.full((nb, nx, nx), 5, np.uint8)
    rho = np.ones(mat.shape, np.float32)
    src = transport.Source(
        "parallel", origin=(0.0, 0.0, -0.01), direction=(0.0, 0.0, 1.0), ex=(1.0, 0.0, 0.0), ey=(0.0, 1.0, 0.0),
        hx=1e-3, hy=1e-3, energies_mev=[2.0], weights=[1.0], particle="electron",
    )  # fmt: skip
    r = transport.simulate(tb, mat, rho, (400.0 / nx, 400.0 / nx, dz), (-200.0, -200.0, 0.0), src, 5_000_000)
    eg = r.edep_mev.sum(axis=(1, 2))

    def r50(a: np.ndarray) -> float:
        z = (np.arange(len(a)) + 0.5) * dz
        j = int(np.argmax(a))
        k = j + int(np.argmax(a[j:] < 0.5 * a[j]))
        return float(z[k - 1] + (a[k - 1] - 0.5 * a[j]) / (a[k - 1] - a[k]) * dz)

    assert r50(eg) == pytest.approx(r50(et), abs=0.2), f"R50 GPU {r50(eg):.2f} TOPAS {r50(et):.2f} mm"
    assert eg.sum() == pytest.approx(et.sum(), rel=0.02), "總沉積能量（反散射、制動輻射逃出）"


def test_engine_mu_calibration_and_depth_dose(tmp_path: Path) -> None:
    """引擎 `gpu`：10 × 10、SSD 100、水中 —— dmax 的劑量 ≈ 1 cGy／MU（自己的 MU 校正）、dmax 在 1–2.5 cm、
    PDD(10 cm) 在 6 MV 的典型範圍。"""
    from rtgaia_dosecalc.delivery import Beam, ControlPoint
    from rtgaia_dosecalc.gpumc import engine
    from rtgaia_geom import Grid

    water = {"calibration_id": "water", "name": "water", "demo": False,
             "density": {"type": "points", "points": [[-1000, 0.0012], [0, 1.0], [3000, 2.8]]},
             "materials": {"type": "schneider2000"}}  # fmt: skip
    cps = [ControlPoint(m, 0.0, 0.0, 0.0, (-50.0, 50.0), (-50.0, 50.0)) for m in (0.0, 100.0)]
    beam = Beam(1, "B", 6.0, "STANDARD", 1000.0, (0.0, -150.0, 0.0), "HFS", 100.0, cps)  # 等中心在水面
    hu, g = phantoms.water_box((300.0, 300.0, 300.0), 5.0, air_margin_mm=20.0)
    grid = Grid(size=(60, 60, 60), spacing=(5.0,) * 3, origin=(-147.5,) * 3, direction=(1, 0, 0, 0, 1, 0, 0, 0, 1),
                frame_of_reference_uid=g.frame_of_reference_uid)  # fmt: skip
    inp = CalcInput(
        engine="gpu", delivery=Delivery([beam], fractions=1), ct_hu=hu, ct_grid=g, dose_grid=grid,
        calibration=water, beam_model=beam_models.demo_6x(), options={"histories": 100_000_000},
    )  # fmt: skip
    res = engine.run(inp, tmp_path / "job" / "out", lambda *_a: None)
    dose = np.nan_to_num(res.dose_gy)
    axis = dose[28:32, :, 28:32].mean(axis=(0, 2))
    smooth = np.convolve(axis, np.ones(3) / 3, mode="same")
    j = int(np.argmax(smooth[1:-1])) + 1
    assert 10 <= 2.5 + 5 * j <= 25
    assert smooth[j] == pytest.approx(1.0, rel=0.03), "100 MU、SSD 100、10 × 10 的 dmax ≈ 1 Gy"
    assert 0.62 <= axis[20] / smooth[j] <= 0.72
    assert res.info["engine"] == "gpu" and res.info["histories_per_mu"] > 0
    assert float(np.nanmedian(res.uncertainty[28:32, 3:10, 28:32])) < 0.02


def test_engine_plan_matches_topas(tmp_path: Path) -> None:
    """合成 6X 計畫（靜態、MLC 圓、VMAT）：每個射束高劑量區 GPU／TOPAS 的中位數在 0.97–1.05（GPU 的機頭沒有準直器
    散射與電子污染，MU 校正約差 2%）、50% 範圍重疊 ≥ 0.9。"""
    from rtgaia_dosecalc.from_rtplan import read_delivery
    from rtgaia_dosecalc.gpumc import engine
    from rtgaia_geom import Grid
    from rtgaia_testbe.fixtures import synth_plan

    case = synth_plan.build(tmp_path / "case")
    d, problems = read_delivery(next((case.root / "RP").glob("*.dcm")))
    assert d is not None, problems
    geom = synth_plan.GEOM
    ct = np.stack([synth_plan._hu(k) for k in range(geom.size[2])]).astype(np.float32)
    ct_grid = Grid(size=geom.size, spacing=geom.spacing, origin=geom.origin, direction=(1, 0, 0, 0, 1, 0, 0, 0, 1),
                   frame_of_reference_uid="x")  # fmt: skip
    dose_grid = Grid(size=(64, 48, 36), spacing=(5.0,) * 3, origin=(-157.5, -117.5, -87.5),
                     direction=(1, 0, 0, 0, 1, 0, 0, 0, 1), frame_of_reference_uid="x")  # fmt: skip
    out = {}
    for name, run, hist in (("gpu", engine.run, 200_000_000), ("topas", topas.run, 20_000_000)):
        inp = CalcInput(
            engine=name, delivery=d, ct_hu=ct, ct_grid=ct_grid, dose_grid=dose_grid,
            calibration=builtin_calibration(), beam_model=beam_models.demo_6x(), options={"histories": hist},
        )  # fmt: skip
        out[name] = run(inp, tmp_path / name / "job" / "out", lambda *_a: None)
    for n in (1, 2, 3):
        a, b = np.nan_to_num(out["gpu"].per_beam_gy[n]), np.nan_to_num(out["topas"].per_beam_gy[n])
        hi = b > 0.5 * np.percentile(b, 99.5)
        ma = a > 0.5 * np.percentile(a, 99.5)
        dice = 2 * (ma & hi).sum() / (ma.sum() + hi.sum())
        ratio = float(np.median(a[hi] / b[hi]))
        assert 0.97 <= ratio <= 1.05, f"射束 {n} GPU／TOPAS {ratio:.3f}"
        assert dice >= 0.9, f"射束 {n} 50% 範圍重疊 {dice:.2f}"
    assert out["gpu"].info["seconds"] < out["topas"].info["seconds"]


def test_model_vs_public_beam_data(tb, tmp_path: Path) -> None:  # type: ignore[no-untyped-def]
    """示範 6X 模型對 Beyer 2013（三台 TrueBeam）的 PDD10 與中間射野的輸出因子：用來確認比對流程在 GPU 上跑得通、
    取值合理（示範模型不是擬合出來的，門檻放寬；擬合之後另有更嚴的測試）。"""
    from rtgaia_dosecalc import beam_data, commissioning
    from rtgaia_dosecalc.gpumc import engine

    model = beam_models.demo_6x()
    ds = {d["dataset_id"]: d for d in beam_data.builtin_datasets()}["pub-beyer2013-6x"]
    keep = {"beyer2013-t1-pdd10-6x-10x10", "beyer2013-t1-dmax-6x-10x10", "beyer2013-t2-of-6x"}
    sub = {**ds, "measurements": [m for m in ds["measurements"] if m["measurement_id"] in keep]}
    sub["measurements"] = [
        {**m, "points": [r for r in m["points"] if r[0] in (60.0, 100.0, 150.0)]} if m["kind"] == "output_factor" else m
        for m in sub["measurements"]
    ]
    hpm = engine.calibration(model, tmp_path / "calibration", tb)
    rep = commissioning.run_checks(model, sub, tb, hpm, histories=500_000_000)
    rows = {(r["measurement_id"], r["x"]): r for r in rep["checks"]}
    pdd = rows[("beyer2013-t1-pdd10-6x-10x10", 100.0)]
    assert abs(pdd["diff"]) < 1.5 and pdd["u_model"] < 0.6  # 百分點
    assert abs(rows[("beyer2013-t1-dmax-6x-10x10", None)]["diff"]) < 3.0  # mm
    for fs in (60.0, 150.0):
        of = rows[("beyer2013-t2-of-6x", fs)]
        assert abs(of["diff_relative"]) < 0.03 and of["u_model"] < 0.01
    assert rows[("beyer2013-t2-of-6x", 100.0)]["model"] == pytest.approx(1.0)


def test_source_model_components(tb) -> None:  # type: ignore[no-untyped-def]
    """擬合用的射源成分在 GPU 上的效果方向對：電子污染抬高表面劑量、大射野效果比較大、關起來的 MLC 下面沒有電子；
    準直器有效密度變小 → 穿透變大（約 exp(0.15 μρL) 倍）；監測游離腔反散射 → 小射野每 MU 劑量少 s 倍。"""
    import copy

    from rtgaia_dosecalc import water

    base = beam_models.demo_6x()
    ec = copy.deepcopy(base)
    ec["params"]["electron_contamination"] = {
        "fraction": 0.002, "mean_energy_mev": 1.5, "sigma_mm": 30.0, "distance_below_target_mm": 150.0,
    }  # fmt: skip

    def surface_and_dmax(model: dict, field: float, n: float) -> tuple[float, float]:  # type: ignore[type-arg]
        c = water.simulate(model, water.Setup(field, field, 1000.0), tb, int(n)).mean
        dm = water.dmax_mm(c.depth_mm, c.cax)
        return c.cax[0] / water.dose_at(c.depth_mm, c.cax, dm), dm

    s0, d0 = surface_and_dmax(base, 100.0, 5e8)
    s1, d1 = surface_and_dmax(ec, 100.0, 5e8)
    s0b, _ = surface_and_dmax(base, 400.0, 2e9)
    s1b, _ = surface_and_dmax(ec, 400.0, 2e9)
    assert s1 > s0 + 0.015 and d1 <= d0 + 0.3
    assert (s1b - s0b) > (s1 - s0)  # 大射野的電子污染多

    def transmission(model: dict) -> float:  # type: ignore[type-arg]
        closed = water.simulate(model, water.Setup(100, 100, 1000, "closed"), tb, 1_000_000_000).mean
        open_ = water.simulate(model, water.Setup(100, 100, 1000), tb, 300_000_000).mean
        return water.dose_at(closed.depth_mm, closed.cax, 100.0) / water.dose_at(open_.depth_mm, open_.cax, 100.0)

    dens = copy.deepcopy(base)
    dens["params"]["collimators"]["MLCX"]["density_factor"] = 0.85
    t1, t085 = transmission(base), transmission(dens)
    assert 2.0 < t085 / t1 < 4.5

    # 電子污染碰到鎢就停：MLC 整片關起來，dmax 附近的穿透跟沒有電子污染時一樣（以前電子直接穿過，3% 對 0.4%）
    def transmission_dmax(model: dict) -> float:  # type: ignore[type-arg]
        closed = water.simulate(model, water.Setup(100, 100, 1000, "closed"), tb, 1_000_000_000).mean
        open_ = water.simulate(model, water.Setup(100, 100, 1000), tb, 300_000_000).mean
        return water.dose_at(closed.depth_mm, closed.cax, 15.0) / water.dose_at(open_.depth_mm, open_.cax, 15.0)

    assert transmission_dmax(ec) == pytest.approx(transmission_dmax(base), rel=0.15)

    bs = copy.deepcopy(base)
    bs["params"]["monitor_backscatter"] = {"per_mm_x": 1e-4, "per_mm_y": 1e-4}
    a = water.simulate(base, water.Setup(40, 40, 1000), tb, 300_000_000, seed=5).mean
    b = water.simulate(bs, water.Setup(40, 40, 1000), tb, 300_000_000, seed=5).mean
    ratio = water.dose_at(b.depth_mm, b.cax, 100.0) / water.dose_at(a.depth_mm, a.cax, 100.0)
    assert ratio == pytest.approx(1 / 1.012, abs=1e-6)  # 同一個種子、同一組粒子：只差 M


def test_x_and_y_profiles(tb) -> None:  # type: ignore[no-untyped-def]
    """10 × 6 cm 的 jaw 射野、SSD 100、10 cm 深：x 方向 FWHM ≈ 110 mm、y 方向 ≈ 66 mm（幾何投影 1.1 倍）。"""
    from rtgaia_dosecalc import water

    s = water.Setup(100, 60, 1000, profile_depths=(100.0,), profile_y=True)
    c = water.simulate(beam_models.demo_6x(), s, tb, 500_000_000).mean
    fx = water.profile_metrics(c.x_mm, c.profiles[100.0], fff=False)["fwhm_mm"]
    fy = water.profile_metrics(c.y_mm, c.profiles_y[100.0], fff=False)["fwhm_mm"]
    assert fx == pytest.approx(110.0, abs=1.5) and fy == pytest.approx(66.0, abs=1.5)


def test_dlg_opens_narrow_gaps(tb) -> None:  # type: ignore[no-untyped-def]
    """DLG：每對葉片的開口兩側各放大 DLG／2。5 mm 的 MLC 窄縫在 DLG 1.33 mm 時，橫向積分的劑量（掃描間隙、VMAT
    的窄開口累積的就是這個）跟開口寬度成比例（6.33／5 ＝ 1.27）；中心軸只多一點散射；10 cm 的開口幾乎不變。"""
    import copy

    from rtgaia_dosecalc import water

    base = beam_models.demo_6x()
    base["params"]["collimators"]["MLCX"]["dlg_mm"] = 1.33
    no_dlg = copy.deepcopy(base)
    no_dlg["params"]["collimators"]["MLCX"]["dlg_mm"] = 0.0

    def integral(model: dict, field: float) -> float:  # type: ignore[type-arg]
        s = water.Setup(field, 100.0, 1000.0, "mlc", profile_depths=(100.0,))
        c = water.simulate(model, s, tb, 500_000_000, seed=3).mean
        prof = c.profiles[100.0]
        return float(2 * prof.sum() - prof[0])

    narrow = integral(base, 5.0) / integral(no_dlg, 5.0)
    wide = integral(base, 100.0) / integral(no_dlg, 100.0)
    assert narrow == pytest.approx(6.33 / 5.0, abs=0.06) and wide == pytest.approx(1.0133, abs=0.01)


def test_radial_fluence_shapes_the_profile(tb) -> None:  # type: ignore[no-untyped-def]
    """徑向通量：權重全是 1 跟沒有一樣（統計內）；外圍加 10%（平坦射束的「角」）→ 40 × 40 的側向分佈在 150 mm 處
    相對中心軸高約 5%（節點之間線性）。"""
    import copy

    from rtgaia_dosecalc import water

    base = beam_models.demo_6x()
    flat = copy.deepcopy(base)
    flat["params"]["radial_fluence"] = {"r_mm": [0.0, 300.0], "weight": [1.0, 1.0]}
    horns = copy.deepcopy(base)
    horns["params"]["radial_fluence"] = {"r_mm": [0.0, 100.0, 200.0, 300.0], "weight": [1.0, 1.0, 1.1, 1.1]}
    s = water.Setup(400, 400, 1000, profile_depths=(15.0,))

    def rel150(m: dict) -> float:  # type: ignore[type-arg]
        c = water.simulate(m, s, tb, 2_000_000_000, seed=9).mean
        p, x = c.profiles[15.0], c.x_mm
        return float(p[(x >= 130) & (x <= 170)].mean() / p[x <= 20].mean())

    r0, r1, r2 = rel150(base), rel150(flat), rel150(horns)
    assert r1 == pytest.approx(r0, abs=0.01)
    assert r2 / r0 == pytest.approx(1.05, abs=0.02)  # 150 mm 在 100（1.0）與 200 mm（1.1）兩節點的正中間


def test_model_sensitivity_recalculates_with_equally_good_alternatives(tmp_path: Path) -> None:
    """模型敏感度：擬合裡一樣好的其他參數各重算一次（同一組種子）。跟模型一模一樣的「替代」→ 比值剛好 1；機頭散射
    加倍 → 高劑量區的劑量變了，寫進結果與備註。"""
    from rtgaia_dosecalc.delivery import Beam, ControlPoint
    from rtgaia_dosecalc.gpumc import engine
    from rtgaia_geom import Grid

    water = {"calibration_id": "water", "name": "water", "demo": False,
             "density": {"type": "points", "points": [[-1000, 0.0012], [0, 1.0], [3000, 2.8]]},
             "materials": {"type": "schneider2000"}}  # fmt: skip
    cps = [ControlPoint(m, 0.0, 0.0, 0.0, (-30.0, 30.0), (-30.0, 30.0)) for m in (0.0, 100.0)]
    beam = Beam(1, "B", 6.0, "STANDARD", 1000.0, (0.0, -100.0, 0.0), "HFS", 100.0, cps)
    hu, g = phantoms.water_box((200.0, 200.0, 200.0), 5.0, air_margin_mm=20.0)
    grid = Grid(size=(40, 40, 40), spacing=(5.0,) * 3, origin=(-97.5,) * 3, direction=(1, 0, 0, 0, 1, 0, 0, 0, 1),
                frame_of_reference_uid=g.frame_of_reference_uid)  # fmt: skip
    model = beam_models.demo_6x()
    ef = model["params"]["extra_focal"]
    focal = model["params"]["focal_spot_sigma_mm"]
    model["fit"] = {"alternatives": [
        {"stage": "focal_spot", "cost": 1.0, "overrides": {"focal_spot_sigma_mm": focal}},
        {"stage": "head_scatter", "cost": 1.2, "overrides": {"extra_focal.fraction": 3 * ef["fraction"]}},
    ]}  # fmt: skip
    inp = CalcInput(
        engine="gpu", delivery=Delivery([beam], fractions=1), ct_hu=hu, ct_grid=g, dose_grid=grid,
        calibration=water, beam_model=model, options={"histories": 30_000_000, "model_sensitivity": True},
    )  # fmt: skip
    res = engine.run(inp, tmp_path / "job" / "out", lambda *_a: None)
    same, more_ef = res.info["model_sensitivity"]
    assert same["median_ratio"] == 1.0 and same["p5_ratio"] == 1.0 and same["p95_ratio"] == 1.0
    assert more_ef["stage"] == "head_scatter" and abs(more_ef["median_ratio"] - 1.0) > 0.005
    assert more_ef["p5_ratio"] <= more_ef["median_ratio"] <= more_ef["p95_ratio"]
    assert any("一樣好的其他參數" in n for n in res.info["notes"])
    plain = engine.run(
        dataclasses.replace(inp, options={"histories": 30_000_000}), tmp_path / "job2" / "out", lambda *_a: None
    )
    assert "model_sensitivity" not in plain.info
    assert np.allclose(np.nan_to_num(plain.dose_gy), np.nan_to_num(res.dose_gy))  # 主計算不受影響
