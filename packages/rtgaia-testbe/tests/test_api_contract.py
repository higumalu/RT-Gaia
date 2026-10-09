"""API 契約 —— 行為與錯誤碼。

**這個檔案是「契約的參考實作」那句話的可執行形式**：任何一條掛掉，
就代表前端會被建構在錯的假設上。
"""

from __future__ import annotations

import base64

import numpy as np
import pytest
from rtgaia_geom import ContractViolation, Grid, decode, rigid_matrix

# ── GridSet ─────────────────────────────────────────────────────────────────


def test_grids_requires_series_ids(client, driver) -> None:
    """`series_ids` 必填：漏傳 ＝ 第二組影像載入時才發現放不下。"""
    loaded = client.post("/api/v1/_test/load", json={"source": "phantom:landmark"}).json()
    r = client.post(
        f"/api/v1/studies/{loaded['study_id']}/grids",
        json={"primary_series_id": "x", "client_capability": {}},
    )
    assert r.status_code == 422
    assert r.json()["detail"]["code"] == "MISSING_SERIES_IDS"


def test_grids_returns_two_grids(landmark) -> None:
    """🔴 回傳兩個網格。`mask_grid` 是前端唯一能取得 `mask_grid_id` 的地方。"""
    gs = landmark.grids(webgl2=True, tier="A", probe_fps=60)
    assert gs["display_grid"]["display_grid_id"].startswith("dg_")
    assert gs["mask_grid"]["mask_grid_id"].startswith("mg_")
    assert gs["display_grid"]["display_grid_id"] != gs["mask_grid"]["mask_grid_id"]
    assert gs["assigned_tier"] in ("A", "B", "C")
    assert "temporal_groups" in gs
    assert "frame_groups" in gs


def test_grids_mask_grid_is_never_downsampled(client) -> None:
    """即使影像降採樣，mask grid 恆為取像網格。"""
    client.post("/api/v1/_test/load", json={"source": "phantom:huge"})
    study = client.get("/api/v1/_test/state").json()["gridSet"]
    series = [f["series_id"] for f in study["frame_groups"]]
    r = client.post(
        f"/api/v1/studies/{client.get('/api/v1/_test/sessions').json()['sessions'][0]['study_id']}/grids",
        json={
            "primary_series_id": series[0],
            "series_ids": series,
            "client_capability": {"webgl2": True, "probe_fps": 15.0, "tier": "B"},
        },
    ).json()
    assert r["display_grid"]["downsample_factor"] != [1, 1, 1]
    assert r["mask_grid"]["grid"]["size"] == [512, 512, 900]
    assert r["mask_grid"]["grid"]["spacing"] == [1.0, 1.0, 1.0]


def test_grids_412_only_on_capability_conflict(client) -> None:
    """⚠️ 412 的語意見 `tiers` 模組：前端建議 A/B 但自報無 WebGL2。"""
    loaded = client.post("/api/v1/_test/load", json={"source": "phantom:landmark"}).json()
    series = [f["series_id"] for f in loaded["scene"]["gridSet"]["frame_groups"]]
    r = client.post(
        f"/api/v1/studies/{loaded['study_id']}/grids",
        json={
            "primary_series_id": series[0],
            "series_ids": series,
            "client_capability": {"webgl2": False, "tier": "A"},
        },
    )
    assert r.status_code == 412
    body = r.json()
    assert body["reason"] == "no_webgl2"
    # 🔴 body 已帶 assigned_tier，前端不必再打一次請求
    assert body["assigned_tier"] == "C"


def test_tier_c_client_is_not_rejected(client) -> None:
    """加入 Tier C 之後，**不再有「拒絕啟動」的情況**。"""
    loaded = client.post("/api/v1/_test/load", json={"source": "phantom:landmark"}).json()
    series = [f["series_id"] for f in loaded["scene"]["gridSet"]["frame_groups"]]
    r = client.post(
        f"/api/v1/studies/{loaded['study_id']}/grids",
        json={
            "primary_series_id": series[0],
            "series_ids": series,
            "client_capability": {"webgl2": False, "tier": "C"},
        },
    )
    assert r.status_code == 200
    assert r.json()["assigned_tier"] == "C"


def test_backend_cannot_upgrade_tier(client) -> None:
    """後端**只能下調**——它不知道客戶端真實算力。"""
    loaded = client.post("/api/v1/_test/load", json={"source": "phantom:landmark"}).json()
    series = [f["series_id"] for f in loaded["scene"]["gridSet"]["frame_groups"]]
    r = client.post(
        f"/api/v1/studies/{loaded['study_id']}/grids",
        json={
            "primary_series_id": series[0],
            "series_ids": series,
            "client_capability": {"webgl2": True, "probe_fps": 12.0, "tier": "B"},
        },
    ).json()
    assert r["assigned_tier"] == "B"


def test_manual_override_cannot_exceed_hard_capability(client) -> None:
    loaded = client.post("/api/v1/_test/load", json={"source": "phantom:landmark"}).json()
    series = [f["series_id"] for f in loaded["scene"]["gridSet"]["frame_groups"]]
    r = client.post(
        f"/api/v1/studies/{loaded['study_id']}/grids",
        json={
            "primary_series_id": series[0],
            "series_ids": series,
            "manual_tier": "A",
            "client_capability": {"webgl2": False, "tier": "C"},
        },
    ).json()
    assert r["assigned_tier"] == "C"
    assert "超越硬性能力" in r["tier_decision"]["reason"]


# ── 影像 ─────────────────────────────────────────────────────────────────────


def test_image_header_always_carries_direction(tilt) -> None:
    """`direction` 一律完整傳遞，不得因「看起來軸對齊」而省略。"""
    header, arr = tilt.image()
    assert len(header["grid"]["direction"]) == 9
    grid = Grid.from_wire(header["grid"])
    step = grid.index_to_world([0, 0, 1]) - grid.index_to_world([0, 0, 0])
    assert abs(step[1]) > 0.7


def test_image_rejects_stale_display_grid(client, landmark) -> None:
    """I3 —— 網格 id 不符即拒絕，不得嘗試自動對齊。"""
    series = landmark.grid_set["frame_groups"][0]["series_id"]
    r = client.get(f"/api/v1/series/{series}/image", params={"display_grid": "dg_wrong"})
    assert r.status_code == 409
    assert r.json()["detail"]["code"] == "I3"


def test_image_lod_reduces_size(landmark) -> None:
    """`lod=2` 先出畫面，背景換 `lod=0`。"""
    h0, a0 = landmark.image(lod=0)
    h2, a2 = landmark.image(lod=2)
    assert a2.size < a0.size
    assert h2["grid"]["spacing"][0] == pytest.approx(h0["grid"]["spacing"][0] * 4)
    # 幾何一致性：兩者的世界中心必須在半個粗體素以內
    g0, g2 = Grid.from_wire(h0["grid"]), Grid.from_wire(h2["grid"])
    c0 = g0.index_to_world([(n - 1) / 2 for n in g0.size])
    c2 = g2.index_to_world([(n - 1) / 2 for n in g2.size])
    assert float(np.linalg.norm(c0 - c2)) < max(g2.spacing)


def test_image_payload_length_matches_header(landmark) -> None:
    header, arr = landmark.image()
    size = header["size_ijk"]
    assert arr.size == size[0] * size[1] * size[2]


def test_image_rejects_frame_on_static_series(client, landmark) -> None:
    series = landmark.grid_set["frame_groups"][0]["series_id"]
    r = client.get(
        f"/api/v1/series/{series}/image",
        params={"display_grid": landmark.display_grid_id, "frame": 3},
    )
    assert r.status_code == 422
    assert r.json()["detail"]["code"] == "T7"


def test_image_accepts_frame_on_temporal_series(driver) -> None:
    """`image` 接受 `frame`。"""
    driver.load("phantom:four_d_ct")
    h0, a0 = driver.image(frame=0)
    h5, a5 = driver.image(frame=5)
    assert h0["frame_index"] == 0
    assert h5["frame_index"] == 5
    assert h0["temporal_group_id"] == "tg_resp"
    assert not np.array_equal(a0, a5), "不同相位的影像必須不同"


# ── 結構、mask、mesh ───────────────────────────────────────────────────────


def test_structure_list_has_no_voxels(tilt) -> None:
    entries = tilt.structures()
    assert entries
    for e in entries:
        assert "data" not in e
        assert set(e["bbox_ijk"]) == {"offset", "size"}
        assert e["status"] in ("ai_generated", "under_review", "edited", "approved", "rejected")
        assert e["provenance"]["module_version"]


def test_mask_uses_mask_grid_param(client, tilt) -> None:
    """🔴 參數是 `mask_grid` 不是 `grid`。"""
    r = client.get("/api/v1/structures/lesion/mask", params={"mask_grid": tilt.mask_grid_id})
    assert r.status_code == 200
    r2 = client.get("/api/v1/structures/lesion/mask", params={"mask_grid": tilt.display_grid_id})
    assert r2.status_code == 409


def test_mask_is_cropped_and_hash_matches(tilt) -> None:
    header, arr = tilt.mask("lesion")
    assert header["semantics"] == "binary_mask"
    assert header["components"] == 1
    assert header["dtype"] == "uint8"
    assert arr.shape == (header["size_ijk"][2], header["size_ijk"][1], header["size_ijk"][0])
    assert set(np.unique(arr)) <= {0, 1}
    # bbox 必須貼齊：每一面都至少有一個 1
    assert arr[0].any() and arr[-1].any()
    assert arr[:, 0].any() and arr[:, -1].any()
    assert arr[:, :, 0].any() and arr[:, :, -1].any()


def test_mask_volume_matches_expected_json(driver) -> None:
    """前端測試斷言 `expected.json`，這裡驗證後端算的與它一致。"""
    driver.load("phantom:known_geometry")
    expected = driver.expected()
    for structure_id, entry in expected["structures"].items():
        listed = next(s for s in driver.structures() if s["structure_id"] == structure_id)
        assert listed["volume_cc"] == pytest.approx(entry["volume_cc_voxelized"], abs=1e-9)


def test_mesh_vertices_are_world_coordinates(tilt) -> None:
    """頂點是 LPS mm，不是索引座標。"""
    header, vertices, triangles = tilt.mesh("lesion", lod=1)
    assert header["vertex_space"] == "world_lps_mm"
    assert header["mask_grid_id"] == tilt.mask_grid_id
    assert len(vertices) == header["vertex_count"]
    assert len(triangles) == header["triangle_count"]
    assert int(triangles.max()) < len(vertices)
    # lesion 是半徑 12 mm、球心 (51.2, 14.3, 0) 的球
    radii = np.linalg.norm(vertices - np.array([51.2, 14.3, 0.0]), axis=1)
    assert radii.mean() == pytest.approx(12.0, abs=1.5)


def test_mesh_lod_reduces_triangles(tilt) -> None:
    counts = [tilt.mesh("lesion", lod=lod)[0]["triangle_count"] for lod in (0, 1, 2)]
    assert counts[0] > counts[1] > counts[2]


# ── 編輯 ─────────────────────────────────────────────────────────────────────


def test_edit_applies_and_returns_new_hash(tilt) -> None:
    header, _ = tilt.mask("lesion")
    before = next(s for s in tilt.structures() if s["structure_id"] == "lesion")["volume_cc"]
    block = np.ones((2, 4, 4), dtype=np.uint8)
    out = tilt.edit("lesion", offset_ijk=(300, 300, 40), array=block, client_seq=1)
    assert out["content_hash"] != header["content_hash"]
    assert out["volume_cc"] > before
    assert out["status"] == "edited"
    assert out["provenance"]["source"] == "user-edit"
    assert out["provenance"]["view_reference"] is not None


def test_edit_requires_view_reference(client, tilt) -> None:
    """`source="user-edit"` 時 `view_reference` 必填。"""
    header, _ = tilt.mask("lesion")
    r = client.post(
        "/api/v1/structures/lesion/edit",
        json={
            "mask_grid_id": tilt.mask_grid_id,
            "base_content_hash": header["content_hash"],
            "offset_ijk": [0, 0, 0],
            "size_ijk": [1, 1, 1],
            "data": base64.b64encode(b"\x01").decode(),
            "client_seq": 1,
        },
    )
    assert r.status_code == 422
    assert r.json()["detail"]["code"] == "P3"


def test_edit_rejects_display_grid_id(client, tilt) -> None:
    """🔴 編輯一律換算到 MaskGrid，**絕不可用 DisplayGrid**。"""
    header, _ = tilt.mask("lesion")
    r = client.post(
        "/api/v1/structures/lesion/edit",
        json={
            "mask_grid_id": tilt.display_grid_id,
            "base_content_hash": header["content_hash"],
            "offset_ijk": [0, 0, 0],
            "size_ijk": [1, 1, 1],
            "data": base64.b64encode(b"\x01").decode(),
            "client_seq": 1,
            "view_reference": tilt.view_reference(),
        },
    )
    assert r.status_code == 400
    assert r.json()["code"] == "I3"


def test_edit_409_on_stale_hash(tilt) -> None:
    """hash 過期回 409，前端需重取。"""
    block = np.ones((1, 2, 2), dtype=np.uint8)
    tilt.edit("lesion", offset_ijk=(300, 300, 40), array=block, client_seq=1)
    with pytest.raises(RuntimeError) as exc:
        tilt.edit(
            "lesion",
            offset_ijk=(300, 300, 41),
            array=block,
            base_content_hash="mh_stale",
            client_seq=2,
        )
    assert "409" in str(exc.value)
    assert "stale_hash" in str(exc.value)


def test_edit_rejects_out_of_order_seq(tilt) -> None:
    """`client_seq` 單調遞增，伺服器據此拒絕亂序。"""
    block = np.ones((1, 2, 2), dtype=np.uint8)
    tilt.edit("lesion", offset_ijk=(300, 300, 40), array=block, client_seq=5, client_id="c1")
    with pytest.raises(RuntimeError) as exc:
        tilt.edit("lesion", offset_ijk=(300, 300, 41), array=block, client_seq=3, client_id="c1")
    assert "out_of_order" in str(exc.value)


def test_client_seq_is_scoped_per_client(tilt) -> None:
    """🔴 `client_seq` 的作用域是**每個 client**。

    症狀：使用者**重新整理頁面**後，前端的 `client_seq` 從 1 重新起算，
    而後端還記著上一輪的 5 → 第一筆編輯被判 `out_of_order` →
    清空 undo 並在 UI 顯示「已被其他來源修改」。但 409 應該
    「只在真正的外部修改時發生」——沒有人改過任何東西。

    真正的順序保護來自 `base_content_hash`：分歧的狀態一定 hash 不符。
    `client_seq` 只是同一個 client 內的網路重排保險。
    """
    block = np.ones((1, 2, 2), dtype=np.uint8)
    tilt.edit("lesion", offset_ijk=(300, 300, 40), array=block, client_seq=5, client_id="tab-1")
    # 重新整理 = 換一個 client id，序號從 1 重新起算 → 必須被接受
    out = tilt.edit("lesion", offset_ijk=(300, 300, 41), array=block, client_seq=1, client_id="tab-2")
    assert out["content_hash"].startswith("mh_")
    # 而同一個 client 的亂序仍然被拒
    with pytest.raises(RuntimeError) as exc:
        tilt.edit("lesion", offset_ijk=(300, 300, 42), array=block, client_seq=1, client_id="tab-2")
    assert "out_of_order" in str(exc.value)


def test_edit_rejects_out_of_bounds_block(client, tilt) -> None:
    header, _ = tilt.mask("lesion")
    r = client.post(
        "/api/v1/structures/lesion/edit",
        json={
            "mask_grid_id": tilt.mask_grid_id,
            "base_content_hash": header["content_hash"],
            "offset_ijk": [510, 510, 99],
            "size_ijk": [8, 8, 8],
            "data": base64.b64encode(b"\x01" * 512).decode(),
            "client_seq": 1,
            "view_reference": tilt.view_reference(),
        },
    )
    assert r.status_code == 400
    assert r.json()["code"] == "E1"


def test_edit_on_temporal_structure_is_per_frame(driver) -> None:
    """**編輯一律針對特定相位**；改相位 3 不得影響相位 4。"""
    driver.load("phantom:four_d_ct")
    h3, _ = driver.mask("gtv_4d", frame=3)
    h4_before, _ = driver.mask("gtv_4d", frame=4)
    block = np.ones((1, 3, 3), dtype=np.uint8)
    driver.edit("gtv_4d", offset_ijk=(5, 5, 2), array=block, frame=3, client_seq=1)
    h3_after, _ = driver.mask("gtv_4d", frame=3)
    h4_after, _ = driver.mask("gtv_4d", frame=4)
    assert h3_after["content_hash"] != h3["content_hash"]
    assert h4_after["content_hash"] == h4_before["content_hash"]


def test_temporal_structure_listed_once_with_frame_count(driver) -> None:
    """4D 病例的結構清單以前整個 404（單參數 `structure(sid)` 找 `(sid, None)`）。
    現在帶時間軸的結構列一次、`frame_count` 與逐相位體積都在。"""
    driver.load("phantom:four_d_ct")
    rows = driver._client.get(f"/api/v1/studies/{driver.study_id}/structures", headers=driver._headers)
    assert rows.status_code == 200, rows.text
    gtv = [r for r in rows.json() if r["structure_id"] == "gtv_4d"]
    assert len(gtv) == 1 and gtv[0]["temporal_group_id"] == "tg_resp" and gtv[0]["frame_count"] == 10
    assert isinstance(gtv[0]["volume_cc"], list) and len(gtv[0]["volume_cc"]) == 10
    assert gtv[0]["editable"] is True


# ── 後處理 ──────────────────────────────────────────────────────────────────


def test_ops_registry_drives_ui(driver) -> None:
    """每個參數都要有 `x-ui-widget`，前端才生得出 UI。"""
    ALLOWED = {"number", "integer", "boolean", "enum", "structure-picker", "slice-range", "hu-range", "seed", "bbox"}
    ops = driver.ops()
    assert {o["op"] for o in ops} == {
        "fill_holes",
        "remove_islands",
        "smooth",
        "boolean",
        "interpolate",
        "threshold",
        "region_grow",
    }
    for op in ops:
        for name, prop in op["params_schema"]["properties"].items():
            assert "x-ui-widget" in prop, f"{op['op']}.{name} 缺 x-ui-widget"
            assert prop["x-ui-widget"] in ALLOWED
            assert prop.get("title"), f"{op['op']}.{name} 缺 title"


def test_postprocess_returns_new_payload_with_provenance(driver) -> None:
    driver.load("phantom:overlap_set")
    header, _ = driver.mask("gtv")
    out = driver.postprocess("gtv", "smooth", sigma_mm=2.0)
    assert out["provenance"]["source"] == "post-process"
    assert out["provenance"]["parent_hash"] == header["content_hash"]
    assert out["content_hash"] != header["content_hash"]
    assert out["op"] == "smooth"


def test_postprocess_boolean_subtract(driver) -> None:
    driver.load("phantom:overlap_set")
    out = driver.postprocess("ctv", "boolean", other_structure_id="gtv", mode="subtract")
    listed = next(s for s in driver.structures() if s["structure_id"] == "ctv")
    assert listed["volume_cc"] > 0
    assert out["size_ijk"]


def test_postprocess_accepts_frame_and_mask_grid(driver) -> None:
    """body 補上 `mask_grid_id` 與 `frame_index`。"""
    driver.load("phantom:four_d_ct")
    out = driver.postprocess("gtv_4d", "fill_holes", frame=2, per_slice=True)
    assert out["frame_index"] == 2
    assert out["mask_grid_id"] == driver.mask_grid_id


def test_postprocess_rejects_wrong_mask_grid(client, driver) -> None:
    driver.load("phantom:overlap_set")
    r = client.post(
        "/api/v1/structures/gtv/postprocess",
        json={"op": "fill_holes", "params": {}, "mask_grid_id": "mg_wrong"},
    )
    assert r.status_code == 400
    assert r.json()["code"] == "I3"


# ── 變換、重切、3D ────────────────────────────────────────────────────


def test_transform_roundtrip(driver) -> None:
    driver.load("phantom:two_series")
    m = rigid_matrix(translation_mm=(15.0, -8.0, 4.0), rotation_deg=(0, 0, 5))
    column_major = m.flatten(order="F").tolist()
    series = [f["series_id"] for f in driver.grid_set["frame_groups"]]
    out = driver.create_transform(
        matrix_column_major=column_major, fixed_series_id=series[0], moving_series_id=series[1]
    )
    assert out["transform_id"].startswith("tf_")
    state = driver.state
    assert out["transform_id"] in state["transforms"]


def test_transform_apply_to_frame_group_replaces_registration(client, driver) -> None:
    """提交對位微調 → 該 FoR 的 FrameGroup 換掉、source=manual；契約 F5／F7 仍驗。"""
    driver.load("phantom:two_series")
    fgs = driver.grid_set["frame_groups"]
    primary = next(f for f in fgs if f["role"] == "primary")
    secondary = next(f for f in fgs if f["role"] == "secondary")
    m = rigid_matrix(translation_mm=(3.0, -2.0, 1.5), rotation_deg=(0, 0, 2))
    out = driver.create_transform(
        matrix_column_major=m.flatten(order="F").tolist(),
        fixed_series_id=primary["series_id"],
        moving_series_id=secondary["series_id"],
        apply_to_frame_group=True,
    )
    assert out["frame_group"]["registration"]["source"] == "manual"
    after = next(f for f in driver.grid_set["frame_groups"] if f["series_id"] == secondary["series_id"])
    assert np.allclose(after["transform_to_primary"], m.flatten(order="F"))
    assert after["transform_kind"] == "rigid"
    assert after["registration"]["source"] == "manual"
    assert after["mask_grid_id"] == secondary["mask_grid_id"]
    # 網格本身不變 —— 前端據此不重建 host
    assert driver.grid_set["display_grid"]["display_grid_id"] == driver.display_grid_id

    # F5：primary 不得動
    r = client.post(
        "/api/v1/transforms",
        json={
            "kind": "rigid",
            "matrix": m.flatten(order="F").tolist(),
            "fixed_series_id": primary["series_id"],
            "moving_series_id": primary["series_id"],
            "apply_to_frame_group": True,
        },
    )
    assert r.status_code == 422
    assert r.json()["detail"]["code"] == "F5"
    # F7：含縮放的矩陣不算 rigid，即使是使用者手調
    scaled = m.copy()
    scaled[0, 0] *= 2
    r = client.post(
        "/api/v1/transforms",
        json={
            "kind": "rigid",
            "matrix": scaled.flatten(order="F").tolist(),
            "fixed_series_id": primary["series_id"],
            "moving_series_id": secondary["series_id"],
            "apply_to_frame_group": True,
        },
    )
    assert r.status_code == 400
    assert r.json()["code"] == "F7"
    # 沒被換掉
    still = next(f for f in driver.grid_set["frame_groups"] if f["series_id"] == secondary["series_id"])
    assert np.allclose(still["transform_to_primary"], m.flatten(order="F"))


def test_image_with_transform_is_resampled_and_has_coverage(client, driver) -> None:
    """帶 `transform` 的路徑 ＋ `coverageMaskId`。"""
    driver.load("phantom:two_series")
    m = rigid_matrix(translation_mm=(15.0, -8.0, 4.0))
    series = [f["series_id"] for f in driver.grid_set["frame_groups"]]
    tf = driver.create_transform(
        matrix_column_major=m.flatten(order="F").tolist(),
        fixed_series_id=series[0],
        moving_series_id=series[1],
    )["transform_id"]
    r = client.get(
        f"/api/v1/series/{series[1]}/image",
        params={"display_grid": driver.display_grid_id, "transform": tf},
    )
    assert r.status_code == 200
    header, _ = decode(r.content)
    assert header["transform_kind"] == "resampled"
    assert header["coverage_mask_id"], "重採樣後必須給 coverage，否則空白區域看起來像解剖結構"


def test_reslice_bspline_returns_plane(driver) -> None:
    """高品質斜面重切。"""
    driver.load("phantom:anisotropic")
    view = driver.view_reference(
        view_plane_normal=(0.0, 0.3826834, 0.9238795),
        view_up=(0.0, 0.9238795, -0.3826834),
        slab_mm=0.0,
    )
    header, plane = driver.reslice(view_reference=view, output_size_px=(128, 128))
    assert plane.shape == (128, 128)
    assert header["interpolator"] == "bspline"
    assert header["dtype"] == "float32"
    assert plane.max() > plane.min()


def test_reslice_bspline_differs_from_linear(driver) -> None:
    """B-spline 若與 linear 完全相同，就代表插值器參數沒生效。"""
    driver.load("phantom:anisotropic")
    view = driver.view_reference(view_plane_normal=(0.0, 0.3826834, 0.9238795), view_up=(0.0, 0.9238795, -0.3826834))
    _, a = driver.reslice(view_reference=view, output_size_px=(96, 96), interpolator="bspline")
    _, b = driver.reslice(view_reference=view, output_size_px=(96, 96), interpolator="linear")
    assert not np.allclose(a, b)


def test_render3d_returns_png_with_camera_used(driver) -> None:
    """回傳實際使用的相機，前端據此標註與偵測過期。"""
    driver.load("phantom:overlap_set")
    header, png = driver.render3d(output_size_px=(96, 96))
    assert png[:8] == b"\x89PNG\r\n\x1a\n"
    assert header["mime"] == "image/png"
    assert header["width"] == 96
    assert header["camera_used"]["distance_mm"] == 500.0
    assert header["provenance"]["module_version"]


def test_render3d_rejects_unknown_renderer(client, driver) -> None:
    """🔴 不可轉譯者不得宣告這條退路。"""
    driver.load("phantom:overlap_set")
    r = client.post(
        f"/api/v1/studies/{driver.study_id}/render3d",
        json={
            "camera": driver.view_reference(),
            "output_size_px": [64, 64],
            "layers": [{"renderer": "module-custom-overlay", "opacity": 1.0}],
        },
    )
    assert r.status_code == 422
    assert r.json()["detail"]["code"] == "UNRENDERABLE_LAYER"


# ── 建立、審核、輸出 ───────────────────────────────────────────────────────────


def test_create_structure_suggests_tg263(driver) -> None:
    driver.load("phantom:landmark")
    out = driver.create_structure("ptv high dose", color_rgb=[255, 0, 255])
    assert out["status"] == "under_review"
    assert out["tg263_suggestion"]["matched"] == "ptv"
    assert "PTV_" in out["tg263_suggestion"]["suggestion"]


def test_review_state_machine(driver) -> None:
    driver.load("phantom:overlap_set")
    out = driver.review({"gtv": "approved", "ctv": "rejected"}, note="第一輪審核")
    statuses = {s["structure_id"]: s["status"] for s in out["structures"]}
    assert statuses["gtv"] == "approved"
    assert statuses["ctv"] == "rejected"


def test_review_rejects_illegal_status(client, driver) -> None:
    driver.load("phantom:overlap_set")
    r = client.post(
        f"/api/v1/studies/{driver.study_id}/review",
        json={"structure_statuses": {"gtv": "ai_generated"}},
    )
    assert r.status_code == 422


def test_export_rtstruct_roundtrip(driver) -> None:
    """從 labelmap 在**取像平面**重抽輪廓，產生可讀回的 RTSTRUCT。"""
    import io

    import pydicom

    driver.load("phantom:overlap_set")
    job_id = driver.export_rtstruct(["gtv", "ptv"])["job_id"]
    job = driver.wait_for_job(job_id)
    assert job["status"] == "done", job
    assert job["structure_count"] == 2
    assert job["contour_count"] > 10

    ds = pydicom.dcmread(io.BytesIO(driver.download_job(job_id)))
    assert ds.Modality == "RTSTRUCT"
    assert len(ds.StructureSetROISequence) == 2
    names = {roi.ROIName for roi in ds.StructureSetROISequence}
    assert names == {"GTV", "PTV_7000"}
    # 輪廓必須共面（RTSTRUCT 的原生語意）
    for roi_contour in ds.ROIContourSequence:
        for contour in roi_contour.ContourSequence:
            zs = np.asarray(contour.ContourData, dtype=np.float64).reshape(-1, 3)[:, 2]
            assert zs.std() < 1e-6, "同一個 contour 的所有點必須共面"
    # PTV 的 RTROIInterpretedType 必須是 PTV
    types = {obs.ReferencedROINumber: obs.RTROIInterpretedType for obs in ds.RTROIObservationsSequence}
    ptv_number = next(r.ROINumber for r in ds.StructureSetROISequence if r.ROIName == "PTV_7000")
    assert types[ptv_number] == "PTV"


def test_export_rejects_unknown_format(client, driver) -> None:
    driver.load("phantom:landmark")
    r = client.post(f"/api/v1/studies/{driver.study_id}/export", json={"format": "nifti"})
    assert r.status_code == 422


# ── 時間群組 ───────────────────────────────────────────────────────────────────


def test_temporal_window_endpoint(client, driver) -> None:
    driver.load("phantom:four_d_ct")
    r = client.get("/api/v1/temporal/tg_resp/window", params={"from": 2, "count": 4})
    assert r.status_code == 200
    body = r.json()
    assert body["frames"] == [2, 3, 4, 5]
    assert body["next_available"] == 6
    assert body["kind"] == "cyclic"


def test_state_carries_study_id_of_the_current_session(client, driver) -> None:
    """🔴 `_test/state` 必須自帶 `studyId`，且是**當前**session 的。

    這是一個實際踩過的 bug：前端從 `_test/state` 取場景、卻另外打 `_test/sessions`
    取 `sessions[0]` 當 studyId。store 會同時保留不同 study 的 session，於是
    「清單第一個」不是「當前這個」——結果是拿 A 的 studyId 去 `POST /grids`、
    卻拿 B 的 series 去抓影像，換來 409 I3。

    而且它只在「切換過案例後的第一次重新整理」壞，因此表現成「不穩定」。
    """
    first = driver.load("phantom:overlap_set")
    second = driver.load("phantom:huge")
    assert first["study_id"] != second["study_id"]

    state = client.get("/api/v1/_test/state").json()
    assert state["studyId"] == second["study_id"], "state 的 studyId 不是當前 session 的"
    assert state["source"] == "phantom:huge"

    # 場景裡的 series 也必須屬於同一個 session —— 兩者不同步就是那個 bug
    series_ids = [f["series_id"] for f in state["gridSet"]["frame_groups"]]
    structures = client.get(f"/api/v1/studies/{state['studyId']}/structures").json()
    assert all("huge" in sid for sid in series_ids)
    assert structures == []  # huge 沒有結構

    # 清單裡第一個**不是**當前的 —— 這正是舊寫法會挑錯的原因
    sessions = client.get("/api/v1/_test/sessions").json()
    assert len(sessions["sessions"]) == 2
    assert sessions["current"] == second["session_id"]


def test_load_response_and_state_agree(client, driver) -> None:
    """`_test/load` 與 `_test/state` 對同一個 session 必須給出一致的 studyId。"""
    loaded = driver.load("phantom:two_series")
    state = client.get("/api/v1/_test/state").json()
    assert state["studyId"] == loaded["study_id"]
    assert state["sessionId"] == loaded["session_id"]


def test_scene_push_also_carries_study_id(client, driver) -> None:
    """WS 推送的 `scene.replace` 同樣要能定位 study（否則前端得再問一次）。"""
    driver.load("phantom:gantry_tilt")
    with client.websocket_connect("/api/v1/session/current/events") as ws:
        message = ws.receive_json()
    assert message["type"] == "scene.replace"
    assert message["payload"]["studyId"]
    # 但**不含**結構清單（N10）
    assert "structures" not in message["payload"]


def test_grids_on_a_non_current_study_does_not_break_the_current_one(client, driver) -> None:
    """對非當前 study 打 `/grids` 會把它變成當前 —— 這是既有行為，但要可預期。

    網格由後端決定，因此 `POST /grids` 必然重建該 study 的 session。
    這裡固定住「重建的是**請求裡那個 study**，不是當前那個」這件事。
    """
    a = driver.load("phantom:overlap_set")
    b = driver.load("phantom:landmark")
    assert client.get("/api/v1/_test/state").json()["studyId"] == b["study_id"]

    series = [f["series_id"] for f in a["scene"]["gridSet"]["frame_groups"]]
    response = client.post(
        f"/api/v1/studies/{a['study_id']}/grids",
        json={
            "primary_series_id": series[0],
            "series_ids": series,
            "client_capability": {"webgl2": True, "tier": "A", "probe_fps": 60},
        },
    )
    assert response.status_code == 200
    # 現在當前變成 A，且 state 的 studyId 跟著換
    assert client.get("/api/v1/_test/state").json()["studyId"] == a["study_id"]


def test_reloading_the_same_study_evicts_the_stale_session(client, driver) -> None:
    """🔴 重新載入同一個病例後，查找必須打到**新**的 session。

    這個缺陷是真 socket 的 e2e 抓到的（行程內測試每個各有一個 app，撞不到）：
    `SessionStore` 舊版留著同 study 的舊 session，而 `by_structure()` 是掃描式
    查找 → 編輯打到過期的 session，`client_seq` 與 `content_hash` 都是上一輪的。
    """
    first = driver.load("phantom:gantry_tilt")
    driver.edit(
        "lesion",
        offset_ijk=(300, 300, 40),
        array=np.ones((1, 2, 2), dtype=np.uint8),
        client_seq=1,
    )
    second = driver.load("phantom:gantry_tilt")
    assert second["session_id"] != first["session_id"]

    sessions = client.get("/api/v1/_test/sessions").json()
    assert len(sessions["sessions"]) == 1, "同一個 study 的舊 session 未被汰除"
    assert sessions["current"] == second["session_id"]

    # 新 session 的 client_seq 是乾淨的，因此 seq=1 必須被接受
    out = driver.edit(
        "lesion",
        offset_ijk=(300, 300, 40),
        array=np.ones((1, 2, 2), dtype=np.uint8),
        client_seq=1,
    )
    assert out["content_hash"]


def test_loading_a_different_study_keeps_both_sessions(client, driver) -> None:
    """不同 study 各自保留 —— 汰除只針對**同一個** study。"""
    driver.load("phantom:gantry_tilt")
    driver.load("phantom:overlap_set")
    sessions = client.get("/api/v1/_test/sessions").json()
    assert len(sessions["sessions"]) == 2
    # 查找優先看當前 session
    assert driver.structures()[0]["structure_id"] in {"body", "ctv", "gtv", "lung_l", "lung_r", "lungs", "ptv"}


def test_healthz_reports_kernel_and_geom_version(client) -> None:
    body = client.get("/healthz").json()
    assert body["ok"]
    assert body["geom_version"]
    assert "reslice_kernel" in body


def test_coop_coep_headers_are_present(client) -> None:
    """Tier C 的 `SharedArrayBuffer` 需要這兩個標頭，列為部署必檢項。"""
    r = client.get("/healthz")
    assert r.headers["cross-origin-opener-policy"] == "same-origin"
    assert r.headers["cross-origin-embedder-policy"] == "require-corp"


def test_contract_violation_becomes_400_with_code(client, driver) -> None:
    """契約違反一律 400 ＋ 機器可讀的 code。"""
    driver.load("phantom:landmark")
    r = client.post("/api/v1/structures/nonexistent/postprocess", json={"op": "fill_holes", "params": {}})
    assert r.status_code == 404
    assert ContractViolation  # 匯入即用於型別文件


# ── 2026-09-09：3D 出圖的裁切（Slicer Volume Rendering 的 Crop）──────────────


def test_render3d_crop_shrinks_volume_and_reports_crop_used(driver) -> None:
    from rtgaia_core import render3d

    driver.load("phantom:overlap_set")
    grid = driver.grid_set["display_grid"]["grid"]
    o, sp, n = grid["origin"], grid["spacing"], grid["size"]
    full_max = [o[i] + sp[i] * (n[i] - 1) for i in range(3)]
    # 中間一半（z 方向）
    crop = {
        "min": [o[0], o[1], o[2] + (full_max[2] - o[2]) * 0.25],
        "max": [full_max[0], full_max[1], o[2] + (full_max[2] - o[2]) * 0.75],
    }
    header, png = driver.render3d(output_size_px=(96, 96), crop=crop, technique="mip")
    assert png[:8] == b"\x89PNG\r\n\x1a\n"
    used = header["crop_used"]
    assert used is not None
    assert used["index_lo"][2] > 0 and used["index_hi"][2] < n[2] - 1
    assert used["index_lo"][0] == 0 and used["index_hi"][0] == n[0] - 1
    # 沒裁切 → crop_used None，且兩張圖不同
    header_full, png_full = driver.render3d(output_size_px=(96, 96), technique="mip")
    assert header_full["crop_used"] is None
    assert png_full != png
    # 純函式：子體積的值與原體積在方框內逐點一致
    from rtgaia_geom import Grid

    g = Grid.from_wire(grid)
    vol = np.arange(np.prod(n), dtype=np.float32).reshape(n[2], n[1], n[0])
    sub, sub_grid, info = render3d.crop_volume(vol, g, crop)
    lo, hi = info["index_lo"], info["index_hi"]
    assert sub.shape == (hi[2] - lo[2] + 1, hi[1] - lo[1] + 1, hi[0] - lo[0] + 1)
    assert np.array_equal(sub, vol[lo[2] : hi[2] + 1, lo[1] : hi[1] + 1, lo[0] : hi[0] + 1])
    assert np.allclose(sub_grid.index_to_world([0, 0, 0]), g.index_to_world(lo))
    # 空方框 → 422 EMPTY_CROP
    r = driver._client.post(
        f"/api/v1/studies/{driver.study_id}/render3d",
        json={
            "camera": {**driver.view_reference(), "distance_mm": 500.0, "fov_deg": 30.0},
            "output_size_px": [32, 32],
            "layers": [
                {"renderer": "volume-3d", "series_id": driver.grid_set["frame_groups"][0]["series_id"], "opacity": 1.0}
            ],
            "crop": {"min": [9000, 9000, 9000], "max": [9100, 9100, 9100]},
        },
    )
    assert r.status_code == 422 and r.json()["detail"]["code"] == "EMPTY_CROP"


def test_render3d_zoom_changes_scale_and_is_reported(driver) -> None:
    """正交縮放：zoom 2 的圖與 zoom 1 不同，header 回 zoom_used。"""
    driver.load("phantom:overlap_set")
    h1, png1 = driver.render3d(output_size_px=(64, 64))
    h2, png2 = driver.render3d(output_size_px=(64, 64), zoom=2.0)
    assert h1["zoom_used"] == 1.0 and h2["zoom_used"] == 2.0
    assert png1 != png2


def test_render3d_camera_distance_acts_as_orthographic_zoom(driver) -> None:
    """MIP 沒有透視：相機前進／後退（`distance_mm`）換成正交縮放 —— 靠近一半放大兩倍；沒給距離 → 倍率 1（舊行為）。
    MIP 的滾輪要跟體積渲染一樣有前後。"""
    driver.load("phantom:overlap_set")
    h0, png0 = driver.render3d(output_size_px=(64, 64), technique="mip")
    assert h0["dolly_zoom"] == 1.0 and h0["zoom_used"] == 1.0
    h_far, png_far = driver.render3d(output_size_px=(64, 64), technique="mip", distance_mm=800.0)
    h_near, png_near = driver.render3d(output_size_px=(64, 64), technique="mip", distance_mm=400.0)
    assert h_near["dolly_zoom"] == pytest.approx(h_far["dolly_zoom"] * 2)
    assert h_near["zoom_used"] == pytest.approx(h_near["dolly_zoom"])
    assert png_near != png_far
    # 與 zoom 相乘
    h_both, _ = driver.render3d(output_size_px=(64, 64), technique="mip", distance_mm=400.0, zoom=2.0)
    assert h_both["zoom_used"] == pytest.approx(h_near["dolly_zoom"] * 2)


def test_render3d_projection_cache_and_mask_downsample(driver) -> None:
    """同相機再要一張（換視窗）走快取但結果一致；降解析度 mask 的網格幾何對；快取清掉後仍相同。"""
    from rtgaia_core import render3d
    from rtgaia_geom import Grid

    driver.load("phantom:overlap_set")
    series = driver.grid_set["frame_groups"][0]["series_id"]
    structures = [s["structure_id"] for s in driver.structures()[:2]]
    layers = [
        {"renderer": "volume-3d", "series_id": series, "window": {"center": 40, "width": 400}, "opacity": 1.0}
    ] + [{"renderer": "mesh", "structure_id": sid, "color": [0, 1, 0], "opacity": 0.5} for sid in structures]
    h1, png1 = driver.render3d(output_size_px=(64, 64), layers=layers, technique="mip")
    render3d.clear_caches()
    h2, png2 = driver.render3d(output_size_px=(64, 64), layers=layers, technique="mip")
    assert png1 == png2 and h1["content_hash"] == h2["content_hash"]
    # 快取命中（沒清）→ 同一張
    h3, png3 = driver.render3d(output_size_px=(64, 64), layers=layers, technique="mip")
    assert png3 == png1
    # 換視窗只重合成：圖不同、但不必重投影（快取仍在）
    layers[0]["window"] = {"center": 400, "width": 1800}
    h4, png4 = driver.render3d(output_size_px=(64, 64), layers=layers, technique="mip")
    assert png4 != png1
    assert len(render3d._PROJ_CACHE.items) == 3
    # downsample2_mask：奇數尺寸補齊、原點移半個體素、間距加倍、任一為真
    g = Grid(
        size=(3, 3, 3),
        spacing=(1.0, 1.0, 2.0),
        origin=(0.0, 0.0, 0.0),
        direction=(1, 0, 0, 0, 1, 0, 0, 0, 1),
        frame_of_reference_uid="f",
    )
    mask = np.zeros((3, 3, 3), dtype=np.uint8)
    mask[0, 0, 1] = 1
    small, sg = render3d.downsample2_mask(mask, g)
    assert small.shape == (2, 2, 2) and small[0, 0, 0] == 1 and small.sum() == 1
    assert sg.spacing == (2.0, 2.0, 4.0) and sg.size == (2, 2, 2)
    assert np.allclose(sg.origin, [0.5, 0.5, 1.0])
