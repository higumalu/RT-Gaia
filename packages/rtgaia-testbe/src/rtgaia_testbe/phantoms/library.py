"""合成假體庫。

> **真實 DICOM 用來抓意外，合成假體用來做數值斷言。** 兩者都要，不能只有其一。

除了最初那十個之外，本庫多了一個 **`four_d_ct`**：時間軸必須與幾何契約
同時納入，不可延後，但原本的假體清單裡沒有任何帶時間軸的案例——
`temporal_groups`、`frame` 參數與三元組／二元組鍵**沒有東西可以測**。
"""

from __future__ import annotations

import numpy as np
from rtgaia_core.dataset import Dataset, DatasetMarker, DatasetSeries, DatasetStructure
from rtgaia_core.dataset_io import FOUR_D_FRAMES
from rtgaia_core.shapes import Box, Cylinder, Ellipsoid, Sphere, Union
from rtgaia_geom import rigid_matrix
from rtgaia_geom.grid import Grid
from rtgaia_geom.temporal import TemporalGroup

from . import images

UID_ROOT = "1.2.826.0.1.3680043.8.498.RTGAIA.TESTBE"


def _for(name: str) -> str:
    return f"{UID_ROOT}.FOR.{name}"


def _series(name: str) -> str:
    return f"{UID_ROOT}.SERIES.{name}"


def _study(name: str) -> str:
    return f"{UID_ROOT}.STUDY.{name}"


def centered_grid(
    size: tuple[int, int, int],
    spacing: tuple[float, float, float],
    *,
    direction: tuple[float, ...] = (1, 0, 0, 0, 1, 0, 0, 0, 1),
    frame_of_reference_uid: str,
    origin: tuple[float, float, float] | None = None,
) -> Grid:
    """世界原點落在體積中心的網格。

    刻意讓 origin 落在半體素（`-255.5`）而非整數：**這樣「忘記體素中心 vs 體素角」
    的差半格錯誤會立刻在數值上顯現**，而在整數 origin 上兩者恰好都算得出漂亮數字。
    """
    if origin is None:
        half = [(size[i] - 1) * spacing[i] / 2.0 for i in range(3)]
        d = np.asarray(direction, dtype=np.float64).reshape(3, 3)
        origin = tuple(float(v) for v in (-d @ np.asarray(half)))  # type: ignore[assignment]
    assert origin is not None
    return Grid(
        size=size,
        spacing=spacing,
        origin=origin,
        direction=direction,  # type: ignore[arg-type]
        frame_of_reference_uid=frame_of_reference_uid,
    )


def rotation(deg_x: float = 0.0, deg_y: float = 0.0, deg_z: float = 0.0) -> tuple[float, ...]:
    """row-major 3×3 方向餘弦（Rz @ Ry @ Rx）。"""
    return tuple(rigid_matrix(rotation_deg=(deg_x, deg_y, deg_z))[:3, :3].flatten().tolist())


# ── known_geometry 的真值常數（expected.json 與影像產生器共用）─────────────

KNOWN_GEOMETRY_SPHERE = Sphere(center=(-40.0, 0.0, 0.0), radius_mm=25.0)
"""半徑 25 mm → 解析體積 65.4498 cc（約 65.45 cc）。"""

KNOWN_GEOMETRY_CUBE = Box(center=(40.0, 0.0, 0.0), size_mm=(40.0, 40.0, 40.0))
"""邊長 40 mm → 解析體積 64.00 cc。"""

KNOWN_GEOMETRY_MARKERS: tuple[tuple[float, float, float], ...] = (
    (-50.0, 60.0, 0.0),
    (50.0, 60.0, 0.0),
)
"""相距**正好** 100.00 mm 的兩個標記點。"""


# ── 假體定義 ────────────────────────────────────────────────────────────────


def _ct_series(name: str, grid: Grid, image=images.torso) -> DatasetSeries:
    return DatasetSeries(
        series_id=_series(name),
        grid=grid,
        role="primary",
        modality="CT",
        image=image,
        default_window=(40.0, 400.0),
    )


def axial_clean() -> Dataset:
    grid = centered_grid((512, 512, 100), (1.0, 1.0, 3.0), frame_of_reference_uid=_for("axial"))
    return Dataset(
        dataset_id="axial_clean",
        description="512×512×100，1×1×3 mm，單位 direction，origin 在已知 LPS。基線。",
        study_id=_study("axial_clean"),
        series=(_ct_series("axial_clean", grid),),
        structures=(
            DatasetStructure(
                structure_id="body",
                name="BODY",
                tg263_code="External",
                shape=Ellipsoid(center=(0.0, 0.0, 0.0), radii_mm=(184.0, 143.0, 144.0)),
                color_rgb=(200, 180, 160),
                frame_of_reference_uid=grid.frame_of_reference_uid,
                default_visible=False,
            ),
            DatasetStructure(
                structure_id="lesion",
                name="GTV",
                tg263_code="GTV",
                shape=Sphere(center=(51.2, 14.3, 0.0), radius_mm=12.0),
                color_rgb=(255, 0, 0),
                frame_of_reference_uid=grid.frame_of_reference_uid,
            ),
        ),
        verifies=("LPS 慣例", "DisplayGrid 導出", "基線比較用"),
    )


def gantry_tilt() -> Dataset:
    """🔴 **最該優先跑的假體**：direction 繞 x 傾斜 15°。

    漏傳 `direction` 時，這個假體上的一切都會偏，而在
    `axial_clean` 上完全正常。
    """
    grid = centered_grid(
        (512, 512, 100),
        (1.0, 1.0, 3.0),
        direction=rotation(deg_x=15.0),
        frame_of_reference_uid=_for("gantry_tilt"),
    )
    return Dataset(
        dataset_id="gantry_tilt",
        description="direction 繞 x 傾斜 15°。抓「漏傳 direction」的 bug。",
        study_id=_study("gantry_tilt"),
        series=(_ct_series("gantry_tilt", grid),),
        structures=(
            DatasetStructure(
                structure_id="lesion",
                name="GTV",
                tg263_code="GTV",
                shape=Sphere(center=(51.2, 14.3, 0.0), radius_mm=12.0),
                color_rgb=(255, 0, 0),
                frame_of_reference_uid=grid.frame_of_reference_uid,
            ),
            DatasetStructure(
                structure_id="cord",
                name="SpinalCord",
                tg263_code="SpinalCord",
                shape=Cylinder(center=(0.0, 27.2, 0.0), radius_mm=7.0, length_mm=220.0),
                color_rgb=(0, 255, 255),
                frame_of_reference_uid=grid.frame_of_reference_uid,
            ),
        ),
        verifies=("direction 一律完整傳遞", "座標轉換鏈"),
    )


def oblique_acq() -> Dataset:
    grid = centered_grid(
        (512, 512, 100),
        (1.0, 1.0, 3.0),
        direction=rotation(deg_x=20.0, deg_y=12.0),
        frame_of_reference_uid=_for("oblique"),
    )
    return Dataset(
        dataset_id="oblique_acq",
        description="direction 同時繞兩軸旋轉 20°／12°。非軸對齊取像。",
        study_id=_study("oblique_acq"),
        series=(_ct_series("oblique_acq", grid),),
        structures=(
            DatasetStructure(
                structure_id="lesion",
                name="GTV",
                tg263_code="GTV",
                shape=Sphere(center=(51.2, 14.3, 0.0), radius_mm=12.0),
                color_rgb=(255, 0, 0),
                frame_of_reference_uid=grid.frame_of_reference_uid,
            ),
        ),
        verifies=("非軸對齊取像", "斜面 MPR"),
    )


def anisotropic() -> Dataset:
    grid = centered_grid((512, 512, 60), (1.0, 1.0, 5.0), frame_of_reference_uid=_for("aniso"))
    return Dataset(
        dataset_id="anisotropic",
        description="1×1×5 mm。斜面階梯 artifact 的臨床判斷素材。",
        study_id=_study("anisotropic"),
        series=(_ct_series("anisotropic", grid),),
        structures=(
            DatasetStructure(
                structure_id="sphere_20mm",
                name="GTV",
                tg263_code="GTV",
                shape=Sphere(center=(0.0, 0.0, 0.0), radius_mm=20.0),
                color_rgb=(255, 0, 0),
                frame_of_reference_uid=grid.frame_of_reference_uid,
            ),
        ),
        verifies=("斜面畫質 hybrid", "slab 下的輪廓語意"),
    )


LANDMARK_IJK = (37, 61, 13)
"""`landmark` 假體的唯一高值體素。**不取對稱位置**——(37, 61, 13) 三軸互異，
因此任何軸交換都會被抓到；取 (32, 32, 20) 這種對稱點就抓不到。"""


def landmark() -> Dataset:
    """座標轉換鏈的驗收假體。

    網格刻意做小（128×128×40），因為**這是 API 測試最常載入的假體**，
    512³ 會讓整個測試套件慢一個數量級。
    """
    grid = centered_grid((128, 128, 40), (1.2, 1.2, 2.5), frame_of_reference_uid=_for("landmark"))

    def image(g: Grid, frame: int = 0) -> np.ndarray:
        return images.gradient_with_landmark(g, frame, landmark_ijk=LANDMARK_IJK)

    world = grid.index_to_world(list(LANDMARK_IJK))
    return Dataset(
        dataset_id="landmark",
        description="平滑漸層底 ＋ 在已知 (i,j,k) 放唯一高值體素。驗證座標轉換鏈。",
        study_id=_study("landmark"),
        series=(
            DatasetSeries(
                series_id=_series("landmark"),
                grid=grid,
                role="primary",
                modality="CT",
                image=image,
                default_window=(0.0, 1200.0),
            ),
        ),
        markers=(
            DatasetMarker(
                marker_id="landmark_voxel",
                world_lps=tuple(float(v) for v in world),  # type: ignore[arg-type]
                frame_of_reference_uid=grid.frame_of_reference_uid,
                ijk=LANDMARK_IJK,
                voxel_value=3000,
            ),
        ),
        verifies=("座標轉換鏈", "Python 與瀏覽器取到同一個體素"),
    )


def known_geometry() -> Dataset:
    """量測工具的數值正確性。"""
    grid = centered_grid((256, 256, 128), (1.0, 1.0, 1.0), frame_of_reference_uid=_for("known_geom"))
    return Dataset(
        dataset_id="known_geometry",
        description="半徑 25 mm 球（65.45 cc）、邊長 40 mm 立方（64.00 cc）、相距 100.00 mm 的兩個標記點。",
        study_id=_study("known_geometry"),
        series=(
            DatasetSeries(
                series_id=_series("known_geometry"),
                grid=grid,
                role="primary",
                modality="CT",
                image=images.geometry_blocks,
                default_window=(0.0, 1000.0),
            ),
        ),
        structures=(
            DatasetStructure(
                structure_id="sphere_25mm",
                name="Sphere_25mm",
                shape=KNOWN_GEOMETRY_SPHERE,
                color_rgb=(255, 128, 0),
                frame_of_reference_uid=grid.frame_of_reference_uid,
                status="approved",
            ),
            DatasetStructure(
                structure_id="cube_40mm",
                name="Cube_40mm",
                shape=KNOWN_GEOMETRY_CUBE,
                color_rgb=(0, 128, 255),
                frame_of_reference_uid=grid.frame_of_reference_uid,
                status="approved",
            ),
        ),
        markers=tuple(
            DatasetMarker(
                marker_id=f"marker_{n}",
                world_lps=w,
                frame_of_reference_uid=grid.frame_of_reference_uid,
                ijk=tuple(int(v) for v in grid.world_to_nearest_voxel(w)),  # type: ignore[arg-type]
                voxel_value=3000,
            )
            for n, w in enumerate(KNOWN_GEOMETRY_MARKERS)
        ),
        verifies=("量測工具的數值正確性",),
        notes={
            "marker_distance_mm": 100.0,
            "sphere_volume_cc": 65.45,
            "cube_volume_cc": 64.00,
        },
    )


def overlap_set() -> Dataset:
    """結構重疊 —— **為何不能用單一 label volume**。"""
    grid = centered_grid((256, 256, 80), (1.5, 1.5, 3.0), frame_of_reference_uid=_for("overlap"))
    f = grid.frame_of_reference_uid
    gtv = Sphere(center=(0.0, 0.0, 0.0), radius_mm=20.0)
    ctv = Sphere(center=(0.0, 0.0, 0.0), radius_mm=30.0)
    ptv = Sphere(center=(0.0, 0.0, 0.0), radius_mm=35.0)
    body = Ellipsoid(center=(0.0, 0.0, 0.0), radii_mm=(180.0, 150.0, 115.0))
    lung_l = Ellipsoid(center=(60.0, -10.0, 0.0), radii_mm=(35.0, 45.0, 70.0))
    lung_r = Ellipsoid(center=(-60.0, -10.0, 0.0), radii_mm=(35.0, 45.0, 70.0))
    return Dataset(
        dataset_id="overlap_set",
        description="BODY ⊃ PTV ⊃ CTV ⊃ GTV ＋ 左右成對器官。驗證結構重疊。",
        study_id=_study("overlap_set"),
        series=(_ct_series("overlap_set", grid),),
        structures=(
            DatasetStructure("body", "BODY", body, (200, 180, 160), f, "External", default_visible=False),
            DatasetStructure("ptv", "PTV_7000", ptv, (255, 0, 255), f, "PTV"),
            DatasetStructure("ctv", "CTV_7000", ctv, (255, 128, 0), f, "CTV"),
            DatasetStructure("gtv", "GTV", gtv, (255, 0, 0), f, "GTV"),
            DatasetStructure("lung_l", "Lung_L", lung_l, (0, 200, 255), f, "Lung_L"),
            DatasetStructure("lung_r", "Lung_R", lung_r, (0, 160, 255), f, "Lung_R"),
            DatasetStructure("lungs", "Lungs", Union((lung_l, lung_r)), (0, 120, 200), f, "Lungs"),
        ),
        verifies=(
            "每個結構一份二值 mask，不用多標籤 volume",
            "LPS 的 +x = 病人左：Lung_L 在 +x、Lung_R 在 -x",
        ),
    )


LATERALITY_MARKER_R = Sphere(center=(-70.0, 0.0, 0.0), radius_mm=20.0)
"""**只在病人右側**（LPS 的 -x）。`laterality` 假體的整個重點。"""

LATERALITY_BODY = Ellipsoid(center=(0.0, 0.0, 0.0), radii_mm=(150.0, 110.0, 90.0))
"""左右對稱的軀幹，用來當「中線」的參考。"""


def laterality() -> Dataset:
    """🔴 **左右不對稱假體 —— 專門抓「整格左右鏡像」。**

    ## 為什麼需要一個新假體

    原有的十個假體**在左右方向上全部對稱**（球與立方在中線、成對器官等距、
    `many_structs` 的隨機球在統計上對稱）。因此 axial 視圖左右翻轉時，
    **549 個測試沒有一個會變色**，畫面看起來也完全正常——這正是
    `cameras.ts` 的 `ORIENTATIONS` 能把 axial 法線寫反並一路出貨的原因。

    這個假體只放**一顆球，在病人右側**（LPS `-x`）。任何左右鏡像都會讓它
    跑到畫面的另一半，而那是一條寫得出來的斷言：

        投影到 axial 的 u（`marker_r`）< 投影到 axial 的 u（`body`）

    ## 為什麼不直接用真實 CT

    `data/CT` 不進版控（本 repo `.gitignore`），因此用它寫的
    回歸測試在 CI 上跑不了。合成假體讓這條**離線可跑**——兩者的分野依然
    成立：真實資料抓意外，合成假體做數值斷言。
    """
    grid = centered_grid((160, 160, 48), (2.0, 2.0, 3.0), frame_of_reference_uid=_for("laterality"))
    f = grid.frame_of_reference_uid
    return Dataset(
        dataset_id="laterality",
        description="只在病人右側（-x）放一顆 20 mm 球。抓 axial／coronal 的左右鏡像。",
        study_id=_study("laterality"),
        series=(_ct_series("laterality", grid),),
        structures=(
            DatasetStructure("body", "BODY", LATERALITY_BODY, (200, 180, 160), f, "External", default_visible=False),
            DatasetStructure("marker_r", "Marker_R", LATERALITY_MARKER_R, (255, 0, 0), f, "GTV"),
        ),
        verifies=(
            "LPS 的 +x = 病人左",
            "axial／coronal 的畫面右 = 病人左（放射科慣例：病人右在畫面左）",
        ),
        notes={
            "marker_r_center_lps": list(LATERALITY_MARKER_R.center),
            "expect_marker_left_of_midline_on_screen": True,
        },
    )


TWO_SERIES_MATRIX = rigid_matrix(translation_mm=(15.0, -8.0, 4.0), rotation_deg=(0.0, 0.0, 5.0))
"""`two_series` 的真值 4×4（row-major，secondary → primary）。"""


def two_series() -> Dataset:
    """融合與 FrameGroup 變換。

    secondary 刻意用**不同的網格與較小的 FOV**（CBCT 常態），因此它同時驗證
    `coverageMask` 的必要性與「display grid 是整組共用的一個」這條設計。
    """
    primary_grid = centered_grid((256, 256, 80), (1.5, 1.5, 3.0), frame_of_reference_uid=_for("two_series_primary"))
    secondary_grid = centered_grid((192, 192, 48), (1.2, 1.2, 3.0), frame_of_reference_uid=_for("two_series_secondary"))
    pf = primary_grid.frame_of_reference_uid
    sf = secondary_grid.frame_of_reference_uid
    return Dataset(
        dataset_id="two_series",
        description="primary ＋ secondary，兩者間有已知的 4×4 剛性位移。",
        study_id=_study("two_series"),
        series=(
            _ct_series("two_series_primary", primary_grid),
            DatasetSeries(
                series_id=_series("two_series_secondary"),
                grid=secondary_grid,
                role="secondary",
                modality="CBCT",
                image=images.torso,
                default_window=(40.0, 600.0),
                transform_to_primary=tuple(TWO_SERIES_MATRIX.flatten().tolist()),
            ),
        ),
        structures=(
            DatasetStructure("gtv_primary", "GTV", Sphere((0.0, 0.0, 0.0), 20.0), (255, 0, 0), pf, "GTV"),
            # 🔴 屬於 secondary FoR 的結構：拖曳 secondary 影像時它必須一起動
            DatasetStructure("gtv_secondary", "GTV_CBCT", Sphere((0.0, 0.0, 0.0), 18.0), (255, 160, 0), sf, "GTV"),
        ),
        verifies=("融合與並排", "剛性變換套用於整個 FrameGroup"),
        notes={
            "transform_to_primary_row_major": TWO_SERIES_MATRIX.flatten().tolist(),
            "translation_mm": [15.0, -8.0, 4.0],
            "rotation_deg_z": 5.0,
        },
    )


def huge() -> Dataset:
    grid = centered_grid((512, 512, 900), (1.0, 1.0, 1.0), frame_of_reference_uid=_for("huge"))
    return Dataset(
        dataset_id="huge",
        description="512×512×900。記憶體分級與降採樣邏輯。",
        study_id=_study("huge"),
        series=(_ct_series("huge", grid),),
        verifies=("記憶體分級", "後端決定網格"),
        notes={"raw_int16_bytes": 512 * 512 * 900 * 2},
    )


def many_structs(count: int = 182) -> Dataset:
    """182 個結構 —— 圖層批次開關、LRU 逐出、mask 裁切策略。"""
    grid = centered_grid((256, 256, 64), (1.5, 1.5, 3.0), frame_of_reference_uid=_for("many"))
    f = grid.frame_of_reference_uid
    rng = np.random.default_rng(20260903)
    structures: list[DatasetStructure] = [
        DatasetStructure(
            "body",
            "BODY",
            Ellipsoid((0.0, 0.0, 0.0), (180.0, 150.0, 90.0)),
            (200, 180, 160),
            f,
            "External",
            default_visible=False,
        )
    ]
    for n in range(count - 1):
        center = rng.uniform(-120.0, 120.0, size=3)
        center[2] = rng.uniform(-70.0, 70.0)
        radius = float(rng.uniform(4.0, 14.0))
        structures.append(
            DatasetStructure(
                structure_id=f"struct_{n:03d}",
                name=f"Organ_{n:03d}",
                shape=Sphere(tuple(float(v) for v in center), radius),  # type: ignore[arg-type]
                color_rgb=(int(rng.integers(60, 256)), int(rng.integers(60, 256)), int(rng.integers(60, 256))),
                frame_of_reference_uid=f,
                default_visible=n < 20,
            )
        )
    return Dataset(
        dataset_id="many_structs",
        description=f"{count} 個結構（多數為小球體）。圖層批次開關、LRU 逐出、mask 裁切。",
        study_id=_study("many_structs"),
        series=(_ct_series("many_structs", grid),),
        structures=tuple(structures),
        verifies=("圖層與 LRU", "同時可見結構數上限", "多結構下的 mask 裁切"),
    )


def four_d_ct() -> Dataset:
    """⚠️ **最初的假體清單之外，本實作補上的假體。**

    時間軸必須與幾何契約同時納入，但原本的清單沒有任何帶時間軸的假體——
    `temporal_groups`、`frame` 參數、以及 mask 的 `(structure_id, frame_index)`
    鍵**沒有東西可以測**。網格刻意做小（10 相位已經是 10 倍資料量）。
    """
    grid = centered_grid((96, 96, 32), (2.0, 2.0, 3.0), frame_of_reference_uid=_for("four_d"))
    tg = TemporalGroup(temporal_group_id="tg_resp", kind="cyclic", frame_count=FOUR_D_FRAMES)
    return Dataset(
        dataset_id="four_d_ct",
        description=f"{FOUR_D_FRAMES} 個呼吸相位，共享網格與 FoR（T1 週期相位軸）。",
        study_id=_study("four_d_ct"),
        series=(
            DatasetSeries(
                series_id=_series("four_d_ct"),
                grid=grid,
                role="primary",
                modality="CT",
                image=images.torso,
                temporal_group_id=tg.temporal_group_id,
            ),
        ),
        structures=(
            DatasetStructure(
                structure_id="gtv_4d",
                name="GTV",
                tg263_code="GTV",
                shape=Sphere((0.0, 0.0, 0.0), 15.0),
                color_rgb=(255, 0, 0),
                frame_of_reference_uid=grid.frame_of_reference_uid,
                temporal_group_id=tg.temporal_group_id,
                per_frame_shift_mm=(0.0, 0.0, 6.0),
            ),
        ),
        temporal_groups=(tg,),
        verifies=(
            "時間軸屬於幾何契約",
            "image/mask/mesh/edit/postprocess 都接受 frame",
            "mask 的鍵是 (structure_id, frame_index)",
        ),
    )


BUILDERS: dict[str, object] = {
    "axial_clean": axial_clean,
    "gantry_tilt": gantry_tilt,
    "oblique_acq": oblique_acq,
    "anisotropic": anisotropic,
    "landmark": landmark,
    "known_geometry": known_geometry,
    "overlap_set": overlap_set,
    "laterality": laterality,
    "two_series": two_series,
    "huge": huge,
    "many_structs": many_structs,
    "four_d_ct": four_d_ct,
}
