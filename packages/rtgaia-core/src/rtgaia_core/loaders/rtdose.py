"""RTDOSE 載入：劑量是 F1 純量場的一個實例，有**自己的網格**。

劑量網格與影像網格幾乎永遠不同（間距 2.5 mm、原點不同、frame 數不同），因此
它以自己的 `Grid` 進入空間、靠同一個 FoR 的 FrameGroup 對齊 —— **不重採樣到 CT
網格**（「display grid 全會話共用」講的是顯示，不是資料）。

## 三件 RTDOSE 才會遇到的事

1. **第三軸的間距藏在 `GridFrameOffsetVector`**，不是 `SliceThickness`。它可以是
   遞減的（此時法線要反向），也可以不等距（此時**必須報錯**，與 CT 的 DL12 同理）。
   而且它有**兩種編碼**（PS3.3 C.8.8.3.2）：首項為 0 → 各 frame 相對 IPP 的位移；
   首項不為 0 → 各 frame 的**病人座標 z 絕對值**（只在 axial 方向合法）。
   🔴 先前一律 `IPP + normal * gfov[0]`，絕對編碼被多加一次
   位移 —— IPP `[4,5,6]`、GFOV `[6,8,10]` 算出原點 `[4,5,12]`，劑量場整個平移、DVH
   取樣位置錯，畫面不會報錯。判據「首項是否為 0」是規範給的，不是我們的偏好：
   0 既是合法位移也是合法絕對 z，兩種編碼在那一點無法區分，所以規範用它當旗標。
   不合法的組合（絕對編碼但 IOP 非 axial、絕對 z 與 IPP.z 不符）一律拒絕，不猜。
2. **像素值要乘 `DoseGridScaling`** 才是 Gy。忘了乘的症狀不是報錯，而是等劑量線
   全部消失（值差五個數量級）。
3. `DoseUnits` 可能是 `GY` 或 `RELATIVE`。後者不是 Gy，讀數與等劑量線的單位都不同。
   載入器只**如實保留**（正規化大寫）；「不是 GY 就不做 Gy 統計」由 DVH 路由執行。
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Any

import numpy as np
import pydicom
from rtgaia_geom.errors import require
from rtgaia_geom.grid import Grid

GFOV_UNIFORM_TOL_MM = 0.01
GFOV_ZERO_TOL_MM = 1e-4
"""首項在這個範圍內視為 0（相對編碼）。DS 字串轉 float 的誤差遠小於此。"""
GFOV_ABSOLUTE_IPP_TOL_MM = 0.01
"""絕對編碼時 `gfov[0]` 必須等於 `IPP.z`（規範要求兩者一致）；容許 DS 精度。"""
AXIAL_NORMAL_TOL = 1e-6
DERIVED_DOSE_CODES = frozenset({"121370", "121378"})
"""PS3.16 CID 7220：Composed from prior doses／Composed with weighting for fractions delivered。"""


@dataclass(frozen=True)
class DoseHeader:
    path: Path
    sop_instance_uid: str
    series_instance_uid: str
    frame_of_reference_uid: str
    grid: Grid
    scaling: float
    units: str
    dose_type: str
    summation_type: str
    referenced_plan_sop_uids: tuple[str, ...]
    series_date: str
    series_description: str
    derivation_description: str = ""
    """RT-Gaia 劑量運算存回來的 RTDOSE 寫了運算鏈（`DerivationDescription`）；空 ＝ 一般 TPS 劑量。"""
    derived: bool = False
    """有 `DerivationCodeSequence`（CID 7220 的「由先前劑量組成」）。"""
    referenced_beams: tuple[tuple[int, int], ...] = ()
    """`(fraction group 號, beam 號)` —— BEAM 劑量是哪個計畫的哪個射束
    （ReferencedRTPlanSequence ＞ ReferencedFractionGroupSequence ＞ ReferencedBeamSequence）。"""

    @property
    def params(self) -> dict[str, Any]:
        """→ `Layer.params`（模組專屬參數的落點）。`max_gy` 在讀像素時補上。"""
        return {
            "units": self.units,
            "dose_grid_scaling": self.scaling,
            "dose_type": self.dose_type,
            "summation_type": self.summation_type,
            "referenced_plan_sop_uids": list(self.referenced_plan_sop_uids),
            "sop_instance_uid": self.sop_instance_uid,
            **({"referenced_beams": [list(x) for x in self.referenced_beams]} if self.referenced_beams else {}),
            **(
                {"saved_derivation": {"description": self.derivation_description}}
                if self.derived or self.derivation_description
                else {}
            ),
        }


def _floats(value: Any) -> list[float]:
    if value is None:
        return []
    try:
        return [float(v) for v in value]
    except TypeError:
        return [float(value)]


def read_dose_header(path: str | Path) -> DoseHeader:
    """只讀標頭，建出劑量網格。像素留給 `read_dose_pixels`（惰性）。"""
    p = Path(path)
    ds = pydicom.dcmread(str(p), stop_before_pixels=True)
    require(str(ds.get("Modality", "")) == "RTDOSE", "RD1", "不是 RTDOSE", path=str(p))

    iop = _floats(ds.get("ImageOrientationPatient"))
    ipp = _floats(ds.get("ImagePositionPatient"))
    spacing = _floats(ds.get("PixelSpacing"))
    gfov = _floats(ds.get("GridFrameOffsetVector"))
    rows, cols = int(ds.Rows), int(ds.Columns)
    frames = int(ds.get("NumberOfFrames", 1) or 1)
    require(len(iop) == 6 and len(ipp) == 3 and len(spacing) == 2, "RD2", "RTDOSE 缺少幾何欄位", path=str(p))

    row_dir = np.asarray(iop[0:3], dtype=np.float64)
    col_dir = np.asarray(iop[3:6], dtype=np.float64)
    row_dir /= np.linalg.norm(row_dir)
    col_dir /= np.linalg.norm(col_dir)
    normal = np.cross(row_dir, col_dir)

    if frames > 1:
        require(
            len(gfov) == frames,
            "RD3",
            "GridFrameOffsetVector 的長度與 NumberOfFrames 不符",
            gfov=len(gfov),
            frames=frames,
        )
        diffs = np.diff(gfov)
        step = float(np.median(diffs))
        require(step != 0.0, "RD4", "GridFrameOffsetVector 沒有增量", path=str(p))
        worst = float(np.max(np.abs(diffs - step)))
        require(
            worst <= GFOV_UNIFORM_TOL_MM,
            "RD5",
            "劑量網格第三軸不等距 —— 不是規則網格，不得默默取中位數",
            step=round(step, 6),
            worst_deviation_mm=round(worst, 6),
        )
        if step < 0:
            # 遞減的 offset：法線反向，網格仍是右手／左手皆可（G6 允許）
            normal = -normal
            step = -step
        spacing_z = step
        if abs(gfov[0]) <= GFOV_ZERO_TOL_MM:
            # 相對編碼：第一個 frame 就在 IPP
            origin = np.asarray(ipp, dtype=np.float64)
        else:
            # 絕對編碼：gfov 是病人 z；只在 axial 定義（法線 ∥ ±z）
            plane_normal = np.cross(row_dir, col_dir)
            require(
                abs(abs(float(plane_normal[2])) - 1.0) <= AXIAL_NORMAL_TOL,
                "RD7",
                "GridFrameOffsetVector 首項不為 0（絕對 z 編碼），但 IOP 不是 axial —— "
                "PS3.3 C.8.8.3.2 沒有定義這個組合，不猜",
                gfov0=float(gfov[0]),
                iop=[round(v, 6) for v in iop],
                path=str(p),
            )
            require(
                abs(float(gfov[0]) - float(ipp[2])) <= GFOV_ABSOLUTE_IPP_TOL_MM,
                "RD8",
                "GridFrameOffsetVector 首項（絕對 z）與 ImagePositionPatient 的 z 不一致",
                gfov0=float(gfov[0]),
                ipp_z=float(ipp[2]),
                path=str(p),
            )
            origin = np.asarray([ipp[0], ipp[1], float(gfov[0])], dtype=np.float64)
    else:
        spacing_z = float(ds.get("SliceThickness", 1.0) or 1.0)
        origin = np.asarray(ipp)

    direction = np.column_stack([row_dir, col_dir, normal]).flatten()
    for_uid = str(ds.get("FrameOfReferenceUID", "") or "")
    require(bool(for_uid), "RD6", "RTDOSE 缺少 FrameOfReferenceUID —— 沒有 FoR 就無法進入空間", path=str(p))

    grid = Grid(
        size=(cols, rows, frames),
        spacing=(float(spacing[1]), float(spacing[0]), float(spacing_z)),
        origin=(float(origin[0]), float(origin[1]), float(origin[2])),
        direction=tuple(float(v) for v in direction),  # type: ignore[arg-type]
        frame_of_reference_uid=for_uid,
    )
    return DoseHeader(
        path=p,
        sop_instance_uid=str(ds.get("SOPInstanceUID", "")),
        series_instance_uid=str(ds.get("SeriesInstanceUID", "")),
        frame_of_reference_uid=for_uid,
        grid=grid,
        # 🔴 不寫 `or 1.0`：DoseGridScaling=0 是壞資料，要讓路由看見（DOSE_SCALING_INVALID），不是默默當 1
        scaling=float(ds.get("DoseGridScaling", 1.0) if ds.get("DoseGridScaling") is not None else 1.0),
        units=str(ds.get("DoseUnits", "") or "").strip().upper(),
        dose_type=str(ds.get("DoseType", "") or ""),
        summation_type=str(ds.get("DoseSummationType", "") or ""),
        referenced_plan_sop_uids=tuple(
            str(x.ReferencedSOPInstanceUID) for x in ds.get("ReferencedRTPlanSequence", []) or []
        ),
        series_date=str(ds.get("SeriesDate", "") or ""),
        series_description=str(ds.get("SeriesDescription", "") or ""),
        derivation_description=str(ds.get("DerivationDescription", "") or ""),
        derived=any(
            str(c.get("CodeValue", "")) in DERIVED_DOSE_CODES for c in ds.get("DerivationCodeSequence", []) or []
        ),
        referenced_beams=_referenced_beams(ds),
    )


def _referenced_beams(ds: Any) -> tuple[tuple[int, int], ...]:
    out: list[tuple[int, int]] = []
    for rp in ds.get("ReferencedRTPlanSequence", []) or []:
        for fg in rp.get("ReferencedFractionGroupSequence", []) or []:
            try:
                group = int(fg.get("ReferencedFractionGroupNumber", 1) or 1)
            except (TypeError, ValueError):
                group = 1
            for b in fg.get("ReferencedBeamSequence", []) or []:
                try:
                    out.append((group, int(b.ReferencedBeamNumber)))
                except (AttributeError, TypeError, ValueError):
                    continue
    return tuple(out)


def read_dose_pixels(header: DoseHeader) -> np.ndarray:
    """`(k, j, i)` float32，已乘 `DoseGridScaling`（Gy）。"""
    ds = pydicom.dcmread(str(header.path))
    arr = ds.pixel_array
    if arr.ndim == 2:
        arr = arr[np.newaxis, ...]
    out = arr.astype(np.float32) * np.float32(header.scaling)
    nk, nj, ni = header.grid.size[2], header.grid.size[1], header.grid.size[0]
    require(
        out.shape == (nk, nj, ni),
        "RD7",
        "RTDOSE 像素的形狀與標頭宣告不符",
        pixels=list(out.shape),
        declared=[nk, nj, ni],
    )
    return np.ascontiguousarray(out)
