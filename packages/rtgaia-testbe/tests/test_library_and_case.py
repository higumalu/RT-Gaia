"""資料庫索引、多物件病例組裝、每 FrameGroup 一個 MaskGrid、劑量、REG。

全部跑在 `synth_dicom.write_synth_case()` 產生的合成病例上（沒有病人資料）。
"""

from __future__ import annotations

from pathlib import Path

import numpy as np
import pytest
from rtgaia_core.library import LibraryIndex
from rtgaia_core.loaders.case import CaseSelection, build_case_dataset, choose_primary, select_all
from rtgaia_core.loaders.registration import read_registration, resolve
from rtgaia_core.loaders.rtdose import read_dose_header, read_dose_pixels
from rtgaia_core.loaders.rtstruct import fill_polygon
from rtgaia_core.state import build_session
from rtgaia_core.tiers import ClientCapability
from rtgaia_geom import ContractViolation, GridSet, decode
from rtgaia_testbe import Session
from synth_dicom import SynthCase, write_synth_case


@pytest.fixture(scope="module")
def synth(tmp_path_factory) -> SynthCase:
    return write_synth_case(tmp_path_factory.mktemp("synth"))


@pytest.fixture(scope="module")
def index(synth: SynthCase) -> LibraryIndex:
    return LibraryIndex.scan(synth.root, use_cache=False)


# ── 索引 ─────────────────────────────────────────────────────────────────────


def test_index_groups_series_and_resolves_links(index: LibraryIndex, synth: SynthCase) -> None:
    """勾一個 CT，它的 RS／DOSE／REG／PLAN 要能自動帶入（`links.bundle`）。"""
    assert index.summary()["modalities"] == {"CT": 2, "RTSTRUCT": 2, "RTDOSE": 2, "RTPLAN": 1, "REG": 1}
    plan_ct = index.series[synth.plan_ct.series_uid]
    assert plan_ct.links["bundle"] == {
        "structure_sets": [synth.plan_rs_uid],
        "doses": [synth.plan_dose_uid],
        "registrations": [synth.reg_uid],
        "plans": [synth.plan_uid],
    }
    cbct = index.series[synth.cbct.series_uid]
    assert cbct.links["bundle"]["structure_sets"] == [synth.cbct_rs_uid]
    assert cbct.links["bundle"]["doses"] == [synth.cbct_dose_uid]
    assert cbct.links["bundle"]["registrations"] == [synth.reg_uid]
    # 劑量 → 計畫 → 結構集 → 影像 這條鏈
    dose = index.series[synth.plan_dose_uid]
    assert dose.links["plan_label"] == "SYNTH-ART1"
    assert dose.links["prescription_gy"] == [50.0]
    assert dose.links["image_series_uid"] == synth.plan_ct.series_uid
    # 沒有計畫的分次劑量退回同 FoR 的影像
    assert index.series[synth.cbct_dose_uid].links["image_series_uid"] == synth.cbct.series_uid


def test_index_search_filters(index: LibraryIndex, synth: SynthCase) -> None:
    by_patient = index.search(patient_id="synth-0001")
    assert len(by_patient) == len(index.series)
    assert index.search(patient_id="nobody") == []
    dated = index.search(date_from="2026-06-03", date_to="20260605")
    assert {s.series_instance_uid for s in dated} == {
        synth.cbct.series_uid,
        synth.cbct_rs_uid,
        synth.cbct_dose_uid,
        synth.reg_uid,
    }
    assert [s.modality for s in index.search(modality="rtplan")] == ["RTPLAN"]
    # description 同時比對 label：臨床找的是「那個 ART 計畫」
    assert {s.modality for s in index.search(description="ART_2026")} == {"RTSTRUCT"}
    assert {s.modality for s in index.search(description="synth-art1")} == {"RTPLAN"}


def test_index_tree_hides_patient_name_by_default(index: LibraryIndex) -> None:
    """預設只送 PatientID。"""
    tree = index.tree(show_names=False)
    assert len(tree["patients"]) == 1
    patient = tree["patients"][0]
    assert patient["patient_id"] == "SYNTH-0001"
    assert "patient_name" not in patient
    assert all("patient_name" not in s for st in patient["studies"] for s in st["series"])
    named = index.tree(show_names=True)["patients"][0]
    assert named["patient_name"] == "Synthetic^Case"


def test_index_cache_round_trips(synth: SynthCase, tmp_path: Path) -> None:
    first = LibraryIndex.scan(synth.root, cache_dir=tmp_path)
    cached = LibraryIndex.scan(synth.root, cache_dir=tmp_path)
    assert {s.series_instance_uid for s in cached.series.values()} == {
        s.series_instance_uid for s in first.series.values()
    }
    assert cached.series[synth.plan_ct.series_uid].links == first.series[synth.plan_ct.series_uid].links


# ── 載入器 ───────────────────────────────────────────────────────────────────


def test_registration_matrix_direction_and_layout(synth: SynthCase) -> None:
    """🔴 REG item 的矩陣是 item FoR → REG FoR（B→A），row-major；轉錯任一個都會 fail。"""
    reg = read_registration(synth.root / "fx_1" / "registration.dcm")
    assert reg.frame_of_reference_uid == synth.plan_ct.frame_of_reference_uid
    item = reg.item_for(synth.cbct.frame_of_reference_uid)
    assert item is not None and item.matrix_type == "RIGID"
    assert np.allclose(item.matrix_row_major, synth.matrix_b_to_a, atol=1e-9)
    resolved = resolve(
        [reg], source_for=synth.cbct.frame_of_reference_uid, primary_for=synth.plan_ct.frame_of_reference_uid
    )
    assert resolved is not None
    assert np.allclose(resolved.matrix_row_major, synth.matrix_b_to_a)
    assert resolved.info.source == "REG" and resolved.info.sop_instance_uid == synth.reg_sop_uid
    # 反向：以 CBCT 為 primary 時要得到逆矩陣
    inv = resolve([reg], source_for=synth.plan_ct.frame_of_reference_uid, primary_for=synth.cbct.frame_of_reference_uid)
    assert inv is not None and np.allclose(inv.matrix_row_major, np.linalg.inv(synth.matrix_b_to_a))
    assert resolve([reg], source_for="for.unknown", primary_for=synth.plan_ct.frame_of_reference_uid) is None


def test_rtdose_grid_and_scaling(synth: SynthCase) -> None:
    """劑量網格由 IPP／GFOV 算出；像素乘 DoseGridScaling 才是 Gy；遞減 GFOV 反轉法線。"""
    h = read_dose_header(synth.root / "plan_0" / "dose.dcm")
    truth = synth.plan_dose_grid
    assert h.grid.size == truth["size"]
    assert h.grid.spacing == truth["spacing"]
    assert np.allclose(h.grid.origin, truth["origin"])
    assert h.units == "GY" and h.summation_type == "PLAN"
    assert list(h.referenced_plan_sop_uids) == [synth.plan_sop_uid]
    px = read_dose_pixels(h)
    assert px.dtype == np.float32 and px.shape == (6, 7, 8)
    assert abs(float(px.max()) - synth.plan_dose_max_gy) < 1e-4
    # 分次劑量：GFOV 遞減 → 法線 (0,0,-1)、origin 落在第一個 frame
    h2 = read_dose_header(synth.root / "fx_1" / "dose.dcm")
    assert np.allclose(np.asarray(h2.grid.direction).reshape(3, 3)[:, 2], [0, 0, -1])
    assert h2.grid.spacing[2] == 2.0


def test_fill_polygon_matches_even_odd_reference() -> None:
    """自寫的掃描線填充：像素中心在多邊形內即為內部，與參考實作逐像素一致。"""
    rng = np.random.default_rng(7)
    from skimage.draw import polygon as reference_polygon  # 先前的實作，只在測試裡當參考

    for _ in range(50):
        n = int(rng.integers(3, 10))
        ang = np.sort(rng.uniform(0, 2 * np.pi, n))
        r = rng.uniform(3, 25, n)
        cx, cy = rng.uniform(15, 50, 2)
        xs, ys = cx + r * np.cos(ang), cy + r * np.sin(ang)
        ours = fill_polygon(xs, ys, (64, 64))
        rr, cc = reference_polygon(ys, xs, shape=(64, 64))
        ref = np.zeros((64, 64), dtype=bool)
        ref[rr, cc] = True
        # 邊界上的像素兩邊的半開規則可能不同；只允許極少數邊界差異
        disagree = ours ^ ref
        assert disagree.sum() <= 0.02 * max(1, ref.sum()), disagree.sum()
    # 洞：外框 XOR 內框
    outer = fill_polygon(np.array([0, 10, 10, 0.0]), np.array([0, 0, 10, 10.0]), (12, 12))
    inner = fill_polygon(np.array([3, 7, 7, 3.0]), np.array([3, 3, 7, 7.0]), (12, 12))
    assert (outer ^ inner).sum() == outer.sum() - inner.sum() == 84


# ── 病例組裝 ─────────────────────────────────────────────────────────────────


def test_case_builds_two_frame_groups_with_own_mask_grids(index: LibraryIndex, synth: SynthCase) -> None:
    """每個影像序列一個 FrameGroup、一個 MaskGrid；劑量借用同 FoR 的 FrameGroup。"""
    dataset = build_case_dataset(index, select_all(index))
    assert dataset.primary.series_id == synth.plan_ct.series_uid, "primary 應由 RTPLAN／RTDOSE 參照鏈決定"
    kinds = [(s.kind, s.role, s.modality) for s in dataset.series]
    assert kinds == [
        ("image", "primary", "CT"),
        ("dose", "primary", "RTDOSE"),
        ("image", "secondary", "CBCT"),  # Halcyon 機型字串 → CBCT
        ("dose", "secondary", "RTDOSE"),
    ]
    cbct = next(s for s in dataset.series if s.kind == "image" and s.role == "secondary")
    assert cbct.registration is not None and cbct.registration.source == "REG"
    assert np.allclose(np.asarray(cbct.transform_to_primary).reshape(4, 4), synth.matrix_b_to_a)
    assert dataset.notes["case"]["warnings"] == []

    session = build_session(dataset=dataset, capability=ClientCapability(), source="test")
    gs = session.grid_set
    assert len(gs.frame_groups) == 2, "劑量不擁有 FrameGroup"
    assert len(gs.mask_grids) == 2
    primary_fg, secondary_fg = gs.primary, gs.frame_group(synth.cbct.frame_of_reference_uid)
    assert primary_fg.mask_grid_id == gs.mask_grid.mask_grid_id
    assert secondary_fg.mask_grid_id != primary_fg.mask_grid_id
    assert gs.mask_grid_for(synth.cbct.frame_of_reference_uid).grid.size == synth.cbct.size
    assert secondary_fg.transform_kind == "rigid" and secondary_fg.registration is not None
    # wire round trip 帶著新欄位
    again = GridSet.from_wire(gs.to_wire())
    assert again.frame_group(synth.cbct.frame_of_reference_uid).mask_grid_id == secondary_fg.mask_grid_id


def test_case_structures_rasterize_on_their_own_grid(index: LibraryIndex, synth: SynthCase) -> None:
    """CBCT 的 RTSTRUCT 光柵化在 CBCT 網格上：體積 ≈ 球體積，且 id 不與 primary 的 BODY 撞。"""
    dataset = build_case_dataset(index, select_all(index))
    ids = [s.structure_id for s in dataset.structures]
    assert "BODY" in ids and "PTV" in ids
    cbct_body = next(s for s in dataset.structures if s.structure_id.endswith("_BODY"))
    assert cbct_body.frame_of_reference_uid == synth.cbct.frame_of_reference_uid
    assert cbct_body.provenance_source == "import" and cbct_body.status == "under_review"
    offset, size, block = cbct_body.preloaded
    voxel_cc = float(np.prod(synth.cbct.spacing)) / 1000.0
    volume = block.sum() * voxel_cc
    sphere = 4 / 3 * np.pi * synth.cbct.sphere_radius_mm**3 / 1000.0
    assert abs(volume - sphere) / sphere < 0.25, (volume, sphere)
    # primary 的球用 A 座標，體積也對
    body = next(s for s in dataset.structures if s.structure_id == "BODY")
    volume_a = body.preloaded[2].sum() * float(np.prod(synth.plan_ct.spacing)) / 1000.0
    sphere_a = 4 / 3 * np.pi * synth.plan_ct.sphere_radius_mm**3 / 1000.0
    assert abs(volume_a - sphere_a) / sphere_a < 0.25


def test_case_sphere_centroid_maps_through_registration(index: LibraryIndex, synth: SynthCase) -> None:
    """跨 FoR 對位的資料面：CBCT 結構的質心經 M_B→A 後落在計畫 CT 的球心。"""
    dataset = build_case_dataset(index, select_all(index))
    session = build_session(dataset=dataset, capability=ClientCapability(), source="test")
    cbct_fg = session.grid_set.frame_group(synth.cbct.frame_of_reference_uid)
    st = next(s for s in session.structures.values() if s.structure_id.endswith("_BODY"))
    grid = session.grid_for_frame(st.frame_of_reference_uid)
    kji = np.argwhere(st.dense(grid) > 0)
    ijk = kji[:, ::-1].astype(float)
    centroid_b = grid.index_to_world(ijk).mean(axis=0)
    centroid_a = cbct_fg.to_primary_world(centroid_b)
    assert np.allclose(centroid_a, synth.plan_ct.sphere_center_world, atol=1.0), centroid_a


def test_case_without_registration_is_flagged_not_silently_aligned(index: LibraryIndex, synth: SynthCase) -> None:
    """找不到 REG → 單位矩陣 ＋ `registration.source='none'` ＋ warning；**不得默默當成已對位**。"""
    sel = select_all(index)
    sel.registration_uids = []
    dataset = build_case_dataset(index, sel)
    cbct = next(s for s in dataset.series if s.kind == "image" and s.role == "secondary")
    assert cbct.transform_to_primary is None
    assert cbct.registration is not None and cbct.registration.source == "none"
    assert any("找不到" in w for w in dataset.notes["case"]["warnings"])


def test_case_primary_can_be_forced_and_must_be_selected(index: LibraryIndex, synth: SynthCase) -> None:
    sel = select_all(index)
    sel.primary_series_uid = synth.cbct.series_uid
    assert choose_primary(index, sel) == synth.cbct.series_uid
    dataset = build_case_dataset(index, sel)
    assert dataset.primary.series_id == synth.cbct.series_uid
    planct = next(s for s in dataset.series if s.series_id == synth.plan_ct.series_uid)
    assert np.allclose(np.asarray(planct.transform_to_primary).reshape(4, 4), np.linalg.inv(synth.matrix_b_to_a))
    sel.primary_series_uid = "not.selected"
    with pytest.raises(ContractViolation, match="CS1"):
        choose_primary(index, sel)
    with pytest.raises(ContractViolation, match="CS2"):
        choose_primary(index, CaseSelection())


def test_legacy_ct_directory_still_loads_with_sibling_rtstruct(synth: SynthCase) -> None:
    """`dicom:/case/CT` 這條舊路：影像目錄旁邊放檔案的 RTSTRUCT 也要找得到。"""
    from rtgaia_core.loaders.dicom import load_dicom_dataset

    dataset = load_dicom_dataset(synth.root / "plan_0" / "CT")
    assert [s.kind for s in dataset.series] == ["image"]
    assert {s.structure_id for s in dataset.structures} == {"BODY", "PTV"}


# ── API ──────────────────────────────────────────────────────────────────────


@pytest.fixture
def lib_driver(synth: SynthCase):
    with Session(library_root=str(synth.root)) as s:
        yield s


def test_library_endpoints(lib_driver: Session, synth: SynthCase) -> None:
    summary = lib_driver.library()
    assert summary["configured"] is True and summary["series_count"] == 8
    patients = lib_driver.library_patients()
    assert patients[0]["patient_id"] == "SYNTH-0001" and "patient_name" not in patients[0]
    tree = lib_driver.library_series(modality="CT")
    assert tree["total"] == 2
    series = tree["patients"][0]["studies"][0]["series"]
    assert all(s["is_image"] for s in series)
    assert "bundle" in series[0]["links"]
    assert lib_driver.library_series(patient_id="nobody")["total"] == 0
    assert lib_driver.rescan_library()["series_count"] == 8


def test_library_not_configured_is_404_not_500() -> None:
    with Session(library_root="") as s:
        assert s.library() == {"configured": False, "root": None}
        with pytest.raises(RuntimeError, match="404"):
            s.library_series()


def test_sessions_endpoint_builds_scene_with_dose_layers_and_per_frame_mask_grids(
    lib_driver: Session, synth: SynthCase
) -> None:
    """`POST /sessions` 與 `_test/load` 同形；scene 裡有 `kind:'dose'` 圖層與兩個 mask grid。"""
    out = lib_driver.load_case(
        {
            "image_series_uids": [synth.plan_ct.series_uid, synth.cbct.series_uid],
            "structure_set_uids": [synth.plan_rs_uid, synth.cbct_rs_uid],
            "dose_uids": [synth.plan_dose_uid, synth.cbct_dose_uid],
            "registration_uids": [synth.reg_uid],
            "plan_uids": [synth.plan_uid],
        },
        webgl2=False,
        tier="C",
    )
    assert out["source"].startswith("library:")
    assert out["warnings"] == []
    scene = out["scene"]
    layers = scene["layers"]
    assert [layer["kind"] for layer in layers if layer["kind"] != "mask"] == ["image", "dose", "image", "dose"]
    dose = next(layer for layer in layers if layer["kind"] == "dose")
    assert dose["params"]["units"] == "GY"
    assert abs(dose["params"]["max_gy"] - synth.plan_dose_max_gy) < 1e-3
    assert dose["params"]["referenced_plan_label"] == "SYNTH-ART1"
    assert dose["seriesMeta"]["series_date"] == "20260601"
    image = layers[0]
    assert image["seriesMeta"]["series_description"] == "Pelvis 2.0 synthetic"
    gs = scene["gridSet"]
    assert len(gs["mask_grids"]) == 2
    fgs = {fg["role"]: fg for fg in gs["frame_groups"]}
    assert fgs["secondary"]["registration"]["source"] == "REG"
    assert fgs["secondary"]["mask_grid_id"] in {m["mask_grid_id"] for m in gs["mask_grids"]}
    # 舊欄位仍在：單序列前端不必改
    assert gs["mask_grid"]["mask_grid_id"] == fgs["primary"]["mask_grid_id"]


def test_dose_image_payload_is_float32_gy(lib_driver: Session, synth: SynthCase) -> None:
    """劑量走同一條 `GET /series/{id}/image`：float32、semantics=dose_gy、不四捨五入。"""
    lib_driver.load_case(
        {"image_series_uids": [synth.plan_ct.series_uid], "dose_uids": [synth.plan_dose_uid]}, tier="C", webgl2=False
    )
    header, arr = lib_driver.image(synth.plan_dose_uid)
    assert header["semantics"] == "dose_gy" and header["dtype"] == "float32" and header["kind"] == "dose"
    assert header["modality"] == "RTDOSE"
    assert arr.dtype == np.float32 and arr.shape == (6, 7, 8)
    assert abs(float(arr.max()) - synth.plan_dose_max_gy) < 1e-3
    assert header["grid"]["spacing"] == [4.0, 4.0, 2.0], "劑量不跟著 primary 的降採樣倍率"
    # lod 對劑量仍有效（盒平均、不 rint）
    header2, arr2 = lib_driver.image(synth.plan_dose_uid, lod=1)
    assert header2["grid"]["spacing"] == [8.0, 8.0, 4.0]
    assert 0 < float(arr2.max()) <= float(arr.max())
    assert not np.array_equal(arr2, np.rint(arr2)), "float 劑量被四捨五入了"


def test_secondary_mask_requires_its_own_mask_grid_id(lib_driver: Session, synth: SynthCase) -> None:
    """I3 對次要 FoR 的結構比對的是**它的** MaskGrid；拿 primary 的會 409。"""
    lib_driver.load_case(
        {
            "image_series_uids": [synth.plan_ct.series_uid, synth.cbct.series_uid],
            "structure_set_uids": [synth.plan_rs_uid, synth.cbct_rs_uid],
            "registration_uids": [synth.reg_uid],
        },
        tier="C",
        webgl2=False,
    )
    gs = lib_driver.grid_set
    fgs = {fg["role"]: fg for fg in gs["frame_groups"]}
    cbct_structure = next(
        s["structure_id"]
        for s in lib_driver.structures()
        if s["frame_of_reference_uid"] == synth.cbct.frame_of_reference_uid
    )
    client = lib_driver._client
    wrong = client.get(
        f"/api/v1/structures/{cbct_structure}/mask", params={"mask_grid": fgs["primary"]["mask_grid_id"]}
    )
    assert wrong.status_code == 409 and wrong.json()["detail"]["code"] == "I3"
    right = client.get(
        f"/api/v1/structures/{cbct_structure}/mask", params={"mask_grid": fgs["secondary"]["mask_grid_id"]}
    )
    assert right.status_code == 200
    header, _ = decode(right.content)
    assert header["mask_grid_id"] == fgs["secondary"]["mask_grid_id"]
    assert header["frame_of_reference_uid"] == synth.cbct.frame_of_reference_uid
    # primary 的結構照舊
    primary_structure = next(
        s["structure_id"]
        for s in lib_driver.structures()
        if s["frame_of_reference_uid"] == synth.plan_ct.frame_of_reference_uid
    )
    ok = client.get(f"/api/v1/structures/{primary_structure}/mask", params={"mask_grid": lib_driver.mask_grid_id})
    assert ok.status_code == 200


def test_test_load_dicom_source_takes_whole_directory(synth: SynthCase) -> None:
    """`_test/load {source:'dicom:<病例根目錄>'}` 走同一條病例組裝。"""
    with Session() as s:
        out = s.load(f"dicom:{synth.root}", tier="C", webgl2=False)
        kinds = [layer["kind"] for layer in out["scene"]["layers"] if layer["kind"] != "mask"]
        assert kinds == ["image", "dose", "image", "dose"]
        assert len(out["scene"]["gridSet"]["frame_groups"]) == 2
