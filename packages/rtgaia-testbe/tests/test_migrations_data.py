"""資料遷移：在舊版 schema 放進有代表性的資料，升級到最新，檢查資料被正確轉換。需要 `RTGAIA_TEST_DB_URL`。"""

from __future__ import annotations

import asyncio
import os

import pytest
from alembic import command
from rtgaia_server.db.migrate import alembic_config, downgrade_base, upgrade_to_head

pytestmark = pytest.mark.db
DB_URL = os.environ.get("RTGAIA_TEST_DB_URL", "")


@pytest.fixture
def db_url() -> str:
    if not DB_URL:
        pytest.skip("RTGAIA_TEST_DB_URL 未設")
    downgrade_base(DB_URL)
    return DB_URL


def _sql(db_url: str, statements: list[tuple[str, dict]]) -> list[list[tuple]]:
    from sqlalchemy import text
    from sqlalchemy.ext.asyncio import create_async_engine

    async def main() -> list[list[tuple]]:
        engine = create_async_engine(db_url)
        out = []
        async with engine.begin() as conn:
            for sql, params in statements:
                result = await conn.execute(text(sql), params)
                out.append([tuple(r) for r in result.all()] if result.returns_rows else [])
        await engine.dispose()
        return out

    return asyncio.run(main())


_STRUCTURE = (
    "INSERT INTO structure (case_id, structure_id, frame_key, name, color_rgb, frame_of_reference_uid, status, "
    "default_visible, head_version_id, created_by, updated_by, updated_at) VALUES "
    "('c1', :s, -1, :name, '[1, 2, 3]', '1.2.3', 'edited', true, :head, 'u', 'u', '2026-01-01T00:00:00+00:00')"
)
_VERSION = (
    "INSERT INTO structure_version (version_id, case_id, structure_id, frame_key, seq, parent_version_id, kind, "
    "content_hash, offset_ijk, size_ijk, voxel_count, provenance, created_by, created_at, client_id, client_seq, note) "
    "VALUES (:v, 'c1', :s, -1, :seq, :parent, 'edit', 'h', '[0, 0, 0]', '[1, 1, 1]', 1, '{}', 'u', :at, NULL, NULL, '')"
)


def _version(s: str, v: str, seq: int, parent: str | None, at: str = "2026-01-01T00:00:00+00:00") -> tuple[str, dict]:
    return _VERSION, {"s": s, "v": v, "seq": seq, "parent": parent, "at": at}


def test_version_seq_is_renumbered_along_the_parent_chain(db_url: str) -> None:
    """0024：滿 200 版後的版本以前都記成 199。升級後沿父版本鏈從 head 往回編號，並且 (結構, 序號) 唯一。"""
    command.upgrade(alembic_config(db_url), "0023_job_lease")
    _sql(
        db_url,
        [
            (
                "INSERT INTO rt_case (case_id, study_id, source, selection_hash, selection, description, created_by, "
                "created_at, updated_at) VALUES ('c1', 'st', '', 'h1', '{}', '', 'u', '2026-01-01', '2026-01-01')",
                {},
            ),
            # 線性鏈 a ← b ← c ← d ← e，c／d／e 都記成 199，而且故意不照順序寫入
            (_STRUCTURE, {"s": "linear", "name": "linear", "head": "e"}),
            _version("linear", "e", 199, "d"),
            _version("linear", "a", 0, None),
            _version("linear", "c", 199, "b"),
            _version("linear", "b", 1, "a"),
            _version("linear", "d", 199, "c"),
            # 已經出過事的：head 指到中間的 x（它後面還有 y），內容以 head 為準、不改；編號從最新的末端往回
            (_STRUCTURE, {"s": "forked", "name": "forked", "head": "x"}),
            _version("forked", "w", 0, None),
            _version("forked", "x", 199, "w"),
            _version("forked", "y", 199, "x", at="2026-01-02T00:00:00+00:00"),
        ],
    )
    upgrade_to_head(db_url)
    (rows, heads) = _sql(
        db_url,
        [
            ("SELECT structure_id, version_id, seq FROM structure_version ORDER BY structure_id, seq", {}),
            ("SELECT structure_id, head_version_id FROM structure ORDER BY structure_id", {}),
        ],
    )
    order = {sid: [v for s, v, _ in rows if s == sid] for sid in ("linear", "forked")}
    assert order["linear"] == ["a", "b", "c", "d", "e"]
    assert [seq for s, _, seq in rows if s == "linear"] == [0, 1, 2, 3, 4]
    assert order["forked"] == ["w", "x", "y"]
    assert heads == [("forked", "x"), ("linear", "e")]
    with pytest.raises(Exception, match="ix_structure_version_structure|unique|duplicate"):
        _sql(db_url, [_version("linear", "f", 4, "e")])
