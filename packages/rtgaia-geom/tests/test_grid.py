"""`Grid` 是幾何的唯一表示，LPS 恆定，direction 不得省略。"""

from __future__ import annotations

import numpy as np
import pytest
from rtgaia_geom import IDENTITY_DIRECTION, ContractViolation, Grid, assert_round_trip


def test_roundtrip_identity(axial_grid: Grid) -> None:
    assert assert_round_trip(axial_grid) < 1e-9


def test_roundtrip_gantry_tilt(tilted_grid: Grid) -> None:
    """傾斜網格的 index↔world 必須同樣精確——這裡若過不了，斜面全錯。"""
    assert assert_round_trip(tilted_grid) < 1e-9


def test_roundtrip_oblique(oblique_grid: Grid) -> None:
    assert assert_round_trip(oblique_grid) < 1e-9


def test_origin_is_voxel_zero(axial_grid: Grid) -> None:
    assert np.allclose(axial_grid.index_to_world([0, 0, 0]), axial_grid.origin)


def test_spacing_applies_per_axis(axial_grid: Grid) -> None:
    step = axial_grid.index_to_world([0, 0, 1]) - axial_grid.index_to_world([0, 0, 0])
    assert np.allclose(np.linalg.norm(step), 3.0)


def test_tilt_moves_z_step_off_axis(tilted_grid: Grid) -> None:
    """傾斜 15° 時，沿 k 走一步在 LPS 的 y 分量必須非零。

    **這正是「漏傳 direction」的症狀所在**：若前端把 direction 當單位矩陣，
    這個分量會是 0，而畫面上只表現為結構整體歪掉一點點。
    """
    step = tilted_grid.index_to_world([0, 0, 1]) - tilted_grid.index_to_world([0, 0, 0])
    assert abs(step[1]) > 0.7  # 3 mm * sin(15°) ≈ 0.776
    assert np.isclose(np.linalg.norm(step), 3.0)


def test_from_wire_rejects_missing_direction(axial_grid: Grid) -> None:
    """chaos: `missing_direction` —— 拒絕載入，**不得預設為單位矩陣**。"""
    wire = axial_grid.to_wire()
    del wire["direction"]
    with pytest.raises(ContractViolation) as e:
        Grid.from_wire(wire)
    assert e.value.code == "G4"


def test_from_wire_rejects_null_direction(axial_grid: Grid) -> None:
    wire = axial_grid.to_wire()
    wire["direction"] = None
    with pytest.raises(ContractViolation) as e:
        Grid.from_wire(wire)
    assert e.value.code == "G4"


def test_rejects_spacing_baked_into_direction() -> None:
    """把 spacing 乘進 direction 是真實發生過的錯誤，正交性檢查要抓到它。"""
    scaled = tuple(v * 2.0 for v in IDENTITY_DIRECTION)
    with pytest.raises(ContractViolation) as e:
        Grid(
            size=(4, 4, 4),
            spacing=(1.0, 1.0, 1.0),
            origin=(0.0, 0.0, 0.0),
            direction=scaled,  # type: ignore[arg-type]
            frame_of_reference_uid="x",
        )
    assert e.value.code == "G5"


def test_accepts_left_handed_direction() -> None:
    """🔴 **左手系必須被接受。**

    舊版這裡斷言「拒絕 det < 0」，而那條限制是錯的：DICOM／ITK 從不保證右手系，
    切片沿 −z 排列在 HFS 掃描上是常態（Philips CT 就是這樣存）。結果是**真實
    臨床 CT 一載入就被拒絕**，而合成假體全是右手系，所以 200 多個測試沒有一個
    抓到 —— 只有真實資料抓到了。

    正交性（G5）已經保證 |det| = 1；det 的**正負號**是取像幾何的一部分。
    """
    mirrored = (-1.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0)
    grid = Grid(
        size=(4, 4, 4),
        spacing=(1.0, 1.0, 1.0),
        origin=(0.0, 0.0, 0.0),
        direction=mirrored,
        frame_of_reference_uid="x",
    )
    assert grid.handedness == -1
    assert assert_round_trip(grid) < 1e-9


def test_reports_handedness() -> None:
    """右手系回 +1、左手系回 -1。**mesh 的三角形繞向要據此補償。**"""
    right_handed = Grid(
        size=(4, 4, 4),
        spacing=(1.0, 1.0, 1.0),
        origin=(0.0, 0.0, 0.0),
        direction=IDENTITY_DIRECTION,
        frame_of_reference_uid="x",
    )
    assert right_handed.handedness == 1


def test_rejects_direction_with_wrong_determinant_magnitude() -> None:
    """|det| ≠ 1 一定伴隨非正交，因此 G5 會先擋下；G6 是第二道保險。"""
    scaled = tuple(v * 3.0 for v in IDENTITY_DIRECTION)
    with pytest.raises(ContractViolation) as e:
        Grid(
            size=(4, 4, 4),
            spacing=(1.0, 1.0, 1.0),
            origin=(0.0, 0.0, 0.0),
            direction=scaled,  # type: ignore[arg-type]
            frame_of_reference_uid="x",
        )
    assert e.value.code in ("G5", "G6")


def test_rejects_float_size() -> None:
    with pytest.raises(ContractViolation) as e:
        Grid(
            size=(4.0, 4, 4),  # type: ignore[arg-type]
            spacing=(1.0, 1.0, 1.0),
            origin=(0.0, 0.0, 0.0),
            direction=IDENTITY_DIRECTION,
            frame_of_reference_uid="x",
        )
    assert e.value.code == "G1"


def test_requires_frame_of_reference() -> None:
    with pytest.raises(ContractViolation) as e:
        Grid(
            size=(4, 4, 4),
            spacing=(1.0, 1.0, 1.0),
            origin=(0.0, 0.0, 0.0),
            direction=IDENTITY_DIRECTION,
            frame_of_reference_uid="",
        )
    assert e.value.code == "G7"


def test_wire_roundtrip(oblique_grid: Grid) -> None:
    assert Grid.from_wire(oblique_grid.to_wire()) == oblique_grid


def test_voxel_volume(axial_grid: Grid) -> None:
    assert np.isclose(axial_grid.voxel_volume_mm3, 3.0)
