"""射束資料（量測資料集）：清單、內容、通用 CSV 解析、新增草稿、改草稿、鎖定、刪草稿。

* `GET    /beam-data`              ：內建（公開文獻）＋ 使用者的（摘要）
* `GET    /beam-data/{id}`         ：完整內容（含每筆量測的資料點）
* `POST   /beam-data/parse-csv`    ：通用 CSV → 量測 ＋ 問題（不存；匯入表單預覽）
* `POST   /beam-data`              ：新增草稿（admin；複製別份時帶 `derived_from`）
* `PUT    /beam-data/{id}`         ：改草稿（admin）
* `POST   /beam-data/{id}/lock`    ：鎖定（admin；之後不能改、不能刪 —— 擬合要引用固定的內容）
* `DELETE /beam-data/{id}`         ：刪草稿（admin）

存在 `app_setting` 的 `beam_data` 一筆（資料集少、改得少）。讀改寫在同一個行程裡用鎖串起來。
"""

from __future__ import annotations

import asyncio
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Request
from rtgaia_dosecalc import beam_data as bd

from ..i18n import localized_route_class
from .deps import API, AppState, actor, state

router = APIRouter(route_class=localized_route_class())
_lock = asyncio.Lock()
MAX_CSV_CHARS = 2_000_000


async def _items(app: AppState) -> list[dict[str, Any]]:
    doc = await (await app.settings_store_async()).get(bd.SETTINGS_KEY)
    return list((doc or {}).get("items") or [])


async def _save(app: AppState, items: list[dict[str, Any]], user: str) -> None:
    await (await app.settings_store_async()).put(bd.SETTINGS_KEY, {"items": items}, updated_by=user)


def _reject(code: str, message: str, **extra: Any) -> HTTPException:
    return HTTPException(status_code=422, detail={"code": code, "message": message, **extra})


def _find(items: list[dict[str, Any]], dataset_id: str) -> dict[str, Any]:
    item = next((x for x in [*bd.builtin_datasets(), *items] if x["dataset_id"] == dataset_id), None)
    if item is None:
        raise HTTPException(status_code=404, detail={"code": "NO_BEAM_DATA", "dataset_id": dataset_id})
    return item


def _detail(ds: dict[str, Any]) -> dict[str, Any]:
    return {
        **bd.summary(ds),
        "derived_from": ds.get("derived_from"),
        "measurements": [{**m, "label": bd.measurement_label(m)} for m in ds.get("measurements") or []],
    }


def _check(body: dict[str, Any]) -> dict[str, Any]:
    draft, problems = bd.check_dataset(body)
    if draft is None:
        raise _reject("BAD_BEAM_DATA", "；".join(problems[:20]), problems=problems)
    draft["derived_from"] = str(body.get("derived_from") or "").strip()[:64] or None
    return draft


@router.get(API + "/beam-data")
async def list_beam_data(app: AppState = Depends(state)) -> Any:
    items = await _items(app)
    return {"datasets": [*(bd.summary(x) for x in bd.builtin_datasets()), *(bd.summary(x) for x in reversed(items))]}


@router.get(API + "/beam-data/{dataset_id}")
async def get_beam_data(dataset_id: str, app: AppState = Depends(state)) -> Any:
    return _detail(_find(await _items(app), dataset_id))


@router.post(API + "/beam-data/parse-csv")
async def parse_beam_data_csv(body: dict[str, Any]) -> Any:
    text = body.get("text")
    if not isinstance(text, str) or len(text) > MAX_CSV_CHARS:
        raise _reject("BAD_CSV", f"text 要是字串（最多 {MAX_CSV_CHARS} 字）")
    raw, problems = bd.parse_csv(text)
    out = []
    for i, m in enumerate(raw):
        rec, p = bd.check_measurement(m)
        problems += [bd.numbered(i, m.get("kind"), x) for x in p]
        if rec is not None:
            out.append({**rec, "label": bd.measurement_label(rec)})
    return {"ok": not problems and bool(out), "problems": problems, "measurements": out}


@router.post(API + "/beam-data", status_code=201)
async def create_beam_data(body: dict[str, Any], request: Request, app: AppState = Depends(state)) -> Any:
    draft = _check(body)
    user = actor(request)
    async with _lock:
        items = await _items(app)
        rec = bd.new_record(draft, user=user)
        items.append(rec)
        await _save(app, items, user)
    request.state.audit_detail = {
        "beam_data": {
            "action": "create",
            "dataset_id": rec["dataset_id"],
            "name": rec["name"],
            "derived_from": rec.get("derived_from"),
        }
    }
    return _detail(rec)


@router.put(API + "/beam-data/{dataset_id}")
async def update_beam_data(
    dataset_id: str, body: dict[str, Any], request: Request, app: AppState = Depends(state)
) -> Any:
    draft = _check(body)
    user = actor(request)
    async with _lock:
        items = await _items(app)
        item = _find(items, dataset_id)
        if item["status"] != "draft":
            raise _reject("NOT_DRAFT", "只有草稿可以改（內建與鎖定的資料集：複製成新草稿再改）", status=item["status"])
        bd.update_draft(item, draft, user=user)
        await _save(app, items, user)
    request.state.audit_detail = {"beam_data": {"action": "update", "dataset_id": dataset_id, "name": item["name"]}}
    return _detail(item)


@router.post(API + "/beam-data/{dataset_id}/lock")
async def lock_beam_data(dataset_id: str, request: Request, app: AppState = Depends(state)) -> Any:
    user = actor(request)
    async with _lock:
        items = await _items(app)
        item = _find(items, dataset_id)
        if item["status"] != "draft":
            raise _reject("NOT_DRAFT", "只有草稿可以鎖定", status=item["status"])
        bd.lock(item, user=user)
        await _save(app, items, user)
    request.state.audit_detail = {"beam_data": {"action": "lock", "dataset_id": dataset_id}}
    return _detail(item)


@router.delete(API + "/beam-data/{dataset_id}")
async def delete_beam_data(dataset_id: str, request: Request, app: AppState = Depends(state)) -> Any:
    user = actor(request)
    async with _lock:
        items = await _items(app)
        item = _find(items, dataset_id)
        if item["status"] != "draft":
            raise _reject("NOT_DRAFT", "只有草稿可以刪（鎖定的資料集可能已被擬合引用）", status=item["status"])
        await _save(app, [x for x in items if x is not item], user)
    request.state.audit_detail = {"beam_data": {"action": "delete", "dataset_id": dataset_id}}
    return {"deleted": dataset_id}
