"""VTK 體積渲染：GPU 優先 CPU 備援、TF、等值面、次要 FoR、MIP 仍在、無 VTK 的退路。"""

from __future__ import annotations

import numpy as np
import pytest
from rtgaia_core import render3d_vtk

pytestmark = pytest.mark.skipif(not render3d_vtk.available(), reason="沒有 VTK／EGL")


def _lit(png_header_png) -> int:
    """PNG 位元組數當「畫面有東西」的粗略指標（全黑 PNG 很小）。"""
    return len(png_header_png)


def test_composite_default_gpu_first_then_cpu(driver) -> None:
    driver.load("phantom:overlap_set")
    header, png = driver.render3d(output_size_px=(96, 96))
    assert header["technique_used"] == "composite"
    assert header["mapper_used"] in ("gpu", "cpu")
    assert png[:8] == b"\x89PNG\r\n\x1a\n" and header["width"] == 96
    assert "position" in header["camera_used"]
    expected = "gpu" if render3d_vtk.gpu_available() else "cpu"
    assert header["mapper_used"] == expected
    # 強制 CPU
    h_cpu, png_cpu = driver.render3d(output_size_px=(96, 96), mapper="cpu")
    assert h_cpu["mapper_used"] == "cpu"
    assert _lit(png_cpu) > 300  # 不是全黑
    # 舊路徑仍在
    h_mip, _ = driver.render3d(output_size_px=(96, 96), technique="mip")
    assert h_mip["technique_used"] == "mip" and h_mip["mapper_used"] == "rust-mip"


def test_transfer_functions_change_the_image(driver) -> None:
    driver.load("phantom:overlap_set")
    series = driver.grid_set["frame_groups"][0]["series_id"]
    base = {"renderer": "volume-3d", "series_id": series, "opacity": 1.0}
    tf1 = {
        **base,
        "scalar_opacity": [[-1000, 0], [0, 0], [500, 0.9]],
        "scalar_color": [[-1000, 0, 0, 0], [500, 1, 1, 1]],
    }
    tf2 = {
        **base,
        "scalar_opacity": [[-1000, 0], [-500, 0.9], [500, 0.9]],
        "scalar_color": [[-1000, 1, 0, 0], [500, 1, 0, 0]],
        "shade": False,
    }
    h1, png1 = driver.render3d(output_size_px=(96, 96), layers=[tf1])
    h2, png2 = driver.render3d(output_size_px=(96, 96), layers=[tf2])
    assert png1 != png2
    # 同 TF 再要一張 → 快取命中，結果一致
    h3, png3 = driver.render3d(output_size_px=(96, 96), layers=[tf1])
    assert png3 == png1


def test_mesh_surface_and_secondary_frame_group(driver) -> None:
    """結構畫等值面；次要 FoR 的結構套 transform_to_primary（two_series 有 REG 真值）。"""
    driver.load("phantom:two_series")
    fgs = driver.grid_set["frame_groups"]
    secondary_for = next(f for f in fgs if f["role"] == "secondary")["frame_of_reference_uid"]
    structures = driver.structures()
    sec = [s for s in structures if s.get("frame_of_reference_uid") == secondary_for]
    prim = [s for s in structures if s.get("frame_of_reference_uid") != secondary_for]
    layers = [{"renderer": "mesh", "structure_id": prim[0]["structure_id"], "color": [0, 1, 0], "opacity": 0.6}]
    if sec:
        layers.append({"renderer": "mesh", "structure_id": sec[0]["structure_id"], "color": [1, 0, 0], "opacity": 0.6})
    header, png = driver.render3d(output_size_px=(96, 96), layers=layers)
    assert header["technique_used"] == "composite"
    assert [u["renderer"] for u in header["layers_used"]] == ["mesh"] * len(layers)
    assert _lit(png) > 300
    # 次要序列的體積也能進來（actor 套 userMatrix）
    sec_series = next(f for f in fgs if f["role"] == "secondary")["series_id"]
    h2, png2 = driver.render3d(
        output_size_px=(96, 96), layers=[{"renderer": "volume-3d", "series_id": sec_series, "opacity": 1.0}]
    )
    assert h2["layers_used"][0]["series_id"] == sec_series


def test_reverse_pick_hits_mesh_surface_and_misses_background(driver) -> None:
    """反向 pick：overlap_set 的 GTV 是圓心在原點、半徑 20 mm 的球；相機在 +z 500 mm 看原點。
    畫面正中央的視線打在球面 z ≈ +20；角落的視線打不到東西。"""
    driver.load("phantom:overlap_set")
    gtv = next(s for s in driver.structures() if s["name"].upper() == "GTV")
    layers = [{"renderer": "mesh", "structure_id": gtv["structure_id"], "color": [1, 0, 0], "opacity": 1.0}]
    hit = driver.render3d_pick(48, 48, layers=layers, output_size_px=(96, 96))
    assert hit["hit"] is True
    x, y, z = hit["world"]
    assert abs(x) < 3 and abs(y) < 3 and z == pytest.approx(20.0, abs=2.5)
    miss = driver.render3d_pick(1, 1, layers=layers, output_size_px=(96, 96))
    assert miss["hit"] is False and miss["world"] is None
    # 體積：不透明的組織擋在前面 → 打到的點在球心的相機側
    series = driver.grid_set["frame_groups"][0]["series_id"]
    vol = [
        {
            "renderer": "volume-3d",
            "series_id": series,
            "opacity": 1.0,
            "scalar_opacity": [[-1000, 0], [-300, 0], [0, 1.0], [3000, 1.0]],
            "scalar_color": [[-1000, 0, 0, 0], [3000, 1, 1, 1]],
        }
    ]
    vhit = driver.render3d_pick(48, 48, layers=vol, output_size_px=(96, 96))
    assert vhit["hit"] is True and vhit["world"][2] > 0


def test_3d_follows_temporal_frame(driver) -> None:
    """3D 出圖跟著相位 —— 影像與結構的 layer 帶 `frame_index`，VTK 快取 key 也帶（以前永遠是相位 0 那份）。"""
    driver.load("phantom:four_d_ct")
    series = driver.grid_set["frame_groups"][0]["series_id"]

    def layers(frame: int) -> list[dict]:
        return [
            {"renderer": "mesh", "structure_id": "gtv_4d", "frame_index": frame, "color": [1, 0, 0], "opacity": 1.0},
            {"renderer": "volume-3d", "series_id": series, "opacity": 0.3, "frame_index": frame},
        ]

    camera = driver.view_reference(view_plane_normal=(1.0, 0.0, 0.0), view_up=(0.0, 0.0, 1.0))
    _, png0 = driver.render3d(output_size_px=(96, 96), layers=layers(0), camera=camera)
    _, png5 = driver.render3d(output_size_px=(96, 96), layers=layers(5), camera=camera)
    _, png0b = driver.render3d(output_size_px=(96, 96), layers=layers(0), camera=camera)
    assert png0 != png5  # GTV 每相位沿 z 移 6 mm
    assert png0b == png0  # 回到相位 0 用回相位 0 的快取


def test_crop_and_zoom_apply_to_vtk(driver) -> None:
    driver.load("phantom:overlap_set")
    h1, png1 = driver.render3d(output_size_px=(96, 96))
    h2, png2 = driver.render3d(output_size_px=(96, 96), zoom=2.0)
    assert h2["camera_used"]["distance_mm"] == pytest.approx(h1["camera_used"]["distance_mm"] / 2)
    assert png1 != png2
    g = driver.grid_set["display_grid"]["grid"]
    o, sp, n = g["origin"], g["spacing"], g["size"]
    hi = [o[i] + sp[i] * (n[i] - 1) for i in range(3)]
    crop = {"min": [o[0], o[1], (o[2] + hi[2]) / 2], "max": hi}
    h3, png3 = driver.render3d(output_size_px=(96, 96), crop=crop)
    assert h3["crop_used"] == crop and png3 != png1


def test_status_reports_window_and_gpu() -> None:
    st = render3d_vtk.status()
    assert st["available"] is True
    assert "window_class" in st
    assert isinstance(st["gpu"], bool)
    assert np.isfinite(1.0)


def _pixels(png: bytes) -> np.ndarray:
    import io

    from PIL import Image

    return np.asarray(Image.open(io.BytesIO(png)).convert("RGB"), dtype=np.float32)


def _diff(a: np.ndarray, b: np.ndarray) -> float:
    return float(np.abs(a - b).mean())


def test_dose_volume_3d_float_gy(tmp_path) -> None:  # type: ignore[no-untyped-def]
    """劑量的 3D 體積（`dose-3d`）—— float Gy（不截成整數）、TF 以 Gy 為軸；疊在 CT 上畫面會變；
    影像序列不能當 dose-3d（422）、沒帶 TF 422；結構整批驗真的有驗（404）。"""
    from rtgaia_testbe import Session
    from synth_dicom import write_synth_case

    synth = write_synth_case(tmp_path / "synth")
    with Session(library_root=str(synth.root)) as s:
        s.load_case(
            {
                "image_series_uids": [synth.plan_ct.series_uid],
                "structure_set_uids": [synth.plan_rs_uid],
                "dose_uids": [synth.plan_dose_uid],
            }
        )
        ct = {
            "renderer": "volume-3d",
            "series_id": synth.plan_ct.series_uid,
            "opacity": 1.0,
            "scalar_opacity": [[-1000, 0], [200, 0], [1000, 0.6]],
            "scalar_color": [[-1000, 0, 0, 0], [1000, 1, 1, 1]],
        }
        top = synth.plan_dose_max_gy

        def dose(threshold: float) -> dict:
            return {
                "renderer": "dose-3d",
                "series_id": synth.plan_dose_uid,
                "opacity": 1.0,
                "scalar_opacity": [[max(0.0, threshold - 0.001), 0], [threshold, 0.05], [top, 0.6]],
                "scalar_color": [[threshold, 0, 0, 1], [top, 1, 0, 0]],
                "shade": False,
            }

        h0, only_ct = s.render3d(output_size_px=(96, 96), layers=[ct], mapper="cpu")
        h1, with_dose = s.render3d(output_size_px=(96, 96), layers=[ct, dose(top * 0.1)], mapper="cpu")
        assert h1["technique_used"] == "composite" and with_dose != only_ct
        # 閾值只比最大劑量低一點點：若被截成整數 Gy，最大值那格也會掉到閾值下而全透明
        _, near_top = s.render3d(output_size_px=(96, 96), layers=[ct, dose(top - 0.05)], mapper="cpu")
        _, above = s.render3d(output_size_px=(96, 96), layers=[ct, {**dose(top * 0.1), "opacity": 0.0}], mapper="cpu")
        base = _pixels(only_ct)
        # 全透明（圖層 opacity 0）的劑量體積仍讓 VTK 的多體積合成有極細微差異 → 比「差多少」而不是逐位元組相同。
        # 合成劑量最大 47.89 Gy：閾值 47.84 時只有最高那幾格看得到；若被截成整數（47）就會全透明、跟 opacity 0 一樣
        transparent = _diff(_pixels(above), base)
        assert transparent < 0.005 and _diff(_pixels(with_dose), base) > 0.1
        assert _diff(_pixels(near_top), base) > max(0.005, 5 * transparent)
        with pytest.raises(RuntimeError, match="NOT_DOSE"):
            s.render3d(output_size_px=(64, 64), layers=[{**dose(1.0), "series_id": synth.plan_ct.series_uid}])
        with pytest.raises(RuntimeError, match="422"):
            s.render3d(output_size_px=(64, 64), layers=[{"renderer": "dose-3d", "series_id": synth.plan_dose_uid}])
        with pytest.raises(RuntimeError, match="404"):
            s.render3d(
                output_size_px=(64, 64), layers=[{"renderer": "mesh", "structure_id": "nope", "color": [1, 0, 0]}]
            )
