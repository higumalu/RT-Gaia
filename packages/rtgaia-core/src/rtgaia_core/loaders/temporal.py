"""真實 DICOM 的 4D／動態影像 → 時間軸。

DICOM 有三種形狀：

* **A. 每個相位／時間點一個序列**（4DCT 最常見）—— 傳統 CT 標準裡**沒有任何相位欄位**，也沒有欄位把多個序列連成
  一次掃描；只能靠「同 study、同 FoR、同網格」＋ 序列描述解析出相位（`0%`、`Gated, 40.0%`、`In 25%`）。
  → `cross_series_plans`
* **B. 一個序列、同一個位置重複多次**（MR DCE、4D-MRI、多回波、DWI、cine）—— 依 Temporal Position Identifier／
  Acquisition Number／Trigger Time／Acquisition Time 分幀；回波與 b 值是**參數軸**不是時間。→ `analyze_series`
* **C. Enhanced 多幀** —— `loaders/enhanced.py`。

規則：
* 高信心（標準欄位、描述解析得出相位）自動合併；低信心（沒有標籤、只有時間戳）只列為候選，使用者按了才合併；
  兩種都能在資料頁改（`CaseSelection.temporal_overrides`）。
* 回波、b 值 → 參數軸（`axis_label` echo_time／b_value、`unit`），不是時間。
* 不一致的相位（缺片、網格不同）→ **排除並警告**，組照樣成立。

這裡只用標頭（`InstanceHeader`）與少數額外標籤（`_dyn_tags`，開病例時才讀、依檔案快取），不讀像素。
"""

from __future__ import annotations

import hashlib
import re
from collections import Counter, defaultdict
from collections.abc import Iterable, Sequence
from dataclasses import dataclass, field
from functools import lru_cache
from typing import Any

import numpy as np

from ..library.index import SeriesEntry
from ..library.scan import InstanceHeader

# ── 描述文字的解析 ───────────────────────────────────────────

_AMPLITUDE = re.compile(r"(?:^|[\s,_(\-])(In|Ex|Insp|Exp|Inh|Exh)[a-z]*[\s_]*(\d{1,3}(?:\.\d+)?)\s*%", re.IGNORECASE)
_PERCENT = re.compile(r"(?:^|[^\d.])(\d{1,3}(?:\.\d+)?)\s*%")
_DERIVED = re.compile(
    r"\b(AVG|AVE|AVERAGE|AIP|AVE-?IP|MEAN|MIP|MAXIP|MAX-?IP|MINIP|MIN-?IP)\b",
    re.IGNORECASE,
)
_DERIVED_OP = {"MEAN": "avg", "MAXIMUM": "mip", "MINIMUM": "minip"}


@dataclass(frozen=True)
class PhaseLabel:
    kind: str
    """`phase`（0–100 % 的相位）或 `amplitude`（In／Ex 振幅分箱）。"""
    value: float
    side: str = ""
    """振幅分箱的 In／Ex。"""
    text: str = ""
    stem: str = ""
    """描述去掉標籤之後的部分：同一次掃描的各相位要一樣（`Chest 3.0, Gated,`）。"""

    @property
    def order(self) -> tuple[int, float]:
        """排序：相位依百分比；振幅依 In 遞增 → Ex 遞減（一個呼吸週期）。"""
        if self.kind == "amplitude":
            return (0, self.value) if self.side == "In" else (1, -self.value)
        return (0, self.value)


def _norm_stem(text: str) -> str:
    return re.sub(r"[\s,;:_\-]+", " ", text).strip().lower()


def parse_phase_label(description: str) -> PhaseLabel | None:
    """序列描述 → 相位或振幅標籤；衍生影像（AVG／MIP）回 None。"""
    desc = description or ""
    if derived_op(desc) is not None:
        return None
    m = _AMPLITUDE.search(desc)
    if m:
        side = "In" if m.group(1).lower().startswith("in") else "Ex"
        value = float(m.group(2))
        if value <= 100:
            stem = _norm_stem(desc[: m.start()] + " " + desc[m.end() :])
            return PhaseLabel("amplitude", value, side, f"{side} {value:g}%", stem)
    m = _PERCENT.search(desc)
    if m:
        value = float(m.group(1))
        if value <= 100:
            stem = _norm_stem(desc[: m.start(1)] + " " + desc[m.end() :])
            return PhaseLabel("phase", value, "", f"{value:g}%", stem)
    return None


def derived_op(description: str, image_type: Sequence[str] = ()) -> str | None:
    """AVG／MIP／MinIP（序列描述，或 Image Type 第 4 值 MEAN／MAXIMUM／MINIMUM，PS3.3 C.8.16.1）。"""
    m = _DERIVED.search(description or "")
    if m:
        word = m.group(1).upper().replace("-", "")
        if word in ("MIP", "MAXIP"):
            return "mip"
        if word == "MINIP":
            return "minip"
        return "avg"
    it = [str(v).upper() for v in image_type]
    if len(it) >= 4 and it[0] == "DERIVED":
        return _DERIVED_OP.get(it[3])
    return None


# ── 額外標籤（形狀 B、衍生影像判斷）：開病例時才讀，依檔案快取 ─────────────────────

_DYN_TAGS = [
    "ImageType",
    "TemporalPositionIdentifier",
    "NumberOfTemporalPositions",
    "AcquisitionNumber",
    "TriggerTime",
    "AcquisitionTime",
    "ContentTime",
    "EchoNumbers",
    "EchoTime",
    "DiffusionBValue",
    0x0019100C,  # Siemens B_value（MultiVolumeImporter）
    0x00431039,  # GE Slop_int_6..9（第一個值 % 100000 ＝ b）
    0x20011003,  # Philips Diffusion B-Factor
]


def _tm_seconds(value: Any) -> float | None:
    text = str(value or "").strip()
    if len(text) < 2:
        return None
    try:
        h = int(text[0:2])
        m = int(text[2:4]) if len(text) >= 4 else 0
        s = float(text[4:]) if len(text) > 4 else 0.0
    except ValueError:
        return None
    return h * 3600 + m * 60 + s


def _num(value: Any) -> float | None:
    if value is None or value == "":
        return None
    try:
        if isinstance(value, (list, tuple)) or hasattr(value, "__iter__") and not isinstance(value, (str, bytes)):
            value = list(value)[0]
        return float(value)
    except (TypeError, ValueError, IndexError):
        return None


@lru_cache(maxsize=65536)
def _dyn_tags_cached(path: str, mtime_ns: int) -> dict[str, Any]:
    import pydicom

    ds = pydicom.dcmread(path, stop_before_pixels=True, specific_tags=_DYN_TAGS)
    b = _num(ds.get("DiffusionBValue"))
    if b is None and (el := ds.get(0x0019100C)) is not None:
        b = _num(el.value)
    if b is None and (el := ds.get(0x00431039)) is not None:
        first = _num(el.value)
        b = None if first is None else float(int(first) % 100000)
    if b is None and (el := ds.get(0x20011003)) is not None:
        b = _num(el.value)
    return {
        "image_type": [str(v).upper() for v in (ds.get("ImageType") or [])],
        "tpi": _num(ds.get("TemporalPositionIdentifier")),
        "acquisition_number": _num(ds.get("AcquisitionNumber")),
        "trigger_time": _num(ds.get("TriggerTime")),
        "acquisition_time": _tm_seconds(ds.get("AcquisitionTime")),
        "content_time": _tm_seconds(ds.get("ContentTime")),
        "echo_number": _num(ds.get("EchoNumbers")),
        "echo_time": _num(ds.get("EchoTime")),
        "b_value": b,
        "resp_phase": None,  # 只有 Enhanced 的 Functional Group 有（傳統影像標準裡沒有）
        "cardiac_phase": None,
    }


def dyn_tags(h: InstanceHeader) -> dict[str, Any]:
    if h.frame_number is not None and isinstance(h.refs, dict) and "dyn" in h.refs:
        return h.refs["dyn"]  # Enhanced 多幀攤開的虛擬切片，這一幀的欄位在攤開時就讀好了
    return _dyn_tags_cached(h.path, h.mtime_ns)


# ── 結果 ────────────────────────────────────────────────────────────────────


@dataclass(frozen=True)
class FrameSpec:
    """時間軸的一幀：一組切片（形狀 A 是一整個序列，形狀 B 是序列的一部分）。"""

    headers: tuple[InstanceHeader, ...]
    series_uid: str
    label: str | None = None
    time_s: float | None = None


@dataclass(frozen=True)
class TemporalPlan:
    """一條時間軸該怎麼組（還沒讀像素）。`key` 是穩定的 id：資料頁與開病例用同一個。"""

    key: str
    kind: str
    """`cyclic`（相位：首尾相接）或 `series`（時間序列、參數軸）。"""
    axis: str
    """`phase`／`amplitude`／`time`／`echo_time`／`b_value`。"""
    confidence: str
    """`high`／`medium` 自動合併；`low` 只列候選。"""
    source: str
    """怎麼判斷的（給人看）：`series_description`、`TemporalPositionIdentifier`…"""
    frames: tuple[FrameSpec, ...]
    unit: str | None = None
    derived: tuple[tuple[str, str], ...] = ()
    """同一組的衍生影像 `(series_uid, avg|mip|minip)`：不進時間軸、跟著這組。"""
    excluded: tuple[dict[str, Any], ...] = ()
    """被排除的相位：`{series_uid, label, reason, detail, position}`（`position` ＝ 排除前在時間軸上的位置）。"""
    resampled: tuple[dict[str, Any], ...] = ()
    """網格跟第一幀不同、使用者選了「重新取樣補進來」的相位（形狀同 `excluded`）—— 已經在 `frames` 裡。"""
    split_off: tuple[dict[str, Any], ...] = ()
    """同一序列裡拆出去、這次不載入的影像（相位圖、ADC…）：`{kind, count}`。"""
    warnings: tuple[str, ...] = ()
    resample: bool = False
    """網格跟第一幀不同的幀**重新取樣到第一幀的網格**（不排除）。使用者在時間軸列（或組成 4D）選的。"""
    b_guess: tuple[float, ...] = ()
    """DWI 沒有 b 值標籤時**從描述推定**的 b 值（每幀一個；空 ＝ 沒推定）。幀標籤帶「?」。"""
    b_implied: bool = False
    """`b_guess` 的 b0 是補上的（描述沒寫）。"""

    @property
    def auto(self) -> bool:
        return self.confidence != "low"

    @property
    def frame_series_uids(self) -> list[str]:
        return list(dict.fromkeys(f.series_uid for f in self.frames))

    @property
    def member_uids(self) -> list[str]:
        """資料頁「選這一列」要選的：各幀的序列 ＋ 衍生影像 ＋ 被排除的（使用者仍可以個別開）。"""
        return list(
            dict.fromkeys(
                [*self.frame_series_uids, *(u for u, _ in self.derived), *(x["series_uid"] for x in self.excluded)]
            )
        )

    @property
    def labels(self) -> list[str] | None:
        if all(f.label is None for f in self.frames):
            return None
        return [f.label or f"#{n + 1}" for n, f in enumerate(self.frames)]

    @property
    def times(self) -> list[float] | None:
        ts = [f.time_s for f in self.frames]
        if any(t is None for t in ts):
            return None
        vals = [float(t) for t in ts if t is not None]
        if any(b <= a for a, b in zip(vals, vals[1:], strict=False)):
            return None
        return vals

    def wire(self) -> dict[str, Any]:
        return {
            "key": self.key,
            "kind": self.kind,
            "axis": self.axis,
            "unit": self.unit,
            "confidence": self.confidence,
            "auto": self.auto,
            "source": self.source,
            "frame_count": len(self.frames),
            "frame_labels": self.labels,
            "frame_times": self.times,
            "frame_series_uids": [f.series_uid for f in self.frames],
            "derived": [{"series_uid": u, "op": op} for u, op in self.derived],
            "excluded": list(self.excluded),
            "resampled": list(self.resampled),
            "resample": self.resample,
            "split_off": list(self.split_off),
            "warnings": list(self.warnings),
            "b_guess": list(self.b_guess),
        }


def _key(*parts: Iterable[str]) -> str:
    h = hashlib.sha1("|".join(sorted(p for ps in parts for p in ps)).encode()).hexdigest()
    return f"tg_{h[:12]}"


# ── 幾何簽章（不讀像素、不丟例外）───────────────────────────────────────────


def _normal(iop: Sequence[float]) -> np.ndarray:
    r = np.asarray(iop[:3], dtype=np.float64)
    c = np.asarray(iop[3:6], dtype=np.float64)
    n = np.cross(r, c)
    norm = float(np.linalg.norm(n))
    return n / norm if norm > 0 else n


def _plane_key(h: InstanceHeader) -> tuple[Any, ...]:
    """同一組的切片必須一樣的部分：列數、欄數、像素間距、方向。"""
    return (
        h.rows,
        h.columns,
        tuple(round(float(v), 4) for v in h.pixel_spacing),
        tuple(round(float(v), 4) for v in h.image_orientation_patient),
    )


def _projections(headers: Sequence[InstanceHeader]) -> list[float]:
    if not headers or len(headers[0].image_orientation_patient) != 6:
        return []
    n = _normal(headers[0].image_orientation_patient)
    return sorted(
        float(np.dot(np.asarray(h.image_position_patient, dtype=np.float64), n))
        for h in headers
        if len(h.image_position_patient) == 3
    )


def stack_signature(headers: Sequence[InstanceHeader]) -> tuple[int, float, float, float]:
    """(片數, 第一片, 最後一片, 間距中位數)：各相位要一樣（不一樣就排除）。"""
    p = _projections(headers)
    if not p:
        return (0, 0.0, 0.0, 0.0)
    step = float(np.median(np.diff(p))) if len(p) > 1 else 0.0
    return (len(p), round(p[0], 2), round(p[-1], 2), round(step, 3))


def _uniform(headers: Sequence[InstanceHeader]) -> bool:
    """間距均勻（跟影像載入器的 DL11／DL12 同一套容許值）。"""
    from rtgaia_geom.errors import ContractViolation

    from .dicom import check_spacing

    p = _projections(headers)
    if len(p) < 2:
        return True
    try:
        check_spacing(p)
    except ContractViolation:
        return False
    return True


def repeated_positions(entry: SeriesEntry) -> int:
    """同一個位置最多出現幾次（1 ＝ 一般的 3D 序列）。只看標頭，資料頁也用。"""
    if not entry.instances:
        return 1
    hs = entry.instances
    if len(hs[0].image_orientation_patient) != 6:
        return 1
    n = _normal(hs[0].image_orientation_patient)
    counts = Counter(
        round(float(np.dot(np.asarray(h.image_position_patient, dtype=np.float64), n)), 2)
        for h in hs
        if len(h.image_position_patient) == 3
    )
    return max(counts.values()) if counts else 1


# ── 形狀 A：跨序列 ───────────────────────────────────────────────────────────


def _image_type_of(entry: SeriesEntry) -> list[str]:
    if not entry.instances:
        return []
    try:
        return list(dyn_tags(entry.instances[0])["image_type"])
    except Exception:  # noqa: BLE001 - 讀不到 Image Type 就只靠描述
        return []


def _series_number(entry: SeriesEntry) -> float:
    try:
        return float(entry.series_number)
    except (TypeError, ValueError):
        return float("inf")


def _series_seconds(entry: SeriesEntry) -> float | None:
    """序列的時間：第一片的 Acquisition Time，沒有就 Series Time。"""
    if entry.instances:
        try:
            t = dyn_tags(entry.instances[0])["acquisition_time"]
            if t is not None:
                return float(t)
        except Exception:  # noqa: BLE001
            pass
    return _tm_seconds(entry.series_time)


def cross_series_plans(entries: Iterable[SeriesEntry], *, read_tags: bool = True) -> list[TemporalPlan]:
    """同一個 study 的影像序列 → 跨序列的時間軸候選。

    `read_tags=False`：只用索引裡的標頭（資料頁列表用；衍生影像只靠描述判斷、低信心候選沒有時間戳）。
    """
    buckets: dict[tuple[Any, ...], list[SeriesEntry]] = defaultdict(list)
    for e in entries:
        if not e.is_image or not e.instances or e.instances[0].number_of_frames not in (None, 1):
            continue
        if repeated_positions(e) > 1:
            continue  # 形狀 B 自己處理
        buckets[(e.study_instance_uid, e.frame_of_reference_uid, e.modality, _plane_key(e.instances[0]))].append(e)

    plans: list[TemporalPlan] = []
    for members in buckets.values():
        if len(members) < 2:
            continue
        used: set[str] = set()
        derived = [
            (e, op)
            for e in members
            if (op := derived_op(e.series_description, _image_type_of(e) if read_tags else ())) is not None
        ]
        derived_uids = {e.series_instance_uid for e, _ in derived}
        labeled: dict[tuple[str, str], list[tuple[SeriesEntry, PhaseLabel]]] = defaultdict(list)
        for e in members:
            if e.series_instance_uid in derived_uids:
                continue
            lab = parse_phase_label(e.series_description)
            if lab is not None:
                labeled[(lab.kind, lab.stem)].append((e, lab))
        labeled_plans: list[TemporalPlan] = []
        leftover: list[tuple[SeriesEntry, PhaseLabel]] = []
        for (kind, _stem), items in labeled.items():
            plan = _group_plan(kind, items, allow_duplicates=True)
            if plan is None:
                leftover.extend(items)
            else:
                labeled_plans.append(plan)
                used.update(plan.member_uids)
        # 描述裡帶每個序列不同的編號（4D-Lung／Pinnacle：`P4^P113^S303^I10350, Gated, 50.0%B`，
        # I 編號每個相位都不同）→ 精確比對湊不成組的，數字當萬用字元再湊一次。這一步比較寬，
        # 所以同一個相位出現兩次就不算（那多半是兩次不同的掃描，例：B30f／B70f 兩種重建）
        loose: dict[tuple[str, str], list[tuple[SeriesEntry, PhaseLabel]]] = defaultdict(list)
        for e, lab in leftover:
            loose[(lab.kind, re.sub(r"\d+", "#", lab.stem))].append((e, lab))
        for (kind, _stem), items in loose.items():
            plan = _group_plan(kind, items, allow_duplicates=False)
            if plan is not None:
                labeled_plans.append(plan)
                used.update(plan.member_uids)
        # 衍生影像跟著同一組（同 FoR、同網格）；一個 bucket 有多組時跟著網格相同的那一組
        for n, plan in enumerate(labeled_plans):
            ref = stack_signature(plan.frames[0].headers)
            mine = tuple(
                (e.series_instance_uid, op)
                for e, op in derived
                if stack_signature(e.instances) == ref and e.series_instance_uid not in used
            )
            if mine:
                labeled_plans[n] = _replace(plan, derived=mine)  # key 只看幀：衍生影像怎麼判斷不影響它
                used.update(u for u, _ in mine)
        plans.extend(labeled_plans)
        # 低信心：描述相同、日期相同、網格相同的 ≥ 3 個序列（沒有相位標籤）
        rest = [e for e in members if e.series_instance_uid not in used and e.series_instance_uid not in derived_uids]
        same: dict[tuple[str, str, tuple[Any, ...]], list[SeriesEntry]] = defaultdict(list)
        for e in rest:
            if parse_phase_label(e.series_description) is not None:
                continue
            same[(_norm_stem(e.series_description), e.series_date, stack_signature(e.instances))].append(e)
        for group in same.values():
            if len(group) < 3:
                continue
            group.sort(key=lambda e: (_series_number(e), e.series_time))
            times = [_series_seconds(e) if read_tags else _tm_seconds(e.series_time) for e in group]
            t0 = times[0]
            frames = tuple(
                FrameSpec(
                    headers=tuple(e.instances),
                    series_uid=e.series_instance_uid,
                    label=None,
                    time_s=(t - t0) if (t is not None and t0 is not None) else None,
                )
                for e, t in zip(group, times, strict=True)
            )
            plans.append(
                TemporalPlan(
                    key=_key([e.series_instance_uid for e in group]),
                    kind="series",
                    axis="time",
                    confidence="low",
                    source="series_number",
                    frames=frames,
                    warnings=("沒有相位標籤：依序列號排序，確認後才合併成時間軸",),
                )
            )
    return plans


def _group_plan(
    kind: str, items: list[tuple[SeriesEntry, PhaseLabel]], *, allow_duplicates: bool
) -> TemporalPlan | None:
    """同一個描述（去掉標籤）的有標籤序列 → 一條時間軸；不到 2 個不同的標籤 → None。"""
    by_label: dict[tuple[str, float], list[tuple[SeriesEntry, PhaseLabel]]] = defaultdict(list)
    for e, lab in items:
        by_label[(lab.side, lab.value)].append((e, lab))
    if len(by_label) < 2:
        return None
    if not allow_duplicates and any(len(v) > 1 for v in by_label.values()):
        return None
    warnings: list[str] = []
    chosen: list[tuple[SeriesEntry, PhaseLabel]] = []
    for dup in by_label.values():
        dup.sort(key=lambda x: (_series_number(x[0]), x[0].series_time))
        chosen.append(dup[0])
        if len(dup) > 1:
            warnings.append(f"相位 {dup[0][1].text} 有 {len(dup)} 個序列，取序列號最小的")
    chosen.sort(key=lambda x: x[1].order)
    return _labeled_plan(kind, chosen, warnings)


def _replace(plan: TemporalPlan, **kw: Any) -> TemporalPlan:
    from dataclasses import replace

    return replace(plan, **kw)


def _labeled_plan(kind: str, chosen: list[tuple[SeriesEntry, PhaseLabel]], warnings: list[str]) -> TemporalPlan | None:
    """有標籤的相位 → 一條時間軸；片數或範圍跟多數不同的相位排除。"""
    sigs = [stack_signature(e.instances) for e, _ in chosen]
    ref = Counter(sigs).most_common(1)[0][0]
    frames: list[FrameSpec] = []
    excluded: list[dict[str, Any]] = []
    for position, ((e, lab), sig) in enumerate(zip(chosen, sigs, strict=True)):
        if sig != ref or not _uniform(e.instances):
            if sig[0] != ref[0] or not _uniform(e.instances):
                reason, detail = "slice_count", f"{sig[0]} 片（其他 {ref[0]} 片）"
            else:
                reason, detail = "grid", f"範圍 {sig[1]}…{sig[2]} mm（其他 {ref[1]}…{ref[2]} mm）"
            excluded.append(
                {
                    "series_uid": e.series_instance_uid,
                    "label": lab.text,
                    "reason": reason,
                    "detail": detail,
                    "position": position,
                }
            )
            continue
        frames.append(FrameSpec(headers=tuple(e.instances), series_uid=e.series_instance_uid, label=lab.text))
    if len(frames) < 2:
        return None
    for x in excluded:
        warnings.append(f"相位 {x['label']} 已排除：{x['detail']}")
    return TemporalPlan(
        key=_key([f.series_uid for f in frames]),
        kind="cyclic",
        axis="amplitude" if kind == "amplitude" else "phase",
        confidence="high",
        source="series_description",
        frames=tuple(frames),
        excluded=tuple(excluded),
        warnings=tuple(warnings),
    )


# ── 形狀 B：一個序列內 ───────────────────────────────────────────────────────

_PHASE_IMAGE = {"P", "PHASE", "R", "REAL", "I", "IMAGINARY"}
_DERIVED_IMAGE = {"ADC", "EADC", "FA", "TRACEW", "TRACE", "CALC_BV", "EXP"}
_GATED = {"RESP_GATED", "CARDIAC_GATED", "CARDRESP_GATED"}
# 看起來是擴散影像（描述或 Image Type）但沒有 b 值標籤 —— 去識別化常把廠商私有的 b 值刪掉
# （CC-Tumor-Heterogeneity：GE 0043,1039 只剩 Private Creator）。不能當成時間點
_DIFFUSION_DESC = re.compile(r"\b(DWI|DIFF\w*|DTI|TRACEW?)\b|\bB\s?\d{2,4}\b", re.IGNORECASE)
# 描述裡的 b 值清單（`B100/600/1000`、`b=0,500,1000`、`b0 b800`）
_B_LIST = re.compile(r"\bB\s?=?\s?(\d{1,4}(?:\s*[/,]\s*\d{1,4})*)(?![\d.])", re.IGNORECASE)


def b_values_from_description(description: str, groups: int) -> tuple[tuple[float, ...], bool] | None:
    """描述裡寫的 b 值 → 每組一個（遞增）＋「b0 是補上的」。對不上組數 → None（不猜）。

    * 數字個數 ＝ 組數 → 照寫的
    * 少一個、而且沒寫 0 → 前面補 b0（GE／Siemens 的多 b 值 DWI 都會掃 b0，描述常只寫非零的；
      CC-Tumor-Heterogeneity 的 `SAG DWI B100/600/1000` 是 4 組）
    """
    found: list[float] = []
    for m in _B_LIST.finditer(description or ""):
        found.extend(float(x) for x in re.split(r"\s*[/,]\s*", m.group(1)) if x)
    values = sorted(set(found))
    if not values or any(v > 10000 for v in values):
        return None
    if len(values) == groups:
        return tuple(values), False
    if len(values) == groups - 1 and 0.0 not in values:
        return (0.0, *values), True
    return None


@dataclass
class SeriesAnalysis:
    """一個序列分析的結果：要載入的切片（`main`）＋ 時間軸（沒有 ＝ 一般 3D）＋ 拆出去的影像。"""

    main: list[InstanceHeader]
    plan: TemporalPlan | None = None
    split_off: list[dict[str, Any]] = field(default_factory=list)
    error: str | None = None


def analyze_series(entry: SeriesEntry) -> SeriesAnalysis:
    """拆掉相位圖／衍生影像，再看同一位置重複的影像怎麼分成幀。"""
    headers = list(entry.instances)
    if repeated_positions(entry) <= 1:
        return SeriesAnalysis(main=headers)
    tags = {(h.path, h.frame_number): dyn_tags(h) for h in headers}

    def category(h: InstanceHeader) -> str:
        it = tags[(h.path, h.frame_number)]["image_type"]
        if len(it) > 2 and it[2] in _PHASE_IMAGE:
            return "phase_image"
        if any(x in _DERIVED_IMAGE for x in it) and (it[:1] == ["DERIVED"] or len(it) > 3):
            return "derived_image"
        return "main"

    cats = defaultdict(list)
    for h in headers:
        cats[category(h)].append(h)
    main = cats.get("main") or headers
    split_off = [{"kind": k, "count": len(v)} for k, v in cats.items() if k != "main" and main is not headers]
    n = _normal(main[0].image_orientation_patient)

    def pos(h: InstanceHeader) -> float:
        return round(float(np.dot(np.asarray(h.image_position_patient, dtype=np.float64), n)), 2)

    by_pos: dict[float, list[InstanceHeader]] = defaultdict(list)
    for h in main:
        by_pos[pos(h)].append(h)
    counts = {len(v) for v in by_pos.values()}
    if len(counts) != 1:
        return SeriesAnalysis(
            main=main,
            split_off=split_off,
            error=f"每個位置的影像數不同（{min(counts)}～{max(counts)} 張），無法分成時間點",
        )
    m = counts.pop()
    if m == 1:
        return SeriesAnalysis(main=main, split_off=split_off)

    def values(field_name: str) -> list[float | None]:
        return [tags[(h.path, h.frame_number)][field_name] for h in main]

    def splits_cleanly(field_name: str) -> bool:
        vals = values(field_name)
        if any(v is None for v in vals) or len(set(vals)) != m:
            return False
        return all(len({tags[(h.path, h.frame_number)][field_name] for h in hs}) == m for hs in by_pos.values())

    axis, kind, unit, source, confidence = "time", "series", None, "", "high"
    key_field: str | None = None
    if splits_cleanly("echo_number") or splits_cleanly("echo_time"):
        key_field = "echo_time" if splits_cleanly("echo_time") else "echo_number"
        axis, unit, source = "echo_time", "ms", "EchoTime"
    elif splits_cleanly("b_value"):
        key_field, axis, unit, source = "b_value", "b_value", "s/mm²", "DiffusionBValue"
    else:
        for field_name, label, conf in (
            ("resp_phase", "NominalPercentageOfRespiratoryPhase", "high"),
            ("cardiac_phase", "NominalPercentageOfCardiacPhase", "high"),
            ("tpi", "TemporalPositionIdentifier", "high"),
            ("acquisition_number", "AcquisitionNumber", "high"),
            ("trigger_time", "TriggerTime", "high"),
            ("acquisition_time", "AcquisitionTime", "medium"),
            ("content_time", "ContentTime", "medium"),
        ):
            if splits_cleanly(field_name):
                key_field, source, confidence = field_name, label, conf
                break
    warnings: list[str] = []
    if key_field is None:
        source, confidence = "InstanceNumber", "low"
        warnings.append("沒有可用的時間欄位：時間點順序依 InstanceNumber 推定")
        ordered = {p: sorted(hs, key=lambda h: (h.instance_number or 0, h.path)) for p, hs in by_pos.items()}
        frame_headers = [[ordered[p][i] for p in sorted(ordered)] for i in range(m)]
        frame_vals: list[float | None] = [None] * m
    else:
        distinct = sorted({float(v) for v in values(key_field) if v is not None})
        frame_headers = [[h for h in main if tags[(h.path, h.frame_number)][key_field] == v] for v in distinct]
        frame_vals = list(distinct)
    gated = any(set(dyn_tags(h)["image_type"]) & _GATED for h in main[:1])
    if axis == "time" and (gated or key_field in ("resp_phase", "cardiac_phase")):
        kind, axis = "cyclic", "phase"
    diffusion_without_b = False
    b_guess: tuple[float, ...] = ()
    b_implied = False
    if axis == "time" and kind == "series" and _looks_like_diffusion(entry, main[0]):
        diffusion_without_b = True
        axis = "b_value"
        guess = b_values_from_description(entry.series_description or "", m)
        if guess is None:
            warnings.append(
                f"看起來是擴散影像，但沒有 b 值標籤（可能被去識別化移除）：依 {source} 分成 {m} 組，b 值未知"
            )
        else:
            b_guess, b_implied = guess
            unit = "s/mm²"
            warnings.append(_b_guess_warning(b_guess, b_implied, source))
    frames: list[FrameSpec] = []
    for i, hs in enumerate(frame_headers):
        label: str | None = None
        time_s: float | None = None
        if axis == "echo_time":
            te = tags[(hs[0].path, hs[0].frame_number)]["echo_time"]
            label = f"TE {te:g} ms" if te is not None else f"E{i + 1}"
        elif axis == "b_value" and not diffusion_without_b:
            label = f"b {frame_vals[i]:g}"
        elif axis == "b_value" and b_guess:
            label = f"b {b_guess[i]:g}?"
        elif kind == "cyclic" and key_field in ("resp_phase", "cardiac_phase"):
            label = f"{frame_vals[i]:g}%"
        elif kind == "cyclic":
            label = f"{round(100 * i / m)}%"
        elif axis == "time":
            trig = [tags[(h.path, h.frame_number)]["trigger_time"] for h in hs]
            acq = [tags[(h.path, h.frame_number)]["acquisition_time"] for h in hs]
            if trig[0] is not None and len(set(values("trigger_time"))) > 1:
                time_s = float(min(t for t in trig if t is not None)) / 1000.0
            elif acq[0] is not None:
                time_s = float(min(t for t in acq if t is not None))
        frames.append(FrameSpec(headers=tuple(hs), series_uid=entry.series_instance_uid, label=label, time_s=time_s))
    if kind == "series" and axis == "time":
        t0 = next((f.time_s for f in frames if f.time_s is not None), None)
        if t0 is not None:
            frames = [_replace_frame(f, time_s=None if f.time_s is None else round(f.time_s - t0, 4)) for f in frames]
    for s in split_off:
        warnings.append(
            {
                "phase_image": f"序列裡有 {s['count']} 張相位影像（Image Type P／R／I），已分開、這次沒有載入",
                "derived_image": f"序列裡有 {s['count']} 張衍生影像（ADC 等），已分開、這次沒有載入",
            }.get(s["kind"], "")
        )
    plan = TemporalPlan(
        key=_key([entry.series_instance_uid]),
        kind=kind,
        axis=axis,
        unit=unit,
        confidence=confidence,
        source=source,
        frames=tuple(frames),
        split_off=tuple(split_off),
        warnings=tuple(w for w in warnings if w),
        b_guess=b_guess,
        b_implied=b_implied,
    )
    return SeriesAnalysis(main=main, plan=plan, split_off=split_off)


def _b_guess_warning(values: tuple[float, ...], implied: bool, source: str) -> str:
    listed = "/".join(f"{v:g}" for v in values)
    note = "（b0 描述沒寫，依慣例補上）" if implied else ""
    return (
        f"沒有 b 值標籤（可能被去識別化移除）：依描述推定 b 值 {listed}{note}，"
        f"依 {source} 的順序由小到大 —— 標籤帶「?」，請核對"
    )


def check_b_guess(plan: TemporalPlan, read_mean: Any) -> TemporalPlan:
    """從描述推定的 b 值，開病例時用訊號核對 —— 擴散加權影像 b 越大訊號越弱，
    每組中間那一片的平均值要**嚴格遞減**；不是 → 拿掉推定（回到「b 值未知」）並警告。`read_mean(header) -> float`。"""
    if not plan.b_guess:
        return plan
    from dataclasses import replace

    try:
        means = [float(read_mean(f.headers[len(f.headers) // 2])) for f in plan.frames]
    except Exception:  # noqa: BLE001 - 讀不到就不核對（像素讀不到在載入時會報）
        return plan
    if all(a > b for a, b in zip(means, means[1:], strict=False)):
        return plan
    shown = "、".join(f"{v:.0f}" for v in means)
    return replace(
        plan,
        b_guess=(),
        b_implied=False,
        unit=None,
        frames=tuple(replace(f, label=None) for f in plan.frames),
        warnings=(
            *(w for w in plan.warnings if w != _b_guess_warning(plan.b_guess, plan.b_implied, plan.source)),
            f"描述寫的 b 值跟訊號強度的順序不符（各組平均 {shown}，b 越大應該越暗），不標 b 值",
        ),
    )


def _looks_like_diffusion(entry: SeriesEntry, h: InstanceHeader) -> bool:
    if entry.modality not in ("MR", ""):
        return False
    if any("DIFFUSION" in v or v in ("TRACEW", "ADC") for v in dyn_tags(h)["image_type"]):
        return True
    return bool(_DIFFUSION_DESC.search(entry.series_description or ""))


def _replace_frame(f: FrameSpec, **kw: Any) -> FrameSpec:
    from dataclasses import replace

    return replace(f, **kw)


def study_plans(entries: Iterable[SeriesEntry]) -> list[TemporalPlan]:
    """一個 study（或任何一組序列）的全部時間軸：跨序列的 ＋ 每個序列內的。"""
    items = list(entries)
    out = cross_series_plans(items)
    for e in items:
        if e.is_image and repeated_positions(e) > 1:
            a = analyze_series(e)
            if a.plan is not None:
                out.append(a.plan)
    return out
