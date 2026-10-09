"""容量提醒（超過門檻所有人看得到、跨過與回落各記一筆稽核）
與完整性巡檢（基準、缺檔、內容被改、移到暫存區不算遺失、管理者重設基準、權限）。"""

from __future__ import annotations

import asyncio
import os
import shutil
from pathlib import Path

import pytest
from rtgaia_core import storage
from rtgaia_testbe import Session
from synth_dicom import SynthCase, write_synth_case


@pytest.fixture(scope="module")
def synth(tmp_path_factory) -> SynthCase:
    return write_synth_case(tmp_path_factory.mktemp("synth"))


def test_volumes_merge_same_disk_and_threshold(tmp_path: Path, monkeypatch) -> None:  # type: ignore[no-untyped-def]
    (tmp_path / "a").mkdir()
    vols = storage.volumes({"library": tmp_path / "a", "blobs": tmp_path / "b/not/yet", "none": None}, threshold=99)
    assert len(vols) == 1 and vols[0]["labels"] == ["library", "blobs"]
    v = vols[0]
    assert 0 <= v["percent"] <= 100 and v["total"] > 0 and v["used"] + v["free"] <= v["total"] + 1
    # 門檻：環境變數、夾在 50–99
    monkeypatch.setenv("RTGAIA_DISK_WARN_PERCENT", "10")
    assert storage.warn_percent() == 50
    monkeypatch.setenv("RTGAIA_DISK_WARN_PERCENT", "x")
    assert storage.warn_percent() == 90


def test_monitor_reports_crossing_once_and_recovery(tmp_path: Path, monkeypatch) -> None:  # type: ignore[no-untyped-def]
    mon = storage.StorageMonitor()
    used = storage.volumes({"x": tmp_path})[0]["percent"]
    monkeypatch.setenv("RTGAIA_DISK_WARN_PERCENT", str(max(50, int(used) - 1)))
    if used < 51:
        pytest.skip("測試機的磁碟用量太低，做不出超過門檻")
    status, events = mon.check({"library": tmp_path})
    assert status["warn"] is True and [e["action"] for e in events] == ["storage.threshold_exceeded"]
    _, again = mon.check({"library": tmp_path})
    assert again == []  # 同一顆磁碟不重報
    monkeypatch.setenv("RTGAIA_DISK_WARN_PERCENT", "99")
    status, events = mon.check({"library": tmp_path})
    assert status["warn"] is False and [e["action"] for e in events] == ["storage.threshold_recovered"]


def test_patrol_baseline_missing_mismatch_retired_and_rebaseline(tmp_path: Path, synth: SynthCase) -> None:
    lib = tmp_path / "lib"
    shutil.copytree(synth.plan_ct.directory, lib)
    files = sorted(lib.glob("*.dcm"))
    # 一個內容定址的匯入檔：檔名就是 sha256
    digest = storage.sha256_file(files[0])
    blob = lib / f"{digest}.dcm"
    shutil.copy(files[0], blob)
    pairs = [(str(p), f"sop{i}") for i, p in enumerate([*files, blob])]
    store = storage.MemoryLocations()

    first = asyncio.run(storage.patrol(store, pairs, batch=100))
    assert first["checked"] == len(pairs) and first["problems"] == []
    assert (
        store.rows[str(blob)].sha256 == digest and store.rows[str(blob)].detail == ""
    )  # 檔名就是基準、不是「第一次記錄」
    # 改一個檔、刪一個檔、把一個移出資料庫（暫存區）
    files[1].write_bytes(files[1].read_bytes() + b"x")
    files[2].unlink()
    current = [p for p in pairs if p[0] != str(files[3])]
    # 內容定址檔被改：第一次看到也驗得出來
    blob.write_bytes(b"tampered")
    second = asyncio.run(storage.patrol(store, current, batch=100))
    status = {Path(p["path"]).name: p["verify_status"] for p in second["problems"]}
    assert status == {files[1].name: "mismatch", files[2].name: "missing", blob.name: "mismatch"}
    assert second["retired"] == 1 and store.rows[str(files[3])].verify_status == "retired"
    # 管理者確認是合法變動 → 重設基準；不存在的檔不能重設
    rows = asyncio.run(storage.rebaseline(store, [str(files[1]), str(files[2])]))
    assert [Path(r["path"]).name for r in rows] == [files[1].name]
    summary = asyncio.run(storage.integrity_summary(store, current))
    assert {Path(p["path"]).name for p in summary["problems"]} == {files[2].name, blob.name}
    # 最久沒驗的先驗
    store2 = storage.MemoryLocations()
    asyncio.run(storage.patrol(store2, pairs[:3], batch=2))
    assert sorted(store2.rows) == sorted(p for p, _ in pairs[:2])


def test_storage_api_roles_and_integrity_endpoints(tmp_path: Path, synth: SynthCase, monkeypatch) -> None:  # type: ignore[no-untyped-def]
    monkeypatch.setenv("RTGAIA_DATA_DIR", str(tmp_path / "data"))
    lib = tmp_path / "library"
    shutil.copytree(synth.root, lib)
    with Session(library_root=str(lib), user="qa") as s:
        st = s._get("/api/v1/storage/status")
        assert st["threshold"] == storage.warn_percent() and st["volumes"] and "labels" in st["volumes"][0]
        assert "path" in st["volumes"][0]  # auth off ＝ 管理者視角
        health = s._client.get("/healthz").json()
        assert health["storage"] is not None and "warn" in health["storage"]
        run = s._post("/api/v1/storage/integrity/run", {"batch": 5})
        assert run["checked"] == 5 and run["problems"] == []
        summary = s._get("/api/v1/storage/integrity")
        assert summary["verified"] == 5 and summary["total_files"] > 5 and summary["last_run"]["checked"] == 5
        victim = next(r["path"] for r in [*[{"path": p} for p in sorted(str(x) for x in lib.rglob("CT.*.dcm"))]])
        with open(victim, "ab") as f:
            f.write(b"x")
        s._post("/api/v1/storage/integrity/run", {"batch": 10_000})
        problems = s._get("/api/v1/storage/integrity")["problems"]
        assert [p["path"] for p in problems] == [victim] and problems[0]["verify_status"] == "mismatch"
        en = s._client.get("/api/v1/storage/integrity", headers={**s._headers, "Accept-Language": "en"}).json()
        assert en["problems"][0]["detail"].startswith("Content differs from the baseline")
        with pytest.raises(RuntimeError, match="422"):
            s._post("/api/v1/storage/integrity/rebaseline", {"paths": ["/etc/passwd"]})
        s._post("/api/v1/storage/integrity/rebaseline", {"paths": [victim]})
        assert s._get("/api/v1/storage/integrity")["problems"] == []
    assert os.environ.get("RTGAIA_DATA_DIR")


def test_storage_roles_with_accounts(synth: SynthCase, tmp_path: Path, monkeypatch) -> None:  # type: ignore[no-untyped-def]
    """所有登入者都看得到容量（畫面要能提醒），但不給伺服器路徑；完整性巡檢只有 admin。"""
    db_url = os.environ.get("RTGAIA_TEST_DB_URL", "")
    if not db_url:
        pytest.skip("RTGAIA_TEST_DB_URL 未設")
    from rtgaia_server.db.migrate import downgrade_base, upgrade_to_head

    monkeypatch.setenv("RTGAIA_DATA_DIR", str(tmp_path / "data"))
    downgrade_base(db_url)
    upgrade_to_head(db_url)
    with Session(library_root=str(synth.root), db_url=db_url) as admin:
        admin.bootstrap("boss", "disk-watcher-Passw0rd")
        admin._post(
            "/api/v1/auth/users",
            {"username": "viewer1", "password": "look-only-Passw0rd", "role": "viewer", "must_change_password": False},
        )
        assert "path" in admin._get("/api/v1/storage/status")["volumes"][0]
        assert admin._post("/api/v1/storage/integrity/run", {"batch": 3})["checked"] == 3
        v = Session(client=admin._client)
        v._headers = {}
        v.login("viewer1", "look-only-Passw0rd")
        st = v._get("/api/v1/storage/status")
        assert st["volumes"] and "path" not in st["volumes"][0] and "percent" in st["volumes"][0]
        r = v._client.get("/api/v1/storage/integrity", headers=v._headers)
        assert r.status_code == 403
        r = v._client.post("/api/v1/storage/integrity/run", json={}, headers=v._headers)
        assert r.status_code == 403
