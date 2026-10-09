"""plugin 端點。三組：

1. 管理與清單（使用者身分）：`GET /plugins`、`POST /plugins`（admin）、`PATCH／DELETE /plugins/{id}`（admin）、
   `POST /plugins/{id}/refresh`（admin）、`POST /plugins/register`（plugin 自我登錄，registration token）。
2. 使用（使用者身分，角色 ≥ manifest.required_role）：`POST /plugins/{id}/run`、`DELETE /plugins/{id}/jobs/{job}`、
   `/plugins/{id}/kv/{key}`（user 命名空間）、`ANY /modules/{id}/{path}` 代理。
3. 回呼（**job token**，不是使用者 cookie；`auth.required_role_for` 對這些路徑回 None）：
   `/plugins/{id}/jobs/{job}/inputs/image`、`…/inputs/structures[/{sid}]`、`…/progress`、`…/results`、`…/done`、`…/audit`、`…/kv/{key}`。
"""

from __future__ import annotations

import json
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Request, Response
from fastapi.responses import JSONResponse

from ..i18n import localized_route_class
from ..plugins import PluginError
from .deps import API, AppState, actor, readable_structure_ids, state

router = APIRouter(route_class=localized_route_class())  # 錯誤、原因等句子依請求語言翻


def _principal(request: Request) -> Any:
    return getattr(request.state, "principal", None)


def _role(request: Request) -> str:
    p = _principal(request)
    return str(p.role) if p is not None else "admin"


def _is_admin(request: Request) -> bool:
    p = _principal(request)
    return p is None or p.at_least("admin")


def _at_least(request: Request, role: str) -> bool:
    p = _principal(request)
    return p is None or p.at_least(role)


def _require_admin(request: Request) -> None:
    if not _is_admin(request):
        raise HTTPException(403, {"code": "PL-ROLE", "message": "需要 admin"})


def _err(exc: PluginError) -> JSONResponse:
    return JSONResponse(status_code=exc.status, content=exc.to_wire())


def _bearer(request: Request) -> str | None:
    h = request.headers.get("Authorization", "")
    return h[7:].strip() if h.lower().startswith("bearer ") else None


# ── 1. 管理與清單 ─────────────────────────────────────────────────────────────


@router.get(API + "/plugins")
async def list_plugins(request: Request, app: AppState = Depends(state)) -> list[dict[str, Any]]:
    pm = await app.plugins_async()
    admin = _is_admin(request)
    return [rec.to_wire(admin=admin, allowed=_at_least(request, rec.required_role)) for rec in await pm.list()]


@router.post(API + "/plugins", status_code=201)
async def register_plugin(request: Request, app: AppState = Depends(state)) -> Any:
    _require_admin(request)
    body = await request.json()
    pm = await app.plugins_async()
    try:
        rec = await pm.register(
            endpoint=str(body.get("endpoint", "")).strip(),
            token=str(body.get("token", "")),
            by=actor(request),
            allow_licenses=list(body.get("allow_licenses", [])),
        )
    except PluginError as exc:
        return _err(exc)
    return rec.to_wire(admin=True, allowed=True)


@router.post(API + "/plugins/register", status_code=201)
async def self_register(request: Request, app: AppState = Depends(state)) -> Any:
    """plugin 自我登錄：`Authorization: Bearer <RTGAIA_PLUGIN_REGISTRATION_TOKEN>`；body `{endpoint, token}`。"""
    pm = await app.plugins_async()
    if not pm.registration_token or _bearer(request) != pm.registration_token:
        raise HTTPException(403, {"code": "PL-SCOPE", "message": "registration token 不符或未設定"})
    body = await request.json()
    try:
        rec = await pm.register(
            endpoint=str(body["endpoint"]).strip(), token=str(body.get("token", "")), by="self-register"
        )
    except PluginError as exc:
        return _err(exc)
    return rec.to_wire(admin=True, allowed=True)


@router.get(API + "/plugins/{plugin_id}")
async def get_plugin(plugin_id: str, request: Request, app: AppState = Depends(state)) -> Any:
    pm = await app.plugins_async()
    try:
        rec = await pm.get(plugin_id)
    except PluginError as exc:
        return _err(exc)
    return rec.to_wire(admin=_is_admin(request), allowed=_at_least(request, rec.required_role))


@router.patch(API + "/plugins/{plugin_id}")
async def update_plugin(plugin_id: str, request: Request, app: AppState = Depends(state)) -> Any:
    _require_admin(request)
    pm = await app.plugins_async()
    try:
        rec = await pm.update(plugin_id, await request.json(), by=actor(request))
    except PluginError as exc:
        return _err(exc)
    return rec.to_wire(admin=True, allowed=True)


@router.delete(API + "/plugins/{plugin_id}", status_code=204)
async def delete_plugin(plugin_id: str, request: Request, app: AppState = Depends(state)) -> Response:
    _require_admin(request)
    pm = await app.plugins_async()
    try:
        await pm.remove(plugin_id, by=actor(request))
    except PluginError as exc:
        return _err(exc)
    return Response(status_code=204)


@router.post(API + "/plugins/{plugin_id}/refresh")
async def refresh_plugin(plugin_id: str, request: Request, app: AppState = Depends(state)) -> Any:
    _require_admin(request)
    pm = await app.plugins_async()
    try:
        rec = await pm.refresh(await pm.get(plugin_id))
    except PluginError as exc:
        return _err(exc)
    return rec.to_wire(admin=True, allowed=True)


# ── 2. 使用 ──────────────────────────────────────────────────────────────────


async def _active_for_user(request: Request, app: AppState, plugin_id: str) -> Any:
    pm = await app.plugins_async()
    rec = await pm.get_active(plugin_id)
    if not _at_least(request, rec.required_role):
        raise PluginError("PL-ROLE", f"需要 {rec.required_role}", status=403)
    return pm, rec


@router.post(API + "/plugins/{plugin_id}/run", status_code=202)
async def run_plugin(plugin_id: str, request: Request, app: AppState = Depends(state)) -> Any:
    """以使用者身分建 job。body `{params, image_series_id?, structure_ids?, study_id?|session_id?}`。"""
    try:
        pm, rec = await _active_for_user(request, app, plugin_id)
    except PluginError as exc:
        return _err(exc)
    body = await request.json() if await request.body() else {}
    params = body.get("params") or {}
    schema = (rec.manifest.get("inputs") or {}).get("params_schema")
    if schema:
        from jsonschema import Draft202012Validator

        errors = sorted(Draft202012Validator(schema).iter_errors(params), key=lambda e: list(e.absolute_path))
        if errors:
            e = errors[0]
            return _err(
                PluginError(
                    "PL-SCHEMA",
                    f"params 不符 params_schema：{e.message}",
                    pointer="/" + "/".join(map(str, e.absolute_path)),
                )
            )
    user = actor(request)
    try:
        if body.get("session_id"):
            session_id = str(body["session_id"])
            session = app.store.get(session_id)
            if session.user != user:  # 2026-10-09：別人的 session 不能拿來跑（輸入是他的病例、結果進他的暫存）
                raise KeyError(f"沒有 session {session_id}")
        elif body.get("study_id"):
            session = app.store.by_study(str(body["study_id"]), user=user)
        else:
            # 2026-09-30：沒給 study／session → 這個人自己的 current（以前是全域 current，多人時可能拿到別人的）
            session = app.store.by_study_or_current(None, user=user)
    except KeyError as exc:
        return _err(PluginError("PL-SCHEMA", f"找不到 session：{exc}", status=404))
    # 送給 plugin 的結構一律經共用讀取閘（別人的暫存結果 404，不會被當輸入送出去）
    structure_ids = readable_structure_ids(session, [str(s) for s in body.get("structure_ids") or []], request)
    try:
        job = await pm.start_run(
            rec,
            session=session,
            principal_name=user,
            params=params,
            image_series_id=body.get("image_series_id"),
            structure_ids=structure_ids,
            actor_role=_role(request),
        )
    except PluginError as exc:
        return _err(exc)
    return {"job_id": job.job_id, "case_id": job.case_id, "status": job.status}


@router.delete(API + "/plugins/{plugin_id}/jobs/{job_id}", status_code=204)
async def cancel_plugin_job(plugin_id: str, job_id: str, request: Request, app: AppState = Depends(state)) -> Response:
    pm = await app.plugins_async()
    async with pm.job_lock(job_id):
        job = await (await app.job_queue_async()).get(job_id)
        if job is None or job.request.get("plugin_id") != plugin_id:
            raise HTTPException(404, {"code": "NO_JOB", "job_id": job_id})
        if job.requested_by != actor(request) and not _is_admin(request):
            raise HTTPException(403, {"code": "PL-ROLE", "message": "只能取消自己的 job"})
        await pm.cancel(job, by=actor(request))
    return Response(status_code=204)


async def user_kv(plugin_id: str, key: str, request: Request, app: AppState = Depends(state)) -> Any:
    """使用者側 KV：`user/…` 以登入者隔離；`plugin/…` 只有 admin 能寫。"""
    try:
        pm, rec = await _active_for_user(request, app, plugin_id)
        ns, _, k = key.partition("/")
        if ns not in ("user", "plugin") or not k:
            raise PluginError("PL-SCHEMA", "key 要是 user/<key> 或 plugin/<key>")
        namespace = f"user:{actor(request)}" if ns == "user" else "plugin"
        if request.method == "GET":
            return await pm.kv_get(plugin_id, namespace, k)
        if ns == "plugin" and not _is_admin(request):
            raise PluginError("PL-ROLE", "plugin 命名空間只有 admin 能寫", status=403)
        if request.method == "PUT":
            await pm.kv_put(plugin_id, namespace, k, await request.json(), by=actor(request))
        else:
            await pm.kv_delete(plugin_id, namespace, k, by=actor(request))
        return Response(status_code=204)
    except PluginError as exc:
        return _err(exc)


async def proxy_module(plugin_id: str, path: str, request: Request, app: AppState = Depends(state)) -> Response:
    """代理到 plugin 自訂端點；先驗角色，再帶 `X-RTGaia-Actor`／`X-RTGaia-Role`。"""
    try:
        pm, rec = await _active_for_user(request, app, plugin_id)
        upstream = await pm.proxy(
            rec,
            method=request.method,
            path=path,
            query=request.url.query,
            body=await request.body(),
            content_type=request.headers.get("content-type"),
            actor=actor(request),
            role=_role(request),
        )
    except PluginError as exc:
        return _err(exc)
    passthrough = {
        k: v
        for k, v in upstream.headers.items()
        if k.lower() in ("content-type", "cache-control", "etag", "x-rtgaia-engine")
    }
    return Response(content=upstream.content, status_code=upstream.status_code, headers=passthrough)


@router.get(API + "/plugins/{plugin_id}/ui/{path:path}")
async def plugin_ui(plugin_id: str, path: str, request: Request, app: AppState = Depends(state)) -> Response:
    """UI bundle 一定經宿主代理（同源 → COEP 不擋）。登入即可（viewer）；stale 版本靠 `?v=` 破快取。

    只代理 manifest 宣告的那支 bundle，內容 sha256 必須等於登錄時釘住的 digest（`proxy_ui`）。"""
    pm = await app.plugins_async()
    try:
        rec = await pm.get_active(plugin_id)
        upstream = await pm.proxy_ui(rec, path, actor=actor(request), role=_role(request))
    except PluginError as exc:
        return _err(exc)
    media = upstream.headers.get("content-type", "application/octet-stream")
    if path.endswith(".js") or path.endswith(".mjs"):
        media = "text/javascript"
    return Response(
        content=upstream.content,
        status_code=upstream.status_code,
        headers={"Content-Type": media, "Cache-Control": "no-cache"},
    )


# ── 3. 回呼（job token）─────────────────────────────────────────────────────

CB = API + "/plugins/{plugin_id}/jobs/{job_id}"


async def _cb_job(request: Request, app: AppState, plugin_id: str, job_id: str, capability: str | None) -> Any:
    pm = await app.plugins_async()
    return pm, await pm.job_for_callback(plugin_id, job_id, _bearer(request), capability)


@router.get(CB + "/inputs/image")
async def cb_image(plugin_id: str, job_id: str, request: Request, app: AppState = Depends(state)) -> Response:
    try:
        pm, job = await _cb_job(request, app, plugin_id, job_id, "read-image")
        from rtgaia_plugin_sdk.geometry import grid_to_json

        data, grid, content_hash = await pm.image_nifti(job)
    except PluginError as exc:
        return _err(exc)
    return Response(
        content=data,
        media_type="application/gzip",
        headers={"X-RTGaia-Grid": json.dumps(grid_to_json(grid)), "X-RTGaia-Content-Hash": content_hash},
    )


@router.get(CB + "/inputs/structures")
async def cb_structures(plugin_id: str, job_id: str, request: Request, app: AppState = Depends(state)) -> Any:
    try:
        pm, job = await _cb_job(request, app, plugin_id, job_id, "read-structures")
    except PluginError as exc:
        return _err(exc)
    case = await app.case_async(job.case_id)  # 不依賴 API 的 session
    wanted = set(job.request.get("structure_ids") or [])
    rows = case.structure_list(user=job.requested_by)
    return [s for s in rows if not wanted or s.get("structure_id") in wanted]


@router.get(CB + "/inputs/structures/{structure_id}")
async def cb_structure_mask(
    plugin_id: str, job_id: str, structure_id: str, request: Request, app: AppState = Depends(state)
) -> Response:
    try:
        pm, job = await _cb_job(request, app, plugin_id, job_id, "read-masks")
        if structure_id not in (job.request.get("structure_ids") or []):
            raise PluginError("PL-SCOPE", "這個結構不在 RunRequest 的輸入內", status=403)
        data = await pm.structure_nifti(job, structure_id)
    except PluginError as exc:
        return _err(exc)
    except KeyError as exc:
        return _err(PluginError("PL-SCHEMA", str(exc), status=404))
    return Response(content=data, media_type="application/gzip")


# 會改工作列的回呼（進度、結果、完成）在 `job_lock` 裡做、進去後重新驗一次：跟輪詢、逾時、取消不交錯，
# 也不會兩個回呼各拿一份副本、後寫的蓋掉先寫的。


@router.post(CB + "/progress", status_code=204)
async def cb_progress(plugin_id: str, job_id: str, request: Request, app: AppState = Depends(state)) -> Response:
    body = await request.json()
    pm = await app.plugins_async()
    async with pm.job_lock(job_id):
        try:
            _, job = await _cb_job(request, app, plugin_id, job_id, None)
        except PluginError as exc:
            return _err(exc)
        await pm.progress(job, float(body.get("percent", job.percent)), body.get("phase"))
    return Response(status_code=204)


@router.post(CB + "/results")
async def cb_results(plugin_id: str, job_id: str, request: Request, app: AppState = Depends(state)) -> Any:
    body = await request.json()
    pm = await app.plugins_async()
    async with pm.job_lock(job_id):
        try:
            _, job = await _cb_job(request, app, plugin_id, job_id, "write-transient")
            if job.status != "running":
                raise PluginError("PL-SCOPE", f"job 狀態 {job.status}，不再收結果", status=409)
            return await pm.accept_results(job, body)
        except PluginError as exc:
            return _err(exc)


@router.post(CB + "/done", status_code=204)
async def cb_done(plugin_id: str, job_id: str, request: Request, app: AppState = Depends(state)) -> Response:
    body = await request.json()
    pm = await app.plugins_async()
    async with pm.job_lock(job_id):
        return await _done(pm, request, app, plugin_id, job_id, body)


async def _done(pm: Any, request: Request, app: AppState, plugin_id: str, job_id: str, body: dict) -> Response:
    try:
        _, job = await _cb_job(request, app, plugin_id, job_id, None)
    except PluginError as exc:
        return _err(exc)
    if body.get("status") != "done":
        await pm.finish(job, status="failed", error=str(body.get("error") or "plugin 回報失敗"))
    elif job.request.get("progress_mode") == "poll":
        # poll 模式：結果要由宿主去拉（D.4）；plugin 打 /done 只是提早通知，拉不到就交給 tick 重試
        await pm._poll(job)
    else:
        await pm._finish_from_outcome(
            job,
            {
                "accepted": [1] * int(job.result.get("accepted", 0)),
                "rejected": [{"code": "B?", "reason": "見 job.result"}] * int(job.result.get("rejected", 0)),
            },
        )
    return Response(status_code=204)


@router.post(CB + "/audit", status_code=204)
async def cb_audit(plugin_id: str, job_id: str, request: Request, app: AppState = Depends(state)) -> Response:
    try:
        _, job = await _cb_job(request, app, plugin_id, job_id, "audit")
    except PluginError as exc:
        return _err(exc)
    body = await request.json()
    from ..audit_events import new_event

    await app.audit(
        new_event(
            user=job.requested_by,
            action=f"plugin.{body.get('kind', 'event')}",
            status=200,
            object_type="plugin",
            object_id=plugin_id,
            case_id=job.case_id,
            client_id=None,
            remote_addr=None,
            detail={"module": plugin_id, "job_id": job_id, **(body.get("payload") or {})},
        )
    )
    return Response(status_code=204)


async def cb_kv(plugin_id: str, job_id: str, key: str, request: Request, app: AppState = Depends(state)) -> Any:
    try:
        pm, job = await _cb_job(request, app, plugin_id, job_id, "kv")
        ns, _, k = key.partition("/")
        if ns not in ("user", "plugin") or not k:
            raise PluginError("PL-SCHEMA", "key 要是 user/<key> 或 plugin/<key>")
        namespace = f"user:{job.requested_by}" if ns == "user" else "plugin"
        if request.method == "GET":
            return await pm.kv_get(plugin_id, namespace, k)
        if request.method == "PUT":
            await pm.kv_put(plugin_id, namespace, k, await request.json(), by=f"plugin:{plugin_id}")
        else:
            await pm.kv_delete(plugin_id, namespace, k, by=f"plugin:{plugin_id}")
        return Response(status_code=204)
    except PluginError as exc:
        return _err(exc)


def _multi(path: str, endpoint: Any, methods: list[str]) -> None:
    """同一個處理函式掛多個方法：每個方法一條路由、各自的 name，OpenAPI operation id 才不會重複。"""
    for m in methods:
        router.add_api_route(path, endpoint, methods=[m], name=f"{endpoint.__name__}_{m.lower()}")


_multi(API + "/plugins/{plugin_id}/kv/{key:path}", user_kv, ["GET", "PUT", "DELETE"])
_multi(API + "/modules/{plugin_id}/{path:path}", proxy_module, ["GET", "POST", "PUT", "PATCH", "DELETE"])
_multi(CB + "/kv/{key:path}", cb_kv, ["GET", "PUT", "DELETE"])
