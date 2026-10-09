"""FastAPI 應用組裝。"""

from __future__ import annotations

import asyncio
import os
from collections.abc import AsyncIterator, Callable
from contextlib import asynccontextmanager
from typing import Any
from urllib.parse import urlsplit

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from rtgaia_geom import ContractViolation
from rtgaia_geom import __version__ as geom_version

from .. import render3d_vtk
from ..auth import COOKIE_NAME, Principal, load_secret, required_role_for
from ..i18n import current_lang, lang_from_header, translate, translate_detail
from ..limits import USERNAME_MAX
from ..state import ConflictError
from . import (
    routes_auth,
    routes_cases,
    routes_catalog,
    routes_dimse,
    routes_dose,
    routes_dose_ops,
    routes_events,
    routes_export_records,
    routes_grids,
    routes_import,
    routes_library,
    routes_measurements,
    routes_misc,
    routes_plan,
    routes_plugins,
    routes_retention,
    routes_series,
    routes_storage,
    routes_structure_sets,
    routes_structures,
    routes_temporal,
    routes_temporal_structures,
    routes_transient,
)
from .deps import API, AppState, AuditUnavailable

__all__ = ["API", "AppState", "create_app"]

#: `/readyz`：行程內 worker 閒著卻超過這麼久沒 tick → 不就緒。
WORKER_STALE_SECONDS = 60.0
#: `/readyz`：事件匯流排的 LISTEN 連線斷了超過這麼久 → 不就緒（收不到別的行程的推送）。
BUS_DOWN_SECONDS = 30.0


def _is_plugin_callback_path(path: str) -> bool:
    parts = path.split("/")
    return len(parts) > 7 and parts[:4] == ["", "api", "v1", "plugins"] and parts[5] == "jobs"


def _object_of(params: dict[str, Any]) -> tuple[str | None, str | None]:
    if "level" in params and "key" in params:  # /catalog/{level}/{key}（下載、刪除）
        return str(params["level"]), str(params["key"])
    for key in ("structure_id", "measurement_id", "case_id", "study_id", "batch_id", "job_id", "user_id", "series_id"):
        if key in params:
            return key[:-3], str(params[key])
    return None, None


def create_app(
    *,
    latency_ms: int = 0,
    chaos: dict[str, Any] | None = None,
    library_root: str | None = None,
    show_patient_names: bool | None = None,
    db_url: str | None = None,
    auth: str | None = None,
    test_api: bool | None = None,
    adapters: Any = None,
    test_api_installer: Callable[[FastAPI, AppState], None] | None = None,
    public_url: str | None = None,
    allowed_hosts: list[str] | None = None,
) -> FastAPI:
    """`public_url`／`allowed_hosts`：宿主對外位址是**部署設定**，不是第一個 request 的 Host。
    參數 > `RTGAIA_PUBLIC_URL`／`RTGAIA_ALLOWED_HOSTS`；`auth=required` 時 `public_url` 必填，缺了就讓部署明確失敗。
    `allowed_hosts` 沒給就由 `public_url` 的 host 推導（＋ localhost／127.0.0.1）；偽造 Host 的 `/api/v1/*` 請求回 400。

    `test_api`：是否掛載 `/api/v1/_test/*`（假體載入、任意推送、直接注入 mask、全域 chaos）。

    參數 > 環境變數 `RTGAIA_TEST_API` > **預設 False**。這組端點繞過擁有者、
    approved lock、版本鏈與持久化，又被稽核排除；只要掛在正式 app 上，任何 contourer 都能覆寫
    已簽核的輪廓而不留紀錄。測試與開發入口（driver、e2e、`scripts/dev.sh`）明確打開它。
    """
    app = FastAPI(
        title="RT-Gaia API",
        version="0.1.0",
        description=(
            "RT-Gaia 的後端：目錄、病例、結構版本鏈、簽核、匯出、DIMSE、plugin 宿主。"
            "合成假體與故障注入只在 `test_api=True` 時掛載。"
        ),
    )
    # UID 設定不合法就拒絕啟動（不默默產生壞 UID）
    from ..dicom_uid import uid_config_problems

    uid_problems = uid_config_problems()
    if uid_problems:
        raise ValueError("DICOM UID 設定錯誤：" + "；".join(uid_problems))
    state = AppState()
    state.adapters = adapters  # SQL 實作（rtgaia_server）；None ＝ 純記憶體
    state.chaos.latency_ms = latency_ms
    if chaos:
        state.chaos.update(chaos)
    # 資料庫：參數 > 環境變數；沒設就沒有資料庫，資料頁只列假體
    state.library_root = library_root if library_root is not None else os.environ.get("RTGAIA_LIBRARY_ROOT", "")
    state.show_patient_names = (
        show_patient_names
        if show_patient_names is not None
        else os.environ.get("RTGAIA_LIBRARY_SHOW_NAMES", "") in ("1", "true", "yes")
    )
    # 目錄持久化：參數 > 環境變數；沒設就沒有 DB（目錄只在記憶體 ＋ JSON 快取）
    state.db_url = db_url if db_url is not None else os.environ.get("RTGAIA_DB_URL", "")
    # 身分：有 DB 預設 required；沒有 DB 只能 off（帳號在 DB 裡）
    requested = (auth if auth is not None else os.environ.get("RTGAIA_AUTH", "")).strip().lower()
    state.auth_mode = requested or ("required" if state.db_url else "off")
    if state.auth_mode == "required" and not state.db_url:
        raise ValueError("RTGAIA_AUTH=required 需要 RTGAIA_DB_URL（帳號在 Postgres）")
    if state.auth_mode not in ("required", "off"):
        raise ValueError(f"RTGAIA_AUTH 必須是 required 或 off，收到 {state.auth_mode!r}")
    state.secret = load_secret()
    # public URL 與可信 Host 都是設定；先前「第一個 request 的 Host 記成全域」已移除
    configured_public = (public_url if public_url is not None else os.environ.get("RTGAIA_PUBLIC_URL", "")).strip()
    if configured_public:
        parsed = urlsplit(configured_public)
        if parsed.scheme not in ("http", "https") or not parsed.netloc or parsed.path not in ("", "/") or parsed.query:
            raise ValueError(f"RTGAIA_PUBLIC_URL 必須是 http(s)://host[:port]，收到 {configured_public!r}")
        state.public_url = configured_public.rstrip("/")
    elif state.auth_mode == "required":
        raise ValueError("RTGAIA_AUTH=required 需要 RTGAIA_PUBLIC_URL（plugin 回呼與 Host 驗證都以它為準）")
    hosts_raw = (
        allowed_hosts
        if allowed_hosts is not None
        else [h for h in os.environ.get("RTGAIA_ALLOWED_HOSTS", "").split(",") if h.strip()]
    )
    if hosts_raw:
        state.allowed_hosts = {h.strip().lower() for h in hosts_raw}
    elif state.public_url:
        host = urlsplit(state.public_url).hostname or ""
        state.allowed_hosts = {host.lower(), "localhost", "127.0.0.1"}
    else:
        state.allowed_hosts = None  # 開發／off 模式沒設就不判
    # 有 DB 才敢把沒人看的 library 病例從記憶體淘汰（能從 DB／檔案重建）
    state.store.evict_library_cases = bool(state.db_url)
    state.test_api = (
        test_api
        if test_api is not None
        else os.environ.get("RTGAIA_TEST_API", "").strip().lower() in ("1", "true", "yes")
    )
    state.inprocess_worker = os.environ.get("RTGAIA_INPROCESS_WORKER", "1").strip() not in ("0", "false", "no")
    app.state.rtgaia = state

    async def _start_worker() -> None:
        # 先訂閱匯流排（DB 模式 LISTEN），再決定要不要在 API 行程裡跑 worker
        state.loop = asyncio.get_running_loop()
        try:
            await state.bus_async()
        except Exception:  # noqa: BLE001 - DB 還沒好：第一個請求會再試
            pass
        # 接收端照設定（env 預設 `RTGAIA_SCP`／`RTGAIA_SCP_PORT`，DB `app_setting.dimse` 覆寫）
        # 在 API 行程起；`RTGAIA_SCP_OWNER=0` → 交給獨立 `rtgaia-scp` 行程（它訂閱匯流排，設定改了自己重啟）
        state.scp_owner = os.environ.get("RTGAIA_SCP_OWNER", "1").strip() not in ("0", "false", "no")
        try:
            await state.dimse_settings_async()
            await state.apply_dimse_settings(force=True)
        except Exception as exc:  # noqa: BLE001 - DB 還沒好／port 被佔：不擋 API 啟動
            state.scp_error = str(exc)
        if state.inprocess_worker:
            from ..jobs import worker_loop

            state.worker_task = asyncio.create_task(worker_loop(state))
        # plugin 健康檢查／poll／逾時；`RTGAIA_PLUGIN_TICK_SECONDS=0` 關掉（測試自己呼叫 tick）
        tick_seconds = float(os.environ.get("RTGAIA_PLUGIN_TICK_SECONDS", "5"))
        if tick_seconds > 0:

            async def _plugin_ticks() -> None:
                while True:
                    await asyncio.sleep(tick_seconds)
                    try:
                        await (await state.plugins_async()).tick()
                    except Exception:  # noqa: BLE001 - 健康檢查失敗不能拖垮 API
                        pass

            state.plugin_tick_task = asyncio.create_task(_plugin_ticks())
        # 暫存區過期清除（封存區不動）；`RTGAIA_RETENTION_TICK_SECONDS=0` 關掉（測試自己呼叫 retention_tick）
        retention_seconds = float(os.environ.get("RTGAIA_RETENTION_TICK_SECONDS", "3600"))
        if retention_seconds > 0:
            from ..retention import retention_tick

            async def _retention_ticks() -> None:
                while True:
                    try:
                        await retention_tick(state)
                    except Exception:  # noqa: BLE001 - 清理失敗不能拖垮 API；下一輪再試
                        pass
                    await asyncio.sleep(retention_seconds)

            state.retention_task = asyncio.create_task(_retention_ticks())
        # 容量監看（預設每 5 分鐘）與完整性巡檢（預設每天一輪）；各自 `=0` 關掉（測試自己呼叫）
        storage_seconds = float(os.environ.get("RTGAIA_STORAGE_TICK_SECONDS", "300"))
        if storage_seconds > 0:

            async def _storage_ticks() -> None:
                while True:
                    try:
                        await state.storage_check()
                    except Exception:  # noqa: BLE001 - 量不到不能拖垮 API
                        pass
                    await asyncio.sleep(storage_seconds)

            state.storage_task = asyncio.create_task(_storage_ticks())
        integrity_seconds = float(os.environ.get("RTGAIA_INTEGRITY_TICK_SECONDS", "86400"))
        if integrity_seconds > 0:

            async def _integrity_ticks() -> None:
                await asyncio.sleep(min(600.0, integrity_seconds))  # 啟動後先讓索引與 DB 就緒
                while True:
                    try:
                        await state.integrity_tick()
                    except Exception:  # noqa: BLE001
                        pass
                    await asyncio.sleep(integrity_seconds)

            state.integrity_task = asyncio.create_task(_integrity_ticks())
        # 稽核待送重送；`RTGAIA_AUDIT_FLUSH_SECONDS=0` 關掉（測試自己呼叫 flush_audit_outbox）
        flush_seconds = float(os.environ.get("RTGAIA_AUDIT_FLUSH_SECONDS", "5"))
        if flush_seconds > 0 and state.db_url:

            async def _audit_flush_ticks() -> None:
                while True:
                    await asyncio.sleep(flush_seconds)
                    await state.flush_audit_outbox()

            state.audit_flush_task = asyncio.create_task(_audit_flush_ticks())

    async def _dispose_db() -> None:
        render3d_vtk.shutdown_scenes()
        if getattr(state, "plugin_tick_task", None) is not None:
            state.plugin_tick_task.cancel()
        if getattr(state, "audit_flush_task", None) is not None:
            state.audit_flush_task.cancel()
        if getattr(state, "retention_task", None) is not None:
            state.retention_task.cancel()
        for name in ("storage_task", "integrity_task"):
            if getattr(state, name, None) is not None:
                getattr(state, name).cancel()
        if state.plugins is not None:
            await state.plugins.close()
        if state.worker_task is not None:
            state.worker_task.cancel()
            try:
                await state.worker_task
            except (asyncio.CancelledError, Exception):  # noqa: BLE001
                pass
        state.stop_scp()
        if state.bus is not None:
            await state.bus.stop()
        if state.catalog_store is not None:
            await state.catalog_store.dispose()

    # `on_event` 已棄用（每建一個 app 一則 DeprecationWarning，
    # 測試裡上千則）→ lifespan。
    # 啟動與關閉的內容不變；關閉放在 finally —— 啟動途中出例外也會取消已經起來的背景工作。
    @asynccontextmanager
    async def _lifespan(_app: FastAPI) -> AsyncIterator[None]:
        try:
            await _start_worker()
            yield
        finally:
            await _dispose_db()

    app.router.lifespan_context = _lifespan

    # 🔴 前端在 dev server（不同 port）上跑，且 Tier C 需要 COOP/COEP
    # （缺少時 CPU 路徑會退化成單執行緒，約慢 8 倍）。
    app.add_middleware(
        CORSMiddleware,
        allow_origins=["*"],
        allow_credentials=False,
        allow_methods=["*"],
        allow_headers=["*"],
        expose_headers=["*"],
    )

    @app.middleware("http")
    async def authenticate(request: Request, call_next):  # type: ignore[no-untyped-def]
        """解 cookie／Bearer → `request.state.principal`；required 模式擋 401／403。

        角色規則（`auth.required_role_for`）：GET 至少 viewer、非 GET 至少 contourer、`/review` 至少 approver、
        `/auth/users` admin。`off` 模式：principal 來自 `X-RTGaia-User`／`X-RTGaia-Role`（缺省 admin）。
        """
        path = request.url.path
        needed = required_role_for(request.method, path)
        principal = None
        if state.auth_mode == "required":
            # Bearer 優先於 cookie：同一個瀏覽器／client 可以明確切換身分（測試、腳本）
            auth_header = request.headers.get("Authorization", "")
            token = auth_header[7:].strip() if auth_header.lower().startswith("bearer ") else None
            if not token:
                token = request.cookies.get(COOKIE_NAME)
            if token:
                try:
                    principal = await state.principal_for_token(token)
                except Exception:  # noqa: BLE001 - DB 掛了就當沒登入，讓 401 說話
                    principal = None
        else:
            username = (request.headers.get("X-RTGaia-User") or "anonymous").strip() or "anonymous"
            role = (request.headers.get("X-RTGaia-Role") or "admin").strip() or "admin"
            if len(username) > USERNAME_MAX:
                # 帳號會寫進 created_by／updated_by（64 字）：超過就整個病例之後都存不進 DB
                return JSONResponse(
                    status_code=400,
                    content={
                        "code": "BAD_USER",
                        "message": translate("X-RTGaia-User 太長"),
                        "max_length": USERNAME_MAX,
                    },
                )
            principal = Principal(
                user_id=f"stub:{username}", username=username, display_name=username, role=role, source="stub"
            )
        request.state.principal = principal
        # 臨時密碼的帳號在改密碼之前只能做這幾件事（伺服器端擋，不只靠前端）
        if (
            principal is not None
            and getattr(principal, "must_change_password", False)
            and path.startswith("/api/v1/")
            and path
            not in ("/api/v1/auth/status", "/api/v1/auth/me", "/api/v1/auth/me/password", "/api/v1/auth/logout")
        ):
            return JSONResponse(
                status_code=403,
                content={"code": "PASSWORD_CHANGE_REQUIRED", "message": translate("請先修改臨時密碼")},
            )
        if needed is not None:
            if principal is None:
                return JSONResponse(
                    status_code=401, content={"code": "AUTH_REQUIRED", "message": translate("請先登入")}
                )
            if path.startswith("/api/v1/auth/users") and not principal.at_least("admin"):
                return JSONResponse(
                    status_code=403, content={"code": "FORBIDDEN", "needed": "admin", "role": principal.role}
                )
            if not principal.at_least(needed):
                return JSONResponse(
                    status_code=403, content={"code": "FORBIDDEN", "needed": needed, "role": principal.role}
                )
        return await call_next(request)

    @app.middleware("http")
    async def audit_writes(request: Request, call_next):  # type: ignore[no-untyped-def]
        """每個成功的寫入（非 GET、`/api/v1/*`、非 `_test`／auth login）記一筆 `audit_event`。

        內容層的「改成什麼」在版本鏈與簽核事件；這裡是「誰、何時、對哪個物件、做了什麼」，append-only。
        """
        response = await call_next(request)
        path = request.url.path
        if (
            request.method in ("GET", "HEAD", "OPTIONS")
            or not path.startswith("/api/v1/")
            # `_test` 排除只在 `test_api=True` 的 app 有意義（生產 app 不掛那組 router）
            or path.startswith("/api/v1/_test/")
            or path.startswith("/api/v1/auth/login")
            or path.startswith("/api/v1/auth/logout")
            or _is_plugin_callback_path(path)  # plugin 回呼自己寫帶 module 的稽核（results／audit）
            or response.status_code >= 400
        ):
            return response
        from ..audit_events import new_event

        params = dict(request.scope.get("path_params") or {})
        route = request.scope.get("route")
        template = getattr(route, "path", path)
        object_type, object_id = _object_of(params)
        principal = getattr(request.state, "principal", None)
        client_id = request.headers.get("X-RTGaia-Client")
        try:
            await state.audit(
                new_event(
                    user=principal.username if principal else "anonymous",
                    action=f"{request.method} {template}",
                    status=response.status_code,
                    object_type=object_type,
                    object_id=object_id,
                    case_id=params.get("case_id"),
                    client_id=client_id,
                    remote_addr=request.client.host if request.client else None,
                    # 路由可以在 `request.state.audit_detail` 補內容（例：DVH 匯出的格式、是否匿名）
                    detail={"path_params": params, **(getattr(request.state, "audit_detail", None) or {})},
                )
            )
        except AuditUnavailable as exc:
            # 業務變更已發生、稽核兩邊都寫不進去 → 明確告知，不回 200
            return JSONResponse(
                status_code=503,
                content={
                    "code": "AUDIT_UNAVAILABLE",
                    "message": translate("操作已執行但稽核無法記錄；請通知管理者"),
                    "detail": str(exc)[:300],
                },
            )
        return response

    @app.middleware("http")
    async def chaos_latency(request: Request, call_next):  # type: ignore[no-untyped-def]
        """chaos: `latency:N` —— 驗證載入指示、漸進式 lod、不得出現空白畫面。"""
        if state.allowed_hosts is not None and request.url.path.startswith("/api/v1/"):
            # Host 不在白名單 → 400。只看 `/api/v1/*`（`/healthz` 給容器健康檢查，不帶對外 Host）
            host = (request.headers.get("host") or "").lower()
            if host not in state.allowed_hosts and host.split(":")[0] not in state.allowed_hosts:
                return JSONResponse(
                    status_code=400, content={"code": "BAD_HOST", "message": translate(f"Host {host!r} 不在白名單")}
                )
        if state.chaos.latency_ms:
            await asyncio.sleep(state.chaos.latency_ms / 1000.0)
        response = await call_next(request)
        # Tier C 的 SharedArrayBuffer 需要這兩個標頭（部署必檢項）
        response.headers.setdefault("Cross-Origin-Opener-Policy", "same-origin")
        response.headers.setdefault("Cross-Origin-Embedder-Policy", "require-corp")
        response.headers.setdefault("Cross-Origin-Resource-Policy", "cross-origin")
        return response

    @app.exception_handler(ContractViolation)
    async def contract_violation(_request: Request, exc: ContractViolation) -> JSONResponse:
        """契約違反一律 400 ＋ 機器可讀的 code（I1/I3/I5/…）。"""
        return JSONResponse(
            status_code=400,
            content={
                "code": exc.code,
                "message": translate(str(exc).split("\n")[0]),
                "context": {k: repr(v) for k, v in exc.context.items()},
            },
        )

    @app.exception_handler(ConflictError)
    async def conflict(_request: Request, exc: ConflictError) -> JSONResponse:
        return JSONResponse(
            status_code=409,
            content={
                "code": "CONFLICT",
                "reason": exc.reason,
                "message": translate(str(exc)),
                "content_hash": exc.content_hash,
            },
        )

    @app.exception_handler(ValueError)
    async def bad_value(_request: Request, exc: ValueError) -> JSONResponse:
        """讓內部斷言的訊息傳到客戶端。

        否則像「WS 訊息超過上限」這種**自己的守門機制**會表現成一句
        `Internal Server Error`，前端只看得到 500 —— 而那正是最需要看到原因的時候。
        """
        return JSONResponse(status_code=500, content={"code": "VALUE_ERROR", "message": translate(str(exc))})

    from ..session_store import AmbiguousLookup

    @app.exception_handler(AmbiguousLookup)
    async def ambiguous(_request: Request, exc: AmbiguousLookup) -> JSONResponse:
        """同一個 id 在請求者開著的多個病例裡都有：不猜，請 client 帶 `X-RTGaia-Session`。"""
        return JSONResponse(
            status_code=409,
            content={
                "code": "AMBIGUOUS_SESSION",
                "message": translate(str(exc.args[0])),
                "object_id": exc.object_id,
                "study_ids": exc.study_ids,
            },
        )

    @app.exception_handler(KeyError)
    async def not_found(_request: Request, exc: KeyError) -> JSONResponse:
        # `str(KeyError("x"))` 帶引號；訊息本身是 args[0]（這樣才翻得到）
        text = exc.args[0] if exc.args and isinstance(exc.args[0], str) else str(exc)
        return JSONResponse(status_code=404, content={"code": "NOT_FOUND", "message": translate(text)})

    from fastapi.exception_handlers import http_exception_handler
    from starlette.exceptions import HTTPException as StarletteHTTPException

    @app.exception_handler(StarletteHTTPException)
    async def http_error(request: Request, exc: StarletteHTTPException) -> Any:
        """`HTTPException` 的 `detail`（字串，或 dict 的 message／reason／problems）依請求語言翻。"""
        translated = translate_detail(exc.detail)
        if translated is not exc.detail:
            exc = StarletteHTTPException(status_code=exc.status_code, detail=translated, headers=exc.headers)
        return await http_exception_handler(request, exc)

    @app.get("/healthz")
    async def healthz() -> dict[str, Any]:
        kernel: dict[str, Any]
        try:
            from rtgaia_geom.kernel import load_kernel

            k = load_kernel()
            kernel = {"available": True, "library": str(k.library_path)}
        except Exception as exc:  # noqa: BLE001
            kernel = {"available": False, "reason": str(exc).split("\n")[0]}
        # 記憶體看得見 —— RSS 與還在記憶體裡的病例／session 數
        memory: dict[str, Any] = {"cases_in_memory": len(state.store.cases()), "sessions": len(state.store.all())}
        try:
            with open("/proc/self/statm", encoding="ascii") as f:
                memory["rss_bytes"] = int(f.read().split()[1]) * os.sysconf("SC_PAGE_SIZE")
        except (OSError, ValueError, IndexError):
            pass
        db: dict[str, Any] = {"configured": bool(state.db_url)}
        if state.catalog_store is not None:
            try:
                db["ok"] = await state.catalog_store.ping()
                db["counts"] = await state.catalog_store.counts()
                if state.case_store is not None:
                    db["case_counts"] = await state.case_store.counts()
            except Exception as exc:  # noqa: BLE001
                db["ok"] = False
                db["error"] = str(exc).split("\n")[0]
        return {
            "ok": True,
            "geom_version": geom_version,
            "reslice_kernel": kernel,
            "chaos": state.chaos.to_wire(),
            "sessions": len(state.store.all()),
            "catalog_db": db,
            "auth": {"mode": state.auth_mode},
            "memory": memory,
            # 稽核落後（待送筆數、最舊年齡）；沒有 DB 是 None
            "audit_lag": await state.audit_lag() if state.db_url and state.catalog_store is not None else None,
            # 容量；超過門檻 warn=true（監控系統可以直接看這個欄位）
            "storage": (
                {
                    "warn": state.storage_monitor.last["warn"],
                    "max_percent": max((v["percent"] for v in state.storage_monitor.last["volumes"]), default=None),
                    "threshold": state.storage_monitor.last["threshold"],
                }
                if state.storage_monitor.last
                else None
            ),
            # 行程內 worker 的心跳（獨立 worker 看容器的心跳檔）
            "worker": _worker_view(),
        }

    def _worker_view() -> dict[str, Any]:
        if not state.inprocess_worker:
            return {"inprocess": False}
        import time

        task = state.worker_task
        h = state.worker_health
        alive = task is not None and not task.done()
        age = time.time() - float(h["last_tick"]) if h.get("last_tick") else None
        # 執行長工作時迴圈本來就不會 tick —— 只有「閒著卻沒在 tick」才算卡住
        stale = alive and h.get("busy_job") is None and age is not None and age > WORKER_STALE_SECONDS
        return {
            "inprocess": True,
            "alive": alive,
            "stale": stale,
            "last_tick_age_s": round(age, 1) if age is not None else None,
            "busy_job": h.get("busy_job"),
            "jobs": h.get("jobs", 0),
            "errors": h.get("errors", 0),
            "last_error": h.get("last_error"),
        }

    @app.get("/readyz")
    async def readyz() -> JSONResponse:
        """就緒：`/healthz` 是存活＋診斷、永遠 200；這裡**真的不能服務就回 503** ——
        DB 設了但連不上、行程內 worker 死了或閒著卻不 tick。容器健康檢查與負載平衡看這個。"""
        checks: dict[str, Any] = {}
        ready = True
        if state.catalog_store is not None:
            try:
                checks["db"] = bool(await state.catalog_store.ping())
            except Exception as exc:  # noqa: BLE001
                checks["db"] = False
                checks["db_error"] = str(exc).split("\n")[0]
            ready = ready and checks["db"]
        worker = _worker_view()
        checks["worker"] = worker
        if worker["inprocess"] and (not worker["alive"] or worker["stale"]):
            ready = False
        bus_status = getattr(state.bus, "status", None)
        bus = bus_status() if callable(bus_status) else None
        if bus is not None:
            checks["bus"] = bus
            if not bus["listening"] and bus["down_seconds"] > BUS_DOWN_SECONDS:
                ready = False
        return JSONResponse(status_code=200 if ready else 503, content={"ready": ready, "checks": checks})

    for module in (
        routes_grids,
        routes_series,
        routes_temporal_structures,  # 比 routes_structures 先（/studies/{id}/structures/… 的子路徑）
        routes_structures,
        routes_structure_sets,
        routes_misc,
        routes_dose,
        routes_dose_ops,
        routes_plan,
        routes_measurements,
        routes_library,
        routes_catalog,
        routes_import,
        routes_cases,
        routes_auth,
        routes_dimse,
        routes_plugins,
        routes_transient,
        routes_temporal,
        routes_events,
        routes_retention,
        routes_export_records,
        routes_storage,
    ):
        app.include_router(module.router)
    if state.test_api:
        # 測試端點只在明確要求時存在。core 不認識 `rtgaia_testbe`，
        # 由呼叫端（testbe 的 create_app）
        # 傳 `test_api_installer` 把 `/api/v1/_test/*` 掛上；`rtgaia_server` 永遠不傳 → 生產不可能誤帶。
        if test_api_installer is None:
            raise RuntimeError("test_api=True 需要 test_api_installer（請用 rtgaia_testbe.create_app）")
        test_api_installer(app, state)

    @app.middleware("http")
    async def request_language(request: Request, call_next):  # type: ignore[no-untyped-def]
        """前端每個請求帶 `Accept-Language`（跟介面語言）；後端訊息在 API 邊界依它翻（`rtgaia_core.i18n`）。
        最後註冊 ＝ 最外層，裡面的中介層（身分、稽核、chaos）回的訊息也吃得到。"""
        token = current_lang.set(lang_from_header(request.headers.get("accept-language")))
        try:
            return await call_next(request)
        finally:
            current_lang.reset(token)

    return app
