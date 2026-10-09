"""目錄樹：四層、PLAN 容納 DOSE、REG 只掛 moving 側、篩選命中傳播、搜尋路徑、zip 下載。

跑在 `synth_dicom.write_synth_case()` 的合成病例上：一個病人、一個 study、計畫 CT（FoR A）＋ CBCT（FoR B）、
各一套 RTSTRUCT、計畫 RTPLAN ＋ 其 RTDOSE、CBCT 的分次劑量（無計畫）、一個 REG（B → A）。
"""

from __future__ import annotations

import io
import zipfile
from pathlib import Path

import pytest
from rtgaia_core.library import Catalog, LibraryIndex
from rtgaia_testbe import Session
from synth_dicom import SynthCase, write_synth_case


@pytest.fixture(scope="module")
def synth(tmp_path_factory) -> SynthCase:
    return write_synth_case(tmp_path_factory.mktemp("synth"))


@pytest.fixture(scope="module")
def catalog(synth: SynthCase) -> Catalog:
    return Catalog(LibraryIndex.scan(synth.root, use_cache=False))


@pytest.fixture(scope="module")
def lib_driver(synth: SynthCase):
    with Session(library_root=str(synth.root)) as s:
        yield s


def _uids(rows: list[dict]) -> list[str]:
    return [r["series_instance_uid"] for r in rows]


def test_patient_and_study_rows(catalog: Catalog, synth: SynthCase) -> None:
    patients = catalog.patients()
    assert patients["total"] == 1
    p = patients["items"][0]
    assert p["kind"] == "patient" and p["patient_id"] == "SYNTH-0001"
    assert p["study_count"] == 1 and p["series_count"] == 8 and p["image_series_count"] == 2
    assert "patient_name" not in p  # 預設只送 PatientID
    studies = catalog.studies("SYNTH-0001")
    assert len(studies) == 1
    st = studies[0]
    assert st["image_series_count"] == 2 and st["rt_object_count"] == 6 and st["unlinked_count"] == 0


def test_fourth_level_plan_contains_dose_and_reg_only_on_moving_side(catalog: Catalog, synth: SynthCase) -> None:
    study_uid = synth.plan_ct.study_uid
    series = catalog.series(study_uid)
    images = {r["series_instance_uid"]: r for r in series["images"]}
    assert set(images) == {synth.plan_ct.series_uid, synth.cbct.series_uid}
    assert series["unlinked"] == []

    plan_ct = images[synth.plan_ct.series_uid]
    # 計畫 CT：RS 1、PLAN 1（底下 1 個 DOSE）、REG 0（它是 fixed 側）、被 1 個對位指向
    assert plan_ct["rtstruct_count"] == 1 and plan_ct["plan_count"] == 1 and plan_ct["dose_count"] == 1
    assert plan_ct["registration_count"] == 0 and plan_ct["registrations_targeting"] == 1

    cbct = images[synth.cbct.series_uid]
    # CBCT：RS 1、孤兒 DOSE 1、REG 1（moving 側）
    assert cbct["rtstruct_count"] == 1 and cbct["plan_count"] == 0 and cbct["dose_count"] == 1
    assert cbct["registration_count"] == 1 and cbct["registrations_targeting"] == 0

    rt_plan_ct = catalog.rt(synth.plan_ct.series_uid)
    kinds = [r["kind"] for r in rt_plan_ct]
    assert kinds == ["rtstruct", "plan"]
    plan_row = rt_plan_ct[1]
    assert _uids(plan_row["doses"]) == [synth.plan_dose_uid]
    assert plan_row["doses"][0]["plan_missing"] is False
    rs_row = rt_plan_ct[0]
    assert rs_row["referenced_by_plans"] == [synth.plan_uid]
    assert rs_row["referenced_by_plan_labels"] == ["SYNTH-ART1"]

    rt_cbct = catalog.rt(synth.cbct.series_uid)
    assert [r["kind"] for r in rt_cbct] == ["rtstruct", "dose", "reg"]
    assert rt_cbct[1]["plan_missing"] is True
    reg = rt_cbct[2]
    assert reg["direction"]["from_series_uid"] == synth.cbct.series_uid
    assert reg["direction"]["to_series_uid"] == synth.plan_ct.series_uid
    assert reg["direction"]["deformable"] is False
    assert reg["fixed_frame_of_reference_uid"] == synth.plan_ct.frame_of_reference_uid
    assert reg["moving_frame_of_reference_uids"] == [synth.cbct.frame_of_reference_uid]


def test_filter_hits_propagate_to_ancestors_but_children_stay_complete(catalog: Catalog, synth: SynthCase) -> None:
    # ROI 名稱是搜尋入口之一：合成 RTSTRUCT 的 ROI 叫什麼由 synth_dicom 決定，這裡取第一個
    rs = catalog.index.series[synth.plan_rs_uid]
    roi = rs.refs["roi_names"][0]
    match = catalog.match(q=roi.lower())
    assert match is not None and synth.plan_rs_uid in match
    # 病人與 study 因子孫命中而出現
    assert catalog.patients(match)["total"] == 1
    assert catalog.studies("SYNTH-0001", match)[0]["hit_count"] >= 1
    series = catalog.series(synth.plan_ct.study_uid, match)
    # 只有掛著命中 RS 的影像出現（CBCT 的 RS 也可能同名 → 兩者都在；至少計畫 CT 在）
    assert synth.plan_ct.series_uid in _uids(series["images"])
    # 影像展開：全部 RT 都列，命中者 hit=True
    rt = catalog.rt(synth.plan_ct.series_uid, match)
    assert [r["kind"] for r in rt] == ["rtstruct", "plan"]
    assert rt[0]["hit"] is True and rt[1]["hit"] is False

    # `has`：只有掛著 REG 的影像
    only_reg = catalog.match(has="reg")
    assert only_reg == {synth.cbct.series_uid}
    # 沒有條件 → None（＝全部）
    assert catalog.match() is None
    # UID 子字串只是備援，但要能命中
    assert synth.plan_uid in (catalog.match(q=synth.plan_uid[-8:]) or set())


def test_search_returns_paths_for_auto_expand(catalog: Catalog, synth: SynthCase) -> None:
    hits = catalog.search(catalog.match(modality="RTDOSE"))
    by_uid = {h["series_instance_uid"]: h for h in hits}
    plan_dose = by_uid[synth.plan_dose_uid]
    assert plan_dose["path"]["image_series_uid"] == synth.plan_ct.series_uid
    assert plan_dose["path"]["plan_series_uid"] == synth.plan_uid
    cbct_dose = by_uid[synth.cbct_dose_uid]
    assert cbct_dose["path"]["image_series_uid"] == synth.cbct.series_uid
    assert cbct_dose["path"]["plan_series_uid"] is None
    assert catalog.search(None) == []


def test_detail_lists_attached_and_related_labels(catalog: Catalog, synth: SynthCase) -> None:
    d = catalog.detail(synth.plan_ct.series_uid)
    assert d["attached"]["plan"] == [synth.plan_uid]
    assert d["attached"]["doses_of_plan"] == {synth.plan_uid: [synth.plan_dose_uid]}
    assert d["attached"]["registrations_targeting"] == [synth.reg_uid]
    assert synth.reg_uid in d["labels"]
    assert Path(d["directory"]).is_dir()
    rs = catalog.detail(synth.plan_rs_uid)
    assert rs["attached"] is None and rs["referenced_by_plans"] == [synth.plan_uid]


def test_endpoints_and_zip_download(lib_driver: Session, synth: SynthCase) -> None:
    patients = lib_driver.catalog_patients()
    assert patients["total"] == 1 and patients["items"][0]["patient_id"] == "SYNTH-0001"
    studies = lib_driver.catalog_studies("SYNTH-0001")
    series = lib_driver.catalog_series(studies[0]["study_instance_uid"])
    assert len(series["images"]) == 2
    rt = lib_driver.catalog_rt(synth.cbct.series_uid)
    assert [r["kind"] for r in rt] == ["rtstruct", "dose", "reg"]
    assert lib_driver.catalog_search(modality="REG")["total"] == 1
    with pytest.raises(RuntimeError, match="404"):
        lib_driver.catalog_rt("nope")

    # zip：STORE、檔名 UID、不含姓名、內容逐位元組等於原檔
    blob = lib_driver.catalog_download("series", synth.plan_ct.series_uid)
    zf = zipfile.ZipFile(io.BytesIO(blob))
    names = zf.namelist()
    assert len(names) == synth.plan_ct.size[2]
    assert all(n.startswith(f"{synth.plan_ct.series_uid}/") and n.endswith(".dcm") for n in names)
    assert all(i.compress_type == zipfile.ZIP_STORED for i in zf.infolist())
    assert "Synthetic" not in " ".join(names)
    entry = catalog_entry = None
    index = LibraryIndex.scan(synth.root, use_cache=False)
    catalog_entry = index.series[synth.plan_ct.series_uid]
    first = catalog_entry.paths[0]
    entry = next(n for n in names if n.endswith(f"{catalog_entry.instances[0].sop_instance_uid}.dcm"))
    assert zf.read(entry) == first.read_bytes() or any(zf.read(n) == first.read_bytes() for n in names)

    # 使用者可選壓縮（2026-09-15）：DEFLATE、內容仍逐位元組相同
    zc = zipfile.ZipFile(io.BytesIO(lib_driver.catalog_download("series", synth.plan_ct.series_uid, compress=True)))
    assert zc.namelist() == names and all(i.compress_type == zipfile.ZIP_DEFLATED for i in zc.infolist())
    assert zc.read(entry) == zf.read(entry)

    # 病人層：study/series 兩層目錄
    whole = zipfile.ZipFile(io.BytesIO(lib_driver.catalog_download("patients", "SYNTH-0001")))
    assert len(whole.namelist()) == index.summary()["file_count"]
    assert all(n.count("/") == 2 for n in whole.namelist())
    with pytest.raises(RuntimeError, match="404"):
        lib_driver.catalog_download("studies", "nope")


def test_catalog_delete_moves_to_trash_and_guards_cases(tmp_path: Path, monkeypatch) -> None:  # type: ignore[no-untyped-def]
    """2026-09-15：從資料庫移除序列／study（admin）—— 檔案搬進 .rtgaia/trash（可救回）、樹上消失；
    有病例引用 → 409 IN_USE，force 才刪；非 admin 403。"""
    import json

    monkeypatch.setenv("RTGAIA_DATA_DIR", str(tmp_path / "data"))
    synth = write_synth_case(tmp_path / "lib")
    with Session(library_root=str(synth.root), user="admin") as s:
        # 非 admin 不能刪
        tech = Session(client=s._client, user="tech")
        tech._headers["X-RTGaia-Role"] = "contourer"
        with pytest.raises(RuntimeError, match="403"):
            tech.catalog_delete("series", synth.cbct_dose_uid)
        # 刪 CBCT 的劑量序列：檔案進垃圾桶、manifest、樹上沒了
        n_files_before = sum(1 for _ in synth.root.rglob("*.dcm"))
        out = s.catalog_delete("series", synth.cbct_dose_uid)
        assert out["files_moved"] == 1 and out["series_uids"] == [synth.cbct_dose_uid] and out["affected_cases"] == []
        trash = Path(out["trash_dir"])
        manifest = json.loads((trash / "manifest.json").read_text(encoding="utf-8"))
        assert manifest["who"] == "admin" and manifest["level"] == "series" and len(manifest["files"]) == 1
        assert Path(manifest["files"][0]["to"]).exists() and not Path(manifest["files"][0]["from"]).exists()
        assert sum(1 for p in synth.root.rglob("*.dcm") if ".rtgaia" not in p.parts) == n_files_before - 1
        assert [r["kind"] for r in s.catalog_rt(synth.cbct.series_uid)] == ["rtstruct", "reg"]
        with pytest.raises(RuntimeError, match="404"):
            s.catalog_delete("series", synth.cbct_dose_uid)
        # 有病例引用 → 409（列出病例）；force → 刪，回 affected_cases
        s.load_case(
            {
                "primary_series_uid": synth.plan_ct.series_uid,
                "image_series_uids": [synth.plan_ct.series_uid],
                "structure_set_uids": [synth.plan_rs_uid],
                "dose_uids": [],
                "registration_uids": [],
                "plan_uids": [],
            }
        )
        with pytest.raises(RuntimeError, match="IN_USE") as exc:
            s.catalog_delete("series", synth.plan_rs_uid)
        assert s.case_id in str(exc.value)
        forced = s.catalog_delete("series", synth.plan_rs_uid, force=True)
        assert forced["forced"] is True and forced["affected_cases"][0]["case_id"] == s.case_id
        # 刪整個 study（剩下的全部）→ 病人也消失
        out = s.catalog_delete("studies", synth.plan_ct.study_uid, force=True)
        assert out["files_moved"] > 1 and s.catalog_patients()["total"] == 0
        # 稽核：DELETE 有記、物件是 (level, key)
        tail = s._app.state.rtgaia.audit_tail
        ev = next(e for e in tail if e["action"].startswith("DELETE /api/v1/catalog"))
        assert ev["object_type"] == "series" and ev["user"] == "admin"
