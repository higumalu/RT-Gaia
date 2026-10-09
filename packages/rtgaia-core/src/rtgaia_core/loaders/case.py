"""多物件病例組裝：一組選取（影像序列、RTSTRUCT、RTDOSE、REG）→ 一個 `Dataset`。

它把「所有東西都在同一個空間」的原則落成資料：

* 每個**影像序列**一個 FrameGroup；primary 恆為單位矣陣，其餘的
  `transform_to_primary` 來自 REG（`loaders/registration.py`），找不到就單位矩陣
  ＋ `registration.source='none'`（**畫面上看得見「未對位」**，不默默當成已對位）。
* 每個 **RTSTRUCT** 依它宣告的 FoR 掛到對應的影像，**光柵化在那個影像自己的
  取像網格上**（每個 FrameGroup 一個 MaskGrid）。
* 每個 **RTDOSE** 以自己的網格進來（`kind='dose'`），借用同 FoR 影像的 FrameGroup。
* RTPLAN 只提供 label 與處方給 UI。

像素**惰性**：組裝時只讀標頭；`phantoms.volume()` 第一次要體素時才讀檔並快取。
劑量例外——它小（10–40 MB）而且 UI 一開始就要 `max_gy`，因此組裝時就讀。
"""

from __future__ import annotations

import hashlib
from dataclasses import dataclass, field, replace
from pathlib import Path
from typing import Any

import numpy as np
from rtgaia_geom import ContractViolation, RegistrationInfo
from rtgaia_geom.grid import Grid
from rtgaia_geom.temporal import TemporalGroup

from ..dataset import Dataset, DatasetSeries, DatasetStructure
from ..library.index import LibraryIndex, SeriesEntry
from ..library.scan import InstanceHeader
from .dicom import SeriesGeometry, read_pixels, series_geometry, with_estimated_window
from .enhanced import expand_multiframe
from .frame_resample import SliceStack, read_slice_stack, slice_stack, stack_sops
from .pet_suv import pet_values
from .registration import SpatialRegistration, read_registration, resolve
from .rtdose import read_dose_header, read_dose_pixels
from .rtplan import read_plan_header
from .rtstruct import LoadedStructure, find_rtstruct, read_rtstruct, summarize
from .temporal import FrameSpec, TemporalPlan, _series_seconds, analyze_series, check_b_guess, cross_series_plans

DEFAULT_VISIBLE_PER_STRUCTURE_SET = 8
"""大型 RTSTRUCT（> SHOW_ALL_UP_TO_STRUCTURES 個）預設顯示的結構數。
三套 × 8 ＝ 24，仍在 outline 上限 50 內。"""
SHOW_ALL_UP_TO_STRUCTURES = 24
"""2026-09-18：整套 ≤ 24 個的結構集（AI 一次跑出來的、匯出回來的）全部顯示 —— 8 個上限是為 85 個 ROI 的臨床 RS 設的，
對一套 14 個脊椎「只看到 8 個」只會讓人以為少了。"""


@dataclass
class CaseSelection:
    """資料頁送來的選取（`POST /api/v1/sessions` 的 body）。"""

    image_series_uids: list[str] = field(default_factory=list)
    structure_set_uids: list[str] = field(default_factory=list)
    dose_uids: list[str] = field(default_factory=list)
    registration_uids: list[str] = field(default_factory=list)
    plan_uids: list[str] = field(default_factory=list)
    primary_series_uid: str | None = None
    extra_rtstruct_paths: list[Path] = field(default_factory=list)
    """舊版型 `case/CT/ ＋ case/RTSTRUCT/`：不在索引根目錄裡、但在相鄰目錄找到的 RTSTRUCT。"""
    temporal_overrides: dict[str, str] = field(default_factory=dict)
    """跨序列時間軸候選的 `key` → `merge`／`split`，蓋過預設（高信心合併、低信心分開）。"""
    temporal_assemblies: list[dict[str, Any]] = field(default_factory=list)
    """在檢視器裡手動組成的時間軸，每條 `{series_uids（幀的順序）, labels | None, axis}`。

    開病例時跟自動偵測的候選一樣組成一個時間軸 `DatasetSeries`（key ＝ `assembly_key(series_uids)`，穩定）；
    資料頁不送這個欄位，所以不影響「同一組選取回同一個病例」的 hash（病例原地組成時沿用原本的 hash）。"""
    temporal_views: dict[str, str] = field(default_factory=dict)
    """時間軸 key → `expanded`（攤開成每一幀一張獨立影像）。沒有 ＝ 一條時間軸（4D）。只影響圖層，不影響資料集。"""
    temporal_resample: list[str] = field(default_factory=list)
    """這些自動時間軸的 key —— 網格跟第一幀不同而被排除的相位（缺片、位移）**重新取樣補進來**。
    手動組成的時間軸用自己的 `resample` 旗標（`temporal_assemblies[n]["resample"]`）。"""

    @classmethod
    def from_wire(cls, d: dict[str, Any]) -> CaseSelection:
        def strs(key: str) -> list[str]:
            v = d.get(key) or []
            return [str(x) for x in v]

        return cls(
            image_series_uids=strs("image_series_uids") or strs("series_uids"),
            structure_set_uids=strs("structure_set_uids"),
            dose_uids=strs("dose_uids"),
            registration_uids=strs("registration_uids"),
            plan_uids=strs("plan_uids"),
            primary_series_uid=(str(d["primary_series_uid"]) if d.get("primary_series_uid") else None),
            temporal_overrides={
                str(k): str(v) for k, v in (d.get("temporal_overrides") or {}).items() if str(v) in ("merge", "split")
            },
            temporal_assemblies=[a for a in (_assembly_from_wire(x) for x in d.get("temporal_assemblies") or []) if a],
            temporal_views={str(k): str(v) for k, v in (d.get("temporal_views") or {}).items() if str(v) == "expanded"},
            temporal_resample=list(dict.fromkeys(str(k) for k in d.get("temporal_resample") or [])),
        )

    def to_wire(self) -> dict[str, Any]:
        return {
            "image_series_uids": list(self.image_series_uids),
            "structure_set_uids": list(self.structure_set_uids),
            "dose_uids": list(self.dose_uids),
            "registration_uids": list(self.registration_uids),
            "plan_uids": list(self.plan_uids),
            "primary_series_uid": self.primary_series_uid,
            **({"temporal_overrides": dict(self.temporal_overrides)} if self.temporal_overrides else {}),
            **(
                {"temporal_assemblies": [dict(a) for a in self.temporal_assemblies]} if self.temporal_assemblies else {}
            ),
            **({"temporal_views": dict(self.temporal_views)} if self.temporal_views else {}),
            **({"temporal_resample": list(self.temporal_resample)} if self.temporal_resample else {}),
        }


ASSEMBLY_KEY_PREFIX = "tga_"
"""手動組成的時間軸 key 前綴（自動偵測的是 `tg_`）。"""
ASSEMBLY_AXES = ("phase", "time")


def assembly_key(series_uids: list[str]) -> str:
    """手動時間軸的 key：幀的順序有意義（第 n 幀 ＝ 第 n 個序列），所以不排序。"""
    return ASSEMBLY_KEY_PREFIX + hashlib.sha1("|".join(series_uids).encode()).hexdigest()[:12]


def _assembly_from_wire(x: Any) -> dict[str, Any] | None:
    if not isinstance(x, dict):
        return None
    uids = [str(u) for u in x.get("series_uids") or [] if str(u)]
    if len(uids) < 2 or len(set(uids)) != len(uids):
        return None
    labels = x.get("labels")
    labels = (
        [str(v) if v is not None else "" for v in labels]
        if isinstance(labels, list) and len(labels) == len(uids)
        else None
    )
    axis = str(x.get("axis") or "phase")
    out: dict[str, Any] = {"series_uids": uids, "labels": labels, "axis": axis if axis in ASSEMBLY_AXES else "phase"}
    if x.get("resample") is True:
        out["resample"] = True  # 網格不同的幀重新取樣到第一幀的網格
    return out


def select_all(
    index: LibraryIndex,
    *,
    include_structures: bool = True,
    sibling_rtstruct_of: Path | None = None,
) -> CaseSelection:
    """把索引裡**全部**物件選起來（`dicom:/path` 這條路）。

    `sibling_rtstruct_of`：傳進來的是 `case/CT` 這種只有影像的目錄時，往相鄰目錄
    找 RTSTRUCT（沿用第一版的版型支援）。
    """
    sel = CaseSelection(
        image_series_uids=[s.series_instance_uid for s in index.image_series()],
        structure_set_uids=[s.series_instance_uid for s in index.by_modality("RTSTRUCT")] if include_structures else [],
        dose_uids=[s.series_instance_uid for s in index.by_modality("RTDOSE")],
        registration_uids=[s.series_instance_uid for s in index.by_modality("REG")],
        plan_uids=[s.series_instance_uid for s in index.by_modality("RTPLAN")],
    )
    if include_structures and not sel.structure_set_uids and sibling_rtstruct_of is not None:
        extra = find_rtstruct(sibling_rtstruct_of)
        if extra is not None:
            sel.extra_rtstruct_paths.append(extra)
    return sel


def choose_primary(index: LibraryIndex, selection: CaseSelection) -> str:
    """primary ＝ 使用者指定 → 被 RTPLAN／RTDOSE 參照鏈指到的影像 → 切片最多的影像。"""
    if selection.primary_series_uid:
        if selection.primary_series_uid not in selection.image_series_uids:
            raise ContractViolation(
                "CS1", "primary_series_uid 不在選取的影像序列裡", primary=selection.primary_series_uid
            )
        return selection.primary_series_uid
    if not selection.image_series_uids:
        raise ContractViolation("CS2", "至少要選一個影像序列")
    chosen = set(selection.image_series_uids)
    for uid in [*selection.plan_uids, *selection.dose_uids]:
        entry = index.series.get(uid)
        target = entry.links.get("image_series_uid") if entry else None
        if target in chosen:
            return str(target)
    return max(selection.image_series_uids, key=lambda u: index.series[u].instance_count if u in index.series else 0)


@dataclass
class _ImageBundle:
    entry: SeriesEntry
    geometry: SeriesGeometry
    role: str
    matrix: np.ndarray | None
    registration: RegistrationInfo | None
    plan: TemporalPlan | None = None
    """時間軸（`geometry` 是第 0 幀；`frames` 每一幀一份）。"""
    frames: list[SeriesGeometry] | None = None
    resampled: frozenset[int] = frozenset()
    """哪幾幀要（三線性）重新取樣到第 0 幀的網格。"""
    slicewise: dict[int, SliceStack] = field(default_factory=dict)
    """哪幾幀只差在切片位置、逐片沿法線內插（`frames[k]` 放的是第 0 幀的幾何）。"""
    params: dict[str, Any] = field(default_factory=dict)
    """image layer 的值參數（PET：`value_unit`、`value_scale`、`suv` 明細）。"""

    @property
    def temporal_group(self) -> TemporalGroup | None:
        if self.plan is None:
            return None
        times = self.plan.times
        labels = self.plan.labels
        return TemporalGroup(
            temporal_group_id=self.plan.key,
            kind=self.plan.kind,  # type: ignore[arg-type]
            frame_count=len(self.plan.frames),
            frame_times=tuple(times) if times and self.plan.kind == "series" else None,
            axis_label=self.plan.axis,
            frame_labels=tuple(labels) if labels else None,
            unit=self.plan.unit,
        )


def _real_sops(geometry: SeriesGeometry) -> tuple[str, ...]:
    """每一片的 SOP Instance UID；Enhanced 的虛擬切片是 `UID#幀號`（匯出 RS 時拆成 Referenced Frame Number）。"""
    return tuple(f.sop_instance_uid for f in geometry.files)


def _same_grid(a: Grid, b: Grid) -> bool:
    return (
        tuple(a.size) == tuple(b.size)
        and np.allclose(a.spacing, b.spacing, atol=1e-3)
        and np.allclose(a.origin, b.origin, atol=1e-2)
        and np.allclose(a.direction, b.direction, atol=1e-4)
    )


def _manual_plans(index: LibraryIndex, selection: CaseSelection, warnings: list[str]) -> list[TemporalPlan]:
    """檢視器裡手動組成的時間軸（形狀 A：每一幀一個序列，順序照使用者排的）。"""
    selected = set(selection.image_series_uids)
    out: list[TemporalPlan] = []
    for a in selection.temporal_assemblies:
        uids = [u for u in a["series_uids"] if u in selected and u in index.series and index.series[u].is_image]
        if len(uids) < len(a["series_uids"]):
            warnings.append(f"手動組成的時間軸有 {len(a['series_uids']) - len(uids)} 個序列不在這個病例裡，略過")
        if len(uids) < 2:
            continue
        labels = a.get("labels")
        axis = a.get("axis", "phase")
        frames = []
        t0: float | None = None
        for u in uids:
            e = index.series[u]
            n = a["series_uids"].index(u)
            t = _series_seconds(e) if axis == "time" else None
            if t is not None:
                t0 = t if t0 is None else t0
                t -= t0
            frames.append(
                FrameSpec(
                    headers=tuple(e.instances), series_uid=u, label=(labels[n] or None) if labels else None, time_s=t
                )
            )
        out.append(
            TemporalPlan(
                key=assembly_key(a["series_uids"]),
                kind="cyclic" if axis == "phase" else "series",
                axis=axis,
                confidence="high",
                source="manual",
                frames=tuple(frames),
                resample=bool(a.get("resample")),
            )
        )
    return out


def _with_resampled(plan: TemporalPlan, index: LibraryIndex) -> TemporalPlan:
    """被排除的相位（缺片、位移）照原本的位置插回時間軸，之後由 `_temporal_bundle` 重新取樣到第一幀的網格。

    key 不變（照舊由沒被排除的幀算）—— 開關「重新取樣」不換時間軸、不影響已經掛在這條時間軸上的東西（幀號由
    `reassemble_case` 依序列 UID 重新對應）。"""
    if not plan.excluded:
        return replace(plan, resample=True)
    excluded_at = {int(x.get("position", -1)): x for x in plan.excluded}
    if any(p < 0 for p in excluded_at) or any(x["series_uid"] not in index.series for x in plan.excluded):
        return replace(plan, resample=True)
    frames: list[FrameSpec] = []
    kept = iter(plan.frames)
    for pos in range(len(plan.frames) + len(excluded_at)):
        x = excluded_at.get(pos)
        if x is None:
            frames.append(next(kept))
            continue
        e = index.series[x["series_uid"]]
        frames.append(FrameSpec(headers=tuple(e.instances), series_uid=x["series_uid"], label=x.get("label")))
    dropped = {f"相位 {x['label']} 已排除：{x['detail']}" for x in plan.excluded}  # 跟 temporal.py 寫的同一句
    warnings = tuple(w for w in plan.warnings if w not in dropped)
    return replace(plan, frames=tuple(frames), excluded=(), resampled=plan.excluded, resample=True, warnings=warnings)


def _merged_plans(index: LibraryIndex, selection: CaseSelection, warnings: list[str]) -> list[TemporalPlan]:
    """跨序列的時間軸（形狀 A）：在**整個 study** 上找候選（key 跟資料頁一致），再只留選了的幀。

    手動組成的排在最前面；它用掉的序列不再進自動候選。"""
    selected = set(selection.image_series_uids)
    out: list[TemporalPlan] = _manual_plans(index, selection, warnings)
    used = {f.series_uid for p in out for f in p.frames}
    studies = {index.series[u].study_instance_uid for u in selected if u in index.series}
    pool = [e for e in index.image_series() if e.study_instance_uid in studies]
    for plan in cross_series_plans(pool):
        if plan.key in selection.temporal_resample:
            plan = _with_resampled(plan, index)
        frames = tuple(f for f in plan.frames if f.series_uid in selected and f.series_uid not in used)
        if len(frames) < 2:
            continue
        override = selection.temporal_overrides.get(plan.key)
        if not ((override == "merge") if override else plan.auto):
            continue
        if len(frames) < len(plan.frames):
            warnings.append(f"時間軸只選了 {len(frames)}／{len(plan.frames)} 幀")
        warnings.extend(plan.warnings if plan.auto else ())
        out.append(replace(plan, frames=frames, derived=tuple(d for d in plan.derived if d[0] in selected)))
    return out


def _temporal_bundle(entry: SeriesEntry, plan: TemporalPlan, warnings: list[str]) -> _ImageBundle | None:
    """每一幀算幾何（驗證 DL4–DL12）；壞掉的幀排除。網格跟第 0 幀不同的幀：排除，
    或 `plan.resample` 時**重新取樣到第 0 幀的網格**（同一個 FoR 才行）。剩不到 2 幀 → None。"""
    geoms: list[SeriesGeometry] = []
    kept = []
    resampled: set[int] = set()
    slicewise: dict[int, SliceStack] = {}
    for n, f in enumerate(plan.frames):
        name = f.label or f"第 {n + 1} 幀"
        try:
            g: SeriesGeometry | None = series_geometry(list(f.headers))
            message = None
        except ContractViolation as exc:
            g, message = None, exc.message
        if not geoms:
            if g is None:
                warnings.append(f"時間軸的 {name} 已排除：{message}")
                continue
            g = with_estimated_window(g, list(f.headers))  # 時間軸的預設窗位跟著第一幀
        elif g is None or not _same_grid(geoms[0].grid, g.grid):
            same_for = all(h.frame_of_reference_uid == geoms[0].grid.frame_of_reference_uid for h in f.headers)
            stack = slice_stack(list(f.headers), geoms[0].grid) if plan.resample and same_for else None
            if stack is not None:
                # 只差在切片位置（缺片、位移）：逐片沿法線內插，平面內不動
                slicewise[len(kept)] = stack
                g = geoms[0]
            elif plan.resample and same_for and g is not None:
                resampled.add(len(kept))  # 平面幾何也不同：三線性重新取樣
            elif message is not None:
                warnings.append(f"時間軸的 {name} 已排除：{message}")
                continue
            else:
                warnings.append(f"時間軸的 {name} 已排除：網格跟第一幀不同")
                continue
            warnings.append(f"時間軸的 {name}：網格跟第一幀不同，已重新取樣到第一幀的網格")
        geoms.append(g)
        kept.append(f)
        warnings.extend(f"時間軸的 {name}：{w}" for w in g.warnings if n == 0 or len(kept) - 1 not in slicewise)
    if len(kept) < 2:
        return None
    plan = replace(plan, frames=tuple(kept))
    return _ImageBundle(
        entry=entry,
        geometry=geoms[0],
        role="secondary",
        matrix=None,
        registration=None,
        plan=plan,
        frames=geoms,
        resampled=frozenset(resampled),
        slicewise=slicewise,
    )


def _read_frame(
    frames: list[SeriesGeometry], k: int, resampled: frozenset[int], slicewise: dict[int, SliceStack]
) -> np.ndarray:
    """時間軸第 k 幀的像素。只差在切片位置的幀 → 逐片內插（`frame_resample`）；平面幾何也不同的 → 三線性取樣到
    第 0 幀的網格（同一個 FoR，不用 transform），網格外補最小值。"""
    if k in slicewise:
        return read_slice_stack(slicewise[k], frames[0].grid)
    vol = read_pixels(frames[k])
    if k not in resampled:
        return vol
    from ..dose_ops import resample_onto

    eye = np.eye(4)
    out = resample_onto(vol, frames[k].grid, eye, frames[0].grid, eye)
    fill = float(vol.min()) if vol.size else 0.0
    return np.where(np.isnan(out), fill, np.rint(out)).astype(vol.dtype)


def _frame_sops(
    frames: list[SeriesGeometry], k: int, resampled: frozenset[int], slicewise: dict[int, SliceStack]
) -> tuple[str, ...]:
    """匯出 RS 引用的切片 SOP：一般的幀照原樣；重新取樣的幀 → 第 0 幀每一片對到這一幀最近的一片（半片厚以內），
    有一片對不到（缺片）→ ()，匯出改用合成參照（`rtstruct.py`：長度不符就合成）。"""
    if k in slicewise:
        return stack_sops(slicewise[k], frames[0].grid)
    if k not in resampled:
        return _real_sops(frames[k])
    ref, own = frames[0].grid, frames[k].grid
    rm, om = ref.index_to_world_matrix, own.index_to_world_matrix
    normal = rm[:3, 2] / np.linalg.norm(rm[:3, 2])
    ref_z = [float(normal @ (rm @ np.array([0.0, 0.0, kk, 1.0]))[:3]) for kk in range(int(ref.size[2]))]
    own_z = [float(normal @ (om @ np.array([0.0, 0.0, kk, 1.0]))[:3]) for kk in range(int(own.size[2]))]
    sops = _real_sops(frames[k])
    if len(sops) != len(own_z):
        return ()
    tol = 0.5 * float(ref.spacing[2]) + 1e-6
    out: list[str] = []
    for z in ref_z:
        j = min(range(len(own_z)), key=lambda i: abs(own_z[i] - z))
        if abs(own_z[j] - z) > tol:
            return ()
        out.append(sops[j])
    return tuple(out)


def _slice_mean(h: InstanceHeader) -> float:
    """一片（Enhanced 的一幀）存的像素平均 —— 核對推定的 b 值順序用，不套 Rescale（同一序列內比大小）。"""
    from pydicom.pixels import pixel_array

    arr = pixel_array(str(h.path), index=(h.frame_number - 1) if h.frame_number else None)
    return float(np.mean(arr))


def _single_image(entry: SeriesEntry, warnings: list[str]) -> _ImageBundle:
    """不在跨序列 4D 組裡的一個影像序列：Enhanced 攤開 → 序列內分幀（形狀 B）→ 幾何。失敗 → ContractViolation。"""
    uid = entry.series_instance_uid
    # Enhanced 多幀 → 每一幀一個虛擬切片（方向、位置、Rescale 在 Functional Group 裡）
    entry = expand_multiframe(entry)
    analysis = analyze_series(entry)  # 形狀 B：同一序列內分幀
    if analysis.error:
        raise ContractViolation("TA1", analysis.error, series=uid)
    if analysis.plan is not None:
        # 從描述推定的 b 值用訊號核對（b 越大越暗），不符就拿掉
        plan = check_b_guess(analysis.plan, _slice_mean)
        bundle = _temporal_bundle(entry, plan, warnings)
        if bundle is None:
            raise ContractViolation("TA2", "序列內的時間點不到 2 個可用（各時間點的網格不同）", series=uid)
        warnings.extend(plan.warnings)
        return bundle
    geometry = with_estimated_window(series_geometry(analysis.main), analysis.main)
    # PET 換成 SUV（標籤齊才換；不齊就標 Bq/ml 並說缺什麼）
    geometry, params, suv_warning = pet_values(geometry)
    name = entry.series_description or uid
    warnings.extend(f"影像「{name}」：{w}" for w in geometry.warnings)
    if (w := suv_warning) is not None:
        warnings.append(f"影像「{name}」：{w}")
    return _ImageBundle(entry=entry, geometry=geometry, role="secondary", matrix=None, registration=None, params=params)


def build_case_dataset(
    index: LibraryIndex,
    selection: CaseSelection,
    *,
    only_structures: set[str] | None = None,
) -> Dataset:
    warnings: list[str] = []

    # ── 1. 影像序列的幾何（惰性像素） ─────────────────────────────────────────
    images: dict[str, _ImageBundle] = {}
    # 任何一幀（或 4D 組的衍生影像）的序列 UID → (bundle 的 UID, 幀；衍生影像為 None)
    member_of: dict[str, tuple[str, int | None]] = {}
    excluded: set[str] = set()
    manual_members: set[str] = set()
    for uid in selection.image_series_uids:
        entry = index.series.get(uid)
        if entry is None or not entry.is_image:
            raise ContractViolation("CS3", "選取的影像序列不在索引裡", series=uid)
    for plan in _merged_plans(index, selection, warnings):
        first = index.series[plan.frames[0].series_uid]
        bundle = _temporal_bundle(first, plan, warnings)
        if bundle is None:
            warnings.append("時間軸可用的幀不到 2 個，改成各自獨立的影像")
            continue
        images[first.series_instance_uid] = bundle
        for n, f in enumerate(bundle.plan.frames):  # type: ignore[union-attr]
            member_of[f.series_uid] = (first.series_instance_uid, n)
        for u, _op in bundle.plan.derived:  # type: ignore[union-attr]
            member_of.setdefault(u, (first.series_instance_uid, None))
        excluded.update(x["series_uid"] for x in plan.excluded)
        excluded.update(f.series_uid for f in plan.frames if f.series_uid not in member_of)
        if plan.source == "manual":
            # 手動組成之前就有的 RTSTRUCT（畫在其中一張影像上）維持靜態：組成前後結構的 key 不變（不會拆成只屬某一幀）
            manual_members.update(f.series_uid for f in bundle.plan.frames)  # type: ignore[union-attr]
    failed: dict[str, ContractViolation] = {}
    for uid in selection.image_series_uids:
        if uid in member_of and member_of[uid][1] is not None:
            continue
        if uid in excluded:
            continue  # 時間軸排除的相位（缺片、網格不同）不另外開；警告已經寫了
        try:
            images[uid] = _single_image(index.series[uid], warnings)
        except ContractViolation as exc:
            failed[uid] = exc  # 先記著；是 primary 才擋，副序列排除並警告
    if not images and failed:
        raise next(iter(failed.values()))
    primary_uid = choose_primary(index, selection)
    if primary_uid in failed:
        raise failed[primary_uid]
    if primary_uid not in images and primary_uid not in member_of:
        primary_uid = next(iter(images))
    for uid, exc in failed.items():
        e = index.series[uid]
        name = " ".join(x for x in (e.modality, e.series_description) if x) or uid
        warnings.append(f"影像「{name}」沒有載入：{exc.code} {exc.message}")
    # 選到某一幀或 4D 組的衍生影像 → 4D 組本身當 primary（使用者明確指定衍生影像的除外）
    if primary_uid in member_of and (
        member_of[primary_uid][1] is not None or primary_uid != selection.primary_series_uid
    ):
        primary_uid = member_of[primary_uid][0]
    elif selection.primary_series_uid is None and images[primary_uid].plan is None:
        # 使用者沒指定、參照鏈也沒指到 4D 組的成員 → 有跨序列的 4D 組（4DCT）就用它，不用片數最多的那組（自由呼吸掃描）
        group = next((u for u, b in images.items() if b.plan is not None and len(b.plan.frame_series_uids) > 1), None)
        if group is not None:
            primary_uid = group
    primary = images[primary_uid]
    primary.role = "primary"
    primary_for = primary.geometry.grid.frame_of_reference_uid

    # ── 2. REG → 每個次要影像的 transform_to_primary ───────────────────────────
    registrations: list[SpatialRegistration] = []
    for uid in selection.registration_uids:
        entry = index.series.get(uid)
        if entry is None:
            raise ContractViolation("CS4", "選取的 REG 不在索引裡", series=uid)
        try:
            registrations.append(read_registration(entry.paths[0]))
        except ContractViolation as exc:
            warnings.append(f"REG {uid} 略過：{exc}")
    for uid, bundle in images.items():
        if bundle.role == "primary":
            continue
        source_for = bundle.geometry.grid.frame_of_reference_uid
        if source_for == primary_for:
            bundle.registration = RegistrationInfo(
                source="shared_frame", description="與 primary 同一個 Frame of Reference，無需對位"
            )
            continue
        resolved = resolve(registrations, source_for=source_for, primary_for=primary_for)
        if resolved is None:
            warnings.append(f"影像 {uid}（FoR {source_for[-12:]}）找不到通往 primary 的 REG，以單位矩陣擺放")
            bundle.registration = RegistrationInfo(source="none", description="找不到 REG；以單位矩陣擺放（未對位）")
        else:
            bundle.matrix = resolved.matrix_row_major
            bundle.registration = resolved.info

    # ── 3. RTSTRUCT → 各自 FoR 的影像網格 ──────────────────────────────────────
    structures: list[DatasetStructure] = []
    structure_notes: list[dict[str, Any]] = []
    used_ids: set[str] = set()
    rs_paths: list[tuple[str, Path]] = []
    for uid in selection.structure_set_uids:
        entry = index.series.get(uid)
        if entry is None:
            raise ContractViolation("CS5", "選取的 RTSTRUCT 不在索引裡", series=uid)
        rs_paths.append((uid, entry.paths[0]))
    rs_paths.extend((f"path:{p}", p) for p in selection.extra_rtstruct_paths)
    # primary 的結構集排最前面：structure_id 不加前綴、預設可見的也是它的
    resolved_rs = [
        (uid, path, *_image_for_rtstruct(index, uid, path, images, member_of, manual_members)) for uid, path in rs_paths
    ]
    resolved_rs.sort(
        key=lambda t: (t[2] is None or t[2].role != "primary", t[2].entry.series_date if t[2] else "", t[3] or 0)
    )

    structure_sets: list[dict[str, Any]] = []
    for n, (uid, path, target, frame) in enumerate(resolved_rs):
        if target is None:
            warnings.append(f"RTSTRUCT {uid} 略過：它的 Frame of Reference 沒有對應的影像序列在選取裡")
            continue
        grid = target.geometry.grid
        # 多套 RTSTRUCT 會有同名 ROI（每套都有 BODY）：非 primary 的加前綴，id 才唯一
        # （顯示上不靠前綴，靠結構集分層；前綴只讓 structure_id 唯一）
        prefix = "" if target.role == "primary" else f"{_short_tag(target, n)}_"
        loaded = read_rtstruct(path, grid, only=only_structures, id_prefix=prefix, used_ids=used_ids)
        # 結構集：id 用 RTSTRUCT 的 series UID（持久化後重載仍對得上）；`path:` 來源用檔名
        set_id = uid if not uid.startswith("path:") else f"path:{Path(path).name}"
        entry = index.series.get(uid)
        label = _structure_set_label(entry, path)
        structure_sets.append(
            {
                "structure_set_id": set_id,
                "kind": "import",  # 匯入集唯讀；工作集 kind="work"
                "label": label,
                "series_instance_uid": uid if entry is not None else None,
                "image_series_uid": target.entry.series_instance_uid,
                "image_label": f"{_modality_of(target.entry)} {target.entry.series_date}".strip(),
                "frame_of_reference_uid": grid.frame_of_reference_uid,
                "date": (entry.series_date if entry is not None else "") or "",
                "roi_count": len(loaded),
                "role": target.role,
                # 畫在 4D 組某一幀（相位序列）上 → 那套結構只屬於那一幀
                **(
                    {
                        "temporal_group_id": target.plan.key,
                        "frame_index": frame,
                        "frame_label": (target.plan.labels or [None] * (frame + 1))[frame],
                    }
                    if frame is not None and target.plan is not None
                    else {}
                ),
            }
        )
        # 次要影像的結構預設隱藏（跟著它的影像）；primary 的前 8 個預設顯示
        structures.extend(
            _to_phantom_structures(
                loaded,
                grid.frame_of_reference_uid,
                default_visible=target.role == "primary",
                structure_set_id=set_id,
                temporal_group_id=target.plan.key if (frame is not None and target.plan is not None) else None,
                frame_index=frame if target.plan is not None else None,
            )
        )
        structure_notes.append(
            {
                "series_instance_uid": uid,
                "path": str(path),
                "image_series_uid": target.entry.series_instance_uid,
                "roi_count": len(loaded),
                "structures": summarize(loaded, grid),
            }
        )

    # ── 4. RTDOSE → 自己的網格，借同 FoR 影像的 FrameGroup ─────────────────────
    doses: dict[str, DatasetSeries] = {}
    for uid in selection.dose_uids:
        entry = index.series.get(uid)
        if entry is None:
            raise ContractViolation("CS6", "選取的 RTDOSE 不在索引裡", series=uid)
        header = read_dose_header(entry.paths[0])
        host = next(
            (b for b in images.values() if b.geometry.grid.frame_of_reference_uid == header.frame_of_reference_uid),
            None,
        )
        if host is None:
            warnings.append(f"RTDOSE {uid} 略過：它的 Frame of Reference 沒有影像序列在選取裡")
            continue
        pixels = read_dose_pixels(header)
        # `DoseUnits` 不是 GY 就不是 Gy —— 病例仍可開（顯示相對場有用），
        # 但 layer params 標 `dose_scale`，DVH 路由據此拒絕 Gy 統計；這裡同時給使用者一句警告
        dose_scale = "gy" if header.units == "GY" else ("relative" if header.units == "RELATIVE" else "unknown")
        if dose_scale != "gy":
            warnings.append(
                f"RTDOSE {uid}：DoseUnits={header.units or '(缺)'}，不是 Gy —— 只能顯示相對值，不提供 Gy 統計（DVH）"
            )
        params: dict[str, Any] = {
            **header.params,
            "dose_scale": dose_scale,
            "max_gy": float(np.max(pixels)) if pixels.size else 0.0,
            # DoseType=ERROR（差值）可以有負值 → 前端用發散色階、DVH 不畫曲線
            "min_gy": float(np.min(pixels)) if pixels.size else 0.0,
            "referenced_plan_label": entry.links.get("plan_label"),
            "prescription_gy": entry.links.get("prescription_gy") or [],
        }
        doses[host.entry.series_instance_uid + "|" + uid] = DatasetSeries(
            series_id=uid,
            grid=header.grid,
            role=host.role,  # type: ignore[arg-type]
            modality="RTDOSE",
            image=lambda _g, _f=0, _v=pixels: _v,
            default_window=(params["max_gy"] / 2.0, params["max_gy"]),
            kind="dose",
            dtype="float32",
            meta=_series_meta(entry),
            params=params,
        )

    # ── 5. 組成 Dataset：primary 影像 → 它的劑量 → 各次要影像 → 各自的劑量 ─────
    ordered: list[DatasetSeries] = []
    for uid, bundle in sorted(images.items(), key=lambda kv: (kv[1].role != "primary", kv[1].entry.series_date, kv[0])):
        frames = bundle.frames
        meta = _series_meta(bundle.entry, geometry=bundle.geometry)
        if bundle.plan is not None:
            meta["temporal"] = bundle.plan.wire()
        ordered.append(
            DatasetSeries(
                series_id=uid,
                grid=bundle.geometry.grid,
                role=bundle.role,  # type: ignore[arg-type]
                modality=_modality_of(bundle.entry),
                image=(
                    (
                        lambda _g, _f=0, _fs=frames, _rs=bundle.resampled, _sw=bundle.slicewise: _read_frame(
                            _fs, _f or 0, _rs, _sw
                        )
                    )
                    if frames is not None
                    else (lambda _g, _f=0, _geom=bundle.geometry: read_pixels(_geom))
                ),
                temporal_group_id=bundle.plan.key if bundle.plan is not None else None,
                default_window=bundle.geometry.default_window,
                transform_to_primary=(tuple(bundle.matrix.flatten().tolist()) if bundle.matrix is not None else None),
                kind="image",
                dtype="int16",
                registration=bundle.registration,
                meta=meta,
                params=dict(bundle.params),
                # Enhanced 多幀的虛擬切片（`SOP#幀`）不是能引用的 SOP —— 匯出改用合成參照（enhanced.py 的限制）
                slice_sop_uids=_real_sops(bundle.geometry),
                sop_class_uid=bundle.entry.sop_class_uid,
                source_path=str(bundle.geometry.files[0].path) if bundle.geometry.files else "",
                frame_series_uids=tuple(f.series_uid for f in bundle.plan.frames) if bundle.plan else (),
                frame_slice_sop_uids=(
                    tuple(_frame_sops(frames, k, bundle.resampled, bundle.slicewise) for k in range(len(frames)))
                    if frames is not None
                    else ()
                ),
            )
        )
        for key, dose in doses.items():
            if key.startswith(uid + "|"):
                ordered.append(dose)

    # ── 6. RTPLAN：選取的 ＋ 載入的劑量參照到的；只記標頭，射束在 API 層才讀 ────────────
    plans: list[dict[str, Any]] = []
    plan_uids = list(
        dict.fromkeys(
            [
                *selection.plan_uids,
                *(
                    index.series[d.series_id].links.get("plan_uid")
                    for d in doses.values()
                    if d.series_id in index.series
                ),
            ]
        )
    )
    for puid in plan_uids:
        pentry = index.series.get(puid) if puid else None
        if pentry is None or not pentry.paths:
            continue
        try:
            ph = read_plan_header(pentry.paths[0])
        except Exception as exc:  # noqa: BLE001 - 壞掉的 RTPLAN 不擋病例
            warnings.append(f"RTPLAN {puid} 讀不到：{exc}")
            continue
        plans.append(
            {
                "series_instance_uid": puid,
                "sop_instance_uid": ph.sop_instance_uid,
                "label": ph.label,
                "frame_of_reference_uid": ph.frame_of_reference_uid,
                "path": ph.path,
            }
        )

    n_images = len(images)
    description = (
        f"DICOM 病例：{n_images} 個影像序列、{len(structures)} 個 ROI、{len(doses)} 個劑量、"
        f"{len(registrations)} 個 REG（primary {primary.entry.modality} {primary.entry.series_date}）"
    )
    return Dataset(
        dataset_id=f"case:{primary_uid[-16:]}",
        description=description,
        study_id=primary.entry.study_instance_uid or f"{primary_uid}.STUDY",
        series=tuple(ordered),
        structures=tuple(structures),
        temporal_groups=tuple(tg for b in images.values() if (tg := b.temporal_group) is not None),
        structure_sets=tuple(structure_sets),
        plans=tuple(plans),
        registrations=tuple(
            {
                "reg_id": r.series_instance_uid,
                "sop_instance_uid": r.sop_instance_uid,
                "series_date": r.series_date,
                "label": (index.series[r.series_instance_uid].series_description or "")
                if r.series_instance_uid in index.series
                else "",
                "frame_of_reference_uid": r.frame_of_reference_uid,
                "items": [
                    {
                        "source_frame_of_reference_uid": i.source_frame_of_reference_uid,
                        "matrix_row_major": [float(v) for v in i.matrix_row_major.reshape(-1)],
                        "matrix_type": i.matrix_type,
                    }
                    for i in r.items
                ],
            }
            for r in registrations
        ),
        verifies=(
            "真實資料的意外（幾何推論、非等向 spacing、ROI 命名、缺欄位）",
            "多 FrameGroup",
            "REG → transform_to_primary",
        ),
        notes={
            "dicom_meta": {**primary.geometry.meta, "series_in_directory": str(len(index.image_series()))},
            "expected_json": None,
            "rtstruct": structure_notes[0] if structure_notes else None,
            "case": {
                "selection": selection.to_wire(),
                "primary_series_uid": primary_uid,
                "registrations": [r.sop_instance_uid for r in registrations],
                "structure_sets": structure_notes,
                "warnings": warnings,
            },
        },
    )


# ── 輔助 ─────────────────────────────────────────────────────────────────────


def _image_for_rtstruct(
    index: LibraryIndex,
    uid: str,
    path: Path,
    images: dict[str, _ImageBundle],
    member_of: dict[str, tuple[str, int | None]] | None = None,
    manual_members: set[str] | None = None,
) -> tuple[_ImageBundle | None, int | None]:
    """RTSTRUCT 掛到哪個影像（＋ 4D 組的哪一幀）：先看索引算好的 `image_series_uid`，再退回讀檔看 FoR。

    參照到 4D 組（每相位一個序列）某一幀的序列 → (那個 4D 組, 幀)；參照到衍生影像（AVG）或
    一個序列內分幀的動態影像 → 靜態（每一幀都顯示）。
    """
    member_of = member_of or {}
    entry = index.series.get(uid)
    if entry is not None:
        target = entry.links.get("image_series_uid")
        if target in member_of and member_of[target][1] is not None:
            bundle_uid, frame = member_of[target]
            # 手動組成的時間軸 → 靜態（見 build_case_dataset）
            return images[bundle_uid], (None if target in (manual_members or ()) else frame)
        if target in images:
            return images[target], None
        for for_uid in entry.links.get("frame_of_reference_uids", []):
            for b in images.values():
                if b.geometry.grid.frame_of_reference_uid == for_uid:
                    return b, None
    import pydicom

    ds = pydicom.dcmread(
        str(path),
        stop_before_pixels=True,
        specific_tags=["StructureSetROISequence", "ReferencedFrameOfReferenceSequence"],
    )
    fors = {str(r.get("ReferencedFrameOfReferenceUID", "")) for r in ds.get("StructureSetROISequence", []) or []} - {""}
    fors |= {str(r.get("FrameOfReferenceUID", "")) for r in ds.get("ReferencedFrameOfReferenceSequence", []) or []} - {
        ""
    }
    for b in images.values():
        if b.geometry.grid.frame_of_reference_uid in fors:
            return b, None
    if len(images) == 1 and not fors:
        return next(iter(images.values())), None
    return None, None


def _structure_set_label(entry: SeriesEntry | None, path: Path) -> str:
    """StructureSetLabel（索引有就用；`path:` 來源讀檔）→ 沒有就 SeriesDescription → 檔名。"""
    if entry is not None:
        label = str(entry.refs.get("structure_set_label") or "").strip() or entry.series_description.strip()
        if label:
            return label
    try:
        import pydicom

        ds = pydicom.dcmread(
            str(path), stop_before_pixels=True, specific_tags=["StructureSetLabel", "SeriesDescription"]
        )
        label = str(getattr(ds, "StructureSetLabel", "") or getattr(ds, "SeriesDescription", "") or "").strip()
        if label:
            return label
    except Exception:  # noqa: BLE001 - 標籤只是顯示用
        pass
    return Path(path).stem


def _to_phantom_structures(
    loaded: list[LoadedStructure],
    frame_of_reference_uid: str,
    *,
    default_visible: bool = True,
    structure_set_id: str | None = None,
    temporal_group_id: str | None = None,
    frame_index: int | None = None,
) -> list[DatasetStructure]:
    return [
        DatasetStructure(
            structure_id=s.structure_id,
            name=s.name,
            shape=None,
            color_rgb=s.color_rgb,
            frame_of_reference_uid=frame_of_reference_uid,
            # 真實 RTSTRUCT 是臨床畫的，不是模型產生的 → 狀態不是 ai_generated
            status="under_review",
            # 🔴 追溯的來源也要跟著說
            provenance_source="import",
            default_visible=default_visible
            and (len(loaded) <= SHOW_ALL_UP_TO_STRUCTURES or n < DEFAULT_VISIBLE_PER_STRUCTURE_SET),
            preloaded=(s.offset_ijk, s.size_ijk, s.block),
            interpreted_type=s.interpreted_type,
            structure_set_id=structure_set_id,
            temporal_group_id=temporal_group_id,
            frame_index=frame_index if temporal_group_id is not None else None,
        )
        for n, s in enumerate(loaded)
    ]


def _short_tag(bundle: _ImageBundle, n: int) -> str:
    date = bundle.entry.series_date
    return f"{bundle.entry.modality.lower()}{date}" if date else f"s{n}"


def _modality_of(entry: SeriesEntry) -> str:
    """Halcyon 的 CBCT 在 DICOM 裡是 `Modality=CT`；靠機型字串辨認，讓預設視窗與標籤正確。"""
    model = (entry.manufacturer_model_name or "").lower()
    desc = (entry.series_description or "").lower()
    if entry.modality == "CT" and ("cbct" in desc or "halcyon" in model or "obi" in model or "truebeam" in model):
        return "CBCT"
    return entry.modality


def _series_meta(entry: SeriesEntry, *, geometry: SeriesGeometry | None = None) -> dict[str, object]:
    meta: dict[str, object] = {
        "patient_id": entry.patient_id,
        "study_instance_uid": entry.study_instance_uid,
        "study_date": entry.study_date,
        "study_description": entry.study_description,
        "series_instance_uid": entry.series_instance_uid,
        "series_date": entry.series_date,
        "series_time": entry.series_time,
        "series_description": entry.series_description,
        "series_number": entry.series_number,
        "manufacturer": entry.manufacturer,
        "manufacturer_model_name": entry.manufacturer_model_name,
        "instance_count": entry.instance_count,
        "dicom_modality": entry.modality,
    }
    if geometry is not None:
        meta["slice_count"] = len(geometry.files)
    return meta
