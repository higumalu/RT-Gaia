"""高品質斜面重切。

> **這是後端 SimpleITK 在本架構中不可取代的角色之一。**
> 後端有 ≥ 12 GB VRAM 與 ≥ 64 GB RAM，這個端點在毫秒級即可完成，
> **因此可以對所有 Tier 常態啟用**，不只是畫質補強的選配。Tier C 尤其倚賴它。

與 Tier C 前端的 WASM 核心（`rtgaia-reslice`）分工：
* 前端核心 = **互動中**的三線性取樣，維持手感
* 本模組 = **停止互動後**的 B-spline 補強，畫質
兩者對同一個 `ViewReference` 必須落在同一塊空間——這由 `plane_reference_image`
與核心共用同一套平面基底保證（`up = -view_up`）。
"""

from __future__ import annotations

from typing import Literal

import numpy as np
import SimpleITK as sitk
from rtgaia_geom import ViewReference
from rtgaia_geom.grid import Grid

Interpolator = Literal["nearest", "linear", "bspline"]

_SITK_INTERP = {
    "nearest": sitk.sitkNearestNeighbor,
    "linear": sitk.sitkLinear,
    "bspline": sitk.sitkBSpline,
}


def to_sitk_image(volume: np.ndarray, grid: Grid) -> sitk.Image:
    img = sitk.GetImageFromArray(np.ascontiguousarray(volume))
    img.SetSpacing([float(v) for v in grid.spacing])
    img.SetOrigin([float(v) for v in grid.origin])
    img.SetDirection([float(v) for v in grid.direction])
    return img


def plane_reference_image(
    view: ViewReference,
    *,
    out_size_px: tuple[int, int],
    px_mm: float,
    dtype=sitk.sitkFloat32,
) -> sitk.Image:
    """輸出平面的參考影像（size (w, h, 1)）。

    🔴 `direction` 的三個**欄**依序是 x 軸（right）、y 軸（列增加方向 = `-view_up`）、
    z 軸（normal）。與 `rtgaia_geom.kernel.plane_desc` 完全同一個慣例；
    寫錯的症狀是上下顛倒或左右鏡射，而在對稱假體上看不出來。
    """
    w, h = int(out_size_px[0]), int(out_size_px[1])
    right = np.asarray(view.right, dtype=np.float64)
    rows = -np.asarray(view.up, dtype=np.float64)
    normal = np.asarray(view.view_plane_normal, dtype=np.float64)
    origin = (
        np.asarray(view.plane_origin, dtype=np.float64) - right * (w - 1) / 2.0 * px_mm - rows * (h - 1) / 2.0 * px_mm
    )
    ref = sitk.Image(w, h, 1, dtype)
    ref.SetSpacing([px_mm, px_mm, max(view.slab_thickness_mm, 1e-3)])
    ref.SetOrigin([float(v) for v in origin])
    ref.SetDirection(
        [
            right[0],
            rows[0],
            normal[0],
            right[1],
            rows[1],
            normal[1],
            right[2],
            rows[2],
            normal[2],
        ]
    )
    return ref


def reslice_plane(
    volume: np.ndarray,
    grid: Grid,
    view: ViewReference,
    *,
    out_size_px: tuple[int, int],
    px_mm: float,
    interpolator: Interpolator = "bspline",
    outside: float = -1024.0,
) -> np.ndarray:
    """回傳 `(h, w)` float32 的單張 2D 切面。"""
    img = sitk.Cast(to_sitk_image(volume, grid), sitk.sitkFloat32)
    ref = plane_reference_image(view, out_size_px=out_size_px, px_mm=px_mm)
    out = sitk.Resample(
        img,
        ref,
        sitk.Transform(),
        _SITK_INTERP[interpolator],
        float(outside),
        sitk.sitkFloat32,
    )
    arr = sitk.GetArrayFromImage(out)
    return np.ascontiguousarray(arr.reshape(int(out_size_px[1]), int(out_size_px[0])), dtype=np.float32)
