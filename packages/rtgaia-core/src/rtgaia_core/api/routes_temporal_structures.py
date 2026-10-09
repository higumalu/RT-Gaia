"""4D 的結構 —— 各相位的同一個結構合成一個時間結構、複製到其他相位、ITV。

同名結構跨相位（例如 GTV_c00…c90 原本是 10 個結構各在一幀）可以合成一個時間結構。

* `POST /studies/{study_id}/structures/merge-frames`：幾個**只屬某幾幀**的結構（同一條時間軸、幀不重疊）→
  一個新的時間結構（進我的工作集；來源不動 —— 匯入的本來就唯讀）。
* `POST /structures/{structure_id}/propagate-frames`：把這個時間結構某一幀的輪廓複製到其他幀（預設只補沒有的；
  `overwrite` 才蓋掉已有的）。結構要能改（匯入集唯讀 → 先「合併到我的結構集」）。
* `POST /studies/{study_id}/structures/itv`：幾個結構在選定各幀的聯集 → 一個**靜態**結構（`interpreted_type=ITV`，
  每一幀都顯示）；靜態的來源直接併進去。

全部同一個 FoR（同一個 MaskGrid）；在 mask 網格上做布林，不重新取樣。
"""

from __future__ import annotations

from typing import Any

import numpy as np
from fastapi import APIRouter, Depends, HTTPException, Request
from rtgaia_geom import Provenance

from ..i18n import localized_route_class
from ..limits import STRUCTURE_ID_MAX
from ..state import MODULE_VERSION, StructureState, StructureVersion
from .deps import (
    API,
    AppState,
    actor,
    push_case,
    readable_structure,
    require_id,
    session_for_structure,
    session_for_study,
    state,
)
from .routes_structures import _locked, _require_editable, _target_work_set, announce_new_work_set

router = APIRouter(route_class=localized_route_class())


def _bad(code: str, message: str, status: int = 422, **extra: Any) -> HTTPException:
    return HTTPException(status_code=status, detail={"code": code, "message": message, **extra})


def _states(session: Any, structure_id: str, request: Request | None = None) -> list[StructureState]:
    if request is not None:
        readable_structure(session, structure_id, None, request)  # 別人的暫存結果看不到（404）
    out = sorted(
        (st for (sid, _), st in session.structures.items() if sid == structure_id),
        key=lambda s: -1 if s.frame_index is None else s.frame_index,
    )
    if not out:
        raise HTTPException(status_code=404, detail={"code": "NO_STRUCTURE", "structure_id": structure_id})
    return out


def _ids(body: dict[str, Any]) -> list[str]:
    raw = body.get("structure_ids")
    if not isinstance(raw, list) or not raw:
        raise _bad("BAD_REQUEST", "structure_ids 要是非空的清單")
    ids = [str(x) for x in raw]
    if len(set(ids)) != len(ids):
        raise _bad("BAD_REQUEST", "同一個結構選了兩次")
    return ids


def _frame_count(session: Any, temporal_group_id: str) -> int:
    tg = next((g for g in session.temporal_groups if g.temporal_group_id == temporal_group_id), None)
    if tg is None:
        raise _bad("NO_TEMPORAL_GROUP", "這條時間軸已經不在病例裡", temporal_group_id=temporal_group_id)
    return int(tg.frame_count or 1)


def _new_state(
    src: StructureState,
    *,
    structure_id: str,
    name: str,
    color: tuple[int, int, int],
    frame_index: int | None,
    temporal_group_id: str | None,
    volume: np.ndarray,
    structure_set_id: str | None,
    user: str,
    module: str,
    note: str,
    kind: str,
    interpreted_type: str | None,
    tg263_code: str | None,
) -> StructureState:
    """新的一個結構狀態（某一幀或靜態），內容 ＝ `volume`（mask 網格上的稠密陣列），第一版記來源。"""
    from rtgaia_geom import crop_to_bbox
    from rtgaia_geom.hashing import payload_content_hash

    offset, size, block = crop_to_bbox(volume)
    if block is None:
        offset, size, block = (0, 0, 0), (1, 1, 1), np.zeros((1, 1, 1), dtype=np.uint8)
    block = np.ascontiguousarray(block, dtype=np.uint8)
    content_hash = payload_content_hash(offset_ijk=offset, size_ijk=size, data=block.tobytes(), prefix="mh_")
    st = StructureState(
        structure_id=structure_id,
        name=name,
        color_rgb=color,
        frame_of_reference_uid=src.frame_of_reference_uid,
        offset_ijk=offset,
        size_ijk=size,
        block=block,
        content_hash=content_hash,
        provenance=Provenance(
            source="post-process", module_version=f"{MODULE_VERSION}+{module}", parent_hash=src.content_hash
        ),
        status="under_review",
        tg263_code=tg263_code,
        interpreted_type=interpreted_type,
        default_visible=True,
        temporal_group_id=temporal_group_id,
        frame_index=frame_index,
        structure_set_id=structure_set_id,
        created_by=user,
        updated_by=user,
    )
    st.versions[0] = StructureVersion(**{**st.versions[0].__dict__, "kind": kind, "note": note})
    return st


def _color(body: dict[str, Any], fallback: tuple[int, int, int]) -> tuple[int, int, int]:
    raw = body.get("color_rgb")
    if isinstance(raw, list | tuple) and len(raw) == 3:
        return tuple(max(0, min(255, int(v))) for v in raw)  # type: ignore[return-value]
    return fallback


def _layer(session: Any, structure_id: str) -> dict[str, Any]:
    return next(x for x in session.layers() if x["contentRef"] == structure_id)


@router.post(API + "/studies/{study_id}/structures/merge-frames", status_code=201)
async def merge_frames(study_id: str, request: Request, app: AppState = Depends(state)) -> Any:
    body = await request.json()
    session = session_for_study(app, request, study_id)
    ids = _ids(body)
    if len(ids) < 2:
        raise _bad("BAD_REQUEST", "至少要選兩個結構才能合成一個時間結構")
    groups = {sid: _states(session, sid, request) for sid in ids}
    first = groups[ids[0]][0]
    tg_id = first.temporal_group_id
    by_frame: dict[int, tuple[str, StructureState]] = {}
    for sid in ids:
        for st in groups[sid]:
            if st.frame_index is None or st.temporal_group_id is None:
                raise _bad(
                    "STATIC_SOURCE",
                    f"「{st.name}」是靜態結構（每一幀都顯示），不能合成時間結構；要聯集請用 ITV",
                    structure_id=sid,
                )
            if st.temporal_group_id != tg_id or st.frame_of_reference_uid != first.frame_of_reference_uid:
                raise _bad("OTHER_TIMELINE", f"「{st.name}」不在同一條時間軸上", structure_id=sid)
            if st.frame_index in by_frame:
                other = by_frame[st.frame_index][1]
                raise _bad(
                    "FRAME_OVERLAP",
                    f"「{st.name}」跟「{other.name}」都在第 {st.frame_index + 1} 幀；每一幀只能來自一個結構",
                    frame_index=st.frame_index,
                )
            by_frame[st.frame_index] = (sid, st)
    user = actor(request)
    name = str(body.get("name") or first.name).strip() or first.name
    new_id = session.case.unique_structure_id(
        require_id(body["structure_id"], field="structure_id", max_len=STRUCTURE_ID_MAX)
        if body.get("structure_id")
        else session.case.structure_id_from_name(name),
        sep="_",
    )
    sets_before = len(session.case.structure_sets)
    set_id = _target_work_set(session, request, first.frame_of_reference_uid, body.get("structure_set_id"))
    grid = session.grid_for_frame(first.frame_of_reference_uid)
    color = _color(body, first.color_rgb)
    for frame, (sid, src) in sorted(by_frame.items()):
        st = _new_state(
            src,
            structure_id=new_id,
            name=name,
            color=color,
            frame_index=frame,
            temporal_group_id=tg_id,
            volume=src.dense(grid),
            structure_set_id=set_id,
            user=user,
            module="merge-frames",
            note=f"第 {frame + 1} 幀合併自 {sid}@{src.head.version_id}",
            kind="merge",
            interpreted_type=src.interpreted_type,
            tg263_code=src.tg263_code,
        )
        session.structures[st.key] = st
    session.case.touch()
    await announce_new_work_set(app, session, sets_before)
    await push_case(app, session, "layer.add", _layer(session, new_id))
    return {
        "structure_id": new_id,
        "structure_set_id": set_id,
        "frames": sorted(by_frame),
        "sources": {str(f): sid for f, (sid, _) in sorted(by_frame.items())},
    }


@router.post(API + "/structures/{structure_id}/propagate-frames")
async def propagate_frames(structure_id: str, request: Request, app: AppState = Depends(state)) -> Any:
    body = await request.json()
    session = session_for_structure(app, request, structure_id)
    states = _states(session, structure_id, request)
    head = states[0]
    if head.temporal_group_id is None or head.frame_index is None:
        raise _bad("STATIC_STRUCTURE", "這是靜態結構，每一幀本來就都顯示，不需要複製到其他相位")
    _require_editable(session, head, request)
    if any(s.status == "approved" for s in states):
        return _locked(structure_id)
    have = {s.frame_index: s for s in states}
    if "source_frame" not in body:
        raise _bad("BAD_REQUEST", "要指定從哪一幀複製（source_frame）")
    source_frame = int(body["source_frame"])
    if source_frame not in have:
        raise _bad("NOT_IN_FRAME", f"這個結構沒有第 {source_frame + 1} 幀", frame_index=source_frame)
    src = have[source_frame]
    if "base_content_hash" in body and body["base_content_hash"] != src.content_hash:
        raise HTTPException(
            status_code=409,
            detail={"code": "CONFLICT", "reason": "stale_hash", "content_hash": src.content_hash},
        )
    count = _frame_count(session, head.temporal_group_id)
    targets = body.get("target_frames")
    wanted = sorted({int(f) for f in targets}) if isinstance(targets, list) and targets else list(range(count))
    if any(f < 0 or f >= count for f in wanted):
        raise _bad("BAD_FRAME", f"幀號要在 1～{count} 之間")
    overwrite = bool(body.get("overwrite"))
    grid = session.grid_for_frame(src.frame_of_reference_uid)
    volume = src.dense(grid)
    user = actor(request)
    note = f"從第 {source_frame + 1} 幀複製（{src.head.version_id}）"
    added: list[int] = []
    replaced: list[int] = []
    skipped: list[int] = []
    for f in wanted:
        if f == source_frame:
            continue
        if f in have:
            if not overwrite:
                skipped.append(f)
                continue
            st = have[f]
            st.replace_dense(
                volume,
                Provenance(
                    source="post-process",
                    module_version=f"{MODULE_VERSION}+propagate-frames",
                    parent_hash=st.content_hash,
                ),
                kind="post-process",
                user=user,
                note=note,
            )
            replaced.append(f)
            continue
        st = _new_state(
            src,
            structure_id=structure_id,
            name=src.name,
            color=src.color_rgb,
            frame_index=f,
            temporal_group_id=src.temporal_group_id,
            volume=volume,
            structure_set_id=src.structure_set_id,
            user=user,
            module="propagate-frames",
            note=note,
            kind="copy",
            interpreted_type=src.interpreted_type,
            tg263_code=src.tg263_code,
        )
        session.structures[st.key] = st
        added.append(f)
    session.case.touch()
    if added:
        # 幀清單變了 → 圖層（frames）要換
        await push_case(app, session, "layer.update", _layer(session, structure_id))
    for f in replaced:
        await push_case(
            app,
            session,
            "mask.updated",
            {"structureId": structure_id, "frameIndex": f, "contentHash": have[f].content_hash},
        )
    return {"structure_id": structure_id, "added": added, "replaced": replaced, "skipped": skipped}


@router.post(API + "/studies/{study_id}/structures/itv", status_code=201)
async def create_itv(study_id: str, request: Request, app: AppState = Depends(state)) -> Any:
    body = await request.json()
    session = session_for_study(app, request, study_id)
    ids = _ids(body)
    groups = {sid: _states(session, sid, request) for sid in ids}
    first = groups[ids[0]][0]
    frames_raw = body.get("frames")
    frames = {int(f) for f in frames_raw} if isinstance(frames_raw, list) and frames_raw else None
    grid = session.grid_for_frame(first.frame_of_reference_uid)
    union = np.zeros((grid.size[2], grid.size[1], grid.size[0]), dtype=np.uint8)
    used: list[str] = []
    for sid in ids:
        for st in groups[sid]:
            if st.frame_of_reference_uid != first.frame_of_reference_uid:
                raise _bad("OTHER_FOR", f"「{st.name}」不在同一組影像（Frame of Reference）上", structure_id=sid)
            if st.frame_index is not None and frames is not None and st.frame_index not in frames:
                continue
            union |= st.dense(grid)
            used.append(f"{sid}@{'static' if st.frame_index is None else st.frame_index}")
    if not used or not union.any():
        raise _bad("EMPTY", "選的結構在選的幀裡都沒有內容，ITV 會是空的")
    user = actor(request)
    name = str(body.get("name") or "ITV").strip() or "ITV"
    new_id = session.case.unique_structure_id(session.case.structure_id_from_name(name), sep="_")
    sets_before = len(session.case.structure_sets)
    set_id = _target_work_set(session, request, first.frame_of_reference_uid, body.get("structure_set_id"))
    st = _new_state(
        first,
        structure_id=new_id,
        name=name,
        color=_color(body, (255, 128, 0)),
        frame_index=None,
        temporal_group_id=None,
        volume=union,
        structure_set_id=set_id,
        user=user,
        module="itv",
        note="ITV ＝ " + "、".join(used),
        kind="merge",
        interpreted_type="ITV",
        tg263_code="ITV" if name.upper().startswith("ITV") else None,
    )
    session.structures[st.key] = st
    session.case.touch()
    await announce_new_work_set(app, session, sets_before)
    await push_case(app, session, "layer.add", _layer(session, new_id))
    return {
        "structure_id": new_id,
        "structure_set_id": set_id,
        "sources": used,
        "volume_cc": st.volume_cc(grid),
    }
