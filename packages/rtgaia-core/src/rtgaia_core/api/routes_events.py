"""WS Push 通道：身分、每人 current、連線數（presence）。"""

from __future__ import annotations

import asyncio
import contextlib
from typing import Any

from fastapi import APIRouter, WebSocket, WebSocketDisconnect

from ..auth import COOKIE_NAME
from .deps import API, AppState

router = APIRouter()

WS_REVALIDATE_SECONDS = 30.0
"""長連線多久重驗一次身分。帳號被停用、改密碼、要求改密碼時不必等 ——
`invalidate_principal` 立刻叫醒。"""
CLOSE_UNAUTHORIZED = 4401
CLOSE_FORBIDDEN = 4403


def ws_policy_close_code(principal: Any) -> int | None:
    """HTTP 與 WS 共用的帳號政策：沒有有效身分 → 4401；被要求改密碼 → 4403（HTTP 那邊只放行帳號 API，
    業務推送也一樣不給）。回 None ＝ 可以連。"""
    if principal is None:
        return CLOSE_UNAUTHORIZED
    if getattr(principal, "must_change_password", False):
        return CLOSE_FORBIDDEN
    return None


async def _watch_account(app: AppState, websocket: WebSocket, token: str, user_id: str, wake: asyncio.Event) -> None:
    """定期（或帳號變動時立刻）重驗 token；失效就以對應的碼關掉這條連線。"""
    while True:
        with contextlib.suppress(TimeoutError):
            await asyncio.wait_for(wake.wait(), timeout=WS_REVALIDATE_SECONDS)
        wake.clear()
        principal = await app.principal_for_token(token)
        code = ws_policy_close_code(principal)
        if code is None and principal.user_id != user_id:
            code = CLOSE_UNAUTHORIZED
        if code is not None:
            with contextlib.suppress(Exception):
                await websocket.close(code=code)
            return


@router.websocket(API + "/session/{session_id}/events")
async def events(websocket: WebSocket, session_id: str) -> None:
    app: AppState = websocket.app.state.rtgaia
    # 身分 —— cookie／Bearer（required）或 X-RTGaia-User（off）；required 模式沒登入就關
    principal = None
    token = ""
    if app.auth_mode == "required":
        token = websocket.cookies.get(COOKIE_NAME) or websocket.query_params.get("token") or ""
        principal = await app.principal_for_token(token) if token else None
        # 跟 HTTP 同一套政策（以前只驗 token；被要求改密碼的帳號照樣收得到業務推送）
        code = ws_policy_close_code(principal)
        if code is not None:
            await websocket.close(code=code)
            return
    user = principal.username if principal else (websocket.headers.get("X-RTGaia-User") or None)
    if session_id in ("current", "_"):
        try:
            session_id = app.store.current_for(user).session_id
        except KeyError:
            await websocket.close(code=4404)
            return
    session = None
    try:
        session = app.store.get(session_id)
    except KeyError:
        pass
    # session 是**某個人的**（各自的 DisplayGrid、各自看得到的暫存結果）。`required` 模式下
    # 連別人的 session 一律拒絕（admin 也是 —— 暫存結果連 admin 都不該看）；session ID 不是秘密（presence
    # 與 `_test/sessions` 都有），所以不能靠「知道 ID」當授權。以前 Bob 連 Alice 的 WS，
    # `scene.replace` 帶著 Alice 私人的 mask layer 回來。`off` 模式沒有可信身分，不判。
    if principal is not None and session is not None and session.user != principal.username:
        await websocket.close(code=4403)
        return
    if session is not None:
        session.connections += 1
        session.disconnected_at = None
    conn = await app.hub.connect(session_id, websocket)
    watcher: asyncio.Task[None] | None = None
    wake: asyncio.Event | None = None
    if principal is not None:
        # 連線期間也守著帳號（停用、改密碼、要求改密碼 → 斷線；前端會重連，新 cookie 有效就連得回來）
        wake = app.register_ws_watch(principal.user_id)
        watcher = asyncio.create_task(_watch_account(app, websocket, token, principal.user_id, wake))
    try:
        # 連上就先送一次完整場景，前端不必先打 HTTP 才有東西可畫
        try:
            await app.hub.send(session_id, "scene.replace", app.store.get(session_id).scene_push())
        except KeyError:
            pass
        # presence 在 `POST /sessions`（開病例）與斷線時發，**連上時不發** ——
        # 🔴 這條 WS 的訊息順序前端與測試都以「scene.replace 之後就是業務訊息」為準，多一則會錯位
        while True:
            message = await websocket.receive_json()
            kind = message.get("type")
            # 回覆也走這條連線的佇列 —— 直接 send 會插到排隊中的推送前面（順序錯）
            if kind == "session.hello":
                conn.hello = message.get("payload") or {}
                await app.hub.send_to(conn, "job.progress", {"jobId": "hello", "phase": "acknowledged", "percent": 100})
            elif kind == "ack":
                pass
            else:
                await app.hub.send_to(conn, "error", {"code": "UNKNOWN_CLIENT_MESSAGE", "message": str(kind)})
            if app.chaos.should_disconnect():
                # chaos: disconnect —— 驗證前端「重連並重新同步」
                await websocket.close(code=1012)
                break
    except WebSocketDisconnect:
        pass
    finally:
        if watcher is not None:
            watcher.cancel()
        if principal is not None and wake is not None:
            app.unregister_ws_watch(principal.user_id, wake)
        app.hub.disconnect(conn)
        if session is not None:
            session.connections = max(0, session.connections - 1)
            if session.connections == 0:
                from datetime import UTC, datetime

                session.disconnected_at = datetime.now(UTC).isoformat(timespec="seconds")
            await app.publish_presence(session.case.case_id)
