"""`TemporalGroup` —— 時間／相位軸。

> **時間軸不是第七個型態，而是 F1–F6 任何一個都可以帶的屬性。**
> 因此 `temporal_group_id` / `frame_index` 是所有 payload 型態共通的欄位。

**規則**：網格與 FoR 相同的序列 → 物件上的一個軸；網格或 FoR 不同的
取像 → 各自獨立的 FrameGroup，以配準關聯。每週 CBCT 不是時間軸。

⚠️ **後端模型刻意不含 `cursor` 與 `playback`。** 游標與播放狀態
是前端狀態，不需端點。前端的 `TemporalGroup` 介面才有那兩個欄位。
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Literal

from .errors import require

TemporalKind = Literal["cyclic", "series", "stream"]
"""
* `cyclic` — T1 週期相位軸：閉環、等分、跨相位插值有意義（4DCT、4D-MRI、心臟相位）
* `series` — T2 不規則時間序列 ／ T4 參數軸：單調（DCE、灌流、b 值、echo time）
* `stream` — T3 串流：長度無上限，只有視窗常駐（MR-Linac cine）
"""


@dataclass(frozen=True)
class TemporalGroup:
    temporal_group_id: str
    kind: TemporalKind
    frame_count: int | None
    frame_times: tuple[float, ...] | None = None
    """T2/T3 的實際時間戳（秒）。T1 等分相位可為 None。"""
    axis_label: str = "time"
    """T4 參數軸用（"b_value" / "echo_time" / "gradient_direction"）。

    另有 "phase"／"amplitude"（4DCT 的相位或振幅分箱）。"""
    frame_labels: tuple[str, ...] | None = None
    """每一幀給人看的名字（「40%」「In 75%」「b 500」「TE 4.8 ms」）；None ＝ 只顯示序號。"""
    unit: str | None = None
    """參數軸的單位（"ms"、"s/mm²"）。"""

    def __post_init__(self) -> None:
        require(bool(self.temporal_group_id), "T2", "temporal_group_id 必填")
        if self.kind == "stream":
            require(
                self.frame_count is None,
                "T3",
                "kind=stream 的 frame_count 必須為 None（長度無上限，只有視窗常駐）",
                frame_count=self.frame_count,
            )
        else:
            require(
                isinstance(self.frame_count, int) and self.frame_count >= 1,
                "T3",
                "kind=cyclic/series 必須有 frame_count >= 1",
                frame_count=self.frame_count,
            )
        if self.frame_times is not None and self.frame_count is not None:
            require(
                len(self.frame_times) == self.frame_count,
                "T4",
                "frame_times 長度必須等於 frame_count",
                times=len(self.frame_times),
                frame_count=self.frame_count,
            )
        if self.frame_labels is not None and self.frame_count is not None:
            require(
                len(self.frame_labels) == self.frame_count,
                "T4",
                "frame_labels 長度必須等於 frame_count",
                labels=len(self.frame_labels),
                frame_count=self.frame_count,
            )
        if self.frame_times is not None and self.kind in ("series", "stream"):
            require(
                all(b > a for a, b in zip(self.frame_times, self.frame_times[1:], strict=False)),
                "T5",
                "series/stream 的 frame_times 必須嚴格單調遞增",
            )

    def validate_frame_index(self, frame_index: int | None) -> None:
        require(
            frame_index is not None,
            "T6",
            "屬於 TemporalGroup 的物件必須指定 frame_index",
            temporal_group_id=self.temporal_group_id,
        )
        assert frame_index is not None
        require(frame_index >= 0, "T6", "frame_index 不得為負", frame_index=frame_index)
        if self.frame_count is not None:
            require(
                frame_index < self.frame_count,
                "T6",
                "frame_index 超出 frame_count",
                frame_index=frame_index,
                frame_count=self.frame_count,
            )

    def to_wire(self) -> dict[str, Any]:
        return {
            "temporal_group_id": self.temporal_group_id,
            "kind": self.kind,
            "frame_count": self.frame_count,
            "frame_times": list(self.frame_times) if self.frame_times else None,
            "axis_label": self.axis_label,
            "frame_labels": list(self.frame_labels) if self.frame_labels else None,
            "unit": self.unit,
        }

    @classmethod
    def from_wire(cls, d: dict[str, Any]) -> TemporalGroup:
        ft = d.get("frame_times")
        return cls(
            temporal_group_id=str(d["temporal_group_id"]),
            kind=d["kind"],
            frame_count=None if d.get("frame_count") is None else int(d["frame_count"]),
            frame_times=tuple(float(v) for v in ft) if ft else None,
            axis_label=str(d.get("axis_label", "time")),
            frame_labels=tuple(str(v) for v in d["frame_labels"]) if d.get("frame_labels") else None,
            unit=str(d["unit"]) if d.get("unit") else None,
        )
