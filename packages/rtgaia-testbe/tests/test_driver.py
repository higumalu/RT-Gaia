"""驅動 API —— **同一份 driver 也用於前端 e2e 測試**。"""

from __future__ import annotations

import numpy as np
import pytest


def test_verification_script_runs_verbatim(driver) -> None:
    """驅動 API 的範例腳本逐行照跑。**它就是驗收條件。**"""
    driver.load("phantom:gantry_tilt")

    grid = driver.grid_set["mask_grid"]["grid"]
    arr = np.zeros((grid["size"][2] // 4, 16, 16), dtype=np.uint8)
    arr[2:5, 4:12, 4:12] = 1
    driver.push_mask("Parotid_L", arr, offset_ijk=(100, 100, 20))

    driver.push_measurement(
        kind="distance",
        points=[(0.0, 0.0, 0.0), (100.0, 0.0, 0.0)],
        label="測試距離 100mm",
    )
    driver.set_camera(
        view_plane_normal=(0.0, 0.5, 0.866),
        view_up=(0.0, 0.866, -0.5),
        slab_mm=3,
    )
    driver.set_layer("mask:Parotid_L", visible=True, opacity=0.6)
    driver.chaos(grid_mismatch=True)
    driver.chaos(reset=True)

    driver.load("phantom:known_geometry")
    assert driver.expected()["structures"]["sphere_25mm"]["volume_cc"] == 65.45


def test_pushed_mask_is_visible_in_state(driver) -> None:
    driver.load("phantom:landmark")
    arr = np.ones((3, 5, 5), dtype=np.uint8)
    out = driver.push_mask("Injected", arr, offset_ijk=(20, 30, 10))
    assert out["offset_ijk"] == [20, 30, 10]
    assert out["size_ijk"] == [5, 5, 3]
    state = driver.state
    assert any(s["structure_id"] == "Injected" for s in state["structures"])
    header, back = driver.mask("Injected")
    assert back.shape == (3, 5, 5)
    assert back.all()


def test_pushed_measurement_result_is_not_stored(driver) -> None:
    """`result` 永遠由 `points` 重算，**不得獨立儲存為真相**。"""
    driver.load("phantom:known_geometry")
    expected = driver.expected()
    a = expected["markers"]["marker_0"]["world_lps"]
    b = expected["markers"]["marker_1"]["world_lps"]
    out = driver.push_measurement(kind="distance", points=[tuple(a), tuple(b)], label="marker pair")
    m = out["payload"]["measurement"]
    assert "result" not in m
    # 由 points 重算應等於 expected.json 的真值
    dist = float(np.linalg.norm(np.asarray(m["points"][0]) - np.asarray(m["points"][1])))
    assert dist == pytest.approx(expected["marker_distance_mm"])


def test_area_measurement_requires_view_reference(driver) -> None:
    """平面型量測必須存完整平面，不得存 slice index。"""
    driver.load("phantom:landmark")
    out = driver.push_measurement(
        kind="area",
        points=[(0.0, 0.0, 0.0), (10.0, 0.0, 0.0), (10.0, 10.0, 0.0)],
        label="面積",
    )
    view = out["payload"]["measurement"]["viewReference"]
    assert view is not None
    assert view["view_plane_normal"] == [0.0, 0.0, 1.0]
    assert "slice_index" not in view


def test_layer_override_survives_grid_renegotiation(driver) -> None:
    """重新協商 Tier 不該丟掉使用者改過的圖層狀態。"""
    driver.load("phantom:overlap_set")
    driver.set_layer("mask:gtv", visible=False, opacity=0.3)
    driver.grids(webgl2=True, probe_fps=15.0, tier="B")
    layer = next(x for x in driver.state["layers"] if x["layerId"] == "mask:gtv")
    assert layer["visible"] is False
    assert layer["opacity"] == 0.3


def test_edits_survive_grid_renegotiation(driver) -> None:
    """降 Tier 會換 display grid，但 **mask 不隨影像降採樣**。"""
    driver.load("phantom:overlap_set")
    before = driver.edit("gtv", offset_ijk=(10, 10, 5), array=np.ones((2, 3, 3), dtype=np.uint8), client_seq=1)
    old_mask_grid = driver.mask_grid_id
    driver.grids(webgl2=True, probe_fps=15.0, tier="B")
    assert driver.mask_grid_id == old_mask_grid, "mask grid 不得因 Tier 改變而改變"
    header, _ = driver.mask("gtv")
    assert header["content_hash"] == before["content_hash"]


def test_driver_reports_kernel_availability(driver) -> None:
    health = driver.health()
    assert "reslice_kernel" in health
    assert "available" in health["reslice_kernel"]
