"""時間軸裡網格跟第一幀不同的相位 —— 重新取樣到第一幀的網格（預設仍是排除；使用者選了才做）。

4DCT 各相位不一致最常見的兩種（Pinnacle 論壇、synth4d ct6）都只差在**切片位置**：某一相位少一片（間距不均勻，
`series_geometry` 依 DL12 拒絕）、或整個相位沿 z 位移半片。平面幾何（列、欄、方向、像素間距、平面內位置）完全一樣。
這種情況逐片沿參考法線線性內插就好（平面內不動、不模糊），`SliceStack` 處理；
平面幾何也不同的，由呼叫端退回三線性重新取樣（`dose_ops.resample_onto`，要那一幀本身是規則網格）。
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Any

import numpy as np
from rtgaia_geom.grid import Grid

from .dicom import SeriesFile, _read_slice

PLANE_TOL_MM = 0.05
"""平面內位置、像素間距一樣的容許值（mm）。"""
IOP_TOL = 1e-4
MAX_GAP_FACTOR = 2.5
"""內插時兩片之間最多可以差幾個參考片厚（缺一片 ＝ 2 倍）；再大就不內插、補最小值（不編造影像）。"""

_INT16_MIN, _INT16_MAX = -32768.0, 32767.0


@dataclass(frozen=True)
class SliceStack:
    """跟參考幀同一個平面幾何、但切片位置不同的一幀：檔案依參考法線排序，`z` ＝ 每片沿參考法線的位置。"""

    files: tuple[SeriesFile, ...]
    z: tuple[float, ...]


def _axes(ref: Grid) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    m = np.asarray(ref.direction, dtype=np.float64).reshape(3, 3)
    return m[:, 0], m[:, 1], m[:, 2]


def slice_stack(headers: list[Any], ref: Grid) -> SliceStack | None:
    """這一幀能不能逐片內插到 `ref`：列、欄、方向、像素間距、平面內位置都跟 `ref` 一樣 → `SliceStack`；否則 None。"""
    if not headers:
        return None
    row, col, normal = _axes(ref)
    origin = np.asarray(ref.origin, dtype=np.float64)
    files: list[SeriesFile] = []
    for h in headers:
        if int(h.columns or 0) != int(ref.size[0]) or int(h.rows or 0) != int(ref.size[1]):
            return None
        if h.frame_number is not None or len(h.image_orientation_patient) != 6 or len(h.image_position_patient) != 3:
            return None
        iop = np.asarray(h.image_orientation_patient, dtype=np.float64)
        if np.max(np.abs(iop[:3] - row)) > IOP_TOL or np.max(np.abs(iop[3:] - col)) > IOP_TOL:
            return None
        ps = [float(v) for v in h.pixel_spacing]
        if len(ps) != 2 or abs(ps[1] - ref.spacing[0]) > PLANE_TOL_MM or abs(ps[0] - ref.spacing[1]) > PLANE_TOL_MM:
            return None
        pos = np.asarray(h.image_position_patient, dtype=np.float64)
        d = pos - origin
        if abs(float(d @ row)) > PLANE_TOL_MM or abs(float(d @ col)) > PLANE_TOL_MM:
            return None
        proj = float(pos @ normal)
        files.append(SeriesFile(path=Path(h.path), sop_instance_uid=h.sop_instance_uid, position=pos, projection=proj))
    files.sort(key=lambda f: f.projection)
    z = [f.projection for f in files]
    if any(b - a < 1e-3 for a, b in zip(z, z[1:], strict=False)):
        return None  # 同一個位置兩片（兩個序列混在一起）
    return SliceStack(files=tuple(files), z=tuple(z))


def _ref_z(ref: Grid) -> np.ndarray:
    _row, _col, normal = _axes(ref)
    return float(np.asarray(ref.origin) @ normal) + np.arange(int(ref.size[2])) * float(ref.spacing[2])


def read_slice_stack(stack: SliceStack, ref: Grid) -> np.ndarray:
    """參考網格每一片：剛好有那個位置的片 → 原樣；夾在兩片之間（差不到 `MAX_GAP_FACTOR` 片厚）→ 線性內插；
    其他（超出這一幀的範圍、缺太多）→ 這一幀的最小值。回 `(k, j, i)` int16。"""
    zs = np.asarray(stack.z)
    out = np.empty((int(ref.size[2]), int(ref.size[1]), int(ref.size[0])), dtype=np.int16)
    cache: dict[int, np.ndarray] = {}
    checked: set[Path] = set()

    def plane(i: int) -> np.ndarray:
        if i not in cache:
            cache[i] = _read_slice(stack.files[i], checked).astype(np.float32)
        return cache[i]

    max_gap = MAX_GAP_FACTOR * float(ref.spacing[2])
    fill: float | None = None
    holes: list[int] = []
    for k, z in enumerate(_ref_z(ref)):
        j = int(np.searchsorted(zs, z))
        if j < len(zs) and abs(zs[j] - z) < 1e-3:
            values = plane(j)
        elif j > 0 and abs(zs[j - 1] - z) < 1e-3:
            values = plane(j - 1)
        elif 0 < j < len(zs) and zs[j] - zs[j - 1] <= max_gap:
            w = (z - zs[j - 1]) / (zs[j] - zs[j - 1])
            values = (1.0 - w) * plane(j - 1) + w * plane(j)
        else:
            holes.append(k)
            continue
        fill = float(values.min()) if fill is None else min(fill, float(values.min()))
        out[k] = np.clip(np.rint(values), _INT16_MIN, _INT16_MAX).astype(np.int16)
    for k in holes:
        out[k] = np.int16(fill if fill is not None else 0)
    return out


def stack_sops(stack: SliceStack, ref: Grid) -> tuple[str, ...]:
    """匯出 RS 引用：參考網格每一片對到這一幀最近的一片（半片厚以內）；有一片對不到 → ()（匯出用合成參照）。"""
    zs = np.asarray(stack.z)
    tol = 0.5 * float(ref.spacing[2]) + 1e-6
    out: list[str] = []
    for z in _ref_z(ref):
        j = int(np.argmin(np.abs(zs - z)))
        if abs(float(zs[j]) - z) > tol:
            return ()
        out.append(stack.files[j].sop_instance_uid)
    return tuple(out)
