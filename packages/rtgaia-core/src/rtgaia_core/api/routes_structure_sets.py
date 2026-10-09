"""結構集與合併。

* `GET  /cases/{case_id}/structure-sets`                  → 全部結構集（匯入集＋工作集），帶 `mine`／`editable`
* `POST /cases/{case_id}/structure-sets/mine {frame_of_reference_uid?}` → 我在該 FoR 的工作集（沒有就建）
* `PATCH /cases/{case_id}/structure-sets/{id} {label?, description?}` → 改名／改描述（擁有者或 admin）
* 結構集 CRUD：
  `POST /cases/{case_id}/structure-sets {label, description?, frame_of_reference_uid?}`
    → 新建**自己的**工作集（一人一 FoR 可多套）
  `DELETE /cases/{case_id}/structure-sets/{id}[?force=1]` → 刪自己的工作集與全部結構；
    含已簽核 → 409 `SET_HAS_APPROVED`（admin `force`）；匯入集 422 `IMPORT_READ_ONLY`；暫存集 422 `USE_DISCARD`
  `POST /cases/{case_id}/structure-sets/{id}/move {structure_ids}`
    → 把自己能改的結構**搬**進自己的工作集（同 FoR；同名 409）
* `POST /cases/{case_id}/structure-sets/{id|mine}/merge {structure_ids, on_conflict}`
  → 把別的集裡的結構**複製**進我的工作集（版本鏈 `kind=merge`，`parent_hash` 指向來源版本）。
  同名：`on_conflict[sid]` ∈ `skip`／`replace`（目標結構新增一版＝來源內容）／`rename`（尾綴 `_2`…）；
  沒給 → 409 `NAME_CONFLICT` 列出衝突，前端用它開對話框。跨 FoR → 422 `FOR_MISMATCH`。
"""

from __future__ import annotations

import re
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Request
from rtgaia_geom import Provenance

from ..audit_events import new_event
from ..i18n import localized_route_class, translate
from ..state import MODULE_VERSION, Case, Session, StructureState, StructureVersion
from .deps import API, AppState, actor, push_case, state

router = APIRouter(route_class=localized_route_class())  # 錯誤、原因等句子依請求語言翻


def _is_admin(request: Request) -> bool:
    principal = getattr(request.state, "principal", None)
    return bool(principal is not None and getattr(principal, "role", "") == "admin")


async def _case_and_session(app: AppState, case_id: str, request: Request) -> tuple[Case, Session]:
    """合併要推 layer.*／mask.updated，要有一個 session 算圖層 wire：優先用操作者自己開的。"""
    sessions = app.store.sessions_of(case_id)
    if not sessions:
        try:
            case = await app.case_async(case_id)
        except KeyError as exc:
            raise HTTPException(status_code=404, detail={"code": "NO_CASE", "message": str(exc)}) from exc
        raise HTTPException(
            status_code=409, detail={"code": "NO_SESSION", "case_id": case.case_id, "message": "請先開啟這個病例"}
        )
    me = actor(request)
    session = next((s for s in sessions if s.user == me), sessions[0])
    return session.case, session


def _set_wire(case: Case, s: dict[str, Any], user: str, admin: bool) -> dict[str, Any]:
    return case.structure_set_wire(s, user, admin=admin)


@router.get(API + "/cases/{case_id}/structure-sets")
async def list_structure_sets(case_id: str, request: Request, app: AppState = Depends(state)) -> list[dict[str, Any]]:
    try:
        case = await app.case_async(case_id)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail={"code": "NO_CASE", "message": str(exc)}) from exc
    user = actor(request)
    return [
        _set_wire(case, s, user, _is_admin(request))
        for s in case.structure_sets
        if not case.is_transient_of_other(s["structure_set_id"], user)
    ]


@router.post(API + "/cases/{case_id}/structure-sets/mine", status_code=201)
async def ensure_my_set(case_id: str, request: Request, app: AppState = Depends(state)) -> dict[str, Any]:
    body = await request.json() if int(request.headers.get("content-length") or 0) > 0 else {}
    case, session = await _case_and_session(app, case_id, request)
    if not case.uses_structure_sets:
        raise HTTPException(status_code=422, detail={"code": "NO_STRUCTURE_SETS", "message": "假體病例沒有結構集"})
    for_uid = str(body.get("frame_of_reference_uid") or case.dataset.primary.frame_of_reference_uid)
    ws = case.work_set_for(actor(request), for_uid)
    assert ws is not None
    await push_case(app, session, "structure_sets.changed", {"caseId": case.case_id})
    return _set_wire(case, ws, actor(request), _is_admin(request))


@router.patch(API + "/cases/{case_id}/structure-sets/{set_id}")
async def rename_structure_set(
    case_id: str, set_id: str, request: Request, app: AppState = Depends(state)
) -> dict[str, Any]:
    body = await request.json()
    case, session = await _case_and_session(app, case_id, request)
    s = case.structure_set(set_id)
    if s is None:
        raise HTTPException(status_code=404, detail={"code": "NO_STRUCTURE_SET", "structure_set_id": set_id})
    if s.get("kind", "import") != "work":
        raise HTTPException(
            status_code=422, detail={"code": "IMPORT_READ_ONLY", "message": "匯入集的名稱來自 RTSTRUCT"}
        )
    if s.get("owner") != actor(request) and not _is_admin(request):
        raise HTTPException(status_code=403, detail={"code": "NOT_OWNER", "owner": s.get("owner")})
    if "label" in body:
        label = str(body.get("label") or "").strip()
        if not label:
            raise HTTPException(status_code=422, detail={"code": "BAD_LABEL", "message": "label 必填"})
        s["label"] = label[:120]
    if "description" in body:
        s["description"] = str(body.get("description") or "").strip()[:2000]
    if "label" not in body and "description" not in body:
        raise HTTPException(
            status_code=422, detail={"code": "NOTHING_TO_CHANGE", "message": "要給 label 或 description"}
        )
    case.touch()
    await app.persist_case(case, created_by=actor(request))
    await push_case(app, session, "structure_sets.changed", {"caseId": case.case_id})
    await _audit(
        app,
        request,
        "structure_set.update",
        case.case_id,
        {"structure_set_id": set_id, **{k: body[k] for k in ("label", "description") if k in body}},
    )
    return _set_wire(case, s, actor(request), _is_admin(request))


async def _audit(app: AppState, request: Request, action: str, case_id: str, detail: dict[str, Any]) -> None:
    await app.audit(
        new_event(
            user=actor(request),
            action=action,
            status=200,
            object_type="structure_set",
            object_id=str(detail.get("structure_set_id") or case_id),
            case_id=case_id,
            client_id=None,
            remote_addr=None,
            detail=detail,
        )
    )


@router.post(API + "/cases/{case_id}/structure-sets", status_code=201)
async def create_structure_set(case_id: str, request: Request, app: AppState = Depends(state)) -> dict[str, Any]:
    """新建自己的工作集（label 必填；FoR 預設 primary；一人一 FoR 可多套）。"""
    body = await request.json()
    case, session = await _case_and_session(app, case_id, request)
    if not case.uses_structure_sets:
        raise HTTPException(status_code=422, detail={"code": "NO_STRUCTURE_SETS", "message": "假體病例沒有結構集"})
    label = str(body.get("label") or "").strip()
    if not label:
        raise HTTPException(status_code=422, detail={"code": "BAD_LABEL", "message": "label 必填"})
    for_uid = str(body.get("frame_of_reference_uid") or case.dataset.primary.frame_of_reference_uid)
    if not any(fg.frame_of_reference_uid == for_uid for fg in case.frame_groups):
        raise HTTPException(status_code=422, detail={"code": "NO_FOR", "frame_of_reference_uid": for_uid})
    me = actor(request)
    if any(s.get("kind") == "work" and s.get("owner") == me and s.get("label") == label for s in case.structure_sets):
        raise HTTPException(status_code=409, detail={"code": "DUPLICATE_LABEL", "label": label})
    made = case.new_work_set(
        me, for_uid, label=label[:120], description=str(body.get("description") or "").strip()[:2000]
    )
    await app.persist_case(case, created_by=me)
    await push_case(app, session, "structure_sets.changed", {"caseId": case.case_id})
    await _audit(
        app,
        request,
        "structure_set.create",
        case.case_id,
        {"structure_set_id": made["structure_set_id"], "label": label},
    )
    return _set_wire(case, made, me, _is_admin(request))


@router.delete(API + "/cases/{case_id}/structure-sets/{set_id}")
async def delete_structure_set(
    case_id: str, set_id: str, request: Request, app: AppState = Depends(state), force: bool = False
) -> dict[str, Any]:
    """刪自己的工作集與全部結構。規則：含已簽核 → 409，admin 帶 `force=1` 才刪；
    匯入集不可刪（從資料頭改選取）；暫存集走 discard。每個結構記一筆 `deleted` 簽核事件、推 `layer.remove`。"""
    case, session = await _case_and_session(app, case_id, request)
    me, admin = actor(request), _is_admin(request)
    s = case.structure_set(set_id)
    if s is None:
        raise HTTPException(status_code=404, detail={"code": "NO_STRUCTURE_SET", "structure_set_id": set_id})
    kind = s.get("kind", "import")
    if kind == "import":
        raise HTTPException(
            status_code=422,
            detail={"code": "IMPORT_READ_ONLY", "message": "匯入的結構集不能刪；要拿掉請在資料頭改選取"},
        )
    if kind == "transient":
        raise HTTPException(status_code=422, detail={"code": "USE_DISCARD", "message": "暫存集請用「丟棄」"})
    if s.get("owner") != me and not admin:
        raise HTTPException(status_code=403, detail={"code": "NOT_OWNER", "owner": s.get("owner")})
    members = [st for st in case.structures.values() if st.structure_set_id == set_id]
    approved = sorted({st.structure_id for st in members if st.status == "approved"})
    if approved and not (force and admin):
        raise HTTPException(
            status_code=409,
            detail={
                "code": "SET_HAS_APPROVED",
                "approved_structure_ids": approved,
                "message": "這一套裡有已簽核的結構；先撤回簽核，或由 admin 以 force=1 刪除",
            },
        )
    statuses = {st.structure_id: st.status for st in members}
    names = {st.structure_id: st.name for st in members}
    removed = case.remove_structure_set(set_id)
    # 系統寫的備註跟請求的介面語言（存進事件、畫面照原樣顯示）；只翻模板，不動結構集名稱
    note = translate("刪除結構集 {p0}").replace("{p0}", str(s.get("label", "")))
    for sid, fi in removed:
        case.record_review(
            structure_id=sid,
            frame_index=fi,
            from_status=statuses.get(sid, ""),
            to_status="deleted",
            note=note,
            user=me,
            structure_name=names.get(sid),
        )
    for sid in sorted({sid for sid, _ in removed}):
        session.layer_overrides.pop(f"mask:{sid}", None)
        await push_case(app, session, "layer.remove", {"layerId": f"mask:{sid}"})
    await app.persist_case(case, created_by=me)
    await push_case(app, session, "structure_sets.changed", {"caseId": case.case_id})
    await _audit(
        app,
        request,
        "structure_set.delete",
        case.case_id,
        {
            "structure_set_id": set_id,
            "label": s.get("label"),
            "structure_ids": sorted({sid for sid, _ in removed}),
            "force": bool(force),
        },
    )
    return {"structure_set_id": set_id, "removed_structure_ids": sorted({sid for sid, _ in removed})}


@router.post(API + "/cases/{case_id}/structure-sets/{set_id}/move")
async def move_structures(
    case_id: str, set_id: str, request: Request, app: AppState = Depends(state)
) -> dict[str, Any]:
    """把結構**搬**進自己的工作集（不是複製）：來源要是我能改的（自己的工作集／暫存集），
    目標是我的工作集（`mine` ＝ 該 FoR 預設那套），同 FoR；目標有同名 → 409 `NAME_CONFLICT`。版本鏈不動。"""
    body = await request.json()
    case, session = await _case_and_session(app, case_id, request)
    me, admin = actor(request), _is_admin(request)
    structure_ids = [str(x) for x in body.get("structure_ids") or []]
    if not structure_ids:
        raise HTTPException(status_code=422, detail={"code": "NOTHING_TO_MOVE", "message": "要給 structure_ids"})
    sources: dict[str, list[StructureState]] = {}
    for sid in structure_ids:
        states = [st for (s_id, _), st in case.structures.items() if s_id == sid]
        if not states:
            raise HTTPException(status_code=404, detail={"code": "NO_STRUCTURE", "structure_id": sid})
        ok, code = case.can_edit(states[0], user=me, is_admin=admin)
        if not ok:
            raise HTTPException(status_code=403, detail={"code": code, "structure_id": sid})
        sources[sid] = states
    fors = {states[0].frame_of_reference_uid for states in sources.values()}
    if len(fors) > 1:
        raise HTTPException(
            status_code=422, detail={"code": "FOR_MISMATCH", "message": "一次只能搬同一組影像（FoR）的結構"}
        )
    for_uid = next(iter(fors))
    if set_id == "mine":
        target = case.work_set_for(me, for_uid)
        assert target is not None
    else:
        target = case.structure_set(set_id)
        if target is None:
            raise HTTPException(status_code=404, detail={"code": "NO_STRUCTURE_SET", "structure_set_id": set_id})
    if target.get("kind") != "work":
        raise HTTPException(status_code=422, detail={"code": "IMPORT_READ_ONLY", "message": "只能搬進工作集"})
    if target.get("owner") != me and not admin:
        raise HTTPException(status_code=403, detail={"code": "NOT_OWNER", "owner": target.get("owner")})
    if target.get("frame_of_reference_uid") != for_uid:
        raise HTTPException(status_code=422, detail={"code": "FOR_MISMATCH", "message": "目標結構集屬於另一組影像"})
    target_id = target["structure_set_id"]
    taken = {st.name for st in case.structures.values() if st.structure_set_id == target_id}
    conflicts = [
        sid for sid, states in sources.items() if states[0].structure_set_id != target_id and states[0].name in taken
    ]
    if conflicts:
        raise HTTPException(status_code=409, detail={"code": "NAME_CONFLICT", "structure_ids": conflicts})
    moved: list[str] = []
    for sid, states in sources.items():
        if states[0].structure_set_id == target_id:
            continue
        for st in states:
            st.structure_set_id = target_id
        moved.append(sid)
    if moved:
        case.touch()
        await app.persist_case(case, created_by=me)
        await push_case(app, session, "structure_sets.changed", {"caseId": case.case_id})
        await _audit(
            app, request, "structure_set.move", case.case_id, {"structure_set_id": target_id, "structure_ids": moved}
        )
    return {"target_structure_set_id": target_id, "moved": moved}


def _unique_id(case: Case, base: str) -> str:
    return case.unique_structure_id(base)  # 連已刪除的 id 一起避開


def _unique_name(case: Case, set_id: str, base: str) -> str:
    taken = {st.name for st in case.structures.values() if st.structure_set_id == set_id}
    if base not in taken:
        return base
    n = 2
    while f"{base}_{n}" in taken:
        n += 1
    return f"{base}_{n}"


def _any_approved(case: Any, structure_id: str | None) -> bool:
    """這個結構有任何一個相位已簽核。"""
    return structure_id is not None and any(
        st.status == "approved" for (sid, _), st in case.structures.items() if sid == structure_id
    )


@router.post(API + "/cases/{case_id}/structure-sets/{set_id}/merge")
async def merge_structures(
    case_id: str, set_id: str, request: Request, app: AppState = Depends(state)
) -> dict[str, Any]:
    body = await request.json()
    case, session = await _case_and_session(app, case_id, request)
    me, admin = actor(request), _is_admin(request)
    structure_ids = [str(x) for x in body.get("structure_ids") or []]
    on_conflict: dict[str, str] = {str(k): str(v) for k, v in dict(body.get("on_conflict") or {}).items()}
    if not structure_ids:
        raise HTTPException(status_code=422, detail={"code": "NOTHING_TO_MERGE", "message": "要給 structure_ids"})
    if not case.uses_structure_sets:
        raise HTTPException(status_code=422, detail={"code": "NO_STRUCTURE_SETS", "message": "假體病例沒有結構集"})
    # 來源：每個 id 的全部相位；FoR 必須一致
    sources: dict[str, list[StructureState]] = {}
    for sid in structure_ids:
        states = [st for (s_id, _), st in case.structures.items() if s_id == sid]
        if not states:
            raise HTTPException(status_code=404, detail={"code": "NO_STRUCTURE", "structure_id": sid})
        sources[sid] = states
    fors = {states[0].frame_of_reference_uid for states in sources.values()}
    if len(fors) > 1:
        raise HTTPException(
            status_code=422,
            detail={"code": "FOR_MISMATCH", "message": "一次只能合併同一組影像（FoR）的結構；跨影像要先對位重採樣"},
        )
    for_uid = next(iter(fors))
    # 目標：mine → 我在該 FoR 的工作集；否則指定的工作集（擁有者或 admin）
    if set_id == "mine":
        target = case.work_set_for(me, for_uid)
        assert target is not None
    else:
        target = case.structure_set(set_id)
        if target is None:
            raise HTTPException(status_code=404, detail={"code": "NO_STRUCTURE_SET", "structure_set_id": set_id})
        if target.get("kind", "import") != "work":
            raise HTTPException(status_code=422, detail={"code": "IMPORT_READ_ONLY", "message": "不能合併進匯入集"})
        if target.get("owner") != me and not admin:
            raise HTTPException(status_code=403, detail={"code": "NOT_OWNER", "owner": target.get("owner")})
        if target.get("frame_of_reference_uid") != for_uid:
            raise HTTPException(status_code=422, detail={"code": "FOR_MISMATCH", "message": "目標結構集屬於另一組影像"})
    target_id = target["structure_set_id"]
    # 預檢同名：沒給決定的 → 409 一次列出，什麼都不改
    conflicts = []
    plan: list[tuple[str, str, str | None]] = []  # (sid, action, existing_id)
    for sid, states in sources.items():
        src = states[0]
        if src.structure_set_id == target_id:
            plan.append((sid, "already", None))
            continue
        existing = next(
            (
                st
                for (e_id, fi), st in case.structures.items()
                if st.structure_set_id == target_id and st.name == src.name and fi in (None, 0)
            ),
            None,
        )
        if existing is None:
            plan.append((sid, "add", None))
            continue
        action = on_conflict.get(sid)
        if action not in ("skip", "replace", "rename"):
            conflicts.append(
                {
                    "structure_id": sid,
                    "name": src.name,
                    "existing_structure_id": existing.structure_id,
                    "existing_status": "approved" if _any_approved(case, existing.structure_id) else existing.status,
                }
            )
            continue
        plan.append((sid, action, existing.structure_id))
    if conflicts:
        raise HTTPException(
            status_code=409,
            detail={
                "code": "NAME_CONFLICT",
                "target_structure_set_id": target_id,
                "conflicts": conflicts,
                "message": "目標結構集已有同名結構；請在 on_conflict 逐一指定 skip／replace／rename",
            },
        )
    # 覆蓋已簽核的結構 ＝ 不經 reopen 就改內容、還把狀態改成 edited（等於撤銷簽核）→ 整批擋下，什麼都不改
    locked = [sid for sid, action, existing_id in plan if action == "replace" and _any_approved(case, existing_id)]
    if locked:
        raise HTTPException(
            status_code=409,
            detail={
                "code": "APPROVED_LOCKED",
                "structure_ids": locked,
                "message": "目標結構已簽核（approved），不能覆蓋；請改名或跳過，或先由審核者重新開啟",
            },
        )
    merged: list[dict[str, Any]] = []
    for sid, action, existing_id in plan:
        states = sources[sid]
        src_set = case.structure_set(states[0].structure_set_id) or {}
        origin = f"{src_set.get('label') or states[0].structure_set_id or '（無集）'}／{sid}"
        if action in ("already", "skip"):
            merged.append(
                {"source_structure_id": sid, "action": action, "structure_id": sid if action == "already" else None}
            )
            continue
        if action == "replace":
            assert existing_id is not None
            for src in states:
                tgt = case.structures.get((existing_id, src.frame_index))
                if tgt is None:
                    continue
                parent = tgt.content_hash
                tgt.offset_ijk, tgt.size_ijk = src.offset_ijk, src.size_ijk
                tgt.block = src.block.copy()
                tgt.content_hash = src.content_hash
                tgt.provenance = Provenance(
                    source="post-process",
                    module_version=f"{MODULE_VERSION}+merge:{sid}@{src.head.version_id}",
                    parent_hash=parent,
                )
                tgt.status = "edited"
                tgt.updated_by = me
                tgt._record_version(
                    kind="merge",
                    user=me,
                    client_id=None,
                    client_seq=None,
                    note=f"合併自 {origin}@{src.head.version_id}（覆蓋）",
                )
                await push_case(
                    app,
                    session,
                    "mask.updated",
                    {"structureId": existing_id, "frameIndex": tgt.frame_index, "contentHash": tgt.content_hash},
                )
            merged.append({"source_structure_id": sid, "action": "replace", "structure_id": existing_id})
            continue
        # add／rename：新結構進目標集
        slug = re.sub(r"[^A-Za-z0-9_.-]+", "_", me) or "me"
        new_id = _unique_id(case, f"{sid}__{slug}")
        name = _unique_name(case, target_id, states[0].name) if action == "rename" else states[0].name
        for src in states:
            st = StructureState(
                structure_id=new_id,
                name=name,
                color_rgb=src.color_rgb,
                frame_of_reference_uid=src.frame_of_reference_uid,
                offset_ijk=src.offset_ijk,
                size_ijk=src.size_ijk,
                block=src.block.copy(),
                content_hash=src.content_hash,
                provenance=Provenance(
                    source="post-process",
                    module_version=f"{MODULE_VERSION}+merge:{sid}@{src.head.version_id}",
                    parent_hash=src.content_hash,
                ),
                status="under_review",
                tg263_code=src.tg263_code,
                interpreted_type=src.interpreted_type,
                default_visible=True,
                temporal_group_id=src.temporal_group_id,
                frame_index=src.frame_index,
                structure_set_id=target_id,
                created_by=me,
                updated_by=me,
            )
            st.versions[0] = StructureVersion(
                **{**st.versions[0].__dict__, "kind": "merge", "note": f"合併自 {origin}@{src.head.version_id}"}
            )
            case.structures[st.key] = st
        layer = next(x for x in session.layers() if x["contentRef"] == new_id)
        await push_case(app, session, "layer.add", layer)
        merged.append({"source_structure_id": sid, "action": action, "structure_id": new_id, "name": name})
    case.touch()
    await push_case(app, session, "structure_sets.changed", {"caseId": case.case_id})
    return {
        "target_structure_set_id": target_id,
        "target": _set_wire(case, target, me, admin),
        "merged": merged,
    }
