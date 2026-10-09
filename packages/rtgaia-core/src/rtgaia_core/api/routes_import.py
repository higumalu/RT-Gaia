"""匯入端點。

* `POST /api/v1/import/batches { source: "upload", detail? }`            → 開批次
* `PUT  /api/v1/import/batches/{id}/files`  (body: bytes; `X-Relative-Path`)  → 暫存一個檔（zip 就地解開）
* `POST /api/v1/import/batches/{id}/complete`                            → 202，背景跑管線
* `GET  /api/v1/import/batches[?mine=]`、`GET /api/v1/import/batches/{id}[?items=1]`
* `DELETE /api/v1/import/batches/{id}`                                   → 丟棄（未 complete 的）
* `POST /api/v1/import/server-path { path }`                             → 伺服器目錄一鍵匯入（開批次＋跑）

管線完成後重掃索引（增量，靠 mtime＋size 快取）並讓目錄樹視圖重建。
"""

from __future__ import annotations

import asyncio
from typing import Any
from urllib.parse import unquote

from fastapi import APIRouter, BackgroundTasks, Depends, Header, HTTPException, Query, Request

from ..i18n import localized_route_class
from ..library.importer import ImportBatch, Importer
from ..limits import limit
from .deps import API, AppState, actor, is_admin, state
from .routes_library import _index

router = APIRouter(route_class=localized_route_class())  # 錯誤、原因等句子依請求語言翻


async def _importer(app: AppState) -> Importer:
    await _index(app)  # 沒設資料庫 → 404 NO_LIBRARY
    cached = getattr(app, "importer", None)
    if cached is None or str(cached.root) != str(Importer(app.library_root).root):
        cached = Importer(app.library_root)
        app.importer = cached
    return cached


async def _batch(app: AppState, batch_id: str) -> ImportBatch:
    try:
        return (await _importer(app)).get(batch_id)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail={"code": "NO_BATCH", "message": str(exc)}) from exc


async def _owned_batch(app: AppState, batch_id: str, request: Request) -> ImportBatch:
    """批次是**建立者的工作物件**——收檔、complete、discard、查看都只有 owner（或 admin）。
    不是 owner 回 404（不是 403），不洩漏批次存在。以前 Bob 能 DELETE Alice 的批次。"""
    batch = await _batch(app, batch_id)
    if batch.created_by != actor(request) and not is_admin(request):
        raise HTTPException(status_code=404, detail={"code": "NO_BATCH", "message": f"沒有批次 {batch_id}"})
    return batch


@router.post(API + "/import/batches", status_code=201)
async def open_batch(request: Request, app: AppState = Depends(state)) -> dict[str, Any]:
    body = await request.json() if await request.body() else {}
    source = str(body.get("source") or "upload")
    if source != "upload":
        raise HTTPException(
            status_code=422,
            detail={"code": "BAD_SOURCE", "message": "這個端點只開 upload 批次；伺服器目錄用 /import/server-path"},
        )
    # 身分一律由 Principal 取得（`actor`），不再讀 client 可任意填的 `X-RTGaia-User`
    batch = (await _importer(app)).open_batch("upload", body.get("detail") or {}, created_by=actor(request))
    return batch.to_wire()


@router.put(API + "/import/batches/{batch_id}/files")
async def receive_file(
    batch_id: str,
    request: Request,
    relative_path: str = Header(..., alias="X-Relative-Path", description="瀏覽器的 webkitRelativePath 或檔名"),
    app: AppState = Depends(state),
) -> dict[str, Any]:
    batch = await _owned_batch(app, batch_id, request)
    # 串流讀入、邊讀邊累計；超過上限就 413，不先把整個 body 收進記憶體再判
    max_bytes = limit("RTGAIA_IMPORT_BODY_MAX_BYTES")
    declared = request.headers.get("content-length")
    if declared and declared.isdigit() and int(declared) > max_bytes:
        raise HTTPException(
            status_code=413, detail={"code": "IMPORT_TOO_LARGE", "limit": max_bytes, "actual": int(declared)}
        )
    chunks: list[bytes] = []
    total = 0
    async for chunk in request.stream():
        total += len(chunk)
        if total > max_bytes:
            raise HTTPException(
                status_code=413, detail={"code": "IMPORT_TOO_LARGE", "limit": max_bytes, "actual": total}
            )
        chunks.append(chunk)
    data = b"".join(chunks)
    try:
        # header 只能是 ASCII，前端以 encodeURIComponent 送（中文資料夾名）
        items = (await _importer(app)).receive(batch, unquote(relative_path), data)
    except ValueError as exc:
        raise HTTPException(status_code=409, detail={"code": "BATCH_CLOSED", "message": str(exc)}) from exc
    return {"batch_id": batch_id, "items": [it.to_wire() for it in items], "counts": batch.counts()}


async def _run(app: AppState, batch: ImportBatch) -> None:
    importer = await _importer(app)
    index = await app.library_index_async()
    try:
        await asyncio.to_thread(importer.process, batch, index, finalize=False)
    except Exception:  # noqa: BLE001 - 已記在 batch.error
        return
    # 增量重掃（快取／DB 裡的 mtime＋size 讓沒變的檔不必重讀）；DB 模式同時把新檔寫進 Postgres。
    # 🔴 done 要等重掃完才標 —— 前端一看到 done 就會查目錄樹。
    try:
        if app.db_url:
            await app.library_index_async(rescan=True)
        else:
            await asyncio.to_thread(app.library_index, rescan=True)
    except Exception as exc:  # noqa: BLE001
        importer.fail(batch, exc)
        return
    importer.finish(batch)


@router.post(API + "/import/batches/{batch_id}/complete", status_code=202)
async def complete_batch(
    batch_id: str, request: Request, background: BackgroundTasks, app: AppState = Depends(state)
) -> dict[str, Any]:
    """202 後在背景跑管線。

    🔴 用 `BackgroundTasks` 而不是 `asyncio.create_task`：Starlette 的 TestClient 會在請求結束時
    **取消**請求內 create_task 出來的 task（真 uvicorn 不會），症狀是測試裡批次永遠停在 running/index。
    BackgroundTasks 在兩種環境都跑完；差別只是 TestClient 會等它做完才回應。
    """
    batch = await _owned_batch(app, batch_id, request)
    if batch.status != "open":
        raise HTTPException(status_code=409, detail={"code": "BATCH_NOT_OPEN", "status": batch.status})
    if not any(it.outcome == "staged" for it in batch.items):
        # 沒有東西可處理：直接結案，讓前端看到「全部被拒絕」而不是永遠 running
        batch.status = "done"
        batch.phase = "done"
        batch.percent = 100
        return batch.to_wire()
    background.add_task(_run, app, batch)
    return batch.to_wire()


@router.get(API + "/import/batches")
async def list_batches(
    request: Request, mine: bool = Query(False), app: AppState = Depends(state)
) -> list[dict[str, Any]]:
    # 非 admin **一律**只看自己的（`mine` 只對 admin 有意義）——否則「mine」是可自願放棄的過濾器
    user = actor(request)
    only_mine = mine or not is_admin(request)
    out = [b for b in (await _importer(app)).list() if not only_mine or b.created_by == user]
    return [b.to_wire() for b in out]


@router.get(API + "/import/batches/{batch_id}")
async def get_batch(
    batch_id: str, request: Request, items: bool = Query(True), app: AppState = Depends(state)
) -> dict[str, Any]:
    return (await _owned_batch(app, batch_id, request)).to_wire(items=items)


@router.delete(API + "/import/batches/{batch_id}")
async def discard_batch(batch_id: str, request: Request, app: AppState = Depends(state)) -> dict[str, Any]:
    await _owned_batch(app, batch_id, request)
    try:
        return (await _importer(app)).discard(batch_id).to_wire()
    except ValueError as exc:
        raise HTTPException(status_code=409, detail={"code": "BATCH_RUNNING", "message": str(exc)}) from exc


@router.post(API + "/import/server-path", status_code=202)
async def import_server_path(
    request: Request, background: BackgroundTasks, app: AppState = Depends(state)
) -> dict[str, Any]:
    """伺服器上的目錄一鍵匯入：來源檔**複製**進 blobs，不動原目錄。"""
    body = await request.json()
    path = str(body.get("path") or "").strip()
    if not path:
        raise HTTPException(status_code=422, detail={"code": "NO_PATH", "message": "path 必填"})
    importer = await _importer(app)
    batch = importer.open_batch("server_path", {"path": path}, created_by=actor(request))
    try:
        staged = await asyncio.to_thread(importer.stage_directory, batch, path)
    except ValueError as exc:
        importer.discard(batch.batch_id)
        raise HTTPException(status_code=422, detail={"code": "BAD_PATH", "message": str(exc)}) from exc
    if staged == 0:
        batch.status = "done"
        batch.phase = "done"
        batch.percent = 100
        return batch.to_wire()
    background.add_task(_run, app, batch)
    return batch.to_wire()
