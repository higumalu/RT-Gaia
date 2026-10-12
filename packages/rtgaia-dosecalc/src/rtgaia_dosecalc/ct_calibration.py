"""CT 校正曲線：HU → 質量密度（g/cm³）＋ 材質（元素組成）—— 純 numpy，零 FastAPI。

Monte Carlo 要的是每個體素的**密度與元素組成**（光子、電子、質子、重粒子的截面與阻擋本領都從組成算），
所以一條曲線同時給這兩樣；不另外存 HU → 相對電子密度或 HU → SPR（那是解析演算法用的）。

## 內建：Schneider 2000（通用，示範用）

Schneider W, Bortfeld T, Schlegel W. *Correlation between CT numbers and tissue parameters needed for Monte Carlo
simulations of clinical dose distributions.* Phys Med Biol 2000;45:459–478.
數值取自 OpenTOPAS 的 `examples/Patient/HUtoMaterialSchneider.txt`（MIT 授權）：

* 密度：7 段，ρ ＝ offset ＋ factor ×（HU ＋ factor_offset），段是 [下界, 上界) 的 HU。
* 材質：25 段（空氣、肺、脂肪到軟組織、結締組織、骨的混合、鈦），每段一組元素質量分率。
* **不用** 那個檔裡的 `DensityCorrection`：那是為了讓 Geant4 的阻擋本領對上某一套 TPS 而調的係數 ——
  拿 TPS 調參數就不是獨立驗算了。

這條曲線不是任何一台 CT 的實測，**一律標示範用**；用它算的結果也帶這個標記。

## 使用者的曲線

使用者給 HU → 密度的點表（假體實測；分段線性內插，HU 嚴格遞增）。元素組成依 HU 套 Schneider 的 25 段
（只換密度、不換組成 —— 組成要從化學計量法另外推，之後有需要再開欄位）。

## 範圍外

HU 低於曲線最小值或高於最大值 → 夾到端點的值，**另外計數**（`clamped_low`／`clamped_high`）：高的通常是金屬或
造影劑，結果的說明要列出來，不默默當成骨頭。

## 哪一條曲線套到哪個 CT（`resolve`）

啟用中的使用者曲線依比對規則（製造商、機型、kVp；空的欄位不比）挑**最具體**的，同樣具體挑最晚啟用的；
都對不到 → 內建的通用曲線，`fallback: true` 並說明原因。
"""

from __future__ import annotations

import uuid
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any

import numpy as np

SETTINGS_KEY = "ct_calibrations"
BUILTIN_ID = "builtin-schneider2000"
STATUSES = ("draft", "active", "retired")
MAX_POINTS = 200
DENSITY_MAX = 25.0
"""g/cm³：比鎢（19.3）還大一點，擋掉打錯單位（kg/m³）的輸入。"""
HU_RANGE = (-1100.0, 30000.0)
KVP_TOL = 1.0
CURVE_STEP_HU = 10

ELEMENTS = ("H", "C", "N", "O", "Mg", "P", "S", "Cl", "Ar", "Ca", "Na", "K", "Ti")

_SCHNEIDER_DENSITY = (
    # (HU 下界, HU 上界, offset, factor, factor_offset)
    (-1000, -98, 0.00121, 0.001029700665188, 1000.0),
    (-98, 15, 1.018, 0.000893, 0.0),
    (15, 23, 1.03, 0.0, 1000.0),
    (23, 101, 1.003, 0.001169, 0.0),
    (101, 2001, 1.017, 0.000592, 0.0),
    (2001, 2995, 2.201, 0.0005, -2000.0),
    (2995, 2996, 4.54, 0.0, 0.0),
)

_SCHNEIDER_MATERIAL_BOUNDS = (
    -1000, -950, -120, -83, -53, -23, 7, 18, 80, 120, 200, 300, 400, 500, 600, 700, 800, 900, 1000, 1100, 1200,
    1300, 1400, 1500, 2995, 2996,
)  # fmt: skip
_SCHNEIDER_WEIGHTS = (
    # H      C      N      O      Mg     P      S      Cl     Ar     Ca     Na     K      Ti
    (0.0, 0.0, 0.755, 0.232, 0.0, 0.0, 0.0, 0.0, 0.013, 0.0, 0.0, 0.0, 0.0),
    (0.103, 0.105, 0.031, 0.749, 0.0, 0.002, 0.003, 0.003, 0.0, 0.0, 0.002, 0.002, 0.0),
    (0.116, 0.681, 0.002, 0.198, 0.0, 0.0, 0.001, 0.001, 0.0, 0.0, 0.001, 0.0, 0.0),
    (0.113, 0.567, 0.009, 0.308, 0.0, 0.0, 0.001, 0.001, 0.0, 0.0, 0.001, 0.0, 0.0),
    (0.110, 0.458, 0.015, 0.411, 0.0, 0.001, 0.002, 0.002, 0.0, 0.0, 0.001, 0.0, 0.0),
    (0.108, 0.356, 0.022, 0.509, 0.0, 0.001, 0.002, 0.002, 0.0, 0.0, 0.0, 0.0, 0.0),
    (0.106, 0.284, 0.026, 0.578, 0.0, 0.001, 0.002, 0.002, 0.0, 0.0, 0.0, 0.001, 0.0),
    (0.103, 0.134, 0.030, 0.723, 0.0, 0.002, 0.002, 0.002, 0.0, 0.0, 0.002, 0.002, 0.0),
    (0.094, 0.207, 0.062, 0.622, 0.0, 0.0, 0.006, 0.003, 0.0, 0.0, 0.006, 0.0, 0.0),
    (0.095, 0.455, 0.025, 0.355, 0.0, 0.021, 0.001, 0.001, 0.0, 0.045, 0.001, 0.001, 0.0),
    (0.089, 0.423, 0.027, 0.363, 0.0, 0.030, 0.001, 0.001, 0.0, 0.064, 0.001, 0.001, 0.0),
    (0.082, 0.391, 0.029, 0.372, 0.0, 0.039, 0.001, 0.001, 0.0, 0.083, 0.001, 0.001, 0.0),
    (0.076, 0.361, 0.030, 0.380, 0.001, 0.047, 0.002, 0.001, 0.0, 0.101, 0.001, 0.0, 0.0),
    (0.071, 0.335, 0.032, 0.387, 0.001, 0.054, 0.002, 0.0, 0.0, 0.117, 0.001, 0.0, 0.0),
    (0.066, 0.310, 0.033, 0.394, 0.001, 0.061, 0.002, 0.0, 0.0, 0.132, 0.001, 0.0, 0.0),
    (0.061, 0.287, 0.035, 0.400, 0.001, 0.067, 0.002, 0.0, 0.0, 0.146, 0.001, 0.0, 0.0),
    (0.056, 0.265, 0.036, 0.405, 0.002, 0.073, 0.003, 0.0, 0.0, 0.159, 0.001, 0.0, 0.0),
    (0.052, 0.246, 0.037, 0.411, 0.002, 0.078, 0.003, 0.0, 0.0, 0.170, 0.001, 0.0, 0.0),
    (0.049, 0.227, 0.038, 0.416, 0.002, 0.083, 0.003, 0.0, 0.0, 0.181, 0.001, 0.0, 0.0),
    (0.045, 0.210, 0.039, 0.420, 0.002, 0.088, 0.003, 0.0, 0.0, 0.192, 0.001, 0.0, 0.0),
    (0.042, 0.194, 0.040, 0.425, 0.002, 0.092, 0.003, 0.0, 0.0, 0.201, 0.001, 0.0, 0.0),
    (0.039, 0.179, 0.041, 0.429, 0.002, 0.096, 0.003, 0.0, 0.0, 0.210, 0.001, 0.0, 0.0),
    (0.036, 0.165, 0.042, 0.432, 0.002, 0.100, 0.003, 0.0, 0.0, 0.219, 0.001, 0.0, 0.0),
    (0.034, 0.155, 0.042, 0.435, 0.002, 0.103, 0.003, 0.0, 0.0, 0.225, 0.001, 0.0, 0.0),
    (0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 1.0),
)


def _material_class(index: int) -> str:
    """Schneider 的 25 段分成五類（面板與說明用）。"""
    if index == 0:
        return "air"
    if index == 1:
        return "lung"
    if index <= 8:
        return "soft_tissue" if index >= 6 else "adipose"
    if index <= 23:
        return "bone"
    return "metal"


def schneider_materials() -> list[dict[str, Any]]:
    out = []
    for i, w in enumerate(_SCHNEIDER_WEIGHTS):
        lo, hi = _SCHNEIDER_MATERIAL_BOUNDS[i], _SCHNEIDER_MATERIAL_BOUNDS[i + 1]
        out.append(
            {
                "index": i,
                "hu_lo": lo,
                "hu_hi": hi,
                "name": f"Schneider {i + 1}",
                "class": _material_class(i),
                "composition": {e: f for e, f in zip(ELEMENTS, w, strict=True) if f > 0},
            }
        )
    return out


def builtin_calibration() -> dict[str, Any]:
    return {
        "calibration_id": BUILTIN_ID,
        "name": "Schneider 2000",
        "status": "builtin",
        "builtin": True,
        "demo": True,
        "reference": (
            "Schneider W, Bortfeld T, Schlegel W. Correlation between CT numbers and tissue parameters needed for "
            "Monte Carlo simulations of clinical dose distributions. Phys Med Biol 2000;45:459-478 "
            "(values from OpenTOPAS examples/Patient/HUtoMaterialSchneider.txt, MIT; DensityCorrection not used)"
        ),
        "density": {
            "type": "sections",
            "sections": [
                {"hu_lo": lo, "hu_hi": hi, "offset": a, "factor": b, "factor_offset": c}
                for lo, hi, a, b, c in _SCHNEIDER_DENSITY
            ],
        },
        "materials": {"type": "schneider2000"},
        "match": {"manufacturer": "", "model": "", "kvp": None},
        "note": "",
    }


# ── 數值 ──────────────────────────────────────────────────────────────────────


def hu_range(cal: dict[str, Any]) -> tuple[float, float]:
    d = cal["density"]
    if d["type"] == "sections":
        return float(d["sections"][0]["hu_lo"]), float(d["sections"][-1]["hu_hi"] - 1)
    pts = d["points"]
    return float(pts[0][0]), float(pts[-1][0])


def density_of(cal: dict[str, Any], hu: np.ndarray) -> np.ndarray:
    """HU（已經夾在範圍內）→ g/cm³（float64）。"""
    d = cal["density"]
    h = np.asarray(hu, dtype=np.float64)
    if d["type"] == "points":
        pts = np.asarray(d["points"], dtype=np.float64)
        return np.interp(h, pts[:, 0], pts[:, 1])
    out = np.zeros_like(h)
    secs = d["sections"]
    for i, s in enumerate(secs):
        last = i == len(secs) - 1
        m = (h >= s["hu_lo"]) & ((h < s["hu_hi"]) if not last else (h <= s["hu_hi"]))
        out[m] = s["offset"] + s["factor"] * (h[m] + s["factor_offset"])
    return out


def material_index_of(hu: np.ndarray) -> np.ndarray:
    """HU → Schneider 25 段的材質編號（uint8）。範圍外夾到兩端。"""
    bounds = np.asarray(_SCHNEIDER_MATERIAL_BOUNDS[1:-1], dtype=np.float64)
    return np.searchsorted(bounds, np.asarray(hu, dtype=np.float64), side="right").astype(np.uint8)


@dataclass
class Converted:
    density: np.ndarray
    """g/cm³，float32，跟輸入同形狀。"""
    material: np.ndarray
    """Schneider 材質編號（uint8）。"""
    info: dict[str, Any]


def convert(cal: dict[str, Any], hu: np.ndarray) -> Converted:
    """一整個 HU 體積 → 密度 ＋ 材質；範圍外的另外計數。NaN（網格外）當成空氣。"""
    lo, hi = hu_range(cal)
    h = np.asarray(hu, dtype=np.float64)
    finite = np.isfinite(h)
    h = np.where(finite, h, lo)
    low = int(((h < lo) & finite).sum())
    high = int((h > hi).sum())
    hc = np.clip(h, lo, hi)
    rho = density_of(cal, hc).astype(np.float32)
    mat = material_index_of(hc)
    counts = np.bincount(mat.ravel(), minlength=len(_SCHNEIDER_WEIGHTS))
    classes: dict[str, int] = {}
    for i, n in enumerate(counts):
        if n:
            k = _material_class(i)
            classes[k] = classes.get(k, 0) + int(n)
    return Converted(
        density=rho,
        material=mat,
        info={
            "calibration_id": cal["calibration_id"],
            "demo": bool(cal.get("demo")),
            "hu_range": [lo, hi],
            "clamped_low": low,
            "clamped_high": high,
            "voxels": int(h.size),
            "material_classes": classes,
        },
    )


def sampled_curve(cal: dict[str, Any], step: int = CURVE_STEP_HU) -> dict[str, Any]:
    """畫圖用：從曲線最小 HU 到最大 HU 每 `step` 取一點的密度與材質編號（段的邊界兩側也取，跳躍畫得出來）。"""
    lo, hi = hu_range(cal)
    xs = set(np.arange(np.ceil(lo / step) * step, hi + 1e-9, step).tolist()) | {lo, hi}
    d = cal["density"]
    if d["type"] == "sections":
        for s in d["sections"]:
            xs |= {float(s["hu_lo"]), float(s["hu_hi"]) - 1e-3}
    else:
        xs |= {float(p[0]) for p in d["points"]}
    hu = np.asarray(sorted(x for x in xs if lo <= x <= hi), dtype=np.float64)
    return {
        "hu": hu.tolist(),
        "density": density_of(cal, hu).tolist(),
        "material": material_index_of(hu).astype(int).tolist(),
    }


# ── 使用者的曲線 ──────────────────────────────────────────────────────────────


def _now() -> str:
    return datetime.now(UTC).isoformat(timespec="seconds")


def check_user_curve(body: dict[str, Any]) -> tuple[dict[str, Any] | None, list[str]]:
    """請求 → 草稿（還沒有 id、狀態）；有問題回原因清單。"""
    problems: list[str] = []
    name = str(body.get("name") or "").strip()
    if not name or len(name) > 80:
        problems.append("名稱必填（最多 80 字）")
    raw = body.get("points")
    pts: list[list[float]] = []
    if not isinstance(raw, list) or not 2 <= len(raw) <= MAX_POINTS:
        problems.append(f"點表要 2–{MAX_POINTS} 點")
    else:
        for p in raw:
            ok = (
                isinstance(p, (list, tuple))
                and len(p) == 2
                and all(isinstance(v, (int, float)) and not isinstance(v, bool) and np.isfinite(v) for v in p)
            )
            if not ok:
                problems.append("每一點要是 [HU, 密度] 兩個數字")
                break
            pts.append([float(p[0]), float(p[1])])
        if pts and len(pts) == len(raw):
            hus = [p[0] for p in pts]
            if any(b <= a for a, b in zip(hus, hus[1:], strict=False)):
                problems.append("HU 要嚴格遞增")
            if any(not HU_RANGE[0] <= h <= HU_RANGE[1] for h in hus):
                problems.append(f"HU 要在 {HU_RANGE[0]:g}–{HU_RANGE[1]:g}")
            if any(not 0 < p[1] <= DENSITY_MAX for p in pts):
                problems.append(f"密度要在 0–{DENSITY_MAX:g} g/cm³（單位是 g/cm³，不是 kg/m³）")
    match = body.get("match") or {}
    if not isinstance(match, dict):
        problems.append("比對規則格式錯")
        match = {}
    kvp = match.get("kvp")
    if kvp is not None and (isinstance(kvp, bool) or not isinstance(kvp, (int, float)) or not 40 <= kvp <= 200):
        problems.append("kVp 要在 40–200")
    manufacturer = str(match.get("manufacturer") or "").strip()
    model = str(match.get("model") or "").strip()
    if not manufacturer and not model and kvp is None:
        problems.append("比對規則至少要填一項（製造商、機型或 kVp）；不填就永遠不會被選到")
    if problems:
        return None, problems
    return {
        "name": name,
        "builtin": False,
        "demo": bool(body.get("demo", False)),
        "reference": str(body.get("reference") or "").strip()[:500],
        "density": {"type": "points", "points": pts},
        "materials": {"type": "schneider2000"},
        "match": {"manufacturer": manufacturer, "model": model, "kvp": float(kvp) if kvp is not None else None},
        "note": str(body.get("note") or "").strip()[:1000],
    }, []


def new_record(draft: dict[str, Any], *, user: str) -> dict[str, Any]:
    return {
        **draft,
        "calibration_id": f"ctc_{uuid.uuid4().hex[:12]}",
        "status": "draft",
        "created_by": user,
        "created_at": _now(),
        "activated_by": None,
        "activated_at": None,
        "retired_by": None,
        "retired_at": None,
    }


def activate(items: list[dict[str, Any]], calibration_id: str, *, user: str) -> list[str]:
    """啟用一條草稿；同一組比對規則的其他啟用中曲線改成停用（回傳被停用的 id）。"""
    target = next(x for x in items if x["calibration_id"] == calibration_id)
    now = _now()
    retired = []
    for x in items:
        if x is not target and x["status"] == "active" and _match_key(x["match"]) == _match_key(target["match"]):
            x.update(status="retired", retired_by=user, retired_at=now)
            retired.append(x["calibration_id"])
    target.update(status="active", activated_by=user, activated_at=now)
    return retired


def retire(item: dict[str, Any], *, user: str) -> None:
    item.update(status="retired", retired_by=user, retired_at=_now())


def _match_key(m: dict[str, Any]) -> tuple[str, str, float | None]:
    return (str(m.get("manufacturer") or "").lower(), str(m.get("model") or "").lower(), m.get("kvp"))


# ── 哪一條套到哪個 CT ─────────────────────────────────────────────────────────


def scanner_of(path: str | None) -> dict[str, Any]:
    """CT 第一張影像的製造商、機型、站名、kVp（讀不到的是空字串／None）。"""
    out: dict[str, Any] = {"manufacturer": "", "model": "", "station": "", "kvp": None}
    if not path:
        return out
    import pydicom

    try:
        tags = ["Manufacturer", "ManufacturerModelName", "StationName", "KVP"]
        ds = pydicom.dcmread(path, stop_before_pixels=True, specific_tags=tags)
    except Exception:  # noqa: BLE001 - 讀不到就是不知道；結果會退回通用曲線並說明
        return out
    out["manufacturer"] = str(ds.get("Manufacturer", "") or "").strip()
    out["model"] = str(ds.get("ManufacturerModelName", "") or "").strip()
    out["station"] = str(ds.get("StationName", "") or "").strip()
    try:
        kvp = ds.get("KVP")
        out["kvp"] = float(kvp) if kvp not in (None, "") else None
    except (TypeError, ValueError):
        out["kvp"] = None
    return out


def _rule_matches(m: dict[str, Any], scanner: dict[str, Any]) -> bool:
    if m.get("manufacturer") and str(m["manufacturer"]).lower() != str(scanner.get("manufacturer") or "").lower():
        return False
    if m.get("model") and str(m["model"]).lower() != str(scanner.get("model") or "").lower():
        return False
    if m.get("kvp") is not None:
        kvp = scanner.get("kvp")
        if kvp is None or abs(float(kvp) - float(m["kvp"])) > KVP_TOL:
            return False
    return True


def resolve(items: list[dict[str, Any]], scanner: dict[str, Any]) -> dict[str, Any]:
    """`{calibration, fallback, reason}`：啟用中的使用者曲線挑最具體的；都對不到 → 內建通用曲線。"""
    candidates = [x for x in items if x["status"] == "active" and _rule_matches(x["match"], scanner)]
    if candidates:

        def rank(x: dict[str, Any]) -> tuple[int, str]:
            m = x["match"]
            fields = sum(1 for k in ("manufacturer", "model") if m.get(k)) + (m.get("kvp") is not None)
            return (fields, x.get("activated_at") or "")

        best = max(candidates, key=rank)
        return {"calibration": best, "fallback": False, "reason": "符合比對規則"}
    desc = " ".join(x for x in (scanner.get("manufacturer"), scanner.get("model")) if x) or "機型不明"
    kvp = scanner.get("kvp")
    kvp_text = f"{kvp:g} kVp" if kvp is not None else "kVp 不明"
    return {
        "calibration": builtin_calibration(),
        "fallback": True,
        "reason": f"沒有符合的曲線（{desc}、{kvp_text}）：用內建的通用曲線（示範用）",
    }


def summary(cal: dict[str, Any]) -> dict[str, Any]:
    """清單用：不帶點表。"""
    lo, hi = hu_range(cal)
    return {
        k: cal.get(k)
        for k in (
            "calibration_id", "name", "status", "builtin", "demo", "reference", "match", "note",
            "created_by", "created_at", "activated_by", "activated_at", "retired_by", "retired_at",
        )
    } | {"hu_range": [lo, hi], "points": len(cal["density"].get("points") or []) or None}  # fmt: skip
