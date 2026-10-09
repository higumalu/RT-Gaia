"""目錄樹。

把 `LibraryIndex` 攤成資料頁要的四層：

    Patient › Study › 影像 Series › RT 物件（RTSTRUCT ／ REG ／ RTPLAN ▸ RTDOSE ／ 孤兒 RTDOSE）

規則：

* **計畫容納劑量**：RTPLAN 列容納它的 RTDOSE；沒有計畫的劑量以 `plan_missing` 掛在影像下。
* **REG 只掛 moving 側**（被變換的 FoR 的影像）；fixed 側只給 `registrations_targeting` 計數。
  形變對位的方向不可逆，雙掛會暗示反向也可用。
* 目錄內部以 UID 連結，但**搜尋不以 UID 為入口**：`q` 比對 PatientID、描述、label、ROI 名稱；
  UID 子字串只是備援。
* 篩選命中的是「葉」（任何序列）；祖先因子孫命中而出現；影像展開時**全部** RT 物件都列，
  以 `hit` 標示命中者 —— 搜尋結果仍是同一棵樹，不另開平表。

這裡沒有 Postgres；它是同一組端點在記憶體索引上的第一個實作，
wire 形狀就是之後 SQL 版要維持的。
"""

from __future__ import annotations

import zipfile
from collections.abc import Iterator
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Literal

from .index import LibraryIndex, SeriesEntry

RtKind = Literal["rtstruct", "reg", "plan", "dose"]
Level = Literal["patients", "studies", "series"]

_MODALITY_TO_KIND: dict[str, RtKind] = {"RTSTRUCT": "rtstruct", "REG": "reg", "RTPLAN": "plan", "RTDOSE": "dose"}
_HAS_KEYS = {"rs": "rtstruct", "rtstruct": "rtstruct", "dose": "dose", "reg": "reg", "plan": "plan"}


@dataclass
class _Attached:
    """一個影像序列底下掛了什麼（都是 series uid）。"""

    rtstruct: list[str] = field(default_factory=list)
    plan: list[str] = field(default_factory=list)
    dose: list[str] = field(default_factory=list)
    """沒有計畫（或計畫不在庫）的劑量 —— 有計畫的劑量在 `doses_of_plan`。"""
    reg: list[str] = field(default_factory=list)
    """此影像是 **moving** 側的 REG。"""
    reg_targeting: list[str] = field(default_factory=list)
    """此影像是 **fixed** 側的 REG（不掛列，只計數）。"""

    def count(self) -> int:
        return len(self.rtstruct) + len(self.plan) + len(self.dose) + len(self.reg)

    def has(self, kind: RtKind, doses_of_plan: dict[str, list[str]]) -> bool:
        if kind == "dose":
            return bool(self.dose) or any(doses_of_plan.get(p) for p in self.plan)
        return bool(getattr(self, kind))


class Catalog:
    """`LibraryIndex` 的樹狀視圖。建構時算一次反向參照；索引重掃就重建。"""

    def __init__(self, index: LibraryIndex, *, show_names: bool = False) -> None:
        self.index = index
        self.show_names = show_names
        self.attached: dict[str, _Attached] = {}
        self.doses_of_plan: dict[str, list[str]] = {}
        self.plans_of_rs: dict[str, list[str]] = {}
        self.unlinked_by_study: dict[str, list[str]] = {}
        self._resolve()

    # ── 反向參照 ────────────────────────────────────────────────────────────

    def _images_in_frame(self, for_uid: str) -> list[SeriesEntry]:
        return self.index.image_series_in_frame(for_uid) if for_uid else []

    def _resolve(self) -> None:
        idx = self.index
        for s in idx.image_series():
            self.attached[s.series_instance_uid] = _Attached()

        def attach(image_uid: str | None, kind: str, uid: str, *, study_uid: str) -> None:
            if image_uid and image_uid in self.attached:
                getattr(self.attached[image_uid], kind).append(uid)
            else:
                self.unlinked_by_study.setdefault(study_uid, []).append(uid)

        for s in idx.by_modality("RTSTRUCT"):
            attach(s.links.get("image_series_uid"), "rtstruct", s.series_instance_uid, study_uid=s.study_instance_uid)

        for s in idx.by_modality("RTPLAN"):
            attach(s.links.get("image_series_uid"), "plan", s.series_instance_uid, study_uid=s.study_instance_uid)
            rs_uid = s.links.get("structure_set_uid")
            if rs_uid:
                self.plans_of_rs.setdefault(str(rs_uid), []).append(s.series_instance_uid)

        for s in idx.by_modality("RTDOSE"):
            plan_uid = s.links.get("plan_uid")
            if plan_uid and plan_uid in idx.series:
                # 有計畫的劑量住在計畫底下
                self.doses_of_plan.setdefault(str(plan_uid), []).append(s.series_instance_uid)
                continue
            attach(s.links.get("image_series_uid"), "dose", s.series_instance_uid, study_uid=s.study_instance_uid)

        for s in idx.by_modality("REG"):
            fixed_for, moving_fors = self.reg_frames(s)
            moving_images = [i for f in moving_fors for i in self._images_in_frame(f)]
            fixed_images = self._images_in_frame(fixed_for)
            if not moving_images:
                self.unlinked_by_study.setdefault(s.study_instance_uid, []).append(s.series_instance_uid)
            for img in moving_images:
                self.attached[img.series_instance_uid].reg.append(s.series_instance_uid)
            for img in fixed_images:
                self.attached[img.series_instance_uid].reg_targeting.append(s.series_instance_uid)

        # 同一 study 內排序穩定：依日期新到舊，再依 uid
        for a in self.attached.values():
            for name in ("rtstruct", "plan", "dose", "reg", "reg_targeting"):
                setattr(a, name, self._sorted(getattr(a, name)))
        for k, v in self.doses_of_plan.items():
            self.doses_of_plan[k] = self._sorted(v)
        for k, v in self.unlinked_by_study.items():
            self.unlinked_by_study[k] = self._sorted(v)

    def _sorted(self, uids: list[str]) -> list[str]:
        def key(u: str) -> tuple[str, str, str]:
            s = self.index.series.get(u)
            return ("", "", u) if s is None else (s.series_date or "", s.series_time or "", u)

        return sorted(dict.fromkeys(uids), key=key, reverse=True)

    def reg_frames(self, s: SeriesEntry) -> tuple[str, list[str]]:
        """REG 的 fixed FoR 與 moving FoR 們（PS3.3 C.20.2.1.1：矩陣把 item 的 FoR 轉到 REG 自己的 FoR）。

        REG 自己的 `FrameOfReferenceUID` 就是 fixed；缺的話退回「矩陣為單位矩陣的那個 item」。
        """
        items = s.refs.get("registration_items") or []
        item_fors = [str(i.get("frame_of_reference_uid") or "") for i in items]
        fixed = s.frame_of_reference_uid
        if not fixed:
            for i in items:
                mats = i.get("matrices") or []
                if mats and _is_identity(mats[0].get("matrix")):
                    fixed = str(i.get("frame_of_reference_uid") or "")
                    break
        if not fixed and item_fors:
            fixed = item_fors[0]
        moving = [f for f in dict.fromkeys(item_fors) if f and f != fixed]
        if not moving and fixed:
            # 兩側同一個 FoR（單位對位）：掛在 fixed 上，方向標為「此 → 此」
            moving = [fixed]
        return fixed, moving

    # ── 篩選 ────────────────────────────────────────────────────────────────

    def match(
        self,
        *,
        q: str | None = None,
        patient_id: str | None = None,
        date_from: str | None = None,
        date_to: str | None = None,
        modality: str | None = None,
        has: str | None = None,
    ) -> set[str] | None:
        """回傳**命中的序列 uid 集合**；沒有任何條件時回 `None`（＝全部）。"""
        if not any(x and x.strip() for x in (q, patient_id, date_from, date_to, modality, has)):
            return None
        base = {
            s.series_instance_uid
            for s in self.index.search(
                patient_id=patient_id, date_from=date_from, date_to=date_to, modality=modality or None
            )
        }
        if q and q.strip():
            base &= self._free_text(q)
        wanted = [_HAS_KEYS[k] for k in (has or "").lower().replace(" ", "").split(",") if k in _HAS_KEYS]
        if wanted:
            images = {
                uid
                for uid, a in self.attached.items()
                if all(a.has(k, self.doses_of_plan) for k in wanted)  # type: ignore[arg-type]
            }
            base &= images
        return base

    def _free_text(self, q: str) -> set[str]:
        tokens = [t for t in q.lower().split() if t]
        out: set[str] = set()
        for s in self.index.series.values():
            hay = self._haystack(s)
            if all(t in hay for t in tokens):
                out.add(s.series_instance_uid)
        return out

    def _haystack(self, s: SeriesEntry) -> str:
        parts: list[Any] = [
            s.patient_id,  # 名字不進搜尋字串
            s.study_description,
            s.series_description,
            s.modality,
            s.refs.get("structure_set_label", ""),
            s.refs.get("plan_label", ""),
            " ".join(s.refs.get("roi_names") or []),
            s.links.get("plan_label") or "",
            # UID 只是備援：使用者貼進一整串 UID 也要找得到
            s.series_instance_uid,
            s.study_instance_uid,
        ]
        return " ".join(str(p) for p in parts if p).lower()

    # ── 命中傳播 ────────────────────────────────────────────────────────────

    def _subtree_uids(self, image_uid: str) -> list[str]:
        a = self.attached.get(image_uid)
        if a is None:
            return [image_uid]
        out = [image_uid, *a.rtstruct, *a.plan, *a.dose, *a.reg]
        for p in a.plan:
            out.extend(self.doses_of_plan.get(p, []))
        return out

    def _study_uids(self, study_uid: str) -> list[str]:
        out: list[str] = []
        for s in self.index.image_series():
            if s.study_instance_uid == study_uid:
                out.extend(self._subtree_uids(s.series_instance_uid))
        out.extend(self.unlinked_by_study.get(study_uid, []))
        return out

    @staticmethod
    def _any_hit(uids: list[str], match: set[str] | None) -> bool:
        return True if match is None else any(u in match for u in uids)

    @staticmethod
    def _hits(uids: list[str], match: set[str] | None) -> int:
        return len(uids) if match is None else sum(1 for u in uids if u in match)

    # ── 各層 ────────────────────────────────────────────────────────────────

    def patients(self, match: set[str] | None = None, *, page: int = 1, size: int = 50) -> dict[str, Any]:
        by_pid: dict[str, list[SeriesEntry]] = {}
        for s in self.index.series.values():
            by_pid.setdefault(s.patient_id, []).append(s)
        rows: list[dict[str, Any]] = []
        for pid in sorted(by_pid):
            entries = by_pid[pid]
            uids = [s.series_instance_uid for s in entries]
            if not self._any_hit(uids, match):
                continue
            studies = {s.study_instance_uid for s in entries}
            dates = sorted({d for s in entries for d in (s.series_date, s.study_date) if d})
            row: dict[str, Any] = {
                "kind": "patient",
                "patient_id": pid,
                "study_count": len(studies),
                "series_count": len(entries),
                "image_series_count": sum(1 for s in entries if s.is_image),
                "modalities": sorted({s.modality for s in entries}),
                "date_from": dates[0] if dates else None,
                "date_to": dates[-1] if dates else None,
                "hit_count": self._hits(uids, match),
            }
            if self.show_names:
                row["patient_name"] = self.index.patient_display_name(pid)
            rows.append(row)
        total = len(rows)
        page = max(1, page)
        size = max(1, min(size, 500))
        return {"total": total, "page": page, "size": size, "items": rows[(page - 1) * size : page * size]}

    def studies(self, patient_id: str, match: set[str] | None = None) -> list[dict[str, Any]]:
        by_study: dict[str, list[SeriesEntry]] = {}
        for s in self.index.series.values():
            if s.patient_id == patient_id:
                by_study.setdefault(s.study_instance_uid, []).append(s)
        rows: list[dict[str, Any]] = []
        for study_uid, entries in by_study.items():
            uids = self._study_uids(study_uid)
            if not self._any_hit(uids, match):
                continue
            first = entries[0]
            images = [s for s in entries if s.is_image]
            rows.append(
                {
                    "kind": "study",
                    "study_instance_uid": study_uid,
                    "patient_id": patient_id,
                    "study_date": first.study_date,
                    "study_description": first.study_description,
                    "image_series_count": len(images),
                    "rt_object_count": len(entries) - len(images),
                    "unlinked_count": len(self.unlinked_by_study.get(study_uid, [])),
                    "modalities": sorted({s.modality for s in entries}),
                    "hit_count": self._hits(uids, match),
                }
            )
        return sorted(rows, key=lambda r: (r["study_date"] or "", r["study_instance_uid"]), reverse=True)

    def series(self, study_uid: str, match: set[str] | None = None) -> dict[str, Any]:
        images: list[dict[str, Any]] = []
        for s in self.index.image_series():
            if s.study_instance_uid != study_uid:
                continue
            uids = self._subtree_uids(s.series_instance_uid)
            if not self._any_hit(uids, match):
                continue
            images.append(self.image_row(s, match))
        images.sort(
            key=lambda r: (r["series_date"] or "", r["series_time"] or "", r["series_instance_uid"]), reverse=True
        )
        unlinked = [
            self.rt_row(self.index.series[u], match)
            for u in self.unlinked_by_study.get(study_uid, [])
            if u in self.index.series and (match is None or u in match)
        ]
        # 跨序列的時間軸候選（4DCT 每相位一個序列）—— 資料頁合成一列；
        # 每一列標出它在組裡的角色。key 跟開病例時一樣（`CaseSelection.temporal_overrides` 用它）
        from ..loaders.temporal import cross_series_plans, repeated_positions

        plans = cross_series_plans(s for s in self.index.image_series() if s.study_instance_uid == study_uid)
        roles: dict[str, dict[str, Any]] = {}
        for p in plans:
            labels = p.labels or []
            for n, f in enumerate(p.frames):
                label = labels[n] if labels else None
                roles[f.series_uid] = {"key": p.key, "role": "frame", "index": n, "label": label}
            for u, op in p.derived:
                roles[u] = {"key": p.key, "role": "derived", "op": op}
            for x in p.excluded:
                roles[x["series_uid"]] = {"key": p.key, "role": "excluded", "label": x["label"], "reason": x["reason"]}
        for row in images:
            uid = row["series_instance_uid"]
            if uid in roles:
                row["temporal"] = roles[uid]
            entry = self.index.series.get(uid)
            repeats = repeated_positions(entry) if entry is not None else 1
            if entry is not None and repeats > 1:
                row["dynamic"] = _dynamic_summary(entry, repeats)  # 形狀 B：同一位置重複
            frames = sum(int(h.number_of_frames or 1) for h in entry.instances) if entry is not None else 0
            if entry is not None and any((h.number_of_frames or 1) > 1 for h in entry.instances):
                row["multiframe"] = {"frames": frames}  # 形狀 C：Enhanced 多幀（開病例時才看是不是 4D）
        return {"images": images, "unlinked": unlinked, "temporal": [p.wire() for p in plans]}

    def image_row(self, s: SeriesEntry, match: set[str] | None = None) -> dict[str, Any]:
        a = self.attached.get(s.series_instance_uid, _Attached())
        row = s.to_wire(
            show_names=self.show_names,
            patient_name=self.index.patient_display_name(s.patient_id) if self.show_names else None,
        )
        row.update(
            {
                "kind": "image",
                "rt_count": a.count(),
                "rtstruct_count": len(a.rtstruct),
                "plan_count": len(a.plan),
                "dose_count": len(a.dose) + sum(len(self.doses_of_plan.get(p, [])) for p in a.plan),
                "registration_count": len(a.reg),
                "registrations_targeting": len(a.reg_targeting),
                "hit": match is None or s.series_instance_uid in match,
                "hit_count": self._hits(self._subtree_uids(s.series_instance_uid), match),
            }
        )
        return row

    def rt(self, image_uid: str, match: set[str] | None = None) -> list[dict[str, Any]]:
        """影像展開後的第四層。順序：RTSTRUCT → RTPLAN（含 DOSE）→ 孤兒 RTDOSE → REG。全部列出，`hit` 標命中。"""
        a = self.attached.get(image_uid)
        if a is None:
            raise KeyError(f"沒有影像序列 {image_uid}")
        rows: list[dict[str, Any]] = []
        for u in a.rtstruct:
            rows.append(self.rt_row(self.index.series[u], match))
        for u in a.plan:
            row = self.rt_row(self.index.series[u], match)
            row["doses"] = [self.rt_row(self.index.series[d], match) for d in self.doses_of_plan.get(u, [])]
            rows.append(row)
        for u in a.dose:
            row = self.rt_row(self.index.series[u], match)
            row["plan_missing"] = not row.get("derived")
            rows.append(row)
        for u in a.reg:
            row = self.rt_row(self.index.series[u], match)
            row["direction"] = self._reg_direction(self.index.series[u], image_uid)
            rows.append(row)
        return rows

    def rt_row(self, s: SeriesEntry, match: set[str] | None = None) -> dict[str, Any]:
        row = s.to_wire(
            show_names=self.show_names,
            patient_name=self.index.patient_display_name(s.patient_id) if self.show_names else None,
        )
        row["kind"] = _MODALITY_TO_KIND.get(s.modality, "other")
        row["hit"] = match is None or s.series_instance_uid in match
        if s.modality == "RTSTRUCT":
            plans = self.plans_of_rs.get(s.series_instance_uid, [])
            row["referenced_by_plans"] = plans
            row["referenced_by_plan_labels"] = [
                str(self.index.series[p].refs.get("plan_label") or "") for p in plans if p in self.index.series
            ]
        if s.modality == "RTDOSE":
            row["derived"] = bool(s.refs.get("derived"))
            row["plan_missing"] = not row["derived"] and not (
                s.links.get("plan_uid") and s.links["plan_uid"] in self.index.series
            )
        if s.modality == "REG":
            fixed, moving = self.reg_frames(s)
            row["fixed_frame_of_reference_uid"] = fixed
            row["moving_frame_of_reference_uids"] = moving
            row["fixed_image_series_uids"] = [i.series_instance_uid for i in self._images_in_frame(fixed)]
        return row

    def _reg_direction(self, reg: SeriesEntry, moving_image_uid: str) -> dict[str, Any]:
        fixed, _ = self.reg_frames(reg)
        targets = self._images_in_frame(fixed)
        target = max(targets, key=lambda e: e.instance_count) if targets else None
        return {
            "from_series_uid": moving_image_uid,
            "to_series_uid": target.series_instance_uid if target else None,
            "to_label": _series_label(target) if target else "（目標影像不在庫）",
            "deformable": bool(reg.refs.get("deformable")),
            "self": bool(target and target.series_instance_uid == moving_image_uid),
        }

    def detail(self, series_uid: str) -> dict[str, Any]:
        s = self.index.series[series_uid]
        row = self.image_row(s) if s.is_image else self.rt_row(s)
        a = self.attached.get(series_uid)
        first = s.paths[0] if s.instances else None
        row.update(
            {
                "study_date": s.study_date,
                "study_description": s.study_description,
                "manufacturer": s.manufacturer,
                "sop_class_uid": s.sop_class_uid,
                "directory": str(first.parent) if first else None,
                "attached": None
                if a is None
                else {
                    "rtstruct": a.rtstruct,
                    "plan": a.plan,
                    "dose": a.dose,
                    "reg": a.reg,
                    "registrations_targeting": a.reg_targeting,
                    "doses_of_plan": {p: self.doses_of_plan.get(p, []) for p in a.plan},
                },
                "labels": {
                    u: _series_label(self.index.series[u]) for u in self._related(series_uid) if u in self.index.series
                },
            }
        )
        return row

    def _related(self, series_uid: str) -> list[str]:
        out: list[str] = []
        a = self.attached.get(series_uid)
        if a:
            out += a.rtstruct + a.plan + a.dose + a.reg + a.reg_targeting
            for p in a.plan:
                out += self.doses_of_plan.get(p, [])
        s = self.index.series[series_uid]
        for key in ("image_series_uid", "plan_uid", "structure_set_uid"):
            v = s.links.get(key)
            if v:
                out.append(str(v))
        out += self.plans_of_rs.get(series_uid, [])
        out += self.doses_of_plan.get(series_uid, [])
        return list(dict.fromkeys(out))

    # ── 搜尋 → 路徑（讓樹自動展開）──────────────────────────────────────────

    def search(self, match: set[str] | None, *, limit: int = 200) -> list[dict[str, Any]]:
        if match is None:
            return []
        hits: list[dict[str, Any]] = []
        for uid in sorted(match):
            s = self.index.series.get(uid)
            if s is None:
                continue
            image_uid = self._image_of(s)
            plan_uid = None
            if s.modality == "RTDOSE" and s.links.get("plan_uid") in self.doses_of_plan:
                plan_uid = str(s.links["plan_uid"])
            hits.append(
                {
                    "kind": "image" if s.is_image else _MODALITY_TO_KIND.get(s.modality, "other"),
                    "series_instance_uid": uid,
                    "label": _series_label(s),
                    "path": {
                        "patient_id": s.patient_id,
                        "study_instance_uid": (
                            self.index.series[image_uid].study_instance_uid if image_uid else s.study_instance_uid
                        ),
                        "image_series_uid": image_uid,
                        "plan_series_uid": plan_uid,
                        "unlinked": (not s.is_image) and image_uid is None,
                    },
                }
            )
            if len(hits) >= limit:
                break
        return hits

    def _image_of(self, s: SeriesEntry) -> str | None:
        if s.is_image:
            return s.series_instance_uid
        for image_uid, a in self.attached.items():
            if (
                s.series_instance_uid in a.rtstruct
                or s.series_instance_uid in a.plan
                or s.series_instance_uid in a.dose
            ):
                return image_uid
            if s.series_instance_uid in a.reg:
                return image_uid
            for p in a.plan:
                if s.series_instance_uid in self.doses_of_plan.get(p, []):
                    return image_uid
        return None

    # ── 下載 ────────────────────────────────────────────────────────────────

    def zip_members(self, level: Level, key: str) -> list[tuple[str, Path]]:
        """要打包的 (arcname, path)。檔名一律 UID；病人層以 study/series 分目錄。"""
        if level == "series":
            s = self.index.series[key]
            entries = [s]
        elif level == "studies":
            entries = [s for s in self.index.series.values() if s.study_instance_uid == key]
        else:
            entries = [s for s in self.index.series.values() if s.patient_id == key]
        if not entries:
            raise KeyError(f"沒有 {level} {key}")
        out: list[tuple[str, Path]] = []
        for s in entries:
            for h in sorted(s.instances, key=lambda h: (h.instance_number or 0, h.path)):
                name = f"{h.sop_instance_uid or Path(h.path).stem}.dcm"
                prefix = (
                    f"{s.series_instance_uid}/"
                    if level == "series"
                    else f"{s.study_instance_uid}/{s.series_instance_uid}/"
                )
                out.append((prefix + name, Path(h.path)))
        return out


def _is_identity(matrix: Any) -> bool:
    try:
        vals = [float(v) for v in matrix]
    except (TypeError, ValueError):
        return False
    if len(vals) != 16:
        return False
    eye = [1.0 if i % 5 == 0 else 0.0 for i in range(16)]
    return all(abs(a - b) < 1e-9 for a, b in zip(vals, eye, strict=True))


def _series_label(s: SeriesEntry) -> str:
    desc = s.series_description or s.refs.get("structure_set_label") or s.refs.get("plan_label") or ""
    return " ".join(x for x in (s.modality, s.series_date, str(desc)) if x)


class _ChunkSink:
    """給 `zipfile` 寫、給 StreamingResponse 讀的非 seekable 緩衝。"""

    def __init__(self) -> None:
        self._buf = bytearray()
        self._pos = 0

    def write(self, b: bytes) -> int:  # noqa: D401
        self._buf += b
        self._pos += len(b)
        return len(b)

    def tell(self) -> int:
        return self._pos

    def flush(self) -> None:
        pass

    def seekable(self) -> bool:
        return False

    def drain(self) -> bytes:
        out = bytes(self._buf)
        self._buf.clear()
        return out


def _zip_info(path: Path, arcname: str, method: int) -> zipfile.ZipInfo:
    info = zipfile.ZipInfo.from_file(path, arcname=arcname)
    info.compress_type = method
    return info


def zip_stream(
    members: list[tuple[str, Path]], *, chunk_bytes: int = 4 << 20, compress: bool = False
) -> Iterator[bytes]:
    """串流 zip：預設 **STORE 不壓縮**（DICOM 壓不了多少，且省 CPU）、ZIP64、不落暫存檔。

    `compress=True`（壓不壓要能選）→ DEFLATE；未壓縮的 CT 通常可省 30–50%，換 CPU 時間。"""
    sink = _ChunkSink()
    method = zipfile.ZIP_DEFLATED if compress else zipfile.ZIP_STORED
    with zipfile.ZipFile(sink, mode="w", compression=method, allowZip64=True) as zf:
        for arcname, path in members:
            with (
                zf.open(_zip_info(path, arcname, method), mode="w", force_zip64=True) as dst,
                path.open("rb") as src,
            ):
                while True:
                    block = src.read(chunk_bytes)
                    if not block:
                        break
                    dst.write(block)
                    if sink.tell() and len(sink._buf) >= chunk_bytes:
                        yield sink.drain()
            yield sink.drain()
    yield sink.drain()


def _dynamic_summary(entry: SeriesEntry, repeats: int) -> dict[str, Any]:
    """資料頁的「動態 ×N」：拆掉相位圖／ADC 之後真正的幀數與軸（以前是原始的重複數 ——
    DCE 混了相位影像顯示 ×12、實際 6 個時間點；DWI ＋ ADC 顯示 ×4、實際 3 個 b 值）。
    分析要讀每片的時間欄位（依檔案快取）；讀不到就退回原始重複數。"""
    from ..loaders.temporal import analyze_series

    out: dict[str, Any] = {"repeats": repeats}
    try:
        a = analyze_series(entry)
    except Exception:  # noqa: BLE001 - 資料頁列表不能因為一個序列讀不到就整個失敗
        return out
    if a.plan is not None:
        out.update(frames=len(a.plan.frames), axis=a.plan.axis, labeled=a.plan.labels is not None, unit=a.plan.unit)
        if a.plan.b_guess:
            out["guessed"] = True  # b 值從描述推定（開病例時再用訊號核對）
    elif a.error:
        out["error"] = a.error
    if a.split_off:
        out["split_off"] = [dict(x) for x in a.split_off]
    return out
