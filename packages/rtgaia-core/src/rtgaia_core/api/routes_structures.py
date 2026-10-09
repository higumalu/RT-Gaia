"""結構 —— 清單、mask、mesh、編輯、後處理、新建、審核。"""

from __future__ import annotations

import asyncio
import base64
from typing import Any

import numpy as np
from fastapi import APIRouter, Depends, HTTPException, Query, Request, Response
from rtgaia_geom import Provenance, ViewReference, require
from rtgaia_geom.hashing import payload_content_hash

from .. import dataset_io as phantoms
from .. import mesh as mesh_mod
from ..i18n import localized_route_class, translate
from ..limits import CLIENT_ID_MAX, STRUCTURE_ID_MAX
from ..ops import OpContext, get_op, run_op
from ..state import MODULE_VERSION, ConflictError, StructureState, StructureVersion
from .deps import (
    API,
    AppState,
    actor,
    is_admin,
    json_maybe_corrupted,
    payload_response,
    push_case,
    readable_structure,
    require_id,
    session_for_structure,
    session_for_study,
    state,
)

router = APIRouter(route_class=localized_route_class())  # 錯誤、原因等句子依請求語言翻


def _is_admin(request: Request) -> bool:
    return is_admin(request)


def _require_editable(session: Any, st: StructureState, request: Request) -> None:
    """匯入集唯讀、別人的工作集唯讀 —— 要改先「合併到我的集」。403 帶原因與該結構的集。"""
    ok, code = session.case.can_edit(st, user=actor(request), is_admin=_is_admin(request))
    if ok:
        return
    s = session.case.structure_set(st.structure_set_id) or {}
    raise HTTPException(
        status_code=403,
        detail={
            "code": code,
            "structure_id": st.structure_id,
            "structure_set_id": st.structure_set_id,
            "structure_set_label": s.get("label"),
            "owner": s.get("owner"),
            "message": "匯入的結構集唯讀；請先「合併到我的結構集」再編輯"
            if code == "IMPORT_READ_ONLY"
            else f"這是 {s.get('owner')} 的結構集；請先合併到你的結構集再編輯",
        },
    )


def _target_work_set(session: Any, request: Request, for_uid: str, requested: str | None) -> str | None:
    """新建／複製要進哪個集：library 病例 → 我的工作集（自動建）；body 指定自己的工作集也可；假體 → None。"""
    case = session.case
    if not case.uses_structure_sets:
        return None
    if requested:
        s = case.structure_set(str(requested))
        if s is None:
            raise HTTPException(status_code=422, detail={"code": "NO_STRUCTURE_SET", "structure_set_id": requested})
        if s.get("kind", "import") == "import":
            raise HTTPException(
                status_code=422,
                detail={"code": "IMPORT_READ_ONLY", "message": "不能在匯入的結構集裡新增；請用你的工作集"},
            )
        if s.get("owner") != actor(request) and not _is_admin(request):
            raise HTTPException(status_code=403, detail={"code": "NOT_OWNER", "owner": s.get("owner")})
        if s.get("frame_of_reference_uid") != for_uid:
            raise HTTPException(status_code=422, detail={"code": "FOR_MISMATCH", "message": "結構集屬於另一組影像"})
        return str(requested)
    ws = case.work_set_for(actor(request), for_uid)
    return ws["structure_set_id"] if ws else None


async def announce_new_work_set(app: AppState, session: Any, sets_before: int) -> None:
    """`_target_work_set` 自動建了工作集 → 在 `layer.add` **之前**推 `structure_sets.changed`。

    沒推的話，同病例的每個 session（包括建立者自己）收到新結構時還不認得它的集，清單把它放進
    「其他（沒有來源結構集）」，要重新整理才歸位（2026-10-09 錄 demo 時發現）。
    """
    if len(session.case.structure_sets) != sets_before:
        await push_case(app, session, "structure_sets.changed", {"caseId": session.case.case_id})


@router.get(API + "/studies/{study_id}/structures")
async def list_structures(study_id: str, request: Request, app: AppState = Depends(state)) -> list[dict[str, Any]]:
    """結構清單 —— 不含體素資料。`bbox_ijk` 是 **mask grid** 索引空間。"""
    session = session_for_study(app, request, study_id)
    user, admin = actor(request), _is_admin(request)
    out = []
    for e in session.case.structure_list(user=user):  # 以**請求者**過濾別人的暫存集（session 可能是別人的）
        # 對目前使用者能不能改（匯入集唯讀、別人的工作集唯讀）
        st = session.structure(e["structure_id"])
        e["editable"] = session.case.can_edit(st, user=user, is_admin=admin)[0]
        out.append(json_maybe_corrupted(e, app.chaos))
    return out


@router.get(API + "/structures/{structure_id}/mask")
async def get_mask(
    structure_id: str,
    mask_grid: str = Query(..., description="參數是 mask_grid 不是 grid"),
    frame: int | None = Query(None),
    request: Request = None,  # type: ignore[assignment]
    app: AppState = Depends(state),
) -> Response:
    session = session_for_structure(app, request, structure_id)
    st = readable_structure(session, structure_id, frame, request)  # 共用的讀取閘
    # 🔴 比對的是**這個結構的 FoR** 的 MaskGrid，不是 session 唯一的那個
    expected = session.mask_grid_for(st.frame_of_reference_uid)
    if mask_grid != expected.mask_grid_id:
        raise HTTPException(
            status_code=409,
            detail={
                "code": "I3",
                "message": "mask_grid 與該結構 FoR 的 MaskGrid 不符——請重新 POST /grids",
                "session_mask_grid_id": expected.mask_grid_id,
                "frame_of_reference_uid": st.frame_of_reference_uid,
            },
        )
    payload = st.payload(expected)
    return payload_response(payload.to_header(), payload.data, app.chaos)


@router.get(API + "/structures/{structure_id}/mesh")
async def get_mesh(
    structure_id: str,
    mask_grid: str = Query(...),
    lod: int = Query(0, ge=0, le=2),
    frame: int | None = Query(None),
    request: Request = None,  # type: ignore[assignment]
    app: AppState = Depends(state),
) -> Response:
    """mesh 帶的是 `mask_grid_id`（I2），頂點為 LPS mm 世界座標。"""
    session = session_for_structure(app, request, structure_id)
    st = readable_structure(session, structure_id, frame, request)
    expected = session.mask_grid_for(st.frame_of_reference_uid)
    if mask_grid != expected.mask_grid_id:
        raise HTTPException(status_code=409, detail={"code": "I3", "message": "mask_grid 不符"})
    grid = session.grid_for_frame(st.frame_of_reference_uid)
    payload = mesh_mod.extract(
        st.dense(grid),
        grid,
        structure_id=structure_id,
        mask_grid_id=expected.mask_grid_id,
        lod=lod,
        frame_index=st.frame_index,
    )
    body = payload.vertices.tobytes() + payload.triangles.tobytes()
    header = {
        **payload.to_header(),
        "layout": [
            {"name": "vertices", "dtype": "float32", "components": 3, "count": int(len(payload.vertices))},
            {"name": "triangles", "dtype": "uint32", "components": 3, "count": int(len(payload.triangles))},
        ],
        "vertex_space": "world_lps_mm",
    }
    return payload_response(header, body, app.chaos)


@router.post(API + "/structures/{structure_id}/edit")
async def edit_structure(structure_id: str, request: Request, app: AppState = Depends(state)) -> Any:
    """樂觀更新的伺服器端。409 只在真正的外部修改時發生。"""
    body = await request.json()
    session = session_for_structure(app, request, structure_id)
    frame = body.get("frame_index")
    _require_editable(session, session.structure(structure_id, frame), request)

    if app.chaos.stale_hash:
        # chaos: stale_hash —— 一律回 409，驗證前端「重取 mask ＋ 提示使用者」
        st = session.structure(structure_id, frame)
        return _conflict(st.content_hash, "chaos:stale_hash", "故障注入：一律回報 hash 過期")

    raw = body.get("data")
    if isinstance(raw, str):
        decoded = base64.b64decode(raw)
    elif raw is None:
        decoded = b""
    else:
        raise HTTPException(status_code=422, detail={"code": "BAD_DATA", "message": "data 必須是 base64 字串"})

    size = [int(v) for v in body["size_ijk"]]
    expected = size[0] * size[1] * size[2]
    if len(decoded) == expected:
        block = np.frombuffer(decoded, dtype=np.uint8).reshape(size[2], size[1], size[0])
    else:
        try:
            import zstandard as zstd

            inflated = zstd.ZstdDecompressor().decompress(decoded, max_output_size=expected)
        except Exception as exc:  # noqa: BLE001
            raise HTTPException(
                status_code=422,
                detail={
                    "code": "I9",
                    "message": f"編輯區塊長度與 size_ijk 不符（宣告 {expected}，收到 {len(decoded)}）",
                },
            ) from exc
        block = np.frombuffer(inflated, dtype=np.uint8).reshape(size[2], size[1], size[0])

    try:
        view = ViewReference.from_wire(body["view_reference"])
    except KeyError as exc:
        raise HTTPException(
            status_code=422,
            detail={"code": "P3", "message": "view_reference 必填——不得存 slice index"},
        ) from exc

    if _approved_locked(session, structure_id, frame):
        return _locked(structure_id)
    try:
        st = session.apply_edit(
            structure_id=structure_id,
            frame_index=frame,
            mask_grid_id=body["mask_grid_id"],
            base_content_hash=body["base_content_hash"],
            offset_ijk=tuple(int(v) for v in body["offset_ijk"]),  # type: ignore[arg-type]
            size_ijk=tuple(size),  # type: ignore[arg-type]
            data=block,
            view_reference=view,
            client_seq=int(body.get("client_seq", 0)),
            # 沒帶 client_id 的舊 client 全部落在同一個桶（維持舊行為）
            client_id=require_id(body.get("client_id") or "anonymous", field="client_id", max_len=CLIENT_ID_MAX),
            user=actor(request),
        )
    except ConflictError as exc:
        return _conflict(exc.content_hash, exc.reason, str(exc))

    await push_case(
        app,
        session,
        "mask.updated",
        {"structureId": structure_id, "frameIndex": st.frame_index, "contentHash": st.content_hash},
    )
    grid = session.grid_for_frame(st.frame_of_reference_uid)
    return {
        "content_hash": st.content_hash,
        "client_seq": int(body.get("client_seq", 0)),
        "volume_cc": st.volume_cc(grid),
        "status": st.status,
        "provenance": st.provenance.to_wire(),
        "version_id": st.head.version_id,
        "version_count": len(st.versions),
    }


def _approved_locked(session: Any, structure_id: str, frame: int | None) -> bool:
    try:
        return session.structure(structure_id, frame).status == "approved"
    except KeyError:
        return False


def _locked(structure_id: str) -> Response:
    """`approved` 的結構對所有人唯讀 —— 要改先在簽核面板 reopen（審核者），會留簽核事件。"""
    from fastapi.responses import JSONResponse

    return JSONResponse(
        status_code=409,
        content={
            "code": "APPROVED_LOCKED",
            "structure_id": structure_id,
            "message": "結構已簽核（approved），唯讀；要修改請先由審核者重新開啟（reopen）",
        },
    )


def _conflict(content_hash: str, reason: str, message: str) -> Response:
    from fastapi.responses import JSONResponse

    return JSONResponse(
        status_code=409,
        content={"code": "CONFLICT", "reason": reason, "message": message, "content_hash": content_hash},
    )


@router.post(API + "/structures/{structure_id}/postprocess")
async def postprocess(structure_id: str, request: Request, app: AppState = Depends(state)) -> Response:
    """`op` 由註冊表決定，不是固定 enum。

    body 帶 `mask_grid_id` 與 `frame_index`。
    """
    body = await request.json()
    session = session_for_structure(app, request, structure_id)
    frame = body.get("frame_index")
    st = session.structure(structure_id, frame)
    _require_editable(session, st, request)
    if st.status == "approved":
        return _locked(structure_id)

    own_mask_grid = session.mask_grid_for(st.frame_of_reference_uid)
    if "mask_grid_id" in body:
        require(
            body["mask_grid_id"] == own_mask_grid.mask_grid_id,
            "I3",
            "postprocess 的 mask_grid_id 與該結構 FoR 的 MaskGrid 不符",
            request=body["mask_grid_id"],
            session=own_mask_grid.mask_grid_id,
        )
    if st.content_hash != body.get("base_content_hash", st.content_hash):
        return _conflict(st.content_hash, "stale_hash", "base_content_hash 已過期")

    grid = session.grid_for_frame(st.frame_of_reference_uid)
    op = get_op(str(body["op"]))

    def image_for_structure() -> np.ndarray | None:
        try:
            series = session.dataset.image_series_for(st.frame_of_reference_uid)
        except KeyError:
            return None
        vol = np.asarray(phantoms.volume(session.dataset, series, frame or 0))
        # PET 存 SUV×100 → 閾值／區域生長的區間用實際單位（SUV），跟前端欄位一致
        scale = float((series.params or {}).get("value_scale") or 1.0)
        return vol.astype(np.float32) * np.float32(scale) if scale != 1.0 else vol

    def other_mask(sid: str) -> np.ndarray:
        # 另一個結構只在某幾幀、這一幀沒有它 → 說清楚（以前是 404 NOT_FOUND）
        try:
            other = session.structure(sid, frame)
        except KeyError as exc:
            raise HTTPException(
                status_code=422,
                detail={
                    "code": "OTHER_NOT_IN_FRAME",
                    "message": f"「{sid}」沒有第 {(frame or 0) + 1} 幀（只在其他相位）",
                    "structure_id": sid,
                    "frame_index": frame,
                },
            ) from exc
        return other.dense(grid)

    ctx = OpContext(other_mask=other_mask, image=image_for_structure)
    # SimpleITK 在執行緒跑 —— 別讓一個人的 region_grow 卡住其他人的影像請求
    # 填洞、去離島、平滑只在結構的外接方塊上跑（`ops.run_op`）
    result = await asyncio.to_thread(run_op, op, st.dense(grid), grid, dict(body.get("params") or {}), ctx)

    parent = st.content_hash
    st.replace_dense(
        result,
        Provenance(
            source="post-process",
            module_version=f"{MODULE_VERSION}+{op.op_id}",
            parent_hash=parent,
        ),
        kind="post-process",
        user=actor(request),
        note=op.op_id,
    )
    await push_case(
        app,
        session,
        "mask.updated",
        {"structureId": structure_id, "frameIndex": st.frame_index, "contentHash": st.content_hash},
    )
    payload = st.payload(own_mask_grid)
    return payload_response(
        {**payload.to_header(), "op": op.op_id, "version_id": st.head.version_id}, payload.data, app.chaos
    )


@router.post(API + "/studies/{study_id}/structures", status_code=201)
async def create_structure(study_id: str, request: Request, app: AppState = Depends(state)) -> Any:
    """新建空結構 ＋ TG-263 命名驗證與建議。"""
    body = await request.json()
    session = session_for_study(app, request, study_id)
    name = str(body["name"])
    for_uid = str(body.get("frame_of_reference_uid") or session.dataset.primary.frame_of_reference_uid)
    if body.get("mask_grid_id") and body["mask_grid_id"] != session.mask_grid_for(for_uid).mask_grid_id:
        raise HTTPException(status_code=409, detail={"code": "I3", "message": "mask_grid_id 不符"})
    structure_id = (
        require_id(body["structure_id"], field="structure_id", max_len=STRUCTURE_ID_MAX)
        if body.get("structure_id")
        else session.case.next_user_structure_id()
    )
    if session.case.structure_id_taken(structure_id):
        raise HTTPException(status_code=409, detail={"code": "DUPLICATE", "structure_id": structure_id})
    # 新建一律進**我的工作集**（該 FoR；沒有就自動建）；匯入集不能新增
    sets_before = len(session.case.structure_sets)
    structure_set_id = _target_work_set(session, request, for_uid, body.get("structure_set_id"))

    # 該 FoR 的影像是時間軸 → 新結構只屬於**目前那一幀**（前端帶 `frame_index`，沒帶 ＝ 0）
    image = session.dataset.image_series_for(for_uid)
    temporal_group_id = image.temporal_group_id
    frame_index: int | None = None
    if temporal_group_id is not None:
        tg = next(g for g in session.temporal_groups if g.temporal_group_id == temporal_group_id)
        frame_index = int(body.get("frame_index") or 0)
        tg.validate_frame_index(frame_index)
    empty = np.zeros((1, 1, 1), dtype=np.uint8)
    st = StructureState(
        structure_id=structure_id,
        name=name,
        color_rgb=tuple(int(v) for v in body.get("color_rgb", (255, 255, 0))),  # type: ignore[arg-type]
        frame_of_reference_uid=for_uid,
        offset_ijk=(0, 0, 0),
        size_ijk=(1, 1, 1),
        block=empty,
        content_hash=payload_content_hash(offset_ijk=(0, 0, 0), size_ijk=(1, 1, 1), data=empty.tobytes(), prefix="mh_"),
        provenance=Provenance(source="import", module_version=MODULE_VERSION),
        status="under_review",
        tg263_code=body.get("tg263_code"),
        interpreted_type=(str(body["interpreted_type"]).upper() if body.get("interpreted_type") else None),
        structure_set_id=structure_set_id,
        created_by=actor(request),
        updated_by=actor(request),
        temporal_group_id=temporal_group_id,
        frame_index=frame_index,
    )
    session.structures[st.key] = st
    session.case.touch()
    await announce_new_work_set(app, session, sets_before)
    layer = next(x for x in session.layers() if x["contentRef"] == structure_id)
    await push_case(app, session, "layer.add", layer)
    return {
        "structure_id": structure_id,
        "structure_set_id": structure_set_id,
        "tg263_suggestion": tg263_suggest(name),
        "content_hash": st.content_hash,
        "status": st.status,
        "version_id": st.head.version_id,
        "frame_index": frame_index,
    }


TG263_HINTS: dict[str, str] = {
    "ptv": "PTV_<dose>",
    "ctv": "CTV_<dose>",
    "gtv": "GTV",
    "body": "External",
    "cord": "SpinalCord",
    "lung": "Lung_L / Lung_R / Lungs",
    "parotid": "Parotid_L / Parotid_R",
}


def tg263_suggest(name: str) -> dict[str, Any]:
    """極簡的 TG-263 建議。

    正式後端該接完整的 TG-263 表；這裡只需要讓**前端的建議 UI 有東西可畫**，
    而不是等到接完整表才能動工。
    """
    lowered = name.lower()
    for key, suggestion in TG263_HINTS.items():
        if key in lowered:
            return {"matched": key, "suggestion": suggestion, "compliant": name == suggestion}
    return {"matched": None, "suggestion": None, "compliant": None}


REVIEW_DEVICES = ("phone", "tablet", "desktop")


@router.post(API + "/studies/{study_id}/review")
async def review(study_id: str, request: Request, app: AppState = Depends(state)) -> Any:
    """審核簽核。狀態機：`ai_generated → under_review → edited → approved | rejected`。"""
    body = await request.json()
    session = session_for_study(app, request, study_id)
    user = actor(request)
    note = str(body.get("note", ""))
    # 手機也可以簽核：簽核事件記下在哪一類裝置上簽的；舊前端不送 → 不記
    device = body.get("device")
    if device is not None and device not in REVIEW_DEVICES:
        raise HTTPException(
            status_code=422,
            detail={"code": "BAD_DEVICE", "message": f"device 只能是 {'、'.join(REVIEW_DEVICES)}"},
        )
    updated: dict[str, str] = {}
    events: list[dict[str, Any]] = []
    for structure_id, status in (body.get("structure_statuses") or {}).items():
        if status not in ("approved", "rejected", "under_review"):
            raise HTTPException(
                status_code=422,
                detail={"code": "BAD_STATUS", "message": f"不允許直接設為 {status!r}"},
            )
        for (sid, fi), st in session.structures.items():
            if sid == structure_id:
                if (session.case.structure_set(st.structure_set_id) or {}).get("kind") == "transient":
                    raise HTTPException(
                        status_code=409,
                        detail={
                            "code": "TRANSIENT_NOT_SIGNABLE",
                            "structure_id": sid,
                            "message": "暫存的 plugin 結果不能簽核；請先「保存到我的結構集」",
                        },
                    )
                # 每一次狀態轉移一個事件 —— 誰、何時、從什麼到什麼。`status` 是它的投影。
                events.append(
                    session.case.record_review(
                        structure_id=sid,
                        frame_index=fi,
                        from_status=st.status,
                        to_status=status,
                        note=note,
                        user=user,
                        tier=session.tier_decision.assigned,
                        device=device,
                    )
                )
                st.status = status  # type: ignore[assignment]
                st.updated_by = user
                st.updated_at = events[-1]["at"]
                updated[f"{sid}@{fi}"] = status
    for structure_id in {k.split("@")[0] for k in updated}:
        layer = next((x for x in session.layers() if x["contentRef"] == structure_id), None)
        if layer:
            await push_case(app, session, "layer.update", layer)
    return {"updated": updated, "events": events, "structures": session.case.structure_list(user=user)}


@router.patch(API + "/structures/{structure_id}")
async def update_structure(structure_id: str, request: Request, app: AppState = Depends(state)) -> Any:
    """改名／改色／TG-263 代碼（所有相位一起改）；推 `layer.update`。
    名稱、顏色、代碼都會進匯出的 RTSTRUCT：任一相位已簽核 → 409 APPROVED_LOCKED（以前不擋，改得到已簽核的結構）。"""
    body = await request.json()
    session = session_for_structure(app, request, structure_id)
    targets = [st for (sid, _), st in session.structures.items() if sid == structure_id]
    if not targets:
        raise HTTPException(status_code=404, detail={"code": "NO_STRUCTURE", "structure_id": structure_id})
    _require_editable(session, targets[0], request)
    if any(st.status == "approved" for st in targets):
        return _locked(structure_id)
    for st in targets:
        if "name" in body and str(body["name"]).strip():
            st.name = str(body["name"]).strip()
        if "color_rgb" in body:
            c = body["color_rgb"]
            if not (isinstance(c, list) and len(c) == 3):
                raise HTTPException(status_code=422, detail={"code": "BAD_COLOR", "message": "color_rgb 要 3 個 0–255"})
            st.color_rgb = tuple(max(0, min(255, int(v))) for v in c)  # type: ignore[assignment]
        if "tg263_code" in body:
            st.tg263_code = body["tg263_code"]
        if "interpreted_type" in body:
            st.interpreted_type = str(body["interpreted_type"]).upper() if body["interpreted_type"] else None
        st.updated_by = actor(request)
    session.case.touch()
    layer = next(x for x in session.layers() if x["contentRef"] == structure_id)
    await push_case(app, session, "layer.update", layer)
    entry = next(e for e in session.structure_list() if e["structure_id"] == structure_id)
    return entry


@router.delete(API + "/structures/{structure_id}", status_code=204)
async def delete_structure(structure_id: str, request: Request, app: AppState = Depends(state)) -> Response:
    """真刪除（所有相位）；推 `layer.remove`。

    刪除也是一個簽核事件（誰、何時，`to_status="deleted"`），留在 review_events。
    已簽核的也可以刪（進封存區，只有管理者看得到、救得回）—— 刻意不擋。"""
    session = session_for_structure(app, request, structure_id)
    keys = [k for k in session.structures if k[0] == structure_id]
    if not keys:
        raise HTTPException(status_code=404, detail={"code": "NO_STRUCTURE", "structure_id": structure_id})
    _require_editable(session, session.structures[keys[0]], request)
    session.case.retired_structure_ids.add(structure_id)  # 進暫存區／封存區，id 不可再用
    for k in keys:
        st = session.structures.pop(k, None)
        if st is not None:
            session.case.record_review(
                structure_id=k[0],
                frame_index=k[1],
                from_status=st.status,
                to_status="deleted",
                note="",
                user=actor(request),
                structure_name=st.name,
            )
    session.layer_overrides.pop(f"mask:{structure_id}", None)
    await push_case(app, session, "layer.remove", {"layerId": f"mask:{structure_id}"})
    return Response(status_code=204)


@router.post(API + "/structures/{structure_id}/copy", status_code=201)
async def copy_structure(structure_id: str, request: Request, app: AppState = Depends(state)) -> Any:
    """複製（新 id、`provenance.parent_hash` 指向來源、status under_review）；推 `layer.add`。"""
    body = await request.json() if int(request.headers.get("content-length") or 0) > 0 else {}
    session = session_for_structure(app, request, structure_id)
    sources = [st for (sid, _), st in session.structures.items() if sid == structure_id]
    if not sources:
        raise HTTPException(status_code=404, detail={"code": "NO_STRUCTURE", "structure_id": structure_id})
    new_id = (
        require_id(body["structure_id"], field="structure_id", max_len=STRUCTURE_ID_MAX)
        if body.get("structure_id")
        else session.case.unique_structure_id(f"{structure_id}_copy1", sep="_")
    )
    if session.case.structure_id_taken(new_id):
        raise HTTPException(status_code=409, detail={"code": "DUPLICATE", "structure_id": new_id})
    # 預設名稱跟請求的介面語言（存進 DB、會匯出到 RTSTRUCT —— 英文介面不該冒出「複本」）；只翻模板，不動來源名稱
    name = str(body.get("name") or translate("{name} 複本").replace("{name}", sources[0].name))
    sets_before = len(session.case.structure_sets)
    for src in sources:
        st = StructureState(
            structure_id=new_id,
            name=name,
            color_rgb=src.color_rgb,
            frame_of_reference_uid=src.frame_of_reference_uid,
            offset_ijk=src.offset_ijk,
            size_ijk=src.size_ijk,
            block=src.block.copy(),
            content_hash=src.content_hash,
            provenance=Provenance(
                source="post-process", module_version=f"{MODULE_VERSION}+copy", parent_hash=src.content_hash
            ),
            status="under_review",
            tg263_code=src.tg263_code,
            interpreted_type=src.interpreted_type,
            default_visible=True,
            temporal_group_id=src.temporal_group_id,
            frame_index=src.frame_index,
            # 複本進我的工作集（來源可以是任何集 —— 這就是最小的「合併」）
            structure_set_id=_target_work_set(
                session, request, src.frame_of_reference_uid, body.get("structure_set_id")
            ),
            created_by=actor(request),
            updated_by=actor(request),
        )
        # 複本的第一版 kind 是 copy，note 指向來源結構與版本
        st.versions[0] = StructureVersion(
            **{**st.versions[0].__dict__, "kind": "copy", "note": f"複製自 {structure_id}@{src.head.version_id}"}
        )
        session.structures[st.key] = st
    session.case.touch()
    await announce_new_work_set(app, session, sets_before)
    layer = next(x for x in session.layers() if x["contentRef"] == new_id)
    await push_case(app, session, "layer.add", layer)
    return {"structure_id": new_id, "source_structure_id": structure_id, "content_hash": sources[0].content_hash}


@router.get(API + "/structures/{structure_id}/versions")
async def list_versions(
    structure_id: str,
    frame: int | None = Query(None),
    request: Request = None,  # type: ignore[assignment]
    app: AppState = Depends(state),
) -> dict[str, Any]:
    """結構的版本鏈（不含體素）。`head_version_id` 是目前的內容。"""
    session = session_for_structure(app, request, structure_id)
    st = readable_structure(session, structure_id, frame, request)
    return {
        "structure_id": structure_id,
        "frame_index": st.frame_index,
        "head_version_id": st.head.version_id,
        "content_hash": st.content_hash,
        "created_by": st.created_by,
        "updated_by": st.updated_by,
        "updated_at": st.updated_at,
        "versions": [v.to_wire() for v in st.versions],
    }


@router.get(API + "/structures/{structure_id}/versions/{version_id}/mask")
async def version_mask(
    structure_id: str,
    version_id: str,
    mask_grid: str = Query(..., description="參數是 mask_grid 不是 grid"),
    frame: int | None = Query(None),
    request: Request = None,  # type: ignore[assignment]
    app: AppState = Depends(state),
) -> Response:
    """某一版的 MaskPayload。**`parent_hash` 指向的東西真的取得到**，這是追溯鏈成立的條件。"""
    session = session_for_structure(app, request, structure_id)
    st = readable_structure(session, structure_id, frame, request)
    expected = session.mask_grid_for(st.frame_of_reference_uid)
    if mask_grid != expected.mask_grid_id:
        raise HTTPException(status_code=409, detail={"code": "I3", "session_mask_grid_id": expected.mask_grid_id})
    try:
        v = st.version(version_id)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail={"code": "NO_VERSION", "message": str(exc)}) from exc
    from rtgaia_geom import MaskPayload

    payload = MaskPayload(
        structure_id=structure_id,
        mask_grid_id=expected.mask_grid_id,
        frame_of_reference_uid=st.frame_of_reference_uid,
        offset_ijk=v.offset_ijk,
        size_ijk=v.size_ijk,
        data=np.ascontiguousarray(v.block, dtype=np.uint8).tobytes(),
        content_hash=v.content_hash,
        provenance=v.provenance,
        temporal_group_id=st.temporal_group_id,
        frame_index=st.frame_index,
    )
    return payload_response({**payload.to_header(), "version": v.to_wire()}, payload.data, app.chaos)


@router.post(API + "/structures/{structure_id}/revert")
async def revert_structure(structure_id: str, request: Request, app: AppState = Depends(state)) -> dict[str, Any]:
    """回到某一版。**也是新的一版**（`kind='revert'`），歷史不刪；推 `mask.updated`。"""
    body = await request.json()
    session = session_for_structure(app, request, structure_id)
    frame = body.get("frame_index")
    st = session.structure(structure_id, frame)
    _require_editable(session, st, request)
    if st.status == "approved":
        raise HTTPException(
            status_code=409,
            detail={
                "code": "APPROVED_LOCKED",
                "structure_id": structure_id,
                "message": "結構已簽核，唯讀；請先 reopen",
            },
        )
    own = session.mask_grid_for(st.frame_of_reference_uid)
    if body.get("mask_grid_id") and body["mask_grid_id"] != own.mask_grid_id:
        raise HTTPException(status_code=409, detail={"code": "I3", "session_mask_grid_id": own.mask_grid_id})
    try:
        v = st.revert_to(str(body["version_id"]), user=actor(request), note=str(body.get("note") or ""))
    except KeyError as exc:
        raise HTTPException(status_code=404, detail={"code": "NO_VERSION", "message": str(exc)}) from exc
    session.case.touch()
    await push_case(
        app,
        session,
        "mask.updated",
        {"structureId": structure_id, "frameIndex": st.frame_index, "contentHash": st.content_hash},
    )
    return {
        "structure_id": structure_id,
        "content_hash": st.content_hash,
        "version_id": v.version_id,
        "reverted_to": str(body["version_id"]),
        "version_count": len(st.versions),
        "status": st.status,
        "provenance": st.provenance.to_wire(),
    }


@router.get(API + "/ops")
async def list_ops() -> list[dict[str, Any]]:
    """前端據此**動態產生參數 UI**，新增運算不必改前端。"""
    from ..i18n import translate_fields
    from ..ops import registry

    # 運算名稱、說明、參數標題與選項標籤依請求語言
    return translate_fields(registry(), frozenset({"label", "description", "title", "enumNames", "x-ui-help"}))
