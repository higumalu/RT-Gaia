"""`expected.json` —— 每個假體的已知答案。

> **前端測試斷言這份檔案，不斷言畫面截圖。**

三種數字刻意分開，因為它們的用途不同：

| 欄位 | 意義 | 誰用 |
|---|---|---|
| `volume_cc` | **解析體積**（球公式算出來的） | 文件引用的那個數字（65.45 / 64.00），驗收量測工具 |
| `volume_cc_voxelized` | 體素計數 × 體素體積 | 驗收 mask 管線（後端算出的 `volume_cc` 必須等於它，逐位元） |
| `tolerance_cc` | 兩者的允許差 | 離散化誤差的上限；**不是量測誤差** |

混用這三個是這類測試最常見的錯誤：拿解析值去斷言體素計數，會在 spacing 一改
就掛，而且看起來像「量測不準」。
"""

from __future__ import annotations

from typing import Any

import numpy as np
from rtgaia_core.dataset import Dataset
from rtgaia_geom import MaskGrid, __version__


def expected_json(dataset: Dataset, *, include_voxelized: bool = True) -> dict[str, Any]:
    from . import mask_block

    mask_grid = MaskGrid.of(dataset.primary.grid)
    out: dict[str, Any] = {
        "phantom_id": dataset.dataset_id,
        "description": dataset.description,
        "study_id": dataset.study_id,
        "geom_version": __version__,
        "verifies": list(dataset.verifies),
        "mask_grid_id": mask_grid.mask_grid_id,
        "series": {},
        "structures": {},
        "markers": {},
        "temporal_groups": [tg.to_wire() for tg in dataset.temporal_groups],
        "notes": dict(dataset.notes),
    }

    for s in dataset.series:
        out["series"][s.series_id] = {
            "role": s.role,
            "modality": s.modality,
            "grid": s.grid.to_wire(),
            "default_window": list(s.default_window),
            "temporal_group_id": s.temporal_group_id,
            "transform_to_primary_row_major": (list(s.transform_to_primary) if s.transform_to_primary else None),
            # 幾何自檢：角點的世界座標。前端算出來的必須逐一吻合。
            "corners_world_lps": s.grid.corners_world.tolist(),
            "voxel_volume_mm3": s.grid.voxel_volume_mm3,
        }

    for st in dataset.structures:
        grid = next(s.grid for s in dataset.series if s.frame_of_reference_uid == st.frame_of_reference_uid)
        entry: dict[str, Any] = {
            "name": st.name,
            "tg263_code": st.tg263_code,
            "color_rgb": list(st.color_rgb),
            "frame_of_reference_uid": st.frame_of_reference_uid,
            "status": st.status,
            "default_visible": st.default_visible,
            "temporal_group_id": st.temporal_group_id,
        }
        if st.shape is not None:
            entry["volume_cc"] = round(st.shape.analytic_volume_mm3 / 1000.0, 2)
            entry["volume_cc_analytic_exact"] = st.shape.analytic_volume_mm3 / 1000.0
        else:
            # 🔴 真實資料**沒有解析答案** —— 這正是合成假體不能被它取代的理由
            entry["volume_cc"] = None
            entry["volume_cc_analytic_exact"] = None
            entry["source"] = "rtstruct"
            entry["interpreted_type"] = st.interpreted_type
        if include_voxelized:
            block = mask_block(dataset, st, frame_index=0 if st.temporal_group_id else None)
            if block is None:
                entry["voxelized"] = None
            else:
                offset, size, data = block
                count = int(np.count_nonzero(data))
                voxelized = count * grid.voxel_volume_mm3 / 1000.0
                entry.update(
                    {
                        "bbox_offset_ijk": list(offset),
                        "bbox_size_ijk": list(size),
                        "voxel_count": count,
                        "volume_cc_voxelized": voxelized,
                    }
                )
                if st.shape is not None:
                    # 離散化誤差上限：以解析值與體素值的差粗估；不是量測誤差。
                    entry["tolerance_cc"] = max(0.02, abs(voxelized - st.shape.analytic_volume_mm3 / 1000.0) * 1.5)
        out["structures"][st.structure_id] = entry

    for m in dataset.markers:
        out["markers"][m.marker_id] = {
            "world_lps": list(m.world_lps),
            "ijk": list(m.ijk) if m.ijk else None,
            "voxel_value": m.voxel_value,
            "frame_of_reference_uid": m.frame_of_reference_uid,
        }

    if len(dataset.markers) == 2:
        a, b = (np.asarray(m.world_lps, dtype=np.float64) for m in dataset.markers)
        out["marker_distance_mm"] = float(np.linalg.norm(a - b))

    return out
