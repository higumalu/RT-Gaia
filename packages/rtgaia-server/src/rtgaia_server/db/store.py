"""`CatalogStore` —— 目錄的持久層。

真相是 `instance.header`（每個檔案的 `InstanceHeader`）；`LibraryIndex` 由它整批重建。
派生表（patient／study／series／series_ref）每次寫入後由 index 重算、整批換掉 —— 數千個序列
在一個交易內幾十毫秒，比維護增量正確性便宜得多。
"""

from __future__ import annotations

from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from rtgaia_core.library.catalog import Catalog
from rtgaia_core.library.index import LibraryIndex, SeriesEntry
from rtgaia_core.library.scan import IMAGE_MODALITIES, InstanceHeader
from sqlalchemy import delete, select, text
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.ext.asyncio import AsyncEngine, async_sessionmaker, create_async_engine

from .models import InstanceRow, PatientRow, SeriesRefRow, SeriesRow, StudyRow

_KIND = {"RTSTRUCT": "rtstruct", "RTPLAN": "rtplan", "RTDOSE": "rtdose", "REG": "reg"}
_GENERATION_KEY = "catalog"
"""`app_setting` 的鍵：`{"generation": n}`，`replace_headers` 每次在同一個交易內加一。"""


class CatalogStore:
    def __init__(self, url: str, *, engine: AsyncEngine | None = None) -> None:
        self.url = url
        self.engine = engine or create_async_engine(url, pool_pre_ping=True)
        self.sessions = async_sessionmaker(self.engine, expire_on_commit=False)

    async def dispose(self) -> None:
        await self.engine.dispose()

    async def ping(self) -> bool:
        async with self.engine.connect() as conn:
            return (await conn.execute(text("SELECT 1"))).scalar() == 1

    # ── 讀 ─────────────────────────────────────────────────────────────────

    async def load_headers(self) -> list[InstanceHeader]:
        async with self.sessions() as s:
            rows = (await s.execute(select(InstanceRow.header).order_by(InstanceRow.path))).scalars().all()
        return [InstanceHeader.from_json(h) for h in rows]

    async def previous_map(self) -> dict[str, InstanceHeader]:
        """給 `scan_tree(previous=…)`：沒變動（mtime＋size 相同）的檔不必重讀。"""
        return {h.path: h for h in await self.load_headers()}

    async def load_index(self, root: str | Path) -> LibraryIndex:
        # 世代先讀：讀到一半有人寫入的話，記下的世代比內容舊 → 下次比對會再載一次（多載，不會漏）
        generation = await self.generation()
        return LibraryIndex(Path(root).resolve(), await self.load_headers(), generation=generation)

    async def generation(self) -> int:
        """目錄世代：不訂閱匯流排的行程（獨立 worker）用它判斷手上的索引舊了沒。"""
        async with self.sessions() as s:
            value = (
                await s.execute(text("SELECT value FROM app_setting WHERE key = :k"), {"k": _GENERATION_KEY})
            ).scalar()
        return int((value or {}).get("generation", 0))

    async def counts(self) -> dict[str, int]:
        async with self.sessions() as s:
            out = {}
            for name, model in (
                ("patients", PatientRow),
                ("studies", StudyRow),
                ("series", SeriesRow),
                ("instances", InstanceRow),
            ):
                out[name] = (await s.execute(text(f"SELECT count(*) FROM {model.__tablename__}"))).scalar() or 0
            return out

    # ── 寫 ─────────────────────────────────────────────────────────────────

    async def replace_headers(self, root: str | Path, headers: list[InstanceHeader]) -> LibraryIndex:
        """以 `headers` 為全集：多的刪、有的 upsert；然後重算派生表。回傳重建好的 index。

        一個交易：讀到一半的人看到的是舊的完整目錄或新的完整目錄，不會是一半。
        """
        index = LibraryIndex(Path(root).resolve(), headers)
        paths = [h.path for h in headers]
        async with self.sessions() as s:
            async with s.begin():
                if paths:
                    # 分批：asyncpg 對 IN 的參數數量有上限
                    keep = set(paths)
                    existing = (await s.execute(select(InstanceRow.path))).scalars().all()
                    stale = [p for p in existing if p not in keep]
                    for chunk in _chunks(stale, 500):
                        await s.execute(delete(InstanceRow).where(InstanceRow.path.in_(chunk)))
                else:
                    await s.execute(delete(InstanceRow))
                for chunk in _chunks(headers, 500):
                    stmt = insert(InstanceRow).values(
                        [
                            {
                                "path": h.path,
                                "series_uid": h.series_instance_uid,
                                "sop_uid": h.sop_instance_uid,
                                "mtime_ns": h.mtime_ns,
                                "size": h.size,
                                "instance_number": h.instance_number,
                                "header": h.to_json(),
                            }
                            for h in chunk
                        ]
                    )
                    stmt = stmt.on_conflict_do_update(
                        index_elements=[InstanceRow.path],
                        set_={
                            "series_uid": stmt.excluded.series_uid,
                            "sop_uid": stmt.excluded.sop_uid,
                            "mtime_ns": stmt.excluded.mtime_ns,
                            "size": stmt.excluded.size,
                            "instance_number": stmt.excluded.instance_number,
                            "header": stmt.excluded.header,
                        },
                    )
                    await s.execute(stmt)
                await self._rebuild_derived(s, index)
                index.generation = await self._bump_generation(s)
        return index

    async def _bump_generation(self, s: Any) -> int:
        bumped = await s.execute(
            text(
                "INSERT INTO app_setting (key, value, updated_by, updated_at) "
                "VALUES (:k, jsonb_build_object('generation', 1), 'catalog', :now) "
                "ON CONFLICT (key) DO UPDATE SET value = jsonb_build_object("
                "'generation', COALESCE((app_setting.value->>'generation')::bigint, 0) + 1), updated_at = :now "
                "RETURNING (value->>'generation')::bigint"
            ),
            {"k": _GENERATION_KEY, "now": datetime.now(UTC).isoformat(timespec="seconds")},
        )
        return int(bumped.scalar_one())

    async def _rebuild_derived(self, s: Any, index: LibraryIndex) -> None:
        await s.execute(delete(SeriesRefRow))
        await s.execute(delete(SeriesRow))
        await s.execute(delete(StudyRow))
        await s.execute(delete(PatientRow))
        patients: dict[str, str] = {}
        studies: dict[str, dict[str, Any]] = {}
        series_rows: list[dict[str, Any]] = []
        refs: list[dict[str, Any]] = []
        catalog = Catalog(index)
        for e in index.series.values():
            patients.setdefault(e.patient_id, e.patient_name_hash or "")
            studies.setdefault(
                e.study_instance_uid,
                {
                    "study_uid": e.study_instance_uid,
                    "patient_id": e.patient_id,
                    "study_date": e.study_date or "",
                    "study_description": e.study_description or "",
                },
            )
            series_rows.append(_series_row(e))
            refs.extend(_refs_of(e, index, catalog))
        if patients:
            await s.execute(
                insert(PatientRow).values([{"patient_id": k, "patient_name_hash": v} for k, v in patients.items()])
            )
        for chunk in _chunks(list(studies.values()), 500):
            await s.execute(insert(StudyRow).values(chunk))
        for chunk in _chunks(series_rows, 500):
            await s.execute(insert(SeriesRow).values(chunk))
        for chunk in _chunks(refs, 500):
            await s.execute(insert(SeriesRefRow).values(chunk))


def _series_row(e: SeriesEntry) -> dict[str, Any]:
    roi_names = [str(x) for x in (e.refs.get("roi_names") or [])]
    label = str(e.refs.get("structure_set_label") or "")
    plan_label = str(e.refs.get("plan_label") or e.links.get("plan_label") or "")
    return {
        "series_uid": e.series_instance_uid,
        "study_uid": e.study_instance_uid,
        "patient_id": e.patient_id,
        "modality": e.modality,
        "kind": "image" if e.modality in IMAGE_MODALITIES else _KIND.get(e.modality, "other"),
        "frame_of_reference_uid": e.frame_of_reference_uid or "",
        "series_date": e.series_date or "",
        "series_time": e.series_time or "",
        "series_description": e.series_description or "",
        "series_number": e.series_number or "",
        "sop_class_uid": e.sop_class_uid or "",
        "manufacturer": e.manufacturer or "",
        "manufacturer_model_name": e.manufacturer_model_name or "",
        "instance_count": e.instance_count,
        "refs": e.refs,
        "links": e.links,
        "structure_set_label": label,
        "plan_label": plan_label,
        "roi_names": roi_names,
        "search_text": " ".join(
            x
            for x in (
                e.patient_id,
                e.study_description,
                e.series_description,
                e.modality,
                label,
                plan_label,
                *roi_names,
            )
            if x
        ).lower(),
    }


def _refs_of(e: SeriesEntry, index: LibraryIndex, catalog: Catalog) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []

    def ref(kind: str, to: Any, for_uid: str = "") -> None:
        to_uid = str(to) if to else None
        out.append(
            {
                "from_series_uid": e.series_instance_uid,
                "to_series_uid": to_uid,
                "kind": kind,
                "resolved": bool(to_uid and to_uid in index.series),
                "to_frame_of_reference_uid": for_uid,
            }
        )

    if e.modality == "RTSTRUCT":
        ref("rtstruct->image", e.links.get("image_series_uid"))
    elif e.modality == "RTPLAN":
        ref("plan->rtstruct", e.links.get("structure_set_uid"))
        ref("plan->image", e.links.get("image_series_uid"))
    elif e.modality == "RTDOSE":
        ref("dose->plan", e.links.get("plan_uid"))
        ref("dose->image", e.links.get("image_series_uid"))
    elif e.modality == "REG":
        fixed, moving = catalog.reg_frames(e)
        fixed_images = index.image_series_in_frame(fixed) if fixed else []
        if fixed_images:
            for img in fixed_images:
                ref("reg->fixed", img.series_instance_uid, fixed)
        else:
            ref("reg->fixed", None, fixed)
        for f in moving:
            imgs = index.image_series_in_frame(f)
            if imgs:
                for img in imgs:
                    ref("reg->moving", img.series_instance_uid, f)
            else:
                ref("reg->moving", None, f)
    return out


def _chunks(items: list[Any], n: int) -> list[list[Any]]:
    return [items[i : i + n] for i in range(0, len(items), n)]
