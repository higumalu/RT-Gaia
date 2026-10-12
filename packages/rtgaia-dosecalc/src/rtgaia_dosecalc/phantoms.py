"""假體：HU 體積 ＋ 網格，給引擎驗證與測試用（劑量計算版的「合成測資」）。

* `water_box`：整塊水（0 HU），外面一圈空氣（−1000 HU）可選。
* `slab`：沿病人前後（LPS y）疊的板 —— 水 / 肺 / 水、水 / 骨 / 水；異質界面的經典驗證案例
  （射束從前方 AP 照進來時，深度方向就是 +y）。

HU 是給 CT 校正曲線換算的：0 → 1.018 g/cm³（Schneider 2000 在 0 HU 的值，不是 1.000）；要純水密度的比對用
使用者曲線把 0 HU 對到 1.000。
"""

from __future__ import annotations

import numpy as np
from rtgaia_geom import Grid

LUNG_HU = -700.0
BONE_HU = 1000.0
AIR_HU = -1000.0


def _grid(size_mm: tuple[float, float, float], spacing_mm: float, for_uid: str) -> Grid:
    n = tuple(max(1, int(round(s / spacing_mm))) for s in size_mm)
    origin = tuple(-(k - 1) * spacing_mm / 2 for k in n)
    return Grid(
        size=n,  # type: ignore[arg-type]
        spacing=(spacing_mm,) * 3,
        origin=origin,  # type: ignore[arg-type]
        direction=(1, 0, 0, 0, 1, 0, 0, 0, 1),
        frame_of_reference_uid=for_uid,
    )


def water_box(
    size_mm: tuple[float, float, float] = (300.0, 300.0, 300.0),
    spacing_mm: float = 5.0,
    *,
    air_margin_mm: float = 0.0,
    for_uid: str = "1.2.826.0.1.3680043.10.1125.1",
) -> tuple[np.ndarray, Grid]:
    """中心在原點的水箱；`air_margin_mm` > 0 時外面包一圈空氣（射束從空氣進水，表面劑量才正確）。"""
    total = tuple(s + 2 * air_margin_mm for s in size_mm)
    g = _grid(total, spacing_mm, for_uid)  # type: ignore[arg-type]
    hu = np.zeros(tuple(reversed(g.size)), dtype=np.float32)
    if air_margin_mm > 0:
        world = _centers(g)
        half = np.asarray(size_mm) / 2
        inside = np.all(np.abs(world) <= half + 1e-6, axis=-1)
        hu[~inside] = AIR_HU
    return hu, g


def slab(
    insert_hu: float,
    *,
    insert_from_mm: float = 30.0,
    insert_to_mm: float = 90.0,
    size_mm: tuple[float, float, float] = (300.0, 300.0, 300.0),
    spacing_mm: float = 5.0,
    air_margin_mm: float = 20.0,
    for_uid: str = "1.2.826.0.1.3680043.10.1125.2",
) -> tuple[np.ndarray, Grid]:
    """水箱，前表面以下 `insert_from_mm`–`insert_to_mm` 深是另一種材質（肺 −700 HU、骨 1000 HU）。
    前表面在 y ＝ −size_y／2（LPS 的 −y 是前）。"""
    hu, g = water_box(size_mm, spacing_mm, air_margin_mm=air_margin_mm, for_uid=for_uid)
    world = _centers(g)
    depth = world[..., 1] + size_mm[1] / 2
    inside = np.all(np.abs(world) <= np.asarray(size_mm) / 2 + 1e-6, axis=-1)
    hu[inside & (depth >= insert_from_mm) & (depth < insert_to_mm)] = insert_hu
    return hu, g


def _centers(g: Grid) -> np.ndarray:
    """(k, j, i, 3) 每個體素中心的 LPS。"""
    ni, nj, nk = g.size
    kk, jj, ii = np.meshgrid(np.arange(nk), np.arange(nj), np.arange(ni), indexing="ij")
    ijk = np.stack([ii, jj, kk], axis=-1).reshape(-1, 3).astype(np.float64)
    return g.index_to_world(ijk).reshape(nk, nj, ni, 3)
