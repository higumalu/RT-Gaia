"""DRR（數位重建放射影像）：從 CT 沿「射源 → BEV 平面」的透視射線積分，當 BEV 的背景；
另把結構投影到同一個 BEV 平面（輪廓線）。

* **幾何**跟 `beam_geometry` 同一套（IEC 61217 示意）：射源 ＝ 等中心 ＋ SAD × BLD z、BEV 像素 (u, v) 在等中心平面
  ＝ 等中心 ＋ u·BLD x ＋ v·BLD y —— 所以 DRR 就在 BEV 的座標裡、跟著准直器轉。
* **衰減**：μ 相對水 ＝ max(0, (HU + 1000) / 1000)；線積分 Σ μ·ds（mm）。CT 先降採樣 2 倍（夠當背景，快很多）。
* **不支援的幾何要明確擋掉**：機架俯仰、床 pitch／roll ≠ 0、不認得的病人擺位 —— 不畫一張錯的圖。
* 預設：`soft`（1 − e^−kI，柔和）、`high`（高百分位窗 ＋ γ，骨頭清楚）、`raw`（線性 1–99 百分位）、
  `custom`（使用者的窗，0–1）。

這只是給人看懂射野與解剖的關係；不是驗證過的影像導引，也不做照野比對。
"""

from __future__ import annotations

from typing import Any

import numpy as np
from rtgaia_geom.grid import Grid

from .beam_geometry import SUPPORTED_POSITIONS, bld_to_lps

DRR_PRESETS = ("soft", "high", "raw", "custom")
DRR_SIZE_MIN, DRR_SIZE_MAX = 64, 384
DRR_SAMPLES = 160
RAY_CHUNK = 4096
UNSUPPORTED_TOL_DEG = 0.01


class UnsupportedGeometry(ValueError):
    """DRR 不支援這個控制點的幾何（機架俯仰、床 pitch／roll、擺位）。"""


def check_geometry(cp: dict[str, Any], position: str) -> None:
    problems = []
    for key, what in (
        ("gantry_pitch_deg", "機架俯仰"),
        ("table_pitch_deg", "床的 pitch"),
        ("table_roll_deg", "床的 roll"),
    ):
        v = cp.get(key)
        if v is not None and abs(float(v)) > UNSUPPORTED_TOL_DEG:
            problems.append(f"{what} {float(v):g}°")
    if position not in SUPPORTED_POSITIONS:
        problems.append(f"病人擺位 {position}")
    if problems:
        detail = "、".join(problems)
        raise UnsupportedGeometry(f"DRR 不支援：{detail}")


def attenuation_volume(hu_kji: np.ndarray, grid: Grid, factor: int = 2) -> tuple[np.ndarray, Grid]:
    """HU → μ（相對水），盒平均降採樣 `factor` 倍；回 (體積, 降採樣後的網格)。"""
    hu = np.asarray(hu_kji, dtype=np.float32)
    mu = np.clip((hu + 1000.0) / 1000.0, 0.0, None)
    if factor > 1:
        nk, nj, ni = (s // factor for s in mu.shape)
        mu = (
            mu[: nk * factor, : nj * factor, : ni * factor]
            .reshape(nk, factor, nj, factor, ni, factor)
            .mean(axis=(1, 3, 5))
        )
        spacing = tuple(float(s) * factor for s in grid.spacing)
        # 盒中心：新的第 0 個體素在原本 (factor − 1)/2 的位置
        origin = grid.index_to_world(np.array([(factor - 1) / 2.0] * 3))
        grid = Grid(
            size=(ni, nj, nk),
            spacing=spacing,  # type: ignore[arg-type]
            origin=tuple(float(v) for v in origin),  # type: ignore[arg-type]
            direction=grid.direction,
            frame_of_reference_uid=grid.frame_of_reference_uid,
        )
    return np.ascontiguousarray(mu, dtype=np.float32), grid


def bev_pixels_mm(size: int, half_mm: float) -> np.ndarray:
    """BEV 像素中心的 (u, v) mm；列 0 在 +v（畫面上方 ＝ Y2）。回 (size, size, 2)。"""
    c = (np.arange(size) + 0.5) / size * 2 * half_mm - half_mm
    u, v = np.meshgrid(c, -c)
    return np.stack([u, v], axis=-1)


def line_integrals(
    mu_kji: np.ndarray,
    grid: Grid,
    source_world: np.ndarray,
    targets_world: np.ndarray,
    samples: int = DRR_SAMPLES,
) -> np.ndarray:
    """每條射線（射源 → target，延伸穿過整個體積）的 Σ μ·ds（mm）。只在射線與體積相交的那段取樣。"""
    from scipy.ndimage import map_coordinates

    w2i = grid.world_to_index_matrix
    a = w2i[:3, :3] @ np.asarray(source_world, dtype=np.float64) + w2i[:3, 3]
    shape = np.array([grid.size[0], grid.size[1], grid.size[2]], dtype=np.float64)
    lo, hi = -0.5, shape - 0.5
    out = np.zeros(len(targets_world), dtype=np.float64)
    mm_per_index = np.linalg.norm((grid.direction_matrix * np.asarray(grid.spacing)), axis=0)  # 每軸 1 index 幾 mm
    for start in range(0, len(targets_world), RAY_CHUNK):
        t = np.asarray(targets_world[start : start + RAY_CHUNK], dtype=np.float64)
        b = t @ w2i[:3, :3].T + w2i[:3, 3]
        d = b - a  # 射源 → target（index 空間）；參數 s ∈ [0, ∞)
        with np.errstate(divide="ignore", invalid="ignore"):
            s1 = (lo - a) / d
            s2 = (hi - a) / d
        smin = np.where(np.isfinite(s1), np.minimum(s1, s2), -np.inf)
        smax = np.where(np.isfinite(s1), np.maximum(s1, s2), np.inf)
        # 平行於某軸、又在那軸範圍外的射線 → 不相交
        outside = (d == 0) & ((a < lo) | (a > hi))
        enter = np.max(np.where(d == 0, -np.inf, smin), axis=1).clip(min=0.0)
        exit_ = np.min(np.where(d == 0, np.inf, smax), axis=1)
        hit = (exit_ > enter) & ~outside.any(axis=1)
        if not hit.any():
            continue
        e, x, dd = enter[hit], exit_[hit], d[hit]
        # 🔴 每條射線固定取樣數、起點相位一樣 → 步長與體素大小打拍，整張圖出現斜向疊紋（2026-10-02 實測）。
        # 起點加上每條射線不同的確定性偏移（黃金比例序列），疊紋變成看不出來的細雜訊
        jitter = ((np.arange(len(e)) + start) * 0.6180339887) % 1.0
        frac = (np.arange(samples)[None, :] + jitter[:, None]) / samples
        s = e[:, None] + (x - e)[:, None] * frac  # (rays, samples)
        pts = a[None, None, :] + s[:, :, None] * dd[:, None, :]
        vals = map_coordinates(
            mu_kji, [pts[..., 2].ravel(), pts[..., 1].ravel(), pts[..., 0].ravel()], order=1, mode="nearest"
        ).reshape(s.shape)
        # 每一步的長度（mm）：index 空間的步長 × 每軸 mm
        step_mm = np.linalg.norm(dd * mm_per_index[None, :], axis=1) * (x - e) / samples
        idx = np.nonzero(hit)[0] + start
        out[idx] = vals.sum(axis=1) * step_mm
    return out


def drr(
    mu_kji: np.ndarray,
    grid: Grid,
    *,
    iso_world: Any,
    gantry_deg: float,
    collimator_deg: float,
    couch_deg: float,
    position: str,
    sad_mm: float,
    size: int,
    half_mm: float,
) -> np.ndarray:
    """BEV 平面的 DRR 線積分 `(size, size)`；`iso_world` 與 `grid` 同一個世界座標（CT 的 FoR ＝ 計畫的 FoR）。"""
    r = bld_to_lps(gantry_deg, collimator_deg, couch_deg, position)
    iso = np.asarray(iso_world, dtype=np.float64)
    source = iso + r[:, 2] * float(sad_mm)
    uv = bev_pixels_mm(size, half_mm).reshape(-1, 2)
    targets = iso[None, :] + uv[:, :1] * r[:, 0][None, :] + uv[:, 1:2] * r[:, 1][None, :]
    return line_integrals(mu_kji, grid, source, targets).reshape(size, size)


def apply_preset(img: np.ndarray, preset: str, window: tuple[float, float] | None = None) -> np.ndarray:
    """線積分 → 0–255 灰階。"""
    x = np.asarray(img, dtype=np.float64)
    pos = x[x > 0]
    if pos.size == 0:
        return np.zeros(x.shape, dtype=np.uint8)
    if preset == "soft":
        k = np.log(2.0) / max(float(np.median(pos)), 1e-6)  # 中位數 → 0.5
        y = 1.0 - np.exp(-k * x)
    elif preset == "high":
        lo, hi = np.percentile(pos, [40.0, 99.7])
        y = np.clip((x - lo) / max(hi - lo, 1e-6), 0.0, 1.0) ** 1.6
    else:
        lo, hi = np.percentile(pos, [1.0, 99.0])
        y = np.clip((x - lo) / max(hi - lo, 1e-6), 0.0, 1.0)
        if preset == "custom" and window is not None:
            c, w = window
            y = np.clip((y - (c - w / 2)) / max(w, 1e-6), 0.0, 1.0)
    return np.round(y * 255).astype(np.uint8)


def project_structure(
    points_world: np.ndarray,
    *,
    iso_world: Any,
    gantry_deg: float,
    collimator_deg: float,
    couch_deg: float,
    position: str,
    sad_mm: float,
    size: int,
    half_mm: float,
) -> list[list[list[float]]]:
    """結構表面點（與 iso 同一個世界座標）→ 透視投影到 BEV 平面 → 輪廓線（mm，(u, v)）。"""
    from scipy.ndimage import binary_dilation, binary_erosion, binary_fill_holes
    from skimage import measure

    if len(points_world) == 0:
        return []
    r = bld_to_lps(gantry_deg, collimator_deg, couch_deg, position)
    iso = np.asarray(iso_world, dtype=np.float64)
    source = iso + r[:, 2] * float(sad_mm)
    d = np.asarray(points_world, dtype=np.float64) - source
    depth = -(d @ r[:, 2])  # 沿射束方向（射源 → 等中心）的距離
    ok = depth > 1.0
    if not ok.any():
        return []
    scale = float(sad_mm) / depth[ok]
    u = (d[ok] @ r[:, 0]) * scale
    v = (d[ok] @ r[:, 1]) * scale
    px = ((u + half_mm) / (2 * half_mm) * size).astype(np.int64)
    py = ((half_mm - v) / (2 * half_mm) * size).astype(np.int64)
    keep = (px >= 0) & (px < size) & (py >= 0) & (py < size)
    occ = np.zeros((size, size), dtype=bool)
    occ[py[keep], px[keep]] = True
    # 表面點投影後是稀疏的點雲（點距 ≈ 幾個像素）：先膨脹連起來、填洞、再收回 —— 得到一個完整的投影外形，
    # 不是一堆小圈（2026-10-02 BODY 實測）
    grow = 3
    occ = binary_erosion(binary_fill_holes(binary_dilation(occ, iterations=grow)), iterations=grow)
    lines = []
    for c in measure.find_contours(occ.astype(np.float32), 0.5):
        if len(c) < 4:
            continue
        rows, cols = c[:, 0], c[:, 1]
        uu = (cols + 0.5) / size * 2 * half_mm - half_mm
        vv = half_mm - (rows + 0.5) / size * 2 * half_mm
        lines.append([[round(float(a), 2), round(float(b), 2)] for a, b in zip(uu, vv, strict=True)])
    return lines


def surface_points(block: np.ndarray, offset_ijk: Any, grid: Grid, max_points: int = 20000) -> np.ndarray:
    """mask 的表面體素中心（世界座標）；超過 `max_points` 均勻抽樣。"""
    from scipy.ndimage import binary_erosion

    m = np.asarray(block) > 0
    if not m.any():
        return np.zeros((0, 3))
    edge = m & ~binary_erosion(m)
    kk, jj, ii = np.nonzero(edge)
    if len(kk) > max_points:
        step = int(np.ceil(len(kk) / max_points))
        kk, jj, ii = kk[::step], jj[::step], ii[::step]
    ijk = np.stack([ii, jj, kk], axis=1).astype(np.float64) + np.asarray(offset_ijk, dtype=np.float64)
    return grid.index_to_world(ijk)
