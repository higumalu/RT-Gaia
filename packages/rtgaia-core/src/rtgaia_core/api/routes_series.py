"""影像與時間群組。"""

from __future__ import annotations

from typing import Any

import numpy as np
from fastapi import APIRouter, Depends, HTTPException, Query, Request, Response
from rtgaia_geom import CONTENT_TYPE

from ..i18n import localized_route_class
from ..limits import run_cpu
from .deps import API, AppState, actor, downsample, encode_frame, image_volume, lod_factor, state

router = APIRouter(route_class=localized_route_class())  # 錯誤、原因等句子依請求語言翻


@router.get(API + "/series/{series_id}/image")
async def get_image(
    series_id: str,
    display_grid: str = Query(..., description="必填；前端據此比對網格 id"),
    lod: int = Query(0, ge=0, le=2),
    transform: str | None = Query(None),
    frame: int | None = Query(None),
    request: Request = None,  # type: ignore[assignment]
    app: AppState = Depends(state),
) -> Response:
    """影像 payload。

    * **不帶 `transform`（預設）**：回傳序列在自己原生網格上的資料，剛性對齊由
      前端以 `userMatrix` 完成 ——**這是建議路徑**。
    * **帶 `transform`**：後端重採樣到 primary 的 display grid 後回傳。
    """
    session = app.store.by_series(series_id)
    # 同一病例可能有多個人的 session、各自的 DisplayGrid；用請求帶的 display_grid 找回**它的** session
    if display_grid != session.display_grid.display_grid_id:
        owner = app.store.by_display_grid(display_grid)
        if owner is not None and owner.case is session.case:
            session = owner
    series = session.dataset.series_by_id(series_id)
    if request is not None and session.case.is_derived_dose_of_other(series_id, actor(request)):
        # 別人的劑量運算暫存結果（跟暫存結構同一個規則：404，不說它存在）
        raise HTTPException(status_code=404, detail={"code": "NO_SERIES", "series_id": series_id})
    if display_grid != session.display_grid.display_grid_id:
        raise HTTPException(
            status_code=409,
            detail={
                "code": "I3",
                "message": "display_grid 與 session 不符——請重新 POST /grids",
                "session_display_grid_id": session.display_grid.display_grid_id,
            },
        )
    if series.temporal_group_id is None and frame not in (None, 0):
        raise HTTPException(
            status_code=422,
            detail={"code": "T7", "message": "此序列不屬於任何 TemporalGroup，不得帶 frame"},
        )
    if series.temporal_group_id is not None:
        tg = next(g for g in session.temporal_groups if g.temporal_group_id == series.temporal_group_id)
        tg.validate_frame_index(frame if frame is not None else 0)

    if transform and transform not in session.transforms:
        raise HTTPException(status_code=404, detail={"code": "NO_TRANSFORM", "transform": transform})

    # 讀像素、重採樣、降採樣、tobytes、content hash、zstd 壓縮**全部**在執行緒跑
    # （CPU 預算 `run_cpu` 內）。以前只有讀像素與降採樣在執行緒，其餘在 event loop 上：4 個 512×512×296 的 lod 0 並發時
    # `/healthz` 最久等 2.5 s（scripts/perf/loop_latency.py），同一個 event loop 上的 WS、其他人的請求一起等。
    def work() -> bytes:
        volume, grid = image_volume(session, series_id, frame)
        transform_kind = "native"
        coverage_mask_id = None
        out_grid = grid
        if transform:
            volume, out_grid, coverage_mask_id = _resample_to_primary(session, series_id, volume, transform)
            transform_kind = "resampled"

        # 劑量網格本來就粗（2.5 mm）且是 float32，不跟著 primary 的降採樣倍率走；
        # lod 仍然適用（它是「前端要求的較低解析度」，不是「後端為了預算做的決定」）。
        display_factor = (
            session.display_grid.downsample_factor if (out_grid is grid and series.kind == "image") else (1, 1, 1)
        )
        total = tuple(display_factor[i] * lod_factor(lod)[i] for i in range(3))
        data = downsample(np.asarray(volume), total)  # type: ignore[arg-type]

        from rtgaia_geom import DisplayGrid
        from rtgaia_geom.hashing import payload_content_hash

        # `DisplayGrid.derive` 只是拿來算「降採樣後的網格」（含盒中心 origin 那一行），
        # 它的 dtype 欄位與 payload 的 dtype 無關 —— payload dtype 由序列決定。
        effective = DisplayGrid.derive(out_grid, downsample_factor=total, dtype="int16")  # type: ignore[arg-type]
        np_dtype = np.float32 if series.dtype == "float32" else np.int16
        raw = np.ascontiguousarray(data, dtype=np_dtype).tobytes()
        header: dict[str, Any] = {
            "semantics": series.semantics,
            "components": 1,
            "dtype": series.dtype,
            "kind": series.kind,
            "params": dict(series.params),
            "grid": effective.grid.to_wire(),
            "source_grid": out_grid.to_wire(),
            "display_grid_id": session.display_grid.display_grid_id,
            "effective_grid_id": effective.display_grid_id,
            "lod": lod,
            "frame_of_reference_uid": out_grid.frame_of_reference_uid,
            "offset_ijk": [0, 0, 0],
            "size_ijk": list(effective.grid.size),
            "temporal_group_id": series.temporal_group_id,
            "frame_index": frame if series.temporal_group_id else None,
            "window_baked": None,
            "default_window": list(series.default_window),
            "modality": series.modality,
            "transform_kind": transform_kind,
            "coverage_mask_id": coverage_mask_id,
            # 同 mask：hash 必須能區分「同樣的體素但不同的網格／相位」
            "content_hash": payload_content_hash(
                offset_ijk=(0, 0, 0),
                size_ijk=tuple(int(v) for v in effective.grid.size),
                data=raw,
                prefix="im_",
                extra={
                    "grid_id": effective.display_grid_id,
                    "frame_index": frame if series.temporal_group_id else None,
                    "transform_kind": transform_kind,
                },
            ),
        }
        return encode_frame(header, raw, app.chaos)

    return Response(content=await run_cpu(work), media_type=CONTENT_TYPE)


def _resample_to_primary(session, series_id: str, volume, transform_id: str):
    """帶 `transform` 時的重採樣（第二條路徑）。

    用於形變變換、匯出、或需要共同網格的體素級運算——**不是**互動路徑。
    """
    import SimpleITK as sitk
    from rtgaia_geom.hashing import digest

    from ..reslice import to_sitk_image

    spec = session.transforms[transform_id]
    matrix = np.asarray(spec["matrix"], dtype=np.float64).reshape(4, 4)
    series = session.dataset.series_by_id(series_id)
    target = session.display_grid.source_grid

    img = sitk.Cast(to_sitk_image(np.asarray(volume), series.grid), sitk.sitkFloat32)
    ref = sitk.Image(*[int(v) for v in target.size], sitk.sitkFloat32)
    ref.SetSpacing([float(v) for v in target.spacing])
    ref.SetOrigin([float(v) for v in target.origin])
    ref.SetDirection([float(v) for v in target.direction])

    affine = sitk.AffineTransform(3)
    # sitk 的 transform 是「輸出 → 輸入」，因此要送逆矩陣
    inv = np.linalg.inv(matrix)
    affine.SetMatrix([float(v) for v in inv[:3, :3].flatten()])
    affine.SetTranslation([float(v) for v in inv[:3, 3]])

    out = sitk.Resample(img, ref, affine, sitk.sitkLinear, -1024.0, sitk.sitkFloat32)
    arr = np.rint(sitk.GetArrayFromImage(out)).astype(np.int16)
    # coverage：重採樣後哪些體素真的有來源資料
    ones = sitk.Cast(to_sitk_image(np.ones_like(np.asarray(volume), dtype=np.uint8), series.grid), sitk.sitkFloat32)
    cov = sitk.Resample(ones, ref, affine, sitk.sitkNearestNeighbor, 0.0, sitk.sitkFloat32)
    coverage_id = digest(
        {"transform": transform_id, "series": series_id, "voxels": int((sitk.GetArrayFromImage(cov) > 0).sum())},
        prefix="cov_",
        length=16,
    )
    return arr, target, coverage_id


@router.get(API + "/temporal/{temporal_group_id}/window")
async def temporal_window(
    temporal_group_id: str,
    request: Request,
    from_: int = Query(0, alias="from", ge=0),
    count: int = Query(8, ge=1, le=64),
    app: AppState = Depends(state),
) -> dict[str, Any]:
    """T3 串流只保留視窗，不全部常駐。"""
    try:
        session = app.store.by_temporal_group(temporal_group_id)  # 以時間群組定位
    except KeyError:
        session = app.store.current()
    tg = next((g for g in session.temporal_groups if g.temporal_group_id == temporal_group_id), None)
    if tg is None:
        raise HTTPException(status_code=404, detail={"code": "NO_TEMPORAL_GROUP"})
    limit = tg.frame_count if tg.frame_count is not None else from_ + count
    frames = list(range(from_, min(from_ + count, limit)))
    return {
        "temporal_group_id": temporal_group_id,
        "frame_index_from": from_,
        "frames": frames,
        "next_available": (
            frames[-1] + 1 if frames and (tg.frame_count is None or frames[-1] + 1 < tg.frame_count) else None
        ),
        "kind": tg.kind,
        "frame_count": tg.frame_count,
    }
