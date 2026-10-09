"""匯入管線：上傳檔案與 zip、非 DICOM 拒絕、去重（同內容／不同內容）、落地 blobs、索引更新、
伺服器目錄匯入（複製不搬）、丟棄。空的資料庫根目錄起步，匯入合成病例。
"""

from __future__ import annotations

import io
import zipfile
from pathlib import Path

import pydicom
import pytest
from rtgaia_core.library import Importer, LibraryIndex
from rtgaia_core.library.importer import BLOBS_DIR, STAGING_DIR
from rtgaia_testbe import Session
from synth_dicom import SynthCase, write_synth_case


@pytest.fixture(scope="module")
def synth(tmp_path_factory) -> SynthCase:
    return write_synth_case(tmp_path_factory.mktemp("synth"))


@pytest.fixture
def empty_root(tmp_path: Path) -> Path:
    root = tmp_path / "library"
    root.mkdir()
    (root / "README.txt").write_text("not dicom", encoding="utf-8")
    return root


def _files(directory: Path) -> list[Path]:
    return sorted(p for p in directory.rglob("*") if p.is_file())


def test_upload_completes_when_the_request_is_english(empty_root: Path, synth: SynthCase) -> None:
    """英文（`Accept-Language: en`，也是沒說語言時的預設）上傳也要匯入完成：翻譯回應時以前另建一個回應、
    丟掉了 BackgroundTasks（匯入管線），批次永遠停在 open。"""
    ct_files = _files(synth.plan_ct.directory)
    with Session(library_root=str(empty_root)) as s:
        s._headers["Accept-Language"] = "en"
        bid = s.import_open({"note": "en"})["batch_id"]
        for p in ct_files:
            assert s.import_put(bid, f"case/CT/{p.name}", p.read_bytes())["items"][0]["outcome"] == "staged"
        done = s.wait_import(s.import_complete(bid)["batch_id"], timeout=10)
        assert done["status"] == "done" and done["counts"]["accepted"] == len(ct_files)
        assert s.catalog_patients()["total"] == 1


def test_upload_files_zip_and_rejects_then_indexes(empty_root: Path, synth: SynthCase) -> None:
    ct_files = _files(synth.plan_ct.directory)
    with Session(library_root=str(empty_root)) as s:
        assert s.catalog_patients()["total"] == 0
        batch = s.import_open({"note": "test"})
        bid = batch["batch_id"]
        # 逐檔上傳（帶子目錄的 relative path）
        for p in ct_files:
            out = s.import_put(bid, f"case/CT/{p.name}", p.read_bytes())
            assert out["items"][0]["outcome"] == "staged"
        # zip：RS ＋ PLAN ＋ DOSE 一包
        buf = io.BytesIO()
        with zipfile.ZipFile(buf, "w") as zf:
            for name in ("rs.dcm", "plan.dcm", "dose.dcm"):
                zf.write(synth.root / "plan_0" / name, arcname=f"rt/{name}")
        out = s.import_put(bid, "plan_0.zip", buf.getvalue())
        assert [it["outcome"] for it in out["items"]] == ["staged"] * 3
        assert all(it["relative_path"].startswith("plan_0/rt/") for it in out["items"])
        # 非 DICOM 當場拒絕，不佔暫存區
        out = s.import_put(bid, "notes.txt", b"hello world" * 20)
        assert out["items"][0]["outcome"] == "rejected"
        # 壞 zip
        out = s.import_put(bid, "broken.zip", b"PK\x03\x04garbage")
        assert out["items"][0]["outcome"] == "rejected"
        staged_dir = empty_root / STAGING_DIR / bid
        assert len(_files(staged_dir)) == len(ct_files) + 3

        done = s.wait_import(s.import_complete(bid)["batch_id"])
        assert done["status"] == "done" and done["percent"] == 100
        c = done["counts"]
        assert c["accepted"] == len(ct_files) + 3 and c["rejected"] == 2 and c["duplicate_same"] == 0
        assert done["touched_patient_ids"] == ["SYNTH-0001"]
        # 落地：blobs/<sha[:2]>/<sha>.dcm，暫存區清掉
        blobs = _files(empty_root / BLOBS_DIR)
        assert len(blobs) == len(ct_files) + 3
        assert all(len(p.stem) == 64 and p.suffix == ".dcm" and p.parent.name == p.stem[:2] for p in blobs)
        assert not staged_dir.exists()
        # 索引已更新：目錄樹看得到，PLAN 容納 DOSE
        patients = s.catalog_patients()
        assert patients["total"] == 1
        studies = s.catalog_studies("SYNTH-0001")
        series = s.catalog_series(studies[0]["study_instance_uid"])
        assert [i["series_instance_uid"] for i in series["images"]] == [synth.plan_ct.series_uid]
        rt = s.catalog_rt(synth.plan_ct.series_uid)
        assert [r["kind"] for r in rt] == ["rtstruct", "plan"] and len(rt[1]["doses"]) == 1
        # 批次清單與 items
        assert s.import_list()[0]["batch_id"] == bid
        assert any(it["outcome"] == "rejected" for it in s.import_get(bid)["items"])


def test_reimport_same_is_duplicate_and_modified_same_sop_is_refused(empty_root: Path, synth: SynthCase) -> None:
    ct_files = _files(synth.plan_ct.directory)
    with Session(library_root=str(empty_root)) as s:
        b1 = s.import_open()["batch_id"]
        for p in ct_files:
            s.import_put(b1, p.name, p.read_bytes())
        s.import_complete(b1)
        assert s.wait_import(b1)["counts"]["accepted"] == len(ct_files)

        # 同內容再匯一次 → 全部 duplicate_same，blobs 不增加
        before = len(_files(empty_root / BLOBS_DIR))
        b2 = s.import_open()["batch_id"]
        for p in ct_files:
            s.import_put(b2, p.name, p.read_bytes())
        s.import_complete(b2)
        c = s.wait_import(b2)["counts"]
        assert c["duplicate_same"] == len(ct_files) and c["accepted"] == 0
        assert len(_files(empty_root / BLOBS_DIR)) == before

        # 同 SOP UID 但內容不同 → duplicate_diff，**不覆寫**
        ds = pydicom.dcmread(str(ct_files[0]))
        ds.SeriesDescription = "TAMPERED"
        buf = io.BytesIO()
        ds.save_as(buf, enforce_file_format=True)
        b3 = s.import_open()["batch_id"]
        s.import_put(b3, "tampered.dcm", buf.getvalue())
        # 同一批裡再放一次原檔 → 與批內比對
        s.import_put(b3, "again.dcm", ct_files[0].read_bytes())
        s.import_complete(b3)
        done = s.wait_import(b3)
        outcomes = {it["relative_path"]: it["outcome"] for it in done["items"]}
        assert outcomes["tampered.dcm"] == "duplicate_diff"
        assert outcomes["again.dcm"] == "duplicate_same"
        assert len(_files(empty_root / BLOBS_DIR)) == before
        # 庫裡那一份沒被動
        index = LibraryIndex.scan(empty_root, use_cache=False)
        assert all(h.series_description != "TAMPERED" for s_ in index.series.values() for h in s_.instances)


def test_server_path_import_copies_and_keeps_source(empty_root: Path, synth: SynthCase) -> None:
    src_files = _files(synth.root)
    with Session(library_root=str(empty_root)) as s:
        batch = s.import_server_path(str(synth.root))
        done = s.wait_import(batch["batch_id"])
        assert done["source"] == "server_path" and done["detail"]["path"] == str(synth.root)
        assert done["counts"]["accepted"] == len(src_files)
        # 來源不動、blobs 多了同樣多的檔
        assert _files(synth.root) == src_files
        assert len(_files(empty_root / BLOBS_DIR)) == len(src_files)
        assert s.catalog_patients()["total"] == 1
        # 目錄不存在 → 422
        with pytest.raises(RuntimeError, match="422"):
            s.import_server_path(str(empty_root / "nope"))


def test_directory_import_job_is_queued_as_a_copy(empty_root: Path, synth: SynthCase, tmp_path: Path) -> None:
    """`/dimse/import-directory` 以前先用「搬移」排入、之後才改成複製再寫回 ——
    worker 在那個空檔領走就會搬走使用者目錄的檔案。現在排入的那一刻就是複製；來源的檔案一個都不少，空目錄也不刪。"""
    import asyncio
    import shutil

    source = tmp_path / "user-dir"
    shutil.copytree(synth.plan_ct.directory, source / "CT")
    (source / "empty").mkdir()
    src_files = _files(source)
    with Session(library_root=str(empty_root)) as s:
        queue = asyncio.run(s._app.state.rtgaia.job_queue_async())
        queued: list[dict] = []
        original = queue.enqueue

        async def recording(job):  # type: ignore[no-untyped-def]
            queued.append(dict(job.request))  # 排入那一刻的內容（之後被改也看得出來）
            return await original(job)

        queue.enqueue = recording
        job = s._post("/api/v1/dimse/import-directory", {"path": str(source)})
        done = s.wait_for_job(job["job_id"])
    assert [q["move"] for q in queued] == [False]
    assert done["status"] == "done", done
    assert _files(source) == src_files and (source / "empty").is_dir()
    assert len(_files(empty_root / BLOBS_DIR)) == len(src_files)


def test_discard_and_closed_batch(empty_root: Path, synth: SynthCase) -> None:
    ct = _files(synth.plan_ct.directory)[0]
    with Session(library_root=str(empty_root)) as s:
        bid = s.import_open()["batch_id"]
        s.import_put(bid, ct.name, ct.read_bytes())
        assert (empty_root / STAGING_DIR / bid).exists()
        assert s.import_discard(bid)["status"] == "discarded"
        assert not (empty_root / STAGING_DIR / bid).exists()
        with pytest.raises(RuntimeError, match="409"):
            s.import_put(bid, ct.name, ct.read_bytes())
        with pytest.raises(RuntimeError, match="404"):
            s.import_get("imp_nope")
        # 只有拒絕、沒有 staged → complete 直接 done
        b2 = s.import_open()["batch_id"]
        s.import_put(b2, "x.txt", b"nope" * 40)
        assert s.import_complete(b2)["status"] == "done"


def test_importer_unit_unsupported_modality_and_safe_paths(empty_root: Path, synth: SynthCase) -> None:
    imp = Importer(empty_root)
    b = imp.open_batch("upload")
    ct = _files(synth.plan_ct.directory)[0]
    ds = pydicom.dcmread(str(ct))
    ds.Modality = "SR"
    buf = io.BytesIO()
    ds.save_as(buf, enforce_file_format=True)
    items = imp.receive(b, "../../etc/passwd/../sr.dcm", buf.getvalue())
    assert items[0].relative_path == "etc/passwd/sr.dcm"
    assert Path(items[0].staged_path).resolve().is_relative_to(b.staging.resolve())
    imp.process(b, LibraryIndex.scan(empty_root, use_cache=False))
    assert b.items[0].outcome == "rejected" and "不支援的模態 SR" in b.items[0].reason
    assert b.status == "done"


def test_importer_keeps_undecodable_compressed_files_and_reports_them(empty_root: Path, synth: SynthCase) -> None:
    """JPEG Lossless／JPEG-LS 先不支援，但要有例外處理：
    解不了的壓縮檔照樣收下（原樣存、不轉碼，可下載／轉送），批次上列出「無法解碼的序列」與原因。"""
    from pydicom.encaps import encapsulate
    from pydicom.uid import JPEGLosslessSV1

    imp = Importer(empty_root)
    b = imp.open_batch("upload")
    for p in _files(synth.plan_ct.directory):
        ds = pydicom.dcmread(str(p))
        ds.file_meta.TransferSyntaxUID = JPEGLosslessSV1
        ds.PixelData = encapsulate([b"\xff\xd8\xff\xc3" + b"\x00" * 16 + b"\xff\xd9"])
        ds["PixelData"].VR = "OB"
        buf = io.BytesIO()
        ds.save_as(buf, enforce_file_format=True)
        imp.receive(b, f"ll/{p.name}", buf.getvalue())
    imp.process(b, LibraryIndex.scan(empty_root, use_cache=False))
    assert {it.outcome for it in b.items} == {"accepted"}
    und = b.to_wire()["undecodable"]
    assert len(und) == 1 and und[0]["series_instance_uid"] == synth.plan_ct.series_uid
    assert und[0]["count"] == len(b.items) and "JPEG Lossless" in und[0]["transfer_syntax"]
    assert "沒有可用的解碼器" in und[0]["reason"]
    # 未壓縮的正常批次不列
    b2 = imp.open_batch("upload")
    for p in _files(synth.cbct.directory):
        imp.receive(b2, f"cbct/{p.name}", p.read_bytes())
    imp.process(b2, LibraryIndex.scan(empty_root, use_cache=False))
    assert b2.to_wire()["undecodable"] == []


# ── 同名檔在驗證前不得互相覆寫 ───────────────────────────────


def test_same_relative_name_does_not_overwrite_before_validation(empty_root: Path, synth: SynthCase) -> None:
    """重現：同批連續上傳兩份不同內容的 `image.dcm`，第一個 item 的 staged_path 讀回第二份。
    現在實體檔名是 item 自己的亂數名，`relative_path` 只是 metadata；同名同 SOP 不同內容也各自進驗證，
    由去重那一步判 `duplicate_diff`，不是其中一份消失。"""
    ct = _files(synth.plan_ct.directory)
    a, b = ct[0].read_bytes(), ct[1].read_bytes()
    assert a != b
    with Session(library_root=str(empty_root)) as s:
        bid = s.import_open()["batch_id"]
        s.import_put(bid, "image.dcm", a)
        s.import_put(bid, "image.dcm", b)
        imp = s._app.state.rtgaia.importer
        items = imp.get(bid).items
        assert [it.relative_path for it in items] == ["image.dcm", "image.dcm"]
        assert items[0].staged_path != items[1].staged_path
        assert Path(items[0].staged_path).read_bytes() == a
        assert Path(items[1].staged_path).read_bytes() == b
        # 同名、同 SOP、不同內容：兩份都進驗證，第二份被判 duplicate_diff（不是靜默消失）
        ds = pydicom.dcmread(str(ct[2]))
        ds.SeriesDescription = "tampered"
        buf = io.BytesIO()
        ds.save_as(buf, enforce_file_format=True)
        s.import_put(bid, "same_sop.dcm", ct[2].read_bytes())
        s.import_put(bid, "same_sop.dcm", buf.getvalue())
        # zip 裡兩個同名成員（zip 格式允許）
        zbuf = io.BytesIO()
        with zipfile.ZipFile(zbuf, "w") as zf:
            zf.writestr("dup/x.dcm", ct[3].read_bytes())
            zf.writestr("dup/x.dcm", ct[4].read_bytes())
        out = s.import_put(bid, "dups.zip", zbuf.getvalue())
        assert [it["outcome"] for it in out["items"]] == ["staged", "staged"]
        done = s.wait_import(bid) if not s.import_complete(bid).get("status") == "done" else s.import_get(bid)
        by_path: dict[str, list[str]] = {}
        for it in done["items"]:
            by_path.setdefault(it["relative_path"], []).append(it["outcome"])
        assert sorted(by_path["image.dcm"]) == ["accepted", "accepted"]
        assert sorted(by_path["same_sop.dcm"]) == ["accepted", "duplicate_diff"]
        assert sorted(by_path["dups/dup/x.dcm"]) == ["accepted", "accepted"]


# ── 匯入批次的身分與 owner ────────────────────────────────────

import os  # noqa: E402

DB_URL = os.environ.get("RTGAIA_TEST_DB_URL", "")


@pytest.mark.db
def test_import_batch_owner_is_principal_and_batches_are_owner_scoped(
    empty_root: Path, synth: SynthCase, tmp_path
) -> None:  # type: ignore[no-untyped-def]
    """重現：已認證的 Alice 帶 `X-RTGaia-User: forged-owner` → 批次 created_by 變成偽造者；
    Bob 能 DELETE 她的批次。現在 created_by 一律 Principal；非 owner 對批次的收檔／查看／complete／discard
    都 404；清單只看自己的（admin 全看）。"""
    if not DB_URL:
        pytest.skip("RTGAIA_TEST_DB_URL 未設")
    from rtgaia_server.db.migrate import downgrade_base, upgrade_to_head

    downgrade_base(DB_URL)
    upgrade_to_head(DB_URL)
    os.environ["RTGAIA_DATA_DIR"] = str(tmp_path / "data")
    ct = _files(synth.plan_ct.directory)[0]
    with Session(library_root=str(empty_root), db_url=DB_URL) as admin:
        admin.bootstrap("admin", "correct-horse-battery")
        admin.create_user("alice", "correct-horse-battery", "contourer")
        admin.create_user("bob", "correct-horse-battery", "contourer")
        alice, bob = Session(client=admin._client), Session(client=admin._client)
        alice.login("alice", "correct-horse-battery")
        bob.login("bob", "correct-horse-battery")
        alice._headers["X-RTGaia-User"] = "forged-owner"  # 偽造標頭必須被忽略
        batch = alice.import_open({"note": "mine"})
        assert batch["created_by"] == "alice"
        bid = batch["batch_id"]
        alice.import_put(bid, ct.name, ct.read_bytes())

        for call in (
            lambda: bob.import_get(bid),
            lambda: bob.import_put(bid, ct.name, ct.read_bytes()),
            lambda: bob.import_complete(bid),
            lambda: bob.import_discard(bid),
        ):
            with pytest.raises(RuntimeError, match="404"):
                call()
        assert alice.import_get(bid)["status"] == "open", "Bob 的操作沒有動到批次"
        assert [b["batch_id"] for b in bob.import_list()] == []
        assert [b["batch_id"] for b in alice.import_list()] == [bid]
        assert [b["batch_id"] for b in admin.import_list()] == [bid]  # admin 看全部
        # admin 可以代為丟棄
        assert admin.import_discard(bid)["status"] == "discarded"
        # server-path 匯入的 created_by 也是 Principal
        b2 = alice.import_server_path(str(synth.plan_ct.directory))
        assert b2["created_by"] == "alice"
