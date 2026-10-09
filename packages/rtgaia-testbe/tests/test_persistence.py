"""病例工作狀態持久化：編輯、版本、簽核、量測、transform 寫進 Postgres ＋ blob store，
新的行程（新 app、同 DB、同 blob 目錄）以同一組選取重開病例，一切都在。需要 `RTGAIA_TEST_DB_URL`；沒設就 skip。
"""

from __future__ import annotations

import os
from pathlib import Path

import numpy as np
import pytest
from rtgaia_core.blobs import FsBlobStore
from rtgaia_server.db.migrate import downgrade_base, upgrade_to_head
from rtgaia_testbe import Session
from synth_dicom import SynthCase, write_synth_case

pytestmark = pytest.mark.db
DB_URL = os.environ.get("RTGAIA_TEST_DB_URL", "")


@pytest.fixture(scope="module")
def synth(tmp_path_factory) -> SynthCase:
    return write_synth_case(tmp_path_factory.mktemp("synth"))


@pytest.fixture
def db_url(monkeypatch, tmp_path: Path) -> str:  # type: ignore[no-untyped-def]
    if not DB_URL:
        pytest.skip("RTGAIA_TEST_DB_URL 未設")
    monkeypatch.setenv("RTGAIA_DATA_DIR", str(tmp_path / "data"))  # blobs 落在暫存目錄
    downgrade_base(DB_URL)
    upgrade_to_head(DB_URL)
    return DB_URL


def _selection(synth: SynthCase) -> dict:
    return {
        "primary_series_uid": synth.plan_ct.series_uid,
        "image_series_uids": [synth.plan_ct.series_uid, synth.cbct.series_uid],
        "structure_set_uids": [synth.plan_rs_uid, synth.cbct_rs_uid],
        "dose_uids": [synth.plan_dose_uid],
        "registration_uids": [synth.reg_uid],
        "plan_uids": [synth.plan_uid],
    }


def test_blob_store_roundtrip_and_dedupe(tmp_path: Path) -> None:
    store = FsBlobStore(tmp_path / "blobs")
    data = bytes(range(256)) * 100
    k1 = store.put(data)
    k2 = store.put(data)
    assert k1 == k2 and store.exists(k1) and store.get(k1) == data
    assert store.put(b"x", key="mh_custom") == "mh_custom" and store.get("mh_custom") == b"x"
    assert store.stats()["files"] == 2 and store.path(k1).suffix == ".zst"
    assert store.delete(k1) and not store.exists(k1) and not store.delete(k1)
    with pytest.raises(KeyError):
        store.get(k1)
    with pytest.raises(ValueError):
        store.put(b"y", key="../evil")


def test_edits_survive_a_new_process(db_url: str, synth: SynthCase, tmp_path: Path) -> None:
    # 第一個「行程」
    with Session(library_root=str(synth.root), db_url=db_url, auth="off", user="dr.a") as s:
        first = s.load_case(_selection(synth))
        assert first["case_reused"] is False
        sids = [st["structure_id"] for st in s.structures()]
        sid = s.claim(sids[0])  # 匯入集唯讀，先合併進自己的工作集
        h0 = s.versions(sid)["content_hash"]
        s.edit(sid, offset_ijk=(0, 0, 0), array=np.ones((2, 2, 2), dtype=np.uint8), client_seq=1)
        s.postprocess(sid, "fill_holes", per_slice=True)
        s.review({sid: "approved"}, note="第一輪")
        s.create_measurement(
            {
                "kind": "distance",
                "points": [0, 0, 0, 10, 0, 0],
                "frameOfReferenceUid": synth.plan_ct.frame_of_reference_uid,
                "label": "d1",
            }
        )
        s.create_transform(
            fixed_series_id=synth.plan_ct.series_uid,
            moving_series_id=synth.cbct.series_uid,
            matrix_column_major=[float(v) for v in np.eye(4).T.ravel()],
        )
        removed = s.create_structure("tmp", color_rgb=[1, 2, 3])["structure_id"]  # 只能刪自己工作集的
        s.delete_structure(removed)
        head_before = s.mask(sid)[0]["content_hash"]
        versions_before = s.versions(sid)["versions"]
        health = s.health()["catalog_db"]
        assert health["case_counts"]["cases"] == 1 and health["case_counts"]["versions"] >= len(versions_before)
        blobs = FsBlobStore()
        assert blobs.exists(h0) and blobs.exists(head_before), "每一版的體素都在 blob store"

    # 第二個「行程」：新 app、同 DB、同 blob 目錄；記憶體是空的
    with Session(library_root=str(synth.root), db_url=db_url, auth="off", user="dr.b") as s2:
        listed = s2._get("/api/v1/cases")
        assert len(listed) == 1 and listed[0]["case_id"] == first["case_id"] and listed[0]["in_memory"] is False
        second = s2.load_case(_selection(synth))
        assert second["case_reused"] is True and second["case_id"] == first["case_id"]
        assert second["session_id"] != first["session_id"]
        # 結構：被刪的不在；編輯過的 head 相同；版本鏈完整且體素逐位元組相同
        ids = [st["structure_id"] for st in s2.structures()]
        assert removed not in ids and sid in ids
        assert s2.mask(sid)[0]["content_hash"] == head_before
        v = s2.versions(sid)
        assert [x["version_id"] for x in v["versions"]] == [x["version_id"] for x in versions_before]
        assert [x["kind"] for x in v["versions"]] == ["merge", "edit", "post-process"]
        assert v["versions"][1]["created_by"] == "dr.a"
        header, raw = s2.version_mask(sid, v["versions"][0]["version_id"])
        assert header["content_hash"] == h0
        # 已簽核的結構唯讀：要先 reopen 才能 revert；revert 的體素從 blob 來
        with pytest.raises(RuntimeError, match="APPROVED_LOCKED"):
            s2.revert(sid, v["versions"][0]["version_id"])
        s2.review({sid: "under_review"}, note="reopen")
        out = s2.revert(sid, v["versions"][0]["version_id"])
        assert out["content_hash"] == h0
        # 簽核事件、量測、transform
        case = s2._get(f"/api/v1/cases/{first['case_id']}")
        assert [e["to_status"] for e in case["review_notes"]][:2] == ["approved", "deleted"]
        assert case["review_notes"][0]["user"] == "dr.a"
        assert [m["label"] for m in case["measurements"].values()] == ["d1"]
        assert len(case["transforms"]) == 1
        assert {st["structure_id"]: st["status"] for st in case["structures"]}[sid] == "edited"  # revert 後
        # 第二個行程的變更也寫回：第三個行程看得到 revert 那一版
    with Session(library_root=str(synth.root), db_url=db_url, auth="off") as s3:
        s3.load_case(_selection(synth))
        assert s3.versions(sid)["versions"][-1]["kind"] == "revert"
        # 不同選取 → 新 case；DB 裡兩個
        s3.load_case(dict(_selection(synth), registration_uids=[]))
        assert len(s3._get("/api/v1/cases")) == 2


def test_get_case_loads_from_db_without_session(db_url: str, synth: SynthCase) -> None:
    with Session(library_root=str(synth.root), db_url=db_url, auth="off") as s:
        first = s.load_case(_selection(synth))
    with Session(library_root=str(synth.root), db_url=db_url, auth="off") as s2:
        case = s2._get(f"/api/v1/cases/{first['case_id']}")
        assert case["case_id"] == first["case_id"] and case["sessions"] == 0 and case["structures"]
        with pytest.raises(RuntimeError, match="404"):
            s2._get("/api/v1/cases/case_nope")


def test_phantom_cases_are_not_persisted(db_url: str) -> None:
    with Session(db_url=db_url, auth="off", library_root="") as s:
        s.load("phantom:axial_clean")
        sid = s.structures()[0]["structure_id"]
        s.edit(sid, offset_ijk=(0, 0, 0), array=np.ones((2, 2, 2), dtype=np.uint8), client_seq=1)
        assert s.health()["catalog_db"].get("case_counts") in (
            None,
            {"cases": 0, "structures": 0, "versions": 0, "review_events": 0},
        )


# ── 交易回滾後版本／簽核事件仍可重試 ─────────────────────────────


def _db_counts_for_case(db_url: str, case_id: str) -> dict[str, int]:
    """直接查 DB（不是記憶體、不是快取）：這個病例的版本數、事件數、結構狀態。"""
    import asyncio

    from sqlalchemy import text
    from sqlalchemy.ext.asyncio import create_async_engine

    async def main() -> dict[str, int]:
        engine = create_async_engine(db_url)
        async with engine.connect() as conn:
            q_v = text("SELECT count(*) FROM structure_version WHERE case_id = :c")
            q_e = text("SELECT count(*) FROM review_event WHERE case_id = :c")
            v = (await conn.execute(q_v, {"c": case_id})).scalar()
            e = (await conn.execute(q_e, {"c": case_id})).scalar()
            a = (
                await conn.execute(
                    text("SELECT count(*) FROM structure WHERE case_id = :c AND status = 'approved'"), {"c": case_id}
                )
            ).scalar()
        await engine.dispose()
        return {"versions": int(v or 0), "events": int(e or 0), "approved": int(a or 0)}

    return asyncio.run(main())


class _FailOnce:
    """把 `CaseStore._persist_tx` 包起來：armed 時先讓交易本體跑完（所有 SQL 都送出了），再丟例外 →
    整個交易回滾。這正是重現出來的形狀：「後段失敗、DB 回滾、快取沒回滾」。"""

    def __init__(self, monkeypatch, where: str) -> None:  # type: ignore[no-untyped-def]
        from rtgaia_server.db.cases import CaseStore

        self.armed = False
        self.fired = 0
        original = CaseStore._persist_tx
        fail = self

        async def wrapped(self_store, s, case, created_by, new_v_ids, new_e_ids):  # type: ignore[no-untyped-def]
            out = await original(self_store, s, case, created_by, new_v_ids, new_e_ids)
            if fail.armed:
                fail.armed = False
                fail.fired += 1
                if where == "commit":
                    # 模擬 commit 階段失敗：`async with s.begin()` 出區塊 → greenlet 裡跑**同步** SessionTransaction
                    # 的 `__exit__` → `commit()`；patch 同步那個，只炸一次，並確保回滾
                    from sqlalchemy.orm.session import SessionTransaction

                    real_commit = SessionTransaction.commit

                    def bad_commit(self_tx, *args, **kwargs):  # type: ignore[no-untyped-def]
                        monkeypatch.setattr(SessionTransaction, "commit", real_commit)
                        self_tx.rollback()
                        raise RuntimeError("injected commit failure")

                    monkeypatch.setattr(SessionTransaction, "commit", bad_commit)
                    return out
                raise RuntimeError("injected failure after all statements")
            return out

        monkeypatch.setattr(CaseStore, "_persist_tx", wrapped)


@pytest.mark.parametrize("where", ["statements", "commit"])
def test_persist_rollback_then_retry_writes_versions_and_events(
    db_url: str, synth: SynthCase, monkeypatch, where: str
) -> None:  # type: ignore[no-untyped-def]
    """重現：注入一次例外後重試，回報 versions=0、events=0，DB 各 0 筆。
    現在：失敗那次什麼都沒寫（回滾），重試把版本與事件都補上，DB 數字與記憶體一致。"""
    fail = _FailOnce(monkeypatch, where)
    with Session(library_root=str(synth.root), db_url=db_url, auth="off", user="dr.a") as s:
        opened = s.load_case(_selection(synth))
        case_id = opened["case_id"]
        sid = s.claim(s.structures()[0]["structure_id"])
        base = _db_counts_for_case(db_url, case_id)
        assert base["versions"] >= 1 and base["events"] == 0

        # 這一筆會新增一個版本；持久化在 push_case 裡 —— 讓它失敗
        fail.armed = True
        with pytest.raises(Exception, match="injected"):
            s.edit(sid, offset_ijk=(0, 0, 0), array=np.ones((2, 2, 2), dtype=np.uint8), client_seq=1)
        assert fail.fired == 1
        after_fail = _db_counts_for_case(db_url, case_id)
        assert after_fail == base, "失敗的交易不得留下任何一列"
        # 記憶體裡那一版存在（編輯本身成功了，是持久化失敗）
        mem_versions = s.versions(sid)["versions"]
        assert len(mem_versions) == 2

        # 重試：任何一個會持久化的寫入（簽核 → 新事件 ＋ 狀態）
        out = s.review({sid: "approved"}, note="重試")
        assert out["events"][0]["to_status"] == "approved"
        after_retry = _db_counts_for_case(db_url, case_id)
        assert after_retry["versions"] == base["versions"] + 1, "失敗那次的版本要在重試時補上"
        assert after_retry["events"] == 1
        assert after_retry["approved"] == 1

    # 重啟（新行程）：版本鏈與簽核狀態從 DB 回來、parent 串接正確
    with Session(library_root=str(synth.root), db_url=db_url, auth="off", user="dr.b") as s2:
        s2.load_case(_selection(synth))
        v = s2.versions(sid)["versions"]
        assert [x["version_id"] for x in v] == [x["version_id"] for x in mem_versions]
        assert v[1]["parent_version_id"] == v[0]["version_id"]
        assert {st["structure_id"]: st["status"] for st in s2.structures()}[sid] == "approved"


def test_persist_is_idempotent_and_reports_actual_rows(db_url: str, synth: SynthCase) -> None:
    """連續持久化兩次 → 第二次沒有新列；計數反映 DB 真相（rowcount），不是迴圈累加。"""
    with Session(library_root=str(synth.root), db_url=db_url, auth="off", user="dr.a") as s:
        opened = s.load_case(_selection(synth))
        case_id = opened["case_id"]
        sid = s.claim(s.structures()[0]["structure_id"])
        s.edit(sid, offset_ijk=(0, 0, 0), array=np.ones((2, 2, 2), dtype=np.uint8), client_seq=1)
        first = _db_counts_for_case(db_url, case_id)
        # 不改內容的寫入（顏色）→ 再持久化一次
        s.update_structure(sid, color_rgb=[9, 9, 9])
        again = _db_counts_for_case(db_url, case_id)
        assert again["versions"] == first["versions"] and again["events"] == first["events"]

        # 快取被丟掉（模擬另一個行程／重啟後的第一次 persist）也不會 UniqueViolation：ON CONFLICT DO NOTHING
        store = s._app.state.rtgaia.case_store
        assert store is not None
        store._persisted_versions.clear()
        store._persisted_events.clear()
        s.update_structure(sid, color_rgb=[8, 8, 8])
        assert _db_counts_for_case(db_url, case_id)["versions"] == first["versions"]


def _db_rows(db_url: str, sql: str, params: dict) -> list[tuple]:
    import asyncio

    from sqlalchemy import text
    from sqlalchemy.ext.asyncio import create_async_engine

    async def main() -> list[tuple]:
        engine = create_async_engine(db_url)
        async with engine.connect() as conn:
            rows = [tuple(r) for r in (await conn.execute(text(sql), params)).all()]
        await engine.dispose()
        return rows

    return asyncio.run(main())


def test_version_order_survives_more_versions_than_memory_keeps(db_url: str, synth: SynthCase) -> None:
    """滿 200 版後新版在 DB 的序號都是 199，重新載入時排序不定 ——
    舊版排到最後就成了 head，下一次寫回連 DB 的 head 都換掉。現在序號一路遞增、(結構, 序號) 唯一。"""
    from rtgaia_core.structure_state import MAX_VERSIONS_IN_MEMORY

    edits = MAX_VERSIONS_IN_MEMORY + 5
    with Session(library_root=str(synth.root), db_url=db_url, auth="off", user="dr.a") as s:
        opened = s.load_case(_selection(synth))
        sid = s.claim(s.structures()[0]["structure_id"])
        content = s.versions(sid)["content_hash"]
        for n in range(edits):
            block = np.full((2, 2, 2), n % 2, dtype=np.uint8)
            out = s.edit(sid, offset_ijk=(0, 0, 0), array=block, base_content_hash=content, client_seq=n + 1)
            content = out["content_hash"]
        head = s.versions(sid)["head_version_id"]
    rows = _db_rows(
        db_url,
        "SELECT version_id, seq FROM structure_version WHERE case_id = :c AND structure_id = :s ORDER BY seq",
        {"c": opened["case_id"], "s": sid},
    )
    seqs = [seq for _, seq in rows]
    assert len(rows) == edits + 1 and seqs == list(range(edits + 1)), seqs[-8:]
    assert rows[-1][0] == head
    with Session(library_root=str(synth.root), db_url=db_url, auth="off", user="dr.b") as s2:
        s2.load_case(_selection(synth))
        reloaded = s2.versions(sid)
        assert reloaded["head_version_id"] == head and reloaded["content_hash"] == content
        assert reloaded["versions"][-1]["version_id"] == head
        s2.update_structure(sid, name="renamed after reload")  # 寫回一次：head 不能被換掉
    assert _db_rows(
        db_url,
        "SELECT head_version_id FROM structure WHERE case_id = :c AND structure_id = :s",
        {"c": opened["case_id"], "s": sid},
    ) == [(head,)]


def test_overlong_ids_cannot_poison_a_case(db_url: str, synth: SynthCase) -> None:
    """病例寫回 DB 是整份快照 —— 一個超過欄寬的值（structure_id 128、measurementId 64、
    client_id 64、帳號 64）進了病例，之後這個病例的每一次寫回都失敗，改的東西都存不進去。
    使用者給的值在入口擋（422／400）；程式組出來的（複製、合併、用名稱組的）截斷加雜湊。"""
    long = "x" * 200
    with Session(library_root=str(synth.root), db_url=db_url, auth="off", user="dr.a") as s:
        s.load_case(_selection(synth))
        post = lambda path, body: s._client.post(path, json=body, headers=s._headers)  # noqa: E731
        structures = f"/api/v1/studies/{s.study_id}/structures"
        assert post(structures, {"name": "A", "structure_id": long}).status_code == 422
        assert post(structures, {"name": "A", "structure_id": "bad/id"}).status_code == 422
        measurement = {
            "measurementId": long,
            "kind": "distance",
            "points": [0, 0, 0, 5, 0, 0],
            "frameOfReferenceUid": synth.plan_ct.frame_of_reference_uid,
        }
        assert post(f"/api/v1/measurements?study_id={s.study_id}", measurement).status_code == 422
        too_long_user = s._client.get(structures, headers={**s._headers, "X-RTGaia-User": long})
        assert too_long_user.status_code == 400 and too_long_user.json()["code"] == "BAD_USER"

        edge = "y" * 128  # 剛好放得下
        s.create_structure("Long", structure_id=edge)
        header, _ = s.mask(edge)
        edit = {
            "mask_grid_id": s.mask_grid_id,
            "base_content_hash": header["content_hash"],
            "client_seq": 1,
            "client_id": long,
            "offset_ijk": [0, 0, 0],
            "size_ijk": [1, 1, 1],
            "data": "AQ==",
            "view_reference": s.view_reference(),
        }
        assert post(f"/api/v1/structures/{edge}/edit", edit).status_code == 422
        copied = s.copy_structure(edge)["structure_id"]  # 預設 id ＝ `<id>_copy1`，原本 134 字
        assert len(copied) <= 128 and copied != edge
        s.update_structure(copied, name="still saved")
    with Session(library_root=str(synth.root), db_url=db_url, auth="off", user="dr.b") as s2:
        s2.load_case(_selection(synth))
        names = {e["structure_id"]: e["name"] for e in s2.structures()}
        assert names[copied] == "still saved" and edge in names
