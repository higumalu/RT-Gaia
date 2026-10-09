"""幾何：`Grid` ↔ JSON ↔ NIfTI，以及「兩個網格是否相同」（B3）。

🔴 **方向矩陣的慣例只有一種**：`direction` 是 row-major 3×3，第 c 欄是第 c 個索引軸的方向向量，
與 ITK `SetDirection` 一致。SimpleITK 的 array 順序是 `(k, j, i)`，這裡的所有 numpy 體積都用這個順序。
"""

from __future__ import annotations

import math
from pathlib import Path
from typing import Any

import numpy as np
import SimpleITK as sitk
from rtgaia_geom import Grid

SPACING_TOL_MM = 1e-3
ORIGIN_TOL_MM = 1e-3
DIRECTION_TOL = 1e-6


def grid_to_json(grid: Grid, *, with_for: bool = True) -> dict[str, Any]:
    out: dict[str, Any] = {
        "size": [int(v) for v in grid.size],
        "spacing": [float(v) for v in grid.spacing],
        "origin": [float(v) for v in grid.origin],
        "direction": [float(v) for v in grid.direction],
    }
    if with_for:
        out["frame_of_reference_uid"] = grid.frame_of_reference_uid
    return out


def grid_from_json(obj: dict[str, Any], *, frame_of_reference_uid: str | None = None) -> Grid:
    """`frame_of_reference_uid` 可由外層成員帶入（ImportBundle 的 `grid` 不含 FoR）。"""
    for_uid = obj.get("frame_of_reference_uid") or frame_of_reference_uid
    if not for_uid:
        raise ValueError("grid has no frame_of_reference_uid")
    return Grid(
        size=tuple(int(v) for v in obj["size"]),  # type: ignore[arg-type]
        spacing=tuple(float(v) for v in obj["spacing"]),  # type: ignore[arg-type]
        origin=tuple(float(v) for v in obj["origin"]),  # type: ignore[arg-type]
        direction=tuple(float(v) for v in obj["direction"]),  # type: ignore[arg-type]
        frame_of_reference_uid=for_uid,
    )


def grids_equal(a: Grid, b: Grid) -> str | None:
    """相同回 None，否則回一句可以直接顯示的原因（B3 要「拒收帶原因」）。"""
    if tuple(a.size) != tuple(b.size):
        return f"size differs: {list(a.size)} vs {list(b.size)}"
    for name, tol, va, vb in (
        ("spacing", SPACING_TOL_MM, a.spacing, b.spacing),
        ("origin", ORIGIN_TOL_MM, a.origin, b.origin),
        ("direction", DIRECTION_TOL, a.direction, b.direction),
    ):
        worst = max(abs(x - y) for x, y in zip(va, vb, strict=True))
        if worst > tol:
            return f"{name} differs by {worst:.3g} (tolerance {tol:g})"
    if a.frame_of_reference_uid != b.frame_of_reference_uid:
        return f"frame of reference differs: {a.frame_of_reference_uid} vs {b.frame_of_reference_uid}"
    return None


def to_sitk(volume: np.ndarray, grid: Grid) -> sitk.Image:
    if volume.shape != tuple(reversed(grid.size)):
        raise ValueError(f"volume shape {volume.shape} should be (k, j, i) = {tuple(reversed(grid.size))}")
    img = sitk.GetImageFromArray(np.ascontiguousarray(volume))
    img.SetSpacing([float(v) for v in grid.spacing])
    img.SetOrigin([float(v) for v in grid.origin])
    img.SetDirection([float(v) for v in grid.direction])
    return img


def from_sitk(img: sitk.Image, frame_of_reference_uid: str) -> tuple[np.ndarray, Grid]:
    arr = sitk.GetArrayFromImage(img)  # (k, j, i)
    grid = Grid(
        size=tuple(int(v) for v in img.GetSize()),  # type: ignore[arg-type]
        spacing=tuple(float(v) for v in img.GetSpacing()),  # type: ignore[arg-type]
        origin=tuple(float(v) for v in img.GetOrigin()),  # type: ignore[arg-type]
        direction=tuple(float(v) for v in img.GetDirection()),  # type: ignore[arg-type]
        frame_of_reference_uid=frame_of_reference_uid,
    )
    return arr, grid


def write_nifti(volume: np.ndarray, grid: Grid, path: str | Path) -> None:
    sitk.WriteImage(to_sitk(volume, grid), str(path), useCompression=str(path).endswith(".gz"))


def read_nifti(path: str | Path, *, frame_of_reference_uid: str) -> tuple[np.ndarray, Grid]:
    """NIfTI 不帶 FoR，要由呼叫端補（bundle 成員的 `frame_of_reference_uid`）。"""
    return from_sitk(sitk.ReadImage(str(path)), frame_of_reference_uid)


def nifti_bytes(volume: np.ndarray, grid: Grid, *, suffix: str = ".nii.gz") -> bytes:
    import tempfile

    with tempfile.TemporaryDirectory() as d:
        p = Path(d) / f"v{suffix}"
        write_nifti(volume, grid, p)
        return p.read_bytes()


def gzip_decoded_size_hint(data: bytes) -> int | None:
    """gzip 尾 4 bytes 的 ISIZE（解壓後大小 mod 2³²）；不是 gzip 就 None。

    在**解碼前**估 NIfTI 解壓後大小，超過配額就不解。ISIZE 會在 4 GiB 處繞回，所以這是
    「先擋掉明顯超限」的便宜檢查，不取代解碼後的實際計量。
    """
    if len(data) < 18 or data[:2] != b"\x1f\x8b":
        return None
    return int.from_bytes(data[-4:], "little")


def nifti_from_bytes(data: bytes, *, frame_of_reference_uid: str, suffix: str = ".nii.gz") -> tuple[np.ndarray, Grid]:
    import tempfile

    with tempfile.TemporaryDirectory() as d:
        p = Path(d) / f"v{suffix}"
        p.write_bytes(data)
        return read_nifti(p, frame_of_reference_uid=frame_of_reference_uid)


def is_orthonormal(direction: tuple[float, ...], tol: float = 1e-6) -> bool:
    m = np.asarray(direction, dtype=np.float64).reshape(3, 3)
    return bool(np.allclose(m.T @ m, np.eye(3), atol=tol)) and math.isclose(abs(np.linalg.det(m)), 1.0, abs_tol=1e-6)
