"""DIMSE 端點。

* `GET/POST /dimse/nodes`、`PATCH/DELETE /dimse/nodes/{id}`（寫入 admin）
* `POST /dimse/nodes/{id}/echo`                       → `{ok, latency_ms, error}`
* `POST /dimse/nodes/{id}/find {level, query}`        → 遠端結果列（給「從 PACS 拉」的查詢頁）
* `POST /dimse/nodes/{id}/retrieve {study_uids|series_uids, method}` → job（move：資料到我方 SCP 再匯入；get：就地匯入）
* `POST /dimse/nodes/{id}/send {series_uids|study_uids|patient_ids|export_job_id}` → job
  （C-STORE；study／病人展開成目錄裡的全部序列）
* `GET  /dimse/status`                                 → 我方 AE、port、SCP 是否在跑、最近接收
* `POST /dimse/import-directory {path}`                → 進 import job（server-path 匯入改走 worker）
* DIMSE 設定：
  `POST /dimse/nodes/{id}/probe`（C-ECHO ＋ 關聯協商探 supports）、`GET /settings`、`PUT /settings/dimse`（admin）、
  `POST /dimse/scp/restart`（admin）。節點寫入後 `nodes.changed` 讓接收驗證的快照失效。
"""

from __future__ import annotations

import asyncio
from datetime import UTC, datetime
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Request

from .. import dimse
from ..i18n import localized_route_class
from ..jobs import new_job
from .deps import API, AppState, actor, state

router = APIRouter(route_class=localized_route_class())  # 錯誤、原因等句子依請求語言翻


async def _node(app: AppState, node_id: str) -> dimse.Node:
    try:
        return await (await app.nodes_async()).get(node_id)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail={"code": "NO_NODE", "message": str(exc)}) from exc


@router.get(API + "/dimse/status")
async def dimse_status(app: AppState = Depends(state)) -> dict[str, Any]:
    cfg = await app.dimse_settings_async()
    return {
        "our_ae_title": cfg.ae_title,
        "scp_port": cfg.scp_port,
        "scp_enabled": cfg.scp_enabled,
        "scp": app.scp.status() if app.scp is not None else None,
        "scp_error": app.scp_error,
        "accepted_sop_classes": dimse.ACCEPTED_SOP_CLASSES,
    }


async def _settings_view(app: AppState) -> dict[str, Any]:
    """`GET /settings` 與 `PUT /settings/dimse` 回**同一個形狀**（前端把回應整份當頁面狀態；少一欄就白頁）。"""
    from ..i18n import translate_fields
    from ..settings import SETTINGS_KEY, readonly_settings

    cfg = await app.dimse_settings_async()
    meta = await (await app.settings_store_async()).meta(SETTINGS_KEY)
    return {
        "dimse": cfg.to_wire(),
        "sources": dict(app.settings_sources),
        "updated": meta,
        # 唯讀區的名稱與（固定文字的）值依請求語言；路徑、URL 查不到譯文會原樣留著
        "readonly": translate_fields(
            readonly_settings(
                db_url=app.db_url,
                library_root=app.library_root,
                auth_mode=app.auth_mode,
                inprocess_worker=app.inprocess_worker,
            ),
            frozenset({"label", "value"}),
        ),
        "scp": app.scp.status() if app.scp is not None else None,
        "scp_error": app.scp_error,
        "scp_owner": app.scp_owner,
    }


@router.get(API + "/settings")
async def get_settings(app: AppState = Depends(state)) -> dict[str, Any]:
    """服務設定（admin）：可改的 `dimse` 區（每個欄位的來源 env／db）、唯讀區、接收端狀態。"""
    return await _settings_view(app)


@router.put(API + "/settings/dimse")
async def put_settings(request: Request, app: AppState = Depends(state)) -> dict[str, Any]:
    body = await request.json()
    if not isinstance(body, dict) or not body:
        raise HTTPException(status_code=422, detail={"code": "BAD_SETTINGS", "message": "要給一個欄位物件"})
    try:
        await app.save_dimse_settings(body, updated_by=actor(request))
    except ValueError as exc:
        raise HTTPException(status_code=422, detail={"code": "BAD_SETTINGS", "message": str(exc)}) from exc
    return await _settings_view(app)


@router.post(API + "/dimse/scp/restart")
async def restart_scp(app: AppState = Depends(state)) -> dict[str, Any]:
    result = await app.apply_dimse_settings(force=True)
    return {**result, "scp": app.scp.status() if app.scp is not None else None, "scp_error": app.scp_error}


@router.get(API + "/dimse/nodes")
async def list_nodes(app: AppState = Depends(state)) -> list[dict[str, Any]]:
    return [n.to_wire() for n in await (await app.nodes_async()).list()]


@router.post(API + "/dimse/nodes", status_code=201)
async def create_node(request: Request, app: AppState = Depends(state)) -> dict[str, Any]:
    body = await request.json()
    try:
        node = dimse.Node.from_wire(body, created_by=actor(request))
    except ValueError as exc:
        raise HTTPException(status_code=422, detail={"code": "BAD_NODE", "message": str(exc)}) from exc
    out = (await (await app.nodes_async()).put(node)).to_wire()
    await app.nodes_changed()
    return out


@router.patch(API + "/dimse/nodes/{node_id}")
async def update_node(node_id: str, request: Request, app: AppState = Depends(state)) -> dict[str, Any]:
    node = await _node(app, node_id)
    body = await request.json()
    merged = {**node.to_wire(), **body}
    try:
        updated = dimse.Node.from_wire(merged, node_id=node_id, created_by=node.created_by)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail={"code": "BAD_NODE", "message": str(exc)}) from exc
    updated.created_at = node.created_at
    updated.last_echo_at, updated.last_echo_ok = node.last_echo_at, node.last_echo_ok
    out = (await (await app.nodes_async()).put(updated)).to_wire()
    await app.nodes_changed()
    return out


@router.delete(API + "/dimse/nodes/{node_id}", status_code=204)
async def delete_node(node_id: str, app: AppState = Depends(state)) -> None:
    await _node(app, node_id)
    await (await app.nodes_async()).delete(node_id)
    await app.nodes_changed()


@router.post(API + "/dimse/nodes/{node_id}/echo")
async def echo_node(node_id: str, app: AppState = Depends(state)) -> dict[str, Any]:
    node = await _node(app, node_id)
    if not node.host or not node.port:
        raise HTTPException(
            status_code=422, detail={"code": "NO_HOST", "message": "這個節點只有接收角色，沒有 host／port"}
        )
    result = await asyncio.to_thread(dimse.echo, node)
    node.last_echo_at = datetime.now(UTC).isoformat(timespec="seconds")
    node.last_echo_ok = bool(result["ok"])
    await (await app.nodes_async()).put(node)
    return {**result, "node": node.to_wire()}


@router.post(API + "/dimse/nodes/{node_id}/probe")
async def probe_node(node_id: str, app: AppState = Depends(state)) -> dict[str, Any]:
    """C-ECHO ＋ 關聯協商：對方接受哪些服務 → `supports` 建議值（不自動寫回，前端按「套用」再 PATCH）。"""
    node = await _node(app, node_id)
    result = await asyncio.to_thread(dimse.probe, node)
    node.last_echo_at = datetime.now(UTC).isoformat(timespec="seconds")
    node.last_echo_ok = bool(result["ok"])
    await (await app.nodes_async()).put(node)
    return {**result, "node": node.to_wire()}


@router.post(API + "/dimse/nodes/{node_id}/find")
async def find_node(node_id: str, request: Request, app: AppState = Depends(state)) -> dict[str, Any]:
    node = await _node(app, node_id)
    body = await request.json()
    level = str(body.get("level") or "study")
    query = dict(body.get("query") or {})
    # 分頁（offset／limit 在已收到的結果上切；一次最多收 FIND_MAX_RESULTS 筆，超過送 C-CANCEL 並標 truncated）
    try:
        offset = max(0, int(body.get("offset") or 0))
        limit = min(dimse.FIND_MAX_RESULTS, max(1, int(body.get("limit") or 100)))
    except (TypeError, ValueError) as exc:
        detail = {"code": "BAD_QUERY", "message": "offset／limit 必須是整數"}
        raise HTTPException(status_code=422, detail=detail) from exc
    try:
        rows, truncated = await asyncio.to_thread(dimse.find_capped, node, level, query)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail={"code": "BAD_QUERY", "message": str(exc)}) from exc
    except ConnectionError as exc:
        raise HTTPException(status_code=502, detail={"code": "ASSOC_FAILED", "message": str(exc)}) from exc
    return {
        "node_id": node_id,
        "level": level,
        "total": len(rows),
        "truncated": truncated,
        "max_results": dimse.FIND_MAX_RESULTS,
        "offset": offset,
        "limit": limit,
        "rows": rows[offset : offset + limit],
    }


@router.post(API + "/dimse/nodes/{node_id}/retrieve", status_code=202)
async def retrieve_from_node(node_id: str, request: Request, app: AppState = Depends(state)) -> dict[str, Any]:
    node = await _node(app, node_id)
    body = await request.json()
    if not (body.get("study_uids") or body.get("series_uids")):
        raise HTTPException(status_code=422, detail={"code": "NO_UIDS", "message": "要給 study_uids 或 series_uids"})
    method = str(body.get("method") or "move").lower()
    if method not in ("move", "get"):
        raise HTTPException(status_code=422, detail={"code": "BAD_METHOD", "message": "method 必須是 move 或 get"})
    job = new_job(
        "",
        "retrieve",
        {
            "node_id": node.node_id,
            "study_uids": body.get("study_uids") or [],
            "series_uids": body.get("series_uids") or [],
            "method": method,
        },
        requested_by=actor(request),
    )
    await (await app.job_queue_async()).enqueue(job)
    return job.to_wire()


async def _derived_doses_in_send(app: AppState, body: dict[str, Any]) -> list[str]:
    """這次送出含 RT-Gaia 劑量運算存的 RTDOSE 嗎？（匯出 job 是 rtdose，或目錄裡的序列標了 `derived`）"""
    out: list[str] = []
    if body.get("export_job_id"):
        job = await (await app.job_queue_async()).get(str(body["export_job_id"]))
        if job is not None and job.request.get("format") == "rtdose":
            out.append(str(job.result.get("series_instance_uid") or job.job_id))
    series_uids = {str(u) for u in body.get("series_uids") or []}
    study_uids = {str(u) for u in body.get("study_uids") or []}
    patient_ids = {str(u) for u in body.get("patient_ids") or []}
    if series_uids or study_uids or patient_ids:
        try:
            index = await app.library_index_async()
        except Exception:  # noqa: BLE001 - 沒有資料庫就沒有衍生劑量可送
            return out
        for e in index.series.values():
            if e.modality != "RTDOSE" or not e.refs.get("derived"):
                continue
            if (
                e.series_instance_uid in series_uids
                or e.study_instance_uid in study_uids
                or e.patient_id in patient_ids
            ):
                out.append(e.series_instance_uid)
    return out


@router.post(API + "/dimse/nodes/{node_id}/send", status_code=202)
async def send_to_node(node_id: str, request: Request, app: AppState = Depends(state)) -> dict[str, Any]:
    node = await _node(app, node_id)
    body = await request.json()
    if not (body.get("series_uids") or body.get("study_uids") or body.get("patient_ids") or body.get("export_job_id")):
        raise HTTPException(
            status_code=422,
            detail={
                "code": "NOTHING_TO_SEND",
                "message": "要給 series_uids／study_uids／patient_ids 或 export_job_id",
            },
        )
    derived = await _derived_doses_in_send(app, body)
    if derived:
        # 送 RT-Gaia 算出的衍生劑量多一道確認，並寫進稽核
        if body.get("confirm_derived") is not True:
            raise HTTPException(
                status_code=409,
                detail={
                    "code": "DERIVED_DOSE_CONFIRM",
                    "message": "這是 RT-Gaia 算出的衍生劑量，不是 TPS 計算結果；確認後再送",
                    "series_uids": derived,
                },
            )
        request.state.audit_detail = {"derived_dose": derived, "confirmed": True}
    job = new_job(
        str(body.get("case_id") or ""),
        "send",
        {
            "node_id": node.node_id,
            "series_uids": body.get("series_uids") or [],
            "study_uids": body.get("study_uids") or [],
            "patient_ids": body.get("patient_ids") or [],
            "export_job_id": body.get("export_job_id"),
        },
        requested_by=actor(request),
    )
    await (await app.job_queue_async()).enqueue(job)
    return job.to_wire()


@router.post(API + "/dimse/nodes/{node_id}/service-call", status_code=202)
async def service_call(node_id: str, request: Request, app: AppState = Depends(state)) -> dict[str, Any]:
    """把目前病例的影像序列送到節點，然後等它把 RT 物件回傳到我方 SCP。

    body：`{series_uids?: [...], study_id?: str, timeout_s?: int, wanted_modalities?: [...]}`。
    沒給 `series_uids` ＝ 病例的全部影像序列。回傳的物件由匯入管線進目錄（是**資料庫物件**，不是暫存物件），
    完成時推 `service.received`，使用者到資料頁把它加入病例。
    """
    node = await _node(app, node_id)
    body = await request.json() if await request.body() else {}
    user = actor(request)
    try:
        session = (
            app.store.by_study(str(body["study_id"]), user=user)
            if body.get("study_id")
            else app.store.own_current(user)  # 2026-10-09：不退回別人的 session（會把別人病例的影像送出去）
        )
    except KeyError as exc:
        raise HTTPException(status_code=404, detail={"code": "NO_SESSION", "message": str(exc)}) from exc
    case = session.case
    series_uids = [str(u) for u in body.get("series_uids") or []]
    index = await app.library_index_async()
    if not series_uids:
        series_uids = [s.series_id for s in session.dataset.series if s.kind == "image" and s.series_id in index.series]
    if not series_uids:
        raise HTTPException(
            status_code=422, detail={"code": "NO_SERIES", "message": "這個病例沒有在資料庫裡的影像序列（假體不能送）"}
        )
    entry = index.series.get(series_uids[0])
    study_uid = entry.study_instance_uid if entry else ""
    from ..jobs import new_job

    job = new_job(
        case.case_id,
        "service.call",
        {
            "node_id": node.node_id,
            "node_name": node.name,
            "series_uids": series_uids,
            "study_instance_uid": study_uid,
            "session_id": session.session_id,
            "timeout_s": int(body.get("timeout_s") or 1800),
            "wanted_modalities": body.get("wanted_modalities") or ["RTSTRUCT", "SEG", "RTDOSE", "REG"],
        },
        requested_by=user,
    )
    await (await app.job_queue_async()).enqueue(job)
    case.jobs[job.job_id] = job.to_wire()
    return {
        "job_id": job.job_id,
        "case_id": case.case_id,
        "status": job.status,
        "series_uids": series_uids,
        "study_instance_uid": study_uid,
    }


@router.post(API + "/dimse/import-directory", status_code=202)
async def import_directory(request: Request, app: AppState = Depends(state)) -> dict[str, Any]:
    """伺服器目錄匯入走 worker（`/import/server-path` 是在 API 行程跑；這條給獨立 worker）。"""
    body = await request.json()
    path = str(body.get("path") or "").strip()
    if not path:
        raise HTTPException(status_code=422, detail={"code": "NO_PATH"})
    # 目錄來源不搬檔（複製）—— 排入時就定，不能排入後再改（見 `enqueue_import`）
    job = await app.enqueue_import(
        path, source="server_path", detail={"path": path}, requested_by=actor(request), move=False
    )
    return job.to_wire()
