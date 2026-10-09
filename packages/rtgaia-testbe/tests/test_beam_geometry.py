"""射束幾何：射源位置、射束座標系、開口（與前端同一套規則）、3D 的線與面、2D 弧刻度用的軌跡。

座標慣例見 `rtgaia_core.beam_geometry`（IEC 61217 示意：只處理機架、准直器、床角與四種病人擺位）。
"""

from __future__ import annotations

import sys
from pathlib import Path

import numpy as np
import pytest
from rtgaia_core import render3d_vtk
from rtgaia_core.beam_geometry import (
    aperture_rects,
    beam_primitives,
    bld_to_lps,
    rotation_axis_lps,
    source_lps,
)
from rtgaia_core.loaders.rtplan import read_beam_control_points
from rtgaia_testbe.driver import Session

sys.path.insert(0, str(Path(__file__).parent))
from synth_dicom import SynthCase, write_synth_case  # noqa: E402


@pytest.mark.parametrize(
    ("gantry", "position", "expected"),
    [
        (0, "HFS", (0, -1000, 0)),  # 正上方 ＝ 病人前方（LPS −y）
        (90, "HFS", (1000, 0, 0)),  # 90° ＝ 病人左側（+x）
        (180, "HFS", (0, 1000, 0)),
        (270, "HFS", (-1000, 0, 0)),
        (0, "HFP", (0, 1000, 0)),  # 趴著：正上方是病人背後
        (90, "FFS", (-1000, 0, 0)),  # 腳先進：機架 90° 在病人右側
    ],
)
def test_source_position_by_gantry_and_patient_position(gantry: float, position: str, expected: tuple) -> None:
    assert np.allclose(source_lps([0, 0, 0], gantry, 0, 1000, position), expected, atol=1e-6)


def test_bld_axes_collimator_and_rotation_axis() -> None:
    r = bld_to_lps(0, 0, 0, "HFS")
    assert np.allclose(r[:, 0], [1, 0, 0]) and np.allclose(r[:, 1], [0, 0, 1]) and np.allclose(r[:, 2], [0, -1, 0])
    r90 = bld_to_lps(0, 90, 0, "HFS")
    assert np.allclose(r90[:, 0], [0, 0, 1]), "准直器 90°：BLD x 轉到頭側"
    assert np.allclose(rotation_axis_lps(0, "HFS"), [0, 0, 1])
    # 床轉 90°：旋轉軸跟著床轉到水平（病人左右）
    assert abs(float(rotation_axis_lps(90, "HFS")[2])) < 1e-9


def test_aperture_rects_dual_layer_intersection_matches_frontend_rule() -> None:
    devices = [
        {"type": "X", "pairs": 1, "boundaries_mm": None},
        {"type": "MLCX1", "pairs": 2, "boundaries_mm": [-10, 0, 10]},
        {"type": "MLCX2", "pairs": 2, "boundaries_mm": [-5, 5, 15]},
    ]
    cp = {
        "jaws": {"x": [-100, 100], "y": [-100, 100]},
        "mlc": {"MLCX1": {"a": [-20, -10], "b": [20, -10]}, "MLCX2": {"a": [-5, -5], "b": [30, 30]}},
    }
    # 與 apps/viewer/tests/plan-bev.test.ts 的「雙層：兩層都開才有光」同一組資料、同一個答案
    assert aperture_rects(cp, devices) == [(-5, 20, -5, 0)]
    assert aperture_rects({"jaws": {"x": [-3, 3], "y": [-4, 4]}, "mlc": {}}, devices[:1]) == [(-3, 3, -4, 4)]


@pytest.fixture(scope="module")
def synth(tmp_path_factory) -> SynthCase:
    return write_synth_case(tmp_path_factory.mktemp("synth-geom"))


def test_beam_primitives_trajectory_ticks_and_current_aperture(synth: SynthCase) -> None:
    cps = read_beam_control_points(synth.root / "plan_0" / "plan.dcm", 2)
    iso = list(synth.plan_ct.sphere_center_world)
    beams = [{"number": 2, "is_treatment": True, "iso_lps": iso, "cps": cps}]
    shift = np.eye(4)
    shift[:3, 3] = [10, 20, 30]
    out = beam_primitives(beams, (2, 0), "HFS", shift)
    # 中心軸：第一個 CP 的射源（機架 181°，病人後方）→ 等中心；全部 ＋ 平移（換到 primary）
    axis = out["lines"][0]["points"]
    assert np.allclose(axis[1], np.add(iso, [10, 20, 30]))
    src = np.subtract(axis[0], axis[1])
    assert np.linalg.norm(src) == pytest.approx(1000.0) and src[1] > 990, "181° ≈ 正下方（病人後方 +y）"
    # 弧：軌跡（每個 CP 一點）＋ 刻度
    assert any(len(x.get("points") or []) == 3 for x in out["lines"][1:])
    assert any(x.get("segments") for x in out["lines"])
    # 目前 CP 的開口：8 對開著的葉片（|y| < 20、x −20…30）→ 一組四邊形，落在等中心平面（離射源 1000 mm）
    quads = np.asarray(out["polys"][0]["quads"])
    assert quads.shape[1:] == (4, 3) and len(quads) == 8
    assert np.allclose(np.linalg.norm(quads.reshape(-1, 3) - axis[0], axis=1).min(), 1000.0, atol=40.0)


def test_beams_endpoint_track_and_render3d_layer(synth: SynthCase) -> None:
    with Session(library_root=str(synth.root)) as s:
        s.load_case(
            {"image_series_uids": [synth.plan_ct.series_uid], "dose_uids": [synth.plan_dose_uid]},
            webgl2=False,
            tier="C",
        )
        plan_id = s._get(f"/api/v1/studies/{s.study_id}/plans")["plans"][0]["plan_id"]
        out = s._get(f"/api/v1/studies/{s.study_id}/plans/{plan_id}/beams/2")
        tr = out["track"]
        assert len(tr["source_primary_mm"]) == 3 and np.allclose(tr["rotation_axis_primary"], [0, 0, 1])
        assert np.allclose(tr["iso_primary_mm"], synth.plan_ct.sphere_center_world)
        if render3d_vtk.available():
            header, png = s.render3d(
                layers=[
                    {"renderer": "beams", "plan_id": plan_id, "beam_number": 2, "cp": 1},
                    {"renderer": "beams", "plan_id": "not-in-case"},  # 不在病例裡 → 略過，不報錯
                ],
                technique="composite",
                output_size_px=(96, 96),
                distance_mm=2500.0,
            )
            assert any(x["renderer"] == "primitives" for x in header["layers_used"])
            assert len(png) > 100
