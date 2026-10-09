"""體素 payload 描述子與其特化。

`VoxelPayloadDescriptor` 是通用描述子，帶 `components` 與 `semantics`，
因此**現在就容得下劑量（float32×1）與 DVF（float32×3）**，即使目前還不用。
`MaskPayload` 只是它的特化（uint8 / 1 通道 / binary_mask）。
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Literal

import numpy as np

from .errors import require
from .grid import Int3
from .hashing import payload_content_hash
from .provenance import Provenance

PayloadDType = Literal["uint8", "int16", "float32"]
Encoding = Literal["raw", "zstd"]

DTYPE_SIZE: dict[str, int] = {"uint8": 1, "int16": 2, "float32": 4}
NUMPY_DTYPE: dict[str, Any] = {"uint8": np.uint8, "int16": np.int16, "float32": np.float32}


@dataclass(frozen=True)
class VoxelPayloadDescriptor:
    """任何規則網格上的場（型態 F1）在 wire 上的描述。"""

    grid_ref: str
    """`display_grid_id`（影像）或 `mask_grid_id`（mask / mesh / 未來的劑量與 DVF）。"""
    frame_of_reference_uid: str
    offset_ijk: Int3
    size_ijk: Int3
    dtype: PayloadDType
    components: int
    """1 = 純量；3 = 向量（DVF）。**寫死單通道就接不住 DVF**。"""
    semantics: str
    """"image" | "binary_mask" | "dose_gy" | "dvf_mm" | ...（開放字串，不是 enum）。"""
    content_hash: str
    temporal_group_id: str | None = None
    frame_index: int | None = None

    def __post_init__(self) -> None:
        require(bool(self.grid_ref), "I2", "每個 payload 都必須帶所屬網格的 id")
        require(bool(self.frame_of_reference_uid), "P1", "payload 必須宣告 frame_of_reference_uid")
        for name, value in (("offset_ijk", self.offset_ijk), ("size_ijk", self.size_ijk)):
            require(len(value) == 3, "I1", f"{name} 必須是三個元素", **{name: value})
            require(
                all(isinstance(v, int) and not isinstance(v, bool) for v in value),
                "I1",
                f"{name} 必須是整數（chaos: fractional_offset）",
                **{name: value},
            )
        require(all(v >= 0 for v in self.offset_ijk), "I1", "offset_ijk 不得為負")
        require(all(v >= 1 for v in self.size_ijk), "I1", "size_ijk 每軸必須為正")
        require(self.dtype in DTYPE_SIZE, "I6", "未知的 dtype", dtype=self.dtype)
        require(self.components >= 1, "I7", "components 必須 >= 1", components=self.components)
        require(bool(self.semantics), "I8", "semantics 必填")
        require(
            (self.temporal_group_id is None) == (self.frame_index is None),
            "T7",
            "temporal_group_id 與 frame_index 必須同時有或同時無",
            temporal_group_id=self.temporal_group_id,
            frame_index=self.frame_index,
        )

    @property
    def voxel_count(self) -> int:
        return int(self.size_ijk[0]) * int(self.size_ijk[1]) * int(self.size_ijk[2])

    @property
    def expected_bytes(self) -> int:
        """解壓後應有的位元組數。**`truncate` 與 `wrong_size` 兩個 chaos 模式都靠它抓。**"""
        return self.voxel_count * self.components * DTYPE_SIZE[self.dtype]

    @property
    def numpy_shape(self) -> tuple[int, ...]:
        """`(k, j, i)`（＋通道）。**x 變化最快**，因此 numpy 是 z-major。"""
        base = (int(self.size_ijk[2]), int(self.size_ijk[1]), int(self.size_ijk[0]))
        return base if self.components == 1 else (*base, self.components)

    def decode(self, raw: bytes) -> np.ndarray:
        require(
            len(raw) == self.expected_bytes,
            "I9",
            "payload 長度與 header 宣告不符（chaos: truncate / wrong_size）——不得渲染半張影像",
            declared=self.expected_bytes,
            actual=len(raw),
        )
        return np.frombuffer(raw, dtype=NUMPY_DTYPE[self.dtype]).reshape(self.numpy_shape)

    def to_wire(self) -> dict[str, Any]:
        return {
            "grid_ref": self.grid_ref,
            "frame_of_reference_uid": self.frame_of_reference_uid,
            "offset_ijk": list(self.offset_ijk),
            "size_ijk": list(self.size_ijk),
            "dtype": self.dtype,
            "components": self.components,
            "semantics": self.semantics,
            "content_hash": self.content_hash,
            "temporal_group_id": self.temporal_group_id,
            "frame_index": self.frame_index,
        }


@dataclass(frozen=True)
class MaskPayload:
    """結構的傳輸格式。

    * **每個結構一份二值 mask（0/1），不使用多標籤 volume。** RT 結構本質會重疊
      （BODY 含全部、GTV ⊂ CTV ⊂ PTV），單一標籤無法表示。
    * **一律裁切到自己的 bounding box。** 全網格 mask 在 182 個結構下需要 14 GB。
    * `mask_grid_id` 🔴 **是 MaskGrid 不是 DisplayGrid**。

    > mask 的鍵實質是**二元組** `(structure_id,
    > frame_index)`——`temporal_group_id` 由 structure 決定（每個結構就帶
    > 一個），因此 payload 上它是「回報」而非「鍵的一部分」。
    """

    structure_id: str
    mask_grid_id: str
    frame_of_reference_uid: str
    offset_ijk: Int3
    size_ijk: Int3
    data: bytes
    """解壓後的 uint8 體素，`size_x*size_y*size_z`，**x 變化最快**。"""
    content_hash: str
    provenance: Provenance
    temporal_group_id: str | None = None
    frame_index: int | None = None

    def __post_init__(self) -> None:
        d = self.descriptor
        require(
            len(self.data) == d.expected_bytes,
            "I9",
            "mask 資料長度與 size_ijk 不符（chaos: wrong_size）",
            declared=d.expected_bytes,
            actual=len(self.data),
        )

    @property
    def key(self) -> tuple[str, int | None]:
        """mask 的鍵：二元組。"""
        return (self.structure_id, self.frame_index)

    @property
    def descriptor(self) -> VoxelPayloadDescriptor:
        return VoxelPayloadDescriptor(
            grid_ref=self.mask_grid_id,
            frame_of_reference_uid=self.frame_of_reference_uid,
            offset_ijk=self.offset_ijk,
            size_ijk=self.size_ijk,
            dtype="uint8",
            components=1,
            semantics="binary_mask",
            content_hash=self.content_hash,
            temporal_group_id=self.temporal_group_id,
            frame_index=self.frame_index,
        )

    @property
    def array(self) -> np.ndarray:
        return self.descriptor.decode(self.data)

    @property
    def voxel_count_set(self) -> int:
        return int(np.count_nonzero(self.array))

    def volume_cc(self, voxel_volume_mm3: float) -> float:
        return self.voxel_count_set * voxel_volume_mm3 / 1000.0

    def to_header(self) -> dict[str, Any]:
        return {
            "structure_id": self.structure_id,
            "mask_grid_id": self.mask_grid_id,
            **self.descriptor.to_wire(),
            "provenance": self.provenance.to_wire(),
        }

    @classmethod
    def from_dense(
        cls,
        *,
        structure_id: str,
        mask_grid_id: str,
        frame_of_reference_uid: str,
        volume: np.ndarray,
        provenance: Provenance,
        temporal_group_id: str | None = None,
        frame_index: int | None = None,
    ) -> MaskPayload | None:
        """由全網格布林陣列裁切成 bbox payload。空 mask 回傳 None。"""
        offset, size, cropped = crop_to_bbox(volume)
        if cropped is None:
            return None
        data = np.ascontiguousarray(cropped, dtype=np.uint8).tobytes()
        return cls(
            structure_id=structure_id,
            mask_grid_id=mask_grid_id,
            frame_of_reference_uid=frame_of_reference_uid,
            offset_ijk=offset,
            size_ijk=size,
            data=data,
            content_hash=payload_content_hash(offset_ijk=offset, size_ijk=size, data=data, prefix="mh_"),
            provenance=provenance,
            temporal_group_id=temporal_group_id,
            frame_index=frame_index,
        )


@dataclass(frozen=True)
class MeshPayload:
    """3D 總覽用的表面（型態 F2）。

    `vertex_scalars` 是每頂點屬性（表面著色劑量、距靶距離），
    目前為 None，但**欄位現在就在**。
    """

    structure_id: str
    mask_grid_id: str
    frame_of_reference_uid: str
    lod: int
    vertices: np.ndarray
    """(N, 3) float32，**LPS mm 世界座標**（不是索引座標）。"""
    triangles: np.ndarray
    """(M, 3) uint32。"""
    content_hash: str
    vertex_scalars: np.ndarray | None = None
    frame_index: int | None = None

    def __post_init__(self) -> None:
        require(
            self.vertices.ndim == 2 and self.vertices.shape[1] == 3,
            "M1",
            "vertices 必須是 (N, 3)",
            shape=self.vertices.shape,
        )
        require(
            self.triangles.ndim == 2 and self.triangles.shape[1] == 3,
            "M2",
            "triangles 必須是 (M, 3)",
            shape=self.triangles.shape,
        )
        if len(self.triangles):
            require(
                int(self.triangles.max()) < len(self.vertices),
                "M3",
                "triangles 索引超出 vertices 範圍",
                max_index=int(self.triangles.max()),
                vertex_count=len(self.vertices),
            )
        if self.vertex_scalars is not None:
            require(
                len(self.vertex_scalars) == len(self.vertices),
                "M4",
                "vertex_scalars 長度必須等於 vertices",
            )

    def to_header(self) -> dict[str, Any]:
        return {
            "structure_id": self.structure_id,
            "mask_grid_id": self.mask_grid_id,
            "frame_of_reference_uid": self.frame_of_reference_uid,
            "lod": self.lod,
            "frame_index": self.frame_index,
            "vertex_count": int(len(self.vertices)),
            "triangle_count": int(len(self.triangles)),
            "has_vertex_scalars": self.vertex_scalars is not None,
            "content_hash": self.content_hash,
        }


def crop_to_bbox(volume: np.ndarray) -> tuple[Int3, Int3, np.ndarray | None]:
    """把布林／uint8 全網格陣列裁到 bounding box。

    輸入為 numpy `(k, j, i)` 排列；回傳的 `offset_ijk` / `size_ijk` 為 **(i, j, k)**
    順序，與 wire 一致。這個順序轉換是 off-by-one 的常客，因此集中在這一個函式。
    """
    nonzero = np.nonzero(volume)
    if len(nonzero[0]) == 0:
        return (0, 0, 0), (1, 1, 1), None
    k0, k1 = int(nonzero[0].min()), int(nonzero[0].max())
    j0, j1 = int(nonzero[1].min()), int(nonzero[1].max())
    i0, i1 = int(nonzero[2].min()), int(nonzero[2].max())
    cropped = volume[k0 : k1 + 1, j0 : j1 + 1, i0 : i1 + 1]
    return (i0, j0, k0), (i1 - i0 + 1, j1 - j0 + 1, k1 - k0 + 1), cropped


def paste_bbox(
    full_shape_kji: tuple[int, int, int],
    offset_ijk: Int3,
    block: np.ndarray,
) -> np.ndarray:
    """把 bbox 區塊貼回全網格（編輯套用、後處理的反向操作）。"""
    out = np.zeros(full_shape_kji, dtype=block.dtype)
    i0, j0, k0 = (int(v) for v in offset_ijk)
    dk, dj, di = block.shape[:3]
    out[k0 : k0 + dk, j0 : j0 + dj, i0 : i0 + di] = block
    return out
