"""兩個網格、不變式 I1／I4／I5、MaskGrid 不裁切。"""

from __future__ import annotations

import numpy as np
import pytest
from rtgaia_geom import (
    ContractViolation,
    DisplayGrid,
    FrameGroup,
    Grid,
    GridSet,
    MaskGrid,
)
from rtgaia_geom.display_grid import _int3


def test_no_downsample_is_identical_geometry(axial_grid: Grid) -> None:
    dg = DisplayGrid.derive(axial_grid)
    assert dg.grid.size == axial_grid.size
    assert np.allclose(dg.grid.origin, axial_grid.origin)
    assert not dg.is_downsampled


def test_downsample_origin_is_box_center(axial_grid: Grid) -> None:
    """🔴 降採樣時 origin 必須落在被合併體素的**中心**，不是第一個體素。

    寫錯的症狀是整張影像偏移 (f-1)/2 * spacing —— 看起來像分割不準。
    """
    dg = DisplayGrid.derive(axial_grid, downsample_factor=(2, 2, 1))
    expected = axial_grid.index_to_world([0.5, 0.5, 0.0])
    assert np.allclose(dg.grid.origin, expected)
    assert dg.grid.spacing == (2.0, 2.0, 3.0)
    assert dg.grid.size == (32, 32, 20)


def test_downsample_preserves_world_extent_center(tilted_grid: Grid) -> None:
    """傾斜網格降採樣後，兩者的世界空間中心必須一致（誤差 < 半個輸出體素）。"""
    dg = DisplayGrid.derive(tilted_grid, downsample_factor=(2, 2, 2))
    src_center = tilted_grid.index_to_world([(n - 1) / 2 for n in tilted_grid.size])
    out_center = dg.grid.index_to_world([(n - 1) / 2 for n in dg.grid.size])
    assert np.linalg.norm(src_center - out_center) < max(dg.grid.spacing)


def test_crop_offset_is_applied(axial_grid: Grid) -> None:
    dg = DisplayGrid.derive(axial_grid, crop_offset_ijk=(4, 8, 2), crop_size_ijk=(16, 16, 10))
    assert np.allclose(dg.grid.origin, axial_grid.index_to_world([4, 8, 2]))
    assert dg.grid.size == (16, 16, 10)


def test_source_index_of_inverts_crop_and_downsample(axial_grid: Grid) -> None:
    dg = DisplayGrid.derive(axial_grid, crop_offset_ijk=(4, 4, 0), downsample_factor=(2, 2, 1))
    # display 索引 0 對應取像索引 4.5（體素 4 與 5 的中心）
    assert np.allclose(dg.source_index_of([0, 0, 0]), [4.5, 4.5, 0.0])
    # 且與世界座標一致
    assert np.allclose(
        dg.grid.index_to_world([3, 2, 5]),
        axial_grid.index_to_world(dg.source_index_of([3, 2, 5])),
    )


def test_i1_rejects_fractional_offset(axial_grid: Grid) -> None:
    """chaos: `fractional_offset` —— 拒絕載入（I1）。"""
    with pytest.raises(ContractViolation) as e:
        DisplayGrid(
            grid=axial_grid,
            source_grid=axial_grid,
            crop_offset_ijk=(0.5, 0, 0),  # type: ignore[arg-type]
            downsample_factor=(1, 1, 1),
            dtype="int16",
            window_baked=None,
            display_grid_id="dg_x",
        )
    assert e.value.code == "I1"


def test_i1_wire_rejects_fractional_offset() -> None:
    with pytest.raises(ContractViolation) as e:
        _int3([0.5, 1, 2], "offset_ijk")
    assert e.value.code == "I1"
    assert _int3([0.0, 1.0, 2.0], "offset_ijk") == (0, 1, 2)


def test_uint8_requires_window_baked(axial_grid: Grid) -> None:
    with pytest.raises(ContractViolation) as e:
        DisplayGrid.derive(axial_grid, dtype="uint8")
    assert e.value.code == "D1"


def test_int16_forbids_window_baked(axial_grid: Grid) -> None:
    """可調 WW/WL 的 layer 一律 int16，不得帶烘焙 window。"""
    with pytest.raises(ContractViolation) as e:
        DisplayGrid.derive(axial_grid, dtype="int16", window_baked=(40.0, 400.0))
    assert e.value.code == "D2"


def test_grid_id_changes_with_every_field(axial_grid: Grid) -> None:
    base = DisplayGrid.derive(axial_grid)
    variants = [
        DisplayGrid.derive(axial_grid, downsample_factor=(2, 1, 1)),
        DisplayGrid.derive(axial_grid, crop_offset_ijk=(1, 0, 0)),
        DisplayGrid.derive(axial_grid, dtype="uint8", window_baked=(40.0, 400.0)),
    ]
    ids = {base.display_grid_id, *(v.display_grid_id for v in variants)}
    assert len(ids) == 4


def test_grid_id_is_stable_across_runs(axial_grid: Grid) -> None:
    a = DisplayGrid.derive(axial_grid, downsample_factor=(2, 2, 1))
    b = DisplayGrid.derive(axial_grid, downsample_factor=(2, 2, 1))
    assert a.display_grid_id == b.display_grid_id


def test_mask_grid_is_always_acquisition_grid(tilted_grid: Grid) -> None:
    """`MaskGrid` 恆等於取像網格，**沒有裁切自由度**。"""
    mg = MaskGrid.of(tilted_grid)
    assert mg.grid == tilted_grid
    assert not hasattr(mg, "crop_offset_ijk")
    assert not hasattr(mg, "downsample_factor")


def test_mask_grid_id_independent_of_display_downsampling(axial_grid: Grid) -> None:
    """🔴 mask **不跟著影像降採樣**。降採樣影像不得改變 mask_grid_id。"""
    mg = MaskGrid.of(axial_grid)
    a = DisplayGrid.derive(axial_grid)
    b = DisplayGrid.derive(axial_grid, downsample_factor=(2, 2, 2))
    assert a.display_grid_id != b.display_grid_id
    assert MaskGrid.of(axial_grid).mask_grid_id == mg.mask_grid_id


def test_gridset_i5_requires_same_source(axial_grid: Grid, tilted_grid: Grid) -> None:
    with pytest.raises(ContractViolation) as e:
        GridSet(
            display_grid=DisplayGrid.derive(axial_grid),
            mask_grid=MaskGrid.of(tilted_grid),
            frame_groups=(FrameGroup.primary_of(axial_grid.frame_of_reference_uid, "s1"),),
            temporal_groups=(),
            assigned_tier="A",
        )
    assert e.value.code == "I5"


def test_gridset_requires_exactly_one_primary(axial_grid: Grid) -> None:
    with pytest.raises(ContractViolation) as e:
        GridSet(
            display_grid=DisplayGrid.derive(axial_grid),
            mask_grid=MaskGrid.of(axial_grid),
            frame_groups=(),
            temporal_groups=(),
            assigned_tier="A",
        )
    assert e.value.code == "F1"


def test_gridset_wire_roundtrip(axial_grid: Grid) -> None:
    gs = GridSet(
        display_grid=DisplayGrid.derive(axial_grid, downsample_factor=(2, 2, 1)),
        mask_grid=MaskGrid.of(axial_grid),
        frame_groups=(FrameGroup.primary_of(axial_grid.frame_of_reference_uid, "s1"),),
        temporal_groups=(),
        assigned_tier="B",
    )
    assert GridSet.from_wire(gs.to_wire()) == gs


# ── GridSet.mask_grids ─────────────────────────────────────────────


def test_grid_set_defaults_mask_grids_to_primary(axial_grid: Grid) -> None:
    """單序列與舊 wire 不必改：`mask_grids` 空 → 視為只有 primary 的那個。"""
    gs = GridSet(
        display_grid=DisplayGrid.derive(axial_grid),
        mask_grid=MaskGrid.of(axial_grid),
        frame_groups=(FrameGroup.primary_of(axial_grid.frame_of_reference_uid, "s1"),),
        temporal_groups=(),
        assigned_tier="A",
    )
    assert [mg.mask_grid_id for mg in gs.mask_grids] == [gs.mask_grid.mask_grid_id]
    assert gs.mask_grid_for(axial_grid.frame_of_reference_uid) is gs.mask_grid
    legacy = {k: v for k, v in gs.to_wire().items() if k != "mask_grids"}
    assert GridSet.from_wire(legacy).mask_grids == gs.mask_grids


def test_grid_set_resolves_secondary_mask_grid_by_frame_group(axial_grid: Grid, tilted_grid: Grid) -> None:
    """🔴 次要 FoR 的結構在**自己的**取像網格上，以 FrameGroup 找到它。"""
    secondary = Grid(
        size=(8, 8, 4),
        spacing=(2.0, 2.0, 3.0),
        origin=(0.0, 0.0, 0.0),
        direction=tilted_grid.direction,
        frame_of_reference_uid="for.secondary",
    )
    mg_p, mg_s = MaskGrid.of(axial_grid), MaskGrid.of(secondary)
    gs = GridSet(
        display_grid=DisplayGrid.derive(axial_grid),
        mask_grid=mg_p,
        frame_groups=(
            FrameGroup.primary_of(axial_grid.frame_of_reference_uid, "s1", mask_grid_id=mg_p.mask_grid_id),
            FrameGroup.secondary_rigid("for.secondary", "s2", np.eye(4), mask_grid_id=mg_s.mask_grid_id),
        ),
        temporal_groups=(),
        assigned_tier="C",
        mask_grids=(mg_p, mg_s),
    )
    assert gs.mask_grid_for("for.secondary").mask_grid_id == mg_s.mask_grid_id
    assert GridSet.from_wire(gs.to_wire()) == gs

    with pytest.raises(ContractViolation, match="I5"):
        GridSet(
            display_grid=DisplayGrid.derive(axial_grid),
            mask_grid=mg_p,
            frame_groups=(
                FrameGroup.primary_of(axial_grid.frame_of_reference_uid, "s1"),
                FrameGroup.secondary_rigid("for.secondary", "s2", np.eye(4), mask_grid_id="mg_missing"),
            ),
            temporal_groups=(),
            assigned_tier="C",
            mask_grids=(mg_p,),
        )
