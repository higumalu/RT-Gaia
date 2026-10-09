"""檢視器裡組成／拆開／攤開時間軸 —— 同一個病例原地重組（`AppState.reassemble_case`）。

* `POST   /studies/{study_id}/temporal-groups`               ：幾張單張影像照順序組成一條時間軸
* `DELETE /studies/{study_id}/temporal-groups/{group_id}`    ：拆回多張影像
* `POST   /studies/{study_id}/temporal-groups/{group_id}/view`：攤開成每一幀一張影像（`expanded`）／收回（`timeline`）
* `POST   /studies/{study_id}/temporal-groups/{group_id}/resample`：網格不同的相位重新取樣補進來／照舊排除
"""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Request
from rtgaia_geom import ContractViolation

from ..case_temporal import compose_selection, dissolve_selection, resample_selection, view_selection
from ..i18n import localized_route_class, translate
from .deps import API, AppState, push_scene_to_case, session_for_study, state

router = APIRouter(route_class=localized_route_class())

_CONFLICT_CODES = {"TA16", "TA17", "TA19"}


def _fail(exc: ContractViolation) -> HTTPException:
    status = 409 if exc.code in _CONFLICT_CODES else 404 if exc.code == "TA15" else 400
    return HTTPException(
        status_code=status,
        detail={
            "code": exc.code,
            "message": translate(exc.message),
            **({"count": exc.context["count"]} if "count" in exc.context else {}),
        },
    )


def _groups(case: Any) -> list[dict[str, Any]]:
    return [g.to_wire() for g in case.temporal_groups]


@router.post(API + "/studies/{study_id}/temporal-groups")
async def compose_temporal_group(study_id: str, request: Request, app: AppState = Depends(state)) -> dict[str, Any]:
    """body：`{series_uids: [...]（幀的順序）, labels?: [...], axis?: "phase"|"time"}`。"""
    body = await request.json()
    session = session_for_study(app, request, study_id)
    case = session.case
    uids = [str(u) for u in body.get("series_uids") or []]
    labels = body.get("labels")
    try:
        selection, key = compose_selection(
            case,
            uids,
            [str(v or "") for v in labels] if isinstance(labels, list) else None,
            str(body.get("axis") or "phase"),
            resample=body.get("resample") is True,
        )
    except ContractViolation as exc:
        raise _fail(exc) from exc
    # 重組是原地換內容（同一個 Case 物件）：退回用的選取與原本的警告要先記下來
    previous_selection = dict(case.selection)
    known = set(case.dataset.notes.get("case", {}).get("warnings", []))
    new = await app.reassemble_case(case, selection)
    group = next((g for g in new.temporal_groups if g.temporal_group_id == key), None)
    if group is None or group.frame_count != len(uids):
        # 幾何驗證（DL4–DL12）排除了幾幀 → 不留半套：退回原本的選取
        warnings = [w for w in new.dataset.notes.get("case", {}).get("warnings", []) if w not in known]
        await app.reassemble_case(new, previous_selection)
        raise HTTPException(
            status_code=400,
            detail={
                "code": "TA13",
                "message": translate("有影像沒辦法放進時間軸：") + "；".join(translate(w) for w in warnings),
            },
        )
    request.state.audit_detail = {
        "temporal_group_id": key,
        "series_uids": uids,
        "axis": body.get("axis") or "phase",
        "resample": body.get("resample") is True,
    }
    return {"temporal_group_id": key, "temporal_groups": _groups(new)}


@router.delete(API + "/studies/{study_id}/temporal-groups/{group_id}")
async def dissolve_temporal_group(
    study_id: str, group_id: str, request: Request, app: AppState = Depends(state)
) -> dict[str, Any]:
    session = session_for_study(app, request, study_id)
    try:
        selection = dissolve_selection(session.case, group_id)
    except ContractViolation as exc:
        raise _fail(exc) from exc
    new = await app.reassemble_case(session.case, selection)
    request.state.audit_detail = {"temporal_group_id": group_id}
    return {"temporal_groups": _groups(new)}


@router.post(API + "/studies/{study_id}/temporal-groups/{group_id}/view")
async def set_temporal_view(
    study_id: str, group_id: str, request: Request, app: AppState = Depends(state)
) -> dict[str, Any]:
    """body：`{mode: "expanded"|"timeline"}`。"""
    body = await request.json()
    session = session_for_study(app, request, study_id)
    mode = str(body.get("mode") or "")
    try:
        selection = view_selection(session.case, group_id, mode)
    except ContractViolation as exc:
        raise _fail(exc) from exc
    # 只改圖層（資料集不變）→ 不重組：換選取、寫回、每個 session 推自己的 scene
    case = session.case
    case.selection = selection
    await push_scene_to_case(app, session)
    request.state.audit_detail = {"temporal_group_id": group_id, "mode": mode}
    return {"temporal_group_id": group_id, "mode": mode, "temporal_groups": _groups(case)}


@router.post(API + "/studies/{study_id}/temporal-groups/{group_id}/resample")
async def set_temporal_resample(
    study_id: str, group_id: str, request: Request, app: AppState = Depends(state)
) -> dict[str, Any]:
    """body `{enabled: bool}` —— 網格跟第一幀不同的相位重新取樣補進來（true）／照舊排除（false）。
    同一個病例原地重組；只屬某一幀的結構依序列 UID 換到新的幀號，那一幀不在了 → 409 TA19（什麼都沒改）。"""
    body = await request.json()
    session = session_for_study(app, request, study_id)
    enabled = body.get("enabled") is True
    try:
        selection = resample_selection(session.case, group_id, enabled)
        new = await app.reassemble_case(session.case, selection)
    except ContractViolation as exc:
        raise _fail(exc) from exc
    group = next((g for g in new.temporal_groups if g.temporal_group_id == group_id), None)
    request.state.audit_detail = {"temporal_group_id": group_id, "enabled": enabled}
    return {
        "temporal_group_id": group_id,
        "enabled": enabled,
        "frame_count": group.frame_count if group is not None else None,
        "temporal_groups": _groups(new),
    }
