"""PatientName 不以明文持久化；搜尋只比 PatientID；show-names 當下從檔案讀。"""

from __future__ import annotations

import json
import os
from pathlib import Path

import pytest
from rtgaia_core.library import Catalog, LibraryIndex
from rtgaia_core.library.scan import InstanceHeader
from rtgaia_core.phi import hash_patient_name, is_patient_name_hash, normalize_person_name
from synth_dicom import SynthCase, write_synth_case

DB_URL = os.environ.get("RTGAIA_TEST_DB_URL", "")
NAME = "Synthetic^Case"


@pytest.fixture(scope="module")
def synth(tmp_path_factory) -> SynthCase:  # type: ignore[no-untyped-def]
    return write_synth_case(tmp_path_factory.mktemp("synth"))


def test_hash_rules(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("RTGAIA_PHI_KEY", raising=False)
    monkeypatch.setenv("RTGAIA_SECRET", "s1")
    h = hash_patient_name(NAME)
    assert is_patient_name_hash(h) and NAME.lower() not in h
    assert hash_patient_name("  synthetic^case^^ ") == h  # 正規化
    assert normalize_person_name("doe^john^^=") == "DOE^JOHN"
    assert hash_patient_name(h) == h  # 已是雜湊不會再雜湊
    assert hash_patient_name("") == "" and hash_patient_name(None) == ""
    monkeypatch.setenv("RTGAIA_PHI_KEY", "other")
    assert hash_patient_name(NAME) != h  # 鍵不同 → 雜湊不同


def test_legacy_header_is_converted_on_load() -> None:
    raw = {
        "path": "/x.dcm", "mtime_ns": 1, "size": 1, "sop_instance_uid": "1", "sop_class_uid": "1", "modality": "CT",
        "series_instance_uid": "2", "study_instance_uid": "3", "frame_of_reference_uid": "4", "patient_id": "P1",
        "patient_name": NAME, "study_date": "", "study_description": "", "series_date": "", "series_time": "",
        "series_description": "", "series_number": "", "instance_number": 1, "manufacturer": "",
        "manufacturer_model_name": "",
    }  # fmt: skip
    h = InstanceHeader.from_json(raw)
    assert is_patient_name_hash(h.patient_name_hash)
    assert NAME not in json.dumps(h.to_json()) and 'patient_name"' not in json.dumps(h.to_json())


def test_index_cache_has_no_plaintext_and_search_is_id_only(synth: SynthCase, tmp_path: Path) -> None:
    cache = tmp_path / "cache"
    index = LibraryIndex.scan(synth.root, cache_dir=cache)
    text = "".join(p.read_text(encoding="utf-8") for p in cache.rglob("*.json"))
    assert NAME not in text and "pnh1:" in text  # 描述裡本來就有 "Synthetic pelvis"，只驗名字本身
    # show_names：當下從檔案讀
    assert index.tree(show_names=True)["patients"][0]["patient_name"] == NAME
    assert index.patients(show_names=True)[0]["patient_name"] == NAME
    assert "patient_name" not in index.patients(show_names=False)[0]
    # 搜尋只比 PatientID：名字搜不到，ID 搜得到（show_names 開著也一樣）
    assert index.patients("synthetic^case", show_names=True) == []
    assert index.patients("SYNTH", show_names=True)[0]["patient_id"] == "SYNTH-0001"
    cat = Catalog(index, show_names=True)
    assert cat._free_text("synthetic^case") == set()  # 只會出現在名字裡的字串


@pytest.mark.db
def test_db_stores_hash_only_and_migration_converts_legacy(synth: SynthCase, tmp_path: Path, monkeypatch) -> None:  # type: ignore[no-untyped-def]
    if not DB_URL:
        pytest.skip("RTGAIA_TEST_DB_URL 未設")
    import asyncio

    import asyncpg
    from rtgaia_server.db import CatalogStore
    from rtgaia_server.db.migrate import downgrade_base, upgrade_to_head

    monkeypatch.setenv("RTGAIA_DATA_DIR", str(tmp_path / "data"))
    downgrade_base(DB_URL)
    upgrade_to_head(DB_URL)
    pg = DB_URL.replace("postgresql+asyncpg", "postgresql")

    async def persist() -> None:
        store = CatalogStore(DB_URL)
        await store.replace_headers(synth.root, LibraryIndex.scan(synth.root, cache_dir=tmp_path / "c").headers)
        await store.dispose()

    asyncio.run(persist())

    async def check() -> tuple[list, list]:
        c = await asyncpg.connect(pg)
        pats = await c.fetch("SELECT patient_id, patient_name_hash FROM patient")
        heads = await c.fetch("SELECT header::text AS h FROM instance")
        await c.close()
        return pats, heads

    pats, heads = asyncio.run(check())
    assert pats and all(is_patient_name_hash(r["patient_name_hash"]) for r in pats)
    assert heads and not any(NAME in r["h"] or '"patient_name"' in r["h"] for r in heads)
    # migration：退回 0014、塞明文、再升級 → 明文消失、變成雜湊
    from alembic import command
    from rtgaia_server.db.migrate import alembic_config

    command.downgrade(alembic_config(DB_URL), "0014_structure_set_description")

    async def plant() -> None:
        c = await asyncpg.connect(pg)
        await c.execute("UPDATE patient SET patient_name = $1", NAME)
        await c.execute("UPDATE instance SET header = header || jsonb_build_object('patient_name', $1::text)", NAME)
        await c.close()

    asyncio.run(plant())
    upgrade_to_head(DB_URL)
    pats, heads = asyncio.run(check())
    assert all(r["patient_name_hash"] == hash_patient_name(NAME) for r in pats)
    assert not any(NAME in r["h"] or '"patient_name"' in r["h"] for r in heads)
