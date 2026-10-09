"""DICOM Spatial Registration（REG，SOP Class 1.2.840.10008.5.1.4.1.1.66.1）。

DICOM SRO／DSR 是後端事務，不影響前端。前端只看得到
`FrameGroup.transformToPrimary` ＋ `registration`（來源）。這個模組就是那道轉換。

## 矩陣的方向（PS3.3 C.20.2.1.1）

`RegistrationSequence` 的每個 item 有自己的 `FrameOfReferenceUID`（來源 FoR）與一個
`FrameOfReferenceTransformationMatrix`：**把該 item 的 FoR 座標轉到 REG 物件本身的
`FrameOfReferenceUID`（登錄的參考 FoR）**。因此若 REG 的 FoR 是計畫 CT（primary）、
item 的 FoR 是 CBCT，那個矩陣就是 CBCT → primary，正好是 `transform_to_primary`，
**不必反轉**。只有 REG 的 FoR 不是 primary 時才需要組合／反轉（見 `resolve`）。

矩陣在 DICOM 裡是 **row-major** 16 個 DS；`FrameGroup.secondary_rigid` 吃的也是
row-major numpy 4×4，wire 上才轉 column-major（F4 會抓到轉錯的那一種）。

⚠️ `DeformableRegistrationSequence`（DIR，SOP Class …66.3）**不在這裡處理**：
DVF 無法用 4×4 表示，那是後端重採樣那條路，留給下一批。
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Any

import numpy as np
import pydicom
from rtgaia_geom import RegistrationInfo
from rtgaia_geom.errors import require

SPATIAL_REGISTRATION_SOP = "1.2.840.10008.5.1.4.1.1.66.1"
DEFORMABLE_REGISTRATION_SOP = "1.2.840.10008.5.1.4.1.1.66.3"


@dataclass(frozen=True)
class RegistrationItem:
    source_frame_of_reference_uid: str
    """這個 item 描述的 FoR（矩陣的輸入端）。"""
    target_frame_of_reference_uid: str
    """REG 物件本身的 FoR（矩陣的輸出端）。"""
    matrix_row_major: np.ndarray
    """4×4，source → target。多個 `MatrixSequence` 已依序乘起來。"""
    matrix_type: str
    """RIGID / RIGID_SCALE / AFFINE。只有 RIGID 能進 `transform_kind='rigid'`（F7）。"""


@dataclass(frozen=True)
class SpatialRegistration:
    path: Path
    sop_instance_uid: str
    series_instance_uid: str
    frame_of_reference_uid: str
    """登錄的參考 FoR ＝ 所有 item 的目標。"""
    series_date: str
    items: tuple[RegistrationItem, ...]
    referenced_series_uids: tuple[str, ...]

    def item_for(self, source_for: str) -> RegistrationItem | None:
        return next((i for i in self.items if i.source_frame_of_reference_uid == source_for), None)

    @property
    def frame_of_reference_uids(self) -> set[str]:
        return {self.frame_of_reference_uid, *(i.source_frame_of_reference_uid for i in self.items)}


def read_registration(path: str | Path) -> SpatialRegistration:
    p = Path(path)
    ds = pydicom.dcmread(str(p), stop_before_pixels=True)
    require(str(ds.get("Modality", "")) == "REG", "RG1", "不是 REG", path=str(p))
    require(
        not ds.get("DeformableRegistrationSequence"),
        "RG2",
        "這是 Deformable Spatial Registration（DIR）—— DVF 無法用 4×4 表示，目前不支援",
        path=str(p),
    )
    target = str(ds.get("FrameOfReferenceUID", "") or "")
    require(bool(target), "RG3", "REG 缺少 FrameOfReferenceUID（登錄的參考 FoR）", path=str(p))

    items: list[RegistrationItem] = []
    for reg in ds.get("RegistrationSequence", []) or []:
        source = str(reg.get("FrameOfReferenceUID", "") or "")
        m = np.eye(4, dtype=np.float64)
        kinds: list[str] = []
        for mreg in reg.get("MatrixRegistrationSequence", []) or []:
            for entry in mreg.get("MatrixSequence", []) or []:
                vals = [float(v) for v in entry.FrameOfReferenceTransformationMatrix]
                require(len(vals) == 16, "RG4", "FrameOfReferenceTransformationMatrix 必須是 16 個值", got=len(vals))
                step = np.asarray(vals, dtype=np.float64).reshape(4, 4)
                # 多個矩陣依序套用：先列的先作用 → 後者左乘
                m = step @ m
                kinds.append(str(entry.get("FrameOfReferenceTransformationMatrixType", "RIGID")))
        require(
            np.allclose(m[3, :], [0, 0, 0, 1], atol=1e-9),
            "RG5",
            "REG 矩陣最後一列不是 [0,0,0,1]",
            last_row=m[3, :].tolist(),
        )
        matrix_type = "RIGID" if all(k == "RIGID" for k in kinds) else (kinds[-1] if kinds else "RIGID")
        items.append(
            RegistrationItem(
                source_frame_of_reference_uid=source,
                target_frame_of_reference_uid=target,
                matrix_row_major=m,
                matrix_type=matrix_type,
            )
        )
    return SpatialRegistration(
        path=p,
        sop_instance_uid=str(ds.get("SOPInstanceUID", "") or ""),
        series_instance_uid=str(ds.get("SeriesInstanceUID", "") or ""),
        frame_of_reference_uid=target,
        series_date=str(ds.get("SeriesDate", "") or ""),
        items=tuple(items),
        referenced_series_uids=tuple(str(x.SeriesInstanceUID) for x in ds.get("ReferencedSeriesSequence", []) or []),
    )


@dataclass(frozen=True)
class ResolvedTransform:
    matrix_row_major: np.ndarray
    """source FoR → primary FoR。"""
    info: RegistrationInfo


def resolve(
    registrations: list[SpatialRegistration],
    *,
    source_for: str,
    primary_for: str,
) -> ResolvedTransform | None:
    """在一批 REG 裡找出 `source_for → primary_for` 的矩陣。

    三種情況都要接（真實資料三種都會出現）：

    | REG 的 FoR | 有的 item | 算法 |
    |---|---|---|
    | primary | source | `M_source`（最常見：計畫 CT 為參考） |
    | source | primary | `inv(M_primary)`（以 CBCT 為參考登錄的） |
    | 第三者 R | source 與 primary | `inv(M_primary) @ M_source`（兩者都相對 R） |

    找不到回 None —— 呼叫端擺單位矩陣並標 `registration.source='none'`，**讓「未
    對位」在畫面上看得見**，而不是默默當成已對位。
    """
    if source_for == primary_for:
        return None
    for reg in registrations:
        src_item = reg.item_for(source_for)
        pri_item = reg.item_for(primary_for)
        info = RegistrationInfo(
            source="REG",
            sop_instance_uid=reg.sop_instance_uid or None,
            matrix_type=(src_item or pri_item).matrix_type if (src_item or pri_item) else None,
            description=f"REG {reg.series_date}".strip(),
        )
        if reg.frame_of_reference_uid == primary_for and src_item is not None:
            return ResolvedTransform(src_item.matrix_row_major, info)
        if reg.frame_of_reference_uid == source_for and pri_item is not None:
            return ResolvedTransform(np.linalg.inv(pri_item.matrix_row_major), info)
        if src_item is not None and pri_item is not None:
            return ResolvedTransform(np.linalg.inv(pri_item.matrix_row_major) @ src_item.matrix_row_major, info)
    return None


def summarize(reg: SpatialRegistration) -> dict[str, Any]:
    return {
        "path": str(reg.path),
        "sop_instance_uid": reg.sop_instance_uid,
        "frame_of_reference_uid": reg.frame_of_reference_uid,
        "items": [
            {
                "source": i.source_frame_of_reference_uid,
                "type": i.matrix_type,
                "translation_mm": [round(float(v), 4) for v in i.matrix_row_major[:3, 3]],
            }
            for i in reg.items
        ],
    }
