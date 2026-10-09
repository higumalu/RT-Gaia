"""資料庫與 session 建立 —— 資料選取頁的後端（正式命名空間）。

* `GET  /api/v1/library`                       索引摘要
* `GET  /api/v1/library/patients?q=`           病人清單
* `GET  /api/v1/library/series?...`            Patient › Study › Series 樹（可篩選）
* `POST /api/v1/library/rescan`                重新掃描
* `POST /api/v1/sessions`                      由一組選取建立 session（與 `_test/load` 同形的回應）

`_test/load` 保留給假體；這裡是產品路徑。
"""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from rtgaia_geom.hashing import digest

from ..audit_events import new_event
from ..i18n import localized_route_class
from ..loaders.case import CaseSelection, build_case_dataset
from ..pixel_codecs import decode_status
from ..state import build_case, build_session
from ..tiers import ClientCapability
from .deps import API, AppState, actor, is_admin, state

router = APIRouter(route_class=localized_route_class())  # 錯誤、原因等句子依請求語言翻


async def _index(app: AppState, *, rescan: bool = False) -> Any:
    """目錄索引：沒有 DB 就掃檔案系統（JSON 快取），有 DB 就從 Postgres 載入。"""
    try:
        return await app.library_index_async(rescan=rescan)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail={"code": "NO_LIBRARY", "message": str(exc)}) from exc


@router.get(API + "/library")
async def library_summary(app: AppState = Depends(state)) -> dict[str, Any]:
    if not app.library_root:
        return {"configured": False, "root": None}
    return {"configured": True, "show_patient_names": app.show_patient_names, **(await _index(app)).summary()}


@router.get(API + "/library/patients")
async def library_patients(q: str | None = Query(None), app: AppState = Depends(state)) -> list[dict[str, Any]]:
    return (await _index(app)).patients(q, show_names=app.show_patient_names)


@router.get(API + "/library/series")
async def library_series(
    patient_id: str | None = Query(None),
    date_from: str | None = Query(None, description="YYYYMMDD 或 YYYY-MM-DD"),
    date_to: str | None = Query(None),
    description: str | None = Query(None, description="比對 Series/Study Description 與 RT label"),
    modality: str | None = Query(None, description="逗號分隔，例：CT,RTSTRUCT"),
    app: AppState = Depends(state),
) -> dict[str, Any]:
    index = await _index(app)
    entries = index.search(
        patient_id=patient_id, date_from=date_from, date_to=date_to, description=description, modality=modality
    )
    return {"total": len(entries), **index.tree(entries, show_names=app.show_patient_names)}


@router.post(API + "/library/rescan")
async def library_rescan(app: AppState = Depends(state)) -> dict[str, Any]:
    return (await _index(app, rescan=True)).summary()


@router.get(API + "/sessions/current")
async def current_session(request: Request, app: AppState = Depends(state)) -> dict[str, Any]:
    """檢視器進場用：**這個人**最近開的 session 的場景（`scene.replace` 同形：sessionId、caseId、studyId、source、
    gridSet、layers、structures、structureSets…）。沒有 → 404 `NO_SESSION`（前端據此回資料頁）。

    檢視器原本只認測試端點 `GET /_test/state`；`_test/*` 改成 `--test-api`
    才掛之後，正式配置的後端就**沒有任何一條路**讓檢視器拿到 session —— 資料頁「開啟」永遠彈回資料頁。
    這裡是正式的入口；`_test/state` 留給測試（多帶 chaos／push／audit 尾巴）。
    `auth=off`（開發、headless）時沒有自己的 session 就退回全域 current，與 `_test/state` 的舊行為一致；
    `required` 模式只給自己的。"""
    me = actor(request)
    store = app.store
    session = None
    if me and me in store._current_by_user and store._current_by_user[me] in store._sessions:
        session = store._sessions[store._current_by_user[me]]
    elif app.auth_mode == "off":
        try:
            session = store.current()
        except KeyError:
            session = None
    if session is None:
        raise HTTPException(
            status_code=404, detail={"code": "NO_SESSION", "message": "這個人沒有開著的 session；請到資料頁選病例"}
        )
    return session.scene()


@router.get(API + "/sessions/{session_id}/scene")
async def session_scene(session_id: str, request: Request, app: AppState = Depends(state)) -> dict[str, Any]:
    """這條 session 的 `scene.replace` 內容（同形）—— 推送太大時伺服器改送 `{refetch: true}`，前端走這裡拿
    （HTTP 沒有 WS 的訊息上限）。只能拿自己的：跟 WS 同一條規則（admin 也不行 ——
    場景裡有這個人看得到的暫存結果）；`auth=off` 沒有可信身分，不判。"""
    try:
        session = app.store.get(session_id)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail={"code": "NO_SESSION", "session_id": session_id}) from exc
    if app.auth_mode == "required" and session.user != actor(request):
        raise HTTPException(status_code=403, detail={"code": "NOT_OWNER", "owner": session.user})
    return session.scene_push()


@router.post(API + "/sessions", status_code=201)
async def create_session(request: Request, app: AppState = Depends(state)) -> Any:
    """由資料頁的選取建立 session。

    body：`{ primary_series_uid?, image_series_uids[], structure_set_uids[], dose_uids[],
    registration_uids[], plan_uids[], client_capability?, manual_tier? }`。
    回應與 `_test/load` 同形（`{session_id, study_id, source, scene}`），前端走同一條路。
    """
    body = await request.json()
    index = await _index(app)
    selection = CaseSelection.from_wire(body)
    if not selection.image_series_uids:
        raise HTTPException(status_code=422, detail={"code": "CS2", "message": "至少要選一個影像序列"})
    # 壓縮格式解不了的序列在這裡就擋（體素是延遲讀的；不擋的話病例開起來、影像請求才 500）
    for uid in selection.image_series_uids:
        entry = index.series.get(uid)
        if entry is None:
            continue
        status = decode_status({h.transfer_syntax_uid for h in entry.instances})
        if not status["decodable"]:
            raise HTTPException(
                status_code=422,
                detail={"code": "CS9", "message": status["decode_error"], "series_instance_uid": uid},
            )
    cap = ClientCapability.from_wire(body.get("client_capability"))
    # 同一組選取 → 同一個 Case（編輯、簽核、量測都還在）；只有 Session 是新的
    selection_hash = digest(selection.to_wire(), prefix="sel_", length=16)
    # 同一組選取一次只有一個請求在找／建病例：兩個人同時開，不能各自載出（或建出）一個 Case（2026-10-09）
    async with app.case_lock(f"selection:{selection_hash}"):
        existing = app.store.case_by_selection(selection_hash)
        if existing is None and app.db_url:
            # 記憶體沒有 → 看 DB（重啟後「回到昨天沒做完的病例」）
            store = await app.case_store_async()
            saved_id = await store.find_by_selection(selection_hash)
            if saved_id is not None:
                existing = await app.load_case_async(saved_id)
        if existing is not None:
            case = existing
            dataset = case.dataset
            reused = True
        else:
            dataset = build_case_dataset(index, selection)
            case = build_case(
                dataset=dataset,
                source=f"library:{dataset.notes['case']['primary_series_uid']}",
                selection_hash=selection_hash,
                selection=selection.to_wire(),
            )
            reused = False
            await app.persist_case(case, created_by=actor(request))
            app.store.register_case(case)
    # 2026-09-18：工作集跟著影像走 —— 同一組影像、不同選取（例：多勾一套匯出回來的 RTSTRUCT）不會把保存的結構留在舊病例
    adopted = await app.adopt_work_sets(case, by=actor(request))
    if any("skipped" not in m for m in adopted):
        await app.persist_case(case, created_by=actor(request))
        await app.publish(f"case:{case.case_id}", "structure_sets.changed", {"caseId": case.case_id})
    source = case.source
    session = app.store.put(
        build_session(case=case, capability=cap, manual_tier=body.get("manual_tier"), user=actor(request))
    )
    await app.publish(session.session_id, "scene.replace", session.scene_push())
    await app.publish_presence(case.case_id)
    return {
        "session_id": session.session_id,
        "case_id": case.case_id,
        "case_reused": reused,
        "study_id": dataset.study_id,
        "source": source,
        "scene": session.scene(),
        "warnings": dataset.notes["case"]["warnings"],
        "adopted_work_sets": [m for m in adopted if "skipped" not in m],
    }


@router.put(API + "/sessions/{session_id}/editing")
async def set_session_editing(
    session_id: str, body: dict[str, Any], request: Request, app: AppState = Depends(state)
) -> dict[str, Any]:
    """presence：我正在編輯哪個結構 —— `{structure_id: str | null}`。
    變了才發 `presence`（`users[].editing`）。只能改自己的 session；結構要是我看得到的（別人的暫存結構 404）。"""
    try:
        session = app.store.get(session_id)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail={"code": "NO_SESSION", "session_id": session_id}) from exc
    me = actor(request)
    if app.auth_mode == "required" and session.user != me:
        raise HTTPException(status_code=403, detail={"code": "NOT_OWNER", "owner": session.user})
    sid = body.get("structure_id")
    if sid is not None:
        if not isinstance(sid, str) or not sid:
            raise HTTPException(status_code=422, detail={"code": "BAD_STRUCTURE_ID"})
        if sid not in {x["structure_id"] for x in session.case.structure_list(user=me)}:
            raise HTTPException(status_code=404, detail={"code": "NO_STRUCTURE", "structure_id": sid})
    changed = session.editing != sid
    session.editing = sid
    if changed:
        await app.publish_presence(session.case.case_id)
    return {"session_id": session_id, "editing": sid, "changed": changed}


@router.post(API + "/sessions/{session_id}/release")
async def release_session(session_id: str, request: Request, app: AppState = Depends(state)) -> dict[str, Any]:
    """「關閉病例」—— 丟掉這條 session 與（沒別人在看時）病例在記憶體裡的體素／3D 場景。
    工作集、暫存集索引照原本的生命週期（暫存集 30 min grace）。回 `selection`，前端「重新載入」就用它再 `POST /sessions`
    （病例從 DB／檔案重建，`case_reused` 為 True、結構與工作集都在）。只能釋放自己的（admin 例外）。"""
    try:
        session = app.store.get(session_id)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail={"code": "NO_SESSION", "session_id": session_id}) from exc
    me = actor(request)
    if session.user != me and not is_admin(request):
        raise HTTPException(status_code=403, detail={"code": "NOT_OWNER", "owner": session.user})
    out = app.store.release_session(session_id, allow_evict=bool(app.db_url))
    await app.publish_presence(out["case_id"])
    await app.audit(
        new_event(
            user=me,
            action="session.release",
            status=200,
            object_type="session",
            object_id=session_id,
            case_id=out["case_id"],
            client_id=None,
            remote_addr=None,
            detail={"case_evicted": out["case_evicted"]},
        )
    )
    return out
