"""測試專用端點。

> `_test` 前綴讓「不小心把測試端點做進正式後端」在 code review 與部署掃描時
> **都看得見**。

這句話**由程式強制**：`create_app()` 只在 `test_api=True`
（或 `RTGAIA_TEST_API=1`）時掛這個 router，預設不掛；`tests/test_production_app.py`
以生產設定建 app 並斷言沒有任何 `/api/v1/_test` 路徑。這組端點直接寫
`session.structures`、接受 client 給的 status、可設全域 chaos，又被稽核排除 ——
在 `auth=required` 下曾重現 contourer 覆寫 approved 結構且無稽核。
"""

from __future__ import annotations

from typing import Any

import numpy as np
from fastapi import APIRouter, Depends, HTTPException, Request
from rtgaia_core.api.deps import API, AppState, actor, state
from rtgaia_core.chaos import MODES
from rtgaia_core.state import MODULE_VERSION, StructureState, build_session
from rtgaia_core.tiers import ClientCapability
from rtgaia_geom import Provenance, crop_to_bbox
from rtgaia_geom.hashing import payload_content_hash

from .. import phantoms

router = APIRouter()
TEST = API + "/_test"


@router.get(TEST + "/phantoms")
async def list_phantoms() -> list[dict[str, Any]]:
    return phantoms.list_phantoms()


@router.post(TEST + "/load")
async def load(request: Request, app: AppState = Depends(state)) -> Any:
    """`{ source: "phantom:gantry_tilt" | "dicom:/path" }` → 建立 session。"""
    body = await request.json()
    source = str(body.get("source", "phantom:axial_clean"))
    cap = ClientCapability.from_wire(body.get("client_capability"))
    if source.startswith("phantom:"):
        dataset = phantoms.build(source.split(":", 1)[1])
    elif source.startswith("dicom:"):
        from rtgaia_core.loaders.dicom import load_dicom_dataset

        dataset = load_dicom_dataset(source.split(":", 1)[1])
    else:
        raise HTTPException(
            status_code=422,
            detail={"code": "BAD_SOURCE", "message": 'source 必須是 "phantom:<id>" 或 "dicom:<path>"'},
        )
    session = app.store.put(
        build_session(
            dataset=dataset,
            capability=cap,
            manual_tier=body.get("manual_tier"),
            source=source,
            user=actor(request),
        )
    )
    await app.publish(session.session_id, "scene.replace", session.scene_push())
    return {
        "session_id": session.session_id,
        "study_id": dataset.study_id,
        "source": source,
        "scene": session.scene(),
    }


@router.post(TEST + "/push")
async def push(request: Request, app: AppState = Depends(state)) -> Any:
    """立即經 WS 推送任意 `scene.replace` / `layer.*` / `camera.set`。"""
    body = await request.json()
    session = app.store.current() if not body.get("session_id") else app.store.get(body["session_id"])
    message_type = str(body["type"])
    payload = body.get("payload")
    if payload is None and message_type == "scene.replace":
        payload = session.scene_push()
    payload = payload or {}

    # 🔴 推送同時**寫進 session 狀態**，而不是只發一則訊息。
    # 否則驅動腳本推的量測與圖層覆寫，在 `GET /_test/state` 上看不到，
    # 而前端 e2e 測試斷言的正是那份 state。
    if message_type == "layer.add" and payload.get("kind") == "measurement":
        m = payload.get("measurement") or payload
        measurement_id = str(m.get("measurementId") or payload.get("contentRef") or f"m{len(session.measurements) + 1}")
        m.setdefault("measurementId", measurement_id)
        m.setdefault(
            "frameOfReferenceUid",
            payload.get("frameOfReferenceUid") or session.dataset.primary.frame_of_reference_uid,
        )
        session.measurements[measurement_id] = m
        payload = next(x for x in session.layers() if x["contentRef"] == measurement_id)
    elif message_type in ("layer.update", "layer.remove"):
        layer_id = str(payload.get("layerId") or payload.get("contentRef") or "")
        if message_type == "layer.remove":
            session.layer_overrides.pop(layer_id, None)
            session.measurements.pop(layer_id.split(":")[-1], None)
        elif layer_id:
            patch = {k: v for k, v in payload.items() if k not in ("layerId",)}
            session.layer_overrides.setdefault(layer_id, {}).update(patch)
            match = next((x for x in session.layers() if layer_id in (x["layerId"], str(x["contentRef"]))), None)
            if match:
                payload = match

    delivered = await app.hub.send(session.session_id, message_type, payload)
    return {
        "delivered": delivered,
        "connections": app.hub.count(session.session_id),
        "payload": payload,
    }


@router.post(TEST + "/mask")
async def inject_mask(request: Request, app: AppState = Depends(state)) -> Any:
    """直接以陣列注入一個結構（**不需經過模型**）。

    body: `{ structure_id, name?, color_rgb?, frame_index?, shape: [nk,nj,ni],
             offset_ijk?, data_b64 | ones_bbox }`
    """
    import base64

    body = await request.json()
    session = app.store.current()
    structure_id = str(body["structure_id"])
    frame = body.get("frame_index")
    for_uid = str(body.get("frame_of_reference_uid") or session.dataset.primary.frame_of_reference_uid)
    grid = session.grid_for_frame(for_uid)

    if body.get("data_b64"):
        shape = [int(v) for v in body["shape"]]
        arr = np.frombuffer(base64.b64decode(body["data_b64"]), dtype=np.uint8).reshape(shape)
        offset = tuple(int(v) for v in body.get("offset_ijk", (0, 0, 0)))
        size = (shape[2], shape[1], shape[0])
        block = arr
    elif body.get("ones_bbox"):
        offset = tuple(int(v) for v in body["ones_bbox"]["offset_ijk"])
        size = tuple(int(v) for v in body["ones_bbox"]["size_ijk"])
        block = np.ones((size[2], size[1], size[0]), dtype=np.uint8)
    else:
        raise HTTPException(status_code=422, detail={"code": "NO_DATA", "message": "需要 data_b64 或 ones_bbox"})

    if not all(offset[i] + size[i] <= grid.size[i] for i in range(3)):
        raise HTTPException(
            status_code=422,
            detail={"code": "E1", "message": "注入的區塊超出 mask 網格", "grid_size": list(grid.size)},
        )
    # 送進來的可能沒貼齊 bbox，這裡重新裁一次，保持 mask 一律裁切到 bbox 的不變式
    o, s, tight = crop_to_bbox(block)
    if tight is None:
        raise HTTPException(status_code=422, detail={"code": "EMPTY_MASK", "message": "注入的 mask 全為 0"})
    raw = np.ascontiguousarray(tight, dtype=np.uint8)
    st = StructureState(
        structure_id=structure_id,
        name=str(body.get("name") or structure_id),
        color_rgb=tuple(int(v) for v in body.get("color_rgb", (255, 255, 0))),  # type: ignore[arg-type]
        frame_of_reference_uid=for_uid,
        offset_ijk=(offset[0] + o[0], offset[1] + o[1], offset[2] + o[2]),
        size_ijk=s,
        block=raw,
        content_hash=payload_content_hash(
            offset_ijk=(offset[0] + o[0], offset[1] + o[1], offset[2] + o[2]),
            size_ijk=s,
            data=raw.tobytes(),
            prefix="mh_",
        ),
        provenance=Provenance(source="import", module_version=MODULE_VERSION),
        status=body.get("status", "ai_generated"),
        temporal_group_id=body.get("temporal_group_id"),
        frame_index=frame,
    )
    session.structures[st.key] = st
    layer = next(x for x in session.layers() if x["contentRef"] == structure_id)
    await app.hub.send(session.session_id, "layer.add", layer)
    return {
        "structure_id": structure_id,
        "content_hash": st.content_hash,
        "offset_ijk": list(st.offset_ijk),
        "size_ijk": list(st.size_ijk),
        "volume_cc": st.volume_cc(grid),
    }


@router.post(TEST + "/chaos")
async def set_chaos(request: Request, app: AppState = Depends(state)) -> Any:
    """設定故障注入。`{"reset": true}` 全部關掉。"""
    body = await request.json()
    if body.pop("reset", False):
        app.chaos.reset()
    try:
        app.chaos.update(body)
    except KeyError as exc:
        raise HTTPException(
            status_code=422, detail={"code": "BAD_MODE", "message": str(exc), "modes": list(MODES)}
        ) from exc
    return app.chaos.to_wire()


@router.get(TEST + "/chaos")
async def get_chaos(app: AppState = Depends(state)) -> Any:
    return app.chaos.to_wire()


@router.get(TEST + "/expected")
async def expected(app: AppState = Depends(state)) -> Any:
    """回傳目前假體的 `expected.json`。**前端測試斷言這份檔案，不斷言截圖。**"""
    session = app.store.current()
    return phantoms.expected_json(session.dataset)


@router.get(TEST + "/state")
async def full_state(request: Request, app: AppState = Depends(state)) -> Any:
    """目前 session 的完整狀態，供斷言。「目前」是**這個人**最近的 session。"""
    session = app.store.current_for(actor(request))
    return {
        **session.scene(),
        "chaos": app.chaos.to_wire(),
        "ws_connections": app.hub.count(session.session_id),
        "transforms": {k: {kk: vv for kk, vv in v.items() if kk != "matrix"} for k, v in session.transforms.items()},
        "jobs": session.jobs,
        "review_notes": session.review_notes,
        "review_events": session.review_events,
        "version_counts": {f"{k[0]}@{k[1]}": len(st.versions) for k, st in session.structures.items()},
        "last_client_seq": {f"{k[0][0]}@{k[0][1]}/{k[1]}": v for k, v in session.last_client_seq.items()},
        "push_history_tail": app.hub.history[-10:],
        "push_targets_tail": app.hub.targets[-20:],
        "audit_tail": app.audit_tail[-20:],
    }


@router.get(TEST + "/sessions")
async def sessions(app: AppState = Depends(state)) -> Any:
    return {
        "current": app.store.current_id,
        "cases": [c.case_id for c in app.store.cases()],
        "sessions": [
            {
                "session_id": s.session_id,
                "case_id": s.case.case_id,
                "user": s.user,
                "connections": s.connections,
                "study_id": s.dataset.study_id,
                "source": s.source,
                "tier": s.tier_decision.assigned,
                "structures": len(s.structures),
            }
            for s in app.store.all()
        ],
    }


@router.post(TEST + "/retention/tick")
async def retention_tick_now(request: Request, app: AppState = Depends(state)) -> Any:
    """立刻跑一次暫存區清理；`now_offset_days` 把「現在」往後推（驗 14 天到期不必等 14 天）。"""
    from datetime import UTC, datetime, timedelta

    from rtgaia_core.retention import retention_tick

    body = await request.json() if int(request.headers.get("content-length") or 0) > 0 else {}
    now = datetime.now(UTC) + timedelta(days=float(body.get("now_offset_days") or 0))
    return await retention_tick(app, now=now)
