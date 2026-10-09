"""FrameGroup 是變換的作用對象，不是單一 layer。"""

from __future__ import annotations

import numpy as np
import pytest
from rtgaia_geom import ContractViolation, FrameGroup, rigid_matrix
from rtgaia_geom.frame_group import IDENTITY_16


def test_primary_is_identity() -> None:
    fg = FrameGroup.primary_of("for.primary", "s1")
    assert np.allclose(fg.matrix, np.eye(4))
    assert fg.transform_kind == "identity"


def test_primary_rejects_non_identity() -> None:
    m = rigid_matrix(translation_mm=(1, 0, 0))
    with pytest.raises(ContractViolation) as e:
        FrameGroup(
            frame_of_reference_uid="for.primary",
            series_id="s1",
            role="primary",
            transform_to_primary=tuple(m.flatten(order="F").tolist()),
            transform_kind="rigid",
        )
    assert e.value.code == "F5"


def test_wire_is_column_major() -> None:
    """wire 上是 column-major。translation 落在第 13–15 個元素。"""
    m = rigid_matrix(translation_mm=(10.0, -5.0, 2.5))
    fg = FrameGroup.secondary_rigid("for.secondary", "s2", m)
    assert fg.transform_to_primary[12:15] == (10.0, -5.0, 2.5)
    assert np.allclose(fg.matrix, m)


def test_rejects_row_major_by_mistake() -> None:
    """誤傳 row-major 時最後一列不是 [0,0,0,1]，必須被抓到。"""
    m = rigid_matrix(translation_mm=(10.0, -5.0, 2.5))
    with pytest.raises(ContractViolation) as e:
        FrameGroup(
            frame_of_reference_uid="for.secondary",
            series_id="s2",
            role="secondary",
            transform_to_primary=tuple(m.flatten().tolist()),  # row-major，錯的
            transform_kind="rigid",
        )
    assert e.value.code == "F4"


def test_rigid_rejects_scaling() -> None:
    m = np.eye(4)
    m[:3, :3] *= 1.5
    with pytest.raises(ContractViolation) as e:
        FrameGroup(
            frame_of_reference_uid="f",
            series_id="s",
            role="secondary",
            transform_to_primary=tuple(m.flatten(order="F").tolist()),
            transform_kind="rigid",
        )
    assert e.value.code == "F7"


def test_resampled_requires_coverage_mask() -> None:
    """否則重採樣後的空白區域看起來會像解剖結構的一部分。"""
    with pytest.raises(ContractViolation) as e:
        FrameGroup(
            frame_of_reference_uid="f",
            series_id="s",
            role="secondary",
            transform_to_primary=IDENTITY_16,
            transform_kind="resampled",
        )
    assert e.value.code == "F9"


def test_round_trip_world_transform() -> None:
    """座標轉換鏈第二段：primary 世界座標 ↔ 序列自身世界座標。"""
    m = rigid_matrix(translation_mm=(12.0, -3.0, 7.5), rotation_deg=(0, 0, 8))
    fg = FrameGroup.secondary_rigid("for.secondary", "s2", m)
    pts = np.array([[0.0, 0.0, 0.0], [10.0, 20.0, -30.0]])
    back = fg.from_primary_world(fg.to_primary_world(pts))
    assert np.allclose(back, pts, atol=1e-9)


def test_known_translation_is_exact() -> None:
    """two_series 假體的真值矩陣要能被精確還原。"""
    m = rigid_matrix(translation_mm=(15.0, -8.0, 4.0))
    fg = FrameGroup.secondary_rigid("for.secondary", "s2", m)
    moved = fg.to_primary_world([0.0, 0.0, 0.0])
    assert np.allclose(moved, [15.0, -8.0, 4.0])


def test_identity_matrix_becomes_identity_kind() -> None:
    fg = FrameGroup.secondary_rigid("f", "s", np.eye(4))
    assert fg.transform_kind == "identity"


def test_wire_roundtrip() -> None:
    fg = FrameGroup.secondary_rigid("f", "s", rigid_matrix(rotation_deg=(3, 4, 5)))
    assert FrameGroup.from_wire(fg.to_wire()) == fg


# ── 每個 FrameGroup 一個 MaskGrid ＋ 對位來源 ─────────────────────


def test_registration_info_round_trips_and_is_optional() -> None:
    """`registration` 說的是矩陣**從哪裡來**；舊 wire 沒有它也要能讀。"""
    from rtgaia_geom import RegistrationInfo

    info = RegistrationInfo(source="REG", sop_instance_uid="1.2.3", matrix_type="RIGID")
    fg = FrameGroup.secondary_rigid(
        "for.b",
        "cbct",
        rigid_matrix(translation_mm=(-15.3, -178.6, -31.4)),
        mask_grid_id="mg_b",
        registration=info,
    )
    wire = fg.to_wire()
    assert wire["mask_grid_id"] == "mg_b"
    assert wire["registration"]["source"] == "REG"
    assert FrameGroup.from_wire(wire) == fg

    legacy = {k: v for k, v in wire.items() if k not in ("mask_grid_id", "registration")}
    old = FrameGroup.from_wire(legacy)
    assert old.mask_grid_id is None and old.registration is None
