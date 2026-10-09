"""匯出紀錄（模型見 `rtgaia_core.export_records`）。

* `GET  /export-records?case_id=&patient_id=&user=&kind=&status=&limit=` → `{items: [...]}`（新到舊）
* `GET  /export-records/{export_id}`
* `POST /export-records/{export_id}/resend {node_id?}` → 202 送出 job。
  送出紀錄：同一組內容再送（`node_id` 預設原節點）；RTSTRUCT 紀錄：把當時產生的那份檔案送到 `node_id`（必填）。
  新紀錄的 `resend_of` 指回這筆。
"""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Query, Request

from ..export_records import KINDS, resend_problem
from ..i18n import localized_route_class
from ..jobs import new_job
from .deps import API, AppState, actor, state
from .routes_dimse import _node

router = APIRouter(route_class=localized_route_class())  # 錯誤、原因等句子依請求語言翻


async def _get(app: AppState, export_id: str) -> Any:
    try:
        return await (await app.export_records_async()).get(export_id)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail={"code": "NO_EXPORT_RECORD", "message": str(exc)}) from exc


@router.get(API + "/export-records")
async def list_export_records(
    case_id: str | None = Query(None),
    patient_id: str | None = Query(None),
    user: str | None = Query(None, description="匯出的人"),
    kind: str | None = Query(None, description="rtstruct|push"),
    status: str | None = Query(None, description="done|failed"),
    limit: int = Query(100, ge=1, le=1000),
    app: AppState = Depends(state),
) -> dict[str, Any]:
    if kind is not None and kind not in KINDS:
        raise HTTPException(status_code=422, detail={"code": "BAD_KIND", "kinds": list(KINDS)})
    records = await (await app.export_records_async()).list(
        case_id=case_id,
        patient_id=patient_id.strip() if patient_id else None,
        requested_by=user,
        kind=kind,
        status=status,
        limit=limit,
    )
    return {"items": [r.to_wire() for r in records]}


DERIVED_CONFIRM_DETAIL = {
    "code": "DERIVED_DOSE_CONFIRM",
    "message": "這是 RT-Gaia 算出的衍生劑量，不是 TPS 計算結果；確認後再送",
}


async def _is_dose_export(app: AppState, export_id: str) -> bool:
    try:
        return (await _get(app, export_id)).kind == "rtdose"
    except HTTPException:
        return False


@router.get(API + "/export-records/{export_id}")
async def get_export_record(export_id: str, app: AppState = Depends(state)) -> dict[str, Any]:
    return (await _get(app, export_id)).to_wire()


@router.post(API + "/export-records/{export_id}/resend", status_code=202)
async def resend_export(export_id: str, request: Request, app: AppState = Depends(state)) -> dict[str, Any]:
    rec = await _get(app, export_id)
    body = await request.json() if await request.body() else {}
    problem = resend_problem(rec)
    if problem is not None:
        raise HTTPException(status_code=409, detail={"code": "NOT_RESENDABLE", "message": problem})
    node_id = str(body.get("node_id") or (rec.node_id if rec.kind == "push" else "") or "")
    if not node_id:
        raise HTTPException(status_code=422, detail={"code": "NODE_REQUIRED", "message": "要指定送到哪個節點"})
    node = await _node(app, node_id)
    if not node.role_send or not node.host:
        raise HTTPException(
            status_code=422, detail={"code": "NODE_CANNOT_SEND", "message": f"節點 {node.name} 沒有「可送出」角色"}
        )
    derived = rec.kind == "rtdose" or bool(rec.source_export_id and await _is_dose_export(app, rec.source_export_id))
    if derived:
        # 送衍生劑量多一道確認，並寫進稽核
        if body.get("confirm_derived") is not True:
            raise HTTPException(status_code=409, detail=DERIVED_CONFIRM_DETAIL)
        request.state.audit_detail = {"derived_dose": True, "confirmed": True}
    if rec.kind in ("rtstruct", "rtdose"):
        try:
            app.export_blobs_get(str(rec.blob_key))
        except KeyError as exc:
            raise HTTPException(
                status_code=410, detail={"code": "EXPORT_GONE", "message": "當時的匯出檔已不在"}
            ) from exc
        spec: dict[str, Any] = {"export_job_id": rec.export_id}
    else:
        spec = dict(rec.resend_spec)
    job = new_job(
        rec.case_id,
        "send",
        {
            "node_id": node.node_id,
            "series_uids": spec.get("series_uids") or [],
            "study_uids": spec.get("study_uids") or [],
            "patient_ids": spec.get("patient_ids") or [],
            "export_job_id": spec.get("export_job_id"),
            "resend_of": rec.export_id,
        },
        requested_by=actor(request),
    )
    await (await app.job_queue_async()).enqueue(job)
    return job.to_wire()
