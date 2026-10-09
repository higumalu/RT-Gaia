"""匯出可關閉匿名化：`anonymize=false` 時 RTSTRUCT 帶真實病人識別與 study 描述、
引用真實影像 SOP UID（TPS 才掛得到）；預設仍匿名；假體只能匿名。
"""

from __future__ import annotations

import io
import time
from pathlib import Path

import numpy as np
import pydicom
import pytest
from rtgaia_core.library import LibraryIndex
from rtgaia_testbe import Session
from synth_dicom import SynthCase, write_synth_case


@pytest.fixture(scope="module")
def synth(tmp_path_factory) -> SynthCase:
    return write_synth_case(tmp_path_factory.mktemp("synth"))


def _selection(synth: SynthCase) -> dict:
    return {
        "primary_series_uid": synth.plan_ct.series_uid,
        "image_series_uids": [synth.plan_ct.series_uid, synth.cbct.series_uid],
        "structure_set_uids": [synth.plan_rs_uid, synth.cbct_rs_uid],
        "dose_uids": [],
        "registration_uids": [synth.reg_uid],
        "plan_uids": [],
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


def _export(s: Session, body: dict) -> tuple[dict, pydicom.Dataset]:
    job = s._post(f"/api/v1/studies/{s.study_id}/export", {"format": "rtstruct", **body})
    done = _wait(s, job["job_id"])
    assert done["status"] == "done", done
    raw = s._client.get(done["download_url"], headers=s._headers).content
    return done, pydicom.dcmread(io.BytesIO(raw))


def test_export_identity_toggle_and_real_references(synth: SynthCase, tmp_path: Path, monkeypatch) -> None:  # type: ignore[no-untyped-def]
    monkeypatch.setenv("RTGAIA_DATA_DIR", str(tmp_path / "data"))
    index = LibraryIndex.scan(synth.root, use_cache=False)
    ct_sops = [i.sop_instance_uid for i in index.series[synth.plan_ct.series_uid].instances]
    with Session(library_root=str(synth.root), user="dr") as s:
        s.load_case(_selection(synth))
        body = next(st for st in s.structures() if st["name"] == "BODY" and st["structure_set_id"] == synth.plan_rs_uid)
        mine = s.claim(body["structure_id"])
        s.edit(mine, offset_ijk=(0, 0, 0), array=np.ones((2, 2, 2), dtype=np.uint8), client_seq=1)
        # 預設：匿名 —— 但影像引用已是真實 SOP UID（引用不是 PHI）
        done, ds = _export(s, {"structure_ids": [mine]})
        assert done["anonymized"] is True and done["real_sop_references"] is True and "patient_id" not in done
        assert str(ds.PatientName) == "PHANTOM^RTGAIA" and ds.PatientID == "RTGAIA-TESTBE"
        refs = ds.ReferencedFrameOfReferenceSequence[0].RTReferencedStudySequence[0].RTReferencedSeriesSequence[0]
        assert refs.SeriesInstanceUID == synth.plan_ct.series_uid
        assert sorted(x.ReferencedSOPInstanceUID for x in refs.ContourImageSequence) == sorted(ct_sops)
        assert str(ds.StudyInstanceUID) == synth.plan_ct.study_uid
        # 關閉匿名化：真實病人識別與 study 描述
        done2, ds2 = _export(s, {"structure_ids": [mine], "anonymize": False})
        assert done2["anonymized"] is False and done2["patient_id"] == "SYNTH-0001"
        assert str(ds2.PatientName) == "Synthetic^Case" and ds2.PatientID == "SYNTH-0001"
        assert ds2.StudyDescription == "Synthetic pelvis" and ds2.StudyDate == "20260601"
        assert str(ds2.StudyInstanceUID) == synth.plan_ct.study_uid
        contour_refs = {
            c.ContourImageSequence[0].ReferencedSOPInstanceUID for c in ds2.ROIContourSequence[0].ContourSequence
        }
        assert contour_refs <= set(ct_sops)
        assert str(ds2.SOPClassUID) == "1.2.840.10008.5.1.4.1.1.481.3"
        # 匯出到 CBCT 那組：引用 CBCT 的序列與 SOP
        cbct_body = next(st for st in s.structures() if st["structure_set_id"] == synth.cbct_rs_uid)
        mine_cbct = s.claim(cbct_body["structure_id"])
        done3, ds3 = _export(
            s,
            {
                "structure_ids": [mine_cbct],
                "target_frame_of_reference_uid": synth.cbct.frame_of_reference_uid,
                "anonymize": False,
            },
        )
        assert done3["referenced_series_uid"] == synth.cbct.series_uid
        refs3 = ds3.ReferencedFrameOfReferenceSequence[0].RTReferencedStudySequence[0].RTReferencedSeriesSequence[0]
        assert refs3.SeriesInstanceUID == synth.cbct.series_uid
        with pytest.raises(RuntimeError, match="422"):
            s._post(f"/api/v1/studies/{s.study_id}/export", {"format": "rtstruct", "anonymize": "no"})


def test_phantom_export_is_always_anonymous(tmp_path: Path, monkeypatch) -> None:  # type: ignore[no-untyped-def]
    monkeypatch.setenv("RTGAIA_DATA_DIR", str(tmp_path / "data"))
    with Session(user="qa") as s:
        s.load("phantom:overlap_set")
        done, ds = _export(s, {"anonymize": False})
        assert done["anonymized"] is True and done["anonymize_forced_reason"] and done["real_sop_references"] is False
        assert str(ds.PatientName) == "PHANTOM^RTGAIA"


def test_export_editable_tags_and_save_to_library(synth: SynthCase, tmp_path: Path, monkeypatch) -> None:  # type: ignore[no-untyped-def]
    """使用者可改白名單內的標籤；`save_to_library` → 匯出檔直接進匯入管線，
    資料頁該影像下多一套 RS（強制帶真實識別）。"""
    monkeypatch.setenv("RTGAIA_DATA_DIR", str(tmp_path / "data"))
    with Session(library_root=str(synth.root), user="wang") as s:
        whitelist = {t["keyword"]: t for t in s._get("/api/v1/export/tags")["tags"]}
        assert whitelist["StructureSetLabel"]["max_length"] == 16 and whitelist["PatientName"]["phi"] is True
        s.load_case(_selection(synth))
        body = next(st for st in s.structures() if st["name"] == "BODY" and st["structure_set_id"] == synth.plan_rs_uid)
        mine = s.claim(body["structure_id"])
        # 預設標籤：來自同一個工作集 → 集名稱（截 16）＋ DRAFT；OperatorsName ＝ 操作者
        done, ds = _export(s, {"structure_ids": [mine]})
        assert str(ds.StructureSetLabel).endswith("DRAFT") and str(ds.OperatorsName) == "wang"
        assert done["structure_set_label"] == str(ds.StructureSetLabel)
        # 使用者改標籤（匿名時也可填病人欄位 → 結果標出）
        tags = {
            "StructureSetLabel": "ART fx1 v2",
            "StructureSetDescription": "王醫師 第一次修訂",
            "SeriesDescription": "RS for TPS",
            "SeriesNumber": "7",
            "InstitutionName": "Clinic A",
            "PatientName": "Test Anon",
            "PatientSex": "f",
        }
        done2, ds2 = _export(s, {"structure_ids": [mine], "tags": tags})
        assert str(ds2.StructureSetLabel) == "ART fx1 v2" and ds2.StructureSetDescription == "王醫師 第一次修訂"
        assert ds2.SeriesDescription == "RS for TPS" and ds2.SeriesNumber == 7 and ds2.InstitutionName == "Clinic A"
        assert str(ds2.PatientName) == "Test^Anon" and ds2.PatientSex == "F" and ds2.PatientID == "RTGAIA-TESTBE"
        assert done2["tags_applied"]["PatientName"] == "Test^Anon" and "使用者填寫" in done2["anonymize_forced_reason"]
        # 白名單外／太長／格式錯 → 422
        for bad in (
            {"Manufacturer": "x"},
            {"StructureSetLabel": "x" * 17},
            {"PatientBirthDate": "2026-01-01"},
            {"PatientSex": "X"},
        ):
            with pytest.raises(RuntimeError, match="422"):
                s._post(f"/api/v1/studies/{s.study_id}/export", {"format": "rtstruct", "tags": bad})
        # 存入資料庫：強制真實識別；資料頁計畫 CT 底下多一套 RS，標籤照給的
        before = [r for r in s.catalog_rt(synth.plan_ct.series_uid) if r["kind"] == "rtstruct"]
        done3, ds3 = _export(
            s,
            {
                "structure_ids": [mine],
                "save_to_library": True,
                "anonymize": True,
                "tags": {"StructureSetLabel": "SAVED_V1"},
            },
        )
        assert (
            done3["saved_to_library"] is True and done3["anonymized"] is False and done3["patient_id"] == "SYNTH-0001"
        )
        assert "存入資料庫" in done3["anonymize_forced_reason"]
        assert done3["import"]["counts"]["accepted"] == 1
        after = [r for r in s.catalog_rt(synth.plan_ct.series_uid) if r["kind"] == "rtstruct"]
        assert len(after) == len(before) + 1
        new_rs = next(r for r in after if r["series_instance_uid"] == done3["series_instance_uid"])
        assert new_rs["refs"]["structure_set_label"] == "SAVED_V1" and str(ds3.PatientName) == "Synthetic^Case"
        # 病例本身的工作集不動；再開病例可以把新 RS 選進來（成為匯入集）
        assert {st["structure_id"] for st in s.structures()} >= {mine}
        with pytest.raises(RuntimeError, match="422"):
            s._post(f"/api/v1/studies/{s.study_id}/export", {"format": "rtstruct", "save_to_library": "yes"})
