"""`FrameGroup` —— 影像與其結構的綁定單位。

RT 的結構永遠綁定在一個 Frame of Reference 上。**當使用者調整某組影像的位置
時，屬於它的結構必須一起動。** 因此變換的作用對象不是單一 layer，而是整個
FrameGroup——分開套用是錯的，症狀是拖曳影像時輪廓留在原地。
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Literal

import numpy as np

from .errors import require

Role = Literal["primary", "secondary"]
TransformKind = Literal["identity", "rigid", "resampled"]
RegistrationSource = Literal["REG", "none", "manual", "phantom", "shared_frame"]
"""`shared_frame`：與 primary 同一個 FoR，本來就在同一個空間，無需對位。"""

IDENTITY_16: tuple[float, ...] = tuple(np.eye(4, dtype=np.float64).flatten(order="F").tolist())
"""4×4 單位矩陣，**column-major**（與前端的 `Float64Array(16)` 一致）。"""

RIGID_TOL = 1e-6


@dataclass(frozen=True)
class RegistrationInfo:
    """`transform_to_primary` 是**從哪裡來的**。

    這是「物件之間的對應關係」最小的落點：一個 REG 物件描述的
    正是 (moving FoR, fixed FoR) 這一對。不動 `Provenance`，也不進 hash——它只
    讓 UI 能說「這個對位來自 2026-06-17 的 Spatial Registration，RIGID」，以及讓
    「找不到 REG、暫以單位矩陣擺放」這件事在畫面上**看得見**而不是被默默當成
    已對位。
    """

    source: RegistrationSource
    sop_instance_uid: str | None = None
    matrix_type: str | None = None
    """DICOM `FrameOfReferenceTransformationMatrixType`（RIGID / RIGID_SCALE / AFFINE）。"""
    description: str | None = None

    def to_wire(self) -> dict[str, Any]:
        return {
            "source": self.source,
            "sop_instance_uid": self.sop_instance_uid,
            "matrix_type": self.matrix_type,
            "description": self.description,
        }

    @classmethod
    def from_wire(cls, d: dict[str, Any] | None) -> RegistrationInfo | None:
        if not d:
            return None
        return cls(
            source=d["source"],
            sop_instance_uid=d.get("sop_instance_uid"),
            matrix_type=d.get("matrix_type"),
            description=d.get("description"),
        )


@dataclass(frozen=True)
class FrameGroup:
    frame_of_reference_uid: str
    series_id: str
    role: Role
    transform_to_primary: tuple[float, ...]
    """從本 FoR 到 primary FoR 的變換。LPS，**column-major 4×4**。"""
    transform_kind: TransformKind
    coverage_mask_id: str | None = None
    mask_grid_id: str | None = None
    """這個 FoR 的結構所在的 `MaskGrid`（**每個 FrameGroup 一個**）。

    None 只允許出現在舊的單序列 wire 上，此時視為 `GridSet.mask_grid`。
    次要 FoR 的 RTSTRUCT 光柵化在**自己的**取像網格上，零重採樣、可編輯；
    前端取 mask 時以此 id 比對 I3，而不是拿 primary 的。
    """
    registration: RegistrationInfo | None = None

    def __post_init__(self) -> None:
        require(
            len(self.transform_to_primary) == 16,
            "F3",
            "transform_to_primary 必須是 16 個 float（column-major 4×4）",
            got=len(self.transform_to_primary),
        )
        m = self.matrix
        require(
            np.allclose(m[3, :], [0, 0, 0, 1], atol=RIGID_TOL),
            "F4",
            "transform_to_primary 的最後一列必須是 [0,0,0,1]（是否誤傳 row-major？）",
            last_row=m[3, :].tolist(),
        )
        if self.role == "primary":
            require(
                np.allclose(m, np.eye(4), atol=RIGID_TOL),
                "F5",
                "primary 的 transform_to_primary 恆為單位矩陣，且不得被使用者調整",
                matrix=m.tolist(),
            )
            require(
                self.transform_kind == "identity",
                "F5",
                "primary 的 transform_kind 必須是 identity",
                transform_kind=self.transform_kind,
            )
        if self.transform_kind == "identity":
            require(
                np.allclose(m, np.eye(4), atol=RIGID_TOL),
                "F6",
                "transform_kind=identity 與非單位矩陣矛盾",
                matrix=m.tolist(),
            )
        if self.transform_kind == "rigid":
            r = m[:3, :3]
            require(
                np.allclose(r.T @ r, np.eye(3), atol=RIGID_TOL),
                "F7",
                "transform_kind=rigid 的旋轉部分必須正交（不得含縮放或剪切）",
                residual=float(np.abs(r.T @ r - np.eye(3)).max()),
            )
            require(
                float(np.linalg.det(r)) > 0,
                "F7",
                "rigid 變換不得含鏡射（det 必須 > 0）",
                det=float(np.linalg.det(r)),
            )
        if self.transform_kind == "resampled":
            # 已重採樣到 primary 的 display grid，因此矩陣為單位，
            # 但必須給出有效資料範圍，否則空白區域看起來像解剖結構的一部分。
            require(
                np.allclose(m, np.eye(4), atol=RIGID_TOL),
                "F8",
                "transform_kind=resampled 時矩陣應為單位（資料已在 primary 網格上）",
                matrix=m.tolist(),
            )
            require(
                bool(self.coverage_mask_id),
                "F9",
                "transform_kind=resampled 必須提供 coverage_mask_id",
            )

    # ── 矩陣 ────────────────────────────────────────────────────────────────

    @property
    def matrix(self) -> np.ndarray:
        """4×4，row-major 的 numpy 視角（wire 上是 column-major）。"""
        return np.asarray(self.transform_to_primary, dtype=np.float64).reshape(4, 4, order="F")

    @property
    def inverse_matrix(self) -> np.ndarray:
        return np.linalg.inv(self.matrix)

    def to_primary_world(self, world: Any) -> np.ndarray:
        """本序列自身的世界座標 → primary 世界座標。"""
        return _apply(self.matrix, world)

    def from_primary_world(self, world: Any) -> np.ndarray:
        """primary 世界座標 → 本序列自身的世界座標。

        🔴 這是座標轉換鏈的第二段。**只有在編輯非 primary 序列的
        結構時才會非單位矩陣**；漏了的症狀是「在融合畫面上對第二組影像的結構
        下筆，筆刷落在偏移的位置」。
        """
        return _apply(self.inverse_matrix, world)

    @classmethod
    def primary_of(
        cls,
        frame_of_reference_uid: str,
        series_id: str,
        *,
        mask_grid_id: str | None = None,
    ) -> FrameGroup:
        return cls(
            frame_of_reference_uid=frame_of_reference_uid,
            series_id=series_id,
            role="primary",
            transform_to_primary=IDENTITY_16,
            transform_kind="identity",
            mask_grid_id=mask_grid_id,
        )

    @classmethod
    def secondary_rigid(
        cls,
        frame_of_reference_uid: str,
        series_id: str,
        matrix_row_major: Any,
        *,
        mask_grid_id: str | None = None,
        registration: RegistrationInfo | None = None,
    ) -> FrameGroup:
        m = np.asarray(matrix_row_major, dtype=np.float64).reshape(4, 4)
        kind: TransformKind = "identity" if np.allclose(m, np.eye(4), atol=RIGID_TOL) else "rigid"
        return cls(
            frame_of_reference_uid=frame_of_reference_uid,
            series_id=series_id,
            role="secondary",
            transform_to_primary=tuple(m.flatten(order="F").tolist()),
            transform_kind=kind,
            mask_grid_id=mask_grid_id,
            registration=registration,
        )

    def to_wire(self) -> dict[str, Any]:
        return {
            "frame_of_reference_uid": self.frame_of_reference_uid,
            "series_id": self.series_id,
            "role": self.role,
            "transform_to_primary": list(self.transform_to_primary),
            "transform_kind": self.transform_kind,
            "coverage_mask_id": self.coverage_mask_id,
            "mask_grid_id": self.mask_grid_id,
            "registration": self.registration.to_wire() if self.registration else None,
        }

    @classmethod
    def from_wire(cls, d: dict[str, Any]) -> FrameGroup:
        return cls(
            frame_of_reference_uid=str(d["frame_of_reference_uid"]),
            series_id=str(d["series_id"]),
            role=d["role"],
            transform_to_primary=tuple(float(v) for v in d["transform_to_primary"]),
            transform_kind=d["transform_kind"],
            coverage_mask_id=d.get("coverage_mask_id"),
            mask_grid_id=d.get("mask_grid_id"),
            registration=RegistrationInfo.from_wire(d.get("registration")),
        )


def _apply(m: np.ndarray, world: Any) -> np.ndarray:
    pts = np.atleast_2d(np.asarray(world, dtype=np.float64))
    out = pts @ m[:3, :3].T + m[:3, 3]
    return out[0] if np.ndim(world) == 1 else out


def rigid_matrix(
    *,
    translation_mm: Any = (0.0, 0.0, 0.0),
    rotation_deg: Any = (0.0, 0.0, 0.0),
) -> np.ndarray:
    """建立 row-major 4×4 剛性矩陣（旋轉順序 Rz @ Ry @ Rx，繞 LPS 軸）。"""
    rx, ry, rz = (np.deg2rad(float(v)) for v in rotation_deg)
    cx, sx, cy, sy, cz, sz = np.cos(rx), np.sin(rx), np.cos(ry), np.sin(ry), np.cos(rz), np.sin(rz)
    mx = np.array([[1, 0, 0], [0, cx, -sx], [0, sx, cx]], dtype=np.float64)
    my = np.array([[cy, 0, sy], [0, 1, 0], [-sy, 0, cy]], dtype=np.float64)
    mz = np.array([[cz, -sz, 0], [sz, cz, 0], [0, 0, 1]], dtype=np.float64)
    m = np.eye(4, dtype=np.float64)
    m[:3, :3] = mz @ my @ mx
    m[:3, 3] = np.asarray(translation_mm, dtype=np.float64)
    return m
