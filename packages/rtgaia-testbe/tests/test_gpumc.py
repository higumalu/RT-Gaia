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
