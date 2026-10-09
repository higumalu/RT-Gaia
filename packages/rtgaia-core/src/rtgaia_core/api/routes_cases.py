"""病例（Case）端點。

* `GET /api/v1/cases`            → 目前記憶體裡的病例工作狀態（之後持久化後就是「回到昨天沒做完的病例」）
* `GET /api/v1/cases/{case_id}`  → 一個病例：結構清單、量測、transform、審核、job、開著它的 session 數

Case 與 Session 的分家見 `state.py` 模組說明。
"""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Query, Request

from ..i18n import localized_route_class
from .deps import API, AppState, actor, state

router = APIRouter(route_class=localized_route_class())  # 錯誤、原因等句子依請求語言翻


@router.get(API + "/cases")
async def list_cases(app: AppState = Depends(state)) -> list[dict[str, Any]]:
    """記憶體裡的 ＋ DB 裡的；同 id 以記憶體為準（較新）。"""
    out = {
        c.case_id: {**c.to_wire(sessions=len(app.store.sessions_of(c.case_id))), "in_memory": True}
        for c in app.store.cases()
    }
    if app.db_url:
        for row in await (await app.case_store_async()).list():
            out.setdefault(row["case_id"], {**row, "sessions": 0, "in_memory": False})
    return sorted(out.values(), key=lambda c: str(c.get("updated_at") or ""), reverse=True)


@router.get(API + "/cases/worklist")
async def worklist(app: AppState = Depends(state)) -> list[dict[str, Any]]:
    """每個病例一列 ＋ 推出來的狀態（none／in_progress／review／approved／exported）、
    工作集結構的簽核計數、最近成功匯出、在線使用者、study 的病歷號／日期／描述。記憶體裡的病例以記憶體為準。"""
    from ..worklist import counts_from_structures, worklist_entry

    entries: dict[str, dict[str, Any]] = {}
    for c in app.store.cases():
        seen: set[str] = set()
        rows: list[tuple[str | None, str]] = []
        for (sid, _fi), st in c.structures.items():
            if sid in seen:
                continue
            seen.add(sid)
            rows.append((st.structure_set_id, st.status))
        exports = [
            str(j.get("finished_at") or "")
            for j in c.jobs.values()
            if isinstance(j, dict) and j.get("kind") == "export" and j.get("status") == "done" and j.get("finished_at")
        ]
        entries[c.case_id] = worklist_entry(
            case={
                **c.to_wire(),
                "selection": getattr(c, "selection", None),
                "created_by": getattr(c, "created_by", ""),
            },
            counts=counts_from_structures(rows),
            last_export_at=max(exports) if exports else None,
            open_users=[s.user for s in app.store.sessions_of(c.case_id)],
            study=None,
        )
    if app.db_url:
        store = await app.case_store_async()
        for row in await store.worklist_rows():
            if row["case_id"] in entries:
                # 記憶體那份比較新，只補 study 資訊與 DB 才知道的匯出紀錄
                e = entries[row["case_id"]]
                for k in ("patient_id", "study_date", "study_description"):
                    if not e.get(k):
                        e[k] = row.get(k)
                if row.get("last_export_at") and (e["last_export_at"] or "") < row["last_export_at"]:
                    e["last_export_at"] = row["last_export_at"]
                    from ..worklist import case_status

                    e["status"] = case_status(
                        work_total=e["counts"]["work_total"],
                        approved=e["counts"]["approved"],
                        under_review=e["counts"]["under_review"],
                        last_export_at=e["last_export_at"],
                        updated_at=str(e.get("updated_at") or ""),
                    )
                continue
            entries[row["case_id"]] = worklist_entry(
                case=row,
                counts=row["counts"],
                last_export_at=row.get("last_export_at"),
                open_users=[],
                study={
                    "patient_id": row.get("patient_id"),
                    "study_date": row.get("study_date", ""),
                    "study_description": row.get("study_description", ""),
                },
            )
    return sorted(entries.values(), key=lambda e: str(e.get("updated_at") or ""), reverse=True)


@router.get(API + "/cases/{case_id}")
async def get_case(case_id: str, request: Request, app: AppState = Depends(state)) -> dict[str, Any]:
    try:
        c = app.store.case(case_id)
    except KeyError as exc:
        if not app.db_url:
            raise HTTPException(status_code=404, detail={"code": "NO_CASE", "message": str(exc)}) from exc
        try:
            c = await app.load_case_async(case_id)
        except KeyError as exc2:
            raise HTTPException(status_code=404, detail={"code": "NO_CASE", "message": str(exc2)}) from exc2
    return {
        **c.to_wire(sessions=len(app.store.sessions_of(case_id))),
        "structures": c.structure_list(user=actor(request)),
        "measurements": c.measurements,
        "transforms": {k: {kk: vv for kk, vv in v.items() if kk != "matrix"} for k, v in c.transforms.items()},
        "review_notes": c.review_notes,
        "jobs": c.jobs,
        "session_ids": [s.session_id for s in app.store.sessions_of(case_id)],
        "presence": [
            {
                "session_id": s.session_id,
                "user": s.user,
                "connections": s.connections,
                "created_at": s.created_at,
                "editing": s.editing,
            }
            for s in app.store.sessions_of(case_id)
        ],
    }


@router.get(API + "/audit/status")
async def audit_status(app: AppState = Depends(state)) -> dict[str, Any]:
    """稽核待送狀態（管理頁顯示；`/healthz` 也有）。沒有 DB → 只有 tail 長度。"""
    lag = await app.audit_lag()
    return {"db": bool(app.db_url), "tail": len(app.audit_tail), "lag": lag}


@router.get(API + "/audit")
async def list_audit(
    case_id: str | None = Query(None),
    user: str | None = Query(None),
    limit: int = Query(100, ge=1, le=1000),
    app: AppState = Depends(state),
) -> list[dict[str, Any]]:
    """稽核事件（誰、何時、做了什麼）。有 DB 從 `audit_event` 查；沒有 DB 回記憶體尾巴。"""
    if app.db_url:
        return await (await app.audit_store_async()).list(case_id=case_id, user=user, limit=limit)
    out = [
        e
        for e in app.audit_tail
        if (not case_id or e.get("case_id") == case_id) and (not user or e.get("user") == user)
    ]
    return list(reversed(out))[:limit]
