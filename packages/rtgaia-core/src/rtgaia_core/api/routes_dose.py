"""劑量 —— DVH。"""

from __future__ import annotations

from typing import Any

import numpy as np
from fastapi import APIRouter, Depends, HTTPException, Query, Request

from ..dvh import DvhTarget, compute_dvh
from ..i18n import localized_route_class
from ..limits import run_cpu
from .deps import API, AppState, readable_dose, readable_structure, readable_structure_ids, state

router = APIRouter(route_class=localized_route_class())  # 錯誤、原因等句子依請求語言翻


@router.get(API + "/dose/{series_id}/dvh")
async def dose_dvh(
    series_id: str,
    structure_ids: str = Query(..., description="逗號分隔的 structure_id"),
    bins: int = Query(200, ge=10, le=2000),
    reference_gy: float | None = Query(None, description="V(ref) 用的參考劑量（例如處方）"),
    frame: int | None = Query(None, description="帶時間軸的結構取哪一個相位"),
    request: Request = None,  # type: ignore[assignment]
    app: AppState = Depends(state),
) -> Any:
    """結構 × 劑量的累積 DVH ＋ 統計。**跨 FoR 也算**：結構經自己的 FrameGroup 到 primary，
    再經劑量所在 FrameGroup 的逆變換到劑量網格（`dvh.py` 的文件）。"""
    # 以劑量序列定位病例，不假設 current；別人的運算暫存結果 404
    session, series = readable_dose(app, series_id, request)
    # DVH 的欄位、參考值與 UI 全是 Gy。`DoseUnits` 不是 GY（RELATIVE／缺）就**拒絕**，
    # 不做隱含換算 —— 相對劑量「相對於什麼」來自 RTPLAN，不一定在選取裡，那是資料模型的事，不是單位換算。
    # 以前 RELATIVE 的病例 DVH 回 200、`dose_max_gy≈47.89`。
    units = str(series.params.get("units") or "").strip().upper()
    if units != "GY":
        raise HTTPException(
            status_code=422,
            detail={
                "code": "DOSE_UNITS_UNSUPPORTED",
                "series_id": series_id,
                "dose_units": units or "(missing)",
                "message": "DVH 統計以 Gy 為單位；這個 RTDOSE 的 DoseUnits 不是 GY，不做隱含換算",
            },
        )
    scaling = series.params.get("dose_grid_scaling")
    if scaling is not None and not (isinstance(scaling, (int, float)) and np.isfinite(scaling) and scaling > 0):
        raise HTTPException(
            status_code=422,
            detail={"code": "DOSE_SCALING_INVALID", "series_id": series_id, "dose_grid_scaling": str(scaling)},
        )
    ids = [s for s in structure_ids.split(",") if s]
    if not ids:
        raise HTTPException(status_code=422, detail={"code": "NO_STRUCTURES", "message": "structure_ids 為空"})

    def to_primary(for_uid: str) -> np.ndarray:
        fg = next((f for f in session.frame_groups if f.frame_of_reference_uid == for_uid), None)
        return fg.matrix if fg is not None else np.eye(4)

    targets: list[DvhTarget] = []
    for sid in ids:
        st = readable_structure(session, sid, frame, request)  # 別人的暫存結果 404
        targets.append(
            DvhTarget(
                structure_id=st.structure_id,
                name=st.name,
                color_rgb=st.color_rgb,
                block=st.block,
                offset_ijk=tuple(int(v) for v in st.offset_ijk),  # type: ignore[arg-type]
                grid=session.mask_grid_for(st.frame_of_reference_uid).grid,
                to_primary=to_primary(st.frame_of_reference_uid),
            )
        )
    dose_to_primary = to_primary(series.frame_of_reference_uid)

    def work() -> dict[str, Any]:
        # 讀劑量（冷載入是 pydicom 解像素）也在執行緒裡，不在 event loop 上
        dose = np.asarray(series.image(series.grid, 0), dtype=np.float32)
        if dose.size and np.isfinite(dose).any() and float(np.nanmin(dose)) < 0:
            # 差值（有負值）不畫 DVH —— 「體積接受 ≥ x Gy」對負的劑量沒有意義；改用 /signed-stats
            raise HTTPException(
                status_code=422,
                detail={
                    "code": "DOSE_SIGNED",
                    "series_id": series_id,
                    "message": "這是差值（有負值），不畫 DVH 曲線；請看最大正差、最大負差與平均差",
                },
            )
        return compute_dvh(
            dose_kji=dose,
            dose_grid=series.grid,
            dose_to_primary=dose_to_primary,
            targets=targets,
            bins=bins,
            reference_gy=reference_gy,
        )

    # 進 CPU 預算（RTGAIA_CPU_WORKERS），名額在執行緒真的結束才還
    out = await run_cpu(work)
    return {"series_id": series_id, "frame_of_reference_uid": series.frame_of_reference_uid, **out}


DVH_EXPORT_FORMATS = ("csv-full", "csv-curves", "png")


@router.post(API + "/dose/{series_id}/dvh/export")
async def dose_dvh_export(
    series_id: str,
    body: dict[str, Any],
    request: Request,
    app: AppState = Depends(state),
) -> Any:
    """DVH 匯出（CSV／PNG 在瀏覽器產生）前**登記一筆稽核** —— 資料離開系統要留下誰、何時、哪些結構、
    是否帶病人識別。稽核由 `audit_writes` 中介層寫，內容從 `request.state.audit_detail` 補上。"""
    fmt = body.get("format")
    if fmt not in DVH_EXPORT_FORMATS:
        raise HTTPException(status_code=422, detail={"code": "BAD_FORMAT", "allowed": list(DVH_EXPORT_FORMATS)})
    ids = body.get("structure_ids")
    if not isinstance(ids, list) or not ids or not all(isinstance(x, str) and x for x in ids):
        raise HTTPException(status_code=422, detail={"code": "NO_STRUCTURES", "message": "structure_ids 為空"})
    session, series = readable_dose(app, series_id, request)
    readable_structure_ids(session, ids, request)  # 看不到的結構（別人的暫存結果）→ 404，不能拿來匯出
    request.state.audit_detail = {
        "dvh_export": {"format": fmt, "structure_ids": ids, "anonymized": body.get("anonymized") is not False}
    }
    return {"ok": True}


@router.get(API + "/dose/{series_id}/max")
async def dose_max(series_id: str, request: Request, app: AppState = Depends(state)) -> Any:
    """最大劑量點 —— 劑量網格索引、劑量 FoR 的世界座標、**primary 世界座標**（經劑量所在 FrameGroup，
    前端拿去 `moveCrosshair`）。同值取第一個（numpy 的 argmax 順序：k、j、i）。"""
    session, series = readable_dose(app, series_id, request)
    fg = next((f for f in session.frame_groups if f.frame_of_reference_uid == series.frame_of_reference_uid), None)
    to_primary = fg.matrix if fg is not None else np.eye(4)

    def work() -> dict[str, Any]:
        dose = np.asarray(series.image(series.grid, 0), dtype=np.float32)
        if dose.size == 0 or not np.isfinite(dose).any():
            raise HTTPException(status_code=422, detail={"code": "EMPTY_DOSE", "series_id": series_id})
        k, j, i = np.unravel_index(int(np.nanargmax(dose)), dose.shape)
        world = series.grid.index_to_world(np.array([[i, j, k]], dtype=np.float64))[0]
        primary = to_primary[:3, :3] @ world + to_primary[:3, 3]
        return {
            "series_id": series_id,
            "max_gy": float(dose[k, j, i]),
            "index_ijk": [int(i), int(j), int(k)],
            "world_mm": [float(v) for v in world],
            "world_primary_mm": [float(v) for v in primary],
        }

    return await run_cpu(work)


@router.get(API + "/dose/{series_id}/signed-stats")
async def dose_signed_stats(
    series_id: str,
    structure_ids: str = Query("", description="逗號分隔的 structure_id（可空 ＝ 只要整體）"),
    request: Request = None,  # type: ignore[assignment]
    app: AppState = Depends(state),
) -> Any:
    """差值劑量的統計 —— 整個網格與每個結構的最大正差、最大負差、平均差（只算有資料、在網格內的點）。
    一般劑量也能查（最大負差就是 0）。"""
    from ..dose_ops import signed_stats
    from ..dvh import sample_dose_for_target

    session, series = readable_dose(app, series_id, request)
    ids = [s for s in structure_ids.split(",") if s]

    def to_primary(for_uid: str) -> np.ndarray:
        fg = next((f for f in session.frame_groups if f.frame_of_reference_uid == for_uid), None)
        return fg.matrix if fg is not None else np.eye(4)

    targets: list[DvhTarget] = []
    for sid in ids:
        st = readable_structure(session, sid, None, request)
        targets.append(
            DvhTarget(
                structure_id=st.structure_id,
                name=st.name,
                color_rgb=st.color_rgb,
                block=st.block,
                offset_ijk=tuple(int(v) for v in st.offset_ijk),  # type: ignore[arg-type]
                grid=session.mask_grid_for(st.frame_of_reference_uid).grid,
                to_primary=to_primary(st.frame_of_reference_uid),
            )
        )
    dose_to_primary = to_primary(series.frame_of_reference_uid)

    def work() -> dict[str, Any]:
        dose = np.asarray(series.image(series.grid, 0), dtype=np.float32)
        rows = []
        for t in targets:
            values, inside = sample_dose_for_target(t, dose, series.grid, dose_to_primary)
            stats = signed_stats(values[inside])
            rows.append(
                {
                    "structure_id": t.structure_id,
                    "name": t.name,
                    "color_rgb": list(t.color_rgb),
                    "outside_fraction": float(1.0 - inside.mean()) if inside.size else 0.0,
                    **stats,
                }
            )
        return {"series_id": series_id, "whole": signed_stats(dose), "structures": rows}

    return await run_cpu(work)
