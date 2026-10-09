"""目錄樹端點。

* `GET /api/v1/catalog/patients?q=&patient_id=&date_from=&date_to=&modality=&has=&page=&size=`
* `GET /api/v1/catalog/patients/{patient_id}/studies?…`
* `GET /api/v1/catalog/studies/{study_uid}/series?…`     → `{ images, unlinked }`
* `GET /api/v1/catalog/series/{series_uid}/rt?…`          → 第四層（RTPLAN 列含 `doses`）
* `GET /api/v1/catalog/series/{series_uid}`               → 抽屜
* `GET /api/v1/catalog/search?…`                          → 命中與路徑（樹自動展開）
* `GET /api/v1/catalog/{patients|studies|series}/{key}/download` → zip（STORE、檔名 UID）

每一層都吃同一組篩選參數，所以搜尋結果仍是同一棵樹。`/library/*` 保留（舊資料頁與 driver 用）。
"""

from __future__ import annotations

import asyncio
from typing import Any, Literal

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from fastapi.responses import StreamingResponse

from ..i18n import localized_route_class
from ..library.catalog import Catalog, zip_stream
from .deps import API, AppState, actor, state
from .routes_library import _index

router = APIRouter(route_class=localized_route_class())  # 錯誤、原因等句子依請求語言翻

Filters = dict[str, str | None]


async def _catalog(app: AppState) -> Catalog:
    index = await _index(app)
    cached = getattr(app, "catalog", None)
    if cached is None or cached.index is not index or cached.show_names != app.show_patient_names:
        cached = Catalog(index, show_names=app.show_patient_names)
        app.catalog = cached
    return cached


def _filters(
    q: str | None = Query(None, description="自由文字：PatientID／描述／label／ROI 名稱（UID 只是備援）"),
    # 🔴 名字不能叫 `patient_id`：`/patients/{patient_id}/studies` 的路徑參數同名，FastAPI 會把它當路徑參數
    patient: str | None = Query(None, alias="patient_id", description="PatientID 子字串"),
    date_from: str | None = Query(None, description="YYYYMMDD 或 YYYY-MM-DD"),
    date_to: str | None = Query(None),
    modality: str | None = Query(None, description="逗號分隔"),
    has: str | None = Query(None, description="影像要掛著哪些：rs,dose,reg,plan（逗號分隔）"),
) -> Filters:
    return {"q": q, "patient_id": patient, "date_from": date_from, "date_to": date_to, "modality": modality, "has": has}


@router.get(API + "/catalog/patients")
async def catalog_patients(
    page: int = Query(1, ge=1),
    size: int = Query(50, ge=1, le=500),
    filters: Filters = Depends(_filters),
    app: AppState = Depends(state),
) -> dict[str, Any]:
    cat = await _catalog(app)
    return cat.patients(cat.match(**filters), page=page, size=size)


@router.get(API + "/catalog/patients/{patient_id}/studies")
async def catalog_studies(
    patient_id: str, filters: Filters = Depends(_filters), app: AppState = Depends(state)
) -> list[dict[str, Any]]:
    cat = await _catalog(app)
    return cat.studies(patient_id, cat.match(**filters))


@router.get(API + "/catalog/studies/{study_uid}/series")
async def catalog_series(
    study_uid: str, filters: Filters = Depends(_filters), app: AppState = Depends(state)
) -> dict[str, Any]:
    cat = await _catalog(app)
    return cat.series(study_uid, cat.match(**filters))


@router.get(API + "/catalog/series/{series_uid}/rt")
async def catalog_rt(
    series_uid: str, filters: Filters = Depends(_filters), app: AppState = Depends(state)
) -> list[dict[str, Any]]:
    cat = await _catalog(app)
    try:
        return cat.rt(series_uid, cat.match(**filters))
    except KeyError as exc:
        raise HTTPException(status_code=404, detail={"code": "NO_SERIES", "message": str(exc)}) from exc


@router.get(API + "/catalog/series/{series_uid}")
async def catalog_detail(series_uid: str, app: AppState = Depends(state)) -> dict[str, Any]:
    cat = await _catalog(app)
    try:
        return cat.detail(series_uid)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail={"code": "NO_SERIES", "message": str(exc)}) from exc


@router.get(API + "/catalog/search")
async def catalog_search(
    limit: int = Query(200, ge=1, le=2000), filters: Filters = Depends(_filters), app: AppState = Depends(state)
) -> dict[str, Any]:
    cat = await _catalog(app)
    match = cat.match(**filters)
    hits = cat.search(match, limit=limit)
    return {"total": 0 if match is None else len(match), "hits": hits}


@router.get(API + "/catalog/{level}/{key}/download")
async def catalog_download(
    level: Literal["patients", "studies", "series"],
    key: str,
    compress: bool = Query(False, description="true → DEFLATE 壓縮；預設 STORE 不壓縮"),
    app: AppState = Depends(state),
) -> StreamingResponse:
    """zip 串流：預設 STORE 不壓縮（`?compress=true` 改 DEFLATE）、ZIP64；檔名用 UID（病人層用 PatientID）。"""
    cat = await _catalog(app)
    try:
        members = cat.zip_members(level, key)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail={"code": "NOT_FOUND", "message": str(exc)}) from exc
    safe = "".join(c if c.isalnum() or c in "._-" else "_" for c in key) or "download"
    return StreamingResponse(
        zip_stream(members, compress=compress),
        media_type="application/zip",
        headers={"Content-Disposition": f'attachment; filename="{safe}.zip"', "X-RTGaia-Files": str(len(members))},
    )


@router.delete(API + "/catalog/{level}/{key}")
async def catalog_delete(
    level: Literal["patients", "studies", "series"],
    key: str,
    request: Request,
    force: bool = Query(False, description="true → 即使有病例引用也刪"),
    app: AppState = Depends(state),
) -> dict[str, Any]:
    """從資料庫移除一位病人／一個 study／一個序列（admin）。

    檔案搬進 `<library_root>/.rtgaia/trash/…`（不真的刪，可救回），重掃後樹上就沒有。
    有持久化病例的選取引用到這些序列 → 409 `IN_USE`（列出病例），`?force=true` 才刪（那些病例之後打不開）。
    """
    from ..library.trash import move_to_trash

    cat = await _catalog(app)
    try:
        members = cat.zip_members(level, key)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail={"code": "NOT_FOUND", "message": str(exc)}) from exc
    index = cat.index
    if level == "series":
        series_uids = [key]
    elif level == "studies":
        series_uids = [s.series_instance_uid for s in index.series.values() if s.study_instance_uid == key]
    else:
        series_uids = [s.series_instance_uid for s in index.series.values() if s.patient_id == key]
    # 引用檢查：記憶體與 DB 的病例選取
    wanted = set(series_uids)
    affected: list[dict[str, Any]] = []
    cases: list[dict[str, Any]] = [
        {"case_id": c.case_id, "selection": c.selection, "description": c.dataset.description}
        for c in app.store.cases()
    ]
    if app.db_url:
        seen = {c["case_id"] for c in cases}
        for row in await (await app.case_store_async()).list():
            if row["case_id"] not in seen:
                cases.append(row)
    for c in cases:
        sel = c.get("selection") or {}
        used = set()
        for k in ("image_series_uids", "structure_set_uids", "dose_uids", "registration_uids", "plan_uids"):
            used |= set(sel.get(k) or [])
        if sel.get("primary_series_uid"):
            used.add(sel["primary_series_uid"])
        hit = sorted(used & wanted)
        if hit:
            affected.append({"case_id": c["case_id"], "description": c.get("description", ""), "series_uids": hit})
    if affected and not force:
        raise HTTPException(
            status_code=409,
            detail={
                "code": "IN_USE",
                "message": f"{len(affected)} 個病例的選取引用到這些序列；加 force=true 仍要刪（那些病例之後打不開）",
                "affected_cases": affected,
            },
        )
    result = await asyncio.to_thread(
        move_to_trash,
        app.library_root,
        [p for _, p in members],
        level=level,
        key=key,
        series_uids=series_uids,
        who=actor(request),
    )
    await app.library_index_async(rescan=True)
    app.catalog = None
    await app.publish("*", "catalog.changed", {"deleted": {"level": level, "key": key}, "series_uids": series_uids})
    return {
        "level": level,
        "key": key,
        "files_moved": result["moved"],
        "series_uids": series_uids,
        "trash_dir": result["trash_dir"],
        "affected_cases": affected,
        "forced": bool(force and affected),
    }
