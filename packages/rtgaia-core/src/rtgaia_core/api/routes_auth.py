"""身分端點。

* `GET  /api/v1/auth/status`      → { mode, bootstrap_needed, user? }
* `POST /api/v1/auth/bootstrap`   → 只在**沒有任何使用者**時可用：建第一個 admin 並登入
* `POST /api/v1/auth/login`       → 設 HttpOnly cookie；回 user
* `POST /api/v1/auth/logout`
* `GET  /api/v1/auth/me`          → 401 沒登入
* `GET  /api/v1/auth/users`、`POST /api/v1/auth/users`、`PATCH /api/v1/auth/users/{id}`（admin；中介層擋）

`RTGAIA_AUTH=off` 時 login／bootstrap 回 400 `AUTH_OFF`；`me` 回 stub principal。
"""

from __future__ import annotations

import re
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Request, Response

from ..auth import (
    COOKIE_NAME,
    TOKEN_TTL_SECONDS,
    PreferencesTooLarge,
    generate_temp_password,
    make_token,
    password_policy,
    password_problems,
    verify_password,
)
from ..i18n import localized_route_class
from ..limits import run_password
from .deps import API, AppState, state

router = APIRouter(route_class=localized_route_class())  # 錯誤、原因等句子依請求語言翻


def _set_cookie(response: Response, token: str, *, secure: bool) -> None:
    response.set_cookie(
        COOKIE_NAME, token, max_age=TOKEN_TTL_SECONDS, httponly=True, samesite="lax", secure=secure, path="/"
    )


@router.get(API + "/auth/status")
async def auth_status(request: Request, app: AppState = Depends(state)) -> dict[str, Any]:
    principal = getattr(request.state, "principal", None)
    out: dict[str, Any] = {
        "mode": app.auth_mode,
        "user": principal.to_wire() if principal else None,
        "password_policy": password_policy(),  # 前端表單照這個檢查
    }
    if app.auth_mode == "required":
        users = await app.user_store_async()
        out["bootstrap_needed"] = (await users.count()) == 0
    else:
        out["bootstrap_needed"] = False
    return out


@router.post(API + "/auth/bootstrap", status_code=201)
async def bootstrap(request: Request, response: Response, app: AppState = Depends(state)) -> dict[str, Any]:
    if app.auth_mode != "required":
        raise HTTPException(status_code=400, detail={"code": "AUTH_OFF", "message": "RTGAIA_AUTH=off，沒有帳號"})
    users = await app.user_store_async()
    if await users.count() > 0:
        raise HTTPException(
            status_code=409, detail={"code": "ALREADY_BOOTSTRAPPED", "message": "已有使用者；請由 admin 建帳號"}
        )
    body = await request.json()
    problems = password_problems(str(body.get("password") or ""), str(body.get("username") or ""))
    if problems:
        raise HTTPException(status_code=422, detail={"code": "WEAK_PASSWORD", "problems": problems})
    try:
        # 🔴 數與建在同一個交易、同一把鎖裡（上面的 count 只是早點回 409 的快路徑）：同時兩個 bootstrap 只會成功一個
        row = await users.create_first_admin(
            username=str(body.get("username") or ""),
            password=str(body["password"]),
            display_name=str(body.get("display_name") or ""),
        )
    except ValueError as exc:
        raise HTTPException(status_code=422, detail={"code": "BAD_USER", "message": str(exc)}) from exc
    if row is None:
        raise HTTPException(
            status_code=409, detail={"code": "ALREADY_BOOTSTRAPPED", "message": "已有使用者；請由 admin 建帳號"}
        )
    token = make_token(row.user_id, app.secret)
    _set_cookie(response, token, secure=request.url.scheme == "https")
    return {"user": users.principal(row).to_wire(), "token": token}


@router.post(API + "/auth/login")
async def login(request: Request, response: Response, app: AppState = Depends(state)) -> dict[str, Any]:
    if app.auth_mode != "required":
        raise HTTPException(status_code=400, detail={"code": "AUTH_OFF", "message": "RTGAIA_AUTH=off，不需要登入"})
    body = await request.json()
    users = await app.user_store_async()
    row, reason = await users.authenticate(str(body.get("username") or ""), str(body.get("password") or ""))
    if row is None:
        # 帳號不存在與密碼錯回同一個訊息；鎖定與停用要讓人知道
        code = {"locked": "LOCKED", "disabled": "DISABLED"}.get(reason, "BAD_CREDENTIALS")
        raise HTTPException(
            status_code=401 if code == "BAD_CREDENTIALS" else 423, detail={"code": code, "reason": reason}
        )
    token = make_token(row.user_id, app.secret)
    _set_cookie(response, token, secure=request.url.scheme == "https")
    # token 也放 body：WS `?token=`、腳本、與多身分測試用（cookie 是瀏覽器的路）
    return {"user": users.principal(row).to_wire(), "token": token}


@router.post(API + "/auth/logout")
async def logout(response: Response) -> dict[str, Any]:
    response.delete_cookie(COOKIE_NAME, path="/")
    return {"ok": True}


@router.get(API + "/auth/me")
async def me(request: Request) -> dict[str, Any]:
    principal = getattr(request.state, "principal", None)
    if principal is None:
        raise HTTPException(status_code=401, detail={"code": "AUTH_REQUIRED"})
    return principal.to_wire()


PREF_KEY = re.compile(r"^[a-z0-9][a-z0-9._-]{0,63}$")
PREF_VALUE_MAX = 64 * 1024
PREF_TOTAL_MAX = 256 * 1024


@router.get(API + "/auth/me/preferences")
async def get_preferences(request: Request, app: AppState = Depends(state)) -> dict[str, Any]:
    """介面偏好（跨電腦）。沒有資料庫帳號（`RTGAIA_AUTH=off`）→ `available: false`，前端只用這台瀏覽器的。"""
    principal = getattr(request.state, "principal", None)
    if principal is None:
        raise HTTPException(status_code=401, detail={"code": "AUTH_REQUIRED"})
    if app.auth_mode != "required" or principal.source != "local":
        return {"available": False, "preferences": {}}
    users = await app.user_store_async()
    return {"available": True, "preferences": await users.preferences(principal.user_id)}


@router.put(API + "/auth/me/preferences")
async def put_preferences(request: Request, app: AppState = Depends(state)) -> dict[str, Any]:
    """合併寫入 `{key: 字串值 | null}`（null ＝ 刪掉）；key 限小寫英數與 `._-`，單值 ≤ 64 KB、總量 ≤ 256 KB。"""
    principal = getattr(request.state, "principal", None)
    if principal is None:
        raise HTTPException(status_code=401, detail={"code": "AUTH_REQUIRED"})
    if app.auth_mode != "required" or principal.source != "local":
        return {"available": False, "preferences": {}}
    body = await request.json()
    if not isinstance(body, dict) or not body:
        raise HTTPException(status_code=422, detail={"code": "BAD_PREFERENCES", "message": "要給一個 {key: 值} 物件"})
    for k, v in body.items():
        if not isinstance(k, str) or not PREF_KEY.match(k):
            raise HTTPException(
                status_code=422, detail={"code": "BAD_PREFERENCE_KEY", "key": k, "message": f"不合法的偏好 key {k}"}
            )
        # 「KB」是 bytes —— 以 UTF-8 長度算（以前 len(str) 算的是字元數，中文會超過三倍）
        if v is not None and (not isinstance(v, str) or len(v.encode("utf-8")) > PREF_VALUE_MAX):
            raise HTTPException(
                status_code=422,
                detail={"code": "BAD_PREFERENCE_VALUE", "key": k, "message": f"偏好 {k} 的值要是 ≤ 64 KB 的字串"},
            )
    users = await app.user_store_async()
    # 合併、刪 key、總量檢查在**同一個持鎖交易**裡（以前先讀再寫、沒有鎖：兩台裝置同時改不同 key，
    # 後寫的會把先寫的那個 key 蓋掉；總量檢查也跟真正的寫入分開）
    try:
        merged = await users.update_preferences(principal.user_id, body, max_total_bytes=PREF_TOTAL_MAX)
    except PreferencesTooLarge as exc:
        raise HTTPException(
            status_code=413, detail={"code": "PREFERENCES_TOO_LARGE", "message": "偏好設定總量超過 256 KB"}
        ) from exc
    return {"available": True, "preferences": merged}


@router.get(API + "/auth/users")
async def list_users(app: AppState = Depends(state)) -> list[dict[str, Any]]:
    users = await app.user_store_async()
    return [users.to_wire(r) for r in await users.list()]


@router.post(API + "/auth/users", status_code=201)
async def create_user(request: Request, app: AppState = Depends(state)) -> dict[str, Any]:
    body = await request.json()
    problems = password_problems(str(body.get("password") or ""), str(body.get("username") or ""))
    if problems:
        raise HTTPException(status_code=422, detail={"code": "WEAK_PASSWORD", "problems": problems})
    users = await app.user_store_async()
    try:
        row = await users.create(
            username=str(body.get("username") or ""),
            password=str(body["password"]),
            role=str(body.get("role") or "contourer"),
            display_name=str(body.get("display_name") or ""),
            # 管理者替人設的密碼，預設要求對方第一次登入就改
            must_change_password=bool(body.get("must_change_password", True)),
            created_by=getattr(request.state, "principal", None).username
            if getattr(request.state, "principal", None)
            else "",
        )
    except ValueError as exc:
        raise HTTPException(status_code=422, detail={"code": "BAD_USER", "message": str(exc)}) from exc
    return users.to_wire(row)


@router.patch(API + "/auth/users/{user_id}")
async def update_user(user_id: str, request: Request, app: AppState = Depends(state)) -> dict[str, Any]:
    body = await request.json()
    users = await app.user_store_async()
    if "password" in body:
        target = await users.by_id(user_id)
        problems = password_problems(str(body["password"]), target.username if target else "")
        if problems:
            raise HTTPException(status_code=422, detail={"code": "WEAK_PASSWORD", "problems": problems})
        body.setdefault("must_change_password", True)  # 管理者重設 → 對方下次登入要改
    try:
        row = await users.update(
            user_id,
            **{
                k: v
                for k, v in body.items()
                if k in ("role", "disabled", "display_name", "password", "must_change_password", "unlock")
            },
        )
        app.invalidate_principal(user_id)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail={"code": "NO_USER", "message": str(exc)}) from exc
    except ValueError as exc:
        raise HTTPException(status_code=422, detail={"code": "BAD_USER", "message": str(exc)}) from exc
    return users.to_wire(row)


@router.post(API + "/auth/me/password")
async def change_my_password(request: Request, response: Response, app: AppState = Depends(state)) -> dict[str, Any]:
    """自己改密碼（要舊密碼）。成功後其他裝置上的 token 作廢，這一個當場換發新的。"""
    principal = getattr(request.state, "principal", None)
    if principal is None or app.auth_mode != "required":
        raise HTTPException(status_code=401, detail={"code": "AUTH_REQUIRED"})
    body = await request.json()
    current, new = str(body.get("current_password") or ""), str(body.get("new_password") or "")
    users = await app.user_store_async()
    row = await users.by_id(principal.user_id)
    # Argon2 不在 event loop 上算
    if row is None or not await run_password(verify_password, row.password_hash, current):
        raise HTTPException(status_code=403, detail={"code": "BAD_CURRENT_PASSWORD", "message": "目前的密碼不對"})
    if await run_password(verify_password, row.password_hash, new):
        raise HTTPException(status_code=422, detail={"code": "WEAK_PASSWORD", "problems": ["新密碼不可與目前的相同"]})
    problems = password_problems(new, row.username)
    if problems:
        raise HTTPException(status_code=422, detail={"code": "WEAK_PASSWORD", "problems": problems})
    row = await users.update(row.user_id, password=new, must_change_password=False)
    app.invalidate_principal(row.user_id)
    token = make_token(row.user_id, app.secret)  # iat_ms 晚於剛寫的 password_changed_at
    _set_cookie(response, token, secure=request.url.scheme == "https")
    return {"user": users.principal(row).to_wire(), "token": token}


BATCH_MAX = 500


def _parse_batch(body: dict[str, Any]) -> list[dict[str, Any]]:
    """`users: [{username, display_name?, role?, password?}]` 或 `csv: "username,display_name,role,password\n…"`
    （第一列是標題就略過；空列略過）。每筆帶 `line`：CSV 是**文字的實際行號**（標題、空行都算，
    跟管理者在框裡看到的一致），`users` 是第幾筆。"""
    import csv
    import io

    if isinstance(body.get("users"), list):
        return [{**dict(x), "line": n} for n, x in enumerate(body["users"][: BATCH_MAX + 1], start=1)]
    reader = csv.reader(io.StringIO(str(body.get("csv") or "")))
    rows = [(reader.line_num, r) for r in reader if any(c.strip() for c in r)]
    if rows and rows[0][1] and rows[0][1][0].strip().lower() in ("username", "帳號"):
        rows = rows[1:]
    out = []
    for line, r in rows[: BATCH_MAX + 1]:
        cells = [c.strip() for c in r] + ["", "", "", ""]
        out.append(
            {
                "username": cells[0],
                "display_name": cells[1],
                "role": cells[2] or "contourer",
                "password": cells[3],
                "line": line,
            }
        )
    return out


@router.post(API + "/auth/users/batch")
async def batch_create_users(request: Request, app: AppState = Depends(state)) -> dict[str, Any]:
    """批次建帳號（admin）。沒給密碼的產生一次性臨時密碼（**只在這個回應出現一次**）並要求首次登入改密碼；
    給了密碼的也要過政策。逐列回報，一列失敗不影響其他列。"""
    body = await request.json()
    items = _parse_batch(body)
    if len(items) > BATCH_MAX:
        raise HTTPException(status_code=422, detail={"code": "TOO_MANY", "max": BATCH_MAX})
    principal = getattr(request.state, "principal", None)
    users = await app.user_store_async()
    created: list[dict[str, Any]] = []
    errors: list[dict[str, Any]] = []
    for it in items:
        n = int(it["line"])
        username = str(it.get("username") or "").strip()
        given = str(it.get("password") or "")
        password = given or generate_temp_password()
        problems = password_problems(password, username) if given else []
        if not username:
            problems = ["帳號必填", *problems]
        if problems:
            errors.append({"line": n, "username": username, "message": "；".join(problems)})
            continue
        try:
            row = await users.create(
                username=username,
                password=password,
                role=str(it.get("role") or "contourer").strip().lower(),
                display_name=str(it.get("display_name") or ""),
                created_by=principal.username if principal else "",
                must_change_password=True,
            )
        except ValueError as exc:
            errors.append({"line": n, "username": username, "message": str(exc)})
            continue
        created.append(
            {
                "username": row.username,
                "display_name": row.display_name,
                "role": row.role,
                **({"temp_password": password} if not given else {}),
            }
        )
    return {"created": created, "errors": errors}
