"""資料庫索引 —— 資料選取頁的後端。

一棵目錄樹 → Patient › Study › Series 的樹，每個序列帶著它「指向誰」與「誰指向它」
（`links`），資料頁勾一個 CT 就能自動帶入參照它的 RTSTRUCT／RTDOSE／REG。

* 只讀標頭（`scan.py`），快取在 `phantoms.cache_root()/library/`（`RTGAIA_DATA_DIR/cache`），以 mtime＋size 失效。
* **不含 PHI 判斷**：`PatientName` 一律存進索引（它在檔案裡本來就有），
  但 `to_wire(show_names=False)` 預設**不送**出去。
* 這裡沒有幾何、沒有驗證；那些在載入時才發生（`loaders/`）。
"""

from __future__ import annotations

import json
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from rtgaia_geom.hashing import digest

from ..pixel_codecs import decode_status
from .scan import IMAGE_MODALITIES, InstanceHeader, scan_tree


@dataclass
class SeriesEntry:
    series_instance_uid: str
    study_instance_uid: str
    patient_id: str
    patient_name_hash: str
    modality: str
    series_date: str
    series_time: str
    series_description: str
    series_number: str
    frame_of_reference_uid: str
    sop_class_uid: str
    manufacturer: str
    manufacturer_model_name: str
    study_date: str
    study_description: str
    instances: list[InstanceHeader] = field(default_factory=list)
    links: dict[str, Any] = field(default_factory=dict)
    """由索引算出的跨物件關係（見 `LibraryIndex.resolve_links`）。"""

    @property
    def is_image(self) -> bool:
        return self.modality in IMAGE_MODALITIES

    @property
    def instance_count(self) -> int:
        return len(self.instances)

    @property
    def refs(self) -> dict[str, Any]:
        """RT 物件一個序列通常只有一個檔案；取第一個的參照。"""
        return self.instances[0].refs if self.instances else {}

    @property
    def sop_instance_uids(self) -> set[str]:
        return {h.sop_instance_uid for h in self.instances}

    @property
    def paths(self) -> list[Path]:
        return [Path(h.path) for h in sorted(self.instances, key=lambda h: (h.instance_number or 0, h.path))]

    def to_wire(self, *, show_names: bool, patient_name: str | None = None) -> dict[str, Any]:
        first = self.instances[0] if self.instances else None
        out: dict[str, Any] = {
            "series_instance_uid": self.series_instance_uid,
            "study_instance_uid": self.study_instance_uid,
            "patient_id": self.patient_id,
            "modality": self.modality,
            "series_date": self.series_date,
            "series_time": self.series_time,
            "series_description": self.series_description,
            "series_number": self.series_number,
            "frame_of_reference_uid": self.frame_of_reference_uid,
            "manufacturer_model_name": self.manufacturer_model_name,
            "instance_count": self.instance_count,
            "is_image": self.is_image,
            "refs": self.refs,
            "links": self.links,
        }
        if show_names and patient_name:
            out["patient_name"] = patient_name
        if first is not None and self.is_image:
            out["geometry_hint"] = {
                "rows": first.rows,
                "columns": first.columns,
                "pixel_spacing": first.pixel_spacing,
                "slice_thickness": first.slice_thickness,
                "slice_count": self.instance_count,
            }
            # 壓縮格式與能不能解（資料頁標「無法解碼」；載入時同一個原因）
            out.update(decode_status({h.transfer_syntax_uid for h in self.instances}))
        return out


class LibraryIndex:
    """一棵目錄樹的 DICOM 索引。"""

    _display_names: dict[str, str] | None = None

    def patient_display_name(self, patient_id: str) -> str:
        """`--show-patient-names` 才用 —— 從這個病人的第一個檔案**當下讀** PatientName，
        只快取在這個行程的記憶體。"""
        from ..phi import read_patient_name

        if self._display_names is None:
            self._display_names = {}
        if patient_id in self._display_names:
            return self._display_names[patient_id]
        name = ""
        for s in self.series.values():
            if s.patient_id != patient_id or not s.instances:
                continue
            p = Path(s.instances[0].path)
            name = read_patient_name(p if p.is_absolute() else self.root / p)
            if name:
                break
        if len(self._display_names) > 5000:
            self._display_names.clear()
        self._display_names[patient_id] = name
        return name

    def __init__(
        self,
        root: Path,
        headers: list[InstanceHeader],
        *,
        scanned_at: float | None = None,
        generation: int | None = None,
    ) -> None:
        self.root = root
        self.headers = headers
        self.scanned_at = scanned_at if scanned_at is not None else time.time()
        self.generation = generation
        """DB 模式：載入或寫入時的目錄世代（`CatalogStore.generation`）；沒有 DB 是 None。"""
        self.series: dict[str, SeriesEntry] = {}
        self._sop_to_series: dict[str, str] = {}
        self._group()
        self.resolve_links()

    # ── 建立 ────────────────────────────────────────────────────────────────

    @classmethod
    def scan(cls, root: str | Path, *, cache_dir: Path | None = None, use_cache: bool = True) -> LibraryIndex:
        root = Path(root).resolve()
        cache_path = cls._cache_path(root, cache_dir) if use_cache else None
        previous: dict[str, InstanceHeader] = {}
        if cache_path is not None and cache_path.exists():
            try:
                raw = json.loads(cache_path.read_text(encoding="utf-8"))
                previous = {h["path"]: InstanceHeader.from_json(h) for h in raw.get("headers", [])}
            except Exception:  # noqa: BLE001 - 快取壞了就重掃
                previous = {}
        headers = scan_tree(root, previous=previous)
        index = cls(root, headers)
        if cache_path is not None:
            index._write_cache(cache_path)
        return index

    def rescan(self) -> LibraryIndex:
        return LibraryIndex.scan(self.root)

    @staticmethod
    def _cache_path(root: Path, cache_dir: Path | None) -> Path:
        if cache_dir is None:
            from ..dataset_io import cache_root

            cache_dir = cache_root() / "library"
        return cache_dir / f"{digest({'root': str(root)}, prefix='lib_', length=16)}.json"

    def _write_cache(self, path: Path) -> None:
        try:
            path.parent.mkdir(parents=True, exist_ok=True)
            tmp = path.with_suffix(".partial.json")
            tmp.write_text(
                json.dumps(
                    {
                        "root": str(self.root),
                        "scanned_at": self.scanned_at,
                        "headers": [h.to_json() for h in self.headers],
                    },
                    ensure_ascii=False,
                ),
                encoding="utf-8",
            )
            tmp.replace(path)
        except OSError:
            pass  # 快取寫不進去不是錯誤，只是下次慢一點

    def _group(self) -> None:
        for h in self.headers:
            entry = self.series.get(h.series_instance_uid)
            if entry is None:
                entry = SeriesEntry(
                    series_instance_uid=h.series_instance_uid,
                    study_instance_uid=h.study_instance_uid,
                    patient_id=h.patient_id,
                    patient_name_hash=h.patient_name_hash,
                    modality=h.modality,
                    series_date=h.series_date,
                    series_time=h.series_time,
                    series_description=h.series_description,
                    series_number=h.series_number,
                    frame_of_reference_uid=h.frame_of_reference_uid,
                    sop_class_uid=h.sop_class_uid,
                    manufacturer=h.manufacturer,
                    manufacturer_model_name=h.manufacturer_model_name,
                    study_date=h.study_date,
                    study_description=h.study_description,
                )
                self.series[h.series_instance_uid] = entry
            entry.instances.append(h)
            if h.sop_instance_uid:
                self._sop_to_series[h.sop_instance_uid] = h.series_instance_uid

    # ── 查找 ────────────────────────────────────────────────────────────────

    def series_of_sop(self, sop_instance_uid: str) -> SeriesEntry | None:
        uid = self._sop_to_series.get(sop_instance_uid)
        return self.series.get(uid) if uid else None

    def image_series(self) -> list[SeriesEntry]:
        return [s for s in self.series.values() if s.is_image]

    def image_series_in_frame(self, frame_of_reference_uid: str) -> list[SeriesEntry]:
        return [
            s
            for s in self.image_series()
            if s.frame_of_reference_uid == frame_of_reference_uid and frame_of_reference_uid
        ]

    def by_modality(self, modality: str) -> list[SeriesEntry]:
        return [s for s in self.series.values() if s.modality == modality]

    # ── 參照關係 ─────────────────────────────────────────────────────────────

    def resolve_links(self) -> None:
        """算出每個序列的 `links`。

        * 影像：`bundle = {structure_sets, doses, registrations, plans}` —— 資料頁勾一個
          CT 時自動帶入的那些。
        * RTSTRUCT：`image_series_uid`（先看它宣告參照的序列，再退回同 FoR 的影像）。
        * RTPLAN：`structure_set_uid` → `image_series_uid`。
        * RTDOSE：`plan_uid` → RTSTRUCT → 影像；退回同 FoR 的影像。
        * REG：`frame_of_reference_uids` 與對應的 `image_series_uids`。
        """
        for s in self.series.values():
            s.links = {}
        images = self.image_series()
        for s in images:
            s.links = {"bundle": {"structure_sets": [], "doses": [], "registrations": [], "plans": []}}

        def attach(image_uid: str | None, key: str, uid: str) -> None:
            if image_uid and image_uid in self.series and self.series[image_uid].is_image:
                bundle = self.series[image_uid].links["bundle"][key]
                if uid not in bundle:
                    bundle.append(uid)

        def image_for_frame(for_uid: str) -> str | None:
            cands = self.image_series_in_frame(for_uid)
            if not cands:
                return None
            return max(cands, key=lambda e: e.instance_count).series_instance_uid

        # RTSTRUCT
        for s in self.by_modality("RTSTRUCT"):
            refs = s.refs
            image_uid = next((u for u in refs.get("referenced_series_uids", []) if u in self.series), None)
            for_uids = refs.get("roi_frame_of_reference_uids") or refs.get("referenced_frame_of_reference_uids") or []
            if image_uid is None:
                image_uid = next((image_for_frame(f) for f in for_uids if image_for_frame(f)), None)
            s.links = {
                "image_series_uid": image_uid,
                "frame_of_reference_uids": for_uids,
                "structure_set_label": refs.get("structure_set_label", ""),
                "roi_count": refs.get("roi_count", 0),
            }
            attach(image_uid, "structure_sets", s.series_instance_uid)

        # RTPLAN
        for s in self.by_modality("RTPLAN"):
            rs = next(
                (
                    self.series_of_sop(u)
                    for u in s.refs.get("referenced_structure_set_sop_uids", [])
                    if self.series_of_sop(u)
                ),
                None,
            )
            image_uid = rs.links.get("image_series_uid") if rs else image_for_frame(s.frame_of_reference_uid)
            s.links = {
                "structure_set_uid": rs.series_instance_uid if rs else None,
                "image_series_uid": image_uid,
                "plan_label": s.refs.get("plan_label", ""),
                "prescription_gy": s.refs.get("prescription_gy", []),
            }
            attach(image_uid, "plans", s.series_instance_uid)

        # RTDOSE
        for s in self.by_modality("RTDOSE"):
            # 劑量運算的結果可能參照好幾個計畫 → 不掛在任何一個計畫底下，掛在網格（A）那組影像底下
            plan = (
                None
                if s.refs.get("derived")
                else next(
                    (
                        self.series_of_sop(u)
                        for u in s.refs.get("referenced_plan_sop_uids", [])
                        if self.series_of_sop(u)
                    ),
                    None,
                )
            )
            image_uid = None
            if plan is not None:
                image_uid = plan.links.get("image_series_uid")
            # 劑量與它的影像必須同 FoR；參照鏈指到別的 FoR 時以 FoR 為準
            if image_uid is None or self.series[image_uid].frame_of_reference_uid != s.frame_of_reference_uid:
                image_uid = image_for_frame(s.frame_of_reference_uid) or image_uid
            s.links = {
                "plan_uid": plan.series_instance_uid if plan else None,
                "plan_label": plan.links.get("plan_label") if plan else None,
                "prescription_gy": plan.links.get("prescription_gy") if plan else [],
                "image_series_uid": image_uid,
                "dose_units": s.refs.get("dose_units"),
                "summation_type": s.refs.get("dose_summation_type"),
                "derived": bool(s.refs.get("derived")),
            }
            attach(image_uid, "doses", s.series_instance_uid)

        # REG
        for s in self.by_modality("REG"):
            fors = [s.frame_of_reference_uid] + [
                i.get("frame_of_reference_uid", "") for i in s.refs.get("registration_items", [])
            ]
            fors = [f for f in dict.fromkeys(fors) if f]
            image_uids = [u for u in (image_for_frame(f) for f in fors) if u]
            s.links = {
                "frame_of_reference_uids": fors,
                "image_series_uids": image_uids,
                "deformable": bool(s.refs.get("deformable")),
                "matrix_types": sorted(
                    {m.get("type", "") for i in s.refs.get("registration_items", []) for m in i.get("matrices", [])}
                    - {""}
                ),
            }
            for u in image_uids:
                attach(u, "registrations", s.series_instance_uid)

    # ── 搜尋 ────────────────────────────────────────────────────────────────

    def search(
        self,
        *,
        patient_id: str | None = None,
        date_from: str | None = None,
        date_to: str | None = None,
        description: str | None = None,
        modality: str | None = None,
    ) -> list[SeriesEntry]:
        """篩選序列。日期是 DICOM 的 `YYYYMMDD` 字串（字串比較即可）。

        `description` 同時比對 SeriesDescription、StudyDescription 與 RT 物件的
        label（StructureSetLabel／RTPlanLabel）—— 臨床上「找那個 ART 計畫」講的
        常是 label 而不是序列描述。
        """
        needle = (description or "").strip().lower()
        mods = {m.strip().upper() for m in (modality or "").split(",") if m.strip()}
        out: list[SeriesEntry] = []
        for s in self.series.values():
            if patient_id and patient_id.strip().lower() not in s.patient_id.lower():
                continue
            if mods and s.modality.upper() not in mods:
                continue
            date = s.series_date or s.study_date
            if date_from and date and date < date_from.replace("-", ""):
                continue
            if date_to and date and date > date_to.replace("-", ""):
                continue
            if needle:
                haystack = " ".join(
                    str(x)
                    for x in (
                        s.series_description,
                        s.study_description,
                        s.refs.get("structure_set_label", ""),
                        s.refs.get("plan_label", ""),
                        s.modality,
                    )
                ).lower()
                if needle not in haystack:
                    continue
            out.append(s)
        return sorted(out, key=lambda s: (s.patient_id, s.study_date, s.series_date, s.series_time, s.modality))

    def tree(self, entries: list[SeriesEntry] | None = None, *, show_names: bool = False) -> dict[str, Any]:
        """Patient › Study › Series（資料頁的主表）。"""
        entries = list(self.series.values()) if entries is None else entries
        patients: dict[str, dict[str, Any]] = {}
        for s in entries:
            p = patients.setdefault(
                s.patient_id,
                {
                    "patient_id": s.patient_id,
                    **({"patient_name": self.patient_display_name(s.patient_id)} if show_names else {}),
                    "studies": {},
                },
            )
            st = p["studies"].setdefault(
                s.study_instance_uid,
                {
                    "study_instance_uid": s.study_instance_uid,
                    "study_date": s.study_date,
                    "study_description": s.study_description,
                    "series": [],
                },
            )
            st["series"].append(
                s.to_wire(
                    show_names=show_names, patient_name=self.patient_display_name(s.patient_id) if show_names else None
                )
            )
        return {
            "patients": [
                {**p, "studies": sorted(p["studies"].values(), key=lambda st: st["study_date"])}
                for p in sorted(patients.values(), key=lambda p: p["patient_id"])
            ]
        }

    def patients(self, q: str | None = None, *, show_names: bool = False) -> list[dict[str, Any]]:
        needle = (q or "").strip().lower()
        out: dict[str, dict[str, Any]] = {}
        for s in self.series.values():
            # 只比 PatientID（名字不參與搜尋）
            if needle and needle not in s.patient_id.lower():
                continue
            p = out.setdefault(
                s.patient_id,
                {
                    "patient_id": s.patient_id,
                    **({"patient_name": self.patient_display_name(s.patient_id)} if show_names else {}),
                    "study_uids": set(),
                    "series_count": 0,
                    "modalities": set(),
                    "dates": set(),
                },
            )
            p["study_uids"].add(s.study_instance_uid)
            p["series_count"] += 1
            p["modalities"].add(s.modality)
            if s.series_date:
                p["dates"].add(s.series_date)
        return [
            {
                "patient_id": p["patient_id"],
                **({"patient_name": p["patient_name"]} if show_names else {}),
                "study_count": len(p["study_uids"]),
                "series_count": p["series_count"],
                "modalities": sorted(p["modalities"]),
                "date_from": min(p["dates"]) if p["dates"] else None,
                "date_to": max(p["dates"]) if p["dates"] else None,
            }
            for p in sorted(out.values(), key=lambda p: p["patient_id"])
        ]

    def summary(self) -> dict[str, Any]:
        mods: dict[str, int] = {}
        for s in self.series.values():
            mods[s.modality] = mods.get(s.modality, 0) + 1
        return {
            "root": str(self.root),
            "scanned_at": self.scanned_at,
            "file_count": len(self.headers),
            "series_count": len(self.series),
            "patient_count": len({s.patient_id for s in self.series.values()}),
            "modalities": mods,
        }
