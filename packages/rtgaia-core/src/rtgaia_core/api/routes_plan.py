"""計畫與射束 —— 只讀：射束清單、治療機、等中心（換到 primary 座標）。

計畫只看不改、不算劑量、不做碰撞檢查、不宣稱照射模擬。
"""

from __future__ import annotations

from typing import Any

import numpy as np
from fastapi import APIRouter, Depends, HTTPException, Query, Request

from ..i18n import localized_route_class
from ..limits import run_cpu
from ..loaders.rtplan import read_beam_control_points, read_plan_beams
from .deps import API, AppState, session_for_study, state

router = APIRouter(route_class=localized_route_class())

_CACHE: dict[str, dict[str, Any]] = {}
"""path → `read_plan_beams` 的結果（RTPLAN 進資料庫後內容不變：同 UID 不同內容會被匯入拒絕）。"""


def plan_beams_cached(path: str) -> dict[str, Any]:
    info = _CACHE.get(path)
    if info is None:
        info = read_plan_beams(path)
        _CACHE[path] = info
    return info


@router.get(API + "/studies/{study_id}/plans")
async def study_plans(study_id: str, request: Request, app: AppState = Depends(state)) -> Any:
    """病例裡的 RTPLAN（選取的 ＋ 載入的劑量參照到的）與射束。等中心多給 `position_primary_mm`：
    經 RTPLAN 那個 FoR 的 FrameGroup 換到 primary；病例裡沒有那個 FoR 的影像 → `null` ＋ `mappable: false`。"""
    try:
        session = session_for_study(app, request, study_id)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail={"code": "NO_STUDY", "study_id": study_id}) from exc
    plans = list(session.dataset.plans)

    def work() -> list[dict[str, Any]]:
        out: list[dict[str, Any]] = []
        for p in plans:
            info = plan_beams_cached(str(p["path"]))
            fg = next(
                (f for f in session.frame_groups if f.frame_of_reference_uid == info["frame_of_reference_uid"]), None
            )
            m = fg.matrix if fg is not None else None
            isos = [
                {
                    **iso,
                    "position_primary_mm": (
                        [float(v) for v in (m[:3, :3] @ np.asarray(iso["position_mm"]) + m[:3, 3])]
                        if m is not None
                        else None
                    ),
                }
                for iso in info["isocenters"]
            ]
            out.append({"plan_id": p["series_instance_uid"], **info, "isocenters": isos, "mappable": m is not None})
        return out

    return {"study_id": study_id, "plans": await run_cpu(work)}


_CP_CACHE: dict[tuple[str, int], dict[str, Any]] = {}


@router.get(API + "/studies/{study_id}/plans/{plan_id}/beams/{beam_number}")
async def beam_control_points(
    study_id: str, plan_id: str, beam_number: int, request: Request, app: AppState = Depends(state)
) -> Any:
    """一個射束每個控制點的完整狀態（往後帶）—— 機架／准直器／床角、累積 MU、ΔMU、MU/°、jaw、MLC；
    裝置定義含葉片邊界（`boundaries_mm`）。給 BEV／MLC 開口圖與控制點時間軸。"""
    try:
        session = session_for_study(app, request, study_id)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail={"code": "NO_STUDY", "study_id": study_id}) from exc
    plan = next((p for p in session.dataset.plans if p["series_instance_uid"] == plan_id), None)
    if plan is None:
        raise HTTPException(status_code=404, detail={"code": "NO_PLAN", "plan_id": plan_id})
    key = (str(plan["path"]), int(beam_number))

    def work() -> dict[str, Any]:
        info = _CP_CACHE.get(key)
        if info is None:
            info = read_beam_control_points(key[0], key[1])
            _CP_CACHE[key] = info
        return info

    try:
        out = await run_cpu(work)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail={"code": "NO_BEAM", "beam_number": beam_number}) from exc
    # 每個 CP 的射源位置（primary）、機架旋轉軸 —— 2D 的弧刻度用（幾何只在伺服器算一次）
    track = await run_cpu(lambda: _track(session, plan, out))
    return {"study_id": study_id, "plan_id": plan_id, **out, "track": track}


def _plan_frame(session: Any, plan: dict[str, Any]) -> tuple[dict[str, Any], np.ndarray | None, str]:
    """(read_plan_beams 的結果, RTPLAN FoR → primary 的矩陣或 None, 病人擺位)。"""
    info = plan_beams_cached(str(plan["path"]))
    fg = next((f for f in session.frame_groups if f.frame_of_reference_uid == info["frame_of_reference_uid"]), None)
    position = (info.get("patient_positions") or ["HFS"])[0]
    return info, (fg.matrix if fg is not None else None), position


def _track(session: Any, plan: dict[str, Any], cps: dict[str, Any]) -> dict[str, Any] | None:
    from ..beam_geometry import beam_track

    info, m, position = _plan_frame(session, plan)
    beam = next((b for b in info["beams"] if b["number"] == cps["number"]), None)
    if m is None or beam is None or beam["isocenter_mm"] is None:
        return None
    return beam_track(cps, beam["isocenter_mm"], position, m)


def beam_primitives_for(session: Any, layer: dict[str, Any]) -> dict[str, Any] | None:
    """3D 的 `{renderer: 'beams', plan_id, beam_number?, cp?}` → `{renderer: 'primitives', lines, polys}`
    （primary 座標）。計畫不在病例裡或它的 FoR 沒有影像 → None（不畫，不報錯：3D 其他圖層照常）。"""
    from ..beam_geometry import beam_primitives

    plan = next((p for p in session.dataset.plans if p["series_instance_uid"] == layer.get("plan_id")), None)
    if plan is None:
        return None
    info, m, position = _plan_frame(session, plan)
    if m is None or info.get("technique") == "gamma_knife":
        return None  # Gamma Knife 的 shot 不是射束，3D 不畫線（等中心照樣標）
    beams = []
    for b in info["beams"]:
        if b["number"] is None or b["isocenter_mm"] is None:
            continue
        key = (str(plan["path"]), int(b["number"]))
        cps = _CP_CACHE.get(key)
        if cps is None:
            cps = read_beam_control_points(key[0], key[1])
            _CP_CACHE[key] = cps
        beams.append(
            {"number": b["number"], "is_treatment": b["is_treatment"], "iso_lps": b["isocenter_mm"], "cps": cps}
        )
    current = None
    if layer.get("beam_number") is not None:
        current = (int(layer["beam_number"]), int(layer.get("cp") or 0))
    prim = beam_primitives(beams, current, position, m)
    return {"renderer": "primitives", "key": f"beams:{layer.get('plan_id')}", **prim}


# ── DRR 當 BEV 背景 ＋ 結構投影 ──────────────────────────────────────────

_MU_CACHE: dict[str, tuple[np.ndarray, Any]] = {}
"""CT series_id → (μ 體積〔降採樣 2 倍〕, 網格)。一個病例通常只有一兩組 CT。"""
_DRR_CACHE: dict[tuple[Any, ...], np.ndarray] = {}
_DRR_CACHE_MAX = 96
_SURFACE_CACHE: dict[str, np.ndarray] = {}


@router.get(API + "/studies/{study_id}/plans/{plan_id}/beams/{beam_number}/drr")
async def beam_drr(
    study_id: str,
    plan_id: str,
    beam_number: int,
    request: Request,
    cp: int = Query(0, ge=0),
    size: int = Query(192, ge=64, le=384),
    half: float = Query(150.0, gt=10.0, le=400.0, description="BEV 半邊（mm，等中心平面）"),
    preset: str = Query("high", description="soft｜high｜raw｜custom"),
    wc: float = Query(0.5, ge=0.0, le=1.0),
    ww: float = Query(1.0, gt=0.0, le=2.0),
    structure_ids: str = Query("", description="逗號分隔：要投影的結構（最多 12 個）"),
    app: AppState = Depends(state),
) -> Any:
    """這個射束在 `cp` 的 DRR（BEV 座標，跟著准直器轉）＋ 結構投影輪廓。
    不支援的幾何（機架俯仰、床 pitch／roll、擺位）→ 422 `DRR_UNSUPPORTED_GEOMETRY`；
    計畫的 FoR 沒有 CT → 422 `DRR_NO_CT`。"""
    import base64

    from ..drr import (
        DRR_PRESETS,
        UnsupportedGeometry,
        apply_preset,
        attenuation_volume,
        check_geometry,
        drr,
        project_structure,
        surface_points,
    )
    from ..render3d import encode_png
    from .deps import readable_structure

    if preset not in DRR_PRESETS:
        raise HTTPException(status_code=422, detail={"code": "BAD_PRESET", "allowed": list(DRR_PRESETS)})
    try:
        session = session_for_study(app, request, study_id)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail={"code": "NO_STUDY", "study_id": study_id}) from exc
    plan = next((p for p in session.dataset.plans if p["series_instance_uid"] == plan_id), None)
    if plan is None:
        raise HTTPException(status_code=404, detail={"code": "NO_PLAN", "plan_id": plan_id})
    info, m, position = _plan_frame(session, plan)
    beam = next((b for b in info["beams"] if b["number"] == beam_number), None)
    if beam is None or beam["isocenter_mm"] is None:
        raise HTTPException(status_code=404, detail={"code": "NO_BEAM", "beam_number": beam_number})
    ct = next(
        (
            s
            for s in session.dataset.image_series
            if s.frame_of_reference_uid == info["frame_of_reference_uid"] and s.modality == "CT"
        ),
        None,
    ) or next(
        (s for s in session.dataset.image_series if s.frame_of_reference_uid == info["frame_of_reference_uid"]), None
    )
    if ct is None or m is None:
        raise HTTPException(
            status_code=422,
            detail={"code": "DRR_NO_CT", "message": "病例裡沒有這個計畫的 Frame of Reference 的影像，算不了 DRR"},
        )
    ids = [s for s in structure_ids.split(",") if s][:12]
    structures = [readable_structure(session, sid, None, request) for sid in ids]
    key = (str(plan["path"]), int(beam_number))
    cps = _CP_CACHE.get(key)
    if cps is None:
        cps = await run_cpu(lambda: read_beam_control_points(key[0], key[1]))
        _CP_CACHE[key] = cps
    if not cps["control_points"]:
        raise HTTPException(status_code=422, detail={"code": "NO_CONTROL_POINTS", "beam_number": beam_number})
    i = max(0, min(len(cps["control_points"]) - 1, int(cp)))
    c = cps["control_points"][i]
    try:
        check_geometry(c, position)
    except UnsupportedGeometry as exc:
        raise HTTPException(status_code=422, detail={"code": "DRR_UNSUPPORTED_GEOMETRY", "message": str(exc)}) from exc
    g, k, f = float(c["gantry_deg"] or 0.0), float(c["collimator_deg"] or 0.0), float(c["couch_deg"] or 0.0)
    sad = float(cps.get("sad_mm") or 1000.0)
    iso = beam["isocenter_mm"]
    # 結構在自己的 FoR → primary → 計畫（＝ CT）的 FoR
    plan_from_primary = np.linalg.inv(m)

    def struct_to_plan(st: Any) -> np.ndarray:
        fg = next((x for x in session.frame_groups if x.frame_of_reference_uid == st.frame_of_reference_uid), None)
        return plan_from_primary @ (fg.matrix if fg is not None else np.eye(4))

    def work() -> dict[str, Any]:
        mu = _MU_CACHE.get(ct.series_id)
        if mu is None:
            mu = attenuation_volume(np.asarray(ct.image(ct.grid, 0)), ct.grid)
            _MU_CACHE.clear()  # 只留一組（CT 換了就換）
            _MU_CACHE[ct.series_id] = mu
        dkey = (ct.series_id, key, round(g, 2), round(k, 2), round(f, 2), size, round(half, 1), position)
        integral = _DRR_CACHE.get(dkey)
        if integral is None:
            integral = drr(
                mu[0], mu[1], iso_world=iso, gantry_deg=g, collimator_deg=k, couch_deg=f,
                position=position, sad_mm=sad, size=size, half_mm=half,
            )  # fmt: skip
            if len(_DRR_CACHE) >= _DRR_CACHE_MAX:
                _DRR_CACHE.pop(next(iter(_DRR_CACHE)))
            _DRR_CACHE[dkey] = integral
        gray = apply_preset(integral, preset, (wc, ww))
        png = encode_png(np.repeat(gray[:, :, None], 3, axis=2))
        contours = []
        for st in structures:
            pts = _SURFACE_CACHE.get(st.content_hash)
            if pts is None:
                grid = session.mask_grid_for(st.frame_of_reference_uid).grid
                pts = surface_points(st.block, st.offset_ijk, grid)
                _SURFACE_CACHE[st.content_hash] = pts
            mm = struct_to_plan(st)
            world = pts @ mm[:3, :3].T + mm[:3, 3] if len(pts) else pts
            contours.append(
                {
                    "structure_id": st.structure_id,
                    "name": st.name,
                    "color_rgb": list(st.color_rgb),
                    "polylines": project_structure(
                        world,
                        iso_world=iso,
                        gantry_deg=g,
                        collimator_deg=k,
                        couch_deg=f,
                        position=position,
                        sad_mm=sad,
                        size=size,
                        half_mm=half,
                    ),  # fmt: skip
                }
            )
        return {
            "png_base64": base64.b64encode(png).decode("ascii"),
            "size": size,
            "half_mm": half,
            "preset": preset,
            "cp": i,
            "gantry_deg": g,
            "collimator_deg": k,
            "couch_deg": f,
            "position": position,
            "ct_series_id": ct.series_id,
            "contours": contours,
        }

    return await run_cpu(work)
