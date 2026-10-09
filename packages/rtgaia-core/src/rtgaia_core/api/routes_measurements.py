"""量測。

量測是 `kind='measurement'` 的 Layer。這裡只存 wire 形狀的 dict（camelCase，與推送同形），
檢查形狀契約，然後推 `layer.add／update／remove`。`result` 由前端從 points 導出，不存。
"""

from __future__ import annotations

import uuid
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Query, Request, Response

from ..i18n import localized_route_class
from ..limits import MEASUREMENT_ID_MAX
from .deps import API, AppState, actor, push_case, require_id, session_for_measurement, state

router = APIRouter(route_class=localized_route_class())  # 錯誤、原因等句子依請求語言翻

# angle（三點、頂點在中間）、cobb（兩條線、綁平面）、curve（開放折線）
# landmark ＝ 配準地標對：points ＝ [移動點（frameOfReferenceUid 自己的座標）, 固定點
# （pairFrameOfReferenceUid 的座標）]；TRE 由前端用當下的對位算
KINDS = ("distance", "area", "roi3d", "point", "angle", "cobb", "curve", "landmark")
REQUIRED_POINTS = {"point": 1, "distance": 2, "roi3d": 2, "area": 3, "angle": 3, "cobb": 4, "curve": 2, "landmark": 2}
PLANAR = ("area", "cobb")


def _reject(code: str, message: str, **extra: Any) -> HTTPException:
    return HTTPException(status_code=422, detail={"code": code, "message": message, **extra})


def validate_measurement(m: dict[str, Any], session: Any) -> None:
    kind = m.get("kind")
    if kind not in KINDS:
        raise _reject("MS2", "kind 必須是 distance／area／roi3d／point／angle／cobb／curve／landmark", kind=kind)
    pts = m.get("points")
    if not isinstance(pts, list) or len(pts) % 3 != 0 or not all(isinstance(v, int | float) for v in pts):
        raise _reject("MS1", "points 必須是 3 的倍數個 float（LPS mm，世界座標）")
    if len(pts) // 3 < REQUIRED_POINTS[kind]:
        raise _reject("MS3", f"{kind} 至少需要 {REQUIRED_POINTS[kind]} 個點", got=len(pts) // 3)
    if kind == "cobb" and len(pts) // 3 != 4:
        raise _reject("MS3", "cobb 剛好 4 個點（兩條線）", got=len(pts) // 3)
    if kind == "angle" and len(pts) // 3 != 3:
        raise _reject("MS3", "angle 剛好 3 個點（第二點是頂點）", got=len(pts) // 3)
    if kind == "landmark" and len(pts) // 3 != 2:
        raise _reject("MS3", "landmark 剛好 2 個點（移動點、固定點）", got=len(pts) // 3)
    if kind in PLANAR and not m.get("viewReference"):
        raise _reject("MS4", f"{kind} 必須帶 viewReference（平面型量測必須存完整平面）")
    for_uid = m.get("frameOfReferenceUid")
    known = {fg.frame_of_reference_uid for fg in session.frame_groups}
    if for_uid not in known:
        raise _reject("MS5", "frameOfReferenceUid 不是這個 session 的任何 FrameGroup", got=for_uid, known=sorted(known))
    if kind == "landmark" and m.get("pairFrameOfReferenceUid") not in known:
        raise _reject(
            "MS8",
            "landmark 的 pairFrameOfReferenceUid 必須是這個 session 的 FrameGroup",
            got=m.get("pairFrameOfReferenceUid"),
        )


def _layer_of(session: Any, measurement_id: str) -> dict[str, Any]:
    return next(x for x in session.layers() if x["kind"] == "measurement" and x["contentRef"] == measurement_id)


@router.get(API + "/measurements")
async def list_measurements(
    request: Request, study_id: str | None = Query(None), app: AppState = Depends(state)
) -> list[dict[str, Any]]:
    """`?study_id=` 定位病例；沒給（舊 client）退回 current（先找請求者自己的）。"""
    return list(app.store.by_study_or_current(study_id, user=actor(request)).measurements.values())


@router.post(API + "/measurements", status_code=201)
async def create_measurement(
    request: Request, study_id: str | None = Query(None), app: AppState = Depends(state)
) -> Any:
    session = app.store.by_study_or_current(study_id, user=actor(request))
    body = await request.json()
    if not isinstance(body, dict):
        raise _reject("MS0", "body 必須是量測物件")
    m = dict(body)
    if "measurementId" in m:
        m["measurementId"] = require_id(m["measurementId"], field="measurementId", max_len=MEASUREMENT_ID_MAX)
    m.setdefault("measurementId", f"ms_{uuid.uuid4().hex[:10]}")
    m.setdefault("label", m["measurementId"])
    validate_measurement(m, session)
    if m["measurementId"] in session.measurements:
        raise HTTPException(
            status_code=409, detail={"code": "MS6", "message": "measurementId 已存在", "id": m["measurementId"]}
        )
    m.setdefault("createdBy", actor(request))
    session.measurements[m["measurementId"]] = m
    session.case.touch()
    layer = _layer_of(session, m["measurementId"])
    await push_case(app, session, "layer.add", layer)
    return layer


@router.patch(API + "/measurements/{measurement_id}")
async def update_measurement(measurement_id: str, request: Request, app: AppState = Depends(state)) -> Any:
    try:
        session = session_for_measurement(app, request, measurement_id)  # 只找請求者自己的 session
    except KeyError as exc:
        raise HTTPException(
            status_code=404, detail={"code": "MS7", "message": "沒有這個量測", "id": measurement_id}
        ) from exc
    body = await request.json()
    if not isinstance(body, dict):
        raise _reject("MS0", "body 必須是量測物件（可部分）")
    merged = {**session.measurements[measurement_id], **{k: v for k, v in body.items() if k != "measurementId"}}
    validate_measurement(merged, session)
    merged["updatedBy"] = actor(request)
    session.measurements[measurement_id] = merged
    session.case.touch()
    layer = _layer_of(session, measurement_id)
    await push_case(app, session, "layer.update", layer)
    return layer


@router.delete(API + "/measurements/{measurement_id}", status_code=204)
async def delete_measurement(measurement_id: str, request: Request, app: AppState = Depends(state)) -> Response:
    try:
        session = session_for_measurement(app, request, measurement_id)
    except KeyError as exc:
        raise HTTPException(
            status_code=404, detail={"code": "MS7", "message": "沒有這個量測", "id": measurement_id}
        ) from exc
    session.measurements.pop(measurement_id, None)
    session.case.touch()
    session.layer_overrides.pop(f"measurement:{measurement_id}", None)
    await push_case(app, session, "layer.remove", {"layerId": f"measurement:{measurement_id}"})
    return Response(status_code=204)
