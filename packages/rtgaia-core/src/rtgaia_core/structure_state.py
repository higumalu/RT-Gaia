"""結構的狀態與版本鏈 —— 從 `state.py` 搬出來，按職責建立可理解的邊界。

`StructureState`（一個結構在病例裡的可變狀態，`block` 永遠等於 head 那一版）、`StructureVersion`（不可變的一版）、
`ConflictError`（→ HTTP 409）。`state.py` 原樣再匯出，舊的 `from .state import StructureState` 都還能用。
"""

from __future__ import annotations

import uuid
from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import Any, Literal

import numpy as np
from rtgaia_geom import MaskGrid, MaskPayload, Provenance
from rtgaia_geom.grid import Grid, Int3
from rtgaia_geom.hashing import payload_content_hash

from .dataset import StructureStatus

MODULE_VERSION = "testbe-0.1.0"
"""→ `Provenance.module_version`。"""

StructureKey = tuple[str, int | None]
"""mask 的鍵是二元組；`temporal_group_id` 由結構決定。"""


VersionKind = Literal["initial", "edit", "post-process", "copy", "revert", "inject", "merge"]

MAX_VERSIONS_IN_MEMORY = 200
"""每個結構在記憶體裡最多留幾版（頭尾不丟：第一版與 head 永遠在）。持久化後這個上限移除。"""


@dataclass(frozen=True)
class StructureVersion:
    """結構的一個版本。**每一次被後端接受的變更就是一版**；append-only。

    `Provenance.parent_hash` 以前指向一個已被覆寫的東西；現在每個 hash 都對應到一個留著體素的版本 ——
    「這條輪廓改之前長什麼樣、誰在哪個平面改的」有答案了。
    """

    version_id: str
    parent_version_id: str | None
    kind: VersionKind
    content_hash: str
    offset_ijk: Int3
    size_ijk: Int3
    block: np.ndarray
    provenance: Provenance
    created_by: str
    created_at: str
    client_id: str | None = None
    client_seq: int | None = None
    note: str = ""
    seq: int = 0
    """這個結構的第幾版：第一版 0，之後每版加一，記憶體列表修剪掉的號碼也不重用。存成 `structure_version.seq`，
    載入時依它排序。以前用的是記憶體列表裡的位置 —— 列表滿 200 版後新版一律記成 199，重新載入時舊版可能排到最後。"""

    @property
    def voxel_count(self) -> int:
        return int(np.count_nonzero(self.block))

    def to_wire(self) -> dict[str, Any]:
        return {
            "version_id": self.version_id,
            "parent_version_id": self.parent_version_id,
            "kind": self.kind,
            "content_hash": self.content_hash,
            "offset_ijk": list(self.offset_ijk),
            "size_ijk": list(self.size_ijk),
            "voxel_count": self.voxel_count,
            "provenance": self.provenance.to_wire(),
            "created_by": self.created_by,
            "created_at": self.created_at,
            "client_id": self.client_id,
            "client_seq": self.client_seq,
            "note": self.note,
        }


def _now_iso() -> str:
    return datetime.now(UTC).isoformat(timespec="seconds")


@dataclass
class StructureState:
    """一個結構在 Case 中的可變狀態。`versions` 是它的歷史；`block`／`content_hash` 永遠等於 head 那一版。"""

    structure_id: str
    name: str
    color_rgb: tuple[int, int, int]
    frame_of_reference_uid: str
    offset_ijk: Int3
    size_ijk: Int3
    block: np.ndarray
    """`(k, j, i)` uint8，**已裁切到 bbox**。"""
    content_hash: str
    provenance: Provenance
    status: StructureStatus = "ai_generated"
    tg263_code: str | None = None
    interpreted_type: str | None = None
    """RTROIInterpretedType（來源 RTSTRUCT 的；匯出時 profile 用它，沒有才依名字推）。"""
    default_visible: bool = True
    temporal_group_id: str | None = None
    frame_index: int | None = None
    structure_set_id: str | None = None
    """屬於哪一套結構集（`Case.structure_sets`）；None ＝ 沒有來源 RS（假體、或未指定的新建）。"""
    versions: list[StructureVersion] = field(default_factory=list)
    created_by: str = "anonymous"
    updated_by: str = "anonymous"
    updated_at: str = field(default_factory=_now_iso)

    def __post_init__(self) -> None:
        # 第一版：建構時的內容（匯入／模型／新建）。沒有它，第一筆編輯的 parent_hash 就指向空氣。
        if not self.versions:
            self.versions.append(
                StructureVersion(
                    version_id=f"v_{uuid.uuid4().hex[:10]}",
                    parent_version_id=None,
                    kind="initial",
                    content_hash=self.content_hash,
                    offset_ijk=self.offset_ijk,
                    size_ijk=self.size_ijk,
                    block=np.ascontiguousarray(self.block, dtype=np.uint8).copy(),
                    provenance=self.provenance,
                    created_by=self.created_by,
                    created_at=self.updated_at,
                )
            )

    @property
    def key(self) -> StructureKey:
        return (self.structure_id, self.frame_index)

    @property
    def head(self) -> StructureVersion:
        return self.versions[-1]

    def version(self, version_id: str) -> StructureVersion:
        for v in self.versions:
            if v.version_id == version_id:
                return v
        raise KeyError(f"結構 {self.structure_id} 沒有版本 {version_id}")

    def version_by_hash(self, content_hash: str) -> StructureVersion | None:
        return next((v for v in reversed(self.versions) if v.content_hash == content_hash), None)

    def _record_version(
        self, *, kind: VersionKind, user: str, client_id: str | None, client_seq: int | None, note: str
    ) -> StructureVersion:
        v = StructureVersion(
            version_id=f"v_{uuid.uuid4().hex[:10]}",
            parent_version_id=self.head.version_id if self.versions else None,
            kind=kind,
            content_hash=self.content_hash,
            offset_ijk=self.offset_ijk,
            size_ijk=self.size_ijk,
            block=self.block.copy(),
            provenance=self.provenance,
            created_by=user,
            created_at=_now_iso(),
            client_id=client_id,
            client_seq=client_seq,
            note=note,
            seq=max(x.seq for x in self.versions) + 1 if self.versions else 0,
        )
        self.versions.append(v)
        self.updated_by = user
        self.updated_at = v.created_at
        # 記憶體上限：丟中間最舊的，第一版與 head 永遠留著
        while len(self.versions) > MAX_VERSIONS_IN_MEMORY:
            del self.versions[1]
        return v

    def revert_to(self, version_id: str, *, user: str, note: str = "") -> StructureVersion:
        """回到某一版 —— **也是新的一版**（`kind='revert'`），不是刪歷史。"""
        target = self.version(version_id)
        parent = self.content_hash
        self.offset_ijk, self.size_ijk = target.offset_ijk, target.size_ijk
        self.block = target.block.copy()
        self.content_hash = target.content_hash
        # Provenance 的 source 仍在契約的四種之內；「這是 revert」記在版本的 kind 與 module_version
        self.provenance = Provenance(
            source="post-process",
            module_version=f"{MODULE_VERSION}+revert:{version_id}",
            parent_hash=parent,
        )
        self.status = "edited"
        return self._record_version(
            kind="revert", user=user, client_id=None, client_seq=None, note=note or f"回到 {version_id}"
        )

    @property
    def voxel_count(self) -> int:
        return int(np.count_nonzero(self.block))

    def volume_cc(self, grid: Grid) -> float:
        return self.voxel_count * grid.voxel_volume_mm3 / 1000.0

    def payload(self, mask_grid: MaskGrid) -> MaskPayload:
        return MaskPayload(
            structure_id=self.structure_id,
            mask_grid_id=mask_grid.mask_grid_id,
            frame_of_reference_uid=self.frame_of_reference_uid,
            offset_ijk=self.offset_ijk,
            size_ijk=self.size_ijk,
            data=np.ascontiguousarray(self.block, dtype=np.uint8).tobytes(),
            content_hash=self.content_hash,
            provenance=self.provenance,
            temporal_group_id=self.temporal_group_id,
            frame_index=self.frame_index,
        )

    def dense(self, grid: Grid) -> np.ndarray:
        out = np.zeros((grid.size[2], grid.size[1], grid.size[0]), dtype=np.uint8)
        o, s = self.offset_ijk, self.size_ijk
        out[o[2] : o[2] + s[2], o[1] : o[1] + s[1], o[0] : o[0] + s[0]] = self.block
        return out

    def replace_dense(
        self,
        volume: np.ndarray,
        provenance: Provenance,
        *,
        kind: VersionKind = "edit",
        user: str = "anonymous",
        client_id: str | None = None,
        client_seq: int | None = None,
        note: str = "",
    ) -> StructureVersion:
        """換掉整個體素內容並**記一版**。回傳新版本。"""
        from rtgaia_geom import crop_to_bbox

        offset, size, block = crop_to_bbox(volume)
        if block is None:
            offset, size, block = (0, 0, 0), (1, 1, 1), np.zeros((1, 1, 1), dtype=np.uint8)
        self.offset_ijk, self.size_ijk = offset, size
        self.block = np.ascontiguousarray(block, dtype=np.uint8)
        # 🔴 位置進 hash：mask 裁切到 bbox 之後，純平移的兩份體素完全相同
        self.content_hash = payload_content_hash(
            offset_ijk=self.offset_ijk,
            size_ijk=self.size_ijk,
            data=self.block.tobytes(),
            prefix="mh_",
        )
        self.provenance = provenance
        return self._record_version(kind=kind, user=user, client_id=client_id, client_seq=client_seq, note=note)


class ConflictError(Exception):
    """→ HTTP 409。"""

    def __init__(self, message: str, *, content_hash: str, reason: str) -> None:
        super().__init__(message)
        self.content_hash = content_hash
        self.reason = reason
