"""射束資料：量測資料集（PDD、profile、輸出因子、單一量值、絕對校正）—— 射束模型擬合與驗證的依據。純 Python。

射束模型的參數只從這裡的資料擬合（不拿 TPS 的劑量調參數），每個參數對得回它用到的量測；
所以每一筆資料都帶**來源**（實測／廠商代表資料／公開文獻／研究合成）、引用、授權與量測條件。

## 資料集

一個資料集 ＝ 一台機器（或一份文獻）的一個射束品質：

* `machine`：製造商、機型、名稱（例如 Varian／TrueBeam／「文獻多機構平均」）。
* `beam`：`energy_mv`、`fluence_mode`（STANDARD／FFF）。
* `source`：`kind`（`measured`／`vendor`／`literature`／`synthetic`）、`citation`、`licence`、`url`、`note`。
  非 `measured` 的資料集擬合出來的模型一律是示範模型。
* `measurements`：下面的量測，一筆一個條件。

## 量測（`kind`）

| kind | x | 值 | 條件 |
|---|---|---|---|
| `depth_dose` | 深度 mm | PDD／TPR／TMR（`quantity`） | 射野、SSD（PDD）或 SAD 深度（TPR）、正規化 |
| `profile` | 離軸 mm | 相對劑量 | 射野、SSD、深度、軸（x／y／diagonal）、正規化 |
| `output_factor` | 射野邊長 mm（或 x、y 兩欄） | 相對參考射野 | SSD 或 SAD、深度、參考射野、準直（jaw／MLC）、偵檢器 |
| `scalar` | — | 單一量值（`quantity`：dmax、TPR20/10、半影、FWHM、unflatness、MLC 穿透、葉端偏移…） | 視量值 |
| `absolute` | — | Gy/MU | 參考條件（射野、SSD、深度或 dmax） |

`depth_dose` 只有幾個點也可以（例如文獻只給 PDD10）。值的單位寫在 `unit`（percent／fraction／mm…）；
統計量寫在 `statistic`（single／mean／median）與 `n`；不確定度（一個標準差或文獻給的區間）放在第三欄。

## 通用 CSV（`parse_csv`）

一個檔案可以有多筆量測，每筆以 `# kind:` 開頭，後面是 `# 鍵: 值` 的條件，再來是資料列：

    # kind: depth_dose
    # quantity: pdd
    # field_mm: 100 x 100
    # ssd_mm: 1000
    # normalization: dmax
    # unit: percent
    # detector: IBA CC13
    # statistic: mean
    # n: 3
    100, 66.8, 0.3

欄位預設依 kind（`depth_dose`：depth_mm, value[, uncertainty]；`output_factor`：field_mm, value[, uncertainty]）；
長方形射野的輸出因子用 `# columns: field_x_mm, field_y_mm, value`。
"""

from __future__ import annotations

import math
import re
import uuid
from datetime import UTC, datetime
from typing import Any

SETTINGS_KEY = "beam_data"
KINDS = ("depth_dose", "profile", "output_factor", "scalar", "absolute")
SOURCE_KINDS = ("measured", "vendor", "literature", "synthetic")
FLUENCE_MODES = ("STANDARD", "FFF")
STATISTICS = ("single", "mean", "median")
UNITS = ("percent", "fraction", "mm", "gy_per_mu", "ratio")
SCALAR_QUANTITIES = {
    "dmax_mm": "mm",
    "tpr20_10": "ratio",
    "pdd10x": "percent",
    "penumbra_80_20_mm": "mm",
    "fwhm_mm": "mm",
    "unflatness": "ratio",
    "slope_percent_per_mm": "ratio",
    "mlc_transmission": "fraction",
    "jaw_transmission": "fraction",
    "leaf_end_offset_mm": "mm",
    "dlg_mm": "mm",
    "leaf_end_radius_mm": "mm",
    "leaf_height_mm": "mm",
}
"""單一量值：名稱 → 預設單位。`pdd10x` 是 TG-51 的 %dd(10)x（純光子的 PDD10）；`unflatness`、`slope_percent_per_mm`
是 FFF 射束的參數（Fogliata 2012 的定義）；葉端半徑、葉片高度是幾何規格（廠商或文獻），不是劑量量測。"""
SIGNED_QUANTITIES = ("leaf_end_offset_mm", "dlg_mm")
"""可以是負的量值（葉端效應的掃描間隙外插截距常是負的）。"""
DEPTH_QUANTITIES = ("pdd", "tpr", "tmr")
AXES = ("x", "y", "diagonal")
NORMALIZATIONS = ("dmax", "depth", "central_axis", "reference_field", "none")
MAX_POINTS = 2000
MAX_MEASUREMENTS = 500
MAX_TEXT = 1000

_CONDITION_KEYS = {
    # 鍵 → (型別, 說明)；型別：field、number、text、choice
    "field_mm": "field",
    "reference_field_mm": "field",
    "ssd_mm": "number",
    "sad_mm": "number",
    "depth_mm": "number",
    "axis": "choice:axis",
    "normalization": "choice:normalization",
    "normalization_depth_mm": "number",
    "setup": "choice:setup",
    "collimation": "choice:collimation",
    "layer": "text",
    "detector": "text",
    "note": "text",
}
_CHOICES = {
    "axis": AXES,
    "normalization": NORMALIZATIONS,
    "setup": ("SSD", "SAD"),
    "collimation": ("jaw", "mlc", "jaw_and_mlc", "cone"),
}
_DEFAULT_COLUMNS = {
    "depth_dose": ("depth_mm", "value", "uncertainty"),
    "profile": ("position_mm", "value", "uncertainty"),
    "output_factor": ("field_mm", "value", "uncertainty"),
    "scalar": ("value", "uncertainty"),
    "absolute": ("value", "uncertainty"),
}
_ALLOWED_COLUMNS = {
    "depth_dose": {("depth_mm", "value"), ("depth_mm", "value", "uncertainty")},
    "profile": {("position_mm", "value"), ("position_mm", "value", "uncertainty")},
    "output_factor": {
        ("field_mm", "value"),
        ("field_mm", "value", "uncertainty"),
        ("field_x_mm", "field_y_mm", "value"),
        ("field_x_mm", "field_y_mm", "value", "uncertainty"),
    },
    "scalar": {("value",), ("value", "uncertainty")},
    "absolute": {("value",), ("value", "uncertainty")},
}


def numbered(i: int, kind: Any, problem: str) -> str:
    """「第 3 筆（profile）：缺條件 depth_mm」。"""
    return f"第 {i + 1} 筆（{kind or '?'}）：{problem}"


def _now() -> str:
    return datetime.now(UTC).isoformat(timespec="seconds")


def parse_field(text: Any) -> list[float] | None:
    """「100 x 100」「100x100」「100」（正方形）、[100, 100] → [x, y] mm；看不懂 → None。"""
    if isinstance(text, (list, tuple)) and len(text) == 2:
        vals = text
    elif isinstance(text, (int, float)) and not isinstance(text, bool):
        vals = (text, text)
    else:
        parts = [p for p in re.split(r"\s*[x×X*]\s*", str(text).strip()) if p]
        if len(parts) == 1:
            parts = parts * 2
        if len(parts) != 2:
            return None
        vals = parts
    try:
        out = [float(v) for v in vals]
    except (TypeError, ValueError):
        return None
    if not all(math.isfinite(v) and 0 < v <= 1000 for v in out):
        return None
    return out


def _number(v: Any) -> float | None:
    if isinstance(v, bool):
        return None
    try:
        x = float(v)
    except (TypeError, ValueError):
        return None
    return x if math.isfinite(x) else None


# ── 一筆量測 ──────────────────────────────────────────────────────────────────


def check_measurement(raw: dict[str, Any]) -> tuple[dict[str, Any] | None, list[str]]:
    """一筆量測（JSON 形式）→ 正規化後的紀錄；有問題回原因（呼叫端用 `numbered` 標第幾筆）。"""
    p: list[str] = []
    bad = p.append

    kind = raw.get("kind")
    if kind not in KINDS:
        bad(f"kind 要是 {'／'.join(KINDS)}")
        return None, p
    quantity = str(raw.get("quantity") or "").strip()
    if kind == "depth_dose":
        quantity = quantity or "pdd"
        if quantity not in DEPTH_QUANTITIES:
            bad(f"深度劑量的 quantity 要是 {'／'.join(DEPTH_QUANTITIES)}")
    elif kind == "scalar":
        if quantity not in SCALAR_QUANTITIES:
            bad(f"單一量值的 quantity 要是 {'、'.join(SCALAR_QUANTITIES)}")
    elif kind == "absolute":
        quantity = "gy_per_mu"
    else:
        quantity = {"profile": "relative_dose", "output_factor": "output_factor"}[kind]

    cond: dict[str, Any] = {}
    for k, v in (raw.get("conditions") or {}).items():
        typ = _CONDITION_KEYS.get(k)
        if typ is None:
            bad(f"不認得的條件 {k}")
            continue
        if v is None or v == "":
            continue
        if typ == "field":
            f = parse_field(v)
            if f is None:
                bad(f"{k} 要是「寬 x 高」（mm）")
            else:
                cond[k] = f
        elif typ == "number":
            x = _number(v)
            if x is None or x < 0 or x > 5000:
                bad(f"{k} 要是 0–5000 的數字（mm）")
            else:
                cond[k] = x
        elif typ.startswith("choice:"):
            choices = _CHOICES[typ.split(":", 1)[1]]
            if v not in choices:
                bad(f"{k} 要是 {'／'.join(choices)}")
            else:
                cond[k] = v
        else:
            cond[k] = str(v).strip()[:MAX_TEXT]

    need: tuple[str, ...] = {
        "depth_dose": ("field_mm",),
        "profile": ("field_mm", "depth_mm"),
        "output_factor": ("depth_mm",),
        "absolute": ("field_mm",),
        "scalar": (),
    }[kind]
    for k in need:
        if k not in cond:
            bad(f"缺條件 {k}")
    if kind in ("depth_dose", "profile", "output_factor", "absolute") and "ssd_mm" not in cond and "sad_mm" not in cond:
        bad("要有 ssd_mm 或 sad_mm")
    if kind == "profile" and "axis" not in cond:
        cond["axis"] = "x"

    unit = str(raw.get("unit") or "").strip()
    default_unit = {
        "depth_dose": "percent",
        "profile": "percent",
        "output_factor": "ratio",
        "absolute": "gy_per_mu",
        "scalar": SCALAR_QUANTITIES.get(quantity, "ratio"),
    }[kind]
    unit = unit or default_unit
    if unit not in UNITS:
        bad(f"unit 要是 {'／'.join(UNITS)}")

    pts_raw = raw.get("points")
    points: list[list[float | None]] = []
    columns: tuple[str, ...] = ()
    if not isinstance(pts_raw, list) or not 1 <= len(pts_raw) <= MAX_POINTS:
        bad(f"資料要 1–{MAX_POINTS} 列")
    elif not all(isinstance(r, (list, tuple)) for r in pts_raw):
        bad("每一列要是一串數字")
    else:
        width = max(len(r) for r in pts_raw)
        given = raw.get("columns")
        columns = tuple(given) if given else _DEFAULT_COLUMNS[kind][:width]
        if columns and columns[-1] == "uncertainty":
            # 不確定度那一欄可以有的列有、有的列沒有
            pts_raw = [[*r, None] if len(r) == len(columns) - 1 else r for r in pts_raw]
        if columns not in _ALLOWED_COLUMNS[kind]:
            bad(f"欄位要是 {' 或 '.join(', '.join(c) for c in sorted(_ALLOWED_COLUMNS[kind]))}")
        else:
            for i, row in enumerate(pts_raw):
                vals = [_number(v) if v is not None else None for v in row]
                bad_cell = any(
                    (v is None and (col != "uncertainty" or row[c] is not None))
                    for c, (col, v) in enumerate(zip(columns, vals, strict=False))
                )
                if len(row) != len(columns) or bad_cell:
                    bad(f"第 {i + 1} 列要是 {len(columns)} 個數字（{', '.join(columns)}）")
                    break
                points.append(vals)
    if points and len(points) == len(pts_raw or []):
        col = {c: i for i, c in enumerate(columns)}
        if kind in ("scalar", "absolute") and len(points) != 1:
            bad("單一量值只能有一列")
        if kind in ("depth_dose", "profile", "output_factor") and columns[0] != "field_x_mm":
            xs = [r[0] for r in points]
            if any(b <= a for a, b in zip(xs, xs[1:], strict=False)):  # type: ignore[operator]
                bad(f"{columns[0]} 要嚴格遞增")
        if kind == "depth_dose" and any(r[0] < 0 for r in points):  # type: ignore[operator]
            bad("深度不能是負的")
        if kind == "output_factor":
            fcols = [col[c] for c in ("field_mm", "field_x_mm", "field_y_mm") if c in col]
            if any(not 0 < r[c] <= 1000 for r in points for c in fcols):  # type: ignore[operator]
                bad("射野要在 0–1000 mm")
        if quantity not in SIGNED_QUANTITIES and any(r[col["value"]] < 0 for r in points):  # type: ignore[operator]
            bad("值不能是負的")
        if "uncertainty" in col and any(
            r[col["uncertainty"]] is not None and r[col["uncertainty"]] < 0  # type: ignore[operator]
            for r in points
        ):
            bad("不確定度不能是負的")

    statistic = raw.get("statistic") or "single"
    if statistic not in STATISTICS:
        bad(f"statistic 要是 {'／'.join(STATISTICS)}")
    n = raw.get("n")
    if n is not None and (isinstance(n, bool) or not isinstance(n, int) or n < 1):
        bad("n 要是正整數")
    if p:
        return None, p
    return {
        "measurement_id": str(raw.get("measurement_id") or f"m_{uuid.uuid4().hex[:10]}"),
        "kind": kind,
        "quantity": quantity,
        "unit": unit,
        "conditions": cond,
        "columns": list(columns),
        "points": points,
        "statistic": statistic,
        "n": n,
        "reference": str(raw.get("reference") or "").strip()[:MAX_TEXT],
    }, []


# ── 通用 CSV ──────────────────────────────────────────────────────────────────


def parse_csv(text: str) -> tuple[list[dict[str, Any]], list[str]]:
    """通用 CSV → 量測（JSON 形式，還沒檢查）；格式見模組說明。回 `(量測, 問題)`。"""
    out: list[dict[str, Any]] = []
    problems: list[str] = []
    cur: dict[str, Any] | None = None
    for lineno, line in enumerate(text.splitlines(), start=1):
        s = line.strip()
        if not s:
            continue
        if s.startswith("#"):
            m = re.match(r"#\s*([A-Za-z_][A-Za-z0-9_]*)\s*[:=]\s*(.*)$", s)
            if not m:
                continue  # 一般註解
            key, val = m.group(1).lower(), m.group(2).strip()
            if key == "kind":
                cur = {"kind": val, "conditions": {}, "points": [], "_line": lineno}
                out.append(cur)
                continue
            if cur is None:
                problems.append(f"第 {lineno} 行：「# kind:」之前不能有條件")
                continue
            if key in ("quantity", "unit", "statistic", "reference"):
                cur[key] = val
            elif key == "n":
                try:
                    cur["n"] = int(val)
                except ValueError:
                    problems.append(f"第 {lineno} 行：n 要是整數")
            elif key == "columns":
                cur["columns"] = [c.strip() for c in re.split(r"[,\t;]", val) if c.strip()]
            else:
                cur["conditions"][key] = val
            continue
        if cur is None:
            problems.append(f"第 {lineno} 行：資料前面要有「# kind:」")
            continue
        cells = [c for c in re.split(r"\s*[,\t;]\s*|\s+", s) if c != ""]
        row: list[float | None] = []
        for c in cells:
            if c.lower() in ("", "na", "nan", "-"):
                row.append(None)
                continue
            x = _number(c)
            if x is None:
                break
            row.append(x)
        else:
            cur["points"].append(row)
            continue
        if not cur["points"]:
            continue  # 表頭列
        problems.append(f"第 {lineno} 行：要是數字")
    for m in out:
        m.pop("_line", None)
    return out, problems


# ── 資料集 ────────────────────────────────────────────────────────────────────


def check_dataset(body: dict[str, Any]) -> tuple[dict[str, Any] | None, list[str]]:
    """請求（資料集＋量測）→ 草稿（還沒有 id、狀態）；有問題回原因清單。"""
    p: list[str] = []
    name = str(body.get("name") or "").strip()
    if not name or len(name) > 120:
        p.append("名稱必填（最多 120 字）")
    machine = body.get("machine") or {}
    machine = {k: str(machine.get(k) or "").strip()[:120] for k in ("manufacturer", "model", "name")}
    if not machine["manufacturer"] and not machine["model"]:
        p.append("機器的製造商或機型至少填一項")
    beam = body.get("beam") or {}
    energy = _number(beam.get("energy_mv"))
    if energy is None or not 0.5 <= energy <= 50:
        p.append("能量要在 0.5–50 MV")
    mode = beam.get("fluence_mode") or "STANDARD"
    if mode not in FLUENCE_MODES:
        p.append(f"fluence_mode 要是 {'／'.join(FLUENCE_MODES)}")
    source = body.get("source") or {}
    skind = source.get("kind")
    if skind not in SOURCE_KINDS:
        p.append(f"來源要是 {'／'.join(SOURCE_KINDS)}（實測／廠商代表資料／公開文獻／研究合成）")
    citation = str(source.get("citation") or "").strip()[:MAX_TEXT]
    if skind in ("literature", "vendor") and not citation:
        p.append("文獻與廠商資料要寫出處")
    raw_ms = body.get("measurements") or []
    if not isinstance(raw_ms, list) or len(raw_ms) > MAX_MEASUREMENTS:
        p.append(f"量測最多 {MAX_MEASUREMENTS} 筆")
        raw_ms = []
    measurements = []
    ids: set[str] = set()
    for i, raw in enumerate(raw_ms):
        if not isinstance(raw, dict):
            p.append(f"第 {i + 1} 筆量測格式錯")
            continue
        m, mp = check_measurement(raw)
        p += [numbered(i, raw.get("kind"), x) for x in mp]
        if m is not None:
            if m["measurement_id"] in ids:
                p.append(f"第 {i + 1} 筆：measurement_id 重複（{m['measurement_id']}）")
            ids.add(m["measurement_id"])
            measurements.append(m)
    if p:
        return None, p
    return {
        "name": name,
        "machine": machine,
        "beam": {"energy_mv": energy, "fluence_mode": mode},
        "source": {
            "kind": skind,
            "citation": citation,
            "licence": str(source.get("licence") or "").strip()[:MAX_TEXT],
            "url": str(source.get("url") or "").strip()[:MAX_TEXT],
            "note": str(source.get("note") or "").strip()[:MAX_TEXT],
        },
        "demo": skind != "measured",
        "measurements": measurements,
        "note": str(body.get("note") or "").strip()[:MAX_TEXT],
    }, []


def new_record(draft: dict[str, Any], *, user: str) -> dict[str, Any]:
    return {
        **draft,
        "dataset_id": f"bd_{uuid.uuid4().hex[:12]}",
        "status": "draft",
        "created_by": user,
        "created_at": _now(),
        "updated_by": None,
        "updated_at": None,
        "locked_by": None,
        "locked_at": None,
    }


def update_draft(item: dict[str, Any], draft: dict[str, Any], *, user: str) -> None:
    item.update(draft, updated_by=user, updated_at=_now())


def lock(item: dict[str, Any], *, user: str) -> None:
    """鎖定：之後不能改（擬合要引用固定的內容）。"""
    item.update(status="locked", locked_by=user, locked_at=_now())


def summary(ds: dict[str, Any]) -> dict[str, Any]:
    """清單用：不帶資料點。"""
    counts: dict[str, int] = {}
    for m in ds.get("measurements") or []:
        counts[m["kind"]] = counts.get(m["kind"], 0) + 1
    return {
        k: ds.get(k)
        for k in (
            "dataset_id", "name", "status", "builtin", "demo", "machine", "beam", "source", "note",
            "created_by", "created_at", "updated_by", "updated_at", "locked_by", "locked_at",
        )
    } | {"measurement_counts": counts, "measurements": len(ds.get("measurements") or [])}  # fmt: skip


def measurement_label(m: dict[str, Any]) -> str:
    """「PDD 100×100 SSD 1000」「OF d100 SSD 900」「mlc_transmission」：清單與殘差表用。"""
    c = m.get("conditions") or {}

    def field(key: str = "field_mm") -> str:
        f = c.get(key)
        return f"{f[0]:g}×{f[1]:g}" if f else ""

    geo = f"SSD {c['ssd_mm']:g}" if "ssd_mm" in c else (f"SAD {c['sad_mm']:g}" if "sad_mm" in c else "")
    depth = f"d{c['depth_mm']:g}" if "depth_mm" in c else ""
    k = m["kind"]
    if k == "depth_dose":
        parts = [m["quantity"].upper(), field(), geo]
    elif k == "profile":
        parts = ["Profile", c.get("axis", ""), field(), depth, geo]
    elif k == "output_factor":
        parts = ["OF", c.get("collimation", ""), depth, geo, "X×Y" if m.get("columns", [""])[0] == "field_x_mm" else ""]
    elif k == "absolute":
        parts = ["Gy/MU", field(), depth or "dmax", geo]
    else:
        parts = [m["quantity"], field(), depth, c.get("layer", "")]
    return " ".join(x for x in parts if x)


# ── 內建：公開文獻的資料 ──────────────────────────────────────────────────────

PUBLIC_DIR = "public_beam_data"
"""套件裡的公開資料（CC BY 文獻的表格，逐筆照原文抄；出處與授權在每個檔案的 `source` 與同目錄的 NOTICE）。"""


def builtin_datasets() -> list[dict[str, Any]]:
    """套件附的公開資料集（唯讀；可以複製成草稿再改）。檔案壞了直接丟例外 —— 測試會擋。"""
    import json
    from importlib import resources

    out = []
    root = resources.files("rtgaia_dosecalc") / PUBLIC_DIR
    if not root.is_dir():
        return out
    for entry in sorted(root.iterdir(), key=lambda e: e.name):
        if not entry.name.endswith(".json"):
            continue
        doc = json.loads(entry.read_text(encoding="utf-8"))
        draft, problems = check_dataset(doc)
        if draft is None:
            raise ValueError(f"{entry.name}: {'；'.join(problems)}")
        out.append(
            {
                **draft,
                "dataset_id": str(doc["dataset_id"]),
                "status": "builtin",
                "builtin": True,
                "created_by": None,
                "created_at": None,
            }
        )
    return out
