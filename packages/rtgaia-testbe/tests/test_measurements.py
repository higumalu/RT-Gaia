"""量測端點：CRUD、形狀契約、layer.* 推送、_test/state。"""

from __future__ import annotations

import pytest


def _view(for_uid: str, grid_id: str) -> dict:
    return {
        "frame_of_reference_uid": for_uid,
        "display_grid_id": grid_id,
        "plane_origin": [0.0, 0.0, 0.0],
        "view_plane_normal": [0.0, 0.0, -1.0],
        "view_up": [0.0, -1.0, 0.0],
        "slab_thickness_mm": 0.0,
        "temporal_group_id": None,
        "frame_index": None,
    }


def _distance(for_uid: str, grid_id: str, **extra) -> dict:
    return {
        "kind": "distance",
        "label": "距離 1",
        "frameOfReferenceUid": for_uid,
        "points": [0.0, 0.0, 0.0, 3.0, 4.0, 0.0],
        "viewReference": None,
        "provenance": {
            "source": "user-edit",
            "parent_hash": None,
            "module_version": "0.1.0",
            "view_reference": _view(for_uid, grid_id),
            "created_at": "2026-09-08T00:00:00Z",
        },
        **extra,
    }


def test_measurement_crud_and_push(driver) -> None:
    driver.load("phantom:landmark")
    fg = driver.grid_set["frame_groups"][0]
    for_uid = fg["frame_of_reference_uid"]
    layer = driver.create_measurement(_distance(for_uid, driver.display_grid_id))
    assert layer["kind"] == "measurement" and layer["groupId"] == "measurements"
    mid = layer["contentRef"]
    assert layer["layerId"] == f"measurement:{mid}" and mid.startswith("ms_")
    assert layer["measurement"]["points"] == [0.0, 0.0, 0.0, 3.0, 4.0, 0.0]
    assert [m["measurementId"] for m in driver.measurements()] == [mid]
    # 出現在 scene 的 layers 與 _test/state
    assert any(x["layerId"] == layer["layerId"] for x in driver.state["layers"])
    tail = driver.state["push_history_tail"]
    assert tail[-1]["type"] == "layer.add" and tail[-1]["payload"]["contentRef"] == mid

    updated = driver.update_measurement(mid, {"label": "股骨頭距離", "points": [0, 0, 0, 0, 0, 10]})
    assert updated["label"] == "股骨頭距離" and updated["measurement"]["points"][-1] == 10
    assert driver.state["push_history_tail"][-1]["type"] == "layer.update"
    # 沒帶的欄位保留
    assert updated["measurement"]["provenance"]["module_version"] == "0.1.0"

    driver.delete_measurement(mid)
    assert driver.measurements() == []
    assert not any(x["kind"] == "measurement" for x in driver.state["layers"])
    assert driver.state["push_history_tail"][-1] == {
        "type": "layer.remove",
        "payload": {"layerId": f"measurement:{mid}"},
    }
    with pytest.raises(RuntimeError, match="404"):
        driver.delete_measurement(mid)


def test_measurement_contract_codes(driver) -> None:
    driver.load("phantom:landmark")
    for_uid = driver.grid_set["frame_groups"][0]["frame_of_reference_uid"]
    grid_id = driver.display_grid_id
    base = _distance(for_uid, grid_id)
    cases = [
        ({**base, "kind": "ellipse"}, "MS2"),
        ({**base, "points": [0, 0, 0, 1]}, "MS1"),
        ({**base, "points": [0, 0, 0]}, "MS3"),
        ({**base, "kind": "area", "points": [0, 0, 0, 1, 0, 0, 0, 1, 0], "viewReference": None}, "MS4"),
        ({**base, "frameOfReferenceUid": "1.2.3.nope"}, "MS5"),
    ]
    for body, code in cases:
        r = driver._client.post("/api/v1/measurements", json=body)
        assert r.status_code == 422, (code, r.text)
        assert r.json()["detail"]["code"] == code
    # area 帶平面就過
    area = {**base, "kind": "area", "points": [0, 0, 0, 10, 0, 0, 10, 10, 0], "viewReference": _view(for_uid, grid_id)}
    layer = driver.create_measurement(area)
    assert layer["measurement"]["kind"] == "area"
    # 重複 id → 409
    r = driver._client.post("/api/v1/measurements", json={**base, "measurementId": layer["contentRef"]})
    assert r.status_code == 409 and r.json()["detail"]["code"] == "MS6"
    # PATCH 也驗契約
    r = driver._client.patch(f"/api/v1/measurements/{layer['contentRef']}", json={"points": [0, 0, 0]})
    assert r.status_code == 422 and r.json()["detail"]["code"] == "MS3"


def test_v10_angle_cobb_curve(driver) -> None:
    """角度剛好 3 點、Cobb 剛好 4 點且要平面、曲線 ≥ 2 點。"""
    driver.load("phantom:landmark")
    for_uid = driver.grid_set["frame_groups"][0]["frame_of_reference_uid"]
    grid_id = driver.display_grid_id
    base = _distance(for_uid, grid_id)
    view = _view(for_uid, grid_id)
    bad = [
        ({**base, "kind": "angle", "points": [0, 0, 0, 1, 0, 0]}, "MS3"),
        ({**base, "kind": "angle", "points": [0, 0, 0, 1, 0, 0, 1, 1, 0, 2, 2, 0]}, "MS3"),
        ({**base, "kind": "cobb", "points": [0, 0, 0, 1, 0, 0, 0, 1, 0]}, "MS3"),
        ({**base, "kind": "cobb", "points": [0, 0, 0, 1, 0, 0, 0, 1, 0, 1, 2, 0]}, "MS4"),
        ({**base, "kind": "curve", "points": [0, 0, 0]}, "MS3"),
    ]
    for body, code in bad:
        r = driver._client.post("/api/v1/measurements", json=body)
        assert r.status_code == 422 and r.json()["detail"]["code"] == code, (body["kind"], r.text)
    ok = [
        {**base, "kind": "angle", "points": [10, 0, 0, 0, 0, 0, 0, 10, 0]},
        {**base, "kind": "cobb", "points": [0, 0, 0, 10, 1, 0, 0, 20, 0, 10, 18, 0], "viewReference": view},
        {**base, "kind": "curve", "points": [0, 0, 0, 3, 4, 0, 3, 4, 12]},
    ]
    kinds = [driver.create_measurement(body)["measurement"]["kind"] for body in ok]
    assert kinds == ["angle", "cobb", "curve"]


def test_v7_landmark_pair(driver) -> None:
    """地標對剛好 2 點、pairFrameOfReferenceUid 必須是這個 session 的 FoR；存得進、讀得回。"""
    driver.load("phantom:two_series")
    fgs = driver.grid_set["frame_groups"]
    primary = next(f for f in fgs if f["role"] == "primary")["frame_of_reference_uid"]
    moving = next(f for f in fgs if f["role"] != "primary")["frame_of_reference_uid"]
    base = {**_distance(moving, driver.display_grid_id), "kind": "landmark", "label": "地標 1"}
    for body, code in [
        ({**base, "points": [0, 0, 0], "pairFrameOfReferenceUid": primary}, "MS3"),
        ({**base, "points": [0, 0, 0, 1, 1, 1, 2, 2, 2], "pairFrameOfReferenceUid": primary}, "MS3"),
        ({**base, "points": [0, 0, 0, 1, 1, 1]}, "MS8"),
        ({**base, "points": [0, 0, 0, 1, 1, 1], "pairFrameOfReferenceUid": "1.2.nope"}, "MS8"),
    ]:
        r = driver._client.post("/api/v1/measurements", json=body)
        assert r.status_code == 422 and r.json()["detail"]["code"] == code, r.text
    layer = driver.create_measurement({**base, "points": [1, 2, 3, 4, 5, 6], "pairFrameOfReferenceUid": primary})
    m = layer["measurement"]
    assert m["kind"] == "landmark" and m["pairFrameOfReferenceUid"] == primary and m["frameOfReferenceUid"] == moving
    assert [x["measurementId"] for x in driver.measurements()] == [m["measurementId"]]


def test_measurement_survives_grid_rebuild(driver) -> None:
    """換網格（Tier 重新協商）不得丟量測 —— routes_grids 已把 measurements 帶過去。"""
    driver.load("phantom:landmark")
    for_uid = driver.grid_set["frame_groups"][0]["frame_of_reference_uid"]
    driver.create_measurement(_distance(for_uid, driver.display_grid_id))
    before = len(driver.measurements())
    driver.grids(webgl2=False, tier="C")
    assert len(driver.measurements()) == before
