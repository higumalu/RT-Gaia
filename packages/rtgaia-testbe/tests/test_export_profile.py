"""UID root 由環境變數定義（預設 pydicom）；匯出 profile 依 Varian（Eclipse）。"""

from __future__ import annotations

import io
import os
import time
from pathlib import Path

import pydicom
import pytest
from pydicom.uid import PYDICOM_IMPLEMENTATION_UID, PYDICOM_ROOT_UID
from rtgaia_core import dicom_uid
from rtgaia_core.export_profile import apply_profile, infer_roi_type, roi_type, to_ascii
from rtgaia_testbe import Session
from synth_dicom import SynthCase, write_synth_case

DB_URL = os.environ.get("RTGAIA_TEST_DB_URL", "")


@pytest.fixture(scope="module")
def synth(tmp_path_factory) -> SynthCase:  # type: ignore[no-untyped-def]
    return write_synth_case(tmp_path_factory.mktemp("synth"))


def _selection(synth: SynthCase) -> dict:
    return {
        "primary_series_uid": synth.plan_ct.series_uid,
        "image_series_uids": [synth.plan_ct.series_uid],
        "structure_set_uids": [synth.plan_rs_uid],
        "dose_uids": [],
        "registration_uids": [],
        "plan_uids": [],
    }


def _export(s: Session, body: dict) -> tuple[dict, pydicom.Dataset]:
    job = s._post(f"/api/v1/studies/{s.study_id}/export", {"format": "rtstruct", **body})
    deadline = time.time() + 60
    while True:
        done = s._get(f"/api/v1/jobs/{job['job_id']}")
        if done["status"] in ("done", "failed"):
            break
        assert time.time() < deadline
        time.sleep(0.05)
    assert done["status"] == "done", done
    raw = s._client.get(done["download_url"], headers=s._headers).content
    return done, pydicom.dcmread(io.BytesIO(raw))


def test_ascii_and_type_rules() -> None:
    assert to_ascii("左側 Parotid") == "_ Parotid".strip() or to_ascii("左側 Parotid") == "_ Parotid"
    assert to_ascii("Côte\\\\x") == "Cote_x"
    assert (
        infer_roi_type("Body") == "EXTERNAL"
        and infer_roi_type("PTV_7000") == "PTV"
        and infer_roi_type("CTV-45") == "CTV"
    )
    assert (
        infer_roi_type("GTVp") == "GTV"
        and infer_roi_type("CouchSurface") == "SUPPORT"
        and infer_roi_type("Bladder") == "ORGAN"
    )
    assert roi_type("organ", "BODY") == "ORGAN"  # 來源有合法類型就沿用
    assert roi_type("WEIRD", "PTV_1") == "PTV"  # 不合法 → 依名字推


def test_varian_profile_rules() -> None:
    entries = [
        {"structure_id": "a", "name": "BODY", "interpreted_type": None},
        {"structure_id": "b", "name": "External", "interpreted_type": "EXTERNAL"},
        {
            "structure_id": "c",
            "name": "Parotid_Left_Superficial",
            "interpreted_type": None,
            "provenance_source": "model",
        },
        {"structure_id": "d", "name": "parotid_left_superficial_2", "interpreted_type": None},
        {"structure_id": "e", "name": "左側腮腺", "interpreted_type": "ORGAN"},
    ]
    r = apply_profile(
        "varian", entries, {"label": "王醫師 計畫", "description": "RT-Gaia 2026 · 王醫師", "series_description": "x"}
    )
    by = {e["structure_id"]: e for e in r.entries}
    names = [e["name"] for e in r.entries]
    assert all(len(n) <= 16 and n.isascii() for n in names)
    assert len({n.upper() for n in names}) == len(names)  # 不分大小寫不重複
    assert by["c"]["name"] == "Parotid_Left_Sup" and by["c"]["roi_description"] == "Parotid_Left_Superficial"
    assert by["d"]["name"].upper() != by["c"]["name"].upper() and len(by["d"]["name"]) <= 16
    assert by["e"]["name"] == "_" or by["e"]["name"].startswith(("_", "ROI_"))
    # 恰好一個 EXTERNAL，保留名字最像體表的
    assert [e["structure_id"] for e in r.entries if e["interpreted_type"] == "EXTERNAL"] == ["a"]
    assert by["c"]["generation_algorithm"] == "AUTOMATIC" and by["a"]["generation_algorithm"] == "SEMIAUTOMATIC"
    assert r.header["label"].isascii() and len(r.header["label"]) <= 16 and r.charset is None
    fields = {w["field"] for w in r.warnings}
    assert {"ROIName", "RTROIInterpretedType", "label", "description"} <= fields
    g = apply_profile("generic", entries, {"label": "王醫師 計畫", "description": "d", "series_description": "x"})
    assert (
        g.entries[2]["name"] == "Parotid_Left_Superficial"
        and g.charset == "ISO_IR 192"
        and g.header["label"] == "王醫師 計畫"
    )
    with pytest.raises(ValueError):
        apply_profile("elekta", entries, {})


def test_uid_root_env(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("RTGAIA_UID_ROOT", raising=False)
    monkeypatch.delenv("RTGAIA_IMPLEMENTATION_CLASS_UID", raising=False)
    assert (
        dicom_uid.new_uid().startswith(PYDICOM_ROOT_UID)
        and dicom_uid.implementation_class_uid() == PYDICOM_IMPLEMENTATION_UID
    )
    monkeypatch.setenv("RTGAIA_UID_ROOT", "1.2.3.4")
    u = dicom_uid.new_uid()
    assert u.startswith("1.2.3.4.") and len(u) <= 64
    monkeypatch.setenv("RTGAIA_UID_ROOT", "2.25")
    assert dicom_uid.new_uid().startswith("2.25.")
    for bad in ("1.02.3", "abc", "1.2.3." + "9" * 40):
        monkeypatch.setenv("RTGAIA_UID_ROOT", bad)
        assert dicom_uid.uid_config_problems()
        with pytest.raises(ValueError):
            dicom_uid.new_uid()
    from rtgaia_server.app import create_app

    with pytest.raises(ValueError, match="UID"):
        create_app(auth="off", db_url="")
    monkeypatch.setenv("RTGAIA_UID_ROOT", "1.2.3")
    monkeypatch.setenv("RTGAIA_IMPLEMENTATION_CLASS_UID", "1.2.3.x")
    assert dicom_uid.uid_config_problems()


def test_export_end_to_end(synth: SynthCase, tmp_path: Path, monkeypatch) -> None:  # type: ignore[no-untyped-def]
    monkeypatch.setenv("RTGAIA_DATA_DIR", str(tmp_path / "data"))
    monkeypatch.setenv("RTGAIA_UID_ROOT", "1.2.826.0.1.99")
    with Session(library_root=str(synth.root), user="dr") as s:
        s.load_case(_selection(synth))
        profiles = s._get("/api/v1/export/profiles")
        assert profiles["default"] == "varian" and {p["id"] for p in profiles["profiles"]} == {"varian", "generic"}
        assert profiles["uid_root"].startswith("1.2.826.0.1.99.")
        made = s._post(
            f"/api/v1/studies/{s.study_id}/structures", {"name": "PTV_boost_high_dose_region", "color_rgb": [1, 2, 3]}
        )
        import numpy as np

        s.edit(made["structure_id"], offset_ijk=(1, 1, 1), array=np.ones((2, 2, 2), dtype=np.uint8))
        with pytest.raises(RuntimeError, match="BAD_PROFILE"):
            s._post(f"/api/v1/studies/{s.study_id}/export", {"format": "rtstruct", "profile": "elekta"})
        done, ds = _export(s, {})  # 預設 varian
        assert done["profile"] == "varian" and done["uid_root"].startswith("1.2.826.0.1.99.")
        assert str(ds.SeriesInstanceUID).startswith("1.2.826.0.1.99.") and str(ds.SOPInstanceUID).startswith(
            "1.2.826.0.1.99."
        )
        assert ds.file_meta.ImplementationVersionName == "RTGAIA_0_1"
        assert ds.file_meta.ImplementationClassUID == PYDICOM_IMPLEMENTATION_UID
        assert ds.ManufacturerModelName == "RT-Gaia"
        rois = {int(r.ROINumber): r for r in ds.StructureSetROISequence}
        types = {int(o.ReferencedROINumber): o.RTROIInterpretedType for o in ds.RTROIObservationsSequence}
        by_name = {str(r.ROIName): types[n] for n, r in rois.items()}
        assert all(len(n) <= 16 for n in by_name)
        assert by_name.get("BODY") == "EXTERNAL"  # 來源 RTSTRUCT 的類型一路帶過來（之前會變 ORGAN）
        boost = next(r for r in rois.values() if str(getattr(r, "ROIDescription", "")) == "PTV_boost_high_dose_region")
        assert str(boost.ROIName) == "PTV_boost_high_d" and by_name["PTV_boost_high_d"] == "PTV"
        assert list(types.values()).count("EXTERNAL") == 1
        assert any(w["field"] == "ROIName" for w in done["profile_warnings"])
        done_g, ds_g = _export(s, {"profile": "generic"})
        assert "PTV_boost_high_dose_region" in {str(r.ROIName) for r in ds_g.StructureSetROISequence}
        assert ds_g.SpecificCharacterSet == "ISO_IR 192" and done_g["profile"] == "generic"


@pytest.mark.db
def test_interpreted_type_survives_db_reload(synth: SynthCase, tmp_path: Path, monkeypatch) -> None:  # type: ignore[no-untyped-def]
    if not DB_URL:
        pytest.skip("RTGAIA_TEST_DB_URL 未設")
    from rtgaia_server.db.migrate import downgrade_base, upgrade_to_head

    monkeypatch.setenv("RTGAIA_DATA_DIR", str(tmp_path / "data"))
    downgrade_base(DB_URL)
    upgrade_to_head(DB_URL)
    with Session(library_root=str(synth.root), db_url=DB_URL, auth="off", user="dr") as s:
        out = s.load_case(_selection(synth))
        s._post(f"/api/v1/studies/{s.study_id}/review", {"structure_statuses": {}, "note": "persist"})
        rel = s._post(f"/api/v1/sessions/{out['session_id']}/release", {})
        assert rel["case_evicted"] is True
        s.load_case(rel["selection"])  # 從 DB 重建
        types = {st["name"]: st.get("interpreted_type") for st in s.structures()}
        assert types.get("BODY") == "EXTERNAL"


def test_varian_default_description_is_english(synth: SynthCase, tmp_path: Path, monkeypatch) -> None:  # type: ignore[no-untyped-def]
    """預設描述在 Varian profile 下直接用英文組，不是把中文硬轉成底線。"""
    monkeypatch.setenv("RTGAIA_DATA_DIR", str(tmp_path / "data"))
    with Session(library_root=str(synth.root), user="dr") as s:
        s.load_case(_selection(synth))
        done, ds = _export(s, {})
        desc = str(ds.StructureSetDescription)
        assert desc.isascii() and "ROIs" in desc and "_ _" not in desc
        assert not any(w["field"] in ("description", "series_description") for w in done["profile_warnings"])
        _done_g, ds_g = _export(s, {"profile": "generic"})
        assert "結構" in str(ds_g.StructureSetDescription)
