"""射束幾何：射源位置、射束座標系、開口在病人座標的位置 —— 3D 射束與 2D 弧刻度共用。

**同一個空間**：全部換到 RTPLAN 的病人座標（DICOM LPS），再由呼叫端經 FrameGroup 換到 primary。

## 座標系（IEC 61217，示意）

* IEC fixed：+X 從床尾看向機架時往右、+Y 往機架、+Z 往上。機架角 θ 繞 +Y 轉；θ = 0 射源在正上方，θ = 90° 在 +X。
  射源 ＝ SAD ·（sin θ, 0, cos θ）。
* 治療床角 φ 繞垂直軸（+Z）：病人跟著床轉 → 射源在床座標 ＝ R_z(−φ) · 射源。
* 病人擺位 → LPS（`PATIENT_TO_LPS`）：HFS 時 X → 病人左（+x）、Y → 頭（+z）、Z → 前（−y）。
* 射束限制裝置座標（BLD，`x` 沿 X jaw／MLCX、`y` 沿 Y jaw、`z` 朝射源）：
  機架 0、准直器 0 時與 IEC fixed 的 X、Y、Z 同向；准直器角 ψ 繞射束軸（BLD z）轉。

⚠️ 這是「看懂計畫」用的示意幾何：不處理機架俯仰、床的 pitch／roll、床的偏心，不做碰撞檢查，也不是照射模擬。
"""

from __future__ import annotations

from typing import Any

import numpy as np

PATIENT_TO_LPS: dict[str, np.ndarray] = {
    # 列 ＝ LPS 的 x、y、z；行 ＝ IEC fixed 的 X、Y、Z
    "HFS": np.array([[1, 0, 0], [0, 0, -1], [0, 1, 0]], dtype=np.float64),
    "FFS": np.array([[-1, 0, 0], [0, 0, -1], [0, -1, 0]], dtype=np.float64),
    "HFP": np.array([[-1, 0, 0], [0, 0, 1], [0, 1, 0]], dtype=np.float64),
    "FFP": np.array([[1, 0, 0], [0, 0, 1], [0, -1, 0]], dtype=np.float64),
}
SUPPORTED_POSITIONS = frozenset(PATIENT_TO_LPS)
DEFAULT_SAD_MM = 1000.0


def _rot_y(deg: float) -> np.ndarray:
    a = np.deg2rad(deg)
    c, s = np.cos(a), np.sin(a)
    # 繞 +Y：把 +Z 轉向 +X（θ = 90° 射源在 +X）
    return np.array([[c, 0, s], [0, 1, 0], [-s, 0, c]], dtype=np.float64)


def _rot_z(deg: float) -> np.ndarray:
    a = np.deg2rad(deg)
    c, s = np.cos(a), np.sin(a)
    return np.array([[c, -s, 0], [s, c, 0], [0, 0, 1]], dtype=np.float64)


def bld_to_lps(gantry_deg: float, collimator_deg: float, couch_deg: float, position: str = "HFS") -> np.ndarray:
    """3×3：BLD 座標（x、y、z 朝射源）→ 病人 LPS 的方向。"""
    p = PATIENT_TO_LPS.get(position, PATIENT_TO_LPS["HFS"])
    return p @ _rot_z(-couch_deg) @ _rot_y(gantry_deg) @ _rot_z(collimator_deg)


def source_lps(
    iso_lps: Any, gantry_deg: float, couch_deg: float, sad_mm: float = DEFAULT_SAD_MM, position: str = "HFS"
) -> np.ndarray:
    """射源在病人 LPS 的位置。"""
    r = bld_to_lps(gantry_deg, 0.0, couch_deg, position)
    return np.asarray(iso_lps, dtype=np.float64) + r @ np.array([0.0, 0.0, float(sad_mm)])


def rotation_axis_lps(couch_deg: float, position: str = "HFS") -> np.ndarray:
    """機架旋轉軸（IEC +Y）在病人 LPS 的方向 —— 2D 格的法線跟它平行時，弧在這張切面上是一個圓。"""
    p = PATIENT_TO_LPS.get(position, PATIENT_TO_LPS["HFS"])
    return p @ _rot_z(-couch_deg) @ np.array([0.0, 1.0, 0.0])


def iso_plane_points_lps(
    rects: list[tuple[float, float, float, float]],
    iso_lps: Any,
    gantry_deg: float,
    collimator_deg: float,
    couch_deg: float,
    position: str = "HFS",
) -> np.ndarray:
    """BLD 的開口矩形 `(x1, x2, y1, y2)`（等中心平面 mm）→ 每個矩形四角的 LPS 座標，`(N, 4, 3)`。"""
    r = bld_to_lps(gantry_deg, collimator_deg, couch_deg, position)
    iso = np.asarray(iso_lps, dtype=np.float64)
    out = np.zeros((len(rects), 4, 3), dtype=np.float64)
    for n, (x1, x2, y1, y2) in enumerate(rects):
        corners = np.array([[x1, y1, 0.0], [x2, y1, 0.0], [x2, y2, 0.0], [x1, y2, 0.0]])
        out[n] = corners @ r.T + iso
    return out


def aperture_rects(cp: dict[str, Any], devices: list[dict[str, Any]]) -> list[tuple[float, float, float, float]]:
    """控制點的開口（每層 MLC 開著的葉片用 jaw 裁、各層取交集）—— 與前端 `apertureRects` 同一套規則。"""
    jx = cp["jaws"].get("x")
    jy = cp["jaws"].get("y")
    jaw = (
        jx[0] if jx else -np.inf,
        jx[1] if jx else np.inf,
        jy[0] if jy else -np.inf,
        jy[1] if jy else np.inf,
    )

    def clip(r: tuple[float, ...], q: tuple[float, ...]) -> tuple[float, float, float, float] | None:
        x1, x2, y1, y2 = max(r[0], q[0]), min(r[1], q[1]), max(r[2], q[2]), min(r[3], q[3])
        return (x1, x2, y1, y2) if x2 - x1 > 1e-6 and y2 - y1 > 1e-6 else None

    layers = []
    for d in devices:
        if not str(d["type"]).startswith("MLC") or not d.get("boundaries_mm"):
            continue
        bank = cp["mlc"].get(d["type"])
        if bank is None:
            continue
        b = d["boundaries_mm"]
        rects = []
        for i in range(len(b) - 1):
            if i >= len(bank["a"]) or bank["b"][i] - bank["a"][i] <= 0.1:
                continue
            r = (
                (bank["a"][i], bank["b"][i], b[i], b[i + 1])
                if not str(d["type"]).startswith("MLCY")
                else (b[i], b[i + 1], bank["a"][i], bank["b"][i])
            )
            c = clip(r, jaw)
            if c is not None:
                rects.append(c)
        layers.append(rects)
    if not layers:
        return [jaw] if all(np.isfinite(jaw)) else []  # type: ignore[list-item]
    acc = layers[0]
    for nxt in layers[1:]:
        acc = [c for r in acc for q in nxt if (c := clip(r, q)) is not None]
    return acc


def _apply(m: np.ndarray, pts: np.ndarray) -> np.ndarray:
    return pts @ m[:3, :3].T + m[:3, 3]


def beam_track(beam_cps: dict[str, Any], iso_lps: Any, position: str, to_primary: np.ndarray) -> dict[str, Any]:
    """一個射束每個控制點的射源位置（primary）、旋轉軸、等中心 —— 2D 弧刻度與 3D 軌跡用。"""
    sad = float(beam_cps.get("sad_mm") or DEFAULT_SAD_MM)
    cps = beam_cps["control_points"]
    src = np.array(
        [source_lps(iso_lps, float(c["gantry_deg"] or 0.0), float(c["couch_deg"] or 0.0), sad, position) for c in cps]
    ).reshape(-1, 3)
    couch0 = float(cps[0]["couch_deg"] or 0.0) if cps else 0.0
    axis = to_primary[:3, :3] @ rotation_axis_lps(couch0, position)
    return {
        "iso_primary_mm": [float(v) for v in _apply(to_primary, np.asarray([iso_lps], dtype=np.float64))[0]],
        "source_primary_mm": [[float(v) for v in p] for p in _apply(to_primary, src)] if len(src) else [],
        "rotation_axis_primary": [float(v) for v in axis / (np.linalg.norm(axis) or 1.0)],
        "sad_mm": sad,
        "position": position,
        "supported_position": position in SUPPORTED_POSITIONS,
    }


BEAM_COLORS = [
    (0.42, 0.62, 1.0),
    (1.0, 0.63, 0.31),
    (0.55, 0.85, 0.45),
    (0.85, 0.5, 0.95),
    (0.35, 0.85, 0.85),
    (0.95, 0.45, 0.5),
]
APERTURE_COLOR = (1.0, 0.88, 0.4)


def beam_primitives(
    beams: list[dict[str, Any]],
    current: tuple[int, int] | None,
    position: str,
    to_primary: np.ndarray,
) -> dict[str, Any]:
    """3D 用的線與面（primary 座標）。

    `beams`：`[{ number, is_treatment, iso_lps, cps: read_beam_control_points 的結果 }]`；`current` ＝ (射束號, CP)。
    * 每個治療射束：中心軸（射源 → 等中心）；弧：射源軌跡（每個 CP 一點）＋ 刻度
      （朝等中心，長度 ∝ MU/°，以該射束最大值正規化）。
    * 目前射束、目前 CP：射源 → 開口外框四角的射線（延伸到等中心後 150 mm）、等中心平面的開口（半透明黃）。
    """
    lines: list[dict[str, Any]] = []
    polys: list[dict[str, Any]] = []
    for n, b in enumerate(beams):
        if not b["is_treatment"] or not b["cps"]["control_points"]:
            continue
        color = BEAM_COLORS[n % len(BEAM_COLORS)]
        cps = b["cps"]["control_points"]
        sad = float(b["cps"].get("sad_mm") or DEFAULT_SAD_MM)
        iso = np.asarray(b["iso_lps"], dtype=np.float64)
        src = np.array(
            [source_lps(iso, float(c["gantry_deg"] or 0.0), float(c["couch_deg"] or 0.0), sad, position) for c in cps]
        )
        is_current = current is not None and current[0] == b["number"]
        first = src[0]
        lines.append(
            {
                "points": _apply(to_primary, np.array([first, iso])).tolist(),
                "color": color,
                "width": 2.0 if is_current else 1.0,
                "opacity": 0.9 if is_current else 0.5,
            }
        )
        moving = len(src) > 1 and float(np.max(np.linalg.norm(src - src[0], axis=1))) > 1.0
        if moving:
            lines.append({"points": _apply(to_primary, src).tolist(), "color": color, "width": 2.0, "opacity": 0.8})
            mpd = [c.get("mu_per_deg") for c in cps]
            peak = max((v for v in mpd if v is not None), default=0.0)
            if peak > 0:
                ticks = []
                for p, v in zip(src, mpd, strict=True):
                    if v is None:
                        continue
                    inward = (iso - p) / (np.linalg.norm(iso - p) or 1.0)
                    ticks.append([p, p + inward * 80.0 * (v / peak)])
                if ticks:
                    pts = _apply(to_primary, np.array(ticks).reshape(-1, 3)).reshape(-1, 2, 3)
                    lines.append({"segments": pts.tolist(), "color": color, "width": 1.0, "opacity": 0.7})
        if is_current and current is not None:
            i = max(0, min(len(cps) - 1, int(current[1])))
            cp = cps[i]
            g, c, f = float(cp["gantry_deg"] or 0.0), float(cp["collimator_deg"] or 0.0), float(cp["couch_deg"] or 0.0)
            rects = aperture_rects(cp, b["cps"]["devices"])
            s = src[i]
            if rects:
                quads = iso_plane_points_lps(rects, iso, g, c, f, position)
                polys.append(
                    {
                        "quads": _apply(to_primary, quads.reshape(-1, 3)).reshape(-1, 4, 3).tolist(),
                        "color": APERTURE_COLOR,
                        "opacity": 0.55,
                    }
                )
                xs = [r[0] for r in rects] + [r[1] for r in rects]
                ys = [r[2] for r in rects] + [r[3] for r in rects]
                box = iso_plane_points_lps([(min(xs), max(xs), min(ys), max(ys))], iso, g, c, f, position)[0]
                rays = []
                for corner in box:
                    d = corner - s
                    rays.append([s, s + d * ((sad + 150.0) / sad)])
                pts = _apply(to_primary, np.array(rays).reshape(-1, 3)).reshape(-1, 2, 3)
                lines.append({"segments": pts.tolist(), "color": APERTURE_COLOR, "width": 1.5, "opacity": 0.9})
            lines.append(
                {
                    "points": _apply(to_primary, np.array([s, iso])).tolist(),
                    "color": APERTURE_COLOR,
                    "width": 2.0,
                    "opacity": 1.0,
                }
            )
    return {"lines": lines, "polys": polys}
