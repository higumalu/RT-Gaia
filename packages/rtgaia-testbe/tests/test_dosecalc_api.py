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
        "dose_uids": [e["tps_dose_series_instance_uid"]],
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
        assert summ["calc_spacing_mm"] is None, "流程測試引擎不是 Monte Carlo：沒有計分網格"
        assert summ["tps_dose_series_id"], "病例裡有參照這份計畫的 TPS 劑量"
        row = _wait(s, base, job["job_id"])
        assert row["status"] == "done", row
        assert row["dosecalc"]["engine"] == "pipeline-test" and row["dosecalc"]["beams"] == [1, 2, 3]
        assert row["dosecalc"]["uncertainty"]["median_rel_50"] == pytest.approx(0.01), "測試引擎的假不確定度 1%"
        with pytest.raises(RuntimeError, match="404"):
            s._post(f"{base}/nope/load", {})
        loaded = s._post(f"{base}/{job['job_id']}/load", {})["results"]
        assert len(loaded) == 5, "總劑量 ＋ 三個射束 ＋ 不確定度圖"
        total, sigma = loaded[0], loaded[-1]
        assert sigma["quantity"] == "uncertainty" and sigma["text"].endswith("1σ")
        layers0 = {x["contentRef"]: x for x in s.state["layers"]}
        assert layers0[sigma["series_id"]]["kind"] == "uncertainty" and layers0[sigma["series_id"]]["visible"] is False
        assert layers0[sigma["series_id"]]["params"]["max_percent"] == 10.0
        sources = s._get(f"/api/v1/studies/{s.study_id}/dose-ops/sources")["sources"]
        assert sigma["series_id"] not in [x["series_id"] for x in sources], "不確定度圖不是劑量：不能當運算元"
        with pytest.raises(RuntimeError, match="NOT_DOSE"):
            s._post(f"/api/v1/dose/{sigma['series_id']}/save", {"purpose": "download"})
        all_loaded, loaded = loaded, loaded[:-1]
        assert total["dose_type"] == "PHYSICAL" and total["summation_type_for_save"] == "PLAN"
        assert any("示範射束模型" in w for w in total["warnings"]) and any(
            "流程測試引擎" in w for w in total["warnings"]
        )
        layers = {x["contentRef"]: x for x in s.state["layers"]}
        assert layers[total["series_id"]]["visible"] is True
        assert all(layers[r["series_id"]]["visible"] is False for r in loaded[1:]), "逐射束預設隱藏"
        assert next(j for j in s._get(base)["jobs"] if j["job_id"] == job["job_id"])["loaded"] == [
            r["series_id"] for r in all_loaded
        ]
        # 可以跟另一個劑量做 γ（這裡跟自己 × 1.01）
        ops = f"/api/v1/studies/{s.study_id}/dose-ops"
        up = s._post(ops, {"op": "mul", "a": total["series_id"], "k": 1.01})["series_id"]
        g = s._post(f"{ops}/gamma", {"reference": total["series_id"], "evaluated": up})
        assert g["gamma"]["pass_rate"] == 1.0
        assert not any("雜訊" in n for n in g["gamma"]["notes"]), "1% 的雜訊對 3% 的判準不用提"
        g2 = s._post(f"{ops}/gamma", {"reference": up, "evaluated": total["series_id"], "dose_pct": 2, "dta_mm": 2})
        assert any(n.startswith("被評估劑量是 Monte Carlo 重算") and "1.0%" in n for n in g2["gamma"]["notes"])
        # 「跟 TPS 比對」：參考 ＝ TPS 劑量、被評估 ＝ 重算的總劑量（計畫面板的按鈕送的就是這個）
        g3 = s._post(
            f"{ops}/gamma",
            {"reference": summ["tps_dose_series_id"], "evaluated": total["series_id"], "dose_pct": 3, "dta_mm": 2},
        )
        assert g3["gamma"]["reference_series_id"] == summ["tps_dose_series_id"] and g3["gamma"]["evaluated"] > 0
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
            ({"plan_sop_uid": plan, "engine": "pipeline-test", "model_sensitivity": "yes"}, "422"),
            ({"plan_sop_uid": plan, "engine": "pipeline-test", "model_sensitivity": True}, "SENSITIVITY_GPU_ONLY"),
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


def test_uncertainty_map_and_summary() -> None:
    """不確定度圖是 %；低於參考最大值（第 99.5 百分位）10% 的點不畫；摘要的參考也不被單一熱點撐大。"""
    import numpy as np
    from rtgaia_core import dosecalc_jobs

    dose = np.full((4, 10, 10), 10.0, dtype=np.float32)
    dose[0] = 0.5  # 低劑量：不畫
    dose[1, 0, 0] = 500.0  # 雜訊撐出來的熱點
    unc = np.full(dose.shape, 0.02, dtype=np.float32)
    unc[3, 5, 5] = np.nan
    m = dosecalc_jobs.uncertainty_map(dose, unc)
    assert m is not None and np.isnan(m[0]).all() and np.isnan(m[3, 5, 5])
    assert float(np.nanmedian(m)) == pytest.approx(2.0)
    s = dosecalc_jobs.uncertainty_summary(dose, unc)
    assert s["median_rel_50"] == pytest.approx(0.02), "參考最大值是第 99.5 百分位，不是熱點的 500"
    assert dosecalc_jobs.uncertainty_map(dose, np.zeros_like(unc)) is None, "沒有不確定度（測試引擎以前）→ 不產生圖"


def test_beam_models_list_parameters_and_calibration(case, env) -> None:  # type: ignore[no-untyped-def]
    """管理頁「射束模型」：每個內建模型的能譜、準直器（種類）、MU 校正條件；做過 MU 校正就附每 MU 歷史數與 PDD。"""
    import json

    from rtgaia_core import dosecalc_jobs
    from rtgaia_dosecalc import beam_models
    from rtgaia_dosecalc.engines import topas

    with Session(library_root=str(case.root.parent), user="dr") as s:
        rows = {m["model_id"]: m for m in s._get("/api/v1/dosecalc/beam-models")["models"]}
        assert set(rows) == {"demo-6x", "demo-6xfff", "demo-6x-hd120", "demo-6xfff-hd120", "demo-6xfff-dual"}
        assert rows["demo-6x-hd120"]["mlc_family"] == "hd120" and rows["demo-6x"]["mlc_family"] == "millennium120"
        six, dual = rows["demo-6x"], rows["demo-6xfff-dual"]
        assert 1.8 < six["spectrum"]["mean_mev"] < 2.0 and rows["demo-6xfff"]["spectrum"]["mean_mev"] < 1.7
        assert {c["device"]: c["kind"] for c in six["collimators"]} == {"jaw_y": "jaw", "jaw_x": "jaw", "MLCX": "mlc"}
        assert {c["kind"] for c in dual["collimators"]} == {"fixed", "mlc"} and dual["mlc_devices"] == [
            "MLCX1",
            "MLCX2",
        ]
        assert six["calibration"]["gy_per_mu"] == 0.01 and six["calibrated"] is None, "還沒校正過"
        assert any("不代表任何一台實機" in x for x in six["limitations"]) and "Mohan" in six["reference"]
        # 做過校正（快取檔）→ 附上，PDD 正規化到最大值 1
        model = beam_models.demo_6x()
        cache = dosecalc_jobs.work_root() / "calibration"
        cache.mkdir(parents=True, exist_ok=True)
        doc = {"engine_version": topas.ENGINE_VERSION, "histories": 10, "dmax_mm": 3.0, "histories_per_mu": 7.0}
        (cache / f"{topas.calibration_key(model)}.json").write_text(
            json.dumps({**doc, "depth_dose_gy": [1.0, 2.0, 1.5], "depth_step_mm": 2.0})
        )
        six = next(m for m in s._get("/api/v1/dosecalc/beam-models")["models"] if m["model_id"] == "demo-6x")
        assert six["calibrated"]["histories_per_mu"] == 7.0
        assert six["calibrated"]["pdd"] == [[1.0, 0.5], [3.0, 1.0], [5.0, 0.75]]
        s._headers["Accept-Language"] = "en"
        en = next(m for m in s._get("/api/v1/dosecalc/beam-models")["models"] if m["model_id"] == "demo-6x")
        assert any("represent no real machine" in x for x in en["limitations"])
