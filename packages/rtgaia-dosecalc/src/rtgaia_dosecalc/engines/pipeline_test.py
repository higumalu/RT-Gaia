"""流程測試引擎 —— **不是劑量計算**。

給計算流程（封包、工作、結果 → 暫存劑量）與射束幾何（射束從哪一側進、開口在哪裡）做確定性的測試：
每個控制點（最多 `MAX_SAMPLES` 個）把開口從射源投到劑量網格，乘上 1/r² 與沿射線的放射深度指數衰減。
沒有散射、沒有建成以外的物理；數字跟真的劑量差很多。介面只在 `RTGAIA_DOSECALC_TEST_ENGINE=1` 時列出它。
"""

from __future__ import annotations

import time
from typing import Any

import numpy as np
from scipy.ndimage import map_coordinates

from ..ct_calibration import convert
from ..delivery import aperture_open, bld_to_lps, interpolate, segments
from ..package import CalcInput, CalcResult

MU_PER_GY = 0.0102
"""每 MU 的 Gy（大約讓 10×10、SSD 100、dmax 落在 1 cGy／MU）。"""
MU_ATTENUATION_PER_MM = 0.005
BUILDUP_MM = 6.0
TRANSMISSION = 0.015
STEP_MM = 5.0
MAX_SAMPLES = 24
ENGINE_VERSION = "pipeline-test 1"
FAKE_UNCERTAINTY = 0.01


def run(inp: CalcInput, workdir: Any, progress: Any) -> CalcResult:
    t0 = time.time()
    conv = convert(inp.calibration, inp.ct_hu)
    rho = conv.density.astype(np.float32)
    g = inp.dose_grid
    ni, nj, nk = g.size
    kk, jj, ii = np.meshgrid(np.arange(nk), np.arange(nj), np.arange(ni), indexing="ij")
    pts = g.index_to_world(np.stack([ii, jj, kk], axis=-1).reshape(-1, 3).astype(np.float64))
    ct_w2i = inp.ct_grid.world_to_index_matrix
    rho_at = _sample(rho, ct_w2i, pts)
    body = rho_at > 0.05
    per_beam: dict[int, np.ndarray] = {}
    total_samples = sum(min(MAX_SAMPLES, max(1, len(segments(b)))) for b in inp.delivery.beams)
    done = 0
    for beam in inp.delivery.beams:
        segs = segments(beam)
        acc = np.zeros(pts.shape[0], dtype=np.float64)
        # 段太多（VMAT）→ 均勻挑 MAX_SAMPLES 段，每段的 MU 分給最近的取樣
        picks = np.linspace(0, len(segs) - 1, min(MAX_SAMPLES, len(segs))).round().astype(int)
        mu_of = np.zeros(len(picks))
        for si, (_a, _b, mu) in enumerate(segs):
            mu_of[int(np.argmin(np.abs(picks - si)))] += mu
        for p_idx, si in enumerate(picks):
            a, b, _ = segs[si]
            cp = interpolate(a, b, 0.5)
            acc[body] += mu_of[p_idx] * _beamlet(beam, cp, pts[body], rho, ct_w2i)
            done += 1
            progress("calculating", 100.0 * done / max(1, total_samples), f"{beam.name}")
        per_beam[beam.number] = (acc * MU_PER_GY * inp.delivery.fractions).reshape(nk, nj, ni).astype(np.float32)
    dose = np.sum(list(per_beam.values()), axis=0) if per_beam else np.zeros((nk, nj, ni), np.float32)
    # 不確定度是假的（固定 1%）：只為了讓載回、摘要、不確定度圖這條路在沒有 Monte Carlo 的地方也走得到
    unc = np.where(dose > 0, FAKE_UNCERTAINTY, np.nan).astype(np.float32)
    return CalcResult(
        dose_gy=dose.astype(np.float32),
        uncertainty=unc,
        per_beam_gy=per_beam,
        info={
            "engine": "pipeline-test",
            "engine_version": ENGINE_VERSION,
            "seconds": round(time.time() - t0, 2),
            "histories": 0,
            "dose_quantity": "none (pipeline test)",
            "calibration": conv.info,
            "notes": ["流程測試引擎：不是劑量計算"],
        },
    )


def _sample(vol: np.ndarray, w2i: np.ndarray, pts: np.ndarray) -> np.ndarray:
    idx = pts @ w2i[:3, :3].T + w2i[:3, 3]
    return map_coordinates(vol, [idx[:, 2], idx[:, 1], idx[:, 0]], order=1, mode="constant", cval=0.0, prefilter=False)


def _beamlet(beam: Any, cp: Any, pts: np.ndarray, rho: np.ndarray, ct_w2i: np.ndarray) -> np.ndarray:
    src = beam.source_lps(cp)
    r = bld_to_lps(cp.gantry_deg, cp.collimator_deg, cp.couch_deg, beam.patient_position)
    v = (pts - src) @ r  # BLD 座標（z 朝射源 → 往病人是負的）
    along = -v[:, 2]
    ok = along > 1.0
    x_iso = np.where(ok, v[:, 0] * beam.sad_mm / np.maximum(along, 1.0), 1e9)
    y_iso = np.where(ok, v[:, 1] * beam.sad_mm / np.maximum(along, 1.0), 1e9)
    fluence = np.where(aperture_open(beam, cp, x_iso, y_iso), 1.0, TRANSMISSION)
    # 放射深度：從這一點往射源走，累積密度 × 步長（走到 CT 網格外為止）
    to_src = src - pts
    dist = np.linalg.norm(to_src, axis=1)
    unit = to_src / np.maximum(dist, 1e-9)[:, None]
    depth = np.zeros(pts.shape[0])
    for s in np.arange(STEP_MM / 2, 600.0, STEP_MM):
        q = pts + unit * s
        d = _sample(rho, ct_w2i, q)
        if not np.any(d > 0):
            break
        depth += d * STEP_MM * (s < dist)
    buildup = 1.0 - np.exp(-depth / BUILDUP_MM)
    return fluence * (beam.sad_mm / np.maximum(along, 1.0)) ** 2 * np.exp(-MU_ATTENUATION_PER_MM * depth) * buildup
