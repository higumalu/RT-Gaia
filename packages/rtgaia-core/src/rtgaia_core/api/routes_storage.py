"""儲存：容量與完整性。

* `GET  /api/v1/storage/status`                  → 各磁碟使用率、門檻、有沒有超過
  （**所有登入者**：畫面上要能提醒；路徑只給 admin）
* `GET  /api/v1/storage/integrity`               → 巡檢摘要與目前問題（admin）
* `POST /api/v1/storage/integrity/run`           → 立刻巡檢一輪（admin；`{batch?}`）
* `POST /api/v1/storage/integrity/rebaseline`    → 確認是合法變動，以現在的內容為基準（admin；`{paths}`）
"""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Request

from .. import storage
from ..i18n import localized_route_class
from .deps import API, AppState, state

router = APIRouter(route_class=localized_route_class())


def _is_admin(request: Request, app: AppState) -> bool:
    if app.auth_mode != "required":
        return True
    principal = getattr(request.state, "principal", None)
    return principal is not None and getattr(principal, "role", "") == "admin"


@router.get(API + "/storage/status")
async def storage_status(request: Request, app: AppState = Depends(state)) -> dict[str, Any]:
    status = app.storage_monitor.last or (await app.storage_check())
    if _is_admin(request, app):
        return status
    # 一般使用者：看得到「哪個用途、幾 %」就夠提醒了，不給伺服器路徑
    return {**status, "volumes": [{k: v for k, v in vol.items() if k != "path"} for vol in status["volumes"]]}


@router.get(API + "/storage/integrity")
async def storage_integrity(app: AppState = Depends(state)) -> dict[str, Any]:
    store = await app.storage_locations_async()
    summary = await storage.integrity_summary(store, await app.library_files())
    return {**summary, "last_run": app.integrity_last_run, "batch": storage.integrity_batch()}


@router.post(API + "/storage/integrity/run")
async def storage_integrity_run(request: Request, app: AppState = Depends(state)) -> dict[str, Any]:
    body = await request.json() if int(request.headers.get("content-length") or 0) > 0 else {}
    try:
        batch = int(body["batch"]) if body.get("batch") is not None else None
    except (TypeError, ValueError) as exc:
        raise HTTPException(status_code=422, detail={"code": "BAD_BATCH", "message": "batch 必須是整數"}) from exc
    return await app.integrity_tick(batch=batch)


@router.post(API + "/storage/integrity/rebaseline")
async def storage_integrity_rebaseline(request: Request, app: AppState = Depends(state)) -> dict[str, Any]:
    body = await request.json()
    paths = [str(p) for p in (body.get("paths") or []) if str(p).strip()]
    if not paths:
        raise HTTPException(status_code=422, detail={"code": "NO_PATHS", "message": "要給 paths"})
    known = {p for p, _ in await app.library_files()}
    unknown = [p for p in paths if p not in known]
    if unknown:
        raise HTTPException(
            status_code=422, detail={"code": "UNKNOWN_PATH", "message": "不是資料庫裡的檔案", "paths": unknown[:20]}
        )
    rows = await storage.rebaseline(await app.storage_locations_async(), paths)
    return {"rebaselined": rows}
