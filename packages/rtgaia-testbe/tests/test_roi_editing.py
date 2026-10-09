"""結構 PATCH／DELETE／copy、閾值分割與區域生長 op、schema 的 x-ui-widget。"""

from __future__ import annotations

import numpy as np
import pytest


def test_update_delete_copy_structure(driver) -> None:
    driver.load("phantom:overlap_set")
    sid = driver.structures()[0]["structure_id"]
    n0 = len(driver.structures())
    out = driver.update_structure(sid, name="Renamed", color_rgb=[1, 2, 300], tg263_code="GTV")
    assert out["name"] == "Renamed" and out["color_rgb"] == [1, 2, 255] and out["tg263_code"] == "GTV"
    assert driver.state["push_history_tail"][-1]["type"] == "layer.update"
    layer = next(x for x in driver.state["layers"] if x["contentRef"] == sid)
    assert layer["label"] == "Renamed" and layer["color"] == [1, 2, 255]
    r = driver._client.patch(f"/api/v1/structures/{sid}", json={"color_rgb": [1, 2]})
    assert r.status_code == 422 and r.json()["detail"]["code"] == "BAD_COLOR"

    copy = driver.copy_structure(sid)
    assert copy["source_structure_id"] == sid and copy["structure_id"].startswith(sid)
    assert len(driver.structures()) == n0 + 1
    entry = next(e for e in driver.structures() if e["structure_id"] == copy["structure_id"])
    assert entry["name"] == "Renamed 複本" and entry["status"] == "under_review"
    assert entry["provenance"]["parent_hash"] == copy["content_hash"]
    _h, a = driver.mask(sid)
    _h2, b = driver.mask(copy["structure_id"])
    assert np.array_equal(a, b)
    assert driver.state["push_history_tail"][-1]["type"] == "layer.add"

    driver.delete_structure(copy["structure_id"])
    assert len(driver.structures()) == n0
    assert driver.state["push_history_tail"][-1] == {
        "type": "layer.remove",
        "payload": {"layerId": f"mask:{copy['structure_id']}"},
    }
    with pytest.raises(RuntimeError, match="404"):
        driver.delete_structure(copy["structure_id"])


def test_ops_schema_has_new_widgets(driver) -> None:
    driver.load("phantom:overlap_set")
    ops = {o["op"]: o for o in driver.ops()}
    assert {"threshold", "region_grow"} <= set(ops)
    th = ops["threshold"]["params_schema"]["properties"]
    assert th["hu_range"]["x-ui-widget"] == "hu-range" and th["bbox_ijk"]["x-ui-widget"] == "bbox"
    rg = ops["region_grow"]["params_schema"]["properties"]
    assert rg["seed_ijk"]["x-ui-widget"] == "seed" and rg["connectivity"]["enum"] == [6, 26]


def _dense(driver, sid: str) -> np.ndarray:
    """`driver.mask()` 回的是裁到 bbox 的區塊；攤回 mask grid 的 dense。"""
    header, block = driver.mask(sid)
    size = driver.grid_set["mask_grid"]["grid"]["size"]
    out = np.zeros((size[2], size[1], size[0]), dtype=np.uint8)
    o, s = header["offset_ijk"], header["size_ijk"]
    out[o[2] : o[2] + s[2], o[1] : o[1] + s[1], o[0] : o[0] + s[0]] = (
        block.reshape(s[2], s[1], s[0]) if block.ndim == 1 else block
    )
    return out


def test_threshold_and_region_grow(driver) -> None:
    driver.load("phantom:overlap_set")
    sid = driver.structures()[0]["structure_id"]
    series = driver.grid_set["frame_groups"][0]["series_id"]
    _hdr, img = driver.image(series)  # (k, j, i)，overlap_set 的 display grid ＝ mask grid
    assert tuple(img.shape) == tuple(_dense(driver, sid).shape)
    # 閾值：整個範圍 → 全部；相減回空；方框內只有方框
    header = driver.postprocess(sid, "threshold", hu_range=[-5000, 5000], mode="replace")
    assert _dense(driver, sid).all()
    driver.postprocess(sid, "threshold", hu_range=[-5000, 5000], mode="subtract")
    assert not _dense(driver, sid).any()
    driver.postprocess(
        sid, "threshold", hu_range=[-5000, 5000], mode="replace", bbox_ijk={"offset": [1, 2, 3], "size": [4, 5, 2]}
    )
    m = _dense(driver, sid)
    assert int(m.sum()) == 4 * 5 * 2 and m[3:5, 2:7, 1:5].all()
    # 區域生長：以中央體素的值 ±50 當區間，結果含種子、是單一連通區域
    k, j, i = (n // 2 for n in img.shape)
    v = float(img[k, j, i])
    driver.postprocess(
        sid, "region_grow", seed_ijk=[i, j, k], hu_range=[v - 50, v + 50], connectivity=26, mode="replace"
    )
    grown = _dense(driver, sid)
    assert grown[k, j, i] == 1
    import SimpleITK as sitk

    cc = sitk.GetArrayFromImage(sitk.ConnectedComponent(sitk.GetImageFromArray(grown.astype(np.uint8))))
    assert cc.max() == 1
    # 2D：只在種子那一層
    driver.postprocess(
        sid, "region_grow", seed_ijk=[i, j, k], hu_range=[v - 50, v + 50], per_slice=True, mode="replace"
    )
    g2 = _dense(driver, sid)
    assert g2[k].any() and not np.delete(g2, k, axis=0).any()
    # 種子不在區間 → 4xx
    r = driver._client.post(
        f"/api/v1/structures/{sid}/postprocess",
        json={
            "op": "region_grow",
            "params": {"seed_ijk": [i, j, k], "hu_range": [v + 1000, v + 2000]},
            "mask_grid_id": driver.mask_grid_id,
        },
    )
    assert r.status_code >= 400
    assert header["op"] == "threshold"
