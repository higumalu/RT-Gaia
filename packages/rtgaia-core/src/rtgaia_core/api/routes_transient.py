"""暫存物件：plugin 結果先進觸發者的暫存集，使用者「保存」才進工作集、「丟棄」即釋放。

* `GET  /cases/{case_id}/transient`            ：我的暫存摘要（結構數、bytes、集清單）
* `POST /cases/{case_id}/transient/save`       ：body `{structure_ids?: [...]}`（沒給＝全部）→ 搬進我在該 FoR 的工作集
* `POST /cases/{case_id}/transient/discard`    ：body 同上 → 移除
只作用在**自己的**暫存結構；別人的看不到也動不了。
"""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Request

from ..audit_events import new_event
from ..i18n import localized_route_class
from .deps import API, AppState, actor, push_case, state

router = APIRouter(route_class=localized_route_class())  # 錯誤、原因等句子依請求語言翻


def _mine(session: Any, user: str, ids: list[str] | None) -> list[Any]:
    sts = session.case.transient_structures(user)
    if ids:
        wanted = set(ids)
        sts = [st for st in sts if st.structure_id in wanted]
        missing = wanted - {st.structure_id for st in sts}
        if missing:
            raise HTTPException(
                404, {"code": "NO_TRANSIENT", "structure_ids": sorted(missing), "message": "不是你的暫存結構或已不存在"}
            )
    return sts


@router.get(API + "/cases/{case_id}/transient")
async def transient_summary(case_id: str, request: Request, app: AppState = Depends(state)) -> dict[str, Any]:
    case = await app.case_async(case_id)
    user = actor(request)
    sts = case.transient_structures(user)
    sets = [s for s in case.structure_sets if s.get("kind") == "transient" and s.get("owner") == user]
    return {
        "case_id": case_id,
        "count": len({st.structure_id for st in sts}),
        "bytes": int(sum(st.block.nbytes for st in sts)),
        "sets": sets,
        "structure_ids": sorted({st.structure_id for st in sts}),
    }


@router.post(API + "/cases/{case_id}/transient/save")
async def transient_save(case_id: str, request: Request, app: AppState = Depends(state)) -> dict[str, Any]:
    body = await request.json() if await request.body() else {}
    user = actor(request)
    # 2026-10-09：只用這個人自己開著這個病例的 session（以前先拿全域 current，可能是別人的）
    sessions = [s for s in app.store.sessions_of(case_id) if s.user == user]
    if not sessions:
        raise HTTPException(404, {"code": "NO_SESSION", "case_id": case_id})
    session = sessions[0]
    case = session.case
    sts = _mine(session, user, body.get("structure_ids"))
    moved: list[str] = []
    for st in sts:
        ws = case.work_set_for(user, st.frame_of_reference_uid, create=True)
        target = ws["structure_set_id"] if ws else None
        old = case.structure_set(st.structure_set_id)
        st.structure_set_id = target
        st.status = "under_review"
        st.updated_by = user
        if old is not None:
            old["roi_count"] = max(0, int(old.get("roi_count", 1)) - 1)
        if ws is not None:
            ws["roi_count"] = int(ws.get("roi_count", 0)) + 1
        moved.append(st.structure_id)
    # 空了的暫存集收掉
    case.structure_sets[:] = [
        s
        for s in case.structure_sets
        if not (
            s.get("kind") == "transient"
            and s.get("owner") == user
            and not any(x.structure_set_id == s["structure_set_id"] for x in case.structures.values())
        )
    ]
    case.touch()
    for sid in sorted(set(moved)):
        layer = next((x for x in session.layers() if x["contentRef"] == sid), None)
        if layer:
            await push_case(app, session, "layer.add", layer)  # 現在所有人都看得到：對別人是新增
    await push_case(app, session, "structure_sets.changed", {"caseId": case_id})
    await app.audit(
        new_event(
            user=user,
            action="transient.save",
            status=200,
            object_type="case",
            object_id=case_id,
            case_id=case_id,
            client_id=None,
            remote_addr=None,
            detail={"structure_ids": sorted(set(moved))},
        )
    )
    return {"saved": sorted(set(moved)), "structures": session.structure_list()}


@router.post(API + "/cases/{case_id}/transient/discard")
async def transient_discard(case_id: str, request: Request, app: AppState = Depends(state)) -> dict[str, Any]:
    body = await request.json() if await request.body() else {}
    user = actor(request)
    sessions = [s for s in app.store.sessions_of(case_id) if s.user == user]
    if not sessions:
        raise HTTPException(404, {"code": "NO_SESSION", "case_id": case_id})
    session = sessions[0]
    case = session.case
    sts = _mine(session, user, body.get("structure_ids"))
    gone = sorted({st.structure_id for st in sts})
    for k in [k for k, st in case.structures.items() if st.structure_id in gone]:
        case.structures.pop(k, None)
    case.structure_sets[:] = [
        s
        for s in case.structure_sets
        if not (
            s.get("kind") == "transient"
            and s.get("owner") == user
            and not any(x.structure_set_id == s["structure_set_id"] for x in case.structures.values())
        )
    ]
    case.touch()
    for s in sessions:
        for sid in gone:
            await app.publish(s.session_id, "layer.remove", {"layerId": f"mask:{sid}"})
        await app.publish(s.session_id, "structure_sets.changed", {"caseId": case_id})
    await app.audit(
        new_event(
            user=user,
            action="transient.discard",
            status=200,
            object_type="case",
            object_id=case_id,
            case_id=case_id,
            client_id=None,
            remote_addr=None,
            detail={"structure_ids": gone},
        )
    )
    return {"discarded": gone}
