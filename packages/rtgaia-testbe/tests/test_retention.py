"""保留政策：資料庫裡的全部保留；刪除 → 暫存區（14 天後自動清除或手動清除）；
已簽核的被刪 → 封存區（只有管理者能看／改／刪）；資料頁移除的 DICOM 也進暫存區。"""

from __future__ import annotations

import json
import os
from datetime import UTC, datetime, timedelta
from pathlib import Path

import numpy as np
import pytest
from rtgaia_core import retention
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


def _new(s: Session, name: str, set_id: str | None = None, value: int = 1) -> dict:
    made = s._post(
        f"/api/v1/studies/{s.study_id}/structures",
        {"name": name, "color_rgb": [1, 2, 3], **({"structure_set_id": set_id} if set_id else {})},
    )
    s.edit(made["structure_id"], offset_ijk=(0, 0, 0), array=np.full((2, 2, 2), value, dtype=np.uint8))
    return made


def _get(s: Session, path: str) -> dict:
    return s._unwrap(s._client.get(path, headers=s._headers))


def _delete(s: Session, path: str) -> dict:
    return s._unwrap(s._client.delete(path, headers=s._headers))


def test_expiry_math() -> None:
    now = datetime(2026, 9, 24, 12, 0, tzinfo=UTC)
    assert retention.cutoff_iso(now, 14) == "2026-09-10T12:00:00+00:00"
    assert retention.expires_at("2026-09-24T12:00:00+00:00", 14) == "2026-10-08T12:00:00+00:00"
    assert retention.expires_at(None) is None


def test_library_trash_list_restore_purge_expire(tmp_path: Path) -> None:
    from rtgaia_core.library.trash import move_to_trash

    root = tmp_path / "lib"
    (root / "p1").mkdir(parents=True)
    f1 = root / "p1" / "a.dcm"
    f1.write_bytes(b"x")
    out = move_to_trash(root, [f1], level="series", key="1.2.3", series_uids=["1.2.3"], who="admin")
    items = retention.library_trash_items(root)
    assert len(items) == 1 and items[0]["file_count"] == 1 and items[0]["expires_at"]
    item_id = items[0]["item_id"]
    assert not f1.exists()
    r = retention.restore_library_item(root, item_id)
    assert r["restored"] == 1 and f1.exists() and retention.library_trash_items(root) == []
    # 再丟一次、手動清除
    move_to_trash(root, [f1], level="series", key="1.2.3", series_uids=["1.2.3"], who="admin")
    item_id = retention.library_trash_items(root)[0]["item_id"]
    assert retention.purge_library_item(root, item_id)["files"] >= 1 and retention.library_trash_items(root) == []
    # 過期自動清除：15 天後
    move_to_trash(root, [root / "p1"], level="patient", key="p1", series_uids=[], who="admin") if (
        root / "p1"
    ).exists() else None
    (root / "p2").mkdir()
    (root / "p2" / "b.dcm").write_bytes(b"y")
    move_to_trash(root, [root / "p2" / "b.dcm"], level="series", key="9", series_uids=["9"], who="admin")
    assert retention.purge_expired_library(root, now=datetime.now(UTC) + timedelta(days=13)) == []
    assert len(retention.purge_expired_library(root, now=datetime.now(UTC) + timedelta(days=15))) >= 1
    with pytest.raises(KeyError):
        retention.restore_library_item(root, "../../etc")
    assert out["moved"] == 1


def _trash_two(root: Path) -> None:
    from rtgaia_core.library.trash import move_to_trash

    for name in ("p1", "p2"):
        (root / name).mkdir(parents=True)
        f = root / name / "a.dcm"
        f.write_bytes(b"x")
        move_to_trash(root, [f], level="series", key=name, series_uids=[name], who="admin")


def test_retention_tick_audits_each_item_before_deleting_it(tmp_path: Path) -> None:
    """以前整批刪完才寫一筆稽核 —— 中途出錯時，已經永久刪掉的沒有紀錄。
    現在每一項先寫稽核（那時它還在），再刪；稽核寫不進去就不刪。"""
    import asyncio

    from rtgaia_core.api.deps import AppState, AuditUnavailable

    root = tmp_path / "lib"
    _trash_two(root)
    later = datetime.now(UTC) + timedelta(days=15)
    app = AppState()
    app.library_root = str(root)
    seen: list[tuple[str, str, bool]] = []

    async def audit(event: dict) -> None:
        present = event["object_id"] in [x["item_id"] for x in retention.library_trash_items(root)]
        seen.append((event["action"], event["object_type"], present))

    app.audit = audit  # type: ignore[method-assign]
    out = asyncio.run(retention.retention_tick(app, now=later))
    assert len(out["library"]) == 2 and retention.library_trash_items(root) == []
    assert seen == [("retention.purge", "library", True)] * 2

    _trash_two(tmp_path / "lib2")
    app.library_root = str(tmp_path / "lib2")

    async def down(event: dict) -> None:
        raise AuditUnavailable("稽核寫不進去（模擬）")

    app.audit = down  # type: ignore[method-assign]
    with pytest.raises(AuditUnavailable):
        asyncio.run(retention.retention_tick(app, now=later))
    assert len(retention.library_trash_items(tmp_path / "lib2")) == 2, "稽核寫不進去就不能刪"


def test_manual_library_purge_is_audited_before_deleting(tmp_path: Path) -> None:
    from rtgaia_core.api.deps import AuditUnavailable

    root = tmp_path / "lib"
    _trash_two(root)
    with Session(library_root=str(root)) as s:
        rt = s._app.state.rtgaia
        item_id = retention.library_trash_items(root)[0]["item_id"]

        async def down(event: dict) -> None:
            raise AuditUnavailable("稽核寫不進去（模擬）")

        real = rt.audit
        rt.audit = down
        try:  # 行程內的 TestClient 會把伺服器端的例外直接丟出來；真的伺服器回 5xx
            r = s._client.delete(f"/api/v1/trash/library/{item_id}", headers=s._headers)
            assert r.status_code >= 500
        except AuditUnavailable:
            pass
        assert item_id in [x["item_id"] for x in retention.library_trash_items(root)], "稽核寫不進去就不能刪"
        rt.audit = real
        assert s._client.delete(f"/api/v1/trash/library/{item_id}", headers=s._headers).status_code == 200
        assert item_id not in [x["item_id"] for x in retention.library_trash_items(root)]


@pytest.mark.db
def test_trash_and_archive_flow(synth: SynthCase, tmp_path: Path, monkeypatch) -> None:  # type: ignore[no-untyped-def]
    if not DB_URL:
        pytest.skip("RTGAIA_TEST_DB_URL 未設")
    from rtgaia_server.db.migrate import downgrade_base, upgrade_to_head

    monkeypatch.setenv("RTGAIA_DATA_DIR", str(tmp_path / "data"))
    downgrade_base(DB_URL)
    upgrade_to_head(DB_URL)
    with Session(library_root=str(synth.root), db_url=DB_URL, auth="off", user="dr") as dr:
        dr._headers["X-RTGaia-Role"] = "approver"
        dr.load_case(_selection(synth))
        plan_b = dr._post(f"/api/v1/cases/{dr.case_id}/structure-sets", {"label": "計畫 B"})["structure_set_id"]
        a = _new(dr, "GTV_trash", plan_b)
        b = _new(dr, "PTV_signed", plan_b, value=1)
        c = _new(dr, "OAR_setdel", plan_b)
        dr._post(
            f"/api/v1/studies/{dr.study_id}/review", {"structure_statuses": {b["structure_id"]: "approved"}, "note": ""}
        )
        # 1) 一般刪除 → 暫存區（帶刪除人、原集名、到期日）
        r = dr._client.delete(f"/api/v1/structures/{a['structure_id']}", headers=dr._headers)
        assert r.status_code == 204
        trash = _get(dr, "/api/v1/trash")
        assert trash["available"] is True and trash["days"] == 14
        it = next(x for x in trash["items"] if x["structure_id"] == a["structure_id"])
        assert (
            it["deleted_by"] == "dr" and it["set_label"] == "計畫 B" and it["expires_at"] and it["version_count"] >= 2
        )
        # 刪除後新建：id 不可重用暫存區裡的（否則寫回 DB 的 upsert 會蓋掉那筆已刪除的列；修改前會直接 409）
        fresh = _new(dr, "NEW_after_delete", plan_b)
        assert fresh["structure_id"] != a["structure_id"]
        again = next(x for x in _get(dr, "/api/v1/trash")["items"] if x["structure_id"] == a["structure_id"])
        assert again["name"] == "GTV_trash" and again["deleted_at"] == it["deleted_at"]
        # 2) 已簽核的刪除 → 封存區（不在暫存區）
        assert dr._client.delete(f"/api/v1/structures/{b['structure_id']}", headers=dr._headers).status_code == 204
        assert not any(x["structure_id"] == b["structure_id"] for x in _get(dr, "/api/v1/trash")["items"])
        # 非 admin 看不到封存區
        with pytest.raises(RuntimeError, match="403"):
            _get(dr, "/api/v1/archive")
        admin = Session(client=dr._client, user="boss")  # auth off 預設 admin
        admin.load_case(_selection(synth))
        arch = _get(admin, "/api/v1/archive")["items"]
        ai = next(x for x in arch if x["structure_id"] == b["structure_id"])
        assert ai["status"] == "approved" and ai["deleted_by"] == "dr"
        detail = _get(admin, f"/api/v1/archive/{dr.case_id}/{b['structure_id']}")
        assert detail["versions"] and any(e["to_status"] == "approved" for e in detail["review_events"])
        assert any(e["to_status"] == "deleted" for e in detail["review_events"])
        note = admin._unwrap(
            admin._client.patch(
                f"/api/v1/archive/{dr.case_id}/{b['structure_id']}", json={"note": "病人轉院"}, headers=admin._headers
            )
        )
        assert note["archive_note"] == "病人轉院"
        # 3) 刪整套：剩下的 OAR 進暫存區、原集名保留；救回時用同 id 同名重建結構集
        _delete(dr, f"/api/v1/cases/{dr.case_id}/structure-sets/{plan_b}")
        oar = next(x for x in _get(dr, "/api/v1/trash")["items"] if x["structure_id"] == c["structure_id"])
        assert oar["set_label"] == "計畫 B"
        other = Session(client=dr._client, user="lin")
        other._headers["X-RTGaia-Role"] = "contourer"
        with pytest.raises(RuntimeError, match="NOT_DELETER"):
            other._post(f"/api/v1/trash/structures/{dr.case_id}/{c['structure_id']}/restore", {})
        rest = dr._post(f"/api/v1/trash/structures/{dr.case_id}/{c['structure_id']}/restore", {})
        assert rest["structure_set_id"] == plan_b
        sets = {x["structure_set_id"]: x for x in dr.structure_sets()}
        assert sets[plan_b]["label"] == "計畫 B"
        assert c["structure_id"] in {s["structure_id"] for s in dr.structures()}
        _header, arr = dr.mask(c["structure_id"])
        assert int(arr.sum()) == 8  # 體素跟著回來
        # 4) 封存區救回（admin）：回到病例、狀態仍是 approved
        admin._post(f"/api/v1/archive/{dr.case_id}/{b['structure_id']}/restore", {})
        back = {s["structure_id"]: s for s in dr.structures()}
        assert back[b["structure_id"]]["status"] == "approved"
        # 5) 手動清除暫存區：版本列消失；共用的 mask 檔不能被刪
        purge = _delete(dr, f"/api/v1/trash/structures/{dr.case_id}/{a['structure_id']}")
        assert purge["structures"] >= 1 and purge["versions"] >= 2
        assert not any(x["structure_id"] == a["structure_id"] for x in _get(dr, "/api/v1/trash")["items"])
        # c 與 a 的體素一樣（全 1 的 2×2×2）→ 同一個 content_hash 的 blob 還被 c 用著，必須還在
        _h2, arr2 = dr.mask(c["structure_id"])
        assert int(arr2.sum()) == 8
        # 6) 過期自動清除：暫存區清、封存區不清
        _new(dr, "TMP_expire")
        tmp_id = next(s["structure_id"] for s in dr.structures() if s["name"] == "TMP_expire")
        dr._client.delete(f"/api/v1/structures/{tmp_id}", headers=dr._headers)
        dr._client.delete(f"/api/v1/structures/{b['structure_id']}", headers=dr._headers)  # 再次封存
        out = dr._post("/api/v1/_test/retention/tick", {"now_offset_days": 15})
        assert any(x["structure_id"] == tmp_id for x in out["structures"])
        assert any(x["structure_id"] == b["structure_id"] for x in _get(admin, "/api/v1/archive")["items"])
        # 7) 封存區永久刪除（admin）
        _delete(admin, f"/api/v1/archive/{dr.case_id}/{b['structure_id']}")
        assert not any(x["structure_id"] == b["structure_id"] for x in _get(admin, "/api/v1/archive")["items"])


def test_trash_without_db_is_unavailable(synth: SynthCase, tmp_path: Path, monkeypatch) -> None:  # type: ignore[no-untyped-def]
    monkeypatch.setenv("RTGAIA_DATA_DIR", str(tmp_path / "data"))
    with Session(library_root=str(synth.root), user="dr") as s:
        s.load_case(_selection(synth))
        t = _get(s, "/api/v1/trash")
        assert t["available"] is False and t["items"] == []
        assert json.dumps(_get(s, "/api/v1/archive")) and _get(s, "/api/v1/archive")["available"] is False
