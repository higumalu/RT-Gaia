"""世界座標中的解析形狀 —— 假體的體素化來源。

🔴 **形狀一律定義在世界座標（LPS mm），不是索引座標。**
這不是風格問題：`gantry_tilt` 與 `oblique_acq` 的價值就在於「一顆真正的球，
在傾斜的取像網格上會是斜的」。若形狀定義在索引空間，這兩個假體就退化成
`axial_clean`，**漏傳 `direction` 的 bug 也就測不到了**。

體素化只在形狀的索引空間 bounding box 內評估，因此 182 個結構
（`many_structs`）不會各自配置一份全網格陣列。
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Protocol

import numpy as np
from rtgaia_geom.grid import Grid, Int3


class Shape(Protocol):
    """能回答「世界座標這一點在不在裡面」與「我的世界包圍盒」。"""

    def world_bounds(self) -> tuple[np.ndarray, np.ndarray]: ...

    def contains(self, points_world: np.ndarray) -> np.ndarray: ...

    @property
    def analytic_volume_mm3(self) -> float: ...


@dataclass(frozen=True)
class Sphere:
    center: tuple[float, float, float]
    radius_mm: float

    def world_bounds(self) -> tuple[np.ndarray, np.ndarray]:
        c = np.asarray(self.center, dtype=np.float64)
        r = np.full(3, self.radius_mm, dtype=np.float64)
        return c - r, c + r

    def contains(self, points_world: np.ndarray) -> np.ndarray:
        d = points_world - np.asarray(self.center, dtype=np.float64)
        return np.einsum("ij,ij->i", d, d) <= self.radius_mm**2

    @property
    def analytic_volume_mm3(self) -> float:
        return 4.0 / 3.0 * np.pi * self.radius_mm**3


@dataclass(frozen=True)
class Ellipsoid:
    center: tuple[float, float, float]
    radii_mm: tuple[float, float, float]

    def world_bounds(self) -> tuple[np.ndarray, np.ndarray]:
        c = np.asarray(self.center, dtype=np.float64)
        r = np.asarray(self.radii_mm, dtype=np.float64)
        return c - r, c + r

    def contains(self, points_world: np.ndarray) -> np.ndarray:
        d = (points_world - np.asarray(self.center)) / np.asarray(self.radii_mm)
        return np.einsum("ij,ij->i", d, d) <= 1.0

    @property
    def analytic_volume_mm3(self) -> float:
        return 4.0 / 3.0 * np.pi * float(np.prod(self.radii_mm))


@dataclass(frozen=True)
class Box:
    """世界座標軸對齊的方盒（`known_geometry` 的立方體）。"""

    center: tuple[float, float, float]
    size_mm: tuple[float, float, float]

    def world_bounds(self) -> tuple[np.ndarray, np.ndarray]:
        c = np.asarray(self.center, dtype=np.float64)
        h = np.asarray(self.size_mm, dtype=np.float64) / 2.0
        return c - h, c + h

    def contains(self, points_world: np.ndarray) -> np.ndarray:
        lo, hi = self.world_bounds()
        return np.all((points_world >= lo) & (points_world <= hi), axis=1)

    @property
    def analytic_volume_mm3(self) -> float:
        return float(np.prod(self.size_mm))


@dataclass(frozen=True)
class Cylinder:
    """沿世界 z 軸的圓柱（脊髓一類的細長結構）。"""

    center: tuple[float, float, float]
    radius_mm: float
    length_mm: float

    def world_bounds(self) -> tuple[np.ndarray, np.ndarray]:
        c = np.asarray(self.center, dtype=np.float64)
        r = np.array([self.radius_mm, self.radius_mm, self.length_mm / 2.0])
        return c - r, c + r

    def contains(self, points_world: np.ndarray) -> np.ndarray:
        d = points_world - np.asarray(self.center)
        radial = d[:, 0] ** 2 + d[:, 1] ** 2 <= self.radius_mm**2
        return radial & (np.abs(d[:, 2]) <= self.length_mm / 2.0)

    @property
    def analytic_volume_mm3(self) -> float:
        return float(np.pi * self.radius_mm**2 * self.length_mm)


@dataclass(frozen=True)
class Union:
    """成對器官（Lung_L ∪ Lung_R = Lungs）用。"""

    parts: tuple[Shape, ...]

    def world_bounds(self) -> tuple[np.ndarray, np.ndarray]:
        bounds = [p.world_bounds() for p in self.parts]
        lo = np.min([b[0] for b in bounds], axis=0)
        hi = np.max([b[1] for b in bounds], axis=0)
        return lo, hi

    def contains(self, points_world: np.ndarray) -> np.ndarray:
        out = np.zeros(len(points_world), dtype=bool)
        for p in self.parts:
            out |= p.contains(points_world)
        return out

    @property
    def analytic_volume_mm3(self) -> float:
        """⚠️ 只有在各部分**不相交**時才等於總和。成對器官符合這個條件。"""
        return float(sum(p.analytic_volume_mm3 for p in self.parts))


def index_bbox(shape: Shape, grid: Grid, *, pad: int = 1) -> tuple[Int3, Int3] | None:
    """形狀在網格索引空間的 bounding box，已裁到網格範圍內。

    做法是把世界包圍盒的 8 個角轉進索引空間再取 min/max —— **傾斜網格下不能只
    轉兩個角**，那會漏掉一部分。
    """
    lo, hi = shape.world_bounds()
    corners = np.array(
        [
            [lo[0], lo[1], lo[2]],
            [hi[0], lo[1], lo[2]],
            [lo[0], hi[1], lo[2]],
            [hi[0], hi[1], lo[2]],
            [lo[0], lo[1], hi[2]],
            [hi[0], lo[1], hi[2]],
            [lo[0], hi[1], hi[2]],
            [hi[0], hi[1], hi[2]],
        ]
    )
    idx = grid.world_to_index(corners)
    start = np.floor(idx.min(axis=0)).astype(np.int64) - pad
    end = np.ceil(idx.max(axis=0)).astype(np.int64) + pad + 1
    start = np.maximum(start, 0)
    end = np.minimum(end, np.asarray(grid.size, dtype=np.int64))
    if np.any(end <= start):
        return None
    return (
        (int(start[0]), int(start[1]), int(start[2])),
        (int(end[0] - start[0]), int(end[1] - start[1]), int(end[2] - start[2])),
    )


def rasterize(shape: Shape, grid: Grid) -> tuple[Int3, Int3, np.ndarray] | None:
    """把形狀體素化成**已裁切到 bbox** 的 uint8 區塊。

    回傳 `(offset_ijk, size_ijk, block)`，`block` 為 numpy `(k, j, i)` 排列。
    形狀完全落在網格外時回傳 None。
    """
    box = index_bbox(shape, grid)
    if box is None:
        return None
    offset, size = box
    i = np.arange(offset[0], offset[0] + size[0], dtype=np.float64)
    j = np.arange(offset[1], offset[1] + size[1], dtype=np.float64)
    k = np.arange(offset[2], offset[2] + size[2], dtype=np.float64)
    kk, jj, ii = np.meshgrid(k, j, i, indexing="ij")
    pts = np.stack([ii.ravel(), jj.ravel(), kk.ravel()], axis=1)
    world = grid.index_to_world(pts)
    inside = shape.contains(world).reshape(size[2], size[1], size[0])
    if not inside.any():
        return None
    # 再裁一次：pad 讓 bbox 比實際佔用大一圈
    nz = np.nonzero(inside)
    k0, k1 = int(nz[0].min()), int(nz[0].max())
    j0, j1 = int(nz[1].min()), int(nz[1].max())
    i0, i1 = int(nz[2].min()), int(nz[2].max())
    block = np.ascontiguousarray(inside[k0 : k1 + 1, j0 : j1 + 1, i0 : i1 + 1].astype(np.uint8))
    return (
        (offset[0] + i0, offset[1] + j0, offset[2] + k0),
        (i1 - i0 + 1, j1 - j0 + 1, k1 - k0 + 1),
        block,
    )


def rasterize_dense(shape: Shape, grid: Grid) -> np.ndarray:
    """體素化成全網格陣列。**只給小網格用**——512×512×100 就是 26 MB。"""
    out = np.zeros((grid.size[2], grid.size[1], grid.size[0]), dtype=np.uint8)
    r = rasterize(shape, grid)
    if r is None:
        return out
    offset, size, block = r
    out[
        offset[2] : offset[2] + size[2],
        offset[1] : offset[1] + size[1],
        offset[0] : offset[0] + size[0],
    ] = block
    return out
