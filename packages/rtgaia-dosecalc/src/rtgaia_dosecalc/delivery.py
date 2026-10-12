"""要照射什麼：射束、控制點、jaw／MLC 開口 —— 引擎吃的格式（跟 DICOM 無關、可存成 JSON）。

## 座標（IEC 61217；跟 `rtgaia_core.beam_geometry` 的示意幾何同一套公式，這裡是照射用的嚴格版）

* IEC fixed：+X 從床尾看向機架時往右、+Y 往機架、+Z 往上。機架角 θ 繞 +Y 轉；θ = 0 射源在正上方。
* 治療床角 φ 繞垂直軸：病人跟著床轉 → 射源在床座標 ＝ R_z(−φ) · 射源。
* 病人擺位 → LPS：HFS 時 X → 病人左（+x）、Y → 頭（+z）、Z → 前（−y）；HFP、FFS、FFP 各自的矩陣。
* 射束限制裝置座標（BLD）：`x` 沿 X jaw／MLCX、`y` 沿 Y jaw、`z` 朝射源；機架 0、准直器 0 時與 IEC fixed 同向；
  准直器角 ψ 繞射束軸轉。jaw 與 MLC 的位置是**投影到等中心平面**的 mm（DICOM 的定義）。

**不支援就拒絕**（`check_beam`）：機架俯仰、床的 pitch／roll、楔形板、擋塊、補償器、bolus、電子／質子射束、
沒有 MLC 也沒有 jaw 的射束 —— 列出原因，不默默近似。
"""

from __future__ import annotations

from dataclasses import asdict, dataclass, field
from typing import Any

import numpy as np

PATIENT_TO_LPS: dict[str, np.ndarray] = {
    # 列 ＝ LPS 的 x、y、z；行 ＝ IEC fixed 的 X、Y、Z
    "HFS": np.array([[1, 0, 0], [0, 0, -1], [0, 1, 0]], dtype=np.float64),
    "FFS": np.array([[-1, 0, 0], [0, 0, -1], [0, -1, 0]], dtype=np.float64),
    "HFP": np.array([[-1, 0, 0], [0, 0, 1], [0, 1, 0]], dtype=np.float64),
    "FFP": np.array([[1, 0, 0], [0, 0, 1], [0, -1, 0]], dtype=np.float64),
}
DEFAULT_SAD_MM = 1000.0


def _rot_y(deg: float) -> np.ndarray:
    a = np.deg2rad(deg)
    c, s = np.cos(a), np.sin(a)
    return np.array([[c, 0, s], [0, 1, 0], [-s, 0, c]], dtype=np.float64)


def _rot_z(deg: float) -> np.ndarray:
    a = np.deg2rad(deg)
    c, s = np.cos(a), np.sin(a)
    return np.array([[c, -s, 0], [s, c, 0], [0, 0, 1]], dtype=np.float64)


def bld_to_lps(gantry_deg: float, collimator_deg: float, couch_deg: float, position: str) -> np.ndarray:
    """3×3：BLD 座標（x、y、z 朝射源）→ 病人 LPS 的方向。"""
    return PATIENT_TO_LPS[position] @ _rot_z(-couch_deg) @ _rot_y(gantry_deg) @ _rot_z(collimator_deg)


@dataclass
class ControlPoint:
    cumulative_mu: float
    """到這個控制點為止的累積 MU（射束的 MU × 累積權重 ÷ 最終權重）。"""
    gantry_deg: float
    collimator_deg: float
    couch_deg: float
    jaw_x: tuple[float, float]
    """X1、X2（等中心平面 mm；X1 是負側）。"""
    jaw_y: tuple[float, float]
    mlc_a: list[float] | None = None
    """每一對葉片 A 側（X1 側）的位置；None ＝ 沒有 MLC。"""
    mlc_b: list[float] | None = None


@dataclass
class Beam:
    number: int
    name: str
    energy_mv: float
    fluence_mode: str
    """`STANDARD` ／ `FFF`。"""
    sad_mm: float
    isocenter_lps: tuple[float, float, float]
    patient_position: str
    mu: float
    control_points: list[ControlPoint]
    leaf_boundaries_mm: list[float] | None = None
    """MLC 葉片的邊界（沿 y，`N+1` 個值）。"""
    machine: str = ""

    def source_lps(self, cp: ControlPoint) -> np.ndarray:
        r = bld_to_lps(cp.gantry_deg, 0.0, cp.couch_deg, self.patient_position)
        return np.asarray(self.isocenter_lps, dtype=np.float64) + r @ np.array([0.0, 0.0, self.sad_mm])


@dataclass
class Delivery:
    beams: list[Beam]
    fractions: int
    plan_label: str = ""
    plan_sop_uid: str = ""
    warnings: list[str] = field(default_factory=list)

    @property
    def total_mu(self) -> float:
        return float(sum(b.mu for b in self.beams))

    def to_wire(self) -> dict[str, Any]:
        return asdict(self)

    @classmethod
    def from_wire(cls, d: dict[str, Any]) -> Delivery:
        beams = []
        for b in d["beams"]:
            cps = [
                ControlPoint(
                    **{
                        **cp,
                        "jaw_x": tuple(cp["jaw_x"]),
                        "jaw_y": tuple(cp["jaw_y"]),
                    }
                )
                for cp in b["control_points"]
            ]
            beams.append(Beam(**{**b, "control_points": cps, "isocenter_lps": tuple(b["isocenter_lps"])}))
        return cls(
            beams=beams,
            fractions=int(d["fractions"]),
            plan_label=d.get("plan_label", ""),
            plan_sop_uid=d.get("plan_sop_uid", ""),
            warnings=list(d.get("warnings") or []),
        )


def segments(beam: Beam) -> list[tuple[ControlPoint, ControlPoint, float]]:
    """控制點兩兩一段 ＋ 這一段的 MU。靜態射束（只有一個 MU 不變的開始與結束）也是一段。"""
    out = []
    for a, b in zip(beam.control_points, beam.control_points[1:], strict=False):
        d_mu = b.cumulative_mu - a.cumulative_mu
        if d_mu > 0:
            out.append((a, b, d_mu))
    return out


def interpolate(a: ControlPoint, b: ControlPoint, t: float) -> ControlPoint:
    """兩個控制點之間 t ∈ [0, 1] 的狀態：機架走短的那邊（VMAT 跨 0°／360°）、jaw 與葉片線性內插；
    床與准直器在一段裡不變（DICOM 允許變，但弧照射不會，不支援的在 `check_beam` 擋）。"""
    dg = ((b.gantry_deg - a.gantry_deg + 180.0) % 360.0) - 180.0

    def lerp(x: Any, y: Any) -> Any:
        if x is None or y is None:
            return x if y is None else y
        return [u + (v - u) * t for u, v in zip(x, y, strict=True)]

    return ControlPoint(
        cumulative_mu=a.cumulative_mu + (b.cumulative_mu - a.cumulative_mu) * t,
        gantry_deg=(a.gantry_deg + dg * t) % 360.0,
        collimator_deg=a.collimator_deg,
        couch_deg=a.couch_deg,
        jaw_x=tuple(lerp(a.jaw_x, b.jaw_x)),  # type: ignore[arg-type]
        jaw_y=tuple(lerp(a.jaw_y, b.jaw_y)),  # type: ignore[arg-type]
        mlc_a=lerp(a.mlc_a, b.mlc_a),
        mlc_b=lerp(a.mlc_b, b.mlc_b),
    )


def aperture_open(beam: Beam, cp: ControlPoint, x_iso: np.ndarray, y_iso: np.ndarray) -> np.ndarray:
    """等中心平面上的點 (x, y)（BLD，mm）在不在開口裡：jaw 的矩形 ∩ MLC 那一列的開口。"""
    inside = (x_iso >= cp.jaw_x[0]) & (x_iso <= cp.jaw_x[1]) & (y_iso >= cp.jaw_y[0]) & (y_iso <= cp.jaw_y[1])
    if cp.mlc_a is None or cp.mlc_b is None or not beam.leaf_boundaries_mm:
        return inside
    bounds = np.asarray(beam.leaf_boundaries_mm, dtype=np.float64)
    row = np.searchsorted(bounds, y_iso, side="right") - 1
    valid = (row >= 0) & (row < len(cp.mlc_a))
    rc = np.clip(row, 0, len(cp.mlc_a) - 1)
    a = np.asarray(cp.mlc_a, dtype=np.float64)[rc]
    b = np.asarray(cp.mlc_b, dtype=np.float64)[rc]
    return inside & valid & (x_iso >= a) & (x_iso <= b)
