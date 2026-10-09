"""`POST /studies/{study_id}/grids`。"""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import JSONResponse

from ..i18n import localized_route_class
from ..state import build_session
from ..tiers import ClientCapability
from .deps import API, AppState, json_maybe_corrupted, session_for_study, state

router = APIRouter(route_class=localized_route_class())  # 錯誤、原因等句子依請求語言翻


@router.post(API + "/studies/{study_id}/grids")
async def create_grids(study_id: str, request: Request, app: AppState = Depends(state)) -> Any:
    """前端先報告能力，**後端決定網格**。

    `series_ids` 必填，因為網格必須為「整組」而非「單一序列」決定：
    兩組 int16 CT 各約 400 MB，直接撞穿記憶體預算。
    """
    body = await request.json()
    if "series_ids" not in body:
        raise HTTPException(
            status_code=422,
            detail={
                "code": "MISSING_SERIES_IDS",
                "message": "series_ids 必填。漏傳 ＝ 第二組影像載入時才發現放不下。",
            },
        )
    cap = ClientCapability.from_wire(body.get("client_capability"))
    # 重新協商是**個人**的 Tier／DisplayGrid —— 只找請求者自己的 session，
    # 不能退回「最近的任何一個」（那會重建別人的 session、回傳別人的 session id、推 scene 給別人）
    session = session_for_study(app, request, study_id, own=True)
    # 只重建 Session（Tier、DisplayGrid），Case 原地不動 —— 結構、量測、transform 不必抄
    rebuilt = build_session(
        case=session.case,
        capability=cap,
        manual_tier=body.get("manual_tier"),
        session_id=session.session_id,
        user=session.user,
    )
    # Session 自己的狀態，重新協商不該歸零（client_seq 水位在 Case，不必抄）
    rebuilt.layer_overrides = session.layer_overrides
    rebuilt.connections = session.connections
    app.store.put(rebuilt)

    payload = {
        **rebuilt.grid_set.to_wire(),
        "tier_decision": rebuilt.tier_decision.to_wire(),
        "grid_notes": rebuilt.grid_notes,
        "session_id": rebuilt.session_id,
    }
    payload = json_maybe_corrupted(payload, app.chaos)

    if rebuilt.tier_decision.conflict:
        # ⚠️ 見 `tiers` 模組開頭：412 只在「前端建議與自報能力矛盾」時發生，
        # 且 body 已帶 assigned_tier，前端不必再打一次請求。
        return JSONResponse(
            status_code=412,
            content={
                "reason": rebuilt.tier_decision.reason,
                "diagnostics": rebuilt.tier_decision.diagnostics,
                **payload,
            },
        )
    await app.publish(rebuilt.session_id, "scene.replace", rebuilt.scene_push())
    return payload
