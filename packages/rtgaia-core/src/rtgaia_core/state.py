"""病例與會話狀態 —— 記憶體 ＋ 磁碟快取，重啟即清空。

原本一個 `Session` 拆成兩種壽命：

* **`Case`**：臨床工作狀態 —— 資料集、FrameGroup、MaskGrid、結構（含編輯）、transform、審核、量測、job。
  後端重啟後使用者會在意它消失 → 持久化。同一個病例不論開幾次都是同一個 Case。
* **`Session`**：一次連線的顯示協商 —— Tier、DisplayGrid、`client_seq` 水位、圖層覆寫。重新協商就有，不需要持久化。

`Session` 對 `Case` 的欄位與方法**委派**（`session.structures` ＝ `session.case.structures`），因此路由層不必改；
判準只有一條：「重啟後使用者會不會在意它消失」。
"""

from __future__ import annotations

import uuid
from dataclasses import dataclass, field, replace
from datetime import UTC, datetime
from typing import Any

import numpy as np
from rtgaia_geom import (
    DisplayGrid,
    FrameGroup,
    GridSet,
    MaskGrid,
    Provenance,
    Tier,
    ViewReference,
    require,
)
from rtgaia_geom.grid import Grid, Int3
from rtgaia_geom.hashing import payload_content_hash
from rtgaia_geom.temporal import TemporalGroup

from . import dataset_io as phantoms
from .dataset import Dataset
from .structure_state import (  # 搬到 structure_state.py，這裡再匯出（舊的 import 照舊）
    MAX_VERSIONS_IN_MEMORY,
    MODULE_VERSION,
    ConflictError,
    StructureKey,
    StructureState,
    StructureVersion,
    VersionKind,
    _now_iso,
)
from .tiers import ClientCapability, TierDecision, decide_tier, display_grid_for

SESSION_IDLE_SECONDS = 30 * 60
"""WS 斷線多久後 session 過期。"""


def default_work_set_label(owner: str) -> str:
    """自動建的工作集名稱（存在 DB）。介面依語言顯示（前端 `setLabel`）；
    匯出 RTSTRUCT 時換成帳號（`jobs._default_label`）。"""
    return f"{owner} 的結構集"


@dataclass
class Case:
    """一個病例的**工作狀態**。跨 Session 存活；同一份資料集只有一個 Case。"""

    case_id: str
    dataset: Dataset
    """資料集（合成假體或真實病例）。名字是歷史包袱，拆套件時改 `Dataset`。"""
    mask_grid: MaskGrid
    """primary FoR 的 MaskGrid；其餘 FoR 的在 `mask_grids`。"""
    frame_groups: tuple[FrameGroup, ...]
    temporal_groups: tuple[TemporalGroup, ...]
    mask_grids: dict[str, MaskGrid] = field(default_factory=dict)
    """FoR → 該 FoR 的影像取像網格的 MaskGrid。**每個 FrameGroup 一個。**"""
    structures: dict[StructureKey, StructureState] = field(default_factory=dict)
    transforms: dict[str, dict[str, Any]] = field(default_factory=dict)
    jobs: dict[str, dict[str, Any]] = field(default_factory=dict)
    # 🔴 key 是 `(structure_key, client_id)`，不是單純的 structure_key。
    #
    # 只用 structure_key 的話，**同一個結構換一個 client 就必然誤判**：
    # 使用者重新整理頁面後前端的 `client_seq` 從 1 重新起算，後端還記著上一輪的
    # 6，於是第一筆編輯被判 `out_of_order` → 清空 undo → 但規則明說
    # 409「只在真正的外部修改時發生」。`client_seq` 是**每個 client 各自**單調
    # 遞增的網路重排保險，作用域必須包含 client。
    #
    # 搬到 Case：`client_id` 已經是每個瀏覽器分頁唯一，水位不必再綁哪一個 Session；
    # 兩個人的請求落到病例的任何一個 session 都查同一張表。
    last_client_seq: dict[tuple[StructureKey, str], int] = field(default_factory=dict)
    review_events: list[dict[str, Any]] = field(default_factory=list)
    """簽核事件，每一次狀態轉移一列：
    `{event_id, structure_id, frame_index, from_status, to_status, note, user, at}`。
    `structure.status` 是它的投影。舊名 `review_notes` 以屬性保留。"""
    measurements: dict[str, dict[str, Any]] = field(default_factory=dict)
    """量測是 `kind='measurement'` 的 Layer，因此自動繼承顯示／群組／變換。"""
    source: str = ""
    selection: dict[str, Any] = field(default_factory=dict)
    """`POST /sessions` 的選取（wire 形狀）——持久化後由它重組資料集。"""
    selection_hash: str | None = None
    """`POST /sessions` 的選取 digest —— 同選取回同一個 Case（冪等）。

    假體（`_test/load`）為 None：每次載入都是新 Case（測試語意＝重置）。"""
    structure_sets: list[dict[str, Any]] = field(default_factory=list)
    retired_structure_ids: set[str] = field(default_factory=set)
    """已刪除（在暫存區／封存區）的結構 id。新結構不可重用 —— 否則寫回 DB 的 upsert 會蓋掉那筆已刪除的列。
    從 DB 載入時一起讀；在記憶體裡刪除時加入；救回時移除。"""
    """結構集清單；結構清單與圖層以它分層。

    多人「各自新增、可合併」：兩種 —
    `kind="import"`（來源 RTSTRUCT，**唯讀**，由 `phantom.structure_sets` 重組）與
    `kind="work"`（某使用者的工作集，`owner`；持久化在 `structure_set` 表）。
    每人每個 FoR 一個工作集，第一次要畫時自動建。"""

    # ── 結構集 ────────────────────────────────────────────────

    @property
    def uses_structure_sets(self) -> bool:
        """library 病例（有 selection_hash）才有結構集規則；假體（測試）維持「誰都能改」。"""
        return self.selection_hash is not None

    def structure_set(self, structure_set_id: str | None) -> dict[str, Any] | None:
        if structure_set_id is None:
            return None
        return next((s for s in self.structure_sets if s["structure_set_id"] == structure_set_id), None)

    @staticmethod
    def work_set_id(user: str, frame_of_reference_uid: str) -> str:
        import hashlib

        return f"work:{user}:{hashlib.sha1(frame_of_reference_uid.encode('utf-8')).hexdigest()[:8]}"

    def work_set_for(self, user: str, frame_of_reference_uid: str, *, create: bool = True) -> dict[str, Any] | None:
        """某人在某個 FoR 的工作集（每人一個；一個集只屬於一組影像，所以以 FoR 分）。"""
        set_id = self.work_set_id(user, frame_of_reference_uid)
        found = self.structure_set(set_id)
        if found is not None or not create:
            return found
        try:
            series = self.dataset.image_series_for(frame_of_reference_uid)
            image_label = f"{series.modality} {series.meta.get('series_date', '')}".strip()
            image_uid = series.series_id
        except StopIteration:
            image_label, image_uid = "", ""
        made = {
            "structure_set_id": set_id,
            "kind": "work",
            "label": default_work_set_label(user),
            "owner": user,
            "series_instance_uid": None,
            "image_series_uid": image_uid,
            "image_label": image_label,
            "frame_of_reference_uid": frame_of_reference_uid,
            "date": "",
            "roi_count": 0,
            "role": "work",
            "created_at": datetime.now(UTC).isoformat(timespec="seconds"),
        }
        self.structure_sets.append(made)
        self.touch()
        return made

    def new_work_set(
        self, user: str, frame_of_reference_uid: str, *, label: str, description: str = ""
    ) -> dict[str, Any]:
        """一人一 FoR **多套**工作集。預設那套仍是 `work_set_id()`；這裡建的是
        `work:<user>:<FoR hash>:<8 位隨機>`，label 使用者定。持久化走同一張 `structure_set` 表。"""
        import secrets

        base = self.work_set_id(user, frame_of_reference_uid)
        set_id = f"{base}:{secrets.token_hex(4)}"
        while self.structure_set(set_id) is not None:
            set_id = f"{base}:{secrets.token_hex(4)}"
        try:
            series = self.dataset.image_series_for(frame_of_reference_uid)
            image_label = f"{series.modality} {series.meta.get('series_date', '')}".strip()
            image_uid = series.series_id
        except StopIteration:
            image_label, image_uid = "", ""
        made = {
            "structure_set_id": set_id,
            "kind": "work",
            "label": label,
            "description": description,
            "owner": user,
            "series_instance_uid": None,
            "image_series_uid": image_uid,
            "image_label": image_label,
            "frame_of_reference_uid": frame_of_reference_uid,
            "date": "",
            "roi_count": 0,
            "role": "work",
            "created_at": datetime.now(UTC).isoformat(timespec="seconds"),
        }
        self.structure_sets.append(made)
        self.touch()
        return made

    def structure_id_taken(self, structure_id: str) -> bool:
        return structure_id in self.retired_structure_ids or any(sid == structure_id for sid, _ in self.structures)

    @staticmethod
    def structure_id_from_name(name: str) -> str:
        """名稱 → 可以放進 URL 的 structure_id 底（跟匯入 ROI 名稱同一套：字母數字與 `-_` 以外換成 `_`）。
        名稱裡的 `/`、空白以前原樣進 id，`/structures/{id}` 這類網址就壞了。"""
        base = "".join(ch if (ch.isalnum() or ch in "-_") else "_" for ch in name).strip("_")
        return base or "roi"

    def unique_structure_id(self, base: str, *, sep: str = "_") -> str:
        """`base` 沒被用過（含已刪除的）就用它，否則 `base_2`、`base_3`…；太長的先截斷（`fit_id`，留後綴的位置）——
        衍生的 id（合併的 `<id>__<人>`、時間軸用名稱組的）以前會超過欄寬，整個病例之後都存不進 DB。"""
        from .limits import STRUCTURE_ID_MAX, fit_id

        base = fit_id(base, STRUCTURE_ID_MAX - 8)
        if not self.structure_id_taken(base):
            return base
        n = 2
        while self.structure_id_taken(f"{base}{sep}{n}"):
            n += 1
        return f"{base}{sep}{n}"

    def next_user_structure_id(self) -> str:
        """新建結構的預設 id：`user_NNN`，跳過現存與已刪除的（2026-09-24 前是「結構數＋1」，刪過東西就撞號）。"""
        n = len({sid for sid, _ in self.structures}) + 1
        while self.structure_id_taken(f"user_{n:03d}"):
            n += 1
        return f"user_{n:03d}"

    def ensure_work_set(self, structure_set_id: str, *, label: str, frame_of_reference_uid: str) -> dict[str, Any]:
        """救回：結構原本的工作集已經被刪掉時，以**同一個 id 與名稱**重建（擁有者從 id `work:<user>:…` 取）。"""
        found = self.structure_set(structure_set_id)
        if found is not None:
            return found
        parts = structure_set_id.split(":")
        owner = parts[1] if len(parts) >= 3 and parts[0] == "work" else ""
        made = self.new_work_set(owner, frame_of_reference_uid, label=label or default_work_set_label(owner))
        self.structure_sets.remove(made)
        made["structure_set_id"] = structure_set_id
        self.structure_sets.append(made)
        return made

    def remove_structure_set(self, structure_set_id: str) -> list[tuple[str, int | None]]:
        """把一套結構集與它的全部結構（所有相位）從記憶體拿掉；回傳拿掉的 (structure_id, frame) 鍵。
        簽核事件與推送由呼叫端負責。persist 時：工作集整批重寫、結構標 deleted_at。"""
        keys = [k for k, st in self.structures.items() if st.structure_set_id == structure_set_id]
        for k in keys:
            self.structures.pop(k, None)
            self.retired_structure_ids.add(k[0])
        self.structure_sets[:] = [s for s in self.structure_sets if s["structure_set_id"] != structure_set_id]
        self.touch()
        return keys

    @staticmethod
    def transient_set_id(user: str, frame_of_reference_uid: str) -> str:
        import hashlib

        return f"transient:{user}:{hashlib.sha1(frame_of_reference_uid.encode('utf-8')).hexdigest()[:8]}"

    def transient_set_for(self, user: str, frame_of_reference_uid: str, *, module_version: str) -> dict[str, Any]:
        """某人在某個 FoR 的暫存集（plugin 結果，未儲存）。只有擁有者看得到；不進 DB；不能簽核。"""
        set_id = self.transient_set_id(user, frame_of_reference_uid)
        found = self.structure_set(set_id)
        if found is not None:
            found.setdefault("module_versions", [])
            if module_version not in found["module_versions"]:
                found["module_versions"].append(module_version)
            return found
        try:
            series = self.dataset.image_series_for(frame_of_reference_uid)
            image_label = f"{series.modality} {series.meta.get('series_date', '')}".strip()
            image_uid = series.series_id
        except StopIteration:
            image_label, image_uid = "", ""
        made = {
            "structure_set_id": set_id,
            "kind": "transient",
            "label": "plugin 結果（未儲存）",
            "owner": user,
            "series_instance_uid": None,
            "image_series_uid": image_uid,
            "image_label": image_label,
            "frame_of_reference_uid": frame_of_reference_uid,
            "date": "",
            "roi_count": 0,
            "role": "work",
            "module_versions": [module_version],
            "created_at": datetime.now(UTC).isoformat(timespec="seconds"),
        }
        self.structure_sets.append(made)
        self.touch()
        return made

    def structure_set_wire(self, s: dict[str, Any], user: str | None, *, admin: bool = False) -> dict[str, Any]:
        """結構集給前端的形狀：多 `mine`／`editable`／`structure_count`。
        2026-09-24：`scene()` 之前直接丟原始 dict，沒有 `editable` → 檢視器載入病例後結構集的「編輯」選單不出現，
        只有 `GET /structure-sets`（用 `_set_wire`）那一刻看得到。兩條路現在共用這裡。"""
        mine = bool(s.get("kind") in ("work", "transient") and user is not None and s.get("owner") == user)
        return {
            **s,
            "description": s.get("description") or "",
            "kind": s.get("kind", "import"),
            "mine": mine,
            "editable": bool((s.get("kind") == "work" and (mine or admin)) or (s.get("kind") == "transient" and mine)),
            "structure_count": sum(
                1
                for (_, fi), st in self.structures.items()
                if st.structure_set_id == s["structure_set_id"] and fi in (None, 0)
            ),
        }

    def is_transient_of_other(self, structure_set_id: str | None, user: str | None) -> bool:
        """暫存集只給擁有者看。`user=None`（驅動腳本、內部）＝ 全部看得到。"""
        if user is None or structure_set_id is None:
            return False
        s = self.structure_set(structure_set_id)
        return bool(s and s.get("kind") == "transient" and s.get("owner") != user)

    def transient_structures(self, user: str) -> list[StructureState]:
        ids = {
            s["structure_set_id"]
            for s in self.structure_sets
            if s.get("kind") == "transient" and s.get("owner") == user
        }
        return [st for st in self.structures.values() if st.structure_set_id in ids]

    def drop_transient(self, user: str) -> list[str]:
        """銷毀某人的暫存集與其結構（viewer 關閉且過了 grace）。回傳移除的 structure_id。"""
        gone = sorted({st.structure_id for st in self.transient_structures(user)})
        for k in [k for k, st in self.structures.items() if st.structure_id in gone]:
            self.structures.pop(k, None)
        self.structure_sets[:] = [
            s for s in self.structure_sets if not (s.get("kind") == "transient" and s.get("owner") == user)
        ]
        if gone:
            self.touch()
        return gone

    # ── 劑量運算的暫存結果 ────────────────────────────────────────────────

    def derived_dose_owner(self, series_id: str) -> str | None:
        """暫存的劑量運算結果是誰的；不是暫存結果 → None。"""
        for s in self.dataset.series:
            if s.series_id == series_id:
                d = s.params.get("derived") if s.params else None
                return str(d.get("owner")) if isinstance(d, dict) else None
        return None

    def is_derived_dose_of_other(self, series_id: str, user: str | None) -> bool:
        owner = self.derived_dose_owner(series_id)
        return owner is not None and owner != (user or "anonymous")

    def derived_doses(self, user: str) -> list[Any]:
        return [
            s
            for s in self.dataset.series
            if isinstance((s.params or {}).get("derived"), dict) and s.params["derived"].get("owner") == user
        ]

    def add_derived_dose(self, series: Any) -> None:
        """暫存結果進資料集（`Dataset` 是不可變的 → 換一份）。跟 plugin 暫存結果同一套語意：
        只有建立者看得到、關掉病例（最後一條 session 走了）就銷毀、不寫 DB。"""
        self.dataset = replace(self.dataset, series=(*self.dataset.series, series))

    def drop_derived_doses(self, user: str, series_ids: list[str] | None = None) -> list[str]:
        mine = {s.series_id for s in self.derived_doses(user)}
        gone = sorted(mine if series_ids is None else mine & set(series_ids))
        if gone:
            kept = tuple(s for s in self.dataset.series if s.series_id not in gone)
            self.dataset = replace(self.dataset, series=kept)
        return gone

    def can_edit(self, st: StructureState, *, user: str, is_admin: bool = False) -> tuple[bool, str | None]:
        """(可改？, 不可改的代碼)。沒有結構集的結構（假體、舊資料）誰都能改；匯入集唯讀；
        工作集只有擁有者（或 admin）；暫存集**可編輯**，但只有擁有者。"""
        s = self.structure_set(st.structure_set_id)
        if s is None:
            return True, None
        if s.get("kind", "import") == "import":
            return False, "IMPORT_READ_ONLY"
        if s.get("kind") == "transient":
            return (True, None) if s.get("owner") == user else (False, "NOT_OWNER")
        if is_admin or s.get("owner") == user:
            return True, None
        return False, "NOT_OWNER"

    created_at: str = field(default_factory=lambda: datetime.now(UTC).isoformat(timespec="seconds"))
    updated_at: str = field(default_factory=lambda: datetime.now(UTC).isoformat(timespec="seconds"))

    @property
    def study_id(self) -> str:
        return self.dataset.study_id

    def touch(self) -> None:
        self.updated_at = datetime.now(UTC).isoformat(timespec="seconds")

    @property
    def review_notes(self) -> list[dict[str, Any]]:
        """舊名（相容）。"""
        return self.review_events

    def record_review(
        self,
        *,
        structure_id: str,
        frame_index: int | None,
        from_status: str,
        to_status: str,
        note: str,
        user: str,
        tier: str | None = None,
        device: str | None = None,
        structure_name: str | None = None,
    ) -> dict[str, Any]:
        """`tier`：簽核當下檢視端的 Tier（Tier C 允許簽核，事件記下 Tier）。
        `device`：在哪一類裝置上簽的（`phone`／`tablet`／`desktop`）。"""
        event = {
            "event_id": f"rev_{uuid.uuid4().hex[:10]}",
            "structure_id": structure_id,
            "frame_index": frame_index,
            "from_status": from_status,
            "to_status": to_status,
            "note": note,
            "user": user,
            "at": _now_iso(),
        }
        # 當下的結構名稱一起記：結構刪掉之後清單裡找不到它，事件只剩內部 id（「physicist 把 user_009 …」）。
        # 已經從清單拿掉的（刪除）由呼叫端給
        name = structure_name or next(
            (st.name for (sid, _), st in self.structures.items() if sid == structure_id), None
        )
        if name:
            event["structure_name"] = name
        if tier:
            event["tier"] = tier
        if device:
            event["device"] = device
        self.review_events.append(event)
        self.touch()
        return event

    # ── 網格 ────────────────────────────────────────────────────────────────

    def grid_for_frame(self, frame_of_reference_uid: str) -> Grid:
        """某個 FoR 的**影像**取像網格——結構光柵化在它上面，劑量網格不算。"""
        return self.dataset.image_series_for(frame_of_reference_uid).grid

    def mask_grid_for(self, frame_of_reference_uid: str) -> MaskGrid:
        """某個 FoR 的結構所在的 MaskGrid（每個 FrameGroup 一個）。"""
        try:
            return self.mask_grids[frame_of_reference_uid]
        except KeyError:
            if frame_of_reference_uid == self.mask_grid.grid.frame_of_reference_uid:
                return self.mask_grid
            raise

    def mask_grid_of_structure(self, structure_id: str, frame_index: int | None = None) -> MaskGrid:
        return self.mask_grid_for(self.structure(structure_id, frame_index).frame_of_reference_uid)

    # ── 結構 ────────────────────────────────────────────────────────────────

    def structure(self, structure_id: str, frame_index: int | None = None) -> StructureState:
        key = self._resolve_key(structure_id, frame_index)
        if key not in self.structures:
            raise KeyError(f"case {self.case_id} 沒有結構 {key}")
        return self.structures[key]

    def _resolve_key(self, structure_id: str, frame_index: int | None) -> StructureKey:
        """**F3**：`temporal_group_id` 由結構決定，因此鍵只需 `(id, frame)`。

        靜態結構即使收到 `frame` 也一律忽略——這讓前端在播放中對靜態結構下筆
        不會誤建出第二份 mask。

        帶時間軸的結構沒給 `frame` → 取最小的相位（清單、可編輯判斷、job、plugin 這些只要**名稱、
        結構集、狀態**的呼叫端都是單參數，各相位這些欄位相同；以前直接 KeyError，4D 病例的結構清單整個 404）。
        """
        frames: list[int] = []
        for sid, fi in self.structures:
            if sid != structure_id:
                continue
            if fi is None:
                return (sid, None)
            frames.append(fi)
        if frame_index is None and frames:
            return (structure_id, min(frames))
        return (structure_id, frame_index)

    def structure_list(self, *, user: str | None = None) -> list[dict[str, Any]]:
        """結構清單（不含體素資料）。

        帶時間軸的結構在清單上是**一個項目**，`bbox_ijk` 為所有 frame 的聯集。
        `user` 給了就**過濾掉別人的暫存集**（plugin 結果只有觸發者看得到）。
        """
        by_id: dict[str, list[StructureState]] = {}
        for st in self.structures.values():
            if self.is_transient_of_other(st.structure_set_id, user):
                continue
            by_id.setdefault(st.structure_id, []).append(st)
        out: list[dict[str, Any]] = []
        for structure_id, states in by_id.items():
            first = states[0]
            grid = self.grid_for_frame(first.frame_of_reference_uid)
            lo = np.min([np.asarray(s.offset_ijk) for s in states], axis=0)
            hi = np.max([np.asarray(s.offset_ijk) + np.asarray(s.size_ijk) for s in states], axis=0)
            tg = first.temporal_group_id
            frame_count = None
            if tg is not None:
                frame_count = next((g.frame_count for g in self.temporal_groups if g.temporal_group_id == tg), None)
            out.append(
                {
                    "structure_id": structure_id,
                    "name": first.name,
                    "tg263_code": first.tg263_code,
                    "interpreted_type": first.interpreted_type,
                    "color_rgb": list(first.color_rgb),
                    "frame_of_reference_uid": first.frame_of_reference_uid,
                    "structure_set_id": first.structure_set_id,
                    "structure_set_kind": (
                        (self.structure_set(first.structure_set_id) or {}).get("kind", "import")
                        if first.structure_set_id
                        else None
                    ),
                    "structure_set_owner": (self.structure_set(first.structure_set_id) or {}).get("owner"),
                    "bbox_ijk": {
                        "offset": [int(v) for v in lo],
                        "size": [int(v) for v in (hi - lo)],
                    },
                    "volume_cc": (
                        first.volume_cc(grid)
                        if len(states) == 1
                        else [s.volume_cc(grid) for s in sorted(states, key=lambda s: s.frame_index or 0)]
                    ),
                    "default_visible": first.default_visible,
                    "content_hash": first.content_hash if len(states) == 1 else None,
                    "content_hashes": (
                        None
                        if len(states) == 1
                        else {
                            str(s.frame_index): s.content_hash for s in sorted(states, key=lambda s: s.frame_index or 0)
                        }
                    ),
                    "provenance": first.provenance.to_wire(),
                    "status": first.status,
                    "temporal_group_id": tg,
                    "frame_count": frame_count if frame_count is not None else 1,
                    # 這個結構有哪幾幀（畫在 4DCT 某一相位上的只有那一幀；None ＝ 靜態）
                    "frames": sorted(s.frame_index for s in states if s.frame_index is not None) if tg else None,
                }
            )
        return sorted(out, key=lambda d: str(d["structure_id"]))

    # ── 編輯 ───────────────────────────────────────────────────

    def apply_edit(
        self,
        *,
        structure_id: str,
        frame_index: int | None,
        mask_grid_id: str,
        base_content_hash: str,
        offset_ijk: Int3,
        size_ijk: Int3,
        data: np.ndarray,
        view_reference: ViewReference,
        client_seq: int,
        client_id: str,
        last_client_seq: dict[tuple[StructureKey, str], int],
        user: str = "anonymous",
    ) -> StructureState:
        """`last_client_seq` 是**Session** 的（每個 client 各自的網路重排保險），由呼叫的 Session 傳進來。"""
        st = self.structure(structure_id, frame_index)
        expected_grid = self.mask_grid_for(st.frame_of_reference_uid)
        require(
            mask_grid_id == expected_grid.mask_grid_id,
            "I3",
            "編輯請求的 mask_grid_id 與**該結構 FoR 的** MaskGrid 不符"
            "（不是 display_grid_id；次要 FoR 的結構有自己的 MaskGrid）",
            request=mask_grid_id,
            session=expected_grid.mask_grid_id,
        )
        if st.content_hash != base_content_hash:
            raise ConflictError(
                "base_content_hash 已過期",
                content_hash=st.content_hash,
                reason="stale_hash",
            )
        seq_key = (st.key, client_id)
        last = last_client_seq.get(seq_key, -1)
        if client_seq <= last:
            raise ConflictError(
                f"client_seq 亂序（client {client_id} 收到 {client_seq}，已處理到 {last}）",
                content_hash=st.content_hash,
                reason="out_of_order",
            )
        grid = self.grid_for_frame(st.frame_of_reference_uid)
        dense = st.dense(grid)
        o, s = offset_ijk, size_ijk
        require(
            all(o[i] >= 0 and o[i] + s[i] <= grid.size[i] for i in range(3)),
            "E1",
            "編輯區塊超出 mask 網格範圍",
            offset_ijk=list(o),
            size_ijk=list(s),
            grid_size=list(grid.size),
        )
        dense[o[2] : o[2] + s[2], o[1] : o[1] + s[1], o[0] : o[0] + s[0]] = data
        st.replace_dense(
            dense,
            Provenance(
                source="user-edit",
                module_version=MODULE_VERSION,
                parent_hash=base_content_hash,
                view_reference=view_reference,
            ),
            kind="edit",
            user=user,
            client_id=client_id,
            client_seq=client_seq,
        )
        st.status = "edited"
        last_client_seq[seq_key] = client_seq
        self.touch()
        return st

    def to_wire(self, *, sessions: int = 0) -> dict[str, Any]:
        """`GET /cases` 的一列。"""
        return {
            "case_id": self.case_id,
            "study_id": self.study_id,
            "source": self.source,
            "selection_hash": self.selection_hash,
            "description": self.dataset.description,
            "structure_count": len({sid for sid, _ in self.structures}),
            "edited_count": sum(1 for st in self.structures.values() if st.status == "edited"),
            "approved_count": sum(1 for st in self.structures.values() if st.status == "approved"),
            "measurement_count": len(self.measurements),
            "version_count": sum(len(st.versions) for st in self.structures.values()),
            "review_event_count": len(self.review_events),
            "job_count": len(self.jobs),
            "frame_groups": [fg.to_wire() for fg in self.frame_groups],
            "created_at": self.created_at,
            "updated_at": self.updated_at,
            "sessions": sessions,
        }


@dataclass
class Session:
    """一次連線的**顯示協商**。工作狀態在 `case`；這裡的東西重新協商就有。"""

    session_id: str
    case: Case
    tier_decision: TierDecision
    display_grid: DisplayGrid
    grid_notes: dict[str, Any]
    user: str = "anonymous"
    """誰開的。同一個人重開同一個病例會換掉自己的舊 session；別人的不動。"""
    layer_overrides: dict[str, dict[str, Any]] = field(default_factory=dict)
    """驅動腳本與前端對圖層的覆寫（visible / opacity / renderStyle / order）。"""
    created_at: str = field(default_factory=_now_iso)
    connections: int = 0
    """目前開著的 WS 連線數（presence）。"""
    disconnected_at: str | None = None
    """最後一條 WS 斷掉的時間；沒有連線且超過 `SESSION_IDLE_SECONDS` 就會被清。"""
    editing: str | None = None
    """presence：正在編輯哪個結構（前端在編輯工具作用中時回報；None ＝ 沒在編輯）。不持久化。"""

    @property
    def last_client_seq(self) -> dict[tuple[StructureKey, str], int]:
        return self.case.last_client_seq

    # ── 委派給 Case（讓路由層不必改）───────────────────────────────────────

    @property
    def dataset(self) -> Dataset:
        return self.case.dataset

    @property
    def source(self) -> str:
        return self.case.source

    @property
    def mask_grid(self) -> MaskGrid:
        return self.case.mask_grid

    @property
    def mask_grids(self) -> dict[str, MaskGrid]:
        return self.case.mask_grids

    @property
    def frame_groups(self) -> tuple[FrameGroup, ...]:
        return self.case.frame_groups

    @frame_groups.setter
    def frame_groups(self, value: tuple[FrameGroup, ...]) -> None:
        self.case.frame_groups = value
        self.case.touch()

    @property
    def temporal_groups(self) -> tuple[TemporalGroup, ...]:
        return self.case.temporal_groups

    @property
    def structures(self) -> dict[StructureKey, StructureState]:
        return self.case.structures

    @property
    def transforms(self) -> dict[str, dict[str, Any]]:
        return self.case.transforms

    @property
    def jobs(self) -> dict[str, dict[str, Any]]:
        return self.case.jobs

    @property
    def review_notes(self) -> list[dict[str, Any]]:
        return self.case.review_events

    @property
    def review_events(self) -> list[dict[str, Any]]:
        return self.case.review_events

    @property
    def measurements(self) -> dict[str, dict[str, Any]]:
        return self.case.measurements

    def grid_for_frame(self, frame_of_reference_uid: str) -> Grid:
        return self.case.grid_for_frame(frame_of_reference_uid)

    def mask_grid_for(self, frame_of_reference_uid: str) -> MaskGrid:
        return self.case.mask_grid_for(frame_of_reference_uid)

    def mask_grid_of_structure(self, structure_id: str, frame_index: int | None = None) -> MaskGrid:
        return self.case.mask_grid_of_structure(structure_id, frame_index)

    def structure(self, structure_id: str, frame_index: int | None = None) -> StructureState:
        return self.case.structure(structure_id, frame_index)

    def structure_list(self) -> list[dict[str, Any]]:
        # 這個 session 的人看不到別人的暫存集（layers()／scene_push 都經這裡，所以推送也自然過濾）
        return self.case.structure_list(user=self.user if self.user != "anonymous" else None)

    def apply_edit(self, **kwargs: Any) -> StructureState:
        return self.case.apply_edit(last_client_seq=self.case.last_client_seq, **kwargs)

    # ── 網格 ────────────────────────────────────────────────────────────────

    @property
    def grid_set(self) -> GridSet:
        return GridSet(
            display_grid=self.display_grid,
            mask_grid=self.mask_grid,
            frame_groups=self.frame_groups,
            temporal_groups=self.temporal_groups,
            assigned_tier=self.tier_decision.assigned,
            mask_grids=tuple(self.mask_grids.values()) or (self.mask_grid,),
        )

    # ── 圖層 ────────────────────────────────────────────────────────

    def layers(self) -> list[dict[str, Any]]:
        """`scene.replace` 推送用的圖層清單。

        image 依 `order` 由下往上；mask 恆在所有 image 之上——**但這個順序由
        `zBand` 以資料表達，這裡只給初始 order**。
        """
        out: list[dict[str, Any]] = []
        # 攤開的時間軸（`temporal_views[key] == "expanded"`）→ 每一幀一個影像圖層（固定那一幀）
        views = (self.case.selection or {}).get("temporal_views") or {}
        for n, s in enumerate(self.dataset.series):
            if s.kind == "image" and s.temporal_group_id and views.get(s.temporal_group_id) == "expanded":
                out.extend(self._frame_layers(s, n))
                continue
            if s.kind == "dose":
                # 別人的劑量運算暫存結果看不到（跟暫存結構集同一個規則）
                if self.case.is_derived_dose_of_other(s.series_id, self.user if self.user != "anonymous" else None):
                    continue
                out.append(self._dose_layer(s, n))
                continue
            out.append(
                {
                    "layerId": f"image:{s.series_id}",
                    "kind": "image",
                    "label": _series_label(s),
                    "groupId": "images",
                    "frameOfReferenceUid": s.frame_of_reference_uid,
                    "contentRef": s.series_id,
                    # 🔴 體素值的單位由模態導出。先前模態只存在於
                    # `label` 字串裡，而從字串解析單位是一個等著發生的臨床錯誤
                    # （在 MR 上標 HU）。
                    "modality": s.modality,
                    # 次要影像預設**隱藏**：兩個 CBCT 各以 0.5 疊上去，計畫 CT 只剩 25%
                    # 亮度，畫面一片暗；由使用者在資料面板逐一打開比較（Slicer 也是一次一個前景）
                    "visible": s.role == "primary",
                    "opacity": 1.0 if s.role == "primary" else 0.5,
                    "order": n,
                    "windowLevel": {"center": s.default_window[0], "width": s.default_window[1]},
                    "blendMode": "normal",
                    "temporalGroupId": s.temporal_group_id,
                    # 給左側面板看的序列描述；camelCase 化在前端 wire.ts
                    "seriesMeta": dict(s.meta) if s.meta else None,
                    # 值的單位與比例（PET：SUV、存 ×100）；CT／MR 沒有
                    **({"params": dict(s.params)} if s.params else {}),
                }
            )
        for n, entry in enumerate(self.structure_list()):
            out.append(
                {
                    "layerId": f"mask:{entry['structure_id']}",
                    "kind": "mask",
                    "label": entry["name"],
                    # 有來源結構集就以它分群（`rs:<set id>`）；`structures` 仍是「全部結構」的群
                    "groupId": f"rs:{entry['structure_set_id']}" if entry.get("structure_set_id") else "structures",
                    "frameOfReferenceUid": entry["frame_of_reference_uid"],
                    "contentRef": entry["structure_id"],
                    "visible": entry["default_visible"],
                    "opacity": 1.0,
                    "order": 100 + n,
                    # outline 是預設且主要的模式
                    "renderStyle": "outline",
                    "color": entry["color_rgb"],
                    "temporalGroupId": entry["temporal_group_id"],
                    "frames": entry["frames"],
                }
            )
        for n, (measurement_id, m) in enumerate(self.measurements.items()):
            out.append(
                {
                    "layerId": f"measurement:{measurement_id}",
                    "kind": "measurement",
                    "label": m.get("label") or measurement_id,
                    "groupId": "measurements",
                    "frameOfReferenceUid": m["frameOfReferenceUid"],
                    "contentRef": measurement_id,
                    "visible": True,
                    "opacity": 1.0,
                    "order": 1000 + n,
                    "measurement": m,
                }
            )
        for layer in out:
            patch = self.layer_overrides.get(layer["layerId"])
            if patch is None and layer.get("frameIndex") is None:
                # 攤開的每一幀共用同一個 contentRef —— 只認自己的 layerId，不然改一幀全部跟著變
                patch = self.layer_overrides.get(str(layer["contentRef"]))
            if patch:
                layer.update(patch)
        return out

    def _frame_layers(self, s: Any, n: int) -> list[dict[str, Any]]:
        """時間軸攤開成每一幀一張影像 —— 同一個序列（`contentRef`）、固定 `frameIndex`、仍帶 `temporalGroupId`
        （結構跟著作用中的那一幀）。預設跟拆開的多張影像一樣：第一幀顯示，其他隱藏、不透明度 0.5。"""
        tg = next((g for g in self.temporal_groups if g.temporal_group_id == s.temporal_group_id), None)
        count = (tg.frame_count if tg is not None else None) or 1
        labels = list(tg.frame_labels) if tg is not None and tg.frame_labels else [f"#{k + 1}" for k in range(count)]
        base = _series_label(s)
        primary = s.role == "primary"
        # 🔴 `temporal`（每一幀的時間／標籤清單）不要每一張都帶一份：62 幀的 DCE 每張 5 KB → scene.replace
        # 385 KB 超過推送上限，攤開後畫面不會更新、重新整理後整片黑（2026-10-06 CCTH-A06）。
        # 每一張自己的幀已經在 frameIndex／frameLabel。
        meta = {k: v for k, v in s.meta.items() if k != "temporal"} if s.meta else None
        return [
            {
                "layerId": f"image:{s.series_id}#f{k}",
                "kind": "image",
                "label": f"{base} · {labels[k]}",
                "groupId": "images",
                "frameOfReferenceUid": s.frame_of_reference_uid,
                "contentRef": s.series_id,
                "modality": s.modality,
                "visible": primary and k == 0,
                "opacity": 1.0 if primary and k == 0 else 0.5,
                "order": n + k / 1000,
                "windowLevel": {"center": s.default_window[0], "width": s.default_window[1]},
                "blendMode": "normal",
                "temporalGroupId": s.temporal_group_id,
                "frameIndex": k,
                "frameLabel": labels[k],
                "seriesMeta": dict(meta) if meta else None,
                **({"params": dict(s.params)} if s.params else {}),
            }
            for k in range(count)
        ]

    def _dose_layer(self, s: Any, n: int) -> dict[str, Any]:
        """劑量是 F1 純量場的一個實例：自己的網格、借用同 FoR 影像的 FrameGroup。

        `params` 是模組專屬參數的落點：核心不認識 `max_gy`，只有 `dose`
        renderer 認識。前端 `params` 用 snake_case 原樣傳遞。
        """
        return {
            "layerId": f"dose:{s.series_id}",
            "kind": "dose",
            "label": _series_label(s),
            "groupId": "dose",
            "frameOfReferenceUid": s.frame_of_reference_uid,
            "contentRef": s.series_id,
            "modality": s.modality,
            # 預設只顯示 primary 的劑量：三個分次劑量全開會把整個骨盆塗成一片藍。
            # 射束劑量也預設隱藏（N 個射束各一層 colorwash 疊在一起，看計畫劑量或合成結果）
            "visible": s.role == "primary" and str((s.params or {}).get("summation_type") or "").upper() != "BEAM",
            "opacity": 0.6,
            # image 在 0–9、dose 在 50–99、mask 從 100 起 —— 只是初始 order，
            # 真正的疊放順序由 renderer 的 zBand 決定
            "order": 50 + n,
            "blendMode": "normal",
            "temporalGroupId": s.temporal_group_id,
            "seriesMeta": dict(s.meta) if s.meta else None,
            "params": dict(s.params),
        }

    def scene_push(self) -> dict[str, Any]:
        """`scene.replace` 的 payload：`{ displayGrid, frameGroups, layers[] }`。

        🔴 **刻意不含結構清單。** 結構清單走 `GET /structures`；把它塞進
        推送會讓訊息大小隨結構數線性成長 —— 真實案例的 85 個 ROI 就是 80 KB，
        182 個會到 170 KB。「推送只送 metadata」不等於「所有 metadata 都推」。
        """
        return {
            "sessionId": self.session_id,
            "caseId": self.case.case_id,
            "user": self.user,
            # 🔴 `studyId` 必須在**同一個回應**裡。
            #
            # 少了它，前端只能另外打 `_test/sessions` 再挑一個 —— 而 store 會
            # 同時保留不同 study 的 session，於是「挑第一個」與「當前這個」不是
            # 同一個東西。症狀是拿 A 的 studyId 去 POST /grids、卻拿 B 的 series
            # 去抓影像，換來一個 409 I3。**這是實際踩過的 bug。**
            "studyId": self.dataset.study_id,
            "source": self.source,
            "gridSet": self.grid_set.to_wire(),
            "tier": self.tier_decision.to_wire(),
            "gridNotes": self.grid_notes,
            "layers": self.layers(),
            "structureCount": len({sid for sid, _ in self.structures}),
            # 2026-09-24：library 病例才有結構集規則（假體沒有）—— 前端據此顯示結構區與「＋ 新結構集」，
            # 不再用「至少有一套」推斷（沒有 RS 或唯一那套是空的時候整個結構區會消失）
            "usesStructureSets": self.case.uses_structure_sets,
            # 結構集清單（幾筆而已；結構清單本身仍走 GET /structures）
            "structureSets": [
                self.case.structure_set_wire(s, self.user)
                for s in self.case.structure_sets
                if not self.case.is_transient_of_other(s["structure_set_id"], self.user)
            ],
        }

    def scene(self) -> dict[str, Any]:
        """完整場景 —— 只走 HTTP（`_test/load`、`_test/state`），供斷言。"""
        return {
            **self.scene_push(),
            "structures": self.structure_list(),
            "measurements": self.measurements,
            "layerOverrides": self.layer_overrides,
        }


def _series_label(s: Any) -> str:
    """UI 標籤：有 DICOM 描述就用它，沒有就退回「模態（主／次）」。"""
    desc = str(s.meta.get("series_description") or "").strip() if s.meta else ""
    date = str(s.meta.get("series_date") or "").strip() if s.meta else ""
    role = "（主）" if s.role == "primary" else "（次）"
    if desc or date:
        return " ".join(x for x in (s.modality, date, desc) if x)
    return f"{s.modality} {role}"


def build_case(
    *,
    dataset: Dataset,
    source: str = "",
    selection_hash: str | None = None,
    case_id: str | None = None,
    selection: dict[str, Any] | None = None,
    keep_mask_grids: dict[str, MaskGrid] | None = None,
) -> Case:
    """建立 Case：每個 FrameGroup 一個 MaskGrid、FrameGroup、體素化所有結構。與 Tier／DisplayGrid 無關。

    `keep_mask_grids`（原地重組）：這些 FoR 沿用原本的 MaskGrid —— 結構的區塊是畫在它上面的；
    組成／拆開時間軸會改變「這個 FoR 排第一的影像」，照預設重選就會換一個網格，結構整個錯位。"""
    primary = dataset.primary
    images = dataset.image_series
    # 每個 FrameGroup（＝每個影像序列的 FoR）一個 MaskGrid
    # 同一個 FoR 有好幾組影像（4D 組 ＋ AVG／MIP、自由呼吸的掃描）→ 用排在前面的（primary 在最前面），
    # 跟 `Dataset.image_series_for` 一致；以前是最後一組蓋掉前面的
    mask_grids: dict[str, MaskGrid] = {
        uid: mg for uid, mg in (keep_mask_grids or {}).items() if any(s.frame_of_reference_uid == uid for s in images)
    }
    for s in images:
        mask_grids.setdefault(s.frame_of_reference_uid, MaskGrid.of(s.grid))
    mask_grid = mask_grids[primary.frame_of_reference_uid]
    frame_groups = tuple(
        FrameGroup.primary_of(
            s.frame_of_reference_uid, s.series_id, mask_grid_id=mask_grids[s.frame_of_reference_uid].mask_grid_id
        )
        if s.role == "primary"
        else FrameGroup.secondary_rigid(
            s.frame_of_reference_uid,
            s.series_id,
            np.asarray(s.transform_to_primary, dtype=np.float64).reshape(4, 4) if s.transform_to_primary else np.eye(4),
            mask_grid_id=mask_grids[s.frame_of_reference_uid].mask_grid_id,
            registration=s.registration,
        )
        for s in images
    )
    case = Case(
        case_id=case_id or f"case_{uuid.uuid4().hex[:12]}",
        dataset=dataset,
        mask_grid=mask_grid,
        frame_groups=frame_groups,
        temporal_groups=dataset.temporal_groups,
        mask_grids=mask_grids,
        source=source,
        selection_hash=selection_hash,
        selection=dict(selection or {}),
        structure_sets=[dict(s) for s in dataset.structure_sets],
    )
    for st in dataset.structures:
        frames: list[int | None] = [None]
        if st.temporal_group_id is not None:
            tg = next(g for g in dataset.temporal_groups if g.temporal_group_id == st.temporal_group_id)
            frames = list(range(tg.frame_count or 1)) if st.frame_index is None else [st.frame_index]
        for fi in frames:
            block = phantoms.mask_block(dataset, st, frame_index=fi)
            if block is None:
                continue
            offset, size, data = block
            raw = np.ascontiguousarray(data, dtype=np.uint8)
            case.structures[(st.structure_id, fi)] = StructureState(
                structure_id=st.structure_id,
                name=st.name,
                color_rgb=st.color_rgb,
                frame_of_reference_uid=st.frame_of_reference_uid,
                offset_ijk=offset,
                size_ijk=size,
                block=raw,
                content_hash=payload_content_hash(offset_ijk=offset, size_ijk=size, data=raw.tobytes(), prefix="mh_"),
                # 🔴 沿用結構自己宣告的來源，**不要硬寫 "model"**。
                # 硬寫的後果是臨床醫師畫的 RTSTRUCT 在追溯鏈上被記成模型產生的
                # ——那是方向性錯誤，不是精度問題。
                provenance=Provenance(source=st.provenance_source, module_version=MODULE_VERSION),
                status=st.status,
                tg263_code=st.tg263_code,
                interpreted_type=getattr(st, "interpreted_type", None),
                default_visible=st.default_visible,
                temporal_group_id=st.temporal_group_id,
                frame_index=fi,
                structure_set_id=st.structure_set_id,
            )
    return case


def rebuild_case(
    *,
    dataset: Dataset,
    case_id: str,
    source: str,
    selection_hash: str | None,
    selection: dict[str, Any],
    frame_groups: list[dict[str, Any]],
    structures: dict[StructureKey, StructureState],
    review_events: list[dict[str, Any]],
    transforms: dict[str, dict[str, Any]],
    measurements: dict[str, dict[str, Any]],
    created_at: str,
    updated_at: str,
    structure_sets: list[dict[str, Any]] | None = None,
    keep_mask_grids: dict[str, MaskGrid] | None = None,
) -> Case:
    """從持久層重組 Case：資料集（影像網格）由 library 重新組；結構、版本、簽核、量測、transform 用 DB 的。

    FrameGroup 以 DB 的為準（含提交過的手動對位）；DB 沒有的 FoR 退回重算的。
    `structure_sets`：DB 裡的**工作集**；匯入集由資料集重組。
    """
    fresh = build_case(
        dataset=dataset,
        source=source,
        selection_hash=selection_hash,
        case_id=case_id,
        selection=selection,
        keep_mask_grids=keep_mask_grids,
    )
    saved = {fg["frame_of_reference_uid"]: FrameGroup.from_wire(fg) for fg in frame_groups}
    # DB 一個 FoR 一列，同一個 FoR 的每組影像都套它的對位，但保留自己的 series_id；
    # 角色不同（存的是 primary、這組是同 FoR 的次要影像）→ 用重算的（同一個 FoR 本來就是單位矩陣）
    fresh.frame_groups = tuple(
        replace(saved_fg, series_id=fg.series_id)
        if (saved_fg := saved.get(fg.frame_of_reference_uid)) is not None and saved_fg.role == fg.role
        else fg
        for fg in fresh.frame_groups
    )
    # migration 0008 之前存的結構沒有 structure_set_id → 從重新載入的 RS 補回（同 structure_id）。
    # 🔴 沒補的話整個病例的 ROI 都落到「其他」，看起來就像沒分層（實際踩過）。
    from_rs = {sid: st.structure_set_id for (sid, _), st in fresh.structures.items() if st.structure_set_id}
    for (sid, _), st in structures.items():
        if st.structure_set_id is None and sid in from_rs:
            st.structure_set_id = from_rs[sid]
    # DB 的工作集
    known = {s["structure_set_id"] for s in fresh.structure_sets}
    for ws in structure_sets or []:
        if ws["structure_set_id"] not in known:
            fresh.structure_sets.append(dict(ws))
            known.add(ws["structure_set_id"])
    fresh.structures = dict(structures)
    # 過渡：匯入集裡已經改過的結構（第二版以上）搬進改動者的工作集；沒改過的留在匯入集（唯讀）
    for st in fresh.structures.values():
        s = fresh.structure_set(st.structure_set_id)
        if s is not None and s.get("kind", "import") == "import" and len(st.versions) > 1:
            who = st.updated_by if st.updated_by not in ("", "anonymous") else st.versions[-1].created_by
            ws = fresh.work_set_for(who or "anonymous", st.frame_of_reference_uid)
            st.structure_set_id = ws["structure_set_id"] if ws else st.structure_set_id
    fresh.review_events = list(review_events)
    fresh.transforms = dict(transforms)
    fresh.measurements = dict(measurements)
    fresh.created_at = created_at
    fresh.updated_at = updated_at
    return fresh


def build_session(
    *,
    dataset: Dataset | None = None,
    capability: ClientCapability,
    manual_tier: Tier | None = None,
    session_id: str | None = None,
    source: str = "",
    case: Case | None = None,
    user: str = "anonymous",
) -> Session:
    """建立 Session：決定 Tier、決定顯示網格。

    給 `case` ＝ 對既有病例重新協商（`POST /grids`）——結構、量測、transform **原地保留**，不再抄欄位；
    給 `phantom` ＝ 順手建一個新 Case（假體載入、測試）。
    """
    if case is None:
        if dataset is None:
            raise ValueError("build_session 需要 phantom 或 case")
        case = build_case(dataset=dataset, source=source)
    decision = decide_tier(capability, manual_override=manual_tier)
    primary = case.dataset.primary
    images = case.dataset.image_series
    others = [s.grid for s in images if s.role != "primary"]
    # 劑量網格不參與 display grid 的降採樣決策，但它的常駐位元組要算進預算
    dose_bytes = sum(s.grid.voxel_count * 4 for s in case.dataset.series if s.kind == "dose")
    display_grid, notes = display_grid_for(
        primary.grid, others, tier=decision.assigned, cap=capability, extra_resident_bytes=dose_bytes
    )
    return Session(
        session_id=session_id or f"sess_{uuid.uuid4().hex[:12]}",
        case=case,
        tier_decision=decision,
        display_grid=display_grid,
        grid_notes=notes,
        user=user,
    )


# `SessionStore` 搬到 session_store.py（它需要上面的 Case／Session，所以放最後再匯出）
from .session_store import SessionStore  # noqa: E402

__all__ = [
    "MAX_VERSIONS_IN_MEMORY",
    "MODULE_VERSION",
    "SESSION_IDLE_SECONDS",
    "Case",
    "ConflictError",
    "Session",
    "SessionStore",
    "StructureKey",
    "StructureState",
    "StructureVersion",
    "VersionKind",
    "build_case",
    "build_session",
    "rebuild_case",
]
