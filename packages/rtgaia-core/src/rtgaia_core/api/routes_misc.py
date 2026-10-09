"""變換、重切、3D 出圖、匯出與 job。"""

from __future__ import annotations

import asyncio
from dataclasses import replace
from typing import Any

import numpy as np
from fastapi import APIRouter, Depends, HTTPException, Query, Request, Response
from rtgaia_geom import FrameGroup, RegistrationInfo, ViewReference
from rtgaia_geom.hashing import digest_bytes

from .. import dataset_io as phantoms
from .. import render3d, render3d_vtk
from ..i18n import localized_route_class
from ..jobs import new_job
from ..limits import cpu_slot, limit, run_cpu
from ..reslice import reslice_plane
from .deps import (
    API,
    AppState,
    actor,
    payload_response,
    push_scene_to_case,
    readable_structure,
    readable_structure_ids,
    session_for_series,
    session_for_study,
    state,
)

router = APIRouter(route_class=localized_route_class())  # 錯誤、原因等句子依請求語言翻


def _check_pixel_budget(w: int, h: int, layers: int) -> None:
    """出圖尺寸在入口就限制（`w×h×layers`），不讓 client 的整數直接變成配置量。"""
    budget = limit("RTGAIA_RENDER_PIXEL_BUDGET")
    if w <= 0 or h <= 0:
        raise HTTPException(status_code=422, detail={"code": "RENDER_BUDGET", "message": "output_size_px 必須為正"})
    if w * h * layers > budget:
        raise HTTPException(
            status_code=422,
            detail={"code": "RENDER_BUDGET", "limit": budget, "actual": w * h * layers, "message": "出圖像素超過預算"},
        )


@router.post(API + "/transforms", status_code=201)
async def create_transform(request: Request, app: AppState = Depends(state)) -> Any:
    """前端在互動中調整剛性對齊時**不需要**呼叫這個端點。

    只有在「提交」時才建立 transform，以供後續模組（傳播、劑量映射）與匯出使用。

    `apply_to_frame_group: true` ＝ 提交的是**對位微調** —— 把
    `moving_series_id` 所在 FoR 的 FrameGroup 換成這個矩陣（`registration.source='manual'`），
    並推 `scene.replace`。矩陣仍過 F7（正交、det>0）—— 契約不因為是使用者手調就放鬆。
    """
    body = await request.json()
    # 以 body 裡的序列定位病例，不再假設「當前 session」
    moving_or_fixed = body.get("moving_series_id") or body.get("fixed_series_id")
    # 2026-10-09：只在請求者自己的 session 裡找（序列可能也在別人開的病例裡；沒給序列也不退回全域 current）
    session = (
        session_for_series(app, request, str(moving_or_fixed))
        if moving_or_fixed
        else app.store.own_current(actor(request))
    )
    kind = body.get("kind", "rigid")
    if kind == "rigid":
        matrix = body.get("matrix")
        if not matrix or len(matrix) != 16:
            raise HTTPException(
                status_code=422,
                detail={"code": "F3", "message": "kind=rigid 需要 16 個 float（column-major）"},
            )
        m = np.asarray(matrix, dtype=np.float64).reshape(4, 4, order="F")
        spec = {
            "kind": "rigid",
            "fixed_series_id": body.get("fixed_series_id"),
            "moving_series_id": body.get("moving_series_id"),
            "matrix": m.tolist(),
        }
    elif kind == "deformable":
        if not body.get("dvf_ref"):
            raise HTTPException(status_code=422, detail={"code": "NO_DVF", "message": "kind=deformable 需要 dvf_ref"})
        spec = {
            "kind": "deformable",
            "fixed_series_id": body.get("fixed_series_id"),
            "moving_series_id": body.get("moving_series_id"),
            "dvf_ref": body["dvf_ref"],
            # 測試後端不做 DIR；DVF 以單位變換代替，但契約形狀完整
            "matrix": np.eye(4).tolist(),
        }
    else:
        raise HTTPException(status_code=422, detail={"code": "BAD_KIND", "kind": kind})
    transform_id = app.store.register_transform(session, spec)
    await app.persist_case(session.case)
    out: dict[str, Any] = {"transform_id": transform_id, **{k: v for k, v in spec.items() if k != "matrix"}}
    if body.get("apply_to_frame_group"):
        if kind != "rigid":
            raise HTTPException(
                status_code=422, detail={"code": "BAD_KIND", "message": "apply_to_frame_group 只接受 rigid"}
            )
        moving = body.get("moving_series_id")
        old = next((fg for fg in session.frame_groups if fg.series_id == moving), None)
        if old is None:
            raise HTTPException(
                status_code=422,
                detail={"code": "NO_FRAME_GROUP", "message": "moving_series_id 不是任何 FrameGroup 的影像序列"},
            )
        if old.role != "secondary":
            raise HTTPException(
                status_code=422,
                detail={"code": "F5", "message": "primary 的 transform_to_primary 恆為單位矩陣，不得被調整"},
            )
        new = FrameGroup.secondary_rigid(
            old.frame_of_reference_uid,
            old.series_id,
            m,
            mask_grid_id=old.mask_grid_id,
            registration=RegistrationInfo(
                source="manual",
                sop_instance_uid=old.registration.sop_instance_uid if old.registration else None,
                matrix_type="RIGID",
                description=str(body.get("description") or "使用者微調"),
            ),
        )
        # 對位以 FoR 為單位：同一個 FoR 的次要影像（例：CBCT 的兩組重建）一起換，各自保留 series_id
        session.frame_groups = tuple(
            replace(new, series_id=fg.series_id)
            if fg.role == "secondary" and fg.frame_of_reference_uid == old.frame_of_reference_uid
            else fg
            for fg in session.frame_groups
        )
        await push_scene_to_case(app, session)  # 病例的每個 session 各收自己的 scene
        out["frame_group"] = new.to_wire()
    return out


@router.post(API + "/studies/{study_id}/reslice")
async def high_quality_reslice(study_id: str, request: Request, app: AppState = Depends(state)) -> Response:
    """B-spline 重切的單張 2D 切面。互動停止後的畫質補強。"""
    body = await request.json()
    # 比對的是**請求者自己的** DisplayGrid
    session = session_for_study(app, request, study_id, own=True)
    if body.get("display_grid_id") and body["display_grid_id"] != session.display_grid.display_grid_id:
        raise HTTPException(status_code=409, detail={"code": "I3", "message": "display_grid_id 不符"})
    view = ViewReference.from_wire(body["view_reference"])
    w, h = (int(v) for v in body.get("output_size_px", [512, 512]))
    _check_pixel_budget(w, h, 1)
    interpolator = body.get("interpolator", "bspline")
    series_id = body.get("series_id") or session.dataset.primary.series_id
    series = session.dataset.series_by_id(series_id)
    volume = phantoms.volume(session.dataset, series, view.frame_index or 0)
    px_mm = float(body.get("px_mm") or _fit_px_mm(series.grid, (w, h)))
    # hybrid 高品質重切要跟前端本地重切一樣「體積外 = NaN → 透明」；JSON 沒有 NaN，用字串 "nan"
    outside_raw = body.get("outside", -1024.0)
    outside = float("nan") if isinstance(outside_raw, str) and outside_raw.lower() == "nan" else float(outside_raw)

    # CPU 工作在受限 executor 跑、以 await 等待，不卡事件迴圈
    async with cpu_slot():
        plane = await asyncio.to_thread(
            reslice_plane,
            np.asarray(volume),
            series.grid,
            view,
            out_size_px=(w, h),
            px_mm=px_mm,
            interpolator=interpolator,
            outside=outside,
        )
    raw = np.ascontiguousarray(plane, dtype=np.float32).tobytes()
    header = {
        "semantics": "image",
        "components": 1,
        "dtype": "float32",
        "width": w,
        "height": h,
        "px_mm": px_mm,
        "interpolator": interpolator,
        "series_id": series_id,
        "view_reference": view.to_wire(),
        "frame_of_reference_uid": series.grid.frame_of_reference_uid,
        "content_hash": digest_bytes(raw, prefix="rs_"),
    }
    return payload_response(header, raw, app.chaos)


def _fit_px_mm(grid: Any, size_px: tuple[int, int]) -> float:
    extent = float(np.max(np.asarray(grid.size) * np.asarray(grid.spacing)))
    return extent / max(size_px)


@router.post(API + "/studies/{study_id}/render3d")
async def render_3d(study_id: str, request: Request, app: AppState = Depends(state)) -> Response:
    """`FallbackSpec.to='server-render'` 的唯一端點。

    **非互動**：由使用者明確觸發，回傳的影像以型態 F6 進場，不隨相機連動。
    """
    return await _render3d(study_id, await request.json(), request, app)


@router.post(API + "/studies/{study_id}/render3d/pick")
async def render_3d_pick(study_id: str, request: Request, app: AppState = Depends(state)) -> dict[str, Any]:
    """反向 pick：body 同 `/render3d`（layers／camera／crop／zoom／output_size_px）
    ＋ `pick: {x, y}`（像素，原點左上）。回 `{hit, world}`（primary 世界座標）；前端把十字線移過去。
    需要 VTK（MIP 退路沒有深度）。"""
    body = await request.json()
    pick = body.get("pick") or {}
    try:
        px, py = int(pick["x"]), int(pick["y"])
    except (KeyError, TypeError, ValueError) as exc:
        detail = {"code": "BAD_PICK", "message": "pick 要給 {x, y}（像素）"}
        raise HTTPException(status_code=422, detail=detail) from exc
    if not render3d_vtk.available():
        detail = {"code": "PICK_UNAVAILABLE", "message": "3D 反向點選需要 VTK 出圖"}
        raise HTTPException(status_code=422, detail=detail)
    # 反向 pick 只有 VTK 那條路有深度（MIP 退路是投影，沒有「第一個打到的東西」）
    out = await _render3d(study_id, {**body, "technique": "composite"}, request, app, pick_px=(px, py))
    assert isinstance(out, dict)
    return out


async def _render3d(
    study_id: str, body: dict[str, Any], request: Request, app: AppState, pick_px: tuple[int, int] | None = None
) -> Any:
    session = session_for_study(app, request, study_id)
    cam_wire = dict(body["camera"])
    raw_distance = cam_wire.pop("distance_mm", None)
    distance = float(raw_distance) if raw_distance is not None else None
    fov = float(cam_wire.pop("fov_deg", 30.0))
    camera = render3d.Camera(view=ViewReference.from_wire(cam_wire), distance_mm=distance, fov_deg=fov)
    w, h = (int(v) for v in body.get("output_size_px", [512, 512]))
    _check_pixel_budget(w, h, max(1, len(body.get("layers") or [])))
    grid = session.dataset.primary.grid

    # 影像層可以各自帶 frame_index（時間序列跟著游標）；沒帶就用 body 的
    frame_of_series = {
        str(layer.get("series_id")): layer.get("frame_index")
        for layer in (body.get("layers") or [])
        if layer.get("series_id") is not None
    }

    def volume_for(series_id: str) -> np.ndarray:
        series = session.dataset.series_by_id(series_id)
        frame = frame_of_series.get(series_id)
        return np.asarray(
            phantoms.volume(session.dataset, series, frame if frame is not None else body.get("frame_index") or 0)
        )

    # 3D 出圖選的結構一律經共用讀取閘（別人的暫存結果 404）；先整批驗，再交給 renderer
    # （前端送的是 `renderer: "mesh"` ＋ `structure_id`，之前只認 `kind: "mask"` ＋ `contentRef`，
    #  整批驗等於沒驗；各結構仍在 `mask_for` 裡逐一過閘，但失敗是在出圖執行緒裡丟、變 500 而不是 404）
    readable_structure_ids(
        session,
        [
            str(layer.get("structure_id") or layer.get("contentRef"))
            for layer in (body.get("layers") or [])
            if layer.get("renderer") == "mesh" or layer.get("kind") == "mask"
        ],
        request,
    )
    for layer in body.get("layers") or []:
        if layer.get("renderer") == "dose-3d":
            try:
                series = session.dataset.series_by_id(str(layer.get("series_id")))
            except (KeyError, StopIteration) as exc:
                raise HTTPException(
                    status_code=404, detail={"code": "NO_SERIES", "series_id": layer.get("series_id")}
                ) from exc
            if series.kind != "dose":
                raise HTTPException(status_code=422, detail={"code": "NOT_DOSE", "message": "dose-3d 只能用在劑量序列"})

    # 計畫射束 → 線與面（primary 座標；幾何在伺服器算）。MIP 退路沒有深度、畫不了線，略過
    from .routes_plan import beam_primitives_for

    layers_in: list[dict[str, Any]] = []
    for layer in body.get("layers") or []:
        if layer.get("renderer") == "beams":
            prim = await run_cpu(lambda layer=layer: beam_primitives_for(session, layer))
            if prim is not None:
                layers_in.append(prim)
        elif (
            layer.get("renderer") == "mesh"
            and layer.get("frame_index") is not None
            and (str(layer.get("structure_id")), None) not in session.structures
            and (str(layer.get("structure_id")), int(layer["frame_index"])) not in session.structures
            and any(sid == str(layer.get("structure_id")) for sid, _ in session.structures)
        ):
            continue  # 畫在 4DCT 某一相位上的結構，其他幀沒有它 → 這一幀的 3D 不畫（不是 404）
        else:
            layers_in.append(layer)
    body = {**body, "layers": layers_in}

    def mask_for(structure_id: str, frame_index: int | None) -> np.ndarray:
        st = readable_structure(session, structure_id, frame_index, request)
        return st.dense(session.grid_for_frame(st.frame_of_reference_uid))

    def to_primary(for_uid: str) -> np.ndarray | None:
        fg = next((f for f in session.frame_groups if f.frame_of_reference_uid == for_uid), None)
        return None if fg is None or fg.role == "primary" else fg.matrix

    technique = str(body.get("technique") or ("composite" if render3d_vtk.available() else "mip"))
    if body.get("crop"):
        # 兩條路徑同一個契約：方框與 primary 網格不相交 → 422（VTK 只會畫成全黑，看不出錯）
        try:
            render3d.crop_index_box(grid, body["crop"])
        except render3d.EmptyCrop as exc:
            raise HTTPException(status_code=422, detail={"code": "EMPTY_CROP", "message": str(exc)}) from exc
    if technique == "composite" and render3d_vtk.available():
        try:
            png, header = await render3d_vtk.render_async(
                session_id=session.session_id,
                layers=list(body.get("layers") or []),
                volume_for=volume_for,
                mask_for=mask_for,
                grid_for_series=lambda sid: session.dataset.series_by_id(sid).grid,
                grid_for_structure=lambda sid, frame: session.grid_for_frame(
                    session.structure(sid, frame).frame_of_reference_uid
                ),
                transform_for=lambda sid, structure=False: to_primary(
                    session.structure(sid).frame_of_reference_uid
                    if structure
                    else session.dataset.series_by_id(sid).frame_of_reference_uid
                ),
                mask_key_for=lambda sid, frame: session.structure(sid, frame).content_hash,
                camera=dict(body["camera"]),
                size_px=(w, h),
                crop=body.get("crop") or None,
                zoom=float(body.get("zoom") or 1.0),
                mapper=str(body.get("mapper") or "auto"),
                module_version="testbe-0.1.0",
                interactive=bool(body.get("interactive")),
                pick_px=pick_px,
            )
        except ValueError as exc:
            raise HTTPException(status_code=422, detail={"code": "UNRENDERABLE_LAYER", "message": str(exc)}) from exc
        if pick_px is not None:
            return dict(header["pick"])
        return payload_response(header, png, app.chaos, compress=False)

    try:
        async with cpu_slot():
            png, header = await asyncio.to_thread(
                render3d.render,
                layers=[x for x in body.get("layers") or [] if x.get("renderer") != "primitives"],
                volume_for=volume_for,
                mask_for=mask_for,
                grid=grid,
                camera=camera,
                size_px=(w, h),
                module_version="testbe-0.1.0",
                crop=body.get("crop") or None,
                zoom=float(body.get("zoom") or 1.0),
                mask_key_for=lambda sid, frame: session.structure(sid, frame).content_hash,
            )
    except render3d.EmptyCrop as exc:
        raise HTTPException(status_code=422, detail={"code": "EMPTY_CROP", "message": str(exc)}) from exc
    except ValueError as exc:
        raise HTTPException(status_code=422, detail={"code": "UNRENDERABLE_LAYER", "message": str(exc)}) from exc
    return payload_response(header, png, app.chaos, compress=False)


@router.post(API + "/studies/{study_id}/render3d/prepare")
async def render_3d_prepare(study_id: str, request: Request, app: AppState = Depends(state)) -> dict[str, Any]:
    """把一批結構的 3D mesh 先建好（磁碟快取有就讀），讓前端分批叫、顯示「建立 3D 模型 8／35」。
    沒有 VTK 就回 `available: False`（前端直接出圖，走 MIP 備援）。"""
    body = await request.json()
    session = session_for_study(app, request, study_id)
    ids = [str(x) for x in (body.get("structure_ids") or [])][:64]
    readable_structure_ids(session, ids, request)
    if not render3d_vtk.available() or not ids:
        return {"available": render3d_vtk.available(), "built": 0, "from_disk": 0, "in_memory": 0, "total": len(ids)}

    def to_primary(for_uid: str) -> np.ndarray | None:
        fg = next((f for f in session.frame_groups if f.frame_of_reference_uid == for_uid), None)
        return None if fg is None or fg.role == "primary" else fg.matrix

    async with cpu_slot():
        out = await render3d_vtk.prepare_meshes_async(
            session_id=session.session_id,
            structure_ids=ids,
            mask_for=lambda sid, frame: readable_structure(session, sid, frame, request).dense(
                session.grid_for_frame(session.structure(sid, frame).frame_of_reference_uid)
            ),
            grid_for_structure=lambda sid, frame: session.grid_for_frame(
                session.structure(sid, frame).frame_of_reference_uid
            ),
            transform_for=lambda sid, structure=False: to_primary(session.structure(sid).frame_of_reference_uid),
            mask_key_for=lambda sid, frame: session.structure(sid, frame).content_hash,
        )
    return {"available": True, **out}


@router.get(API + "/export/profiles")
async def export_profiles() -> dict[str, Any]:
    """匯出 profile 清單與預設（`RTGAIA_EXPORT_PROFILE`），以及目前的 UID 前綴（`RTGAIA_UID_ROOT`）。"""
    from ..dicom_uid import describe
    from ..export_profile import PROFILES, default_profile
    from ..i18n import translate

    labels = {"varian": "Varian Eclipse", "generic": "通用（UTF-8、名稱不截）"}
    return {
        "default": default_profile(),
        "profiles": [{"id": p, "label": translate(labels[p])} for p in PROFILES],
        "uid_root": translate(describe()),
    }


@router.get(API + "/export/tags")
async def export_tags(format: str = Query("rtstruct", description="rtstruct｜rtdose")) -> dict[str, Any]:
    """匯出時可改的 DICOM 標籤白名單（keyword → VR、最大長度、是否 PHI）。給前端畫表單。
    `format=rtdose` ＝ 劑量運算存成 RTDOSE 的白名單（同一份去掉結構集欄位）。"""
    from ..rtdose_export import DOSE_EDITABLE_TAGS
    from ..rtstruct import EDITABLE_TAGS, PHI_TAGS

    table = DOSE_EDITABLE_TAGS if format == "rtdose" else EDITABLE_TAGS
    return {"tags": [{"keyword": k, "vr": vr, "max_length": n, "phi": k in PHI_TAGS} for k, (vr, n) in table.items()]}


@router.post(API + "/studies/{study_id}/export", status_code=202)
async def export(study_id: str, request: Request, app: AppState = Depends(state)) -> Any:
    """從 labelmap 在取像平面重抽輪廓，產生 RTSTRUCT。

    進 job 佇列，worker 執行，結果進 blob store（重啟後仍可下載）。"""
    body = await request.json()
    session = session_for_study(app, request, study_id)
    fmt = body.get("format", "rtstruct")
    if fmt != "rtstruct":
        raise HTTPException(status_code=422, detail={"code": "BAD_FORMAT", "format": fmt})
    if body.get("profile") is not None:
        from ..export_profile import PROFILES

        if body["profile"] not in PROFILES:
            raise HTTPException(status_code=422, detail={"code": "BAD_PROFILE", "profiles": list(PROFILES)})
    if "anonymize" in body and not isinstance(body["anonymize"], bool):
        raise HTTPException(status_code=422, detail={"code": "BAD_ANONYMIZE", "message": "anonymize 必須是布林"})
    if "save_to_library" in body and not isinstance(body["save_to_library"], bool):
        raise HTTPException(status_code=422, detail={"code": "BAD_SAVE", "message": "save_to_library 必須是布林"})
    if body.get("save_to_library") and not app.library_root:
        raise HTTPException(
            status_code=422, detail={"code": "NO_LIBRARY", "message": "沒有設定資料庫目錄，不能存入資料庫"}
        )
    try:
        from ..rtstruct import validate_tags

        validate_tags(dict(body.get("tags") or {}))
    except ValueError as exc:
        raise HTTPException(status_code=422, detail={"code": "BAD_TAG", "message": str(exc)}) from exc
    # 明確指定的結構一律經共用讀取閘；沒指定時的預設集合本來就只含自己看得到的
    structure_ids = (
        readable_structure_ids(session, [str(s) for s in body["structure_ids"]], request)
        if body.get("structure_ids")
        else [sid for sid, _ in session.structures]
    )
    job = new_job(
        session.case.case_id,
        "export",
        {**body, "structure_ids": structure_ids},
        requested_by=actor(request),
    )
    await (await app.job_queue_async()).enqueue(job)
    session.case.jobs[job.job_id] = job.to_wire()
    await app.persist_case(session.case)
    return {"job_id": job.job_id, "case_id": job.case_id, "status": job.status}


@router.get(API + "/jobs")
async def list_jobs(
    case_id: str | None = Query(None),
    kind: str | None = Query(None, description="export|import|send|retrieve"),
    limit: int = Query(50, ge=1, le=500),
    app: AppState = Depends(state),
) -> Any:
    jobs = await (await app.job_queue_async()).list(case_id, limit=limit)
    return [j.to_wire() for j in jobs if kind is None or j.kind == kind]


@router.get(API + "/jobs/{job_id}")
async def get_job(job_id: str, app: AppState = Depends(state)) -> Any:
    job = await (await app.job_queue_async()).get(job_id)
    if job is None:
        raise HTTPException(status_code=404, detail={"code": "NO_JOB", "job_id": job_id})
    return job.to_wire()


@router.get(API + "/jobs/{job_id}/download")
async def download_job(job_id: str, app: AppState = Depends(state)) -> Response:
    job = await (await app.job_queue_async()).get(job_id)
    if job is None or job.result_blob_key is None:
        raise HTTPException(status_code=404, detail={"code": "NO_EXPORT", "job_id": job_id})
    try:
        data = app.export_blobs_get(job.result_blob_key)
    except KeyError as exc:
        raise HTTPException(status_code=410, detail={"code": "EXPORT_GONE", "job_id": job_id}) from exc
    return Response(
        content=data,
        media_type="application/dicom",
        headers={"Content-Disposition": f'attachment; filename="{job_id}.dcm"'},
    )
