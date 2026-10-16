"""呼叫 `transport.cu`：把體素病人、物理表、射源交給 GPU，回每個體素的沉積能量與批次不確定度。"""

from __future__ import annotations

import math
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import numpy as np

from .tables import Tables

KERNEL = Path(__file__).with_name("transport.cu")
ESCALE = float(2**24)
"""沉積能量的定點刻度（每 MeV 幾個整數單位）：1 單位 ≈ 6e-8 MeV；每體素上限約 1e12 MeV，遠超過用得到的量。"""
PHOTON_CUT_MEV = 0.01
ELECTRON_CUT_MEV = 0.05
"""電子／正子低於這個動能就地沉積（水中射程約 0.04 mm）。"""
FRAC_E = 0.05
"""每一步最多損失動能的這個比例。"""
STEP_VOXEL_FRACTION = 0.5
"""每一步最長 ＝ 體素最小邊長 × 這個比例（材質取步伐起點的體素）。"""
THREADS = 128


@dataclass
class Source:
    """驗證用的簡單射源（臨床射束模型之後接）。座標：病人 LPS（mm）。

    `kind` = "parallel"：平行光束，起點平面上 `origin ± hx·ex ± hy·ey` 的矩形均勻，方向 `direction`。
    `kind` = "point"：點射源在 `origin`，往距離 `sad`（沿 `direction`）的平面上 `± hx·ex ± hy·ey` 的矩形均勻發射。"""

    kind: str
    origin: tuple[float, float, float]
    direction: tuple[float, float, float]
    ex: tuple[float, float, float]
    ey: tuple[float, float, float]
    hx: float
    hy: float
    energies_mev: list[float]
    weights: list[float]
    sad: float = 1000.0
    particle: str = "photon"
    """`photon`；`electron`／`positron` 只給驗證用（電子束的深度劑量對多重散射最敏感）。"""
    extra: dict[str, Any] = field(default_factory=dict)


@dataclass
class Result:
    edep_mev: np.ndarray
    """(nz, ny, nx) float64：每個歷史平均沉積的能量（MeV）。"""
    sigma_mev: np.ndarray
    """同上的 1σ（批次法）。"""
    histories: int
    batches: int
    seconds: float
    lost: int
    """粒子堆疊滿了、就地沉積的次數（正常是 0）。"""


_MODULE: Any = None


def _module() -> Any:
    global _MODULE
    if _MODULE is None:
        import cupy as cp

        _MODULE = cp.RawModule(code=KERNEL.read_text(encoding="utf-8"), options=("-std=c++17",), backend="nvrtc")
    return _MODULE


def mumax_table(tb: Tables, mat: np.ndarray, rho: np.ndarray) -> np.ndarray:
    """Woodcock 用的 μ_max(E)：網格裡每個材質的最大密度比 × 那個材質的光子總截面，取最大。"""
    q = [0, 1, 2]  # 光電、康普頓、成對
    total = tb.values[q].sum(axis=0)  # (nmat, ne)
    out = np.zeros(tb.energies.shape, dtype=np.float64)
    for m in np.unique(mat):
        rmax = float(rho[mat == m].max())
        out = np.maximum(out, total[m] * rmax / float(tb.rho_ref[m]))
    return out.astype(np.float32)


def simulate(
    tb: Tables,
    mat: np.ndarray,
    rho: np.ndarray,
    spacing: tuple[float, float, float],
    corner: tuple[float, float, float],
    source: Source,
    histories: int,
    *,
    batches: int = 10,
    seed: int = 1,
    progress: Any = None,
) -> Result:
    """`mat`、`rho` 是 (nz, ny, nx)；`corner` 是網格的外緣角（第一個體素中心 − 半個體素），mm。"""
    import time

    import cupy as cp

    t0 = time.time()
    nz, ny, nx = mat.shape
    kernel = _module().get_function("run")
    d_mat = cp.asarray(np.ascontiguousarray(mat, dtype=np.uint8))
    d_rho = cp.asarray(np.ascontiguousarray(rho, dtype=np.float32))
    d_tab = cp.asarray(tb.values)
    d_mumax = cp.asarray(mumax_table(tb, mat, rho))
    d_rho_ref = cp.asarray(tb.rho_ref)
    w = np.asarray(source.weights, dtype=np.float64)
    cdf = np.cumsum(w) / w.sum()
    d_se = cp.asarray(np.asarray(source.energies_mev, dtype=np.float32))
    d_cdf = cp.asarray(cdf.astype(np.float32))
    d_edep = cp.zeros(mat.size, dtype=cp.uint64)
    d_lost = cp.zeros(1, dtype=cp.uint32)
    f32 = np.float32
    geo = (np.int32(nx), np.int32(ny), np.int32(nz), *(f32(v) for v in spacing), *(f32(v) for v in corner))

    def f3(v: tuple[float, float, float]) -> tuple[np.float32, ...]:
        return tuple(f32(x) for x in v)

    kind = {"parallel": 0, "point": 1}[source.kind]
    particle = {"photon": 0, "electron": 1, "positron": 2}[source.particle]
    tcut, kcut = (float(c) for c in tb.info.get("cuts_mev", [0.1, 0.05]))  # 表是用這組門檻算的受限量
    smax = float(min(spacing)) * STEP_VOXEL_FRACTION
    per_batch = max(1, histories // batches)
    sm = cp.cuda.Device().attributes["MultiProcessorCount"]
    blocks = int(min(sm * 16, math.ceil(per_batch / THREADS)))
    s1 = np.zeros(mat.size, dtype=np.float64)
    s2 = np.zeros(mat.size, dtype=np.float64)
    for b in range(batches):
        d_edep.fill(0)
        kernel(
            (blocks,), (THREADS,),
            (d_edep, d_lost, d_mat, d_rho, *geo, d_tab, d_mumax, d_rho_ref, np.int32(tb.values.shape[1]),
             np.int32(tb.values.shape[2]), np.float32(tb.lne0), np.float32(tb.dlne), np.int32(kind),
             *f3(source.origin), *f3(source.direction), *f3(source.ex), *f3(source.ey), np.float32(source.sad),
             np.float32(source.hx), np.float32(source.hy),
             np.int32(particle), d_se, d_cdf, np.int32(len(cdf)), np.uint64(seed),
             np.uint64(b * per_batch), np.int32(per_batch), np.float32(ESCALE), np.float32(PHOTON_CUT_MEV),
             np.float32(ELECTRON_CUT_MEV), np.float32(tcut), np.float32(kcut), np.float32(smax), np.float32(FRAC_E)),
        )  # fmt: skip
        e = cp.asnumpy(d_edep).astype(np.float64) / ESCALE / per_batch  # 這一批每個歷史的平均
        s1 += e
        s2 += e * e
        if progress is not None:
            progress((b + 1) / batches)
    mean = s1 / batches
    var = np.maximum(s2 / batches - mean * mean, 0.0) / max(1, batches - 1)
    return Result(
        edep_mev=mean.reshape(nz, ny, nx),
        sigma_mev=np.sqrt(var).reshape(nz, ny, nx),
        histories=per_batch * batches,
        batches=batches,
        seconds=time.time() - t0,
        lost=int(cp.asnumpy(d_lost)[0]),
    )


def dose_gy_per_history(edep_mev: np.ndarray, rho: np.ndarray, spacing: tuple[float, float, float]) -> np.ndarray:
    """MeV → Gy：E ×1.602e-13 J ／（ρ g/cm³ × 體積 cm³ × 1e-3 kg/g）。"""
    vol_cm3 = float(np.prod(spacing)) / 1000.0
    with np.errstate(divide="ignore", invalid="ignore"):
        return edep_mev * 1.602176634e-13 / (rho.astype(np.float64) * vol_cm3 * 1e-3)


@dataclass
class BeamSource:
    """一個射束（一批）交給 `run_beam` 的東西；由 `engine.beam_source` 從 `topas.source_plan` 組出來。"""

    cum: np.ndarray
    """(nstate+1,) uint64：每一小段的累積歷史數。"""
    nef: np.ndarray
    """(nstate,) int32：每一小段裡機頭散射的歷史數。"""
    rot: np.ndarray
    """(nstate, 9) float32：BLD → LPS（列優先）。"""
    cone: np.ndarray
    """(nstate, 6) float32：原射源、機頭散射、電子污染的 Marsaglia 錐角 (a, b)。"""
    iso: tuple[float, float, float]
    sad: float
    z_ef: float
    sigma_focal: float
    sigma_ef: float
    m_spread: float
    """原射源高斯角分佈的 Marsaglia σ（0 ＝ 均勻）。"""
    dev_i: np.ndarray
    """(ndev, 4) int32：移動軸、葉片數、邊界的偏移、開口的偏移。"""
    dev_f: np.ndarray
    """(ndev, 3) float32：上表面距靶、厚度、有效密度比。"""
    bounds: np.ndarray
    positions: np.ndarray
    energies_mev: np.ndarray
    weights: np.ndarray
    nec: np.ndarray | None = None
    """(nstate,) int32：每一小段裡電子污染的歷史數（排在機頭散射之後）。"""
    z_ec: float = 0.0
    sigma_ec: float = 0.0
    ec_energies_mev: np.ndarray | None = None
    ec_weights: np.ndarray | None = None
    radial_r_mm: np.ndarray | None = None
    """原射源的徑向通量節點（等中心平面半徑 mm）；None ＝ 沒有（只有角分佈）。"""
    radial_w: np.ndarray | None = None
    """各節點的相對通量（已正規化到最大 1）。"""

    @property
    def histories(self) -> int:
        return int(self.cum[-1])


def simulate_beam(
    tb: Tables,
    mat: np.ndarray,
    rho: np.ndarray,
    spacing: tuple[float, float, float],
    corner: tuple[float, float, float],
    src: BeamSource,
    *,
    batches: int,
    seed: int = 1,
    progress: Any = None,
    on_batch: Any = None,
) -> tuple[np.ndarray, np.ndarray, dict[str, Any]]:
    """同一份射源跑 `batches` 批（歷史編號接續）；回每一批的沉積能量總和（MeV）的平均與 1σ（批次法），
    以及統計（被準直器吸收的比例等）。`on_batch(edep)`：每一批的沉積能量（(nz, ny, nx) MeV）—— 從劑量分佈
    導出的量（dmax、半影…）要逐批算才有自己的批次不確定度。"""
    import time

    import cupy as cp

    t0 = time.time()
    nz, ny, nx = mat.shape
    kernel = _module().get_function("run_beam")
    f32 = np.float32
    d = {
        "mat": cp.asarray(np.ascontiguousarray(mat, dtype=np.uint8)),
        "rho": cp.asarray(np.ascontiguousarray(rho, dtype=np.float32)),
        "tab": cp.asarray(tb.values),
        "mumax": cp.asarray(mumax_table(tb, mat, rho)),
        "rho_ref": cp.asarray(tb.rho_ref),
        "mu_w": cp.asarray(tb.mu_tungsten),
        "cum": cp.asarray(src.cum.astype(np.uint64)),
        "nef": cp.asarray(src.nef.astype(np.int32)),
        "nec": cp.asarray((src.nec if src.nec is not None else np.zeros_like(src.nef)).astype(np.int32)),
        "ec_e": cp.asarray((src.ec_energies_mev if src.ec_energies_mev is not None else np.ones(1)).astype(np.float32)),
        "rad_r": cp.asarray((src.radial_r_mm if src.radial_r_mm is not None else np.zeros(1)).astype(np.float32)),
        "rad_w": cp.asarray((src.radial_w if src.radial_w is not None else np.ones(1)).astype(np.float32)),
        "ec_cdf": cp.asarray(
            (np.cumsum(src.ec_weights) / np.sum(src.ec_weights) if src.ec_weights is not None else np.ones(1)).astype(
                np.float32
            )
        ),
        "rot": cp.asarray(src.rot.astype(np.float32)),
        "cone": cp.asarray(src.cone.astype(np.float32)),
        "dev_i": cp.asarray(src.dev_i.astype(np.int32)),
        "dev_f": cp.asarray(src.dev_f.astype(np.float32)),
        "bounds": cp.asarray(src.bounds.astype(np.float32)),
        "pos": cp.asarray(src.positions.astype(np.float32)),
        "spec_e": cp.asarray(src.energies_mev.astype(np.float32)),
        "spec_cdf": cp.asarray((np.cumsum(src.weights) / np.sum(src.weights)).astype(np.float32)),
    }
    edep = cp.zeros(mat.size, dtype=cp.uint64)
    lost = cp.zeros(1, dtype=cp.uint32)
    absorbed = cp.zeros(1, dtype=cp.uint32)
    tcut, kcut = (float(c) for c in tb.info.get("cuts_mev", [0.1, 0.05]))
    n = src.histories
    sm = cp.cuda.Device().attributes["MultiProcessorCount"]
    blocks = int(min(sm * 16, math.ceil(n / THREADS)))
    s1 = np.zeros(mat.size)
    s2 = np.zeros(mat.size)
    for b in range(batches):
        edep.fill(0)
        kernel(
            (blocks,), (THREADS,),
            (edep, lost, d["mat"], d["rho"], np.int32(nx), np.int32(ny), np.int32(nz), *(f32(v) for v in spacing),
             *(f32(v) for v in corner), d["tab"], d["mumax"], d["rho_ref"], d["mu_w"], np.int32(tb.values.shape[1]),
             np.int32(tb.values.shape[2]), f32(tb.lne0), f32(tb.dlne), np.int32(len(src.nef)), d["cum"], d["nef"],
             d["nec"], d["rot"], d["cone"], *(f32(v) for v in src.iso), f32(src.sad), f32(src.z_ef),
             f32(src.sigma_focal), f32(src.sigma_ef), f32(src.m_spread), f32(src.z_ec), f32(src.sigma_ec), d["ec_e"],
             d["ec_cdf"], np.int32(len(d["ec_e"])), d["rad_r"], d["rad_w"],
             np.int32(len(src.radial_r_mm) if src.radial_r_mm is not None else 0), np.int32(len(src.dev_i)),
             d["dev_i"], d["dev_f"], d["bounds"],
             d["pos"], d["spec_e"], d["spec_cdf"], np.int32(len(src.energies_mev)), np.uint64(seed),
             np.uint64(b * n), np.uint64(n), f32(ESCALE), f32(PHOTON_CUT_MEV), f32(ELECTRON_CUT_MEV), f32(tcut),
             f32(kcut), f32(float(min(spacing)) * STEP_VOXEL_FRACTION), f32(FRAC_E), absorbed),
        )  # fmt: skip
        e = cp.asnumpy(edep).astype(np.float64) / ESCALE
        s1 += e
        s2 += e * e
        if on_batch is not None:
            on_batch(e.reshape(nz, ny, nx))
        if progress is not None:
            progress((b + 1) / batches)
    mean = s1 / batches
    sigma = np.sqrt(np.maximum(s2 / batches - mean * mean, 0.0) / max(1, batches - 1))
    info = {
        "seconds": time.time() - t0,
        "histories": n * batches,
        "absorbed_fraction": int(cp.asnumpy(absorbed)[0]) / max(1, n * batches),
        "lost": int(cp.asnumpy(lost)[0]),
    }
    return mean.reshape(nz, ny, nx), sigma.reshape(nz, ny, nx), info
