"""mesh 抽取。

**mask 用於編輯（少數幾個）、mesh 用於 3D 總覽（很多個）**。因此這裡的
重點不是網格品質，而是 LOD：`lod=2` 用於總覽、`lod=0` 用於單結構檢視。

LOD 以 marching cubes 的 `step_size` 實作（先降採樣再抽取），而不是抽完再簡化
——後者要一個 decimation 實作，前者是同一個呼叫的參數，且成本更低。
"""

from __future__ import annotations

import numpy as np
from rtgaia_geom import MeshPayload
from rtgaia_geom.grid import Grid
from rtgaia_geom.hashing import digest_bytes
from skimage import measure

LOD_STEP = {0: 1, 1: 2, 2: 4}


def extract(
    mask_dense: np.ndarray,
    grid: Grid,
    *,
    structure_id: str,
    mask_grid_id: str,
    lod: int = 0,
    frame_index: int | None = None,
) -> MeshPayload:
    """由全網格 mask 抽出表面，**頂點為 LPS mm 世界座標**。

    🔴 頂點一律送世界座標，不送索引座標。前端已經有 `FrameGroup` 的變換要套，
    再讓它自己乘一次網格矩陣，就多了一處可以寫錯的地方——而症狀是
    「3D 裡的表面與 2D 裡的輪廓對不上」。
    """
    step = LOD_STEP.get(int(lod), 1)
    if mask_dense.max() == 0:
        return MeshPayload(
            structure_id=structure_id,
            mask_grid_id=mask_grid_id,
            frame_of_reference_uid=grid.frame_of_reference_uid,
            lod=int(lod),
            vertices=np.zeros((0, 3), dtype=np.float32),
            triangles=np.zeros((0, 3), dtype=np.uint32),
            content_hash="mesh_empty",
            frame_index=frame_index,
        )
    padded = np.pad(mask_dense.astype(np.float32), 1, mode="constant")
    verts_kji, faces, _normals, _values = measure.marching_cubes(
        padded, level=0.5, step_size=step, allow_degenerate=False
    )
    # 去掉 pad 的一格，並把 (k, j, i) 轉成 (i, j, k)
    ijk = verts_kji[:, ::-1] - 1.0
    world = grid.index_to_world(ijk.astype(np.float64)).astype(np.float32)
    tri = np.ascontiguousarray(faces, dtype=np.uint32)
    if grid.handedness < 0:
        # 🔴 左手系網格（切片沿 −z 排列，DICOM 常態）：index→world 翻轉手性，
        # 因此 marching cubes 的三角形繞向也跟著翻。不翻回來的症狀是
        # **背面剔除把整個表面剔掉 —— 3D 裡什麼都看不到，而且不會報錯。**
        tri = np.ascontiguousarray(tri[:, ::-1], dtype=np.uint32)
    payload_bytes = world.tobytes() + tri.tobytes()
    return MeshPayload(
        structure_id=structure_id,
        mask_grid_id=mask_grid_id,
        frame_of_reference_uid=grid.frame_of_reference_uid,
        lod=int(lod),
        vertices=np.ascontiguousarray(world, dtype=np.float32),
        triangles=tri,
        content_hash=digest_bytes(payload_bytes, prefix="me_"),
        frame_index=frame_index,
    )
