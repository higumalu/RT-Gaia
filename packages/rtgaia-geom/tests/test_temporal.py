"""時間軸是核心空間定義的一部分，且與型態正交。"""

from __future__ import annotations

import pytest
from rtgaia_geom import ContractViolation
from rtgaia_geom.temporal import TemporalGroup


def test_cyclic_requires_frame_count() -> None:
    with pytest.raises(ContractViolation) as e:
        TemporalGroup(temporal_group_id="tg1", kind="cyclic", frame_count=None)
    assert e.value.code == "T3"


def test_stream_forbids_frame_count() -> None:
    """T3 串流長度無上限，只有視窗常駐。"""
    with pytest.raises(ContractViolation) as e:
        TemporalGroup(temporal_group_id="tg1", kind="stream", frame_count=960)
    assert e.value.code == "T3"
    assert TemporalGroup(temporal_group_id="tg1", kind="stream", frame_count=None)


def test_series_times_must_be_monotonic() -> None:
    """DCE 的時間戳可以不等間隔，但必須單調。"""
    with pytest.raises(ContractViolation) as e:
        TemporalGroup(temporal_group_id="dce", kind="series", frame_count=3, frame_times=(0.0, 5.0, 2.0))
    assert e.value.code == "T5"


def test_frame_index_bounds() -> None:
    tg = TemporalGroup(temporal_group_id="4dct", kind="cyclic", frame_count=10)
    tg.validate_frame_index(0)
    tg.validate_frame_index(9)
    with pytest.raises(ContractViolation) as e:
        tg.validate_frame_index(10)
    assert e.value.code == "T6"
    with pytest.raises(ContractViolation) as e2:
        tg.validate_frame_index(None)
    assert e2.value.code == "T6"


def test_backend_model_has_no_cursor() -> None:
    """游標與播放狀態是**前端狀態**，後端模型刻意不含它們。"""
    tg = TemporalGroup(temporal_group_id="tg", kind="cyclic", frame_count=4)
    assert "cursor" not in tg.to_wire()
    assert "playback" not in tg.to_wire()


def test_parameter_axis_uses_series_kind() -> None:
    """T4 參數軸（b 值）結構同 T2，以 axis_label 區分。"""
    tg = TemporalGroup(
        temporal_group_id="dwi",
        kind="series",
        frame_count=4,
        frame_times=(0.0, 50.0, 400.0, 1000.0),
        axis_label="b_value",
    )
    assert TemporalGroup.from_wire(tg.to_wire()) == tg
