"""RT-Gaia 共用幾何核心。

> 🔴 **不要為測試後端另寫一份幾何邏輯**。
> 若測試後端對契約較寬鬆，前端會被建構在寬鬆的假設上，接正式後端時整批壞掉。

這個套件就是「單一 3D ＋ 時間空間」的具體型別定義：

* `Grid` —— 幾何的唯一表示，座標慣例恆為 LPS
* `DisplayGrid`／`MaskGrid`／`GridSet`
* `FrameGroup` —— 影像與其結構的綁定單位
* `TemporalGroup` —— 時間軸屬於核心空間定義，不是之後才擴充
* `VoxelPayloadDescriptor` —— 帶 `components`／`semantics`，容得下劑量與 DVF
* `MaskPayload`／`MeshPayload`
* `ViewReference`／`Provenance`
* `invariants`（I1–I5）／`codec`（wire 格式）
"""

from __future__ import annotations

from .codec import CONTENT_TYPE, decode, encode
from .display_grid import DisplayGrid, GridSet, MaskGrid, Tier
from .errors import ContractViolation, require
from .frame_group import IDENTITY_16, FrameGroup, RegistrationInfo, rigid_matrix
from .grid import IDENTITY_DIRECTION, Grid
from .hashing import digest, digest_bytes, payload_content_hash, stable_json
from .invariants import (
    InvalidationTracker,
    assert_cross_family_compatible,
    assert_round_trip,
    assert_same_family,
)
from .payload import (
    MaskPayload,
    MeshPayload,
    VoxelPayloadDescriptor,
    crop_to_bbox,
    paste_bbox,
)
from .provenance import Provenance, ViewReference

__version__ = "0.1.0"
"""→ `Provenance.module_version`。追溯鏈的其中一節。"""

__all__ = [
    "CONTENT_TYPE",
    "IDENTITY_16",
    "IDENTITY_DIRECTION",
    "ContractViolation",
    "DisplayGrid",
    "FrameGroup",
    "Grid",
    "GridSet",
    "InvalidationTracker",
    "MaskGrid",
    "MaskPayload",
    "MeshPayload",
    "Provenance",
    "RegistrationInfo",
    "Tier",
    "ViewReference",
    "VoxelPayloadDescriptor",
    "__version__",
    "assert_cross_family_compatible",
    "assert_round_trip",
    "assert_same_family",
    "crop_to_bbox",
    "decode",
    "digest",
    "digest_bytes",
    "encode",
    "paste_bbox",
    "payload_content_hash",
    "require",
    "rigid_matrix",
    "stable_json",
]
