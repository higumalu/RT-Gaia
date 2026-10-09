"""`Grid` — 幾何的唯一表示。

座標慣例一律 LPS。系統內任何地方不得出現 RAS。
`direction` 一律完整傳遞，不得因為「看起來是軸對齊」而省略。
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

import numpy as np

from .errors import require

Vec3 = tuple[float, float, float]
Int3 = tuple[int, int, int]
Mat9 = tuple[float, float, float, float, float, float, float, float, float]

DIRECTION_ORTHONORMAL_TOL = 1e-6
"""direction 正交性容差。

DICOM 的 ImageOrientationPatient 只有 16 位有效數字的十進位字串，
真實資料經 cross product 補出第三軸後偏差典型在 1e-9 以下；1e-6 足夠寬鬆
又能抓到「把 spacing 乘進 direction」這類真正的錯誤。
"""


@dataclass(frozen=True)
class Grid:
    """規則體素網格的完整幾何。

    `direction` 為 row-major 的 3×3 方向餘弦矩陣，**第 c 欄是第 c 個索引軸的
    方向向量**（與 ITK `SetDirection` 一致）。因此：

        world = origin + direction @ (spacing ⊙ ijk)
    """

    size: Int3
    spacing: Vec3
    origin: Vec3
    direction: Mat9
    frame_of_reference_uid: str

    def __post_init__(self) -> None:
        require(len(self.size) == 3, "G1", "size 必須是三個元素", size=self.size)
        require(
            all(isinstance(n, int) and not isinstance(n, bool) for n in self.size),
            "G1",
            "size 必須是整數（不是 numpy 型別，不是 float）",
            size=self.size,
        )
        require(all(n > 0 for n in self.size), "G1", "size 每軸必須為正", size=self.size)
        require(len(self.spacing) == 3, "G2", "spacing 必須是三個元素", spacing=self.spacing)
        require(all(s > 0 for s in self.spacing), "G2", "spacing 每軸必須為正", spacing=self.spacing)
        require(len(self.origin) == 3, "G3", "origin 必須是三個元素", origin=self.origin)
        require(
            len(self.direction) == 9,
            "G4",
            "direction 必須是 9 個 float（row-major）——不得省略，不得預設為單位矩陣",
            direction=self.direction,
        )
        d = np.asarray(self.direction, dtype=np.float64).reshape(3, 3)
        residual = float(np.abs(d.T @ d - np.eye(3)).max())
        require(
            residual <= DIRECTION_ORTHONORMAL_TOL,
            "G5",
            "direction 必須正交且單位長（spacing 不得混進 direction）",
            residual=residual,
            direction=self.direction,
        )
        det = float(np.linalg.det(d))
        # 🔴 **不得要求右手系。** 正交性（G5）已經保證 |det| = 1；det 的**正負號**
        # 是取像幾何的一部分，不是錯誤。
        #
        # DICOM／ITK 從不保證右手系：切片沿 −z 排列（`ImagePositionPatient` 的 z
        # 遞減）在 HFS 掃描上是常態，Philips CT 就是這樣存。舊版這裡寫
        # `det > 0`，於是**真實的臨床 CT 一載入就被拒絕**——而合成假體全是右手系，
        # 所以 212 個測試沒有一個抓到。
        #
        # 左手系唯一真正需要補償的地方是**三角形繞向**（mesh 的 winding，見
        # `rtgaia_testbe.mesh`）：index→world 若翻轉手性，marching cubes 的繞向
        # 也跟著翻，背面剔除會讓表面整片消失。用 `handedness` 判斷並翻回來。
        require(
            abs(abs(det) - 1.0) <= DIRECTION_ORTHONORMAL_TOL,
            "G6",
            "direction 的 |det| 必須為 1（正交矩陣的必然結果）",
            det=det,
        )
        require(
            bool(self.frame_of_reference_uid),
            "G7",
            "frame_of_reference_uid 必填（沒有物件可以繞過空間）",
        )

    # ── 矩陣 ────────────────────────────────────────────────────────────────

    @property
    def direction_matrix(self) -> np.ndarray:
        """3×3 方向餘弦（欄為索引軸方向）。"""
        return np.asarray(self.direction, dtype=np.float64).reshape(3, 3)

    @property
    def index_to_world_matrix(self) -> np.ndarray:
        """4×4 齊次矩陣，ijk → LPS mm。"""
        m = np.eye(4, dtype=np.float64)
        m[:3, :3] = self.direction_matrix * np.asarray(self.spacing, dtype=np.float64)
        m[:3, 3] = np.asarray(self.origin, dtype=np.float64)
        return m

    @property
    def world_to_index_matrix(self) -> np.ndarray:
        """4×4 齊次矩陣，LPS mm → ijk（連續索引，可為非整數）。"""
        return np.linalg.inv(self.index_to_world_matrix)

    # ── 座標轉換（座標轉換鏈的其中兩段）───────────────────────────────────

    def index_to_world(self, ijk: Any) -> np.ndarray:
        """連續索引 → LPS mm。支援單點 (3,) 或多點 (N, 3)。"""
        pts = np.atleast_2d(np.asarray(ijk, dtype=np.float64))
        out = pts @ (self.direction_matrix * np.asarray(self.spacing)).T + np.asarray(self.origin)
        return out[0] if np.ndim(ijk) == 1 else out

    def world_to_index(self, world: Any) -> np.ndarray:
        """LPS mm → 連續索引。**不做四捨五入、不做邊界裁切。**"""
        pts = np.atleast_2d(np.asarray(world, dtype=np.float64))
        inv = self.world_to_index_matrix
        out = pts @ inv[:3, :3].T + inv[:3, 3]
        return out[0] if np.ndim(world) == 1 else out

    def world_to_nearest_voxel(self, world: Any) -> np.ndarray:
        """LPS mm → 最近的整數體素索引（四捨五入，不裁切）。"""
        return np.rint(self.world_to_index(world)).astype(np.int64)

    def contains_index(self, ijk: Any) -> bool:
        idx = np.asarray(ijk)
        return bool(np.all(idx >= 0) and np.all(idx <= np.asarray(self.size) - 1))

    # ── 導出量 ──────────────────────────────────────────────────────────────

    @property
    def handedness(self) -> int:
        """index→world 的手性：`+1` 右手、`-1` 左手。

        左手系（切片沿 −z 排列）是 DICOM 的常態，**不是錯誤**。需要據此補償的
        只有三角形繞向（mesh winding）；取樣、筆刷、量測都不受影響。
        """
        return 1 if float(np.linalg.det(self.direction_matrix)) > 0 else -1

    @property
    def voxel_count(self) -> int:
        return int(self.size[0]) * int(self.size[1]) * int(self.size[2])

    @property
    def voxel_volume_mm3(self) -> float:
        return float(self.spacing[0] * self.spacing[1] * self.spacing[2])

    @property
    def corners_world(self) -> np.ndarray:
        """8 個角（以體素中心為準）的 LPS 座標，(8, 3)。"""
        nx, ny, nz = (n - 1 for n in self.size)
        idx = np.array(
            [
                (0, 0, 0),
                (nx, 0, 0),
                (0, ny, 0),
                (nx, ny, 0),
                (0, 0, nz),
                (nx, 0, nz),
                (0, ny, nz),
                (nx, ny, nz),
            ],
            dtype=np.float64,
        )
        return self.index_to_world(idx)

    def same_frame_as(self, other: Grid) -> bool:
        return self.frame_of_reference_uid == other.frame_of_reference_uid

    # ── 序列化 ──────────────────────────────────────────────────────────────

    def to_wire(self) -> dict[str, Any]:
        return {
            "size": list(self.size),
            "spacing": list(self.spacing),
            "origin": list(self.origin),
            "direction": list(self.direction),
            "frame_of_reference_uid": self.frame_of_reference_uid,
        }

    @classmethod
    def from_wire(cls, d: dict[str, Any]) -> Grid:
        require(
            "direction" in d and d["direction"] is not None,
            "G4",
            "header 缺少 direction——不得預設為單位矩陣（測試後端 chaos: missing_direction）",
            keys=sorted(d),
        )
        return cls(
            size=tuple(int(v) for v in d["size"]),  # type: ignore[arg-type]
            spacing=tuple(float(v) for v in d["spacing"]),  # type: ignore[arg-type]
            origin=tuple(float(v) for v in d["origin"]),  # type: ignore[arg-type]
            direction=tuple(float(v) for v in d["direction"]),  # type: ignore[arg-type]
            frame_of_reference_uid=str(d["frame_of_reference_uid"]),
        )


IDENTITY_DIRECTION: Mat9 = (1.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0)
