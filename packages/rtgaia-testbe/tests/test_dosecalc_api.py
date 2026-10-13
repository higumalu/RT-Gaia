"""劑量計算的 API（流程測試引擎；Geant4 另有自己的測試）：送出 → worker 子行程 → 進度 → 載回成暫存劑量
（總劑量 ＋ 逐射束）→ 可以做 γ、存成 RTDOSE（衍生說明寫引擎與模型）；不支援的計畫拒算並列原因；取消；別人看不到。"""

from __future__ import annotations

import io
import time
from pathlib import Path

import pydicom
import pytest
from rtgaia_testbe import Session
from rtgaia_testbe.fixtures import synth_plan


@pytest.fixture(scope="module")
def case(tmp_path_factory):  # type: ignore[no-untyped-def]
    return synth_plan.build(tmp_path_factory.mktemp("synth-plan-api"))


def _selection(case) -> dict:  # type: ignore[no-untyped-def]
    e = case.expected
    return {
        "image_series_uids": [e["ct_series_instance_uid"]],
        "plan_uids": [e["plan_series_instance_uid"]],
        "dose_uids": [],
    }


def _wait(s: Session, base: str, job_id: str, timeout: float = 240.0) -> dict:
    deadline = time.time() + timeout
    while True:
        row = next(j for j in s._get(base)["jobs"] if j["job_id"] == job_id)
        if row["status"] in ("done", "failed"):
            return row
        if time.time() > deadline:
            raise TimeoutError(row)
        time.sleep(0.2)


@pytest.fixture
def env(tmp_path: Path, monkeypatch):  # type: ignore[no-untyped-def]
    monkeypatch.setenv("RTGAIA_DATA_DIR", str(tmp_path / "data"))
    monkeypatch.setenv("RTGAIA_DOSECALC_TEST_ENGINE", "1")


def test_submit_run_load_gamma_and_save(case, env) -> None:  # type: ignore[no-untyped-def]
    with Session(library_root=str(case.root.parent), user="dr") as s:
        s.load_case(_selection(case), webgl2=False, tier="C")
        engines = s._get("/api/v1/dosecalc/engines")
        assert any(e["name"] == "pipeline-test" and e["ready"] for e in engines["engines"])
        assert engines["beam_models"][0]["model_id"] == "demo-6x"
        base = f"/api/v1/studies/{s.study_id}/dosecalc"
        plan = case.expected["plan_sop_instance_uid"]
        job = s._post(base, {"plan_sop_uid": plan, "engine": "pipeline-test", "grid": "ct"})
        summ = job["summary"]
        assert summ["fractions"] == 2 and summ["total_mu"] == 750 and len(summ["beams"]) == 3
        assert summ["calibration_fallback"] is True and summ["beam_model"]["demo"] is True
        assert summ["dose_grid"] == "ct" and "通用曲線" in summ["calibration_reason"]
        assert summ["calc_spacing_mm"] == 4.0, "預設在 4 mm 網格上算、再內插回輸出網格"
        row = _wait(s, base, job["job_id"])
        assert row["status"] == "done", row
        assert row["dosecalc"]["engine"] == "pipeline-test" and row["dosecalc"]["beams"] == [1, 2, 3]
        with pytest.raises(RuntimeError, match="404"):
            s._post(f"{base}/nope/load", {})
        loaded = s._post(f"{base}/{job['job_id']}/load", {})["results"]
        assert len(loaded) == 4, "總劑量 ＋ 三個射束"
        total = loaded[0]
        assert total["dose_type"] == "PHYSICAL" and total["summation_type_for_save"] == "PLAN"
        assert any("示範射束模型" in w for w in total["warnings"]) and any(
            "流程測試引擎" in w for w in total["warnings"]
        )
        layers = {x["contentRef"]: x for x in s.state["layers"]}
        assert layers[total["series_id"]]["visible"] is True
        assert all(layers[r["series_id"]]["visible"] is False for r in loaded[1:]), "逐射束預設隱藏"
        assert next(j for j in s._get(base)["jobs"] if j["job_id"] == job["job_id"])["loaded"] == [
            r["series_id"] for r in loaded
        ]
        # 可以跟另一個劑量做 γ（這裡跟自己 × 1.01）
        ops = f"/api/v1/studies/{s.study_id}/dose-ops"
        up = s._post(ops, {"op": "mul", "a": total["series_id"], "k": 1.01})["series_id"]
        g = s._post(f"{ops}/gamma", {"reference": total["series_id"], "evaluated": up})
        assert g["gamma"]["pass_rate"] == 1.0
        # 存成 RTDOSE：PLAN、引用計畫、衍生說明寫引擎與模型
        saved = s._post(f"/api/v1/dose/{total['series_id']}/save", {"purpose": "download"})
        deadline = time.time() + 60
        while (j := s._get(f"/api/v1/jobs/{saved['job_id']}"))["status"] not in ("done", "failed"):
            assert time.time() < deadline
            time.sleep(0.1)
        assert j["status"] == "done", j
        ds = pydicom.dcmread(
            io.BytesIO(s._client.get(f"/api/v1/jobs/{saved['job_id']}/download", headers=s._headers).content)
        )
        assert ds.DoseSummationType == "PLAN" and ds.ReferencedRTPlanSequence[0].ReferencedSOPInstanceUID == plan
        assert (
            "RT-Gaia dose calculation: pipeline-test" in ds.DerivationDescription
            and "(demo)" in ds.DerivationDescription
        )
        # 別人看不到我的工作
        s._headers["X-RTGaia-User"] = "other"
        assert s._get(base)["jobs"][0]["job_id"] == job["job_id"]  # 清單是病例的（看得到有人在算）
        with pytest.raises(RuntimeError, match="404"):
            s._post(f"{base}/{job['job_id']}/load", {})
        s._headers["X-RTGaia-User"] = "dr"


def test_refusals_and_cancel(case, env, tmp_path: Path) -> None:  # type: ignore[no-untyped-def]
    with Session(library_root=str(case.root.parent), user="dr") as s:
        s.load_case(_selection(case), webgl2=False, tier="C")
        base = f"/api/v1/studies/{s.study_id}/dosecalc"
        plan = case.expected["plan_sop_instance_uid"]
        for body, code in (
            ({"plan_sop_uid": "1.2.3", "engine": "pipeline-test"}, "422"),
            ({"plan_sop_uid": plan, "engine": "nope"}, "422"),
            ({"plan_sop_uid": plan, "engine": "pipeline-test", "histories": 5}, "422"),
            ({"plan_sop_uid": plan, "engine": "pipeline-test", "grid": "x"}, "422"),
            ({"plan_sop_uid": plan, "engine": "pipeline-test", "calc_spacing_mm": 20}, "422"),
            ({"plan_sop_uid": plan, "engine": "pipeline-test", "calc_spacing_mm": "4"}, "422"),
            ({}, "422"),
        ):
            with pytest.raises(RuntimeError, match=code):
                s._post(base, body)
        # 取消：排隊中或計算中的都可以；取消後是 failed（cancelled），不能載回
        job = s._post(base, {"plan_sop_uid": plan, "engine": "pipeline-test", "grid": "ct"})
        r = s._client.delete(f"{base}/{job['job_id']}", headers=s._headers)
        assert r.status_code == 204
        row = _wait(s, base, job["job_id"])
        assert row["status"] == "failed" and row["error"] == "cancelled"
        with pytest.raises(RuntimeError, match="409"):
            s._post(f"{base}/{job['job_id']}/load", {})


def test_unsupported_plan_lists_reasons(case, env, tmp_path: Path) -> None:  # type: ignore[no-untyped-def]
    import shutil

    root = tmp_path / "lib"
    shutil.copytree(case.root, root / "plan6x")
    rp = next((root / "plan6x" / "RP").glob("*.dcm"))
    ds = pydicom.dcmread(rp)
    ds.BeamSequence[0].NumberOfWedges = 1
    ds.BeamSequence[2].RadiationType = "ELECTRON"
    ds.save_as(rp)
    with Session(library_root=str(root), user="dr") as s:
        s.load_case(_selection(case), webgl2=False, tier="C")
        with pytest.raises(RuntimeError, match="422") as exc:
            s._post(
                f"/api/v1/studies/{s.study_id}/dosecalc",
                {"plan_sop_uid": case.expected["plan_sop_instance_uid"], "engine": "pipeline-test"},
            )
        text = str(exc.value)
        assert "楔形板" in text and "只支援光子" in text and "PLAN_NOT_SUPPORTED" in text
