"""暫存區／封存區（規則見 `rtgaia_core.retention`）。

* `GET  /trash`                                        → 暫存區：自己刪的（admin：全部 ＋ 資料頁移除的 DICOM）
* `POST /trash/structures/{case_id}/{structure_id}/restore` · `DELETE …`（永久清除）：刪除人或 admin
* `POST /trash/library/{item_id}/restore` · `DELETE /trash/library/{item_id}`：admin
* `GET  /archive` · `GET /archive/{case_id}/{structure_id}`（版本鏈＋簽核事件）
  `PATCH …  {note}` · `POST …/restore` · `DELETE …`（永久刪除）：**只有 admin**（`auth.required_role_for` 也擋）
沒有資料庫時結構的部分回 `available: false`（刪除就是刪除，沒有暫存）。
"""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Request

from .. import retention
from ..audit_events import new_event
from ..i18n import localized_route_class
from .deps import API, AppState, actor, is_admin, state

router = APIRouter(route_class=localized_route_class())  # 錯誤、原因等句子依請求語言翻


async def _audit(
    app: AppState, request: Request, action: str, object_id: str, case_id: str | None, detail: dict
) -> None:
    await app.audit(
        new_event(
            user=actor(request),
            action=action,
            status=200,
            object_type="retention",
            object_id=object_id,
            case_id=case_id,
            client_id=None,
            remote_addr=None,
            detail=detail,
        )
    )


def _require_admin(request: Request) -> None:
    if not is_admin(request):
        raise HTTPException(status_code=403, detail={"code": "ADMIN_ONLY", "message": "封存區只有管理者可以存取"})


def _require_db(app: AppState) -> None:
    if not app.db_url:
        raise HTTPException(status_code=409, detail={"code": "NO_DB", "message": "暫存區與封存區需要資料庫"})


@router.get(API + "/trash")
async def list_trash(request: Request, app: AppState = Depends(state)) -> dict[str, Any]:
    me, admin = actor(request), is_admin(request)
    days = retention.trash_days()
    items: list[dict[str, Any]] = []
    if app.db_url:
        store = await app.case_store_async()
        items = await store.deleted_items(archived=False, deleted_by=None if admin else me)
        for it in items:
            it["expires_at"] = retention.expires_at(it["deleted_at"], days)
    library = retention.library_trash_items(app.library_root) if admin and app.library_root else []
    return {"available": bool(app.db_url), "days": days, "items": items, "library": library, "is_admin": admin}


async def _restore(
    app: AppState, request: Request, case_id: str, structure_id: str, *, archived: bool
) -> dict[str, Any]:
    store = await app.case_store_async()
    item = await store.deleted_item(case_id, structure_id)
    if item is None or bool(item["archived_at"]) != archived:
        raise HTTPException(status_code=404, detail={"code": "NOT_FOUND", "structure_id": structure_id})
    if not archived and item["deleted_by"] != actor(request) and not is_admin(request):
        raise HTTPException(status_code=403, detail={"code": "NOT_DELETER", "deleted_by": item["deleted_by"]})
    try:
        mem = app.store.case(case_id)
    except KeyError:
        mem = None
    if mem is not None and any(sid == structure_id for sid, _ in mem.structures):
        raise HTTPException(
            status_code=409, detail={"code": "ID_TAKEN", "message": "病例裡已有同 id 的結構；先改名或刪掉那一個"}
        )
    await store.undelete(case_id, structure_id)
    if mem is not None:
        mem.retired_structure_ids.discard(structure_id)
    if mem is None:
        case = await app.case_async(case_id)  # 從 DB 重建，已包含剛救回的
    else:
        case = mem
        case.structures.update(await store.load_structure(case_id, structure_id))
    states = [st for (sid, _), st in case.structures.items() if sid == structure_id]
    if not states:
        raise HTTPException(
            status_code=500, detail={"code": "RESTORE_FAILED", "message": "救回後讀不到結構（沒有版本？）"}
        )
    set_id = states[0].structure_set_id
    if set_id and set_id.startswith("work:"):
        case.ensure_work_set(set_id, label=item["set_label"], frame_of_reference_uid=states[0].frame_of_reference_uid)
    for (sid, fi), st in list(case.structures.items()):
        if sid == structure_id:
            case.record_review(
                structure_id=sid,
                frame_index=fi,
                from_status="deleted",
                to_status=st.status,
                note="從封存區救回" if archived else "從暫存區救回",
                user=actor(request),
            )
    case.touch()
    await app.persist_case(case, created_by=actor(request))
    sessions = app.store.sessions_of(case_id)
    if sessions:
        layer = next((x for x in sessions[0].layers() if x["contentRef"] == structure_id), None)
        if layer:
            await app.publish(f"case:{case_id}", "layer.add", layer)
        await app.publish(f"case:{case_id}", "structure_sets.changed", {"caseId": case_id})
    await _audit(
        app,
        request,
        "archive.restore" if archived else "trash.restore",
        structure_id,
        case_id,
        {"structure_set_id": set_id, "status": states[0].status},
    )
    return {"case_id": case_id, "structure_id": structure_id, "structure_set_id": set_id, "status": states[0].status}


async def _purge(app: AppState, request: Request, case_id: str, structure_id: str, *, archived: bool) -> dict[str, Any]:
    store = await app.case_store_async()
    item = await store.deleted_item(case_id, structure_id)
    if item is None or bool(item["archived_at"]) != archived:
        raise HTTPException(status_code=404, detail={"code": "NOT_FOUND", "structure_id": structure_id})
    if not archived and item["deleted_by"] != actor(request) and not is_admin(request):
        raise HTTPException(status_code=403, detail={"code": "NOT_DELETER", "deleted_by": item["deleted_by"]})
    # 永久刪除：先寫稽核再刪 —— 以前刪完才寫，稽核寫不進去時刪除已經發生、沒有紀錄
    await _audit(
        app,
        request,
        "archive.purge" if archived else "trash.purge",
        structure_id,
        case_id,
        {"name": item["name"], "deleted_at": item.get("deleted_at"), "deleted_by": item.get("deleted_by")},
    )
    out = await store.purge_structure(case_id, structure_id)
    return {"case_id": case_id, "structure_id": structure_id, **out}


@router.post(API + "/trash/structures/{case_id}/{structure_id}/restore")
async def restore_trash(case_id: str, structure_id: str, request: Request, app: AppState = Depends(state)) -> dict:
    _require_db(app)
    return await _restore(app, request, case_id, structure_id, archived=False)


@router.delete(API + "/trash/structures/{case_id}/{structure_id}")
async def purge_trash(case_id: str, structure_id: str, request: Request, app: AppState = Depends(state)) -> dict:
    _require_db(app)
    return await _purge(app, request, case_id, structure_id, archived=False)


@router.post(API + "/trash/library/{item_id}/restore")
async def restore_library(item_id: str, request: Request, app: AppState = Depends(state)) -> dict:
    _require_admin(request)
    if not app.library_root:
        raise HTTPException(status_code=409, detail={"code": "NO_LIBRARY"})
    try:
        out = retention.restore_library_item(app.library_root, item_id)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail={"code": "NOT_FOUND", "item_id": item_id}) from exc
    await app.library_index_async(rescan=True)
    await _audit(app, request, "trash.library.restore", item_id, None, out)
    return out


@router.delete(API + "/trash/library/{item_id}")
async def purge_library(item_id: str, request: Request, app: AppState = Depends(state)) -> dict:
    _require_admin(request)
    if not app.library_root:
        raise HTTPException(status_code=409, detail={"code": "NO_LIBRARY"})
    item = next((x for x in retention.library_trash_items(app.library_root) if x["item_id"] == item_id), None)
    if item is None:
        raise HTTPException(status_code=404, detail={"code": "NOT_FOUND", "item_id": item_id})
    await _audit(app, request, "trash.library.purge", item_id, None, item)  # 先寫稽核再刪
    try:
        out = retention.purge_library_item(app.library_root, item_id)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail={"code": "NOT_FOUND", "item_id": item_id}) from exc
    return out


@router.get(API + "/archive")
async def list_archive(request: Request, app: AppState = Depends(state)) -> dict[str, Any]:
    _require_admin(request)
    if not app.db_url:
        return {"available": False, "items": []}
    store = await app.case_store_async()
    return {"available": True, "items": await store.deleted_items(archived=True)}


@router.get(API + "/archive/{case_id}/{structure_id}")
async def archive_detail(case_id: str, structure_id: str, request: Request, app: AppState = Depends(state)) -> dict:
    _require_admin(request)
    _require_db(app)
    store = await app.case_store_async()
    item = await store.deleted_item(case_id, structure_id)
    if item is None or not item["archived_at"]:
        raise HTTPException(status_code=404, detail={"code": "NOT_FOUND", "structure_id": structure_id})
    return {**item, **(await store.deleted_history(case_id, structure_id))}


@router.patch(API + "/archive/{case_id}/{structure_id}")
async def archive_note(case_id: str, structure_id: str, request: Request, app: AppState = Depends(state)) -> dict:
    _require_admin(request)
    _require_db(app)
    body = await request.json()
    note = str(body.get("note") or "").strip()[:2000]
    store = await app.case_store_async()
    if not await store.set_archive_note(case_id, structure_id, note):
        raise HTTPException(status_code=404, detail={"code": "NOT_FOUND", "structure_id": structure_id})
    await _audit(app, request, "archive.note", structure_id, case_id, {"note": note})
    return {"case_id": case_id, "structure_id": structure_id, "archive_note": note}


@router.post(API + "/archive/{case_id}/{structure_id}/restore")
async def restore_archive(case_id: str, structure_id: str, request: Request, app: AppState = Depends(state)) -> dict:
    _require_admin(request)
    _require_db(app)
    return await _restore(app, request, case_id, structure_id, archived=True)


@router.delete(API + "/archive/{case_id}/{structure_id}")
async def purge_archive(case_id: str, structure_id: str, request: Request, app: AppState = Depends(state)) -> dict:
    _require_admin(request)
    _require_db(app)
    return await _purge(app, request, case_id, structure_id, archived=True)
