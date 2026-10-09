"""劑量運算：產生暫存結果、列出、丟棄、存成 RTDOSE。

* `GET    /studies/{study_id}/dose-ops/sources`  ：病例裡我看得到的劑量，能不能當運算元、為什麼不能
* `POST   /studies/{study_id}/dose-ops`          ：`{op: add|sub|mul|div, a, b?, k?}` → 新的暫存劑量
  （推 `layer.add` 給我自己）；`{op: beam_sum, plan_sop_uid}` → 射束劑量合成計畫劑量
* `GET    /studies/{study_id}/dose-ops`          ：我的暫存結果
* `DELETE /studies/{study_id}/dose-ops/{id}`     ：丟棄
* `POST   /dose/{series_id}/save`                ：存成 RTDOSE（下載或存入資料庫；DICOM 值可自訂）→ export job

**暫存語意**（同 plugin 暫存結果）：只有建立者看得到；關掉病例（這個人最後一條 session 走了）就銷毀；
不寫 DB。使用者從功能選單「存成 RTDOSE」才進資料庫。
"""

from __future__ import annotations

import asyncio
import hashlib
import io
import uuid
from datetime import UTC, datetime
from typing import Any

import numpy as np
from fastapi import APIRouter, Depends, HTTPException, Request

from .. import dose_ops
from ..dataset import DatasetSeries
from ..i18n import localized_route_class, translate
from ..jobs import new_job
from ..limits import run_cpu
from .deps import API, AppState, actor, readable_dose, session_for_study, state

router = APIRouter(route_class=localized_route_class())


def _to_primary(session: Any, for_uid: str) -> np.ndarray:
    fg = next((f for f in session.frame_groups if f.frame_of_reference_uid == for_uid), None)
    return fg.matrix if fg is not None else np.eye(4)


def _session(app: AppState, request: Request, study_id: str) -> Any:
    try:
        return session_for_study(app, request, study_id)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail={"code": "NO_STUDY", "study_id": study_id}) from exc


def _visible_doses(session: Any, user: str) -> list[Any]:
    return [
        s
        for s in session.dataset.series
        if s.kind == "dose" and not session.case.is_derived_dose_of_other(s.series_id, user)
    ]


def _plan_sops_in_case(session: Any) -> dict[str, dict[str, Any]]:
    """病例裡的 RTPLAN：SOP → `{label, path}`（查分次數用）。"""
    return {str(p.get("sop_instance_uid") or ""): p for p in session.dataset.plans if p.get("sop_instance_uid")}


def _fractions(session: Any, series: Any) -> int | None:
    from .routes_plan import plan_beams_cached

    plans = _plan_sops_in_case(session)
    for u in (series.params or {}).get("referenced_plan_sop_uids") or []:
        p = plans.get(str(u))
        if p is None:
            continue
        try:
            return plan_beams_cached(str(p["path"])).get("fractions_planned")
        except Exception:  # noqa: BLE001 - 分次數只是提示，讀不到不擋
            return None
    return None


def _source_row(session: Any, series: Any) -> dict[str, Any]:
    p = series.params or {}
    check = dose_ops.operand_check(series, session.frame_groups, set(_plan_sops_in_case(session)))
    reg = dose_ops.registration_of(series.frame_of_reference_uid, session.frame_groups)
    derived = p.get("derived") if isinstance(p.get("derived"), dict) else None
    return {
        "series_id": series.series_id,
        "label": dose_ops.short_label(series),
        "frame_of_reference_uid": series.frame_of_reference_uid,
        "max_gy": p.get("max_gy"),
        "min_gy": p.get("min_gy"),
        "units": p.get("units"),
        "dose_type": derived.get("result_dose_type") if derived else p.get("dose_type"),
        "summation_type": p.get("summation_type"),
        "registration": {"kind": reg["kind"], "matrix_type": reg["matrix_type"]},
        "fractions_planned": None if derived else _fractions(session, series),
        "plan_label": p.get("referenced_plan_label"),
        "derived": derived is not None,
        "eligible": not check.problems,
        "problems": [translate(x) for x in check.problems],
        "notes": [translate(x) for x in check.notes],
    }


def _plans_read(session: Any) -> dict[str, dict[str, Any]]:
    """病例裡的 RTPLAN：SOP → `read_plan_beams`（射束合成要 fraction group 的射束清單）；讀不到的略過。"""
    from .routes_plan import plan_beams_cached

    out: dict[str, dict[str, Any]] = {}
    for sop, p in _plan_sops_in_case(session).items():
        try:
            out[sop] = plan_beams_cached(str(p["path"]))
        except Exception:  # noqa: BLE001 - 壞掉的 RTPLAN 當成不在病例裡（beam_groups 會說無法核對）
            continue
    return out


def _beam_groups(session: Any, user: str) -> list[dict[str, Any]]:
    groups = dose_ops.beam_groups(_visible_doses(session, user), _plans_read(session), session.frame_groups)
    return [{**g, "problems": [translate(x) for x in g["problems"]]} for g in groups]


@router.get(API + "/studies/{study_id}/dose-ops/sources")
async def dose_op_sources(study_id: str, request: Request, app: AppState = Depends(state)) -> Any:
    session = _session(app, request, study_id)
    user = actor(request)
    return {
        "study_id": study_id,
        "sources": [_source_row(session, s) for s in _visible_doses(session, user)],
        "beam_groups": await run_cpu(lambda: _beam_groups(session, user)),
    }


def _result_row(series: Any) -> dict[str, Any]:
    d = dict(series.params["derived"])
    chain = d["chain"]
    save_type = dose_ops.summation_type_for_save(chain)
    return {
        "series_id": series.series_id,
        "text": d["text"],
        "op": d["op"],
        "created_at": d["created_at"],
        "created_by": d["owner"],
        "frame_of_reference_uid": series.frame_of_reference_uid,
        "summary": d["summary"],
        "signed": bool(d["summary"]["min_gy"] < 0),
        "dose_type": d["result_dose_type"],
        "physical_allowed": bool(d["error_from_sub"] and d["summary"]["min_gy"] >= 0),
        "summation_type_for_save": save_type,
        "save_problem": None
        if save_type
        else translate("來源劑量都沒有參照計畫：DoseSummationType（PLAN／MULTI_PLAN）無法決定，不能存成 RTDOSE"),
        "warnings": [translate(w) for w in d["warnings"]],
        "sources": [
            {"series_id": x["series_id"], "label": x["label"], "sop_instance_uid": x["sop_instance_uid"]}
            for x in dose_ops.leaves(chain)
        ],
        "plan_sop_uids": dose_ops.plan_union(chain),
        "registration_sop_uids": d["registration_sop_uids"],
        "space_label": None,
    }


@router.get(API + "/studies/{study_id}/dose-ops")
async def list_dose_ops(study_id: str, request: Request, app: AppState = Depends(state)) -> Any:
    session = _session(app, request, study_id)
    return {"study_id": study_id, "results": [_result_row(s) for s in session.case.derived_doses(actor(request))]}


def _reject(code: str, message: str, **extra: Any) -> HTTPException:
    return HTTPException(status_code=422, detail={"code": code, "message": message, **extra})


@router.post(API + "/studies/{study_id}/dose-ops", status_code=201)
async def create_dose_op(study_id: str, body: dict[str, Any], request: Request, app: AppState = Depends(state)) -> Any:
    session = _session(app, request, study_id)
    user = actor(request)
    op = body.get("op")
    if op not in (*dose_ops.OPS, "beam_sum"):
        raise _reject("BAD_OP", "op 必須是 add／sub／mul／div／beam_sum", allowed=[*dose_ops.OPS, "beam_sum"])
    if len(session.case.derived_doses(user)) >= dose_ops.MAX_DERIVED_PER_USER:
        raise _reject(
            "TOO_MANY_RESULTS",
            f"暫存結果最多 {dose_ops.MAX_DERIVED_PER_USER} 個；請先丟棄不要的",
            limit=dose_ops.MAX_DERIVED_PER_USER,
        )
    if op == "beam_sum":
        return await _create_beam_sum(app, session, user, body, request)
    visible = {s.series_id: s for s in _visible_doses(session, user)}

    def operand(key: str) -> Any:
        sid = body.get(key)
        if not isinstance(sid, str) or sid not in visible:
            raise HTTPException(status_code=404, detail={"code": "NO_SERIES", "series_id": sid, "operand": key})
        s = visible[sid]
        check = dose_ops.operand_check(s, session.frame_groups, set(_plan_sops_in_case(session)))
        if check.problems:
            raise _reject("NOT_ELIGIBLE", "；".join(check.problems), operand=key, series_id=sid)
        return s

    a = operand("a")
    b = None
    k = None
    if op in ("add", "sub"):
        b = operand("b")
        if b.series_id == a.series_id:
            raise _reject("SAME_OPERAND", "A 與 B 是同一個劑量")
        pa, pb = (a.meta or {}).get("patient_id"), (b.meta or {}).get("patient_id")
        if pa and pb and pa != pb:
            raise _reject("PATIENT_MISMATCH", "兩個劑量不是同一位病人")
    else:
        k, problem = dose_ops.check_k(op, body.get("k"))
        if problem:
            raise _reject("BAD_K", problem)

    chain_a = dose_ops.chain_of(a)
    chain_b = dose_ops.chain_of(b) if b is not None else None
    result_type, problem = dose_ops.result_dose_type(op, chain_a, chain_b)
    if problem:
        raise _reject("DOSE_TYPE_MISMATCH", problem)
    # 同一個空間的 DOSE 物件才能做運算 —— 不同空間要先「套用 REG」產生新的劑量
    if b is not None and b.frame_of_reference_uid != a.frame_of_reference_uid:
        raise _reject(
            "DIFFERENT_SPACE",
            "A 與 B 不在同一個空間：先對 B 套用 REG，把它搬到 A 的空間",
            a_frame_of_reference_uid=a.frame_of_reference_uid,
            b_frame_of_reference_uid=b.frame_of_reference_uid,
        )
    target = a
    warnings: list[str] = []
    registration_sops = _registration_sops(session, [x for x in (a, b) if x is not None], target)
    if b is not None:
        dup = {x["series_id"] for x in dose_ops.leaves(chain_a)} & {x["series_id"] for x in dose_ops.leaves(chain_b)}
        if dup:
            warnings.append("同一個來源劑量在 A 與 B 裡都出現了")
        ma, mb = float(a.params.get("max_gy") or 0), float(b.params.get("max_gy") or 0)
        if ma > 0 and mb > 0 and max(ma, mb) / min(ma, mb) >= dose_ops.MIXED_COURSE_RATIO:
            warnings.append(
                f"兩個劑量的 Dmax 差 {max(ma, mb) / min(ma, mb):.1f} 倍（{ma:.2f} 與 {mb:.2f} Gy）："
                "可能混了整個療程與單次劑量，必要時先乘上分次數"
            )

    def work() -> tuple[np.ndarray, dict[str, Any]]:
        va, cov_a = _on_grid(session, a, target)
        vb, cov_b = _on_grid(session, b, target) if b is not None else (None, 1.0)
        out = dose_ops.compose(op, va, vb, k)
        return np.ascontiguousarray(out, dtype=np.float32), {"a_covered": cov_a, "b_covered": cov_b}

    values, info = await run_cpu(work)
    if b is not None and info["b_covered"] < 0.999:
        warnings.append(f"B 只蓋到 A 網格的 {info['b_covered'] * 100:.1f}%：其餘的點沒有資料（不是 0 Gy）")
    node: dict[str, Any] = {"op": op, "a": chain_a, "b": chain_b, "k": k, "result_dose_type": result_type}
    series = await _register_derived(
        app,
        session,
        user,
        values=values,
        node=node,
        text=dose_ops.chain_text(node),
        grid_series=target,
        warnings=warnings,
        registration_sops=registration_sops,
        extra={"op": op, "a": a.series_id, "b": b.series_id if b is not None else None, "k": k},
    )
    request.state.audit_detail = {
        "dose_op": {
            "op": op,
            "a": a.series_id,
            "b": b.series_id if b is not None else None,
            "k": k,
            "text": series.params["derived"]["text"],
        }
    }
    return {**_result_row(series), "layer_id": f"dose:{series.series_id}"}


async def _create_beam_sum(app: AppState, session: Any, user: str, body: dict[str, Any], request: Request) -> Any:
    """一個計畫的射束劑量 → 計畫劑量（暫存結果，跟其他運算同一套語意）。"""
    plan_sop = body.get("plan_sop_uid")
    plans = _plans_read(session)
    visible = _visible_doses(session, user)
    group = next(
        (g for g in dose_ops.beam_groups(visible, plans, session.frame_groups) if g["plan_sop_uid"] == plan_sop), None
    )
    if group is None:
        raise HTTPException(status_code=404, detail={"code": "NO_BEAM_DOSES", "plan_sop_uid": plan_sop})
    if not group["eligible"]:
        raise _reject(
            "BEAM_SET_INVALID",
            "；".join(group["problems"]),
            **{k: group[k] for k in ("missing", "extra", "duplicates")},
        )
    by_id = {s.series_id: s for s in visible}
    members = [by_id[r["series_id"]] for r in group["doses"]]
    target = members[0]

    def work() -> tuple[np.ndarray, float]:
        total: np.ndarray | None = None
        covered = 1.0
        for s in members:
            v, cov = _on_grid(session, s, target)
            covered = min(covered, cov)
            total = v.astype(np.float32) if total is None else total + v
        assert total is not None
        return np.ascontiguousarray(total, dtype=np.float32), covered

    values, covered = await run_cpu(work)
    warnings: list[str] = []
    if covered < 0.999:
        warnings.append(f"有射束劑量只蓋到第一個射束網格的 {covered * 100:.1f}%：其餘的點沒有資料（不是 0 Gy）")
    node: dict[str, Any] = {
        "op": "beam_sum",
        "parts": [dose_ops.leaf_of(s) for s in members],
        "beams": group["expected_beams"],
        "plan_label": group["plan_label"],
        "plan_sop_uid": plan_sop,
        "fraction_group": group["fraction_group"],
        "result_dose_type": dose_ops.beam_sum_dose_type(members),
    }
    series = await _register_derived(
        app,
        session,
        user,
        values=values,
        node=node,
        text=dose_ops.chain_text(node),
        grid_series=target,
        warnings=warnings,
        registration_sops=[],
        extra={"op": "beam_sum", "a": target.series_id, "b": None, "k": None, "plan_sop_uid": plan_sop},
    )
    request.state.audit_detail = {
        "dose_op": {
            "op": "beam_sum",
            "plan_sop_uid": plan_sop,
            "sources": [s.series_id for s in members],
            "text": series.params["derived"]["text"],
        }
    }
    return {**_result_row(series), "layer_id": f"dose:{series.series_id}"}


def _on_grid(session: Any, src: Any, target: Any) -> tuple[np.ndarray, float]:
    """`src` 的劑量在 `target` 網格上的值（經各自的 FrameGroup 三線性重取樣；網格外 NaN）＋ 有資料的比例。"""
    raw = np.asarray(src.image(src.grid, 0), dtype=np.float32)
    if src is target:
        return raw, 1.0
    s_to_p = _to_primary(session, src.frame_of_reference_uid)
    t_to_p = _to_primary(session, target.frame_of_reference_uid)
    if dose_ops.same_sampling(target.grid, t_to_p, src.grid, s_to_p):
        return raw, float(np.isfinite(raw).mean()) if raw.size else 0.0
    out = dose_ops.resample_onto(raw, src.grid, s_to_p, target.grid, t_to_p)
    return out, float(np.isfinite(out).mean()) if out.size else 0.0


def _registration_sops(session: Any, sources: list[Any], target: Any) -> list[str]:
    """B 經 REG 重取樣時要記下的 REG SOP（存成 RTDOSE 的 ReferencedSpatialRegistrationSequence）。"""
    out: list[str] = []
    for src in sources:
        d = (src.params or {}).get("derived")
        if isinstance(d, dict):
            out += [u for u in d.get("registration_sop_uids") or [] if u not in out]
    fors = {src.frame_of_reference_uid for src in sources} | {target.frame_of_reference_uid}
    if len(fors) > 1:
        for f in sorted(fors):
            reg = dose_ops.registration_of(f, session.frame_groups)
            if reg.get("sop_instance_uid") and reg["sop_instance_uid"] not in out:
                out.append(str(reg["sop_instance_uid"]))
    return out


async def _register_derived(
    app: AppState,
    session: Any,
    user: str,
    *,
    values: np.ndarray,
    node: dict[str, Any],
    text: str,
    grid_series: Any,
    warnings: list[str],
    registration_sops: list[str],
    extra: dict[str, Any],
    role: str | None = None,
) -> Any:
    """一個暫存結果進病例（只有建立者看得到）並推 `layer.add` 給建立者。
    `role`：累積劑量的角色（delivered／planned／difference）。"""
    series_id = f"doseop_{uuid.uuid4().hex[:12]}"
    node["series_id"] = series_id  # 被當運算元時認得出是哪個暫存結果（丟棄時回報 used_by）
    created_at = datetime.now(UTC).isoformat(timespec="seconds")
    info = dose_ops.summary(values)
    summary = {k2: info[k2] for k2 in ("max_gy", "min_gy", "mean_gy", "covered_fraction")}
    result_type = str(node.get("result_dose_type") or "PHYSICAL")
    derived = {
        "owner": user,
        "created_at": created_at,
        **extra,
        "chain": node,
        "text": text,
        "result_dose_type": result_type,
        "error_from_sub": bool(dose_ops.has_sub(node))
        and not any(x.get("dose_type") == "ERROR" for x in dose_ops.leaves(node)),
        "registration_sop_uids": registration_sops,
        "summary": summary,
        "warnings": list(warnings),  # 原文；回應時才依請求語言翻（_result_row）
        **({"role": role} if role else {}),
    }
    params: dict[str, Any] = {
        "units": "GY",
        "dose_scale": "gy",
        "dose_type": result_type,
        "summation_type": dose_ops.summation_type_for_save(node) or "",
        "referenced_plan_sop_uids": dose_ops.plan_union(node),
        "max_gy": summary["max_gy"],
        "min_gy": summary["min_gy"],
        # 不帶處方：加總、差值、權重後的 % 處方都沒有意義 → 等劑量線走自動等距
        "prescription_gy": [],
        "referenced_plan_label": None,
        "derived": derived,
    }
    series = DatasetSeries(
        series_id=series_id,
        grid=grid_series.grid,
        role=grid_series.role,
        modality="RTDOSE",
        image=lambda _g, _f=0, _v=values: _v,
        default_window=(summary["max_gy"] / 2.0, summary["max_gy"]),
        kind="dose",
        dtype="float32",
        meta={
            **dict(grid_series.meta or {}),
            "series_description": text,
            "series_date": created_at[:10].replace("-", ""),
        },
        params=params,
    )
    session.case.add_derived_dose(series)
    for s in app.store.sessions_of(session.case.case_id):
        if s.user == user:
            layer = next((x for x in s.layers() if x["layerId"] == f"dose:{series_id}"), None)
            if layer is not None:
                await app.publish(s.session_id, "layer.add", layer)
    return series


@router.delete(API + "/studies/{study_id}/dose-ops/{series_id}")
async def discard_dose_op(study_id: str, series_id: str, request: Request, app: AppState = Depends(state)) -> Any:
    session = _session(app, request, study_id)
    user = actor(request)
    dependents = [
        s.series_id
        for s in session.case.derived_doses(user)
        if s.series_id != series_id
        and series_id in {x.get("series_id") for x in _all_nodes(s.params["derived"]["chain"])}
    ]
    gone = session.case.drop_derived_doses(user, [series_id])
    if not gone:
        raise HTTPException(status_code=404, detail={"code": "NO_SERIES", "series_id": series_id})
    for s in app.store.sessions_of(session.case.case_id):
        if s.user == user:
            await app.publish(s.session_id, "layer.remove", {"layerId": f"dose:{series_id}"})
    # 用過它的後續結果不受影響（數值已經算好），運算鏈裡的名字照舊
    return {"discarded": gone, "used_by": dependents}


def _all_nodes(node: dict[str, Any]) -> list[dict[str, Any]]:
    out = [node]
    for c in dose_ops.children(node):
        out += _all_nodes(c)
    return out


SAVE_PURPOSES = ("download", "library")


def _ascii_chain(node: dict[str, Any]) -> str:
    """寫進 DICOM 的運算式：符號用 ASCII（+ - * /），名字照原樣。"""
    return dose_ops.chain_text(node).replace("−", "-").replace("×", "*").replace("÷", "/")


@router.post(API + "/dose/{series_id}/save", status_code=202)
async def save_dose_op(series_id: str, body: dict[str, Any], request: Request, app: AppState = Depends(state)) -> Any:
    """暫存結果 → RTDOSE。檔案在 API 行程組好（暫存結果只在這個行程的記憶體裡），交給匯出 job
    （下載、匯出紀錄、送到節點、存入資料庫都走 RS 匯出那一套）。"""
    from ..rtdose_export import build_rtdose, validate_dose_tags
    from ..rtstruct import PHI_TAGS, read_identity

    session, series = readable_dose(app, series_id, request)
    derived = (series.params or {}).get("derived")
    if not isinstance(derived, dict):
        raise _reject("NOT_DERIVED", "只有劑量運算的暫存結果可以存成 RTDOSE")
    user = actor(request)
    purpose = body.get("purpose", "download")
    if purpose not in SAVE_PURPOSES:
        raise _reject("BAD_PURPOSE", "purpose 必須是 download 或 library", allowed=list(SAVE_PURPOSES))
    if "anonymize" in body and not isinstance(body["anonymize"], bool):
        raise _reject("BAD_ANONYMIZE", "anonymize 必須是布林")
    save_to_library = purpose == "library"
    if save_to_library and not app.library_root:
        raise _reject("NO_LIBRARY", "沒有設定資料庫目錄，不能存入資料庫")
    try:
        tags = validate_dose_tags(dict(body.get("tags") or {}))
    except ValueError as exc:
        raise _reject("BAD_TAG", str(exc)) from exc
    chain = derived["chain"]
    summation_type = dose_ops.summation_type_for_save(chain)
    if summation_type is None:
        raise _reject(
            "NO_PLAN_REFERENCE",
            "來源劑量都沒有參照計畫：DoseSummationType（PLAN／MULTI_PLAN）無法決定，不能存成 RTDOSE",
        )
    dose_type = str(derived["result_dose_type"])
    wanted = body.get("dose_type")
    if wanted is not None and wanted != dose_type:
        # 唯一的例外 —— 減法的結果全部 ≥ 0 時可改 PHYSICAL，要再確認一次
        if not (wanted == "PHYSICAL" and dose_type == "ERROR" and derived["error_from_sub"]):
            raise _reject("DOSE_TYPE_FIXED", "DoseType 由運算決定，不能改", dose_type=dose_type)
        if float(derived["summary"]["min_gy"]) < 0:
            raise _reject("NEGATIVE_VALUES", "結果有負值，只能存成 DoseType=ERROR")
        if body.get("confirm_physical") is not True:
            raise HTTPException(
                status_code=409,
                detail={
                    "code": "CONFIRM_PHYSICAL",
                    "message": "改成 PHYSICAL 要再確認一次：TPS 會把它當成一般的物理劑量",
                },
            )
        dose_type = "PHYSICAL"
    want_identity = not bool(body.get("anonymize", True))
    forced_reason = None
    if save_to_library and not want_identity:
        want_identity = True
        forced_reason = "存入資料庫必須帶真實病人識別（否則會掛到假病人底下）"
    try:
        image_series = session.dataset.image_series_for(series.frame_of_reference_uid)
    except KeyError:
        image_series = session.dataset.primary
    identity = None
    if want_identity:
        if image_series.source_path:
            identity = await asyncio.to_thread(read_identity, image_series.source_path)
        else:
            forced_reason = "假體沒有真實病人識別，只能匿名"
            if save_to_library:
                raise _reject("NO_IDENTITY", "假體沒有真實病人識別，不能存入資料庫")
    if identity is None and any(tags.get(t) for t in PHI_TAGS):
        forced_reason = (forced_reason + "；" if forced_reason else "") + "病人欄位為使用者填寫"
    date = datetime.now(UTC).strftime("%Y%m%d")
    leaves = dose_ops.leaves(chain)
    ops = [n["op"] for n in _all_nodes(chain) if "op" in n]
    ascii_text = _ascii_chain(chain)
    description = " | ".join(
        [
            f"RT-Gaia dose operation: {ascii_text}",
            "sources: " + ", ".join(f"{x['label']} ({x['sop_instance_uid'] or x['series_id']})" for x in leaves),
            f"grid of {leaves[0]['label']}",
            *(["B resampled by rigid registration"] if derived["registration_sop_uids"] else []),
            "voxels without data written as 0",
            f"by {user} at {derived['created_at']}",
        ]
    )
    series_description = translate("RT-Gaia 劑量運算") + f" {date}"

    def work() -> bytes:
        ds = build_rtdose(
            values_kji=np.asarray(series.image(series.grid, 0), dtype=np.float32),
            grid=series.grid,
            study_uid=str(image_series.meta.get("study_instance_uid") or session.dataset.study_id),
            dose_type=dose_type,
            summation_type=summation_type,
            plan_sop_uids=dose_ops.plan_union(chain),
            source_dose_sop_uids=[x["sop_instance_uid"] for x in leaves],
            registration_sop_uids=list(derived["registration_sop_uids"]),
            weighted=any(o in ("mul", "div") for o in ops),
            composed=any(o in ("add", "sub", "beam_sum") for o in ops),
            derivation_description=description,
            dose_comment=f"RT-Gaia: {ascii_text}",
            series_description=series_description,
            identity=identity,
            tags=tags,
            operator=user,
        )
        buf = io.BytesIO()
        ds.save_as(buf, enforce_file_format=True)
        return buf.getvalue()

    data = await run_cpu(work)
    job = new_job(
        session.case.case_id,
        "export",
        {
            "format": "rtdose",
            "series_id": series_id,
            "save_to_library": save_to_library,
            "anonymize": identity is None,
            "tags": tags,
            "derived_text": derived["text"],
        },
        requested_by=user,
    )
    import pydicom

    ds_back = pydicom.dcmread(io.BytesIO(data), stop_before_pixels=True)
    key = app.export_blobs_put(job.job_id, data)
    job.request["prebuilt_blob_key"] = key
    job.request["prebuilt_result"] = {
        "result_uid": str(ds_back.SOPInstanceUID),
        "series_instance_uid": str(ds_back.SeriesInstanceUID),
        "bytes": len(data),
        "sha256": hashlib.sha256(data).hexdigest(),
        "anonymized": identity is None,
        "dose_type": dose_type,
        "summation_type": summation_type,
        "series_description": str(ds_back.get("SeriesDescription", "")),
        "derived_text": derived["text"],
        "source_patient_id": image_series.meta.get("patient_id"),
        "tags_applied": tags,
        **({"anonymize_forced_reason": forced_reason} if forced_reason else {}),
        **({"patient_id": identity["PatientID"]} if identity is not None else {}),
    }
    await (await app.job_queue_async()).enqueue(job)
    session.case.jobs[job.job_id] = job.to_wire()
    request.state.audit_detail = {
        "dose_save": {"series_id": series_id, "purpose": purpose, "dose_type": dose_type, "text": derived["text"]}
    }
    return {"job_id": job.job_id, "case_id": job.case_id, "status": job.status}


def space_label(session: Any, for_uid: str) -> str:
    """空間（FoR）的名字：那組影像的「模態 日期」，主要影像加「（主要）」。"""
    img = next((x for x in session.dataset.image_series if x.frame_of_reference_uid == for_uid), None)
    if img is None:
        return f"FoR …{for_uid[-6:]}"
    date = str((img.meta or {}).get("series_date") or "")
    d = f"{date[:4]}-{date[4:6]}-{date[6:8]}" if len(date) >= 8 else ""
    name = " ".join(x for x in (img.modality, d) if x)
    return name + (translate("（主要）") if img.role == "primary" else "")


@router.get(API + "/studies/{study_id}/dose-ops/transforms")
async def dose_transforms(study_id: str, series_id: str, request: Request, app: AppState = Depends(state)) -> Any:
    """這個劑量可以套用的 REG（與「目前的對位」），每個都說明會搬到哪個空間；不能用的帶 `problem`。"""
    session = _session(app, request, study_id)
    user = actor(request)
    visible = {s.series_id: s for s in _visible_doses(session, user)}
    src = visible.get(series_id)
    if src is None:
        raise HTTPException(status_code=404, detail={"code": "NO_SERIES", "series_id": series_id})
    fors = {x.frame_of_reference_uid for x in session.dataset.image_series}
    opts = dose_ops.transform_options(
        src.frame_of_reference_uid, list(session.dataset.registrations), session.frame_groups, fors
    )
    for o in opts:
        o["target_label"] = space_label(session, o["target_frame_of_reference_uid"])
        if o["problem"]:
            o["problem"] = translate(o["problem"])
        o.pop("matrix_row_major", None)
    return {"series_id": series_id, "space_label": space_label(session, src.frame_of_reference_uid), "transforms": opts}


@router.post(API + "/studies/{study_id}/dose-ops/transform", status_code=201)
async def apply_transform(study_id: str, body: dict[str, Any], request: Request, app: AppState = Depends(state)) -> Any:
    """`{series_id, transform_id}` → 新的暫存劑量：在目標空間裡剛好包住原劑量的網格
    （間距沿用原劑量、方向 ＝ 目標影像），三線性重取樣（網格外 NaN）。原劑量不動。"""
    session = _session(app, request, study_id)
    user = actor(request)
    visible = {s.series_id: s for s in _visible_doses(session, user)}
    src = visible.get(body.get("series_id"))  # type: ignore[arg-type]
    if src is None:
        raise HTTPException(status_code=404, detail={"code": "NO_SERIES", "series_id": body.get("series_id")})
    check = dose_ops.operand_check(src, session.frame_groups, set(_plan_sops_in_case(session)))
    if check.problems:
        raise _reject("NOT_ELIGIBLE", "；".join(check.problems), series_id=src.series_id)
    if len(session.case.derived_doses(user)) >= dose_ops.MAX_DERIVED_PER_USER:
        raise _reject(
            "TOO_MANY_RESULTS",
            f"暫存結果最多 {dose_ops.MAX_DERIVED_PER_USER} 個；請先丟棄不要的",
            limit=dose_ops.MAX_DERIVED_PER_USER,
        )
    fors = {x.frame_of_reference_uid for x in session.dataset.image_series}
    opts = dose_ops.transform_options(
        src.frame_of_reference_uid, list(session.dataset.registrations), session.frame_groups, fors
    )
    opt = next((o for o in opts if o["transform_id"] == body.get("transform_id")), None)
    if opt is None:
        raise HTTPException(status_code=404, detail={"code": "NO_TRANSFORM", "transform_id": body.get("transform_id")})
    if opt["problem"]:
        raise _reject("TRANSFORM_UNAVAILABLE", opt["problem"], transform_id=opt["transform_id"])
    target_for = opt["target_frame_of_reference_uid"]
    host = next(
        (x for x in session.dataset.image_series if x.frame_of_reference_uid == target_for and x.role == "primary"),
        None,
    ) or next(x for x in session.dataset.image_series if x.frame_of_reference_uid == target_for)
    m = np.asarray(opt["matrix_row_major"], dtype=np.float64).reshape(4, 4)
    grid = dose_ops.transformed_grid(src.grid, m, host.grid.direction, target_for)
    if grid.voxel_count > 64_000_000:
        raise _reject("GRID_TOO_LARGE", "目標網格太大", voxels=grid.voxel_count)

    def work() -> np.ndarray:
        raw = np.asarray(src.image(src.grid, 0), dtype=np.float32)
        # resample_onto 的「到 primary」在這裡就是「到目標空間」：來源 ＝ m、目標 ＝ 單位矩陣
        return np.ascontiguousarray(dose_ops.resample_onto(raw, src.grid, m, grid, np.eye(4)), dtype=np.float32)

    values = await run_cpu(work)
    target_label = space_label(session, target_for)
    # 運算式裡用短的（「→ CT 06-12」）；空間的完整名字在劑量面板的分組標題
    img = next((x for x in session.dataset.image_series if x.frame_of_reference_uid == target_for), None)
    date = str(((img.meta if img else None) or {}).get("series_date") or "")
    target_short = " ".join(
        x for x in ((img.modality if img else ""), f"{date[4:6]}-{date[6:8]}" if len(date) >= 8 else "") if x
    )
    chain = dose_ops.chain_of(src)
    node: dict[str, Any] = {
        "op": "transform",
        "a": chain,
        "b": None,
        "k": None,
        "result_dose_type": str(chain.get("result_dose_type") or chain.get("dose_type") or "PHYSICAL").upper(),
        "target_label": target_short or target_label,
        "transform": {
            k: opt.get(k) for k in ("transform_id", "kind", "reg_id", "sop_instance_uid", "series_date", "inverse")
        },
    }
    regs = [u for u in ((src.params or {}).get("derived") or {}).get("registration_sop_uids") or []]
    if opt.get("sop_instance_uid") and opt["sop_instance_uid"] not in regs:
        regs.append(str(opt["sop_instance_uid"]))
    grid_host = DatasetSeries(
        series_id="_",
        grid=grid,
        role=host.role,
        modality="RTDOSE",
        image=lambda _g, _f=0: values,
        kind="dose",
        dtype="float32",
        meta=dict(host.meta or {}),
    )
    series = await _register_derived(
        app,
        session,
        user,
        values=values,
        node=node,
        text=dose_ops.chain_text(node),
        grid_series=grid_host,
        warnings=[],
        registration_sops=regs,
        extra={"op": "transform", "a": src.series_id, "transform_id": opt["transform_id"]},
    )
    request.state.audit_detail = {"dose_transform": {"series_id": src.series_id, "transform_id": opt["transform_id"]}}
    return {**_result_row(series), "layer_id": f"dose:{series.series_id}", "space_label": target_label}
