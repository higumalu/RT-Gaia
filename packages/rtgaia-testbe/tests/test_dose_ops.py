"""劑量運算：A ± B（兩個劑量之間，B 經剛性 REG 重取樣到 A 的網格）、A × k、A ÷ k；
暫存結果只有自己看得到；存成 RTDOSE（編碼、衍生欄位、負值只能 ERROR、PHYSICAL 要二次確認）；
存入資料庫後掛在影像底下、標衍生；送到節點要確認。"""

from __future__ import annotations

import io
import time
from pathlib import Path

import numpy as np
import pydicom
import pytest
from rtgaia_core import dose_ops
from rtgaia_core.loaders.rtdose import read_dose_header, read_dose_pixels
from rtgaia_core.rtdose_export import build_rtdose, encode_dose
from rtgaia_geom import Grid
from rtgaia_testbe import Session
from synth_dicom import SynthCase, write_synth_case

# ── 純函式 ────────────────────────────────────────────────────────────────────


def _grid(size=(4, 3, 2), spacing=(2.0, 3.0, 4.0), origin=(-10.0, 5.0, 20.0), for_uid="1.2.3") -> Grid:
    return Grid(
        size=size, spacing=spacing, origin=origin, direction=(1, 0, 0, 0, 1, 0, 0, 0, 1), frame_of_reference_uid=for_uid
    )


def test_resample_identity_and_shift_with_nan_outside() -> None:
    g = _grid()
    vol = np.arange(2 * 3 * 4, dtype=np.float32).reshape(2, 3, 4)
    same = dose_ops.resample_onto(vol, g, np.eye(4), g, np.eye(4))
    assert np.allclose(same, vol)
    # B 平移半個體素（x 方向 +1 mm）→ A 的體素中心落在 B 的兩個體素中間；最後一行在 B 外面 → NaN
    shift = np.eye(4)
    shift[0, 3] = 1.0  # B → primary：+1 mm
    out = dose_ops.resample_onto(vol, g, shift, g, np.eye(4))
    assert np.isnan(out[:, :, 0]).all(), "A 的第一行在 B 的網格外（−0.5 個體素）"
    assert np.allclose(out[:, :, 1], (vol[:, :, 0] + vol[:, :, 1]) / 2)


def test_chain_text_types_and_summation_rules() -> None:
    a = {"series_id": "a", "label": "fx_1", "dose_type": "PHYSICAL", "summation_type": "PLAN", "plan_sop_uids": ["p1"]}
    b = {"series_id": "b", "label": "fx_2", "dose_type": "PHYSICAL", "summation_type": "PLAN", "plan_sop_uids": ["p2"]}
    s = {"op": "add", "a": a, "b": b, "k": None, "result_dose_type": "PHYSICAL"}
    w = {"op": "mul", "a": s, "b": None, "k": 5.0, "result_dose_type": "PHYSICAL"}
    assert dose_ops.chain_text(w) == "(fx_1 + fx_2) × 5"
    assert dose_ops.summation_type_for_save(w) == "MULTI_PLAN"
    assert dose_ops.summation_type_for_save({**a, "plan_sop_uids": []}) is None
    assert dose_ops.summation_type_for_save({"op": "mul", "a": a, "b": None, "k": 2.0}) == "PLAN"
    assert dose_ops.result_dose_type("sub", a, b) == ("ERROR", None)
    assert dose_ops.result_dose_type("add", a, {**b, "dose_type": "EFFECTIVE"})[0] is None
    assert dose_ops.result_dose_type("add", a, {**b, "dose_type": "ERROR"}) == ("ERROR", None)
    assert dose_ops.check_k("div", 0)[1] and dose_ops.check_k("mul", -2)[1] and dose_ops.check_k("mul", "x")[1]
    assert dose_ops.check_k("div", 2.5) == (2.5, None)


def test_encode_dose_signed_only_for_error_and_roundtrip(tmp_path: Path) -> None:
    with pytest.raises(ValueError, match="ERROR"):
        encode_dose(np.array([[[-1.0, 2.0]]]), signed=False)
    g = _grid(size=(3, 2, 2))
    values = np.array(
        [[[0.0, 1.5, -2.25], [np.nan, 0.5, 3.0]], [[1.0, 1.0, 1.0], [0.0, -0.125, 2.0]]], dtype=np.float32
    )
    ds = build_rtdose(
        values_kji=values,
        grid=g,
        study_uid="1.2.3.4",
        dose_type="ERROR",
        summation_type="MULTI_PLAN",
        plan_sop_uids=["1.1", "1.2"],
        source_dose_sop_uids=["2.1", "2.2"],
        registration_sop_uids=["3.1"],
        weighted=False,
        composed=True,
        derivation_description="RT-Gaia dose operation: a - b",
        dose_comment="RT-Gaia: a - b",
        series_description="test",
    )
    path = tmp_path / "d.dcm"
    ds.save_as(str(path), enforce_file_format=True)
    back = pydicom.dcmread(str(path))
    assert back.PixelRepresentation == 1 and back.BitsAllocated == 32 and back.DoseType == "ERROR"
    assert back.DerivationCodeSequence[0].CodeValue == "121370"
    assert back.ReferencedInstanceSequence[0].PurposeOfReferenceCodeSequence[0].CodeValue == "121372"
    assert back.SpatialTransformOfDose == "RIGID" and len(back.ReferencedRTPlanSequence) == 2
    header = read_dose_header(path)
    assert header.derived is True and header.grid.size == g.size
    assert np.allclose(header.grid.origin, g.origin) and np.allclose(header.grid.spacing, g.spacing)
    px = read_dose_pixels(header)
    assert np.allclose(px, np.nan_to_num(values, nan=0.0), atol=1e-6), "NaN（沒資料）寫 0；其餘值來回一致"


# ── HTTP ──────────────────────────────────────────────────────────────────────


@pytest.fixture(scope="module")
def synth(tmp_path_factory) -> SynthCase:
    return write_synth_case(tmp_path_factory.mktemp("synth-doseops"))


def _selection(synth: SynthCase) -> dict:
    return {
        "image_series_uids": [synth.plan_ct.series_uid, synth.cbct.series_uid],
        "structure_set_uids": [synth.plan_rs_uid, synth.cbct_rs_uid],
        "dose_uids": [synth.plan_dose_uid, synth.cbct_dose_uid],
        "registration_uids": [synth.reg_uid],
    }


def _wait(s: Session, job_id: str, timeout: float = 60.0) -> dict:
    deadline = time.time() + timeout
    while True:
        j = s._get(f"/api/v1/jobs/{job_id}")
        if j["status"] in ("done", "failed"):
            return j
        if time.time() > deadline:
            raise TimeoutError(j)
        time.sleep(0.05)


def _op(s: Session, **body) -> dict:  # type: ignore[no-untyped-def]
    return s._post(f"/api/v1/studies/{s.study_id}/dose-ops", body)


def test_sources_list_eligibility_and_fractions(synth: SynthCase, tmp_path: Path, monkeypatch) -> None:  # type: ignore[no-untyped-def]
    monkeypatch.setenv("RTGAIA_DATA_DIR", str(tmp_path / "data"))
    with Session(library_root=str(synth.root), user="dr") as s:
        s.load_case(_selection(synth), webgl2=False, tier="C")
        src = {x["series_id"]: x for x in s._get(f"/api/v1/studies/{s.study_id}/dose-ops/sources")["sources"]}
        plan, cbct = src[synth.plan_dose_uid], src[synth.cbct_dose_uid]
        assert plan["eligible"] and cbct["eligible"]
        assert plan["registration"]["kind"] == "primary" and cbct["registration"]["kind"] == "rigid"
        assert plan["fractions_planned"] is not None
        assert any("沒有參照計畫" in n for n in cbct["notes"])


def test_add_sub_mul_div_chain_visibility_and_discard(synth: SynthCase, tmp_path: Path, monkeypatch) -> None:  # type: ignore[no-untyped-def]
    monkeypatch.setenv("RTGAIA_DATA_DIR", str(tmp_path / "data"))
    with Session(library_root=str(synth.root), user="dr") as s:
        s.load_case(_selection(synth), webgl2=False, tier="C")
        # A × 2：值剛好兩倍、網格是 A 的
        doubled = _op(s, op="mul", a=synth.plan_dose_uid, k=2)
        assert abs(doubled["summary"]["max_gy"] - 2 * synth.plan_dose_max_gy) < 1e-3
        assert doubled["text"].endswith("× 2") and doubled["dose_type"] == "PHYSICAL"
        assert doubled["summation_type_for_save"] == "PLAN"
        layer = next(x for x in s.state["layers"] if x["layerId"] == doubled["layer_id"])
        assert layer["kind"] == "dose" and layer["params"]["derived"]["text"] == doubled["text"]
        # ÷ 2 回到原值（串接：結果當運算元）
        back = _op(s, op="div", a=doubled["series_id"], k=2)
        assert abs(back["summary"]["max_gy"] - synth.plan_dose_max_gy) < 1e-3
        assert back["text"].startswith("(") and back["sources"][0]["series_id"] == synth.plan_dose_uid
        # 2026-10-02：不同空間不能直接運算 → 先對 CBCT 劑量套用 REG 搬到計畫 CT 的空間，再加
        with pytest.raises(RuntimeError, match="422"):
            _op(s, op="add", a=synth.plan_dose_uid, b=synth.cbct_dose_uid)
        base = f"/api/v1/studies/{s.study_id}/dose-ops"
        opts = s._get(f"{base}/transforms", series_id=synth.cbct_dose_uid)["transforms"]
        reg = next(o for o in opts if o["kind"] == "REG")
        moved = s._post(f"{base}/transform", {"series_id": synth.cbct_dose_uid, "transform_id": reg["transform_id"]})
        total = _op(s, op="add", a=synth.plan_dose_uid, b=moved["series_id"])
        assert 0 < total["summary"]["covered_fraction"] < 1
        assert any("Dmax 差" in w for w in total["warnings"]), "52.5 Gy 與 2.1 Gy：提示混了療程與單次"
        assert any("只蓋到" in w for w in total["warnings"])
        assert total["registration_sop_uids"] == [synth.reg_sop_uid]
        # 和的 DVH 能算（NaN 當作網格外 → partial）
        ptv = next(x for x in s.state["layers"] if x["kind"] == "mask" and x["label"] == "PTV")["contentRef"]
        dvh = s.dvh(total["series_id"], [ptv])
        assert dvh["structures"][0]["dmax_gy"] is not None
        # A − A×2 ＝ −A：差值 → DVH 拒絕、signed-stats 給最大負差
        diff = _op(s, op="sub", a=synth.plan_dose_uid, b=doubled["series_id"])
        assert diff["signed"] is True and diff["dose_type"] == "ERROR" and diff["physical_allowed"] is False
        assert abs(diff["summary"]["min_gy"] + synth.plan_dose_max_gy) < 1e-3
        with pytest.raises(RuntimeError, match="422"):
            s.dvh(diff["series_id"], [ptv])
        st = s._get(f"/api/v1/dose/{diff['series_id']}/signed-stats", structure_ids=ptv)
        assert st["whole"]["max_pos_gy"] == 0.0 and st["whole"]["max_neg_gy"] < 0
        assert st["structures"][0]["max_neg_gy"] < 0
        # 錯誤：同一個劑量、k 不合法、op 不合法、看不到的劑量
        for bad in (
            {"op": "add", "a": synth.plan_dose_uid, "b": synth.plan_dose_uid},
            {"op": "div", "a": synth.plan_dose_uid, "k": 0},
            {"op": "mul", "a": synth.plan_dose_uid, "k": -1},
            {"op": "pow", "a": synth.plan_dose_uid},
        ):
            with pytest.raises(RuntimeError, match="422"):
                _op(s, **bad)
        with pytest.raises(RuntimeError, match="404"):
            _op(s, op="mul", a="nope", k=2)
        mine = s._get(f"/api/v1/studies/{s.study_id}/dose-ops")["results"]
        assert {r["series_id"] for r in mine} == {
            doubled["series_id"],
            back["series_id"],
            total["series_id"],
            diff["series_id"],
            moved["series_id"],
        }
        # 別人看不到我的暫存結果（清單、圖層、DVH、影像都 404／不出現）
        s._headers["X-RTGaia-User"] = "other"
        assert s._get(f"/api/v1/studies/{s.study_id}/dose-ops")["results"] == []
        with pytest.raises(RuntimeError, match="404"):
            s._get(f"/api/v1/dose/{doubled['series_id']}/max")
        with pytest.raises(RuntimeError, match="404"):
            _op(s, op="mul", a=doubled["series_id"], k=2)
        s._headers["X-RTGaia-User"] = "dr"
        # 丟棄：用過它的結果不受影響
        out = s._client.delete(
            f"/api/v1/studies/{s.study_id}/dose-ops/{doubled['series_id']}", headers=s._headers
        ).json()
        assert out["discarded"] == [doubled["series_id"]] and back["series_id"] in out["used_by"]
        assert doubled["layer_id"] not in {x["layerId"] for x in s.state["layers"]}
        assert abs(s._get(f"/api/v1/dose/{back['series_id']}/max")["max_gy"] - synth.plan_dose_max_gy) < 1e-3


def test_save_rtdose_download_library_types_and_send_confirm(synth: SynthCase, tmp_path: Path, monkeypatch) -> None:  # type: ignore[no-untyped-def]
    monkeypatch.setenv("RTGAIA_DATA_DIR", str(tmp_path / "data"))
    with Session(library_root=str(synth.root), user="wang") as s:
        s.load_case(_selection(synth), webgl2=False, tier="C")
        tags = {t["keyword"] for t in s._get("/api/v1/export/tags", format="rtdose")["tags"]}
        assert "SeriesDescription" in tags and "StructureSetLabel" not in tags
        # 只有暫存結果能存
        with pytest.raises(RuntimeError, match="422"):
            s._post(f"/api/v1/dose/{synth.plan_dose_uid}/save", {})
        # 沒有計畫參照（CBCT 劑量 × 2）→ DoseSummationType 決定不了 → 不能存
        orphan = _op(s, op="mul", a=synth.cbct_dose_uid, k=2)
        assert orphan["save_problem"]
        with pytest.raises(RuntimeError, match="422"):
            s._post(f"/api/v1/dose/{orphan['series_id']}/save", {})
        # 計畫劑量 × 0.5 → 下載（預設匿名）
        half = _op(s, op="mul", a=synth.plan_dose_uid, k=0.5)
        job = s._post(f"/api/v1/dose/{half['series_id']}/save", {"tags": {"SeriesDescription": "half dose"}})
        done = _wait(s, job["job_id"])
        assert done["status"] == "done", done
        raw = s._client.get(done["download_url"], headers=s._headers).content
        ds = pydicom.dcmread(io.BytesIO(raw))
        assert ds.Modality == "RTDOSE" and ds.DoseType == "PHYSICAL" and ds.DoseSummationType == "PLAN"
        assert ds.PixelRepresentation == 0 and ds.SeriesDescription == "half dose"
        assert ds.DerivationCodeSequence[0].CodeValue == "121378", "乘除 ＝ 權重"
        assert ds.ReferencedRTPlanSequence[0].ReferencedSOPInstanceUID == synth.plan_sop_uid
        assert str(ds.PatientName) == "PHANTOM^RTGAIA" and done["anonymized"] is True
        assert ds.FrameOfReferenceUID == synth.plan_ct.frame_of_reference_uid
        px = ds.pixel_array.astype(np.float64) * float(ds.DoseGridScaling)
        assert abs(px.max() - synth.plan_dose_max_gy / 2) < 1e-4
        # DoseType 不能改（不是減法）
        with pytest.raises(RuntimeError, match="422"):
            s._post(f"/api/v1/dose/{half['series_id']}/save", {"dose_type": "ERROR"})
        # 剩餘劑量 ＝ 計畫 − 計畫×0.5（全部 ≥ 0）：預設 ERROR；改 PHYSICAL 要確認（409），確認後可
        rem = _op(s, op="sub", a=synth.plan_dose_uid, b=half["series_id"])
        assert rem["dose_type"] == "ERROR" and rem["physical_allowed"] is True and rem["signed"] is False
        with pytest.raises(RuntimeError, match="409"):
            s._post(f"/api/v1/dose/{rem['series_id']}/save", {"dose_type": "PHYSICAL"})
        job2 = s._post(
            f"/api/v1/dose/{rem['series_id']}/save",
            {"dose_type": "PHYSICAL", "confirm_physical": True, "purpose": "library"},
        )
        done2 = _wait(s, job2["job_id"])
        assert done2["status"] == "done" and done2["saved_to_library"] is True, done2
        assert done2["anonymized"] is False and done2["dose_type"] == "PHYSICAL"
        # 資料頁：掛在計畫 CT 底下（不在計畫底下）、標衍生、運算鏈看得到
        rows = s.catalog_rt(synth.plan_ct.series_uid)
        saved = next(r for r in rows if r["series_instance_uid"] == done2["series_instance_uid"])
        assert saved["kind"] == "dose" and saved["derived"] is True and saved["plan_missing"] is False
        assert "RT-Gaia dose operation" in saved["refs"]["derivation_description"]
        # 送到節點：衍生劑量要確認（409）；匯出紀錄是 rtdose
        recs = s._get("/api/v1/export-records", case_id=s.case_id)["items"]
        assert {r["kind"] for r in recs if r["export_id"] in (job["job_id"], job2["job_id"])} == {"rtdose"}
        node = s._post(
            "/api/v1/dimse/nodes",
            {"name": "tps", "ae_title": "TPS", "host": "127.0.0.1", "port": 1, "role_send": True},
        )
        with pytest.raises(RuntimeError, match="409"):
            s._post(f"/api/v1/dimse/nodes/{node['node_id']}/send", {"export_job_id": job["job_id"]})
        with pytest.raises(RuntimeError, match="409"):
            s._post(f"/api/v1/dimse/nodes/{node['node_id']}/send", {"series_uids": [done2["series_instance_uid"]]})
        with pytest.raises(RuntimeError, match="409"):
            s._post(f"/api/v1/export-records/{job['job_id']}/resend", {"node_id": node["node_id"]})
        sent = s._post(
            f"/api/v1/dimse/nodes/{node['node_id']}/send", {"export_job_id": job["job_id"], "confirm_derived": True}
        )
        assert sent["job_id"]
        ev = [e for e in s._app.state.rtgaia.audit_tail if e["action"].endswith("/send")][-1]
        assert ev["detail"]["confirmed"] is True


def test_apply_registration_moves_dose_into_another_space(synth: SynthCase, tmp_path: Path, monkeypatch) -> None:  # type: ignore[no-untyped-def]
    """先選劑量、再選要套用哪個 REG → 新的劑量物件；同一個空間的劑量才能運算。"""
    monkeypatch.setenv("RTGAIA_DATA_DIR", str(tmp_path / "data"))
    with Session(library_root=str(synth.root), user="dr") as s:
        s.load_case(_selection(synth), webgl2=False, tier="C")
        base = f"/api/v1/studies/{s.study_id}/dose-ops"
        out = s._get(f"{base}/transforms", series_id=synth.cbct_dose_uid)
        assert out["space_label"].startswith("CBCT") or out["space_label"]
        kinds = {o["kind"] for o in out["transforms"]}
        assert kinds == {"REG", "current"}, "REG 物件 ＋ 目前的對位"
        reg = next(o for o in out["transforms"] if o["kind"] == "REG")
        assert reg["target_frame_of_reference_uid"] == synth.plan_ct.frame_of_reference_uid and reg["problem"] is None
        assert reg["sop_instance_uid"] == synth.reg_sop_uid and "matrix_row_major" not in reg
        moved = s._post(f"{base}/transform", {"series_id": synth.cbct_dose_uid, "transform_id": reg["transform_id"]})
        assert moved["frame_of_reference_uid"] == synth.plan_ct.frame_of_reference_uid
        assert "→" in moved["text"] and moved["registration_sop_uids"] == [synth.reg_sop_uid]
        # 剛性重取樣：最大劑量不變（網格包住整個原劑量、間距相同；三線性只會稍低）
        assert abs(moved["summary"]["max_gy"] - synth.cbct_dose_max_gy) < 0.05 * synth.cbct_dose_max_gy
        # 搬過去的劑量放在 primary 空間：Dmax 點的 primary 座標 ≈ 原劑量的
        a = s._get(f"/api/v1/dose/{synth.cbct_dose_uid}/max")["world_primary_mm"]
        b = s._get(f"/api/v1/dose/{moved['series_id']}/max")["world_primary_mm"]
        assert np.linalg.norm(np.subtract(a, b)) < 6.0
        # 「目前的對位」（FrameGroup）跟 REG 是同一個矩陣 → 同樣的結果
        cur = next(o for o in out["transforms"] if o["kind"] == "current")
        moved2 = s._post(f"{base}/transform", {"series_id": synth.cbct_dose_uid, "transform_id": cur["transform_id"]})
        assert abs(moved2["summary"]["max_gy"] - moved["summary"]["max_gy"]) < 1e-4
        # 計畫 CT 空間裡的計畫劑量已經在主要空間 → 只有 REG 的反向（到 CBCT）可選，沒有「目前的對位」
        plan_opts = s._get(f"{base}/transforms", series_id=synth.plan_dose_uid)["transforms"]
        assert all(o["kind"] == "REG" and o["inverse"] for o in plan_opts)
        # 搬過去之後就能跟計畫劑量運算
        diff = _op(s, op="sub", a=moved["series_id"], b=synth.plan_dose_uid)
        assert diff["dose_type"] == "ERROR"
        with pytest.raises(RuntimeError, match="404"):
            s._post(f"{base}/transform", {"series_id": synth.cbct_dose_uid, "transform_id": "nope"})
