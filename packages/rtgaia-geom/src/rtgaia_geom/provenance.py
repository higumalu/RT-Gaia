"""`ViewReference` 與 `Provenance`。

**wire 慣例（全案唯一一條）**：後端 JSON 一律 snake_case，前端型別一律
camelCase，轉換只發生在 `core/transport/` 這一層。
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import Any, Literal

import numpy as np

from .errors import require

PLANE_TOL = 1e-6


@dataclass(frozen=True)
class ViewReference:
    """平面的完整描述。

    🔴 **任何編輯紀錄、書籤、量測都必須存 `ViewReference`，不得存 slice index。**
    斜面沒有 slice index；這一條同時是斜面功能的需求與法規追溯的前置——要能
    重現「當時在哪個平面看到什麼」。
    """

    frame_of_reference_uid: str
    display_grid_id: str
    plane_origin: tuple[float, float, float]
    view_plane_normal: tuple[float, float, float]
    view_up: tuple[float, float, float]
    slab_thickness_mm: float
    temporal_group_id: str | None = None
    frame_index: int | None = None

    def __post_init__(self) -> None:
        require(bool(self.frame_of_reference_uid), "V1", "frame_of_reference_uid 必填")
        n = np.asarray(self.view_plane_normal, dtype=np.float64)
        u = np.asarray(self.view_up, dtype=np.float64)
        require(
            abs(float(np.linalg.norm(n)) - 1.0) <= 1e-4,
            "V2",
            "view_plane_normal 必須是單位向量",
            norm=float(np.linalg.norm(n)),
        )
        require(
            abs(float(np.linalg.norm(u)) - 1.0) <= 1e-4,
            "V2",
            "view_up 必須是單位向量",
            norm=float(np.linalg.norm(u)),
        )
        require(
            abs(float(np.dot(n, u))) <= 1e-4,
            "V3",
            "view_up 必須與 view_plane_normal 正交",
            dot=float(np.dot(n, u)),
        )
        require(
            self.slab_thickness_mm >= 0.0,
            "V4",
            "slab_thickness_mm 不得為負",
            slab=self.slab_thickness_mm,
        )
        require(
            (self.temporal_group_id is None) == (self.frame_index is None),
            "V5",
            "temporal_group_id 與 frame_index 必須同時有或同時無",
            temporal_group_id=self.temporal_group_id,
            frame_index=self.frame_index,
        )

    # ── 平面基底 ────────────────────────────────────────────────────────────

    @property
    def normal(self) -> np.ndarray:
        return np.asarray(self.view_plane_normal, dtype=np.float64)

    @property
    def up(self) -> np.ndarray:
        return np.asarray(self.view_up, dtype=np.float64)

    @property
    def right(self) -> np.ndarray:
        """平面上的橫軸。右手系：right = up × normal。"""
        return np.cross(self.up, self.normal)

    @property
    def origin(self) -> np.ndarray:
        return np.asarray(self.plane_origin, dtype=np.float64)

    def signed_distance(self, world: Any) -> np.ndarray:
        pts = np.atleast_2d(np.asarray(world, dtype=np.float64))
        out = (pts - self.origin) @ self.normal
        return out[0] if np.ndim(world) == 1 else out

    def is_coplanar_with(self, other: ViewReference, *, angle_tol_deg: float = 1.0, offset_tol_mm: float = 0.5) -> bool:
        """共面才允許編輯平面型量測。"""
        cos = abs(float(np.dot(self.normal, other.normal)))
        if cos < np.cos(np.deg2rad(angle_tol_deg)):
            return False
        return abs(float(self.signed_distance(other.origin))) <= offset_tol_mm

    @classmethod
    def axial(
        cls,
        *,
        frame_of_reference_uid: str,
        display_grid_id: str,
        plane_origin: tuple[float, float, float],
        slab_thickness_mm: float = 0.0,
        temporal_group_id: str | None = None,
        frame_index: int | None = None,
    ) -> ViewReference:
        """放射科慣例的軸向平面：**從病人腳側往頭看**。

        因此 `view_plane_normal = -z`（法線指向觀察者，觀察者在 I 側）、
        `view_up = -y`（畫面上 = A）。由此得到 `right = up × normal = +x`
        —— 病人左在畫面右，也就是**病人右在畫面左**。

        🔴 先前寫的是 `+z`（從頭頂往下看，神經科慣例），左右整格鏡像。
        這裡與 `apps/viewer/src/core/scene/cameras.ts` 的 `ORIENTATIONS`
        **必須一致**：兩邊都會建 axial 相機，分岔的症狀是前後端對同一個
        `ViewReference` 算出鏡像的畫面，而各自看起來都正常。
        """
        return cls(
            frame_of_reference_uid=frame_of_reference_uid,
            display_grid_id=display_grid_id,
            plane_origin=plane_origin,
            view_plane_normal=(0.0, 0.0, -1.0),
            view_up=(0.0, -1.0, 0.0),
            slab_thickness_mm=slab_thickness_mm,
            temporal_group_id=temporal_group_id,
            frame_index=frame_index,
        )

    def to_wire(self) -> dict[str, Any]:
        return {
            "frame_of_reference_uid": self.frame_of_reference_uid,
            "display_grid_id": self.display_grid_id,
            "plane_origin": list(self.plane_origin),
            "view_plane_normal": list(self.view_plane_normal),
            "view_up": list(self.view_up),
            "slab_thickness_mm": self.slab_thickness_mm,
            "temporal_group_id": self.temporal_group_id,
            "frame_index": self.frame_index,
        }

    @classmethod
    def from_wire(cls, d: dict[str, Any]) -> ViewReference:
        return cls(
            frame_of_reference_uid=str(d["frame_of_reference_uid"]),
            display_grid_id=str(d.get("display_grid_id", "")),
            plane_origin=tuple(float(v) for v in d["plane_origin"]),  # type: ignore[arg-type]
            view_plane_normal=tuple(float(v) for v in d["view_plane_normal"]),  # type: ignore[arg-type]
            view_up=tuple(float(v) for v in d["view_up"]),  # type: ignore[arg-type]
            slab_thickness_mm=float(d.get("slab_thickness_mm", 0.0)),
            temporal_group_id=d.get("temporal_group_id"),
            frame_index=None if d.get("frame_index") is None else int(d["frame_index"]),
        )


ProvenanceSource = Literal["model", "user-edit", "post-process", "import"]


@dataclass(frozen=True)
class Provenance:
    """追溯欄位。

    法規送件不在目前範圍，但**現在留下這些欄位幾乎零成本，事後補則需要資料遷移**。
    `module_version` 的來源是 `ModuleManifest.version`，追溯鏈因此閉合。
    """

    source: ProvenanceSource
    module_version: str
    parent_hash: str | None = None
    view_reference: ViewReference | None = None
    created_at: str = field(default_factory=lambda: datetime.now(UTC).isoformat())

    def __post_init__(self) -> None:
        require(
            self.source in ("model", "user-edit", "post-process", "import"),
            "P1",
            "provenance.source 不在允許值內",
            source=self.source,
        )
        require(bool(self.module_version), "P2", "module_version 必填")
        if self.source == "user-edit":
            require(
                self.view_reference is not None,
                "P3",
                "source=user-edit 時 view_reference 必填——要能回答「在哪個平面編輯的」",
            )
        if self.source in ("user-edit", "post-process"):
            require(
                self.parent_hash is not None,
                "P4",
                "衍生物必須記錄 parent_hash",
                source=self.source,
            )

    def to_wire(self) -> dict[str, Any]:
        return {
            "source": self.source,
            "parent_hash": self.parent_hash,
            "module_version": self.module_version,
            "view_reference": self.view_reference.to_wire() if self.view_reference else None,
            "created_at": self.created_at,
        }

    @classmethod
    def from_wire(cls, d: dict[str, Any]) -> Provenance:
        vr = d.get("view_reference")
        return cls(
            source=d["source"],
            module_version=str(d["module_version"]),
            parent_hash=d.get("parent_hash"),
            view_reference=ViewReference.from_wire(vr) if vr else None,
            created_at=str(d.get("created_at") or datetime.now(UTC).isoformat()),
        )
