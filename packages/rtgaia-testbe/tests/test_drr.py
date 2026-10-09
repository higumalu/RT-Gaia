"""DRR：線積分的解析值、預設對比、結構投影、不支援的幾何要擋掉、端點（合成病例）。"""

from __future__ import annotations

import base64
import sys
from pathlib import Path

import numpy as np
import pytest
from rtgaia_core.drr import (
    UnsupportedGeometry,
    apply_preset,
    attenuation_volume,
    bev_pixels_mm,
    check_geometry,
    drr,
    line_integrals,
    project_structure,
)
from rtgaia_geom import Grid
from rtgaia_testbe.driver import Session

sys.path.insert(0, str(Path(__file__).parent))
from synth_dicom import SynthCase, write_synth_case  # noqa: E402


def _cube_grid() -> Grid:
    return Grid(
        size=(50, 50, 50),
        spacing=(2.0, 2.0, 2.0),
        origin=(-49.0, -49.0, -49.0),
        direction=(1, 0, 0, 0, 1, 0, 0, 0, 1),
        frame_of_reference_uid="1.2.3",
    )


def test_line_integral_through_uniform_cube_equals_thickness() -> None:
    """μ = 1、邊長 100 mm 的立方體：穿過中心的射線 ＝ 100；斜一點的也穿過 100 mm 厚（只多一點點）；沒碰到的 ＝ 0。"""
    g = _cube_grid()
    mu = np.ones((50, 50, 50), dtype=np.float32)
    v = line_integrals(
        mu, g, np.array([0.0, -1000.0, 0.0]), np.array([[0.0, 0.0, 0.0], [30.0, 0.0, 0.0], [0, 0, 200.0]])
    )
    assert v[0] == pytest.approx(100.0, abs=0.5)
    assert v[1] == pytest.approx(100.0 / np.cos(np.arctan(30.0 / 1000.0)), abs=0.5)
    assert v[2] == 0.0


def test_drr_magnification_and_presets() -> None:
    """機架 0（射源在前方）：100 mm 的立方體在等中心平面的影子 ≈ 100 × 1000 ／（1000 − 50）≈ 105 mm 寬。"""
    g = _cube_grid()
    mu = np.ones((50, 50, 50), dtype=np.float32)
    img = drr(
        mu,
        g,
        iso_world=[0, 0, 0],
        gantry_deg=0,
        collimator_deg=0,
        couch_deg=0,
        position="HFS",
        sad_mm=1000,
        size=150,
        half_mm=150,
    )
    row = img[75] > 1.0  # 中間那一列
    uv = bev_pixels_mm(150, 150)
    width = float(uv[75, row, 0].max() - uv[75, row, 0].min()) + 2.0  # 像素中心 → 外緣
    assert width == pytest.approx(105.0, abs=3.0)
    for preset in ("soft", "high", "raw", "custom"):
        gray = apply_preset(img, preset, (0.5, 1.0))
        # 柔和：中位數 → 0.5（均勻立方體幾乎全是中位數）；其他：最大值拉到接近 255
        assert gray.dtype == np.uint8 and gray.max() > (100 if preset == "soft" else 200) and gray[0, 0] == 0
    assert apply_preset(np.zeros((4, 4)), "high").max() == 0


def test_attenuation_volume_water_and_air() -> None:
    hu = np.array([[[-1000, 0], [1000, -2000]]], dtype=np.int16).repeat(2, axis=0)
    mu, g = attenuation_volume(hu, _cube_grid(), factor=1)
    assert mu[0, 0, 0] == 0.0 and mu[0, 0, 1] == 1.0 and mu[0, 1, 0] == 2.0 and mu[0, 1, 1] == 0.0


def test_project_structure_silhouette() -> None:
    """等中心上一顆半徑 20 mm 的球（表面點）→ BEV 上一個圓，半徑 ≈ 20 × 1000／1000。"""
    t = np.linspace(0, np.pi, 40)
    p = np.linspace(0, 2 * np.pi, 80)
    tt, pp = np.meshgrid(t, p)
    pts = np.stack([20 * np.sin(tt) * np.cos(pp), 20 * np.sin(tt) * np.sin(pp), 20 * np.cos(tt)], axis=-1).reshape(
        -1, 3
    )
    lines = project_structure(
        pts,
        iso_world=[0, 0, 0],
        gantry_deg=0,
        collimator_deg=0,
        couch_deg=0,
        position="HFS",
        sad_mm=1000,
        size=200,
        half_mm=100,
    )
    assert len(lines) == 1
    r = np.linalg.norm(np.asarray(lines[0]), axis=1)
    assert r.mean() == pytest.approx(20.0, abs=1.5)


def test_unsupported_geometry_is_refused() -> None:
    check_geometry({"gantry_pitch_deg": 0.0, "table_pitch_deg": None, "table_roll_deg": 0.0}, "HFS")
    with pytest.raises(UnsupportedGeometry, match="機架俯仰"):
        check_geometry({"gantry_pitch_deg": 10.0}, "HFS")
    with pytest.raises(UnsupportedGeometry, match="pitch"):
        check_geometry({"table_pitch_deg": 2.0}, "HFS")
    with pytest.raises(UnsupportedGeometry, match="擺位"):
        check_geometry({}, "HFDR")


@pytest.fixture(scope="module")
def synth(tmp_path_factory) -> SynthCase:
    return write_synth_case(tmp_path_factory.mktemp("synth-drr"))


def test_drr_endpoint(synth: SynthCase) -> None:
    with Session(library_root=str(synth.root)) as s:
        s.load_case(
            {
                "image_series_uids": [synth.plan_ct.series_uid],
                "structure_set_uids": [synth.plan_rs_uid],
                "dose_uids": [synth.plan_dose_uid],
            },
            webgl2=False,
            tier="C",
        )
        plan_id = s._get(f"/api/v1/studies/{s.study_id}/plans")["plans"][0]["plan_id"]
        ptv = next(st["structure_id"] for st in s.structures() if st["name"] == "PTV")
        out = s._get(
            f"/api/v1/studies/{s.study_id}/plans/{plan_id}/beams/2/drr", cp=1, size=96, half=60, structure_ids=ptv
        )
        png = base64.b64decode(out["png_base64"])
        assert png[:8] == b"\x89PNG\r\n\x1a\n" and out["size"] == 96 and out["cp"] == 1 and out["gantry_deg"] == 0.0
        assert out["ct_series_id"] == synth.plan_ct.series_uid
        assert out["contours"][0]["structure_id"] == ptv and out["contours"][0]["polylines"], "PTV 投影出一條輪廓"
        with pytest.raises(RuntimeError, match="422"):
            s._get(f"/api/v1/studies/{s.study_id}/plans/{plan_id}/beams/2/drr", preset="nope")
        with pytest.raises(RuntimeError, match="404"):
            s._get(f"/api/v1/studies/{s.study_id}/plans/{plan_id}/beams/99/drr")
