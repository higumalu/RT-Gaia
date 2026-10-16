"""劑量計算（重算 TPS 的計畫）：引擎清單、送出、工作清單、載回結果、取消。

* `GET    /dosecalc/engines`                         ：這台機器上能用的引擎、射束模型
* `GET    /dosecalc/beam-models`                     ：內建射束模型的完整參數與 MU 校正（管理頁）
* `POST   /studies/{study_id}/dosecalc`              ：`{plan_sop_uid, engine?, histories?, grid?, calc_spacing_mm?,
  beam_model_id?, model_sensitivity?}`（`model_sensitivity`：用擬合裡一樣好的其他參數重算，GPU 才有）
  → `dosecalc` job
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
async def dosecalc_engines(app: AppState = Depends(state)) -> Any:
    from rtgaia_dosecalc import beam_models, engines

    from .. import beam_model_jobs

    rows = await run_cpu(engines.available)
    users = [r for r in await beam_model_jobs.items(app) if r["status"] in ("active", "draft")]
    return {
        "engines": [{**e, "reason": translate(str(e.get("reason") or ""))} for e in rows],
        "beam_models": [
            {**{k: m[k] for k in ("model_id", "name", "demo", "energy_mv", "fluence_mode")}, "status": "builtin"}
            for m in beam_models.builtin_models()
        ]
        + [
            {
                **{k: r["model"][k] for k in ("model_id", "name", "energy_mv", "fluence_mode")},
                "demo": bool(r["model"].get("demo")),
                "status": r["status"],
            }
            for r in users
        ],
    }


@router.get(API + "/dosecalc/beam-models")
async def dosecalc_beam_models(app: AppState = Depends(state)) -> Any:
    """內建射束模型的完整參數 ＋ 這台機器上做過的 MU 校正（每 MU 歷史數、參考條件的深度劑量）；擬合出來的模型
    （`user_models`：參數 ＋ 狀態與擬合摘要）—— 管理頁「射束模型」。"""
    from rtgaia_dosecalc import beam_models
    from rtgaia_dosecalc.engines import topas

    from .. import beam_model_jobs

    cache = dosecalc_jobs.work_root() / "calibration"
    users = await beam_model_jobs.items(app)
    return {
        "engine_version": topas.ENGINE_VERSION,
        "models": [
            _beam_model_row(m, await run_cpu(lambda m=m: topas.cached_calibration(m, cache)))
            for m in beam_models.builtin_models()
        ],
        "user_models": [
            {
                **_beam_model_row(r["model"], await run_cpu(lambda m=r["model"]: topas.cached_calibration(m, cache))),
                **beam_model_jobs.summary(r),
            }
            for r in reversed(users)
        ],
    }


COLLIMATOR_KIND = {"jaw_x": "jaw", "jaw_y": "jaw", "fixed_x": "fixed", "fixed_y": "fixed"}


def _beam_model_row(m: dict[str, Any], cal: dict[str, Any] | None) -> dict[str, Any]:
    from rtgaia_dosecalc import beam_models

    p = m["params"]
    energies, weights = [float(x) for x in p["spectrum_mev"]], [float(x) for x in p["spectrum_weights"]]
    calibrated = None
    if cal is not None:
        dd = [float(x) for x in cal.get("depth_dose_gy") or []]
        step = float(cal.get("depth_step_mm") or 2.0)
        peak = max(dd) if dd else 0.0
        calibrated = {
            "engine_version": cal.get("engine_version"),
            "histories": cal.get("histories"),
            "dmax_mm": cal.get("dmax_mm"),
            "histories_per_mu": cal.get("histories_per_mu"),
            "pdd": [[(i + 0.5) * step, v / peak] for i, v in enumerate(dd)] if peak > 0 else [],
        }
    return {
        "model_id": m["model_id"],
        "name": m["name"],
        "demo": bool(m.get("demo")),
        "energy_mv": m["energy_mv"],
        "fluence_mode": m["fluence_mode"],
        "mlc_devices": list(m.get("mlc_devices") or []),
        "mlc_family": m.get("mlc_family"),
        "model_hash": beam_models.model_hash(m),
        "reference": m.get("reference") or "",
        "limitations": [translate(x) for x in m.get("limitations") or []],
        "spectrum": {
            "energies_mev": energies,
            "weights": weights,
            "mean_mev": sum(e * w for e, w in zip(energies, weights, strict=True)) / max(1e-12, sum(weights)),
        },
        "focal_spot_sigma_mm": p.get("focal_spot_sigma_mm"),
        "angular_sigma_deg": p.get("angular_sigma_deg"),
        "extra_focal": p.get("extra_focal"),
        "electron_contamination": p.get("electron_contamination"),
        "monitor_backscatter": p.get("monitor_backscatter"),
        "field_margin_mm": p.get("field_margin_mm"),
        "collimators": [
            {"device": name, "kind": COLLIMATOR_KIND.get(name, "mlc"), **spec}
            for name, spec in p["collimators"].items()
        ],
        "calibration": m["calibration"],
        "calibrated": calibrated,
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
    spacing = body.get("calc_spacing_mm", dosecalc_jobs.DEFAULT_CALC_SPACING_MM)
    if spacing is not None and (
        isinstance(spacing, bool) or not isinstance(spacing, int | float) or not 1 <= spacing <= 10
    ):
        raise _reject("BAD_CALC_SPACING", ["calc_spacing_mm 要是 1–10 的數字，或 null（跟輸出網格相同）"])
    options["calc_spacing_mm"] = float(spacing) if spacing is not None else None
    sensitivity = body.get("model_sensitivity", False)
    if not isinstance(sensitivity, bool):
        raise _reject("BAD_MODEL_SENSITIVITY", ["model_sensitivity 要是 true 或 false"])
    if sensitivity:
        options["model_sensitivity"] = True
    model_id = body.get("beam_model_id")
    if model_id is not None:
        if not isinstance(model_id, str) or not 1 <= len(model_id) <= 64:
            raise _reject("BAD_BEAM_MODEL", ["beam_model_id 要是射束模型的 id"])
        options["beam_model_id"] = model_id
    calibrations = await calibration_items(app)
    from .. import beam_model_jobs

    user_models = await beam_model_jobs.items(app)
    try:
        engine = dosecalc_jobs.engine_choice(body.get("engine"))
        inp, summary = await run_cpu(
            lambda: dosecalc_jobs.prepare(
                session, plan_sop_uid=plan_sop, engine=engine, calibrations=calibrations, options=options,
                user_models=user_models,
            )
        )  # fmt: skip
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
    elif (summary.get("calibration") or {}).get("demo"):
        warnings.append("CT 校正曲線標為示範用：不是這台 CT 的實測")
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
    sigma = dosecalc_jobs.uncertainty_map(res.dose_gy, res.uncertainty)
    if sigma is not None:
        text = f"{label} 1σ"
        series = await _register_derived(
            app,
            session,
            user,
            values=sigma,
            node={**leaf, "label": text, "summation_type": "", "dose_type": "", "result_dose_type": ""},
            text=text,
            grid_series=host,
            warnings=[],
            registration_sops=[],
            extra={"op": "dosecalc", "a": None, "b": None, "k": None, "dosecalc": info, "beam": None},
            params_override={
                "quantity": "uncertainty",
                "units": "PERCENT",
                "dose_scale": "uncertainty",
                "dose_type": "",
                "summation_type": "",
                "referenced_plan_sop_uids": [],
                "max_gy": dosecalc_jobs.UNCERTAINTY_DISPLAY_MAX_PERCENT,
                "min_gy": 0.0,
                "max_percent": dosecalc_jobs.UNCERTAINTY_DISPLAY_MAX_PERCENT,
                "threshold_percent": dosecalc_jobs.UNCERTAINTY_NOISY_PERCENT,
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
