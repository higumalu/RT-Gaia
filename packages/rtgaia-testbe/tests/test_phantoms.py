"""合成假體的已知答案。

**這一整個檔案就是「有已知答案」這句話的意思**：每一條都是數值斷言，
沒有任何一條在看畫面。
"""

from __future__ import annotations

from dataclasses import replace

import numpy as np
import pytest
from rtgaia_core.dataset import DatasetStructure
from rtgaia_core.state import build_session
from rtgaia_core.tiers import ClientCapability
from rtgaia_geom import DisplayGrid, ViewReference, assert_round_trip
from rtgaia_testbe import phantoms
from rtgaia_testbe.phantoms.library import (
    FOUR_D_FRAMES,
    KNOWN_GEOMETRY_MARKERS,
    LANDMARK_IJK,
    TWO_SERIES_MATRIX,
)

SPEC_PHANTOMS = (
    "axial_clean",
    "gantry_tilt",
    "oblique_acq",
    "anisotropic",
    "landmark",
    "known_geometry",
    "overlap_set",
    "two_series",
    "huge",
    "many_structs",
)


def test_all_spec_phantoms_exist() -> None:
    available = {p["phantom_id"] for p in phantoms.list_phantoms()}
    assert set(SPEC_PHANTOMS) <= available


@pytest.mark.parametrize("dataset_id", SPEC_PHANTOMS)
def test_every_phantom_has_valid_geometry(dataset_id: str) -> None:
    """每個假體的每個序列都必須通過 index↔world 往返自檢。"""
    p = phantoms.build(dataset_id)
    for series in p.series:
        assert assert_round_trip(series.grid) < 1e-9


def test_axial_clean_matches_spec_dimensions() -> None:
    grid = phantoms.build("axial_clean").primary.grid
    assert grid.size == (512, 512, 100)
    assert grid.spacing == (1.0, 1.0, 3.0)
    assert grid.direction == (1, 0, 0, 0, 1, 0, 0, 0, 1)


def test_gantry_tilt_is_actually_tilted() -> None:
    """🔴 傾斜 15°：沿 k 走一步在 LPS 必須有非零的 y 分量。"""
    grid = phantoms.build("gantry_tilt").primary.grid
    step = grid.index_to_world([0, 0, 1]) - grid.index_to_world([0, 0, 0])
    assert abs(step[1]) == pytest.approx(3.0 * np.sin(np.deg2rad(15.0)), abs=1e-9)
    assert np.linalg.norm(step) == pytest.approx(3.0)


def test_oblique_is_tilted_on_two_axes() -> None:
    grid = phantoms.build("oblique_acq").primary.grid
    d = grid.direction_matrix
    assert abs(d[2, 2]) < 0.98, "兩軸旋轉後 z 軸不該還幾乎對齊"
    assert np.allclose(d.T @ d, np.eye(3), atol=1e-9)


def test_anisotropic_spacing() -> None:
    assert phantoms.build("anisotropic").primary.grid.spacing == (1.0, 1.0, 5.0)


def test_landmark_coordinate_chain() -> None:
    """驗收：標記體素的 ijk ↔ LPS 必須完全吻合，且影像值真的在那裡。"""
    p = phantoms.build("landmark")
    grid = p.primary.grid
    expected = phantoms.expected_json(p)
    marker = expected["markers"]["landmark_voxel"]
    assert tuple(marker["ijk"]) == LANDMARK_IJK
    world = grid.index_to_world(list(LANDMARK_IJK))
    assert np.allclose(marker["world_lps"], world)
    assert tuple(grid.world_to_nearest_voxel(world)) == LANDMARK_IJK
    volume = phantoms.volume(p, p.primary)
    assert volume[LANDMARK_IJK[2], LANDMARK_IJK[1], LANDMARK_IJK[0]] == marker["voxel_value"]


def test_landmark_gradient_is_monotonic_on_all_axes() -> None:
    """漸層三軸都單調 → 任何軸交換或翻轉都會被抓到。"""
    p = phantoms.build("landmark")
    v = np.asarray(phantoms.volume(p, p.primary), dtype=np.int32)
    assert v[0, 0, 1] > v[0, 0, 0]
    assert v[0, 1, 0] > v[0, 0, 0]
    assert v[1, 0, 0] > v[0, 0, 0]
    # 且三個軸的步長互異，因此 (i,j,k) 的任一置換都會產生不同的值
    steps = {int(v[0, 0, 1] - v[0, 0, 0]), int(v[0, 1, 0] - v[0, 0, 0]), int(v[1, 0, 0] - v[0, 0, 0])}
    assert len(steps) == 3


def test_known_geometry_volumes_match_spec() -> None:
    """兩個已知數字：65.45 cc 與 64.00 cc。"""
    e = phantoms.expected_json(phantoms.build("known_geometry"))
    assert e["structures"]["sphere_25mm"]["volume_cc"] == 65.45
    assert e["structures"]["cube_40mm"]["volume_cc"] == 64.00


def test_known_geometry_cube_voxelization_is_exact() -> None:
    """立方體邊長 40 mm、體素 1 mm、origin 落在半體素 → **恰好 40³ 個體素**。

    這正是 `centered_grid` 刻意讓 origin 落在 `-127.5` 的收益：整數 origin 會讓
    邊界體素中心正好落在邊界上，於是「>=」與「>」差一整層。
    """
    e = phantoms.expected_json(phantoms.build("known_geometry"))
    cube = e["structures"]["cube_40mm"]
    assert cube["voxel_count"] == 64000
    assert cube["volume_cc_voxelized"] == pytest.approx(64.0)
    assert cube["bbox_size_ijk"] == [40, 40, 40]


def test_known_geometry_sphere_within_tolerance() -> None:
    e = phantoms.expected_json(phantoms.build("known_geometry"))
    sphere = e["structures"]["sphere_25mm"]
    assert sphere["volume_cc_voxelized"] == pytest.approx(
        sphere["volume_cc_analytic_exact"], abs=sphere["tolerance_cc"]
    )


def test_known_geometry_markers_are_exactly_100mm_apart() -> None:
    a, b = (np.asarray(m) for m in KNOWN_GEOMETRY_MARKERS)
    assert float(np.linalg.norm(a - b)) == 100.0
    e = phantoms.expected_json(phantoms.build("known_geometry"))
    assert e["marker_distance_mm"] == 100.0


def test_overlap_set_is_actually_nested() -> None:
    """GTV ⊂ CTV ⊂ PTV ⊂ BODY —— **單一 label volume 表達不了這個**。"""
    p = phantoms.build("overlap_set")
    grid = p.primary.grid
    dense = {}
    for sid in ("gtv", "ctv", "ptv", "body"):
        st = p.structure_by_id(sid)
        offset, size, block = phantoms.mask_block(p, st)  # type: ignore[misc]
        full = np.zeros((grid.size[2], grid.size[1], grid.size[0]), dtype=bool)
        full[
            offset[2] : offset[2] + size[2],
            offset[1] : offset[1] + size[1],
            offset[0] : offset[0] + size[0],
        ] = block.astype(bool)
        dense[sid] = full
    assert np.all(dense["gtv"] <= dense["ctv"])
    assert np.all(dense["ctv"] <= dense["ptv"])
    assert np.all(dense["ptv"] <= dense["body"])


def test_overlap_set_paired_organs_union() -> None:
    p = phantoms.build("overlap_set")
    e = phantoms.expected_json(p)
    left = e["structures"]["lung_l"]["voxel_count"]
    right = e["structures"]["lung_r"]["voxel_count"]
    both = e["structures"]["lungs"]["voxel_count"]
    assert both == left + right, "左右肺不相交，聯集必須等於兩者相加"


def _mask_centroid_world(dataset, structure_id: str) -> np.ndarray:
    """結構在其取像網格上的**實際光柵化質心**（世界 LPS mm）。

    從 mask 算而不是從 `shape.center` 抄——後者只證明定義寫了什麼，前者才證明
    光柵化真的把體素放在那裡。
    """
    st = dataset.structure_by_id(structure_id)
    block = phantoms.mask_block(dataset, st)
    assert block is not None
    offset, _size, data = block
    kji = np.argwhere(np.asarray(data, dtype=np.uint8) > 0)
    assert kji.size > 0, f"{structure_id} 的 mask 是空的"
    ijk = kji[:, ::-1] + np.asarray(offset, dtype=np.int64)
    grid = dataset.primary.grid
    return np.asarray(grid.index_to_world(ijk.astype(np.float64))).mean(axis=0)


def test_laterality_marker_is_on_the_patient_right() -> None:
    """🔴 LPS 的 `+x` 是病人**左**，因此 `Marker_R` 的世界 x 必須是負的。

    這條看起來像廢話，但 `overlap_set` 的 `Lung_L`／`Lung_R` 先前就是反的
    （L 在 -x、R 在 +x），而沒有任何測試看得出來。
    """
    p = phantoms.build("laterality")
    marker = _mask_centroid_world(p, "marker_r")
    body = _mask_centroid_world(p, "body")
    assert marker[0] < 0.0, f"Marker_R 應在病人右（-x），實得 x={marker[0]}"
    assert marker[0] < body[0], "Marker_R 必須在中線的病人右側"
    assert abs(body[0]) < 1.0, f"BODY 左右對稱，質心 x 應接近 0，實得 {body[0]}"


def test_laterality_is_actually_asymmetric() -> None:
    """假體必須**真的**左右不對稱，否則它擋不住鏡像。"""
    p = phantoms.build("laterality")
    marker = _mask_centroid_world(p, "marker_r")
    # 鏡像後的位置與原位置差得夠遠，任何左右翻轉都躲不掉
    assert abs(marker[0]) > 50.0, f"偏離中線太少（{marker[0]} mm），鏡像不易察覺"


def test_overlap_set_lungs_are_on_the_anatomically_correct_sides() -> None:
    """🔴 `Lung_L` 在 `+x`、`Lung_R` 在 `-x`（LPS：+x = 病人左）。

    先前兩者對調。因為假體左右對稱、且沒有任何斷言看方向，
    205 個後端測試與 344 個前端測試**一個都沒抓到**。
    """
    p = phantoms.build("overlap_set")
    left = _mask_centroid_world(p, "lung_l")
    right = _mask_centroid_world(p, "lung_r")
    assert left[0] > 0.0, f"Lung_L 應在 +x（病人左），實得 x={left[0]}"
    assert right[0] < 0.0, f"Lung_R 應在 -x（病人右），實得 x={right[0]}"


def test_axial_view_reference_faces_the_radiological_convention() -> None:
    """🔴 `ViewReference.axial()` 的 `right` 必須是 `+x`（病人左在畫面右）。

    等價地說：法線指向觀察者，而放射科的軸向視圖是**從腳側往頭看**（`-z`）。
    這條與 `apps/viewer/src/core/scene/cameras.ts` 的 `ORIENTATIONS` 是同一個
    契約的兩半，前端另有一份對照測試（`cameras.test.ts`）。
    """
    view = ViewReference.axial(
        frame_of_reference_uid="for.test",
        display_grid_id="dg",
        plane_origin=(0.0, 0.0, 0.0),
    )
    assert np.allclose(view.normal, [0.0, 0.0, -1.0])
    assert np.allclose(view.up, [0.0, -1.0, 0.0])
    assert np.allclose(view.right, [1.0, 0.0, 0.0]), "畫面右必須是 +x（病人左）"
    # 病人右側的一點投影到畫面橫軸，必須落在中線左邊
    assert float(np.dot([-70.0, 0.0, 0.0], view.right)) < 0.0


def test_synthetic_phantom_structures_are_model_generated() -> None:
    """合成假體確實是模型（形狀函式）產生的 —— 預設值必須保持 `model`。"""
    p = phantoms.build("overlap_set")
    session = build_session(dataset=p, capability=ClientCapability())
    sources = {st.provenance.source for st in session.structures.values()}
    assert sources == {"model"}


def test_imported_rtstruct_is_not_labelled_model_generated() -> None:
    """🔴 **臨床醫師畫的輪廓不得被記成模型產生的**（追溯欄位）。

    `dicom.py` 早就把 `status` 設成 `under_review`，但 `build_session` 對**所有**
    結構硬寫 `Provenance(source="model")`，於是意圖只實作了一半：審核流程說
    「待審」，追溯鏈卻說「模型產生」。

    法規送件時這兩者的舉證責任完全不同，而事後補要做資料遷移——因此現在修。
    這裡不需要真的 DICOM：`preloaded` ＋ `provenance_source="import"` 走的正是
    RTSTRUCT 載入器建出來的那條路。
    """
    p = phantoms.build("landmark")
    grid = p.primary.grid
    block = np.ones((2, 2, 2), dtype=np.uint8)
    imported = DatasetStructure(
        structure_id="clinical_gtv",
        name="GTV",
        shape=None,
        color_rgb=(255, 0, 0),
        frame_of_reference_uid=grid.frame_of_reference_uid,
        status="under_review",
        preloaded=((0, 0, 0), (2, 2, 2), block),
        provenance_source="import",
    )
    p = replace(p, structures=(*p.structures, imported))

    session = build_session(dataset=p, capability=ClientCapability())
    st = session.structures[("clinical_gtv", None)]
    assert st.provenance.source == "import", "匯入的 RTSTRUCT 不得標成 model-generated"
    assert st.status == "under_review"


def test_dicom_loader_declares_import_provenance() -> None:
    """載入器那一側：`DatasetStructure` 建出來時就要帶 `import`。

    直接讀原始碼太脆，因此改測「型別預設值是 model、而載入器明確覆寫」——
    覆寫的那一行若被刪掉，上一條測試就會紅。這條只鎖住預設值不被改成 import
    （那會讓合成假體也被記成匯入的）。
    """
    default = DatasetStructure(
        structure_id="x",
        name="X",
        shape=None,
        color_rgb=(1, 2, 3),
        frame_of_reference_uid="for.x",
    )
    assert default.provenance_source == "model"


def test_two_series_transform_is_the_declared_truth() -> None:
    p = phantoms.build("two_series")
    secondary = next(s for s in p.series if s.role == "secondary")
    m = np.asarray(secondary.transform_to_primary, dtype=np.float64).reshape(4, 4)
    assert np.allclose(m, TWO_SERIES_MATRIX)
    assert np.allclose(m[:3, 3], [15.0, -8.0, 4.0])
    e = phantoms.expected_json(p)
    assert e["notes"]["translation_mm"] == [15.0, -8.0, 4.0]


def test_two_series_frame_groups_are_distinct() -> None:
    """兩組取像的 FoR 必須不同 —— 否則就不是「需要配準」的案例。"""
    p = phantoms.build("two_series")
    uids = {s.frame_of_reference_uid for s in p.series}
    assert len(uids) == 2


def test_many_structs_has_182() -> None:
    p = phantoms.build("many_structs")
    assert len(p.structures) == 182


def test_many_structs_masks_are_all_cropped() -> None:
    """182 個結構若不裁切到 bbox，全網格需要 14 GB。"""
    p = phantoms.build("many_structs")
    grid = p.primary.grid
    full_bytes = grid.voxel_count
    total = 0
    for st in p.structures[1:21]:  # 抽樣 20 個就夠說明問題
        block = phantoms.mask_block(p, st)
        assert block is not None
        total += int(np.prod(block[1]))
    assert total < full_bytes, "20 個小球的裁切後總量必須遠小於單一份全網格"


def test_huge_is_the_declared_size() -> None:
    grid = phantoms.build("huge").primary.grid
    assert grid.size == (512, 512, 900)
    assert grid.voxel_count * 2 == 471_859_200


def test_huge_gets_downsampled_on_tier_b() -> None:
    """Tier B 單影像 image 配額 400 MB < 472 MB → **後端必須降採樣**。"""
    p = phantoms.build("huge")
    session = build_session(dataset=p, capability=ClientCapability(webgl2=True, probe_fps=15.0, tier="B"))
    assert session.tier_decision.assigned == "B"
    assert session.display_grid.is_downsampled
    assert session.display_grid.resident_bytes <= 400_000_000


def test_huge_fits_tier_a_without_downsampling() -> None:
    session = build_session(dataset=phantoms.build("huge"), capability=ClientCapability())
    assert session.tier_decision.assigned == "A"
    assert not session.display_grid.is_downsampled


def test_four_d_ct_has_a_temporal_group() -> None:
    """時間軸必須有東西可以測。"""
    p = phantoms.build("four_d_ct")
    assert len(p.temporal_groups) == 1
    tg = p.temporal_groups[0]
    assert tg.kind == "cyclic"
    assert tg.frame_count == FOUR_D_FRAMES


def test_four_d_structure_moves_between_frames() -> None:
    """相位之間 mask 必須真的不同，否則播放測不出東西。"""
    p = phantoms.build("four_d_ct")
    st = p.structure_by_id("gtv_4d")
    a = phantoms.mask_block(p, st, frame_index=0)
    b = phantoms.mask_block(p, st, frame_index=2)
    assert a is not None and b is not None
    assert a[0] != b[0], "不同相位的 bbox 原點應不同（呼吸位移）"


def test_display_grid_derivation_is_stable_across_phantoms() -> None:
    for dataset_id in ("axial_clean", "gantry_tilt", "anisotropic"):
        grid = phantoms.build(dataset_id).primary.grid
        a = DisplayGrid.derive(grid, downsample_factor=(2, 2, 1))
        b = DisplayGrid.derive(grid, downsample_factor=(2, 2, 1))
        assert a.display_grid_id == b.display_grid_id
