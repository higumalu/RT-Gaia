"""`CaseStore` —— 病例工作狀態的持久層。

**寫入策略：write-through 快照。** 記憶體裡的 `Case` 仍是執行期的真相；每個會改狀態的請求結束時
`persist(case)` 把整個 Case 的 meta 整批 upsert（結構列、FrameGroup、transform、量測），版本與簽核事件
只補**還沒寫過的**（append-only；以 version_id／event_id 判斷）。版本的體素進 blob store（key ＝ `content_hash`）。
數百個結構、數十版一次幾十毫秒；比逐端點手寫增量正確性便宜得多。

**讀取**：`load(case_id)` 回 `LoadedCase`（純資料）；由 `state.rebuild_case()` 配上資料集（影像網格由 library
重新組）變成活的 `Case`。只有 `selection_hash` 不為空的病例（`POST /sessions` 建的）會持久化 —— 假體是測試替身。

🔴 **「已存過」的快取只能在 commit 之後更新**。先前在交易內、commit 前就把新的
version_id／event_id 加進 `_persisted_*`；後段 SQL 或 commit 失敗時 DB 回滾、集合沒回滾，重試便判定
「已存在」而**永久漏寫** —— 在真 Postgres 上重現過：重試回報 versions=0、events=0，DB 各 0 筆。
現在：交易內只讀快取；成功出了 `begin()` 才 update；失敗就把該病例的快取整個丟掉（下次重讀 DB）。
第二層：版本／事件的 insert 用 `ON CONFLICT DO NOTHING` —— 快取判斷失準（多行程、重啟）時重試也不會
`UniqueViolation` 整批炸掉；version_id 唯一、內容 content-addressed，重複寫入語意上本來就該無害。
"""

from __future__ import annotations

import logging
from dataclasses import dataclass, field
from typing import Any

import numpy as np
from rtgaia_core.blobs import BlobStore
from rtgaia_core.state import Case, StructureState, StructureVersion
from sqlalchemy import delete, select
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.ext.asyncio import AsyncEngine, async_sessionmaker

from .models import (
    CaseFrameGroupRow,
    CaseMeasurementRow,
    CaseRow,
    CaseTransformRow,
    JobRow,
    ReviewEventRow,
    StructureRow,
    StructureSetRow,
    StructureVersionRow,
    StudyRow,
)

log = logging.getLogger(__name__)


def _fk(frame_index: int | None) -> int:
    return -1 if frame_index is None else int(frame_index)


def _fi(frame_key: int) -> int | None:
    return None if frame_key < 0 else int(frame_key)


@dataclass
class LoadedCase:
    case: dict[str, Any]
    frame_groups: list[dict[str, Any]]
    structures: list[dict[str, Any]]
    versions: dict[tuple[str, int], list[dict[str, Any]]] = field(default_factory=dict)
    review_events: list[dict[str, Any]] = field(default_factory=list)
    transforms: dict[str, dict[str, Any]] = field(default_factory=dict)
    measurements: dict[str, dict[str, Any]] = field(default_factory=dict)
    structure_sets: list[dict[str, Any]] = field(default_factory=list)
    """工作集。"""
    retired_structure_ids: list[str] = field(default_factory=list)
    """已刪除（暫存區／封存區）的結構 id。"""


class CaseStore:
    def __init__(self, engine: AsyncEngine, blobs: BlobStore) -> None:
        self.sessions = async_sessionmaker(engine, expire_on_commit=False)
        self.blobs = blobs
        self._persisted_versions: dict[str, set[str]] = {}
        self._persisted_events: dict[str, set[str]] = {}

    # ── 寫 ─────────────────────────────────────────────────────────────────

    async def _known(self, s: Any, case_id: str) -> tuple[set[str], set[str]]:
        if case_id not in self._persisted_versions:
            vids = (
                (await s.execute(select(StructureVersionRow.version_id).where(StructureVersionRow.case_id == case_id)))
                .scalars()
                .all()
            )
            eids = (
                (await s.execute(select(ReviewEventRow.event_id).where(ReviewEventRow.case_id == case_id)))
                .scalars()
                .all()
            )
            self._persisted_versions[case_id] = set(vids)
            self._persisted_events[case_id] = set(eids)
        return self._persisted_versions[case_id], self._persisted_events[case_id]

    async def persist(self, case: Case, *, created_by: str = "") -> dict[str, int]:
        """整批 upsert。回傳這次新寫了多少版本／事件（測試與 healthz 用）。"""
        if case.selection_hash is None:
            return {"versions": 0, "events": 0}
        new_versions = 0
        new_events = 0
        new_v_ids: list[str] = []  # 本次要寫的；只在 commit 成功後才進快取
        new_e_ids: list[str] = []
        try:
            async with self.sessions() as s:
                async with s.begin():
                    new_versions, new_events = await self._persist_tx(s, case, created_by, new_v_ids, new_e_ids)
        except BaseException:
            # 交易失敗：不知道哪些寫成功了（都沒有），也不猜 —— 快取失效，下一次 persist 重讀 DB
            self._persisted_versions.pop(case.case_id, None)
            self._persisted_events.pop(case.case_id, None)
            raise
        self._persisted_versions.setdefault(case.case_id, set()).update(new_v_ids)
        self._persisted_events.setdefault(case.case_id, set()).update(new_e_ids)
        return {"versions": new_versions, "events": new_events}

    async def _persist_tx(
        self, s: Any, case: Case, created_by: str, new_v_ids: list[str], new_e_ids: list[str]
    ) -> tuple[int, int]:
        """交易本體。**不碰 `_persisted_*`**（只讀），新 ID 回填到呼叫者的 list。回傳實際 insert 的筆數。"""
        known_v, known_e = await self._known(s, case.case_id)
        seen_v: set[str] = set()  # 同一批內重複（同一版本出現在兩個 frame 的鏡射）也只寫一次
        seen_e: set[str] = set()
        stmt = insert(CaseRow).values(
            case_id=case.case_id,
            study_id=case.study_id,
            source=case.source,
            selection_hash=case.selection_hash,
            selection=case.selection,
            description=case.dataset.description,
            created_by=created_by,
            created_at=case.created_at,
            updated_at=case.updated_at,
        )
        await s.execute(
            stmt.on_conflict_do_update(
                index_elements=[CaseRow.case_id],
                # 檢視器裡組成／拆開／攤開時間軸會改選取（同一個病例原地重組）
                # → 選取與描述一起更新，重啟後照新選取重組
                set_={
                    "updated_at": stmt.excluded.updated_at,
                    "source": stmt.excluded.source,
                    "selection": stmt.excluded.selection,
                    "description": stmt.excluded.description,
                },
            )
        )
        # 工作集：整批換；匯入集不存
        # 刪除的結構要記得它原本在哪一套（工作集整批重寫，刪掉的集下一行就不在了）
        prev_set_labels = {
            r.structure_set_id: r.label
            for r in (await s.execute(select(StructureSetRow).where(StructureSetRow.case_id == case.case_id))).scalars()
        }
        await s.execute(delete(StructureSetRow).where(StructureSetRow.case_id == case.case_id))
        work_sets = [ws for ws in case.structure_sets if ws.get("kind") == "work"]
        if work_sets:
            await s.execute(
                insert(StructureSetRow).values(
                    [
                        {
                            "case_id": case.case_id,
                            "structure_set_id": ws["structure_set_id"],
                            "kind": "work",
                            "label": ws.get("label", ""),
                            "owner": ws.get("owner", ""),
                            "frame_of_reference_uid": ws.get("frame_of_reference_uid", ""),
                            "image_series_uid": ws.get("image_series_uid") or "",
                            "image_label": ws.get("image_label", ""),
                            "created_at": ws.get("created_at") or case.updated_at,
                            "description": ws.get("description") or "",
                        }
                        for ws in work_sets
                    ]
                )
            )
        # FrameGroup：整批換（提交對位會改）
        await s.execute(delete(CaseFrameGroupRow).where(CaseFrameGroupRow.case_id == case.case_id))
        # 一個 FoR 一列（對位是以 FoR 為單位）。同一個 FoR 可以有好幾組影像（4D 組 ＋ AVG／MIP、
        # CT ＋ 同 FoR 的另一組）—— 以前每組各一列 → 主鍵 (case, FoR) UniqueViolation，開發庫上開 4DCT 500。
        # primary 那組優先
        per_for: dict[str, Any] = {}
        for fg in case.frame_groups:
            if fg.frame_of_reference_uid not in per_for or fg.role == "primary":
                per_for[fg.frame_of_reference_uid] = fg
        if per_for:
            await s.execute(
                insert(CaseFrameGroupRow).values(
                    [
                        {
                            "case_id": case.case_id,
                            "frame_of_reference_uid": for_uid,
                            "frame_group": fg.to_wire(),
                        }
                        for for_uid, fg in per_for.items()
                    ]
                )
            )
        # 結構 meta：upsert；記憶體裡沒有的（被刪的）標 deleted_at
        live_keys: set[tuple[str, int]] = set()
        rows = []
        version_rows = []
        transient_ids = {s["structure_set_id"] for s in case.structure_sets if s.get("kind") == "transient"}
        for st in case.structures.values():
            if st.structure_set_id in transient_ids:
                continue  # 暫存的 plugin 結果不進 DB（保存後才會換成工作集）
            fk = _fk(st.frame_index)
            live_keys.add((st.structure_id, fk))
            rows.append(
                {
                    "case_id": case.case_id,
                    "structure_id": st.structure_id,
                    "frame_key": fk,
                    "name": st.name,
                    "color_rgb": list(st.color_rgb),
                    "frame_of_reference_uid": st.frame_of_reference_uid,
                    "tg263_code": st.tg263_code,
                    "interpreted_type": st.interpreted_type,
                    "status": st.status,
                    "default_visible": st.default_visible,
                    "temporal_group_id": st.temporal_group_id,
                    "structure_set_id": st.structure_set_id,
                    "head_version_id": st.head.version_id,
                    "created_by": st.created_by,
                    "updated_by": st.updated_by,
                    "updated_at": st.updated_at,
                    "deleted_at": None,
                }
            )
            for v in st.versions:
                if v.version_id in known_v or v.version_id in seen_v:
                    continue
                seen_v.add(v.version_id)
                self.blobs.put(np.ascontiguousarray(v.block, dtype=np.uint8).tobytes(), key=v.content_hash)
                version_rows.append(
                    {
                        "version_id": v.version_id,
                        "case_id": case.case_id,
                        "structure_id": st.structure_id,
                        "frame_key": fk,
                        "seq": v.seq,
                        "parent_version_id": v.parent_version_id,
                        "kind": v.kind,
                        "content_hash": v.content_hash,
                        "offset_ijk": list(v.offset_ijk),
                        "size_ijk": list(v.size_ijk),
                        "voxel_count": v.voxel_count,
                        "provenance": v.provenance.to_wire(),
                        "created_by": v.created_by,
                        "created_at": v.created_at,
                        "client_id": v.client_id,
                        "client_seq": v.client_seq,
                        "note": v.note,
                    }
                )
                new_v_ids.append(v.version_id)
        for chunk in _chunks(rows, 500):
            st_stmt = insert(StructureRow).values(chunk)
            await s.execute(
                st_stmt.on_conflict_do_update(
                    index_elements=[StructureRow.case_id, StructureRow.structure_id, StructureRow.frame_key],
                    set_={
                        c: getattr(st_stmt.excluded, c)
                        for c in (
                            "name",
                            "color_rgb",
                            "tg263_code",
                            "interpreted_type",
                            "status",
                            "default_visible",
                            "structure_set_id",
                            "head_version_id",
                            "updated_by",
                            "updated_at",
                            "deleted_at",
                        )
                    },
                )
            )
        existing = (
            await s.execute(
                select(StructureRow.structure_id, StructureRow.frame_key).where(
                    StructureRow.case_id == case.case_id, StructureRow.deleted_at.is_(None)
                )
            )
        ).all()
        # 刪除當下的狀態以「刪除」簽核事件的 from_status 為準（DB 列的 status 可能還沒追上）
        # 刪除人也從事件取：刪除路由經 `push_case` 持久化時不帶操作者
        status_at_delete: dict[str, str] = {}
        deleter: dict[str, str] = {}
        for ev in case.review_events:
            if ev.get("to_status") == "deleted":
                status_at_delete[str(ev.get("structure_id"))] = str(ev.get("from_status") or "")
                deleter[str(ev.get("structure_id"))] = str(ev.get("user") or "")
        for sid, fk in existing:
            if (sid, fk) not in live_keys:
                row = await s.get(StructureRow, (case.case_id, sid, fk))
                if row is not None:
                    row.deleted_at = case.updated_at
                    row.deleted_by = deleter.get(sid) or created_by or row.updated_by
                    live_set = case.structure_set(row.structure_set_id)
                    row.deleted_set_label = (live_set or {}).get("label") or prev_set_labels.get(
                        row.structure_set_id or "", row.structure_set_id or ""
                    )
                    if status_at_delete.get(sid, row.status) == "approved":
                        row.archived_at = row.deleted_at  # 已簽核 → 封存區（不自動清）
        new_versions = 0
        for chunk in _chunks(version_rows, 500):
            r = await s.execute(
                insert(StructureVersionRow).values(chunk).on_conflict_do_nothing(index_elements=["version_id"])
            )
            new_versions += int(r.rowcount or 0)
        # 簽核事件：只補新的
        ev_rows = []
        for seq, ev in enumerate(case.review_events):
            if ev["event_id"] in known_e or ev["event_id"] in seen_e:
                continue
            seen_e.add(ev["event_id"])
            ev_rows.append({"event_id": ev["event_id"], "case_id": case.case_id, "seq": seq, "event": ev})
            new_e_ids.append(ev["event_id"])
        new_events = 0
        for chunk in _chunks(ev_rows, 500):
            r = await s.execute(
                insert(ReviewEventRow).values(chunk).on_conflict_do_nothing(index_elements=["event_id"])
            )
            new_events += int(r.rowcount or 0)
        # transform／量測：整批換（少量）
        await s.execute(delete(CaseTransformRow).where(CaseTransformRow.case_id == case.case_id))
        if case.transforms:
            await s.execute(
                insert(CaseTransformRow).values(
                    [{"case_id": case.case_id, "transform_id": k, "spec": v} for k, v in case.transforms.items()]
                )
            )
        await s.execute(delete(CaseMeasurementRow).where(CaseMeasurementRow.case_id == case.case_id))
        if case.measurements:
            await s.execute(
                insert(CaseMeasurementRow).values(
                    [{"case_id": case.case_id, "measurement_id": k, "body": v} for k, v in case.measurements.items()]
                )
            )
        return new_versions, new_events

    # ── 讀 ─────────────────────────────────────────────────────────────────

    async def list(self) -> list[dict[str, Any]]:
        async with self.sessions() as s:
            rows = (await s.execute(select(CaseRow).order_by(CaseRow.updated_at.desc()))).scalars().all()
            out = []
            for r in rows:
                n_struct = (
                    await s.execute(
                        select(StructureRow.structure_id)
                        .where(StructureRow.case_id == r.case_id, StructureRow.deleted_at.is_(None))
                        .distinct()
                    )
                ).all()
                out.append({**_case_dict(r), "structure_count": len(n_struct)})
            return out

    async def worklist_rows(self) -> list[dict[str, Any]]:
        """一趟查出每個病例的結構計數、最近成功匯出、study 的病歷號／日期／描述。"""
        from rtgaia_core.worklist import counts_from_structures
        from sqlalchemy import func

        async with self.sessions() as s:
            cases = (await s.execute(select(CaseRow).order_by(CaseRow.updated_at.desc()))).scalars().all()
            if not cases:
                return []
            ids = [c.case_id for c in cases]
            struct_rows = (
                await s.execute(
                    select(
                        StructureRow.case_id,
                        StructureRow.structure_id,
                        StructureRow.structure_set_id,
                        StructureRow.status,
                    ).where(
                        StructureRow.case_id.in_(ids), StructureRow.deleted_at.is_(None), StructureRow.frame_key <= 0
                    )
                )
            ).all()
            by_case: dict[str, list[tuple[str | None, str]]] = {}
            for case_id, _sid, set_id, status in struct_rows:
                by_case.setdefault(case_id, []).append((set_id, status))
            exports = (
                await s.execute(
                    select(JobRow.case_id, func.max(JobRow.finished_at))
                    .where(JobRow.case_id.in_(ids), JobRow.kind == "export", JobRow.status == "done")
                    .group_by(JobRow.case_id)
                )
            ).all()
            last_export = {case_id: fin for case_id, fin in exports}
            study_uids = sorted({c.study_id for c in cases})
            studies = {
                st.study_uid: st
                for st in (await s.execute(select(StudyRow).where(StudyRow.study_uid.in_(study_uids)))).scalars().all()
            }
            out = []
            for c in cases:
                st = studies.get(c.study_id)
                out.append(
                    {
                        **_case_dict(c),
                        "counts": counts_from_structures(by_case.get(c.case_id, [])),
                        "last_export_at": last_export.get(c.case_id),
                        "patient_id": st.patient_id if st else None,
                        "study_date": st.study_date if st else "",
                        "study_description": st.study_description if st else "",
                    }
                )
            return out

    async def adopt_work_sets(self, new_case_id: str, frame_of_reference_uids: list[str]) -> list[dict[str, Any]]:
        """2026-09-18：工作集跟著**影像（FoR）**走，不綁選取雜湊。

        別的病例（同一組影像、不同選取）裡的工作集 → 搬到這個病例：`structure_set`、`structure`、`structure_version`
        的 `case_id` 改成新的（版本鏈、簽核狀態原樣保留）。回傳搬過來的集（含 `from_case_id`）。
        新病例若已有同 id 的空集就先刪掉；已有同 id 的結構（撞名）則跳過那個集並記在 `skipped`。
        """
        from sqlalchemy import delete, select, update

        from .models import StructureRow, StructureSetRow, StructureVersionRow

        if not frame_of_reference_uids:
            return []
        moved: list[dict[str, Any]] = []
        async with self.sessions() as s:
            rows = (
                (
                    await s.execute(
                        select(StructureSetRow).where(
                            StructureSetRow.kind == "work",
                            StructureSetRow.case_id != new_case_id,
                            StructureSetRow.frame_of_reference_uid.in_(frame_of_reference_uids),
                        )
                    )
                )
                .scalars()
                .all()
            )
            for ws in rows:
                old_case = ws.case_id
                sids = (
                    (
                        await s.execute(
                            select(StructureRow.structure_id).where(
                                StructureRow.case_id == old_case, StructureRow.structure_set_id == ws.structure_set_id
                            )
                        )
                    )
                    .scalars()
                    .all()
                )
                clash = (
                    (
                        await s.execute(
                            select(StructureRow.structure_id).where(
                                StructureRow.case_id == new_case_id, StructureRow.structure_id.in_(sids or [""])
                            )
                        )
                    )
                    .scalars()
                    .all()
                )
                if clash:
                    moved.append(
                        {"structure_set_id": ws.structure_set_id, "from_case_id": old_case, "skipped": sorted(clash)}
                    )
                    continue
                existing = await s.get(StructureSetRow, (new_case_id, ws.structure_set_id))
                if existing is not None:
                    await s.delete(existing)
                    await s.flush()
                values = {c.name: getattr(ws, c.name) for c in StructureSetRow.__table__.columns}
                await s.delete(ws)
                await s.flush()
                values["case_id"] = new_case_id
                s.add(StructureSetRow(**values))
                if sids:
                    await s.execute(
                        update(StructureRow)
                        .where(StructureRow.case_id == old_case, StructureRow.structure_id.in_(sids))
                        .values(case_id=new_case_id)
                    )
                    await s.execute(
                        update(StructureVersionRow)
                        .where(StructureVersionRow.case_id == old_case, StructureVersionRow.structure_id.in_(sids))
                        .values(case_id=new_case_id)
                    )
                    # 版本 cache 是 per case：搬過去的版本在新病例視為「已存」
                    self._persisted_versions.setdefault(new_case_id, set()).update(
                        self._persisted_versions.get(old_case, set())
                    )
                await s.execute(
                    delete(StructureSetRow).where(
                        StructureSetRow.case_id == old_case, StructureSetRow.structure_set_id == ws.structure_set_id
                    )
                )
                moved.append(
                    {
                        "structure_set_id": ws.structure_set_id,
                        "from_case_id": old_case,
                        "structure_ids": list(sids),
                        "owner": ws.owner,
                    }
                )
            await s.commit()
        return moved

    async def find_by_selection(self, selection_hash: str) -> str | None:
        async with self.sessions() as s:
            return (
                await s.execute(select(CaseRow.case_id).where(CaseRow.selection_hash == selection_hash))
            ).scalar_one_or_none()

    async def load(self, case_id: str) -> LoadedCase:
        async with self.sessions() as s:
            r = await s.get(CaseRow, case_id)
            if r is None:
                raise KeyError(f"DB 裡沒有 case {case_id}")
            fgs = (
                (await s.execute(select(CaseFrameGroupRow).where(CaseFrameGroupRow.case_id == case_id))).scalars().all()
            )
            sts = (
                (
                    await s.execute(
                        select(StructureRow).where(StructureRow.case_id == case_id, StructureRow.deleted_at.is_(None))
                    )
                )
                .scalars()
                .all()
            )
            vers = (
                (
                    await s.execute(
                        select(StructureVersionRow)
                        .where(StructureVersionRow.case_id == case_id)
                        .order_by(
                            StructureVersionRow.structure_id, StructureVersionRow.frame_key, StructureVersionRow.seq
                        )
                    )
                )
                .scalars()
                .all()
            )
            evs = (
                (
                    await s.execute(
                        select(ReviewEventRow).where(ReviewEventRow.case_id == case_id).order_by(ReviewEventRow.seq)
                    )
                )
                .scalars()
                .all()
            )
            trs = (await s.execute(select(CaseTransformRow).where(CaseTransformRow.case_id == case_id))).scalars().all()
            sets = (await s.execute(select(StructureSetRow).where(StructureSetRow.case_id == case_id))).scalars().all()
            retired = sorted(
                {
                    sid
                    for (sid,) in (
                        await s.execute(
                            select(StructureRow.structure_id).where(
                                StructureRow.case_id == case_id, StructureRow.deleted_at.is_not(None)
                            )
                        )
                    ).all()
                }
            )
            mss = (
                (await s.execute(select(CaseMeasurementRow).where(CaseMeasurementRow.case_id == case_id)))
                .scalars()
                .all()
            )
        versions: dict[tuple[str, int], list[dict[str, Any]]] = {}
        for v in vers:
            versions.setdefault((v.structure_id, v.frame_key), []).append(_version_dict(v))
        loaded = LoadedCase(
            case=_case_dict(r),
            frame_groups=[fg.frame_group for fg in fgs],
            structures=[_structure_dict(st) for st in sts],
            versions=versions,
            review_events=[e.event for e in evs],
            transforms={t.transform_id: t.spec for t in trs},
            measurements={m.measurement_id: m.body for m in mss},
            structure_sets=[_set_dict(ws) for ws in sets],
            retired_structure_ids=retired,
        )
        self._persisted_versions[case_id] = {v.version_id for v in vers}
        self._persisted_events[case_id] = {e.event_id for e in evs}
        return loaded

    def block(self, version: dict[str, Any]) -> np.ndarray:
        raw = self.blobs.get(str(version["content_hash"]))
        size = version["size_ijk"]
        return np.frombuffer(raw, dtype=np.uint8).reshape(int(size[2]), int(size[1]), int(size[0])).copy()

    async def counts(self) -> dict[str, int]:
        async with self.sessions() as s:
            out = {}
            for name, model in (
                ("cases", CaseRow),
                ("structures", StructureRow),
                ("versions", StructureVersionRow),
                ("review_events", ReviewEventRow),
            ):
                out[name] = len(
                    (
                        await s.execute(select(model.__table__.c[list(model.__table__.primary_key.columns)[0].name]))
                    ).all()
                )
            return out

    # ── 暫存區／封存區 ─────────────────────────────────────────────────────

    async def deleted_items(self, *, archived: bool, deleted_by: str | None = None) -> list[dict[str, Any]]:
        """已刪除的結構（每個結構一列；多相位合併）。`archived=False` ＝ 暫存區、True ＝ 封存區。
        帶病例的病歷號／study 日期與描述，給頁面辨識用。"""
        from sqlalchemy import func

        async with self.sessions() as s:
            q = select(StructureRow).where(StructureRow.deleted_at.is_not(None), StructureRow.frame_key <= 0)
            q = q.where(StructureRow.archived_at.is_not(None) if archived else StructureRow.archived_at.is_(None))
            if deleted_by is not None:
                q = q.where(StructureRow.deleted_by == deleted_by)
            rows = (await s.execute(q.order_by(StructureRow.deleted_at.desc()))).scalars().all()
            if not rows:
                return []
            case_ids = sorted({r.case_id for r in rows})
            cases = {
                c.case_id: c for c in (await s.execute(select(CaseRow).where(CaseRow.case_id.in_(case_ids)))).scalars()
            }
            studies = {
                st.study_uid: st
                for st in (
                    await s.execute(
                        select(StudyRow).where(StudyRow.study_uid.in_(sorted({c.study_id for c in cases.values()})))
                    )
                ).scalars()
            }
            counts = {
                (cid, sid): n
                for cid, sid, n in (
                    await s.execute(
                        select(StructureVersionRow.case_id, StructureVersionRow.structure_id, func.count())
                        .where(StructureVersionRow.case_id.in_(case_ids))
                        .group_by(StructureVersionRow.case_id, StructureVersionRow.structure_id)
                    )
                ).all()
            }
            out = []
            for r in rows:
                c = cases.get(r.case_id)
                st = studies.get(c.study_id) if c else None
                out.append(
                    {
                        "case_id": r.case_id,
                        "structure_id": r.structure_id,
                        "name": r.name,
                        "color_rgb": r.color_rgb,
                        "status": r.status,
                        "structure_set_id": r.structure_set_id,
                        "set_label": r.deleted_set_label or r.structure_set_id or "",
                        "frame_of_reference_uid": r.frame_of_reference_uid,
                        "deleted_by": r.deleted_by,
                        "deleted_at": r.deleted_at,
                        "archived_at": r.archived_at,
                        "archive_note": r.archive_note,
                        "version_count": counts.get((r.case_id, r.structure_id), 0),
                        "patient_id": st.patient_id if st else None,
                        "study_date": st.study_date if st else "",
                        "study_description": st.study_description if st else (c.description if c else ""),
                    }
                )
            return out

    async def deleted_item(self, case_id: str, structure_id: str) -> dict[str, Any] | None:
        async with self.sessions() as s:
            rows = (
                (
                    await s.execute(
                        select(StructureRow).where(
                            StructureRow.case_id == case_id,
                            StructureRow.structure_id == structure_id,
                            StructureRow.deleted_at.is_not(None),
                        )
                    )
                )
                .scalars()
                .all()
            )
            if not rows:
                return None
            r = min(rows, key=lambda x: x.frame_key)
            return {
                "case_id": case_id,
                "structure_id": structure_id,
                "name": r.name,
                "status": r.status,
                "structure_set_id": r.structure_set_id,
                "set_label": r.deleted_set_label,
                "frame_of_reference_uid": r.frame_of_reference_uid,
                "deleted_by": r.deleted_by,
                "deleted_at": r.deleted_at,
                "archived_at": r.archived_at,
                "archive_note": r.archive_note,
            }

    async def deleted_history(self, case_id: str, structure_id: str) -> dict[str, Any]:
        """封存區詳情：版本鏈（誰、何時、哪一種、體素數）＋ 這個結構的全部簽核事件。"""
        async with self.sessions() as s:
            vers = (
                (
                    await s.execute(
                        select(StructureVersionRow)
                        .where(StructureVersionRow.case_id == case_id, StructureVersionRow.structure_id == structure_id)
                        .order_by(StructureVersionRow.frame_key, StructureVersionRow.seq)
                    )
                )
                .scalars()
                .all()
            )
            evs = (
                (
                    await s.execute(
                        select(ReviewEventRow).where(ReviewEventRow.case_id == case_id).order_by(ReviewEventRow.seq)
                    )
                )
                .scalars()
                .all()
            )
        return {
            "versions": [
                {
                    "version_id": v.version_id,
                    "frame_index": _fi(v.frame_key),
                    "kind": v.kind,
                    "created_by": v.created_by,
                    "created_at": v.created_at,
                    "voxel_count": v.voxel_count,
                    "note": v.note,
                }
                for v in vers
            ],
            "review_events": [e.event for e in evs if (e.event or {}).get("structure_id") == structure_id],
        }

    async def set_archive_note(self, case_id: str, structure_id: str, note: str) -> bool:
        async with self.sessions() as s, s.begin():
            rows = (
                (
                    await s.execute(
                        select(StructureRow).where(
                            StructureRow.case_id == case_id,
                            StructureRow.structure_id == structure_id,
                            StructureRow.archived_at.is_not(None),
                        )
                    )
                )
                .scalars()
                .all()
            )
            for r in rows:
                r.archive_note = note
            return bool(rows)

    async def undelete(self, case_id: str, structure_id: str) -> int:
        """救回：清 deleted_at／archived_at（刪除人與備註留著當歷史）。回傳救回的列數（相位數）。"""
        async with self.sessions() as s, s.begin():
            rows = (
                (
                    await s.execute(
                        select(StructureRow).where(
                            StructureRow.case_id == case_id,
                            StructureRow.structure_id == structure_id,
                            StructureRow.deleted_at.is_not(None),
                        )
                    )
                )
                .scalars()
                .all()
            )
            for r in rows:
                r.deleted_at = None
                r.archived_at = None
            return len(rows)

    async def load_structure(self, case_id: str, structure_id: str) -> dict[tuple[str, int | None], StructureState]:
        """只重建一個（活的）結構的全部相位 ＋ 版本鏈（救回時插進記憶體裡的病例）。"""
        async with self.sessions() as s:
            srows = (
                (
                    await s.execute(
                        select(StructureRow).where(
                            StructureRow.case_id == case_id,
                            StructureRow.structure_id == structure_id,
                            StructureRow.deleted_at.is_(None),
                        )
                    )
                )
                .scalars()
                .all()
            )
            vers = (
                (
                    await s.execute(
                        select(StructureVersionRow)
                        .where(StructureVersionRow.case_id == case_id, StructureVersionRow.structure_id == structure_id)
                        .order_by(StructureVersionRow.frame_key, StructureVersionRow.seq)
                    )
                )
                .scalars()
                .all()
            )
        versions: dict[tuple[str, int], list[dict[str, Any]]] = {}
        for v in vers:
            versions.setdefault((v.structure_id, v.frame_key), []).append(_version_dict(v))
        loaded = LoadedCase(case={}, frame_groups=[], structures=[_structure_dict(r) for r in srows], versions=versions)
        return rebuild_structures(loaded, self)

    async def purge_structure(self, case_id: str, structure_id: str) -> dict[str, int]:
        """永久清除一個**已刪除**的結構：版本列與結構列刪掉；mask 檔只在沒有任何其他版本共用時才刪
        （key ＝ content_hash，合併／複製會共用）。簽核事件與稽核**保留**。"""
        from sqlalchemy import func

        async with self.sessions() as s, s.begin():
            rows = (
                (
                    await s.execute(
                        select(StructureRow).where(
                            StructureRow.case_id == case_id,
                            StructureRow.structure_id == structure_id,
                            StructureRow.deleted_at.is_not(None),
                        )
                    )
                )
                .scalars()
                .all()
            )
            if not rows:
                return {"structures": 0, "versions": 0, "blobs": 0}
            hashes = {
                h
                for (h,) in (
                    await s.execute(
                        select(StructureVersionRow.content_hash).where(
                            StructureVersionRow.case_id == case_id, StructureVersionRow.structure_id == structure_id
                        )
                    )
                ).all()
            }
            nv = (
                await s.execute(
                    delete(StructureVersionRow).where(
                        StructureVersionRow.case_id == case_id, StructureVersionRow.structure_id == structure_id
                    )
                )
            ).rowcount or 0
            await s.execute(
                delete(StructureRow).where(StructureRow.case_id == case_id, StructureRow.structure_id == structure_id)
            )
            still_used = (
                {
                    h
                    for (h,) in (
                        await s.execute(
                            select(StructureVersionRow.content_hash)
                            .where(StructureVersionRow.content_hash.in_(sorted(hashes)))
                            .group_by(StructureVersionRow.content_hash)
                            .having(func.count() > 0)
                        )
                    ).all()
                }
                if hashes
                else set()
            )
        removed = 0
        for h in hashes - still_used:
            if self.blobs.delete(h):
                removed += 1
        return {"structures": len(rows), "versions": int(nv), "blobs": removed}

    async def expired_structures(self, cutoff_iso: str) -> list[dict[str, Any]]:
        """暫存區（未封存）裡 deleted_at 早於 cutoff 的結構（只列，不刪）—— `retention_tick` 逐項先寫稽核再刪。
        封存區不動。"""
        async with self.sessions() as s:
            rows = (
                await s.execute(
                    select(StructureRow).where(
                        StructureRow.deleted_at.is_not(None),
                        StructureRow.archived_at.is_(None),
                        StructureRow.deleted_at < cutoff_iso,
                    )
                )
            ).scalars()
            items = {
                (r.case_id, r.structure_id): {
                    "case_id": r.case_id,
                    "structure_id": r.structure_id,
                    "name": r.name,
                    "deleted_at": r.deleted_at,
                    "deleted_by": r.deleted_by,
                }
                for r in rows
            }
        return [items[k] for k in sorted(items)]


def _case_dict(r: CaseRow) -> dict[str, Any]:
    return {
        "case_id": r.case_id,
        "study_id": r.study_id,
        "source": r.source,
        "selection_hash": r.selection_hash,
        "selection": r.selection,
        "description": r.description,
        "created_by": r.created_by,
        "created_at": r.created_at,
        "updated_at": r.updated_at,
        "persisted": True,
    }


def _set_dict(ws: StructureSetRow) -> dict[str, Any]:
    return {
        "structure_set_id": ws.structure_set_id,
        "kind": ws.kind,
        "label": ws.label,
        "owner": ws.owner,
        "series_instance_uid": None,
        "image_series_uid": ws.image_series_uid,
        "image_label": ws.image_label,
        "frame_of_reference_uid": ws.frame_of_reference_uid,
        "date": "",
        "roi_count": 0,
        "role": "work",
        "created_at": ws.created_at,
        "description": ws.description or "",
    }


def _structure_dict(st: StructureRow) -> dict[str, Any]:
    return {
        "structure_id": st.structure_id,
        "frame_index": _fi(st.frame_key),
        "name": st.name,
        "color_rgb": tuple(int(v) for v in st.color_rgb),
        "frame_of_reference_uid": st.frame_of_reference_uid,
        "tg263_code": st.tg263_code,
        "interpreted_type": st.interpreted_type,
        "status": st.status,
        "default_visible": bool(st.default_visible),
        "temporal_group_id": st.temporal_group_id,
        "structure_set_id": st.structure_set_id,
        "head_version_id": st.head_version_id,
        "created_by": st.created_by,
        "updated_by": st.updated_by,
        "updated_at": st.updated_at,
    }


def _version_dict(v: StructureVersionRow) -> dict[str, Any]:
    return {
        "version_id": v.version_id,
        "parent_version_id": v.parent_version_id,
        "kind": v.kind,
        "content_hash": v.content_hash,
        "offset_ijk": tuple(int(x) for x in v.offset_ijk),
        "size_ijk": tuple(int(x) for x in v.size_ijk),
        "provenance": v.provenance,
        "created_by": v.created_by,
        "created_at": v.created_at,
        "client_id": v.client_id,
        "client_seq": v.client_seq,
        "note": v.note,
        "seq": v.seq,
    }


def _chunks(items: list[Any], n: int) -> list[list[Any]]:
    return [items[i : i + n] for i in range(0, len(items), n)]


def rebuild_structures(loaded: LoadedCase, store: CaseStore) -> dict[tuple[str, int | None], StructureState]:
    """DB 列 ＋ blob → 活的 `StructureState`（含完整版本鏈；`block`／`content_hash` ＝ head）。"""
    from rtgaia_geom import Provenance

    out: dict[tuple[str, int | None], StructureState] = {}
    for sd in loaded.structures:
        key = (sd["structure_id"], _fk(sd["frame_index"]))
        vdicts = loaded.versions.get(key, [])
        versions: list[StructureVersion] = []
        for vd in vdicts:
            versions.append(
                StructureVersion(
                    version_id=vd["version_id"],
                    parent_version_id=vd["parent_version_id"],
                    kind=vd["kind"],
                    content_hash=vd["content_hash"],
                    offset_ijk=vd["offset_ijk"],
                    size_ijk=vd["size_ijk"],
                    block=store.block(vd),
                    provenance=Provenance.from_wire(vd["provenance"]),
                    created_by=vd["created_by"],
                    created_at=vd["created_at"],
                    client_id=vd["client_id"],
                    client_seq=vd["client_seq"],
                    note=vd["note"],
                    seq=vd["seq"],
                )
            )
        if not versions:
            continue  # 沒有版本的結構是壞資料；跳過而不是炸整個病例
        head = next((v for v in versions if v.version_id == sd["head_version_id"]), versions[-1])
        if head is not versions[-1]:
            # DB 的 head 不是最後一版（舊的序號重複留下的不一致）：內容照 head，並把它放到最後 ——
            # 否則 `StructureState.head` 是另一版，下次寫回就把 head 換掉，再載入時輪廓就變了
            log.warning(
                "structure %s (case %s): head version %s is not the newest; keeping it as the head",
                sd["structure_id"],
                loaded.case.get("case_id"),
                head.version_id,
            )
            versions.remove(head)
            versions.append(head)
        st = StructureState(
            structure_id=sd["structure_id"],
            name=sd["name"],
            color_rgb=sd["color_rgb"],
            frame_of_reference_uid=sd["frame_of_reference_uid"],
            offset_ijk=head.offset_ijk,
            size_ijk=head.size_ijk,
            block=head.block.copy(),
            content_hash=head.content_hash,
            provenance=head.provenance,
            status=sd["status"],  # type: ignore[arg-type]
            tg263_code=sd["tg263_code"],
            interpreted_type=sd.get("interpreted_type"),
            default_visible=sd["default_visible"],
            temporal_group_id=sd["temporal_group_id"],
            frame_index=sd["frame_index"],
            structure_set_id=sd.get("structure_set_id"),
            versions=versions,
            created_by=sd["created_by"],
            updated_by=sd["updated_by"],
            updated_at=sd["updated_at"],
        )
        out[(st.structure_id, st.frame_index)] = st
    return out
