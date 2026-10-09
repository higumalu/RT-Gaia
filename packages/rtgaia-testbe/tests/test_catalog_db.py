"""目錄進 Postgres。

需要 `RTGAIA_TEST_DB_URL`（`./scripts/dev-db.sh` 會印出來；CI 用 service）。沒設就 **skip**，
不會靜默通過。每個測試前把 schema 降到 base 再升到 head —— 遷移的 down 也因此被跑到。

驗的是：
* 同一套 `/catalog/*` 在 DB 模式回一樣的東西（與記憶體模式逐一比對）
* 重啟行程後目錄從 DB 載入，**不掃檔案系統**
* 匯入完成後新檔進了 DB，另一個行程看得到
* rescan 以 DB 裡的 mtime＋size 當 previous（沒變的檔不重讀）
"""

from __future__ import annotations

import asyncio
import os
import shutil
from pathlib import Path

import pytest
from rtgaia_server.db import CatalogStore, upgrade_to_head
from rtgaia_server.db.migrate import downgrade_base
from rtgaia_testbe import Session
from synth_dicom import SynthCase, write_synth_case

pytestmark = pytest.mark.db

DB_URL = os.environ.get("RTGAIA_TEST_DB_URL", "")


@pytest.fixture(scope="module")
def synth(tmp_path_factory) -> SynthCase:
    return write_synth_case(tmp_path_factory.mktemp("synth"))


@pytest.fixture
def db_url() -> str:
    if not DB_URL:
        pytest.skip("RTGAIA_TEST_DB_URL 未設（./scripts/dev-db.sh 會印出來）")
    downgrade_base(DB_URL)
    upgrade_to_head(DB_URL)
    return DB_URL


def _strip_volatile(x):  # type: ignore[no-untyped-def]
    """`directory` 與 `scanned_at` 兩邊本來就會不同。"""
    if isinstance(x, dict):
        return {k: _strip_volatile(v) for k, v in x.items() if k not in ("directory", "scanned_at", "root")}
    if isinstance(x, list):
        return [_strip_volatile(v) for v in x]
    return x


def test_db_mode_serves_same_catalog_as_memory_mode(db_url: str, synth: SynthCase) -> None:
    with (
        Session(library_root=str(synth.root)) as mem,
        Session(library_root=str(synth.root), db_url=db_url, auth="off") as db,
    ):
        health = db.health()
        assert health["catalog_db"]["configured"] is True
        # 第一次查詢：DB 空 → 掃檔案系統寫進去
        for call in (
            lambda s: s.catalog_patients(),
            lambda s: s.catalog_studies("SYNTH-0001"),
            lambda s: s.catalog_series(synth.plan_ct.study_uid),
            lambda s: s.catalog_rt(synth.plan_ct.series_uid),
            lambda s: s.catalog_rt(synth.cbct.series_uid),
            lambda s: s.catalog_detail(synth.reg_uid),
            lambda s: s.catalog_search(q="synth-art1"),
            lambda s: s.library_series(modality="RTDOSE"),
        ):
            assert _strip_volatile(call(db)) == _strip_volatile(call(mem))
        counts = db.health()["catalog_db"]["counts"]
        assert counts == {"patients": 1, "studies": 1, "series": 8, "instances": 17}


def test_restart_loads_from_db_without_touching_files(db_url: str, synth: SynthCase, tmp_path: Path) -> None:
    root = tmp_path / "lib"
    shutil.copytree(synth.root, root)
    with Session(library_root=str(root), db_url=db_url, auth="off") as s:
        assert s.catalog_patients()["total"] == 1
    # 把檔案系統的檔全部拿走：下一個行程應該仍從 DB 看到目錄（真相在 DB；檔案只在下載／載入時才需要）
    shutil.rmtree(root)
    root.mkdir()
    with Session(library_root=str(root), db_url=db_url, auth="off") as s2:
        assert s2.catalog_patients()["total"] == 1
        assert s2.catalog_series(synth.plan_ct.study_uid)["images"]
        # 明確 rescan 才會發現檔案不在了
        assert s2.rescan_library()["series_count"] == 0
        assert s2.catalog_patients()["total"] == 0


def test_import_writes_db_and_second_process_sees_it(db_url: str, synth: SynthCase, tmp_path: Path) -> None:
    root = tmp_path / "lib"
    root.mkdir()
    ct_files = sorted(p for p in synth.plan_ct.directory.iterdir() if p.is_file())
    with Session(library_root=str(root), db_url=db_url, auth="off") as s:
        assert s.catalog_patients()["total"] == 0
        bid = s.import_open()["batch_id"]
        for p in ct_files:
            s.import_put(bid, p.name, p.read_bytes())
        s.import_complete(bid)
        done = s.wait_import(bid)
        assert done["status"] == "done" and done["counts"]["accepted"] == len(ct_files)
        assert s.catalog_patients()["total"] == 1
        assert s.health()["catalog_db"]["counts"]["instances"] == len(ct_files)
    # 第二個「行程」（另一個 app）不掃檔案就看到
    with Session(library_root=str(root), db_url=db_url, auth="off") as s2:
        assert s2.catalog_patients()["total"] == 1
        assert s2.catalog_series(synth.plan_ct.study_uid)["images"][0]["instance_count"] == len(ct_files)


def test_rescan_uses_db_headers_as_previous(db_url: str, synth: SynthCase, tmp_path: Path) -> None:
    root = tmp_path / "lib"
    shutil.copytree(synth.root, root)
    with Session(library_root=str(root), db_url=db_url, auth="off") as s:
        s.catalog_patients()
        store = CatalogStore(db_url)
        prev = asyncio.run(store.previous_map())
        asyncio.run(store.dispose())
        assert len(prev) == 17 and all(Path(p).is_relative_to(root) for p in prev)
        # 加一個新檔（複製一張 CT 到別的名字 → 同 SOP 兩個路徑，舊版型允許）→ rescan 後 18 個 instance
        src = next(root.rglob("*.dcm"))
        shutil.copy(src, src.with_name("copy_of_" + src.name))
        s.rescan_library()
        assert s.health()["catalog_db"]["counts"]["instances"] == 18
