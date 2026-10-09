"""假體的影像內容產生器。

**逐 slice 產生，不一次算整個 volume 的世界座標。** `huge`（512×512×900）的世界
座標若一次算完是 5.7 GB 的 float64 —— 這裡的分塊不是最佳化，是可行性。
"""

from __future__ import annotations

import numpy as np
from rtgaia_core.dataset_io import phase_amplitude  # noqa: F401  合成影像與相位位移共用同一條曲線
from rtgaia_geom.grid import Grid

AIR_HU = -1000
LUNG_HU = -700
FAT_HU = -90
SOFT_HU = 40
BONE_HU = 900


def _slice_world(grid: Grid, k: int) -> np.ndarray:
    """第 k 層所有體素中心的世界座標，`(nj, ni, 3)`。"""
    ni, nj = int(grid.size[0]), int(grid.size[1])
    i = np.arange(ni, dtype=np.float64)
    j = np.arange(nj, dtype=np.float64)
    jj, ii = np.meshgrid(j, i, indexing="ij")
    pts = np.stack([ii.ravel(), jj.ravel(), np.full(ii.size, float(k))], axis=1)
    return grid.index_to_world(pts).reshape(nj, ni, 3)


BREATHING_HYSTERESIS = 0.15
"""呼吸滯後係數。

🔴 **不要用純 sin 當相位位移。** `sin(2πf/N)` 在相位 0 與 N/2 都是 0，於是
4DCT 的「吸氣末」與「吐氣末」會產生**一模一樣的影像**——播放看起來會動，但
任何「相位 A ≠ 相位 B」的測試都測不到東西。

正確的最小模型是 `(1-cos θ)/2`（0 在吸氣末、1 在吐氣末，其間單調）加上一個
滯後項，讓吸氣段與吐氣段經過同一位置時仍略有差異。滯後在真實呼吸運動中確實
存在，因此這不是為了讓測試通過而加的雜訊。
"""


def torso(grid: Grid, frame_index: int = 0) -> np.ndarray:
    """類軀幹的合成 CT：體表橢球 ＋ 兩葉低密度肺 ＋ 脊椎骨 ＋ 一顆高對比病灶。

    內容本身不是重點——**重點是它在世界座標中定義**，因此 `gantry_tilt` 與
    `oblique_acq` 上會呈現真正的傾斜，而不是同一張軸向影像。
    """
    ni, nj, nk = (int(v) for v in grid.size)
    out = np.full((nk, nj, ni), AIR_HU, dtype=np.int16)
    extent = np.asarray(grid.size, dtype=np.float64) * np.asarray(grid.spacing)
    center = grid.index_to_world([(n - 1) / 2 for n in grid.size])
    body_r = np.array([extent[0] * 0.36, extent[1] * 0.28, extent[2] * 0.48])
    lung_r = np.array([extent[0] * 0.12, extent[1] * 0.16, extent[2] * 0.30])
    lung_dx = extent[0] * 0.16
    # 呼吸相位：肺與病灶沿 z 移動（cyclic 軸的最小可信模型）
    phase_shift = np.array([0.0, 0.0, 6.0 * phase_amplitude(frame_index, 10)])

    for k in range(nk):
        w = _slice_world(grid, k)
        d = (w - center) / body_r
        rho = np.einsum("ijk,ijk->ij", d, d)
        body = rho <= 1.0
        sl = np.full((nj, ni), AIR_HU, dtype=np.int16)
        # 軟組織 ＋ 一點紋理，讓 WW/WL 與插值的差異看得出來
        texture = 12.0 * np.sin(w[:, :, 0] * 0.15) * np.cos(w[:, :, 1] * 0.11)
        sl[body] = (SOFT_HU + texture[body]).astype(np.int16)
        # 皮下脂肪環
        fat = body & (rho > 0.86)
        sl[fat] = FAT_HU
        # 兩葉肺
        for sign in (-1.0, 1.0):
            c = center + phase_shift + np.array([sign * lung_dx, -extent[1] * 0.04, 0.0])
            dl = (w - c) / lung_r
            lung = (np.einsum("ijk,ijk->ij", dl, dl) <= 1.0) & body
            sl[lung] = LUNG_HU
        # 脊椎（後方的骨柱）
        cb = center + np.array([0.0, extent[1] * 0.19, 0.0])
        db = (w - cb) / np.array([extent[0] * 0.055, extent[1] * 0.055, extent[2] * 0.6])
        sl[(np.einsum("ijk,ijk->ij", db, db) <= 1.0) & body] = BONE_HU
        # 高對比病灶（給量測與視窗調整一個明確目標）
        cl = center + phase_shift + np.array([extent[0] * 0.10, extent[1] * 0.06, 0.0])
        dn = (w - cl) / np.array([12.0, 12.0, 12.0])
        sl[(np.einsum("ijk,ijk->ij", dn, dn) <= 1.0) & body] = 260
        out[k] = sl
    return out


def gradient_with_landmark(
    grid: Grid,
    frame_index: int = 0,
    *,
    landmark_ijk: tuple[int, int, int] = (0, 0, 0),
    landmark_value: int = 3000,
) -> np.ndarray:
    """`landmark` 假體：平滑漸層底 ＋ 在已知 `(i,j,k)` 放唯一高值體素。

    漸層刻意做成**三軸都單調**，因此任何座標軸交換或翻轉都會立刻表現出來——
    比隨機雜訊有用得多。
    """
    ni, nj, nk = (int(v) for v in grid.size)
    i = np.arange(ni, dtype=np.float32)
    j = np.arange(nj, dtype=np.float32)
    k = np.arange(nk, dtype=np.float32)
    vol = (i[None, None, :] * 1.0 + j[None, :, None] * 3.0 + k[:, None, None] * 7.0 - 500.0).astype(np.int16)
    vol[landmark_ijk[2], landmark_ijk[1], landmark_ijk[0]] = landmark_value
    return vol


def geometry_blocks(grid: Grid, frame_index: int = 0) -> np.ndarray:
    """`known_geometry`：均勻背景 ＋ 球與立方體的影像對應物 ＋ 兩個標記點。

    影像本身只是讓畫面上看得到東西；**數值真值在結構與 markers 上**。
    """
    from .library import KNOWN_GEOMETRY_CUBE, KNOWN_GEOMETRY_MARKERS, KNOWN_GEOMETRY_SPHERE
    from .shapes import rasterize

    ni, nj, nk = (int(v) for v in grid.size)
    out = np.full((nk, nj, ni), -800, dtype=np.int16)
    for shape, hu in ((KNOWN_GEOMETRY_SPHERE, 300), (KNOWN_GEOMETRY_CUBE, 120)):
        r = rasterize(shape, grid)
        if r is None:
            continue
        offset, size, block = r
        region = out[
            offset[2] : offset[2] + size[2],
            offset[1] : offset[1] + size[1],
            offset[0] : offset[0] + size[0],
        ]
        region[block.astype(bool)] = hu
    for marker in KNOWN_GEOMETRY_MARKERS:
        ijk = grid.world_to_nearest_voxel(marker)
        if np.all(ijk >= 0) and np.all(ijk < np.asarray(grid.size)):
            out[int(ijk[2]), int(ijk[1]), int(ijk[0])] = 3000
    return out
