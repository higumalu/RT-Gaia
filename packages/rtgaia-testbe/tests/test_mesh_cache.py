"""mesh 上限、降採樣、磁碟 LRU。純 python 的部分不吃 VTK。"""

from __future__ import annotations

import os
import time
from pathlib import Path

import numpy as np
import pytest
from rtgaia_core import mesh_cache, render3d_vtk
from rtgaia_geom import Grid


def _grid(size=(8, 8, 8), spacing=(1.0, 1.0, 1.0)) -> Grid:
    return Grid(
        origin=(0.0, 0.0, 0.0),
        spacing=spacing,
        size=size,
        direction=(1.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0),
        frame_of_reference_uid="for.test",
    )


def test_settings_from_env_and_defaults(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("RTGAIA_MESH_MAX_TRIANGLES", raising=False)
    monkeypatch.delenv("RTGAIA_MESH_DOWNSAMPLE_NAMES", raising=False)
    s = mesh_cache.MeshSettings.from_env()
    assert s.max_triangles == mesh_cache.DEFAULT_MAX_TRIANGLES
    assert s.downsample_names == mesh_cache.DEFAULT_DOWNSAMPLE_NAMES
    monkeypatch.setenv("RTGAIA_MESH_MAX_TRIANGLES", "20000")
    monkeypatch.setenv("RTGAIA_MESH_DOWNSAMPLE_NAMES", "Table, Skin")
    monkeypatch.setenv("RTGAIA_MESH_CACHE_BYTES", "1024")
    s = mesh_cache.MeshSettings.from_env()
    assert s.max_triangles == 20000 and s.downsample_names == ("Table", "Skin") and s.cache_bytes == 1024
    # 名單：前綴、不分大小寫；大結構靠體素數
    assert mesh_cache.should_downsample("tableTop", 10, s)
    assert not mesh_cache.should_downsample("Bladder", 10, s)
    assert mesh_cache.should_downsample("Bladder", mesh_cache.DOWNSAMPLE_VOXELS + 1, s)
    assert mesh_cache.should_downsample("CouchSurface", 10, mesh_cache.MeshSettings())


def test_downsample2_is_union_and_pads_odd_dims() -> None:
    m = np.zeros((5, 4, 3), dtype=np.uint8)
    m[4, 3, 2] = 1  # 奇數維度最後一格
    m[0, 0, 0] = 1
    d = mesh_cache.downsample2(m)
    assert d.shape == (3, 2, 2)
    assert d[0, 0, 0] == 1 and d[2, 1, 1] == 1 and d.sum() == 2
    g = mesh_cache.downsampled_grid(_grid((3, 4, 5), (0.5, 1.0, 2.0)))
    assert g.size == (2, 2, 3) and g.spacing == (1.0, 2.0, 4.0)
    assert g.origin == pytest.approx((0.25, 0.5, 1.0))


def test_crop_to_bbox_shifts_origin_along_direction() -> None:
    m = np.zeros((6, 7, 8), dtype=np.uint8)  # kji
    m[3, 4, 5] = 1
    cropped, g = mesh_cache.crop_to_bbox(m, _grid((8, 7, 6), (1.0, 2.0, 3.0)))
    assert cropped.shape == (3, 3, 3) and cropped[1, 1, 1] == 1
    assert g.size == (3, 3, 3)
    assert g.origin == pytest.approx((4 * 1.0, 3 * 2.0, 2 * 3.0))  # lo = (i=4, j=3, k=2)
    # 貼邊：不會裁出負索引
    m2 = np.zeros((4, 4, 4), dtype=np.uint8)
    m2[0, 0, 0] = 1
    c2, g2 = mesh_cache.crop_to_bbox(m2, _grid((4, 4, 4)))
    assert c2.shape == (2, 2, 2) and g2.origin == (0.0, 0.0, 0.0)
    # 全零：原樣
    c3, g3 = mesh_cache.crop_to_bbox(np.zeros((2, 2, 2), dtype=np.uint8), _grid((2, 2, 2)))
    assert c3.shape == (2, 2, 2) and g3.size == (2, 2, 2)


def test_mesh_key_changes_with_hash_grid_and_params() -> None:
    s = mesh_cache.MeshSettings()
    k = mesh_cache.mesh_key("GTV", "h1", _grid(), s, False)
    assert k == mesh_cache.mesh_key("GTV", "h1", _grid(), s, False)
    assert k != mesh_cache.mesh_key("GTV", "h2", _grid(), s, False)
    assert k != mesh_cache.mesh_key("GTV", "h1", _grid(spacing=(2.0, 1.0, 1.0)), s, False)
    assert k != mesh_cache.mesh_key("GTV", "h1", _grid(), mesh_cache.MeshSettings(max_triangles=10), False)
    assert k != mesh_cache.mesh_key("GTV", "h1", _grid(), s, True)


def test_prune_is_lru_by_mtime(tmp_path: Path) -> None:
    files = []
    for i in range(4):
        p = tmp_path / f"{i}.vtp"
        p.write_bytes(b"x" * 100)
        os.utime(p, (1_000 + i, 1_000 + i))
        files.append(p)
    (tmp_path / "other.txt").write_bytes(b"y" * 1000)  # 不是 .vtp，不動
    removed = mesh_cache.prune(tmp_path, 250)
    assert [p.name for p in removed] == ["0.vtp", "1.vtp"]
    assert (tmp_path / "other.txt").exists()
    assert mesh_cache.prune(tmp_path, 250) == []
    assert mesh_cache.cache_path(mesh_cache.MeshSettings(cache_dir=None), "k") is None
    assert mesh_cache.cache_path(mesh_cache.MeshSettings(cache_dir=tmp_path, cache_bytes=0), "k") is None


@pytest.mark.skipif(not render3d_vtk.available(), reason="沒有 VTK／EGL")
def test_build_decimates_and_round_trips_disk(tmp_path: Path) -> None:
    from rtgaia_core.render3d_vtk import _image_data

    z, y, x = np.mgrid[0:32, 0:32, 0:32]
    mask = (((z - 16) ** 2 + (y - 16) ** 2 + (x - 16) ** 2) < 12**2).astype(np.uint8)
    grid = _grid((32, 32, 32))
    full = mesh_cache.MeshSettings(max_triangles=10**7, cache_dir=tmp_path)
    pd, info = mesh_cache.build_polydata(mask, grid, full, image_data=lambda m, g: _image_data(m, g, 3))
    assert info["triangles"] > 1000 and not info["decimated"]
    small = mesh_cache.MeshSettings(max_triangles=1000, cache_dir=tmp_path)
    pd2, info2 = mesh_cache.build_polydata(mask, grid, small, image_data=lambda m, g: _image_data(m, g, 3))
    assert info2["decimated"] and info2["triangles"] <= 1200 and info2["triangles"] < info["triangles"]
    key = mesh_cache.mesh_key("S", "h", grid, small, False)
    assert mesh_cache.load_polydata(small, key) is None
    path = mesh_cache.save_polydata(small, key, pd2)
    assert path is not None and path.exists()
    before = path.stat().st_mtime
    time.sleep(0.01)
    back = mesh_cache.load_polydata(small, key)
    assert back is not None and back.GetNumberOfPolys() == pd2.GetNumberOfPolys()
    assert path.stat().st_mtime >= before  # 命中更新 mtime（LRU）


@pytest.mark.skipif(not render3d_vtk.available(), reason="沒有 VTK／EGL")
def test_interactive_skips_volume_and_prepare_route(driver, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("RTGAIA_MESH_CACHE", "0")  # 測試不寫 repo 的 .rtgaia/cache
    render3d_vtk.reset_mesh_settings()
    driver.load("phantom:overlap_set")
    series = driver.grid_set["frame_groups"][0]["series_id"]
    sid = driver.structures()[0]["structure_id"]
    layers = [
        {"renderer": "volume-3d", "series_id": series, "opacity": 1.0},
        {"renderer": "mesh", "structure_id": sid, "color": [1, 0, 0], "opacity": 0.5},
    ]
    header, _ = driver.render3d(output_size_px=(64, 64), layers=layers, interactive=True)
    used = header["layers_used"]
    assert any(u.get("skipped") == "interactive" for u in used if u["renderer"] == "volume-3d")
    header2, _ = driver.render3d(output_size_px=(64, 64), layers=layers)
    assert not any(u.get("skipped") for u in header2["layers_used"])
    out = driver._post(f"/api/v1/studies/{driver._study}/render3d/prepare", {"structure_ids": [sid]})
    assert out["available"] is True and out["total"] == 1 and out["in_memory"] == 1  # 上面出過圖 → 記憶體已有
