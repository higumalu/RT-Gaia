"""通用描述子、mask 裁切、以及「接得住 DVF」這件事。"""

from __future__ import annotations

import numpy as np
import pytest
from rtgaia_geom import (
    ContractViolation,
    Grid,
    MaskGrid,
    MaskPayload,
    Provenance,
    ViewReference,
    VoxelPayloadDescriptor,
    crop_to_bbox,
    paste_bbox,
)


def _prov() -> Provenance:
    return Provenance(source="model", module_version="test-1.0")


def test_descriptor_accepts_dvf() -> None:
    """描述子現在就必須容得下 float32 三通道，即使目前還不用。"""
    d = VoxelPayloadDescriptor(
        grid_ref="mg_x",
        frame_of_reference_uid="f",
        offset_ijk=(0, 0, 0),
        size_ijk=(4, 4, 4),
        dtype="float32",
        components=3,
        semantics="dvf_mm",
        content_hash="h",
    )
    assert d.expected_bytes == 4 * 4 * 4 * 3 * 4
    assert d.numpy_shape == (4, 4, 4, 3)


def test_descriptor_accepts_dose() -> None:
    d = VoxelPayloadDescriptor(
        grid_ref="mg_x",
        frame_of_reference_uid="f",
        offset_ijk=(0, 0, 0),
        size_ijk=(2, 2, 2),
        dtype="float32",
        components=1,
        semantics="dose_gy",
        content_hash="h",
    )
    assert d.expected_bytes == 32


def test_descriptor_requires_grid_ref() -> None:
    """I2 —— 每個 payload 都必須帶所屬網格的 id。"""
    with pytest.raises(ContractViolation) as e:
        VoxelPayloadDescriptor(
            grid_ref="",
            frame_of_reference_uid="f",
            offset_ijk=(0, 0, 0),
            size_ijk=(1, 1, 1),
            dtype="uint8",
            components=1,
            semantics="binary_mask",
            content_hash="h",
        )
    assert e.value.code == "I2"


def test_decode_rejects_truncated_body() -> None:
    """chaos: `truncate` —— 偵測並報錯，**不得渲染半張影像**。"""
    d = VoxelPayloadDescriptor(
        grid_ref="g",
        frame_of_reference_uid="f",
        offset_ijk=(0, 0, 0),
        size_ijk=(4, 4, 4),
        dtype="uint8",
        components=1,
        semantics="binary_mask",
        content_hash="h",
    )
    with pytest.raises(ContractViolation) as e:
        d.decode(b"\x00" * 63)
    assert e.value.code == "I9"


def test_decode_rejects_wrong_size() -> None:
    """chaos: `wrong_size` —— size_ijk 與實際資料量不符。"""
    d = VoxelPayloadDescriptor(
        grid_ref="g",
        frame_of_reference_uid="f",
        offset_ijk=(0, 0, 0),
        size_ijk=(4, 4, 4),
        dtype="uint8",
        components=1,
        semantics="binary_mask",
        content_hash="h",
    )
    with pytest.raises(ContractViolation) as e:
        d.decode(b"\x00" * 128)
    assert e.value.code == "I9"


def test_temporal_fields_are_paired() -> None:
    with pytest.raises(ContractViolation) as e:
        VoxelPayloadDescriptor(
            grid_ref="g",
            frame_of_reference_uid="f",
            offset_ijk=(0, 0, 0),
            size_ijk=(1, 1, 1),
            dtype="uint8",
            components=1,
            semantics="binary_mask",
            content_hash="h",
            temporal_group_id="tg",
            frame_index=None,
        )
    assert e.value.code == "T7"


def test_crop_to_bbox_roundtrip() -> None:
    vol = np.zeros((8, 6, 4), dtype=np.uint8)  # (k, j, i)
    vol[2:5, 1:4, 1:3] = 1
    offset, size, block = crop_to_bbox(vol)
    assert offset == (1, 1, 2)  # (i, j, k)
    assert size == (2, 3, 3)
    assert block is not None
    assert np.array_equal(paste_bbox(vol.shape, offset, block), vol)


def test_crop_to_bbox_empty() -> None:
    offset, size, block = crop_to_bbox(np.zeros((4, 4, 4), dtype=np.uint8))
    assert block is None


def test_mask_payload_key_is_binary_tuple(axial_grid: Grid) -> None:
    """鍵實質是二元組，`temporal_group_id` 由結構決定。"""
    vol = np.zeros((20, 64, 64), dtype=np.uint8)
    vol[5:8, 10:20, 10:20] = 1
    mg = MaskGrid.of(axial_grid)
    p = MaskPayload.from_dense(
        structure_id="GTV",
        mask_grid_id=mg.mask_grid_id,
        frame_of_reference_uid=axial_grid.frame_of_reference_uid,
        volume=vol,
        provenance=_prov(),
        temporal_group_id="4dct",
        frame_index=3,
    )
    assert p is not None
    assert p.key == ("GTV", 3)


def test_mask_payload_is_cropped_to_bbox(axial_grid: Grid) -> None:
    """**一律裁切到自己的 bounding box**。全網格在 182 結構下要 14 GB。"""
    vol = np.zeros((20, 64, 64), dtype=np.uint8)
    vol[5:8, 10:20, 10:20] = 1
    mg = MaskGrid.of(axial_grid)
    p = MaskPayload.from_dense(
        structure_id="GTV",
        mask_grid_id=mg.mask_grid_id,
        frame_of_reference_uid=axial_grid.frame_of_reference_uid,
        volume=vol,
        provenance=_prov(),
    )
    assert p is not None
    assert p.size_ijk == (10, 10, 3)
    assert len(p.data) == 300
    assert p.voxel_count_set == 300
    assert np.isclose(p.volume_cc(axial_grid.voxel_volume_mm3), 300 * 3.0 / 1000.0)


def test_mask_payload_carries_mask_grid_id_not_display(axial_grid: Grid) -> None:
    """🔴 mask 帶的是 `mask_grid_id`。"""
    mg = MaskGrid.of(axial_grid)
    vol = np.zeros((20, 64, 64), dtype=np.uint8)
    vol[0, 0, 0] = 1
    p = MaskPayload.from_dense(
        structure_id="s",
        mask_grid_id=mg.mask_grid_id,
        frame_of_reference_uid=axial_grid.frame_of_reference_uid,
        volume=vol,
        provenance=_prov(),
    )
    assert p is not None
    assert p.descriptor.grid_ref == mg.mask_grid_id
    assert p.descriptor.grid_ref.startswith("mg_")


def test_user_edit_requires_view_reference(axial_grid: Grid) -> None:
    """source=user-edit 時 view_reference 必填。"""
    with pytest.raises(ContractViolation) as e:
        Provenance(source="user-edit", module_version="v", parent_hash="h")
    assert e.value.code == "P3"


def test_user_edit_with_view_reference_ok(axial_grid: Grid) -> None:
    vr = ViewReference.axial(
        frame_of_reference_uid=axial_grid.frame_of_reference_uid,
        display_grid_id="dg_x",
        plane_origin=(0.0, 0.0, 0.0),
    )
    p = Provenance(source="user-edit", module_version="v", parent_hash="h", view_reference=vr)
    assert Provenance.from_wire(p.to_wire()).view_reference == vr


def test_derived_requires_parent_hash() -> None:
    with pytest.raises(ContractViolation) as e:
        Provenance(source="post-process", module_version="v")
    assert e.value.code == "P4"


def test_content_hash_distinguishes_pure_translation(axial_grid: Grid) -> None:
    """🔴 **裁切後純平移的兩份 mask 位元組相同，hash 必須不同。**

    這個缺陷是前端 e2e 抓到的：4D 假體相位 0 與相位 5 的 GTV 是同一顆球差
    2 個 voxel，裁切到 bbox 後**位元組完全一致**，於是 `content_hash` 相同。

    後果不只是「兩個相位長得一樣」——`content_hash` 是樂觀更新的衝突判準
    與前端的快取鍵，位置不進 hash 就代表快取可能回傳位置
    錯的 mask，而 `base_content_hash` 比對會放過基於不同位置的編輯。
    """
    mg = MaskGrid.of(axial_grid)
    shape = (axial_grid.size[2], axial_grid.size[1], axial_grid.size[0])

    def payload_at(k0: int) -> MaskPayload:
        vol = np.zeros(shape, dtype=np.uint8)
        vol[k0 : k0 + 3, 10:20, 10:20] = 1
        p = MaskPayload.from_dense(
            structure_id="GTV",
            mask_grid_id=mg.mask_grid_id,
            frame_of_reference_uid=axial_grid.frame_of_reference_uid,
            volume=vol,
            provenance=_prov(),
        )
        assert p is not None
        return p

    a = payload_at(5)
    b = payload_at(9)
    # 裁切後的體素**完全相同** —— 這正是問題所在
    assert a.data == b.data
    assert a.size_ijk == b.size_ijk
    assert a.offset_ijk != b.offset_ijk
    # 但 hash 必須不同
    assert a.content_hash != b.content_hash


def test_content_hash_is_stable_for_identical_payloads(axial_grid: Grid) -> None:
    """同樣的內容 ＋ 同樣的位置 → 同樣的 hash（否則快取永遠失效）。"""
    mg = MaskGrid.of(axial_grid)
    shape = (axial_grid.size[2], axial_grid.size[1], axial_grid.size[0])
    vol = np.zeros(shape, dtype=np.uint8)
    vol[5:8, 10:20, 10:20] = 1
    hashes = set()
    for _ in range(3):
        p = MaskPayload.from_dense(
            structure_id="GTV",
            mask_grid_id=mg.mask_grid_id,
            frame_of_reference_uid=axial_grid.frame_of_reference_uid,
            volume=vol,
            provenance=_prov(),
        )
        assert p is not None
        hashes.add(p.content_hash)
    assert len(hashes) == 1


def test_payload_content_hash_covers_size_as_well_as_offset() -> None:
    """同一個 offset、同樣的位元組，但 size 不同 → hash 必須不同。

    `1×4×1` 與 `4×1×1` 的區塊都是 4 個位元組，內容也可以相同。
    """
    from rtgaia_geom import payload_content_hash

    data = b"\x01\x01\x01\x01"
    a = payload_content_hash(offset_ijk=(0, 0, 0), size_ijk=(1, 4, 1), data=data, prefix="mh_")
    b = payload_content_hash(offset_ijk=(0, 0, 0), size_ijk=(4, 1, 1), data=data, prefix="mh_")
    assert a != b
