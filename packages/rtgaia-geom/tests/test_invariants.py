"""I3／I4 —— 同族比 id、跨族比世界座標、兩個 id 各自獨立失效。"""

from __future__ import annotations

import pytest
from rtgaia_geom import (
    ContractViolation,
    DisplayGrid,
    Grid,
    InvalidationTracker,
    MaskGrid,
    assert_cross_family_compatible,
    assert_same_family,
)


def test_same_family_mismatch_is_rejected() -> None:
    """chaos: `grid_mismatch` —— 拒絕合成並明確報錯，不得嘗試自動對齊。"""
    with pytest.raises(ContractViolation) as e:
        assert_same_family(payload_grid_ref="dg_aaa", session_grid_id="dg_bbb", family="display")
    assert e.value.code == "I3"


def test_same_family_match_passes() -> None:
    assert_same_family(payload_grid_ref="dg_a", session_grid_id="dg_a", family="display")


def test_cross_family_uses_world_not_ids(axial_grid: Grid) -> None:
    """🔴 跨族（影像 vs mask）比對的是 FoR 與世界座標，**不是網格 id**。

    Tier B 降採樣影像時 `display_grid_id` 必然與 `mask_grid_id` 不同——若跨族
    也比 id，融合會在降採樣時整批誤判失敗。
    """
    dg = DisplayGrid.derive(axial_grid, downsample_factor=(2, 2, 2))
    mg = MaskGrid.of(axial_grid)
    assert dg.display_grid_id != mg.mask_grid_id
    assert_cross_family_compatible(dg, mg)  # 不得拋出


def test_cross_family_rejects_different_frame(axial_grid: Grid) -> None:
    other = Grid(
        size=axial_grid.size,
        spacing=axial_grid.spacing,
        origin=axial_grid.origin,
        direction=axial_grid.direction,
        frame_of_reference_uid="different.for",
    )
    with pytest.raises(ContractViolation) as e:
        assert_cross_family_compatible(DisplayGrid.derive(axial_grid), MaskGrid.of(other))
    assert e.value.code == "I3"


def test_cross_family_rejects_shifted_origin(axial_grid: Grid) -> None:
    shifted = Grid(
        size=axial_grid.size,
        spacing=axial_grid.spacing,
        origin=(axial_grid.origin[0] + 1.0, *axial_grid.origin[1:]),
        direction=axial_grid.direction,
        frame_of_reference_uid=axial_grid.frame_of_reference_uid,
    )
    with pytest.raises(ContractViolation) as e:
        assert_cross_family_compatible(DisplayGrid.derive(axial_grid), MaskGrid.of(shifted))
    assert e.value.code == "I3"


def test_i4_invalidation_is_independent() -> None:
    """I4 —— 兩個網格 id 各自獨立失效，**不連動**。"""
    t = InvalidationTracker(display_grid_id="dg_1", mask_grid_id="mg_1")
    assert t.update(display_grid_id="dg_2") == {"image"}
    assert t.update(mask_grid_id="mg_2") == {"mask", "mesh"}
    assert t.update(display_grid_id="dg_2", mask_grid_id="mg_2") == set()
