"""假體的型別。

假體**不存體素**：`image` 是一個惰性函式，`structures` 只帶
解析形狀。可進版控的是這些定義與 `expected.json`，不是資料。
"""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Any, Literal

import numpy as np
from rtgaia_geom.frame_group import RegistrationInfo
from rtgaia_geom.grid import Grid
from rtgaia_geom.provenance import ProvenanceSource
from rtgaia_geom.temporal import TemporalGroup

from .shapes import Shape

Modality = Literal["CT", "MR", "CBCT", "PET", "PT", "RTDOSE"]
StructureStatus = Literal["ai_generated", "under_review", "edited", "approved", "rejected"]
SeriesKind = Literal["image", "dose"]
SeriesDType = Literal["int16", "float32"]


@dataclass(frozen=True)
class DatasetSeries:
    """一個序列。`transform_to_primary` 為 row-major 4×4（wire 上才轉 column-major）。

    **影像與劑量都是 F1 純量場的實例**，因此共用這個型別，以
    `kind` 區分：`image` 產生 `kind:'image'` 的 layer 並擁有一個 FrameGroup；
    `dose` 產生 `kind:'dose'` 的 layer，**不擁有 FrameGroup**——它借用同一個
    FoR 的影像序列那一個，跟著它一起動。
    """

    series_id: str
    grid: Grid
    role: Literal["primary", "secondary"]
    modality: Modality
    image: Callable[[Grid, int], np.ndarray]
    """`(grid, frame_index) -> (k, j, i)`，dtype 依 `dtype`。惰性，且可被磁碟快取。"""
    default_window: tuple[float, float] = (40.0, 400.0)
    transform_to_primary: tuple[float, ...] | None = None
    """None 表示單位矩陣。primary 必須為 None。"""
    temporal_group_id: str | None = None
    kind: SeriesKind = "image"
    dtype: SeriesDType = "int16"
    registration: RegistrationInfo | None = None
    """`transform_to_primary` 的來源（REG 物件、假體真值、或「找不到」）。"""
    meta: dict[str, object] = field(default_factory=dict)
    """給 UI 看的序列描述：patient_id / series_date / series_description / …（snake_case）。"""
    params: dict[str, object] = field(default_factory=dict)
    """`kind='dose'` 的顯示參數：max_gy / units / summation_type / referenced_plan_label …"""
    slice_sop_uids: tuple[str, ...] = ()
    """真實影像每一片（k 順序）的 SOPInstanceUID —— 匯出 RTSTRUCT 引用用；假體為空 → 合成。"""
    sop_class_uid: str = ""
    """真實影像的 SOP Class（CT／MR／Enhanced CT…）；空 → 當 CT。"""
    source_path: str = ""
    """真實影像第一片的檔案路徑：匯出關閉匿名化時從這裡讀病人識別（不放進 meta，PHI 不送前端）。"""
    frame_series_uids: tuple[str, ...] = ()
    """時間軸每一幀來自哪個 SeriesInstanceUID（4DCT 每相位一個序列；同一序列內分幀的全部相同）。

    空 ＝ 不是時間軸。"""
    frame_slice_sop_uids: tuple[tuple[str, ...], ...] = ()
    """每一幀的切片 SOP UID（k 順序）—— 匯出 RTSTRUCT 要引用那一幀的影像。"""

    @property
    def frame_of_reference_uid(self) -> str:
        return self.grid.frame_of_reference_uid

    @property
    def semantics(self) -> str:
        return "dose_gy" if self.kind == "dose" else "image"


@dataclass(frozen=True)
class DatasetStructure:
    """一個結構。

    `shape` 定義在世界座標（見 `shapes` 模組開頭的說明）——合成假體走這條，
    因此有**解析的已知答案**。

    真實 RTSTRUCT 沒有解析形狀：改用 `preloaded` 直接給已裁切的體素。
    此時 `shape` 為 None，`expected.json` 也不會有 analytic 體積 —— 這正是
    兩者的分野：「**真實 DICOM 用來抓意外，合成假體用來做數值斷言。**」
    """

    structure_id: str
    name: str
    shape: Shape | None
    color_rgb: tuple[int, int, int]
    frame_of_reference_uid: str
    tg263_code: str | None = None
    status: StructureStatus = "ai_generated"
    default_visible: bool = True
    temporal_group_id: str | None = None
    per_frame_shift_mm: tuple[float, float, float] = (0.0, 0.0, 0.0)
    """帶時間軸的結構：每一相位平移這個量（模擬呼吸位移）。"""
    frame_index: int | None = None
    """只存在於**這一幀**（真實 RTSTRUCT 畫在 4DCT 的某個相位序列上）；None ＝ 每一幀都有（假體）。"""
    preloaded: tuple[tuple[int, int, int], tuple[int, int, int], np.ndarray] | None = None
    """`(offset_ijk, size_ijk, block)` —— 真實 RTSTRUCT 光柵化後的結果。"""
    interpreted_type: str | None = None
    """`RTROIInterpretedType`（ORGAN / PTV / CTV / GTV / EXTERNAL …）。"""
    structure_set_id: str | None = None
    """來自哪一套 RTSTRUCT（`Dataset.structure_sets` 的 id）；合成假體為 None。"""
    provenance_source: ProvenanceSource = "model"
    """🔴 **這份輪廓是誰畫的**（追溯欄位）。

    合成假體確實是模型（形狀函式）產生的，因此預設 `"model"`；**真實 RTSTRUCT
    是臨床醫師畫的，必須是 `"import"`**。

    先前 `build_session` 對所有結構硬寫 `source="model"`，於是匯入的臨床輪廓在
    追溯鏈上被記成模型產生的。`dicom.py` 其實已經注意到這件事並把 `status` 設成
    `under_review`，但意圖只實作了一半——`status` 是審核流程，`provenance.source`
    是**這份資料的來源**，兩者不能互相取代。

    這不是精度問題而是**方向性錯誤**：法規送件時「模型產生」與「人工匯入」的
    舉證責任完全不同，而事後補要做資料遷移。"""


@dataclass(frozen=True)
class DatasetMarker:
    """型態 F4 的稀疏標記點。`known_geometry` 的距離真值就靠它。"""

    marker_id: str
    world_lps: tuple[float, float, float]
    frame_of_reference_uid: str
    ijk: tuple[int, int, int] | None = None
    voxel_value: int | None = None


@dataclass(frozen=True)
class Dataset:
    dataset_id: str
    description: str
    study_id: str
    series: tuple[DatasetSeries, ...]
    structures: tuple[DatasetStructure, ...] = ()
    markers: tuple[DatasetMarker, ...] = ()
    temporal_groups: tuple[TemporalGroup, ...] = ()
    verifies: tuple[str, ...] = ()
    """這個假體是為了驗證哪些行為（寫進 expected.json，讓測試失敗時看得懂）。"""
    notes: dict[str, object] = field(default_factory=dict)
    structure_sets: tuple[dict[str, Any], ...] = ()
    """載入的 RTSTRUCT 結構集，每套一筆
    `{structure_set_id, label, series_instance_uid, image_series_uid, frame_of_reference_uid, date, roi_count}`。
    結構清單以它分層（多套 RS 進同一個病例時 ROI 不再混在一起）。"""
    plans: tuple[dict[str, Any], ...] = ()
    registrations: tuple[dict[str, Any], ...] = ()
    """病例裡載入的 REG（劑量「套用 REG」用：先選劑量、再選要套用哪個 REG），每個
    `{reg_id, sop_instance_uid, series_date, label, frame_of_reference_uid（fixed）,
    items: [{source_frame_of_reference_uid, matrix_row_major（16）, matrix_type}]}`。"""
    """病例裡的 RTPLAN（選取的 ＋ 載入的劑量參照到的），每個
    `{series_instance_uid, sop_instance_uid, label, frame_of_reference_uid, path}`。
    射束在 API 層讀（`loaders/rtplan.py`）。"""

    @property
    def primary(self) -> DatasetSeries:
        return next(s for s in self.series if s.role == "primary" and s.kind == "image")

    @property
    def image_series(self) -> tuple[DatasetSeries, ...]:
        """擁有 FrameGroup 的序列（`kind='image'`）。"""
        return tuple(s for s in self.series if s.kind == "image")

    def image_series_for(self, frame_of_reference_uid: str) -> DatasetSeries:
        """某個 FoR 的**影像**序列——結構與劑量都掛在它的網格／FrameGroup 上。"""
        for s in self.series:
            if s.kind == "image" and s.frame_of_reference_uid == frame_of_reference_uid:
                return s
        raise KeyError(f"資料集 {self.dataset_id} 沒有 FoR {frame_of_reference_uid} 的影像序列")

    def series_by_id(self, series_id: str) -> DatasetSeries:
        for s in self.series:
            if s.series_id == series_id:
                return s
        raise KeyError(f"資料集 {self.dataset_id} 沒有序列 {series_id}")

    def structure_by_id(self, structure_id: str) -> DatasetStructure:
        for s in self.structures:
            if s.structure_id == structure_id:
                return s
        raise KeyError(f"資料集 {self.dataset_id} 沒有結構 {structure_id}")
