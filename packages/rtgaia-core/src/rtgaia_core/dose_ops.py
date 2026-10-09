"""劑量運算。

> 讓使用者對劑量矩陣做加減乘除：加減是兩個劑量之間，乘跟除是對一個固定值。

* **A ＋ B、A − B**：兩個劑量之間。結果在 **A 的網格**上；B 不在同一個網格時經 FrameGroup（同 FoR 或**剛性**對位）
  三線性重取樣，B 沒蓋到的點是 **NaN**（不是 0：沒資料就是沒資料，透明、不進統計）。
* **A × k、A ÷ k**：k 是正數（0、負數、非有限值擋掉 → ÷ 不會除以零）。
* 結果一律 Gy；可以再當運算元（串接 —— 多個劑量的加總就是一步一步加）。

## 型別規則（DICOM PS3.3 C.8.8.3）

* `DoseType`：`PHYSICAL` 與 `EFFECTIVE` 不能混算；運算元有 `ERROR` → 結果 `ERROR`；**減法的結果是 `ERROR`**
  （差值；存檔時若全部 ≥ 0 可經二次確認改 `PHYSICAL`，見 `routes_dose_ops`）。
* `DoseSummationType`（存檔時用）：所有來源的 `ReferencedRTPlanSequence` 取聯集 —— ≥ 2 個 → `MULTI_PLAN`；
  剛好 1 個 → 沿用第一個來源的類型；0 個 → 不能存。

## 射束劑量合成計畫劑量

`DoseSummationType=BEAM` 不能直接當運算元；要先合成：同一個計畫（病例裡要有那份 RTPLAN）、同一個 fraction group，
射束劑量引用的 beam 號**剛好**等於 fraction group 的射束（不缺、不重複、沒有多的），
同一個空間、同一種 DoseType、單位 Gy。
結果在第一個射束劑量的網格上（其他的不同網格就三線性重取樣），`DoseSummationType` 當 `PLAN`。見 `beam_groups`。

## 不在這裡做

自動換算分次、生物等效（EQD2／BED）、形變累積。
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

import numpy as np
from rtgaia_geom.grid import Grid

OPS = ("add", "sub", "mul", "div")
OP_SYMBOL = {"add": "+", "sub": "−", "mul": "×", "div": "÷"}
K_MAX = 1000.0
"""× ÷ 的 k 上限：比分次數（最多數十）大很多，擋掉打錯一個數量級以上的輸入。"""
MAX_DERIVED_PER_USER = 20
"""每人每個病例最多幾個暫存結果（每個是一份 A 網格大小的 float32）。"""
MIXED_COURSE_RATIO = 3.0
"""A ± B 兩邊 Dmax 差這麼多倍 → 提示「可能混了整個療程與單次」。"""
EXCLUDED_SUMMATION = frozenset({"BEAM", "BEAM_SESSION", "CONTROL_POINT"})
"""不能直接當運算元的。BEAM 先用 `beam_sum` 合成計畫劑量；BEAM_SESSION／CONTROL_POINT 不做。"""
RIGID_MATRIX_TYPES = frozenset({"RIGID", ""})
RESAMPLE_SAME_TOL = 1e-6


def short_label(series: Any) -> str:
    """運算式裡的名字：計畫標籤 → SeriesDescription → 序列 UID 尾碼，後面加日期；衍生結果用它自己的式子。"""
    derived = series.params.get("derived") if series.params else None
    if isinstance(derived, dict) and derived.get("text"):
        return str(derived["text"])
    # 計畫標籤比 SeriesDescription 好認（Eclipse 的劑量描述一律是「Eclipse Doses」）；再加日期 MM-DD 區分分次
    plan = str((series.params or {}).get("referenced_plan_label") or "").strip()
    desc = str((series.meta or {}).get("series_description") or "").strip()
    base = plan or desc or f"RTDOSE …{series.series_id[-6:]}"
    # 射束劑量同一個計畫標籤 → 加射束號，不然 N 個射束劑量同名
    beams = sorted({int(b) for _, b in (series.params or {}).get("referenced_beams") or []})
    if str((series.params or {}).get("summation_type") or "").upper() == "BEAM" and beams:
        base = f"{base} beam {','.join(str(b) for b in beams)}"
    date = str((series.meta or {}).get("series_date") or "").strip()
    return f"{base} {date[4:6]}-{date[6:8]}" if len(date) >= 8 and date.isdigit() else base


def leaf_of(series: Any) -> dict[str, Any]:
    """原始劑量（資料庫裡的 RTDOSE）在運算鏈裡的葉節點。"""
    p = series.params or {}
    return {
        "series_id": series.series_id,
        "label": short_label(series),
        "sop_instance_uid": str(p.get("sop_instance_uid") or ""),
        "dose_type": str(p.get("dose_type") or "").upper(),
        "summation_type": str(p.get("summation_type") or "").upper(),
        "plan_sop_uids": [str(u) for u in p.get("referenced_plan_sop_uids") or []],
    }


def chain_of(series: Any) -> dict[str, Any]:
    derived = (series.params or {}).get("derived")
    if isinstance(derived, dict) and isinstance(derived.get("chain"), dict):
        return dict(derived["chain"])
    return leaf_of(series)


def children(node: dict[str, Any]) -> list[dict[str, Any]]:
    """運算節點的運算元：`a`、`b`；射束合成是 `parts`。"""
    if "op" not in node:
        return []
    if node["op"] == "beam_sum":
        return list(node.get("parts") or [])
    return [node["a"], *([node["b"]] if node.get("b") is not None else [])]


def leaves(node: dict[str, Any]) -> list[dict[str, Any]]:
    if "op" not in node:
        return [node]
    return [x for c in children(node) for x in leaves(c)]


def fmt_k(k: float) -> str:
    return f"{k:g}"


def chain_text(node: dict[str, Any]) -> str:
    """`(fx_1 + fx_2) × 5`。子運算一律加括號（不靠優先順序，讀的人不必想）。"""
    if "op" not in node:
        return str(node.get("label") or node.get("series_id") or "?")

    def part(n: dict[str, Any]) -> str:
        return f"({chain_text(n)})" if "op" in n else chain_text(n)

    if node["op"] == "transform":
        return f"{part(node['a'])} → {node.get('target_label') or '?'}"
    if node["op"] == "beam_sum":
        beams = ",".join(str(b) for b in node.get("beams") or [])
        return f"Σ beams {beams} ({node.get('plan_label') or '?'})"
    sym = OP_SYMBOL[node["op"]]
    if node["op"] in ("mul", "div"):
        return f"{part(node['a'])} {sym} {fmt_k(float(node['k']))}"
    return f"{part(node['a'])} {sym} {part(node['b'])}"


def has_sub(node: dict[str, Any]) -> bool:
    if "op" not in node:
        return False
    return node["op"] == "sub" or any(has_sub(c) for c in children(node))


def plan_union(node: dict[str, Any]) -> list[str]:
    out: list[str] = []
    for leaf in leaves(node):
        for u in leaf.get("plan_sop_uids") or []:
            if u and u not in out:
                out.append(u)
    return out


def summation_type_for_save(node: dict[str, Any]) -> str | None:
    """計畫參照聯集 ≥ 2 → MULTI_PLAN；1 → 第一個來源的類型；0 → None（不能存）。"""
    plans = plan_union(node)
    if len(plans) >= 2:
        return "MULTI_PLAN"
    if len(plans) == 1:
        first = leaves(node)[0].get("summation_type") or "PLAN"
        # 射束劑量只能經 beam_sum 進運算鏈 → 合成後就是計畫劑量
        return "PLAN" if first == "MULTI_PLAN" or first in EXCLUDED_SUMMATION else str(first)
    return None


# ── 運算元資格 ────────────────────────────────────────────────────────────────


@dataclass
class OperandCheck:
    problems: list[str] = field(default_factory=list)
    """不能用的原因（有就整個擋）。"""
    notes: list[str] = field(default_factory=list)
    """能用，但要讓使用者知道的事。"""


def operand_check(series: Any, frame_groups: tuple[Any, ...], plan_sops_in_case: set[str]) -> OperandCheck:
    """這個劑量能不能當運算元（不看另一邊）。"""
    out = OperandCheck()
    p = series.params or {}
    if series.kind != "dose":
        out.problems.append("不是劑量")
        return out
    units = str(p.get("units") or "").upper()
    if units != "GY":
        out.problems.append(f"DoseUnits={units or '(缺)'}，不是 Gy")
    st = str(p.get("summation_type") or "").upper()
    if st in EXCLUDED_SUMMATION:
        out.problems.append(
            f"DoseSummationType={st}：射束劑量要先合成計畫劑量（「射束劑量 → 計畫劑量」）"
            if st == "BEAM"
            else f"DoseSummationType={st}：不能當運算元"
        )
    scaling = p.get("dose_grid_scaling")
    if scaling is not None and not (isinstance(scaling, (int, float)) and np.isfinite(scaling) and scaling > 0):
        out.problems.append("DoseGridScaling 無效")
    # 運算只在同一個空間裡做；要換空間先「套用 REG」產生新的劑量 —— 對位狀態只是說明，不擋運算
    reg = registration_of(series.frame_of_reference_uid, frame_groups)
    if reg["kind"] == "none":
        out.notes.append("這個空間沒有對位到主要影像")
    elif reg["kind"] == "manual":
        out.notes.append("手動對位")
    if not isinstance(p.get("derived"), dict):
        plans = [str(u) for u in p.get("referenced_plan_sop_uids") or []]
        if plans and not any(u in plan_sops_in_case for u in plans):
            out.notes.append("參照的計畫不在病例裡（分次數查不到）")
        if not plans:
            out.notes.append("沒有參照計畫")
    return out


def beam_groups(
    doses: list[Any], plans: dict[str, dict[str, Any]], frame_groups: tuple[Any, ...]
) -> list[dict[str, Any]]:
    """病例裡的射束劑量（`summation_type=BEAM`、不是運算結果）依計畫分組，每組能不能合成計畫劑量、為什麼不能。

    `plans`：病例裡的 RTPLAN SOP → `read_plan_beams` 的結果（要 `label`、`fraction_groups`）。
    """
    by_plan: dict[str, list[Any]] = {}
    unreferenced: list[Any] = []
    for s in doses:
        p = s.params or {}
        if isinstance(p.get("derived"), dict) or str(p.get("summation_type") or "").upper() != "BEAM":
            continue
        refs = [str(u) for u in p.get("referenced_plan_sop_uids") or [] if u]
        if not refs:
            unreferenced.append(s)
            continue
        by_plan.setdefault(refs[0], []).append(s)
    out: list[dict[str, Any]] = []
    for plan_sop, members in by_plan.items():
        problems: list[str] = []
        plan = plans.get(plan_sop)
        rows = []
        covered: dict[int, list[str]] = {}
        groups: set[int] = set()
        for s in members:
            beams = [(int(g), int(b)) for g, b in (s.params or {}).get("referenced_beams") or []]
            groups.update(g for g, _ in beams)
            for _, b in beams:
                covered.setdefault(b, []).append(s.series_id)
            rows.append({"series_id": s.series_id, "label": short_label(s), "beams": sorted({b for _, b in beams})})
            if not beams:
                problems.append(f"「{short_label(s)}」沒有寫是哪個射束（ReferencedBeamSequence）")
            check = operand_check(s, frame_groups, set(plans))
            problems += [x for x in check.problems if not x.startswith("DoseSummationType=")]
        expected: list[int] = []
        group = min(groups) if groups else 1
        if plan is None:
            problems.append("引用的計畫不在病例裡：無法核對射束是否齊全（開病例時把 RTPLAN 一起選進來）")
        else:
            if len(groups) > 1:
                problems.append(f"射束劑量分屬不同的 fraction group（{', '.join(str(g) for g in sorted(groups))}）")
            fg = next((f for f in plan.get("fraction_groups") or [] if int(f.get("number") or 1) == group), None)
            if fg is None:
                problems.append(f"計畫沒有 fraction group {group}")
            else:
                expected = sorted(int(b) for b in fg.get("beam_numbers") or [])
        missing = sorted(set(expected) - set(covered)) if plan is not None else []
        extra = sorted(set(covered) - set(expected)) if plan is not None else []
        duplicates = sorted(b for b, ids in covered.items() if len(ids) > 1)
        if missing:
            problems.append(f"缺射束 {', '.join(str(b) for b in missing)} 的劑量")
        if extra:
            problems.append(f"射束 {', '.join(str(b) for b in extra)} 不在計畫的 fraction group {group} 裡")
        if duplicates:
            problems.append(f"射束 {', '.join(str(b) for b in duplicates)} 有不只一個劑量")
        if len({s.frame_of_reference_uid for s in members}) > 1:
            problems.append("射束劑量不在同一個空間")
        types = {str((s.params or {}).get("dose_type") or "PHYSICAL").upper() for s in members}
        if len(types) > 1:
            problems.append(f"DoseType 不同（{'、'.join(sorted(types))}）")
        out.append(
            {
                "plan_sop_uid": plan_sop,
                "plan_label": (plan or {}).get("label") or "",
                "fraction_group": group,
                "fractions_planned": next(
                    (
                        f.get("fractions_planned")
                        for f in (plan or {}).get("fraction_groups") or []
                        if int(f.get("number") or 1) == group
                    ),
                    None,
                ),
                "expected_beams": expected,
                "doses": sorted(rows, key=lambda r: (r["beams"] or [1 << 30])[0]),
                "missing": missing,
                "extra": extra,
                "duplicates": duplicates,
                "problems": list(dict.fromkeys(problems)),
                "eligible": not problems,
            }
        )
    if unreferenced:
        out.append(
            {
                "plan_sop_uid": "",
                "plan_label": "",
                "fraction_group": None,
                "fractions_planned": None,
                "expected_beams": [],
                "doses": [{"series_id": s.series_id, "label": short_label(s), "beams": []} for s in unreferenced],
                "missing": [],
                "extra": [],
                "duplicates": [],
                "problems": ["射束劑量沒有引用計畫（ReferencedRTPlanSequence）：不知道是哪個計畫的"],
                "eligible": False,
            }
        )
    return out


def beam_sum_dose_type(members: list[Any]) -> str:
    types = {str((s.params or {}).get("dose_type") or "PHYSICAL").upper() for s in members}
    return "ERROR" if "ERROR" in types else next(iter(types))


def registration_of(frame_of_reference_uid: str, frame_groups: tuple[Any, ...]) -> dict[str, Any]:
    """劑量所在 FoR 怎麼到 primary：`primary`｜`rigid`（REG／假體／同 FoR）｜`manual`｜`none`｜`non_rigid`。"""
    fg = next((f for f in frame_groups if f.frame_of_reference_uid == frame_of_reference_uid), None)
    if fg is None:
        return {"kind": "none", "matrix_type": None, "sop_instance_uid": None}
    if fg.role == "primary":
        return {"kind": "primary", "matrix_type": None, "sop_instance_uid": None}
    reg = fg.registration
    if reg is None or reg.source in ("phantom", "shared_frame"):
        return {"kind": "rigid", "matrix_type": None, "sop_instance_uid": None}
    if reg.source == "none":
        return {"kind": "none", "matrix_type": None, "sop_instance_uid": None}
    if reg.source == "manual":
        return {"kind": "manual", "matrix_type": "RIGID", "sop_instance_uid": None}
    mt = str(reg.matrix_type or "").upper()
    if mt not in RIGID_MATRIX_TYPES:
        return {"kind": "non_rigid", "matrix_type": mt, "sop_instance_uid": reg.sop_instance_uid}
    return {"kind": "rigid", "matrix_type": mt or "RIGID", "sop_instance_uid": reg.sop_instance_uid}


def result_dose_type(op: str, a: dict[str, Any], b: dict[str, Any] | None) -> tuple[str | None, str | None]:
    """(結果的 DoseType, 問題)。`a`／`b` 是運算鏈節點；節點的型別看 `dose_type`（葉）或 `result_dose_type`（運算）。"""

    def typ(n: dict[str, Any]) -> str:
        return str(n.get("result_dose_type") or n.get("dose_type") or "PHYSICAL").upper()

    ta = typ(a)
    if op in ("mul", "div"):
        return ta, None
    assert b is not None
    tb = typ(b)
    if "ERROR" in (ta, tb):
        return "ERROR", None
    if ta != tb:
        return None, f"DoseType 不同（{ta} 與 {tb}）：物理劑量與生物等效劑量不能混算"
    return ("ERROR" if op == "sub" else ta), None


# ── 數值 ──────────────────────────────────────────────────────────────────────


def same_sampling(a_grid: Grid, a_to_primary: np.ndarray, b_grid: Grid, b_to_primary: np.ndarray) -> bool:
    if tuple(a_grid.size) != tuple(b_grid.size):
        return False
    ma = a_to_primary @ a_grid.index_to_world_matrix
    mb = b_to_primary @ b_grid.index_to_world_matrix
    return bool(np.allclose(ma, mb, atol=RESAMPLE_SAME_TOL))


def resample_onto(
    src_kji: np.ndarray,
    src_grid: Grid,
    src_to_primary: np.ndarray,
    dst_grid: Grid,
    dst_to_primary: np.ndarray,
) -> np.ndarray:
    """B（src）在 A（dst）每個體素中心的值，三線性；網格外 NaN。一層一層算（記憶體 ≈ 一層的座標）。"""
    from scipy.ndimage import map_coordinates

    # dst ijk → dst world → primary → src world → src ijk
    m = src_grid.world_to_index_matrix @ np.linalg.inv(src_to_primary) @ dst_to_primary @ dst_grid.index_to_world_matrix
    ni, nj, nk = (int(v) for v in dst_grid.size)
    jj, ii = np.meshgrid(np.arange(nj, dtype=np.float64), np.arange(ni, dtype=np.float64), indexing="ij")
    flat_i, flat_j = ii.ravel(), jj.ravel()
    src = np.asarray(src_kji, dtype=np.float32)
    out = np.empty((nk, nj, ni), dtype=np.float32)
    for k in range(nk):
        si = m[0, 0] * flat_i + m[0, 1] * flat_j + m[0, 2] * k + m[0, 3]
        sj = m[1, 0] * flat_i + m[1, 1] * flat_j + m[1, 2] * k + m[1, 3]
        sk = m[2, 0] * flat_i + m[2, 1] * flat_j + m[2, 2] * k + m[2, 3]
        vals = map_coordinates(src, [sk, sj, si], order=1, mode="constant", cval=np.nan, prefilter=False)
        out[k] = vals.reshape(nj, ni)
    return out


def compose(op: str, a: np.ndarray, b: np.ndarray | None = None, k: float | None = None) -> np.ndarray:
    a = np.asarray(a, dtype=np.float32)
    if op == "add":
        assert b is not None
        return a + b
    if op == "sub":
        assert b is not None
        return a - b
    assert k is not None
    if op == "mul":
        return a * np.float32(k)
    if op == "div":
        return a / np.float32(k)
    raise ValueError(op)


def check_k(op: str, k: Any) -> tuple[float | None, str | None]:
    """× ÷ 的 k：正數、有限、≤ K_MAX。"""
    if op not in ("mul", "div"):
        return None, None
    try:
        v = float(k)
    except (TypeError, ValueError):
        return None, "k 要是數字"
    if not np.isfinite(v) or v <= 0:
        return None, "k 必須是正數（0 與負數不允許）"
    if v > K_MAX:
        return None, f"k 不能超過 {K_MAX:g}"
    return v, None


def summary(values: np.ndarray) -> dict[str, Any]:
    """結果的整體數字：最大、最小、平均（只算有資料的點）、有資料的比例。"""
    finite = np.isfinite(values)
    n = int(values.size)
    covered = int(finite.sum())
    if covered == 0:
        return {"max_gy": 0.0, "min_gy": 0.0, "mean_gy": None, "covered_fraction": 0.0}
    v = values[finite]
    return {
        "max_gy": float(v.max()),
        "min_gy": float(v.min()),
        "mean_gy": float(v.mean()),
        "covered_fraction": covered / n if n else 0.0,
    }


def signed_stats(values: np.ndarray) -> dict[str, Any]:
    """差值（有負值）的統計：最大正差、最大負差、平均差（差值不畫 DVH 曲線）。"""
    finite = values[np.isfinite(values)]
    if finite.size == 0:
        return {"max_pos_gy": None, "max_neg_gy": None, "mean_gy": None, "count": 0}
    return {
        "max_pos_gy": float(max(0.0, float(finite.max()))),
        "max_neg_gy": float(min(0.0, float(finite.min()))),
        "mean_gy": float(finite.mean()),
        "count": int(finite.size),
    }


# ── 套用 REG：把劑量搬到另一個空間（先選劑量、再選要套用哪個 REG → 新的劑量物件）──────────


def transform_options(
    dose_for: str,
    registrations: list[dict[str, Any]],
    frame_groups: tuple[Any, ...],
    fors_in_case: set[str],
) -> list[dict[str, Any]]:
    """這個劑量（在 `dose_for`）可以套用的轉換：

    * 每個 REG：item 的來源是這個空間 → 到 REG 的參考空間（`M`）；
      REG 的參考空間是這個空間 → 到每個 item 的來源（`inv(M)`）。
    * 「目前的對位」：病例裡這個空間 → 主要影像的 FrameGroup（含手動微調後的）。
    目標空間不在病例裡（沒有那個 FoR 的影像）→ 列出但 `problem`。只收剛性的。
    """
    out: list[dict[str, Any]] = []
    for r in registrations:
        fixed = str(r.get("frame_of_reference_uid") or "")
        for it in r.get("items") or []:
            src = str(it.get("source_frame_of_reference_uid") or "")
            m = np.asarray(it.get("matrix_row_major") or np.eye(4).reshape(-1), dtype=np.float64).reshape(4, 4)
            for a, b, mat in ((src, fixed, m), (fixed, src, None)):
                if a != dose_for or not b or a == b:
                    continue
                mt = str(it.get("matrix_type") or "RIGID").upper()
                out.append(
                    {
                        "transform_id": f"reg:{r.get('sop_instance_uid')}:{a}>{b}",
                        "kind": "REG",
                        "reg_id": r.get("reg_id"),
                        "sop_instance_uid": r.get("sop_instance_uid"),
                        "series_date": r.get("series_date"),
                        "label": r.get("label") or "",
                        "inverse": mat is None,
                        "matrix_type": mt,
                        "target_frame_of_reference_uid": b,
                        "matrix_row_major": (mat if mat is not None else np.linalg.inv(m)).reshape(-1).tolist(),
                        "problem": None
                        if b in fors_in_case and mt in RIGID_MATRIX_TYPES | {"RIGID"}
                        else (
                            "目標空間不在病例裡（沒有那個 FoR 的影像）"
                            if b not in fors_in_case
                            else f"不是剛性（{mt}）"
                        ),
                    }
                )
    primary = next((f for f in frame_groups if f.role == "primary"), None)
    own = next((f for f in frame_groups if f.frame_of_reference_uid == dose_for), None)
    if primary is not None and own is not None and own is not primary:
        reg = registration_of(dose_for, frame_groups)
        m = np.linalg.inv(primary.matrix) @ own.matrix
        out.append(
            {
                "transform_id": f"fg:{dose_for}>{primary.frame_of_reference_uid}",
                "kind": "current",
                "reg_id": None,
                "sop_instance_uid": reg.get("sop_instance_uid"),
                "series_date": None,
                "label": "",
                "inverse": False,
                "matrix_type": reg.get("matrix_type") or "RIGID",
                "source": reg["kind"],
                "target_frame_of_reference_uid": primary.frame_of_reference_uid,
                "matrix_row_major": m.reshape(-1).tolist(),
                "problem": "這個空間沒有對位到主要影像" if reg["kind"] in ("none", "non_rigid") else None,
            }
        )
    return out


def transformed_grid(src: Grid, m: np.ndarray, target_direction: tuple[float, ...], target_for: str) -> Grid:
    """`src` 網格經 `m`（src 世界 → 目標世界）之後，在目標空間（方向 ＝ 目標影像的方向）裡剛好包住它的網格；
    間距沿用來源。"""
    d = np.asarray(target_direction, dtype=np.float64).reshape(3, 3)
    corners = src.corners_world  # (8, 3) 體素中心
    world = corners @ m[:3, :3].T + m[:3, 3]
    local = world @ d  # 投影到目標方向的軸上
    lo, hi = local.min(axis=0), local.max(axis=0)
    spacing = np.asarray(src.spacing, dtype=np.float64)
    size = np.maximum(1, np.ceil((hi - lo) / spacing - 1e-6).astype(int) + 1)
    origin = d @ lo
    return Grid(
        size=tuple(int(v) for v in size),  # type: ignore[arg-type]
        spacing=tuple(float(v) for v in spacing),  # type: ignore[arg-type]
        origin=tuple(float(v) for v in origin),  # type: ignore[arg-type]
        direction=tuple(float(v) for v in d.reshape(-1)),  # type: ignore[arg-type]
        frame_of_reference_uid=target_for,
    )
