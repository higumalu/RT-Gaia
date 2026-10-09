"""RTPLAN 射束清單、治療機、等中心（換到 primary 座標）。只讀，不算劑量。"""

from __future__ import annotations

import sys
from pathlib import Path

import numpy as np
import pytest
from rtgaia_core.loaders.rtplan import read_beam_control_points, read_plan_beams
from rtgaia_testbe.driver import Session

sys.path.insert(0, str(Path(__file__).parent))
from synth_dicom import SynthCase, write_synth_case  # noqa: E402


@pytest.fixture(scope="module")
def synth(tmp_path_factory) -> SynthCase:
    return write_synth_case(tmp_path_factory.mktemp("synth-plan"))


def test_read_plan_beams_sorts_treatment_first_and_reads_arc_and_meterset(synth: SynthCase) -> None:
    info = read_plan_beams(synth.root / "plan_0" / "plan.dcm")
    assert info["label"] == "SYNTH-ART1"
    assert info["patient_positions"] == ["HFS"]
    assert info["fractions_planned"] == 25 and info["prescription_gy"] == [50.0]
    assert [b["number"] for b in info["beams"]] == [2, 3, 1], "治療射束在前、setup 在後，同群照原始編號"
    arc, ap, setup = info["beams"]
    assert arc["is_arc"] and arc["gantry_start_deg"] == 181.0 and arc["gantry_end_deg"] == 179.0
    assert arc["gantry_direction"] == "CW" and arc["control_points"] == 3
    assert arc["meterset"] == pytest.approx(250.5) and arc["collimator_deg"] == 30.0
    assert not ap["is_arc"] and ap["collimator_deg"] == 0.0 and ap["meterset"] == pytest.approx(120.0)
    assert not setup["is_treatment"] and setup["delivery_type"] == "SETUP" and setup["meterset"] is None
    assert arc["energy"] == 6 and arc["energy_unit"] == "MV"
    assert [d["type"] for d in arc["devices"]] == ["X", "Y", "MLCX"]
    assert info["machines"] == [{"name": "SYNTH_LINAC", "manufacturer": "Synthetic", "model": "SynthBeam"}]
    # 三個射束同一個等中心 → 合併成一個
    assert len(info["isocenters"]) == 1
    assert sorted(info["isocenters"][0]["beam_numbers"]) == [1, 2, 3]
    assert np.allclose(info["isocenters"][0]["position_mm"], synth.plan_ct.sphere_center_world)


def test_study_plans_endpoint_maps_isocenter_to_primary(synth: SynthCase) -> None:
    """劑量參照到的 RTPLAN 自動進病例；primary 是計畫 CT → ISO 的 primary 座標 ＝ 自己的座標。"""
    with Session(library_root=str(synth.root)) as s:
        s.load_case(
            {
                "image_series_uids": [synth.plan_ct.series_uid, synth.cbct.series_uid],
                "structure_set_uids": [synth.plan_rs_uid],
                "dose_uids": [synth.plan_dose_uid],
                "registration_uids": [synth.reg_uid],
            },
            webgl2=False,
            tier="C",
        )
        out = s._get(f"/api/v1/studies/{s.study_id}/plans")
        assert [p["plan_id"] for p in out["plans"]] == [synth.plan_uid]
        plan = out["plans"][0]
        assert plan["mappable"] is True
        iso = plan["isocenters"][0]
        assert np.allclose(iso["position_primary_mm"], iso["position_mm"])
        with pytest.raises(RuntimeError, match="404"):
            s._get("/api/v1/studies/no-such-study/plans")


def test_study_plans_cbct_primary_maps_through_registration(synth: SynthCase) -> None:
    """primary 換成 CBCT（FoR B）：計畫在 FoR A → ISO 經 REG 的逆變換到 B，座標不再相同但仍是同一個物理點。"""
    with Session(library_root=str(synth.root)) as s:
        s.load_case(
            {
                "primary_series_uid": synth.cbct.series_uid,
                "image_series_uids": [synth.plan_ct.series_uid, synth.cbct.series_uid],
                "dose_uids": [],
                "plan_uids": [synth.plan_uid],
                "registration_uids": [synth.reg_uid],
            },
            webgl2=False,
            tier="C",
        )
        plan = s._get(f"/api/v1/studies/{s.study_id}/plans")["plans"][0]
        iso = plan["isocenters"][0]
        a_to_b = np.linalg.inv(synth.matrix_b_to_a)
        want = a_to_b[:3, :3] @ np.asarray(iso["position_mm"]) + a_to_b[:3, 3]
        assert np.allclose(iso["position_primary_mm"], want, atol=1e-6)


def test_beam_control_points_carry_forward_mu_and_mlc(synth: SynthCase) -> None:
    """控制點往後帶（第三個 CP 沒寫 jaw／MLC → 沿用第二個）；累積 MU ＝ 權重 × 射束 MU；MU/° 用最短的機架角。"""
    info = read_beam_control_points(synth.root / "plan_0" / "plan.dcm", 2)
    assert info["name"] == "ARC1" and info["meterset"] == pytest.approx(250.5) and info["final_weight"] == 1.0
    mlc = next(d for d in info["devices"] if d["type"] == "MLCX")
    assert mlc["pairs"] == 60 and len(mlc["boundaries_mm"]) == 61 and mlc["boundaries_mm"][0] == -150.0
    cps = info["control_points"]
    assert [c["gantry_deg"] for c in cps] == [181.0, 0.0, 179.0]
    assert [c["collimator_deg"] for c in cps] == [30.0, 30.0, 30.0]
    assert [c["mu"] for c in cps] == pytest.approx([0.0, 125.25, 250.5])
    # 181 → 0（CW）是 179°；0 → 179 也是 179°
    assert cps[1]["mu_per_deg"] == pytest.approx(125.25 / 179.0) and cps[0]["mu_per_deg"] is None
    assert cps[0]["jaws"] == {"x": [-50.0, 50.0], "y": [-40.0, 40.0]}
    assert cps[2]["jaws"] == cps[0]["jaws"], "jaw 沒再寫 → 沿用"
    a0 = cps[0]["mlc"]["MLCX"]["a"]
    assert len(a0) == 60 and a0[29] == -20.0 and a0[0] == 0.0
    assert cps[1]["mlc"]["MLCX"]["a"][29] == -10.0 and cps[2]["mlc"] == cps[1]["mlc"]
    # 床高／俯仰／側傾（沒寫 → None，前端示意用預設）；機名給機型判斷
    assert cps[0]["table_vertical_mm"] is None and info["machine_name"] == "SYNTH_LINAC"
    with pytest.raises(KeyError):
        read_beam_control_points(synth.root / "plan_0" / "plan.dcm", 99)


def test_beam_control_points_endpoint(synth: SynthCase) -> None:
    with Session(library_root=str(synth.root)) as s:
        s.load_case(
            {"image_series_uids": [synth.plan_ct.series_uid], "dose_uids": [synth.plan_dose_uid]},
            webgl2=False,
            tier="C",
        )
        plan_id = s._get(f"/api/v1/studies/{s.study_id}/plans")["plans"][0]["plan_id"]
        out = s._get(f"/api/v1/studies/{s.study_id}/plans/{plan_id}/beams/2")
        assert out["plan_id"] == plan_id and len(out["control_points"]) == 3
        with pytest.raises(RuntimeError, match="404"):
            s._get(f"/api/v1/studies/{s.study_id}/plans/{plan_id}/beams/99")
        with pytest.raises(RuntimeError, match="404"):
            s._get(f"/api/v1/studies/{s.study_id}/plans/nope/beams/2")
