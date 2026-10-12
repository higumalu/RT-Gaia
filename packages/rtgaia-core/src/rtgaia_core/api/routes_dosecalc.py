"""劑量計算（重算 TPS 的計畫）：引擎清單、送出、工作清單、載回結果、取消。

* `GET    /dosecalc/engines`                         ：這台機器上能用的引擎、射束模型
* `POST   /studies/{study_id}/dosecalc`              ：`{plan_sop_uid, engine?, histories?, grid?}` → `dosecalc` job
* `GET    /studies/{study_id}/dosecalc`              ：這個病例的劑量計算工作（狀態、摘要、載回了沒）
* `POST   /studies/{study_id}/dosecalc/{job_id}/load`：完成的結果 → 暫存劑量（只有發起的人看得到）
* `DELETE /studies/{study_id}/dosecalc/{job_id}`     ：取消（排隊中或計算中）

準備封包（讀 CT 體素、寫磁碟）在 CPU 預算裡跑；計算本身在 worker 的子行程。
"""

from __future__ import annotations

from datetime import UTC, datetime
from typing import Any

import numpy as np
from fastapi import APIRouter, Depends, HTTPException, Request, Response

from .. import dosecalc_jobs
from ..i18n import localized_route_class, translate
from ..jobs import TERMINAL, new_job
from ..limits import run_cpu
from .deps import API, AppState, actor, session_for_study, state

router = APIRouter(route_class=localized_route_class())
KIND = "dosecalc"


def _session(app: AppState, request: Request, study_id: str) -> Any:
    try:
        return session_for_study(app, request, study_id)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail={"code": "NO_STUDY", "study_id": study_id}) from exc


def _reject(code: str, problems: list[str]) -> HTTPException:
    msgs = [translate(p) for p in problems]
    return HTTPException(status_code=422, detail={"code": code, "message": "；".join(msgs), "problems": msgs})


@router.get(API + "/dosecalc/engines")
async def dosecalc_engines() -> Any:
    from rtgaia_dosecalc import beam_models, engines

    rows = await run_cpu(engines.available)
    return {
        "engines": [{**e, "reason": translate(str(e.get("reason") or ""))} for e in rows],
        "beam_models": [
            {k: m[k] for k in ("model_id", "name", "demo", "energy_mv", "fluence_mode")}
            for m in beam_models.builtin_models()
        ],
    }


@router.post(API + "/studies/{study_id}/dosecalc", status_code=202)
async def submit_dosecalc(study_id: str, body: dict[str, Any], request: Request, app: AppState = Depends(state)) -> Any:
    from .routes_ct_calibration import _items as calibration_items

    session = _session(app, request, study_id)
    user = actor(request)
    plan_sop = body.get("plan_sop_uid")
    if not isinstance(plan_sop, str) or not plan_sop:
        raise _reject("NO_PLAN", ["plan_sop_uid 必填"])
    options: dict[str, Any] = {}
    histories = body.get("histories")
    if histories is not None:
        if isinstance(histories, bool) or not isinstance(histories, int) or not 1_000 <= histories <= 5_000_000_000:
            raise _reject("BAD_HISTORIES", ["histories 要是 1,000–5,000,000,000 的整數"])
        options["histories"] = histories
    grid = body.get("grid", "tps")
    if grid not in ("tps", "ct"):
        raise _reject("BAD_GRID", ["grid 要是 tps 或 ct"])
    options["grid"] = grid
    calibrations = await calibration_items(app)
    try:
        engine = dosecalc_jobs.engine_choice(body.get("engine"))
        inp, summary = await run_cpu(
            lambda: dosecalc_jobs.prepare(
                session, plan_sop_uid=plan_sop, engine=engine, calibrations=calibrations, options=options
            )
        )
    except dosecalc_jobs.PrepareError as exc:
        raise _reject(exc.code, exc.problems) from exc
    job = new_job(session.case.case_id, KIND, {"study_id": study_id, "summary": summary}, requested_by=user)
    work = dosecalc_jobs.work_root() / job.job_id
    job.request["work_dir"] = str(work)
    await run_cpu(inp.write, work / "in")
    await (await app.job_queue_async()).enqueue(job)
    session.case.jobs[job.job_id] = job.to_wire()
    request.state.audit_detail = {"dosecalc": {"job_id": job.job_id, "plan_sop_uid": plan_sop, "engine": engine}}
    return {**job.to_wire(), "summary": _summary_wire(summary)}


def _summary_wire(s: dict[str, Any]) -> dict[str, Any]:
    return {**s, "calibration_reason": translate(str(s.get("calibration_reason") or ""))}


def _row(job: Any) -> dict[str, Any]:
    return {
        **job.to_wire(),
        "summary": _summary_wire(job.request.get("summary") or {}),
        "loaded": list(job.request.get("loaded") or []),
    }


@router.get(API + "/studies/{study_id}/dosecalc")
async def list_dosecalc(study_id: str, request: Request, app: AppState = Depends(state)) -> Any:
    session = _session(app, request, study_id)
    jobs = await (await app.job_queue_async()).list(session.case.case_id, limit=200)
    return {"jobs": [_row(j) for j in jobs if j.kind == KIND]}


async def _job(app: AppState, session: Any, job_id: str, request: Request) -> Any:
    job = await (await app.job_queue_async()).get(job_id)
    if job is None or job.kind != KIND or job.case_id != session.case.case_id:
        raise HTTPException(status_code=404, detail={"code": "NO_JOB", "job_id": job_id})
    if job.requested_by != actor(request):
        raise HTTPException(status_code=404, detail={"code": "NO_JOB", "job_id": job_id})
    return job


@router.delete(API + "/studies/{study_id}/dosecalc/{job_id}", status_code=204)
async def cancel_dosecalc(study_id: str, job_id: str, request: Request, app: AppState = Depends(state)) -> Response:
    session = _session(app, request, study_id)
    job = await _job(app, session, job_id, request)
    if job.status in TERMINAL:
        return Response(status_code=204)
    now = datetime.now(UTC).isoformat(timespec="seconds")

    def cancel(fresh: Any) -> bool:
        if fresh.status in TERMINAL:
            return False
        fresh.status, fresh.phase, fresh.error, fresh.finished_at = "failed", "failed", "cancelled", now
        return True

    await app.mutate_job(job_id, cancel)
    request.state.audit_detail = {"dosecalc_cancel": {"job_id": job_id}}
    return Response(status_code=204)


@router.post(API + "/studies/{study_id}/dosecalc/{job_id}/load", status_code=201)
async def load_dosecalc(study_id: str, job_id: str, request: Request, app: AppState = Depends(state)) -> Any:
    from .routes_dose_ops import _register_derived, _result_row

    session = _session(app, request, study_id)
    user = actor(request)
    job = await _job(app, session, job_id, request)
    if job.status != "done":
        raise HTTPException(
            status_code=409, detail={"code": "NOT_DONE", "status": job.status, "message": translate("計算還沒完成")}
        )
    summary = job.request.get("summary") or {}
    try:
        res = await run_cpu(dosecalc_jobs.read_result, job)
    except FileNotFoundError as exc:
        raise HTTPException(
            status_code=410,
            detail={"code": "RESULT_GONE", "message": translate("計算結果已經不在了（資料目錄被清掉）")},
        ) from exc
    ct = session.dataset.series_by_id(summary["ct_series_id"])
    grid = dosecalc_jobs.CalcInput.read(job.request["work_dir"] + "/in").dose_grid
    host = _grid_host(ct, grid)
    unc = dosecalc_jobs.uncertainty_summary(res.dose_gy, res.uncertainty)
    info = {
        "job_id": job_id,
        "engine": res.info.get("engine"),
        "engine_version": res.info.get("engine_version"),
        "histories": res.info.get("histories"),
        "seconds": res.info.get("seconds"),
        "beam_model": summary.get("beam_model"),
        "calibration": {k: (summary.get("calibration") or {}).get(k) for k in ("calibration_id", "name", "demo")},
        "calibration_fallback": summary.get("calibration_fallback"),
        "uncertainty": unc,
        "dose_quantity": res.info.get("dose_quantity"),
        "notes": list(res.info.get("notes") or []),
    }
    warnings: list[str] = []
    if (summary.get("beam_model") or {}).get("demo"):
        warnings.append("用的是示範射束模型：不代表任何實機")
    if summary.get("calibration_fallback"):
        warnings.append("CT 用的是內建的通用校正曲線（示範用）")
    if res.info.get("engine") == "pipeline-test":
        warnings.append("流程測試引擎：不是劑量計算")
    warnings += [str(n) for n in res.info.get("notes") or [] if str(n) not in warnings]
    label = f"{summary.get('plan_label') or 'plan'} {res.info.get('engine')}"
    created = []
    parts = [(None, res.dose_gy, label)] + [
        (n, v, f"{label} beam {n}") for n, v in sorted(res.per_beam_gy.items()) if len(res.per_beam_gy) > 1
    ]
    for number, values, text in parts:
        leaf = {
            "label": text,
            "sop_instance_uid": "",
            "dose_type": "PHYSICAL",
            "summation_type": "PLAN" if number is None else "BEAM",
            "plan_sop_uids": [summary["plan_sop_uid"]],
            "result_dose_type": "PHYSICAL",
            "computed": info,
        }
        series = await _register_derived(
            app,
            session,
            user,
            values=np.ascontiguousarray(values, dtype=np.float32),
            node=leaf,
            text=text,
            grid_series=host,
            warnings=warnings,
            registration_sops=[],
            extra={"op": "dosecalc", "a": None, "b": None, "k": None, "dosecalc": info, "beam": number},
            params_override={
                "summation_type": "PLAN" if number is None else "BEAM",
                **({"referenced_beams": [[1, int(number)]]} if number is not None else {}),
            },
        )
        created.append(series)
    job_loaded = [s.series_id for s in created]

    def mark(fresh: Any) -> bool:
        fresh.request["loaded"] = list(fresh.request.get("loaded") or []) + job_loaded
        return True

    await app.mutate_job(job_id, mark)
    request.state.audit_detail = {"dosecalc_load": {"job_id": job_id, "series": job_loaded}}
    return {"results": [{**_result_row(s), "layer_id": f"dose:{s.series_id}"} for s in created]}


def _grid_host(ct: Any, grid: Any) -> Any:
    from ..dataset import DatasetSeries

    return DatasetSeries(
        series_id="_",
        grid=grid,
        role=ct.role,
        modality="RTDOSE",
        image=lambda _g, _f=0: None,
        kind="dose",
        dtype="float32",
        meta=dict(ct.meta or {}),
    )
