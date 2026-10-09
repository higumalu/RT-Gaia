#!/usr/bin/env python
"""產生前端幾何一致性測試的向量檔。

跨語言驗收：**Python 端與瀏覽器端對同一個 world 座標算出的 ijk 必須
一致。** 這個腳本把 Python 端算出的答案寫成 JSON，前端測試逐條比對。

> 兩邊各寫一次測試、各自通過，證明的是「各自自洽」，不是「彼此一致」。
> 因此測試向量必須由**一邊產生、另一邊斷言**。
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import numpy as np
from rtgaia_geom import (
    DisplayGrid,
    FrameGroup,
    Grid,
    MaskGrid,
    ViewReference,
    __version__,
    rigid_matrix,
)
from rtgaia_testbe import phantoms

OUT = Path(__file__).resolve().parents[1] / "apps/viewer/tests/fixtures/geometry-vectors.json"

SAMPLE_INDICES = [
    [0.0, 0.0, 0.0],
    [1.0, 0.0, 0.0],
    [0.0, 1.0, 0.0],
    [0.0, 0.0, 1.0],
    [12.5, 3.25, 7.0],
    [37.0, 61.0, 13.0],
    [0.5, 0.5, 0.5],
]


def grid_case(name: str, grid: Grid) -> dict:
    idx = np.asarray(SAMPLE_INDICES, dtype=np.float64)
    world = grid.index_to_world(idx)
    return {
        "name": name,
        "grid": grid.to_wire(),
        "index_to_world": [
            {"ijk": list(i), "world_lps": list(w)} for i, w in zip(idx.tolist(), world.tolist(), strict=True)
        ],
        "world_to_index": [{"world_lps": list(w), "ijk": q(grid.world_to_index(w))} for w in world.tolist()],
        "corners_world_lps": grid.corners_world.tolist(),
        "voxel_volume_mm3": grid.voxel_volume_mm3,
        "index_to_world_matrix_row_major": grid.index_to_world_matrix[:3, :3].flatten().tolist(),
    }


def _kernel_section() -> dict:
    """重切核心的跨語言測試向量（WASM 與原生建構的等效性驗證）。

    刻意用**小的合成 volume**（16×16×8）並把體素值也寫進 JSON：前端測試因此
    不需要 fixture 之外的任何東西，也不需要跑後端。**兩邊算的是同一份資料。**
    """
    try:
        from rtgaia_geom.kernel import load_kernel
    except Exception:  # pragma: no cover
        return {"available": False, "reason": "import failed"}
    try:
        kernel = load_kernel()
    except Exception as exc:
        return {"available": False, "reason": str(exc).split("\n")[0]}

    grid = Grid(
        size=(16, 16, 8),
        spacing=(1.5, 1.5, 3.0),
        origin=(-11.25, -11.25, -10.5),
        direction=tuple(np.asarray(rigid_matrix(rotation_deg=(15.0, 0.0, 0.0))[:3, :3]).flatten().tolist()),
        frame_of_reference_uid="for.kernel.vectors",
    )
    ni, nj, nk = grid.size
    i = np.arange(ni)[None, None, :]
    j = np.arange(nj)[None, :, None]
    k = np.arange(nk)[:, None, None]
    volume = ((i * 7 + j * 13 + k * 29) % 1000 - 400).astype(np.int16)
    volume = np.ascontiguousarray(np.broadcast_to(volume, (nk, nj, ni)).copy())

    sample_points = [
        [0.0, 0.0, 0.0],
        [3.0, -2.0, 1.5],
        [-8.0, 5.0, -6.0],
        [11.0, 11.0, 9.0],
    ]
    samples = [{"world_lps": p, "value": kernel.sample_world(volume, grid, p, outside=-1024.0)} for p in sample_points]

    view = ViewReference(
        frame_of_reference_uid=grid.frame_of_reference_uid,
        display_grid_id="dg_kernel_vectors",
        plane_origin=(0.0, 0.0, 0.0),
        view_plane_normal=(0.0, 0.3826834323650898, 0.9238795325112867),
        view_up=(0.0, 0.9238795325112867, -0.3826834323650898),
        slab_thickness_mm=0.0,
    )
    plane = kernel.reslice(volume, grid, view, out_size_px=(12, 12), px_mm=1.5, blend="center", outside=-1024.0)

    # 一顆球的 mask，用來對照 marching squares
    kk, jj, ii = np.meshgrid(np.arange(nk), np.arange(nj), np.arange(ni), indexing="ij")
    world = grid.index_to_world(np.stack([ii.ravel(), jj.ravel(), kk.ravel()], axis=1).astype(np.float64))
    radius = 6.0
    mask = (np.linalg.norm(world, axis=1) <= radius).reshape(nk, nj, ni).astype(np.uint8)
    mask_plane = kernel.reslice(mask, grid, view, out_size_px=(24, 24), px_mm=0.75, blend="center", outside=0.0)
    segments = kernel.marching_squares(mask_plane, 0.5)
    polylines = kernel.stitch(segments)

    return {
        "available": True,
        "grid": grid.to_wire(),
        "volume_kji": volume.astype(int).ravel().tolist(),
        "samples": samples,
        "reslice": {
            "view_reference": view.to_wire(),
            "out_size_px": [12, 12],
            "px_mm": 1.5,
            "plane_row_major": [float(v) for v in plane.ravel()],
        },
        "mask_outline": {
            "sphere_radius_mm": radius,
            "out_size_px": [24, 24],
            "px_mm": 0.75,
            "mask_kji": mask.astype(int).ravel().tolist(),
            "segment_count": int(len(segments)),
            "polyline_count": len(polylines),
            "polyline_point_counts": [int(len(p)) for p in polylines],
        },
    }


def _laterality_section() -> dict:
    """🔴 左右方位的跨語言驗收向量。

    現有的假體在左右方向上**全部對稱**，因此「axial 整格左右鏡像」不會讓任何
    測試變色。`laterality` 假體只在病人右側（LPS `-x`）放一顆球；這裡把它的
    **實際光柵化質心**寫出來，前端據此斷言「病人右落在畫面左」。

    質心從真的 mask 算，不是從 `Sphere.center` 抄——否則假體定義改了而向量沒
    重跑時，測試會對著一個已經不存在的位置通過。
    """
    p = phantoms.build("laterality")
    grid = p.primary.grid
    centroids = {}
    for st in p.structures:
        block = phantoms.mask_block(p, st)
        assert block is not None, f"{st.structure_id} 沒有 mask"
        offset, size, data = block
        kji = np.argwhere(np.asarray(data, dtype=np.uint8) > 0)
        assert kji.size > 0, f"{st.structure_id} 的 mask 是空的"
        # block 是 (k, j, i)；換回全網格的 ijk
        ijk = kji[:, ::-1] + np.asarray(offset, dtype=np.int64)
        world = grid.index_to_world(ijk.astype(np.float64))
        centroids[st.structure_id] = [float(v) for v in world.mean(axis=0)]

    return {
        "grid": grid.to_wire(),
        "centroids_world_lps": centroids,
        # 三個正交方位的期望 right 向量（法線指向觀察者的右手系推導結果）
        "expected_right": {
            "axial": [1.0, 0.0, 0.0],
            "coronal": [1.0, 0.0, 0.0],
            "sagittal": [0.0, 1.0, 0.0],
        },
        "expected_normal": {
            "axial": [0.0, 0.0, -1.0],
            "coronal": [0.0, -1.0, 0.0],
            "sagittal": [1.0, 0.0, 0.0],
        },
        "expected_view_up": {
            "axial": [0.0, -1.0, 0.0],
            "coronal": [0.0, 0.0, 1.0],
            "sagittal": [0.0, 0.0, 1.0],
        },
    }


# 🔴 **走 `np.linalg.inv` 的輸出跨機器不會逐位元組相同。**
#
# CI 的「重跑後不得有 diff」在這裡失敗過，而且不是因為漏跑腳本：GitHub runner
# 算出 `0.9999999999999716` 與 `-2.842170943040401e-14`，本機算出 `1.0` 與 `0.0`。
# 差別來自 numpy 背後的 LAPACK 實作，不同機器就是不同的最後幾個 bit。
#
# **要求浮點結果跨機器位元組相同是做不到的**，而那道檢查真正要抓的是「後端改了
# 幾何卻忘記重跑腳本」——不是浮點的最後一位。因此這兩類輸出量化到 1e-10：
#
# | 來源 | 為什麼會飄 |
# |---|---|
# | `Grid.world_to_index` | `world_to_index_matrix` 是 `np.linalg.inv`（`grid.py:114`） |
# | `FrameGroup.from_primary_world` | `inverse_matrix` 是 `np.linalg.inv`（`frame_group.py:155`） |
#
# **其餘欄位一律不動。** `index_to_world`、`direction`、`origin`、`spacing`、
# `source_index_of` 都只是乘加，跨機器相同 —— 而量化它們會有害：方向餘弦少了
# 1e-10，乘上 500 個體素就是 5e-8 mm 的位置誤差，那**超過**前端的容差。
#
# 為什麼是 1e-10：前端逐條斷言的容差是 `TOL = 1e-9`
# （`geometry-consistency.test.ts:84`），實際的跨語言誤差在 1e-13 量級。量化
# 引入的誤差 ≤ 5e-11 —— 比容差小 20 倍，比要吸收的機器雜訊（~3e-14）大三個
# 數量級。**真的算法分岔（≥ 1e-9）仍然會被前端抓到。**
LAPACK_QUANTUM_DECIMALS = 10


def q(values: Any) -> list[float]:
    """量化一個走過 `np.linalg.inv` 的座標，讓輸出跨機器相同。"""
    out = []
    for v in np.asarray(values, dtype=np.float64).tolist():
        r = round(float(v), LAPACK_QUANTUM_DECIMALS)
        # `round(-2.8e-14, 10)` 是 `-0.0`，序列化成 "-0.0" 又會與 "0.0" 不同
        out.append(0.0 if r == 0 else r)
    return out


def main() -> None:
    cases = []
    for dataset_id in ("axial_clean", "gantry_tilt", "oblique_acq", "anisotropic", "landmark"):
        p = phantoms.build(dataset_id)
        for series in p.series:
            cases.append(grid_case(f"{dataset_id}:{series.series_id[-12:]}", series.grid))

    landmark = phantoms.build("landmark")
    lm_expected = phantoms.expected_json(landmark)
    tilt = phantoms.build("gantry_tilt")
    tilt_grid = tilt.primary.grid

    display_cases = []
    for factor in ((1, 1, 1), (2, 2, 1), (2, 2, 2), (4, 4, 2)):
        dg = DisplayGrid.derive(tilt_grid, downsample_factor=factor)
        display_cases.append(
            {
                "downsample_factor": list(factor),
                "display_grid": dg.to_wire(),
                # 🔴 降採樣後 origin 必須落在被合併體素的**中心**
                "expected_origin_lps": list(tilt_grid.index_to_world([(f - 1) / 2 for f in factor])),
                "source_index_of_display_000": list(dg.source_index_of([0, 0, 0])),
                "resident_bytes": dg.resident_bytes,
            }
        )

    m = rigid_matrix(translation_mm=(15.0, -8.0, 4.0), rotation_deg=(0.0, 0.0, 5.0))
    fg = FrameGroup.secondary_rigid("for.secondary", "series.secondary", m)
    transform_points = [[0.0, 0.0, 0.0], [10.0, 20.0, -30.0], [-5.5, 2.25, 100.0]]

    view = ViewReference(
        frame_of_reference_uid=tilt_grid.frame_of_reference_uid,
        display_grid_id=DisplayGrid.derive(tilt_grid).display_grid_id,
        plane_origin=(0.0, 0.0, 0.0),
        view_plane_normal=(0.0, 0.5, 0.8660254037844386),
        view_up=(0.0, 0.8660254037844386, -0.5),
        slab_thickness_mm=3.0,
    )

    kernel_section = _kernel_section()

    payload = {
        "generated_by": f"scripts/emit-geometry-fixture.py (rtgaia-geom {__version__})",
        "purpose": "跨語言驗收：Python 與瀏覽器對同一個 world 座標必須算出同一個 ijk",
        "grid_cases": cases,
        "display_grid_cases": {
            "source_grid": tilt_grid.to_wire(),
            "cases": display_cases,
        },
        "mask_grid": MaskGrid.of(tilt_grid).to_wire(),
        "frame_group": {
            "frame_group": fg.to_wire(),
            "matrix_row_major": m.flatten().tolist(),
            "to_primary": [{"self_world": p, "primary_world": list(fg.to_primary_world(p))} for p in transform_points],
            "from_primary": [{"primary_world": p, "self_world": q(fg.from_primary_world(p))} for p in transform_points],
        },
        "view_reference": {
            "view_reference": view.to_wire(),
            "right": list(view.right),
            "row_direction": list(-view.up),
            "signed_distance": [
                {"world_lps": p, "distance_mm": float(view.signed_distance(p))} for p in transform_points
            ],
        },
        "landmark": {
            "ijk": list(lm_expected["markers"]["landmark_voxel"]["ijk"]),
            "world_lps": list(lm_expected["markers"]["landmark_voxel"]["world_lps"]),
            "voxel_value": lm_expected["markers"]["landmark_voxel"]["voxel_value"],
            "grid": landmark.primary.grid.to_wire(),
        },
        "kernel": kernel_section,
        "laterality": _laterality_section(),
        "known_geometry": {
            k: v
            for k, v in phantoms.expected_json(phantoms.build("known_geometry")).items()
            if k in ("structures", "markers", "marker_distance_mm")
        },
    }
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"寫入 {OUT}（{len(cases)} 個網格案例）")


if __name__ == "__main__":
    main()
