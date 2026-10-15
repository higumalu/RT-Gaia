"""擬合出來的射束模型：擬合工作、內容、啟用、停用、刪草稿。內建模型的清單在 `routes_dosecalc`（同一個回應帶這裡的）。

* `POST   /dosecalc/beam-models/fit`             ：開擬合工作（admin；GPU）→ `{job_id}`；完成後多一個草稿模型
* `GET    /dosecalc/beam-models/user/{id}`       ：完整內容（模型參數、擬合報告、逐點比對）
* `POST   /dosecalc/beam-models/user/{id}/activate`：啟用（admin；同能量、模式、MLC 與機器名稱的舊模型自動停用）
* `POST   /dosecalc/beam-models/user/{id}/retire`  ：停用（admin）
* `DELETE /dosecalc/beam-models/user/{id}`       ：刪草稿（admin；啟用過的只能停用）
"""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Request

from .. import beam_model_jobs as bm
from ..dosecalc_jobs import PrepareError, work_root
from ..i18n import localized_route_class, translate, translate_fields
from ..jobs import new_job
from ..limits import run_cpu
from .deps import API, AppState, actor, state
from .routes_beam_data import _items as beam_data_items

router = APIRouter(route_class=localized_route_class())


def _reject(code: str, problems: list[str]) -> HTTPException:
    msgs = [translate(p) for p in problems]
    return HTTPException(status_code=422, detail={"code": code, "message": "；".join(msgs), "problems": msgs})


def _get(rows: list[dict[str, Any]], model_id: str) -> dict[str, Any]:
    rec = bm.find(rows, model_id)
    if rec is None:
        raise HTTPException(status_code=404, detail={"code": "NO_BEAM_MODEL", "model_id": model_id})
    return rec


@router.post(API + "/dosecalc/beam-models/fit", status_code=202)
async def start_fit(body: dict[str, Any], request: Request, app: AppState = Depends(state)) -> Any:
    from rtgaia_dosecalc import engines

    gpu = next((e for e in await run_cpu(engines.available) if e["name"] == "gpu"), None)
    if gpu is None or not gpu.get("ready"):
        raise _reject("ENGINE_NOT_READY", [str((gpu or {}).get("reason") or "擬合要 GPU 引擎")])
    try:
        spec = bm.prepare_fit(body, await beam_data_items(app), await bm.items(app))
    except PrepareError as exc:
        raise _reject(exc.code, exc.problems) from exc
    user = actor(request)
    job = new_job("", bm.KIND, {}, requested_by=user)
    job.request = await run_cpu(lambda: bm.write_inputs(work_root() / job.job_id, spec))
    await (await app.job_queue_async()).enqueue(job)
    request.state.audit_detail = {
        "beam_model": {
            "action": "fit",
            "job_id": job.job_id,
            "prior": spec["prior"]["model_id"],
            "fit_datasets": job.request["fit_datasets"],
            "validate_datasets": job.request["validate_datasets"],
        }
    }
    return {"job_id": job.job_id, "status": job.status, "model_id": spec["model_id"]}


@router.get(API + "/dosecalc/beam-models/user/{model_id}")
async def get_user_model(model_id: str, app: AppState = Depends(state)) -> Any:
    rec = _get(await bm.items(app), model_id)
    # 報告裡的備註、原因是後端的原文：照請求的語言翻
    return {
        **bm.summary(rec),
        "model": rec["model"],
        "fit_report": translate_fields(rec.get("fit"), {"note"}),
        "check_reports": translate_fields(rec.get("checks"), {"note", "reason"}),
    }


@router.post(API + "/dosecalc/beam-models/user/{model_id}/activate")
async def activate_user_model(model_id: str, request: Request, app: AppState = Depends(state)) -> Any:
    user = actor(request)
    async with bm.LOCK:
        rows = await bm.items(app)
        rec = _get(rows, model_id)
        if rec["status"] != "draft":
            raise _reject("NOT_DRAFT", ["只有草稿可以啟用（停用的要重新擬合一個）"])
        retired = bm.activate(rows, model_id, user=user)
        await bm.save(app, rows, user)
    request.state.audit_detail = {"beam_model": {"action": "activate", "model_id": model_id, "retired": retired}}
    return {**bm.summary(rec), "retired": retired}


@router.post(API + "/dosecalc/beam-models/user/{model_id}/retire")
async def retire_user_model(model_id: str, request: Request, app: AppState = Depends(state)) -> Any:
    user = actor(request)
    async with bm.LOCK:
        rows = await bm.items(app)
        rec = _get(rows, model_id)
        if rec["status"] != "active":
            raise _reject("NOT_ACTIVE", ["只有啟用中的模型可以停用"])
        rec.update(status="retired", retired_by=user, retired_at=bm._now())
        await bm.save(app, rows, user)
    request.state.audit_detail = {"beam_model": {"action": "retire", "model_id": model_id}}
    return bm.summary(rec)


@router.delete(API + "/dosecalc/beam-models/user/{model_id}")
async def delete_user_model(model_id: str, request: Request, app: AppState = Depends(state)) -> Any:
    user = actor(request)
    async with bm.LOCK:
        rows = await bm.items(app)
        rec = _get(rows, model_id)
        if rec["status"] != "draft":
            raise _reject("NOT_DRAFT", ["啟用過的模型不能刪，只能停用（舊的劑量結果要說得出用了哪一版）"])
        await bm.save(app, [r for r in rows if r is not rec], user)
    request.state.audit_detail = {"beam_model": {"action": "delete", "model_id": model_id}}
    return {"deleted": model_id}
