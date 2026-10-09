"""不變式 I2–I4 的唯一一份可執行定義。

> 這些檢查**必須以程式強制，不是靠約定**。網格的不變式若沒有機器強制，
> 會產生「看起來像分割不準、其實是 1-voxel 偏移」的問題——那是最難查的一類 bug。

`rtgaia-geom` 是這份定義的家；測試後端（會故意違反它）與正式
後端共用同一份程式碼，前端 `core/geometry` 是它的 TypeScript 鏡像。
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Literal

import numpy as np

from .display_grid import DisplayGrid, MaskGrid
from .errors import require
from .grid import Grid

GridFamily = Literal["display", "mask"]

WORLD_TOL_MM = 1e-4
"""跨族比對的世界座標容差。

比對的是「兩個網格是否描述同一塊空間」，不是浮點是否位元相同。1e-4 mm ＝ 0.1 µm，
遠小於任何取像解析度，又吃得下矩陣求逆的捨入誤差。
"""


def assert_same_family(
    *,
    payload_grid_ref: str,
    session_grid_id: str,
    family: GridFamily,
    payload_label: str = "payload",
) -> None:
    """I3 —— 同族網格 id 比對。

    **前端合成任何兩個 payload 前，必須比對「同族網格 id」，不符即拒絕並報錯，
    不得嘗試自動對齊。**（測試後端 chaos: `grid_mismatch`）
    """
    require(
        payload_grid_ref == session_grid_id,
        "I3",
        f"{payload_label} 的 {family} grid id 與本次會話不符——拒絕合成，不得嘗試自動對齊",
        payload_grid_ref=payload_grid_ref,
        session_grid_id=session_grid_id,
        family=family,
    )


def assert_cross_family_compatible(display_grid: DisplayGrid, mask_grid: MaskGrid) -> None:
    """I3 的跨族分支 —— **比對的是 FoR 與世界座標，不是網格 id**。

    影像與 mask 在 vtk.js 裡本就是各自的 `vtkImageData`，GPU 取樣天生支援不同
    解析度的疊圖。因此跨族**不該**比 id（那會在 Tier B 降採樣時誤判），
    而是要求兩者落在同一個 Frame of Reference、且描述同一塊世界空間。
    """
    require(
        display_grid.grid.frame_of_reference_uid == mask_grid.grid.frame_of_reference_uid,
        "I3",
        "影像與 mask 必須落在同一個 Frame of Reference",
        display=display_grid.grid.frame_of_reference_uid,
        mask=mask_grid.grid.frame_of_reference_uid,
    )
    require(
        np.allclose(
            display_grid.source_grid.direction_matrix,
            mask_grid.grid.direction_matrix,
            atol=WORLD_TOL_MM,
        ),
        "I3",
        "影像的取像網格與 mask 網格的 direction 必須相同",
    )
    require(
        np.allclose(display_grid.source_grid.origin, mask_grid.grid.origin, atol=WORLD_TOL_MM),
        "I3",
        "影像的取像網格與 mask 網格的 origin 必須相同",
        display_source_origin=display_grid.source_grid.origin,
        mask_origin=mask_grid.grid.origin,
    )


def assert_round_trip(grid: Grid, *, samples: int = 32, seed: int = 0) -> float:
    """`world_to_index(index_to_world(x)) == x` 的自檢，回傳最大誤差。

    這是「座標轉換鏈每一段都必須有單元測試」的最小形式，也是驗證 `gantry_tilt`
    假體有沒有漏傳 `direction` 的第一道關卡。
    """
    rng = np.random.default_rng(seed)
    idx = rng.uniform(0, np.asarray(grid.size, dtype=np.float64) - 1.0, size=(samples, 3))
    back = grid.world_to_index(grid.index_to_world(idx))
    return float(np.abs(back - idx).max())


@dataclass
class InvalidationTracker:
    """I4 —— **兩個網格 id 各自獨立失效，不連動**。

    `display_grid_id` 改變 → 所有影像 payload 失效。
    `mask_grid_id` 改變 → 所有 mask 與 mesh 失效。

    正式後端與測試後端都不需要這個類別（失效是前端狀態），它存在的理由是讓
    **語意有一份可執行的定義**，前端 `SceneManager` 的 TS 實作以此為鏡像並共用測試向量。
    """

    display_grid_id: str
    mask_grid_id: str
    invalidated: list[str] = field(default_factory=list)

    def update(self, *, display_grid_id: str | None = None, mask_grid_id: str | None = None) -> set[str]:
        """回傳因此次變更而失效的 payload 類別。"""
        dropped: set[str] = set()
        if display_grid_id is not None and display_grid_id != self.display_grid_id:
            self.display_grid_id = display_grid_id
            dropped.add("image")
        if mask_grid_id is not None and mask_grid_id != self.mask_grid_id:
            self.mask_grid_id = mask_grid_id
            dropped.update({"mask", "mesh"})
        self.invalidated.extend(sorted(dropped))
        return dropped
