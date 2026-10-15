"""CT 校正曲線（HU → 密度 ＋ 材質）：清單、內容、新增草稿、改草稿、啟用、停用、刪草稿；某個 CT 用哪一條。

* `GET    /ct-calibrations`                  ：內建 ＋ 使用者的（摘要）
* `GET    /ct-calibrations/{id}`             ：完整內容 ＋ 可編輯的點表 ＋ 畫圖用的取樣曲線 ＋ 材質表
* `POST   /ct-calibrations/preview`          ：還沒存的點表 → 檢查 ＋ 取樣曲線（表單預覽）
* `POST   /ct-calibrations`                  ：新增草稿（admin；複製別條時帶 `derived_from`）
* `PUT    /ct-calibrations/{id}`             ：改草稿（admin；啟用過的不能改）
* `POST   /ct-calibrations/{id}/activate`    ：啟用（admin；同一組比對規則的其他啟用中曲線改成停用）
* `POST   /ct-calibrations/{id}/retire`      ：停用（admin）
* `DELETE /ct-calibrations/{id}`             ：刪草稿（admin；啟用過的不能刪，只能停用 —— 舊結果要說得出用了哪一條）
* `GET    /series/{series_id}/ct-calibration`：這組 CT 會用哪一條、為什麼

存在 `app_setting` 的 `ct_calibrations` 一筆（曲線少、改得少；不另開資料表）。讀改寫在同一個行程裡用鎖串起來。
啟用後內容不能改（要改就複製成新草稿再啟用），停用的留著。
"""

from __future__ import annotations

import asyncio
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Request

from .. import ct_calibration as cc
from ..i18n import localized_route_class
from ..limits import run_cpu
from .deps import API, AppState, actor, state

router = APIRouter(route_class=localized_route_class())
_lock = asyncio.Lock()


async def _items(app: AppState) -> list[dict[str, Any]]:
    doc = await (await app.settings_store_async()).get(cc.SETTINGS_KEY)
    return list((doc or {}).get("items") or [])


async def _save(app: AppState, items: list[dict[str, Any]], user: str) -> None:
    await (await app.settings_store_async()).put(cc.SETTINGS_KEY, {"items": items}, updated_by=user)


def _reject(code: str, message: str, **extra: Any) -> HTTPException:
    return HTTPException(status_code=422, detail={"code": code, "message": message, **extra})


def _find(items: list[dict[str, Any]], calibration_id: str) -> dict[str, Any]:
    if calibration_id == cc.BUILTIN_ID:
        return cc.builtin_calibration()
    item = next((x for x in items if x["calibration_id"] == calibration_id), None)
    if item is None:
        raise HTTPException(status_code=404, detail={"code": "NO_CALIBRATION", "calibration_id": calibration_id})
    return item


def _detail(cal: dict[str, Any]) -> dict[str, Any]:
    return {
        **cc.summary(cal),
        "density": cal["density"],
        "point_table": cc.points_of(cal),
        "curve": cc.sampled_curve(cal),
        "materials": cc.schneider_materials(),
    }


@router.get(API + "/ct-calibrations")
async def list_calibrations(app: AppState = Depends(state)) -> Any:
    items = await _items(app)
    return {"calibrations": [cc.summary(cc.builtin_calibration()), *(cc.summary(x) for x in reversed(items))]}


@router.get(API + "/ct-calibrations/{calibration_id}")
async def get_calibration(calibration_id: str, app: AppState = Depends(state)) -> Any:
    return _detail(_find(await _items(app), calibration_id))


@router.post(API + "/ct-calibrations/preview")
async def preview_calibration(body: dict[str, Any]) -> Any:
    draft, problems = cc.check_user_curve({"match": {"kvp": 120}, "name": "preview", **body})
    if draft is None:
        return {"ok": False, "problems": problems}
    cal = {**draft, "calibration_id": "preview"}
    return {"ok": True, "problems": [], "curve": cc.sampled_curve(cal), "hu_range": list(cc.hu_range(cal))}


@router.post(API + "/ct-calibrations", status_code=201)
async def create_calibration(body: dict[str, Any], request: Request, app: AppState = Depends(state)) -> Any:
    draft, problems = cc.check_user_curve(body)
    if draft is None:
        raise _reject("BAD_CALIBRATION", "；".join(problems), problems=problems)
    user = actor(request)
    async with _lock:
        items = await _items(app)
        rec = cc.new_record(draft, user=user)
        items.append(rec)
        await _save(app, items, user)
    request.state.audit_detail = {
        "ct_calibration": {
            "action": "create",
            "calibration_id": rec["calibration_id"],
            "name": rec["name"],
            "derived_from": rec.get("derived_from"),
        }
    }
    return _detail(rec)


@router.put(API + "/ct-calibrations/{calibration_id}")
async def update_calibration(
    calibration_id: str, body: dict[str, Any], request: Request, app: AppState = Depends(state)
) -> Any:
    if calibration_id == cc.BUILTIN_ID:
        raise _reject("BUILTIN", "內建曲線不能改：複製成新草稿再改")
    draft, problems = cc.check_user_curve(body)
    if draft is None:
        raise _reject("BAD_CALIBRATION", "；".join(problems), problems=problems)
    user = actor(request)
    async with _lock:
        items = await _items(app)
        item = _find(items, calibration_id)
        if item["status"] != "draft":
            raise _reject(
                "NOT_DRAFT", "啟用過的曲線不能改（舊的結果要說得出用了哪一條）：複製成新草稿再改", status=item["status"]
            )
        cc.update_draft(item, draft, user=user)
        await _save(app, items, user)
    request.state.audit_detail = {
        "ct_calibration": {"action": "update", "calibration_id": calibration_id, "name": item["name"]}
    }
    return _detail(item)


@router.post(API + "/ct-calibrations/{calibration_id}/activate")
async def activate_calibration(calibration_id: str, request: Request, app: AppState = Depends(state)) -> Any:
    if calibration_id == cc.BUILTIN_ID:
        raise _reject("BUILTIN", "內建曲線一直都在（沒有符合的曲線時才用），不用啟用")
    user = actor(request)
    async with _lock:
        items = await _items(app)
        item = _find(items, calibration_id)
        if item["status"] != "draft":
            raise _reject("NOT_DRAFT", "只有草稿可以啟用（停用的要重新新增一條）", status=item["status"])
        retired = cc.activate(items, calibration_id, user=user)
        await _save(app, items, user)
    request.state.audit_detail = {
        "ct_calibration": {
            "action": "activate",
            "calibration_id": calibration_id,
            "match": item["match"],
            "retired": retired,
        }
    }
    return {**_detail(item), "retired": retired}


@router.post(API + "/ct-calibrations/{calibration_id}/retire")
async def retire_calibration(calibration_id: str, request: Request, app: AppState = Depends(state)) -> Any:
    if calibration_id == cc.BUILTIN_ID:
        raise _reject("BUILTIN", "內建曲線不能停用")
    user = actor(request)
    async with _lock:
        items = await _items(app)
        item = _find(items, calibration_id)
        if item["status"] != "active":
            raise _reject("NOT_ACTIVE", "只有啟用中的曲線可以停用", status=item["status"])
        cc.retire(item, user=user)
        await _save(app, items, user)
    request.state.audit_detail = {"ct_calibration": {"action": "retire", "calibration_id": calibration_id}}
    return _detail(item)


@router.delete(API + "/ct-calibrations/{calibration_id}")
async def delete_calibration(calibration_id: str, request: Request, app: AppState = Depends(state)) -> Any:
    if calibration_id == cc.BUILTIN_ID:
        raise _reject("BUILTIN", "內建曲線不能刪")
    user = actor(request)
    async with _lock:
        items = await _items(app)
        item = _find(items, calibration_id)
        if item["status"] != "draft":
            raise _reject(
                "NOT_DRAFT", "啟用過的曲線不能刪，只能停用（舊的結果要說得出用了哪一條）", status=item["status"]
            )
        await _save(app, [x for x in items if x is not item], user)
    request.state.audit_detail = {"ct_calibration": {"action": "delete", "calibration_id": calibration_id}}
    return {"deleted": calibration_id}


@router.get(API + "/series/{series_id}/ct-calibration")
async def series_calibration(series_id: str, app: AppState = Depends(state)) -> Any:
    """這組影像會用哪一條曲線：讀第一張影像的製造商、機型、kVp 去比對；對不到 → 內建通用曲線，說明原因。"""
    from ..i18n import translate

    try:
        session = app.store.by_series(series_id)
        series = session.dataset.series_by_id(series_id)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail={"code": "NO_SERIES", "series_id": series_id}) from exc
    if series.kind == "dose" or str(series.modality).upper() not in ("CT", "CBCT"):
        raise _reject("NOT_CT", "只有 CT 有校正曲線", modality=series.modality)
    scanner = await run_cpu(cc.scanner_of, series.source_path or None)
    r = cc.resolve(await _items(app), scanner)
    notes = []
    if str(series.modality).upper() == "CBCT":
        notes.append("CBCT 的 HU 通常不準（散射、重建），直接套曲線的密度誤差大")
    return {
        "series_id": series_id,
        "scanner": scanner,
        "calibration": cc.summary(r["calibration"]),
        "fallback": r["fallback"],
        "reason": translate(r["reason"]),
        "notes": [translate(n) for n in notes],
    }
