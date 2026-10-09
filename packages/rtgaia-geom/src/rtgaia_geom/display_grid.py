"""`DisplayGrid` / `MaskGrid` / `GridSet`。

兩個網格刻意分開，且**各自獨立失效**（I4）：
  * `DisplayGrid` 是「給 GPU 看的」，可裁切、可降採樣，只是顯示。
  * `MaskGrid` 是「被編輯與輸出的真相」，恆等於取像網格。

> `MaskGrid` **不提供裁切自由度**。它只是一個座標系
> 宣告，本身不佔記憶體；裁切它零收益，卻會與 `MaskPayload.offset_ijk` 疊成兩層
> 索引原點，製造一整類 off-by-one。裁切一律只發生在 payload 的 bbox 這一層。
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Literal

import numpy as np

from .errors import require
from .frame_group import FrameGroup
from .grid import Grid, Int3
from .hashing import digest
from .temporal import TemporalGroup

DisplayDType = Literal["int16", "uint8"]
Tier = Literal["A", "B", "C"]


@dataclass(frozen=True)
class DisplayGrid:
    """送到瀏覽器的影像網格，以及它與取像網格的關係。

    **display grid 是「一次會話裡所有序列共用的一個網格」，不是每個序列一個**。
    它由 primary series 決定，其餘序列以 FrameGroup 變換對齊。
    """

    grid: Grid
    source_grid: Grid
    crop_offset_ijk: Int3
    downsample_factor: Int3
    dtype: DisplayDType
    window_baked: tuple[float, float] | None
    display_grid_id: str

    def __post_init__(self) -> None:
        # I1：整數 offset 與整數降採樣倍率
        for name, value in (
            ("crop_offset_ijk", self.crop_offset_ijk),
            ("downsample_factor", self.downsample_factor),
        ):
            require(len(value) == 3, "I1", f"{name} 必須是三個元素", **{name: value})
            require(
                all(isinstance(v, int) and not isinstance(v, bool) for v in value),
                "I1",
                f"{name} 必須是整數 voxel（測試後端 chaos: fractional_offset）",
                **{name: value},
            )
        require(
            all(v >= 0 for v in self.crop_offset_ijk),
            "I1",
            "crop_offset_ijk 不得為負",
            crop_offset_ijk=self.crop_offset_ijk,
        )
        require(
            all(v >= 1 for v in self.downsample_factor),
            "I1",
            "downsample_factor 每軸必須 >= 1（1 = 不降採樣）",
            downsample_factor=self.downsample_factor,
        )
        require(
            self.grid.same_frame_as(self.source_grid),
            "I5",
            "display grid 與 source grid 必須同一個 Frame of Reference",
            display=self.grid.frame_of_reference_uid,
            source=self.source_grid.frame_of_reference_uid,
        )
        # 使用者可調 WW/WL 的 layer 一律 int16；
        # uint8 + window_baked 只用於 window 固定的用途（3D 體積渲染）。
        if self.dtype == "uint8":
            require(
                self.window_baked is not None,
                "D1",
                "dtype=uint8 時 window_baked 必填（否則畫面上的灰階無法反推 HU）",
            )
        else:
            require(
                self.window_baked is None,
                "D2",
                "dtype=int16 不得帶 window_baked——烘焙過的 window 會讓 WW/WL 無法自由調整",
                window_baked=self.window_baked,
            )

    # ── 建構 ────────────────────────────────────────────────────────────────

    @classmethod
    def derive(
        cls,
        source_grid: Grid,
        *,
        crop_offset_ijk: Int3 = (0, 0, 0),
        crop_size_ijk: Int3 | None = None,
        downsample_factor: Int3 = (1, 1, 1),
        dtype: DisplayDType = "int16",
        window_baked: tuple[float, float] | None = None,
    ) -> DisplayGrid:
        """由取像網格導出 display grid。

        🔴 **origin 的算法是這個檔案裡最容易寫錯、也最難查的一行。**
        降採樣 f 倍時，輸出體素 0 涵蓋輸入體素 `[0, f-1]`，其**中心**落在輸入
        索引 `(f-1)/2`。origin 若直接取輸入體素 0 的世界座標，整個影像會偏移
        `(f-1)/2 * spacing`，症狀是「看起來像分割不準、其實是次體素偏移」。
        """
        crop = tuple(int(v) for v in crop_offset_ijk)
        factor = tuple(int(v) for v in downsample_factor)
        require(len(crop) == 3 and len(factor) == 3, "I1", "crop/downsample 必須是三個元素")

        if crop_size_ijk is None:
            crop_size = tuple(int(source_grid.size[i] - crop[i]) for i in range(3))
        else:
            crop_size = tuple(int(v) for v in crop_size_ijk)
        require(
            all(crop[i] + crop_size[i] <= source_grid.size[i] for i in range(3)),
            "I1",
            "裁切範圍超出取像網格",
            crop_offset_ijk=crop,
            crop_size_ijk=crop_size,
            source_size=source_grid.size,
        )
        out_size = tuple(crop_size[i] // factor[i] for i in range(3))
        require(
            all(n >= 1 for n in out_size),
            "I1",
            "降採樣後的 size 至少為 1（裁切範圍太小或倍率太大）",
            crop_size_ijk=crop_size,
            downsample_factor=factor,
        )
        offset_center = [crop[i] + (factor[i] - 1) / 2.0 for i in range(3)]
        origin = source_grid.index_to_world(offset_center)
        grid = Grid(
            size=out_size,  # type: ignore[arg-type]
            spacing=tuple(source_grid.spacing[i] * factor[i] for i in range(3)),  # type: ignore[arg-type]
            origin=tuple(float(v) for v in origin),  # type: ignore[arg-type]
            direction=source_grid.direction,
            frame_of_reference_uid=source_grid.frame_of_reference_uid,
        )
        identity = {
            "grid": grid.to_wire(),
            "source_grid": source_grid.to_wire(),
            "crop_offset_ijk": list(crop),
            "downsample_factor": list(factor),
            "dtype": dtype,
            "window_baked": list(window_baked) if window_baked else None,
        }
        return cls(
            grid=grid,
            source_grid=source_grid,
            crop_offset_ijk=crop,  # type: ignore[arg-type]
            downsample_factor=factor,  # type: ignore[arg-type]
            dtype=dtype,
            window_baked=window_baked,
            display_grid_id=digest(identity, prefix="dg_"),
        )

    # ── 導出量 ──────────────────────────────────────────────────────────────

    @property
    def bytes_per_voxel(self) -> int:
        return 1 if self.dtype == "uint8" else 2

    @property
    def resident_bytes(self) -> int:
        """單一序列在此網格下的體素位元組數（不含 float32 上傳翻倍）。"""
        return self.grid.voxel_count * self.bytes_per_voxel

    @property
    def is_downsampled(self) -> bool:
        return any(f != 1 for f in self.downsample_factor)

    def source_index_of(self, display_ijk: Any) -> np.ndarray:
        """display grid 索引 → 取像網格索引（僅供除錯與驗證，不用於編輯）。"""
        d = np.atleast_2d(np.asarray(display_ijk, dtype=np.float64))
        f = np.asarray(self.downsample_factor, dtype=np.float64)
        o = np.asarray(self.crop_offset_ijk, dtype=np.float64)
        out = d * f + o + (f - 1.0) / 2.0
        return out[0] if np.ndim(display_ijk) == 1 else out

    def to_wire(self) -> dict[str, Any]:
        return {
            "grid": self.grid.to_wire(),
            "source_grid": self.source_grid.to_wire(),
            "crop_offset_ijk": list(self.crop_offset_ijk),
            "downsample_factor": list(self.downsample_factor),
            "dtype": self.dtype,
            "window_baked": list(self.window_baked) if self.window_baked else None,
            "display_grid_id": self.display_grid_id,
        }

    @classmethod
    def from_wire(cls, d: dict[str, Any]) -> DisplayGrid:
        wb = d.get("window_baked")
        return cls(
            grid=Grid.from_wire(d["grid"]),
            source_grid=Grid.from_wire(d["source_grid"]),
            crop_offset_ijk=_int3(d["crop_offset_ijk"], "crop_offset_ijk"),
            downsample_factor=_int3(d["downsample_factor"], "downsample_factor"),
            dtype=d["dtype"],
            window_baked=(float(wb[0]), float(wb[1])) if wb else None,
            display_grid_id=str(d["display_grid_id"]),
        )


@dataclass(frozen=True)
class MaskGrid:
    """mask 與 mesh 的座標系。**恆等於取像網格，不裁切、不降採樣**。"""

    grid: Grid
    mask_grid_id: str

    @classmethod
    def of(cls, source_grid: Grid) -> MaskGrid:
        return cls(
            grid=source_grid,
            mask_grid_id=digest({"grid": source_grid.to_wire()}, prefix="mg_"),
        )

    @property
    def full_resolution_bytes(self) -> int:
        """全網格 uint8 mask 的大小。**這正是為何 mask 一律裁切到 bbox**。"""
        return self.grid.voxel_count

    def to_wire(self) -> dict[str, Any]:
        return {"grid": self.grid.to_wire(), "mask_grid_id": self.mask_grid_id}

    @classmethod
    def from_wire(cls, d: dict[str, Any]) -> MaskGrid:
        return cls(grid=Grid.from_wire(d["grid"]), mask_grid_id=str(d["mask_grid_id"]))


@dataclass(frozen=True)
class GridSet:
    """`POST /studies/{id}/grids` 的回傳。

    🔴 **回傳兩個網格，不是一個。** `mask_grid` 是前端唯一能取得 `mask_grid_id`
    的地方——沒有它，兩個網格的解耦在 API 層無法落實。
    """

    display_grid: DisplayGrid
    mask_grid: MaskGrid
    """primary FoR 的 `MaskGrid`（舊呼叫端仍以此為唯一的 mask grid）。"""
    frame_groups: tuple[FrameGroup, ...]
    temporal_groups: tuple[TemporalGroup, ...]
    assigned_tier: Tier
    mask_grids: tuple[MaskGrid, ...] = ()
    """**每個 FrameGroup 一個** `MaskGrid`。

    空的話視為只有 `(mask_grid,)`——單序列 session 與舊 wire 不必改。
    次要 FoR 的結構光柵化在自己的取像網格上；`FrameGroup.mask_grid_id` 指向
    這裡的其中一個。
    """

    def __post_init__(self) -> None:
        if not self.mask_grids:
            object.__setattr__(self, "mask_grids", (self.mask_grid,))
        by_id = {mg.mask_grid_id: mg for mg in self.mask_grids}
        require(
            self.mask_grid.mask_grid_id in by_id,
            "I5",
            "GridSet.mask_grid（primary）必須也在 mask_grids 裡",
            mask_grid=self.mask_grid.mask_grid_id,
            mask_grids=sorted(by_id),
        )
        for fg in self.frame_groups:
            if fg.mask_grid_id is not None:
                require(
                    fg.mask_grid_id in by_id,
                    "I5",
                    "FrameGroup.mask_grid_id 指向不存在的 MaskGrid",
                    frame_group=fg.frame_of_reference_uid,
                    mask_grid_id=fg.mask_grid_id,
                    known=sorted(by_id),
                )
                require(
                    by_id[fg.mask_grid_id].grid.frame_of_reference_uid == fg.frame_of_reference_uid,
                    "I5",
                    "FrameGroup 的 MaskGrid 必須落在同一個 Frame of Reference",
                    frame_group=fg.frame_of_reference_uid,
                    mask_grid_for=by_id[fg.mask_grid_id].grid.frame_of_reference_uid,
                )
        # I5：兩個網格必須源自同一個 source_grid 與同一個 FoR
        require(
            self.display_grid.source_grid.to_wire() == self.mask_grid.grid.to_wire(),
            "I5",
            "display_grid.source_grid 與 mask_grid.grid 必須是同一個取像網格",
            display_source=self.display_grid.source_grid.to_wire(),
            mask=self.mask_grid.grid.to_wire(),
        )
        primaries = [fg for fg in self.frame_groups if fg.role == "primary"]
        require(
            len(primaries) == 1,
            "F1",
            "必須恰好有一個 primary FrameGroup",
            count=len(primaries),
        )
        require(
            primaries[0].frame_of_reference_uid == self.display_grid.grid.frame_of_reference_uid,
            "F2",
            "display grid 必須落在 primary FrameGroup 的 Frame of Reference 上",
            primary=primaries[0].frame_of_reference_uid,
            grid=self.display_grid.grid.frame_of_reference_uid,
        )
        ids = [tg.temporal_group_id for tg in self.temporal_groups]
        require(len(ids) == len(set(ids)), "T1", "temporal_group_id 必須唯一", ids=ids)

    @property
    def primary(self) -> FrameGroup:
        return next(fg for fg in self.frame_groups if fg.role == "primary")

    def frame_group(self, frame_of_reference_uid: str) -> FrameGroup:
        for fg in self.frame_groups:
            if fg.frame_of_reference_uid == frame_of_reference_uid:
                return fg
        raise KeyError(f"沒有這個 FrameGroup: {frame_of_reference_uid}")

    def temporal_group(self, temporal_group_id: str) -> TemporalGroup:
        for tg in self.temporal_groups:
            if tg.temporal_group_id == temporal_group_id:
                return tg
        raise KeyError(f"沒有這個 TemporalGroup: {temporal_group_id}")

    def mask_grid_for(self, frame_of_reference_uid: str) -> MaskGrid:
        """某個 FoR 的結構所在的 `MaskGrid`。

        FrameGroup 沒宣告 `mask_grid_id` 時（單序列、舊 wire）退回 primary 的。
        """
        fg = self.frame_group(frame_of_reference_uid)
        if fg.mask_grid_id is None:
            require(
                fg.role == "primary",
                "I5",
                "次要 FrameGroup 沒有 mask_grid_id，卻被要求它的 MaskGrid",
                frame_group=frame_of_reference_uid,
            )
            return self.mask_grid
        return next(mg for mg in self.mask_grids if mg.mask_grid_id == fg.mask_grid_id)

    def to_wire(self) -> dict[str, Any]:
        return {
            "display_grid": self.display_grid.to_wire(),
            "mask_grid": self.mask_grid.to_wire(),
            "mask_grids": [mg.to_wire() for mg in self.mask_grids],
            "frame_groups": [fg.to_wire() for fg in self.frame_groups],
            "temporal_groups": [tg.to_wire() for tg in self.temporal_groups],
            "assigned_tier": self.assigned_tier,
        }

    @classmethod
    def from_wire(cls, d: dict[str, Any]) -> GridSet:
        return cls(
            display_grid=DisplayGrid.from_wire(d["display_grid"]),
            mask_grid=MaskGrid.from_wire(d["mask_grid"]),
            frame_groups=tuple(FrameGroup.from_wire(x) for x in d["frame_groups"]),
            temporal_groups=tuple(TemporalGroup.from_wire(x) for x in d["temporal_groups"]),
            assigned_tier=d["assigned_tier"],
            mask_grids=tuple(MaskGrid.from_wire(x) for x in d.get("mask_grids") or ()),
        )


def _int3(value: Any, name: str) -> Int3:
    """把 wire 上的三元組轉成整數，**非整數即拒絕**（I1，chaos: fractional_offset）。"""
    require(
        isinstance(value, (list, tuple)) and len(value) == 3,
        "I1",
        f"{name} 必須是三個元素",
        **{name: value},
    )
    out = []
    for v in value:
        require(
            isinstance(v, int) and not isinstance(v, bool) or (isinstance(v, float) and v.is_integer()),
            "I1",
            f"{name} 必須是整數 voxel，收到非整數",
            **{name: value},
        )
        out.append(int(v))
    return (out[0], out[1], out[2])
