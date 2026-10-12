"""γ 比較的 API：結果是自己的圖層種類（`gamma`），不是劑量 —— 不能運算、不畫 DVH、不存成 RTDOSE、不能套用 REG；
同一個空間才能比；別人看不到；每個結構的通過率。"""

from __future__ import annotations

from pathlib import Path

import pytest
from rtgaia_testbe import Session
from synth_dicom import SynthCase, write_synth_case


@pytest.fixture(scope="module")
def synth(tmp_path_factory) -> SynthCase:  # type: ignore[no-untyped-def]
    return write_synth_case(tmp_path_factory.mktemp("synth-gamma"))


def _selection(synth: SynthCase) -> dict:
    return {
        "image_series_uids": [synth.plan_ct.series_uid, synth.cbct.series_uid],
        "structure_set_uids": [synth.plan_rs_uid, synth.cbct_rs_uid],
        "dose_uids": [synth.plan_dose_uid, synth.cbct_dose_uid],
        "registration_uids": [synth.reg_uid],
    }


def test_gamma_result_is_not_a_dose(synth: SynthCase, tmp_path: Path, monkeypatch) -> None:  # type: ignore[no-untyped-def]
    monkeypatch.setenv("RTGAIA_DATA_DIR", str(tmp_path / "data"))
    with Session(library_root=str(synth.root), user="dr") as s:
        s.load_case(_selection(synth), webgl2=False, tier="C")
        base = f"/api/v1/studies/{s.study_id}/dose-ops"
        plan = synth.plan_dose_uid
        up2 = s._post(base, {"op": "mul", "a": plan, "k": 1.02})["series_id"]
        up5 = s._post(base, {"op": "mul", "a": plan, "k": 1.3})["series_id"]

        # 整片高 2%（全域 3%）→ 全部通過；高 30% → 失敗（合成劑量是很陡的小高斯：偏高不多時移動一點就找得到相同的劑量；
        # 平坦區的分類由 test_gamma 的解析案例核對）
        ok = s._post(f"{base}/gamma", {"reference": plan, "evaluated": up2})
        g = ok["gamma"]
        assert ok["quantity"] == "gamma" and g["pass_rate"] == 1.0 and g["evaluated"] > 0
        assert g["criteria"]["dose_pct"] == 3 and g["criteria"]["dta_mm"] == 2
        assert ok["text"].startswith("γ ")
        bad = s._post(f"{base}/gamma", {"reference": plan, "evaluated": up5, "threshold_pct": 50})["gamma"]
        assert bad["pass_rate"] < 1.0
        f = bad["failures"]
        assert f["count"] > 0 and f["count"] == f["high_gradient"] + f["flat"] and f["flat_cold"] == 0

        layer = next(x for x in s.state["layers"] if x["layerId"] == ok["layer_id"])
        assert layer["kind"] == "gamma" and layer["modality"] == "GAMMA"
        assert layer["params"]["quantity"] == "gamma" and layer["params"]["max_gamma"] == 2.0

        # 不是劑量：運算、DVH、存檔、套用 REG 都擋；運算來源清單裡也沒有它
        sources = s._get(f"{base}/sources")["sources"]
        assert ok["series_id"] not in {x["series_id"] for x in sources}
        with pytest.raises(RuntimeError, match="422"):
            s._post(base, {"op": "mul", "a": ok["series_id"], "k": 2})
        with pytest.raises(RuntimeError, match="422"):
            s._post(f"{base}/gamma", {"reference": ok["series_id"], "evaluated": plan})
        ptv = next(x for x in s.state["layers"] if x["kind"] == "mask" and x["label"] == "PTV")["contentRef"]
        with pytest.raises(RuntimeError, match="422"):
            s.dvh(ok["series_id"], [ptv])
        with pytest.raises(RuntimeError, match="422"):
            s._post(f"/api/v1/dose/{ok['series_id']}/save", {"purpose": "download"})
        with pytest.raises(RuntimeError, match="422"):
            s._post(f"{base}/transform", {"series_id": ok["series_id"], "transform_id": "x"})

        # 每個結構的通過率
        regions = s._get(f"/api/v1/dose/{ok['series_id']}/gamma-regions", structure_ids=ptv)["regions"]
        assert regions[0]["structure_id"] == ptv and regions[0]["pass_rate"] == 1.0
        with pytest.raises(RuntimeError, match="422"):
            s._get(f"/api/v1/dose/{plan}/gamma-regions", structure_ids=ptv)

        # 同一個空間才能比；差值不能比；同一個劑量；條件不合理
        with pytest.raises(RuntimeError, match="422"):
            s._post(f"{base}/gamma", {"reference": plan, "evaluated": synth.cbct_dose_uid})
        diff = s._post(base, {"op": "sub", "a": plan, "b": up2})["series_id"]
        for body in (
            {"reference": plan, "evaluated": diff},
            {"reference": plan, "evaluated": plan},
            {"reference": plan, "evaluated": up2, "dose_pct": 0},
            {"reference": plan, "evaluated": up2, "resolution": 7},
        ):
            with pytest.raises(RuntimeError, match="422"):
                s._post(f"{base}/gamma", body)
        with pytest.raises(RuntimeError, match="404"):
            s._post(f"{base}/gamma", {"reference": plan, "evaluated": "nope"})

        # 別人看不到我的 γ 圖
        s._headers["X-RTGaia-User"] = "other"
        assert s._get(f"{base}")["results"] == []
        with pytest.raises(RuntimeError, match="404"):
            s._get(f"/api/v1/dose/{ok['series_id']}/gamma-regions", structure_ids=ptv)
        s._headers["X-RTGaia-User"] = "dr"
        mine = {r["series_id"]: r for r in s._get(base)["results"]}
        assert mine[ok["series_id"]]["quantity"] == "gamma" and mine[up2]["quantity"] == "dose"
