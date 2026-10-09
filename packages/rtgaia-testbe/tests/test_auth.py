"""本地帳號、登入 cookie、角色、每人 Session、病例頻道推送。

需要 Postgres（`RTGAIA_TEST_DB_URL`）；沒設就 skip。`RTGAIA_AUTH=required` 由 db_url 推得。
"""

from __future__ import annotations

import os

import numpy as np
import pytest
from rtgaia_core.auth import make_token, parse_token
from rtgaia_server.db.migrate import downgrade_base, upgrade_to_head
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
        pytest.skip("RTGAIA_TEST_DB_URL 未設")
    downgrade_base(DB_URL)
    upgrade_to_head(DB_URL)
    return DB_URL


def _selection(synth: SynthCase) -> dict:
    return {
        "primary_series_uid": synth.plan_ct.series_uid,
        "image_series_uids": [synth.plan_ct.series_uid, synth.cbct.series_uid],
        "structure_set_uids": [synth.plan_rs_uid],
        "dose_uids": [synth.plan_dose_uid],
        "registration_uids": [synth.reg_uid],
        "plan_uids": [synth.plan_uid],
    }


def test_token_roundtrip_and_tamper() -> None:
    secret = b"s" * 32
    tok = make_token("u_1", secret, now=1000.0, ttl=60)
    assert parse_token(tok, secret, now=1030.0) == "u_1"
    assert parse_token(tok, secret, now=1061.0) is None  # 過期
    assert parse_token(tok, b"x" * 32, now=1030.0) is None  # 別的金鑰
    body, sig = tok.split(".")
    assert parse_token(f"{body}x.{sig}", secret, now=1030.0) is None  # 改 body
    assert parse_token("garbage", secret) is None


def test_bootstrap_is_atomic_under_concurrency(db_url: str) -> None:
    """bootstrap 以前是 count → create 兩步，同時兩個請求會建出兩個 admin。
    現在數與建在同一個交易、同一把 advisory lock 裡：8 個同時進來只有 1 個成功。"""
    import asyncio

    from rtgaia_server.db.users import UserStore
    from sqlalchemy.ext.asyncio import create_async_engine

    async def run() -> tuple[list[object], int]:
        engine = create_async_engine(db_url)
        try:
            store = UserStore(engine)
            results = await asyncio.gather(
                *[store.create_first_admin(username=f"admin{i}", password="correct-horse-battery") for i in range(8)]
            )
            return list(results), await store.count()
        finally:
            await engine.dispose()

    results, count = asyncio.run(run())
    assert sum(r is not None for r in results) == 1
    assert count == 1


def test_bootstrap_login_roles_and_lockout(db_url: str, synth: SynthCase) -> None:
    with Session(library_root=str(synth.root), db_url=db_url) as s:
        client = s._client
        status = client.get("/api/v1/auth/status").json()
        assert status["mode"] == "required" and status["bootstrap_needed"] is True and status["user"] is None
        # 沒登入：目錄 401；healthz 不用
        assert client.get("/api/v1/catalog/patients").status_code == 401
        assert client.get("/healthz").status_code == 200
        # 弱密碼拒絕
        assert client.post("/api/v1/auth/bootstrap", json={"username": "admin", "password": "short"}).status_code == 422
        r = client.post(
            "/api/v1/auth/bootstrap",
            json={"username": "Admin", "password": "correct-horse-battery", "display_name": "管理者"},
        )
        assert r.status_code == 201 and r.json()["user"]["role"] == "admin" and r.json()["user"]["username"] == "admin"
        assert "rtgaia_session" in r.cookies or client.cookies.get("rtgaia_session")
        # 第二次 bootstrap 不行
        assert (
            client.post(
                "/api/v1/auth/bootstrap", json={"username": "x", "password": "correct-horse-battery"}
            ).status_code
            == 409
        )
        me = client.get("/api/v1/auth/me").json()
        assert me["username"] == "admin" and me["display_name"] == "管理者" and me["source"] == "local"
        assert client.get("/api/v1/catalog/patients").status_code == 200

        # admin 建三個帳號
        for u, role in (("viewer1", "viewer"), ("tech1", "contourer"), ("dr1", "approver")):
            r = client.post(
                "/api/v1/auth/users", json={"username": u, "password": "correct-horse-battery", "role": role}
            )
            assert r.status_code == 201, r.text
        assert [u["username"] for u in client.get("/api/v1/auth/users").json()] == ["admin", "viewer1", "tech1", "dr1"]
        assert (
            client.post(
                "/api/v1/auth/users", json={"username": "tech1", "password": "correct-horse-battery"}
            ).status_code
            == 422
        )
        client.post("/api/v1/auth/logout")
        assert client.get("/api/v1/auth/me").status_code == 401

        # 鎖定：5 次錯 → 423
        for _ in range(5):
            assert (
                client.post("/api/v1/auth/login", json={"username": "tech1", "password": "wrong-password!"}).status_code
                == 401
            )
        r = client.post("/api/v1/auth/login", json={"username": "tech1", "password": "correct-horse-battery"})
        assert r.status_code == 423 and r.json()["detail"]["code"] == "LOCKED"
        # 不存在的帳號與密碼錯回同一個碼
        assert (
            client.post("/api/v1/auth/login", json={"username": "nobody", "password": "x"}).json()["detail"]["code"]
            == "BAD_CREDENTIALS"
        )


def test_roles_gate_writes_reviews_and_admin(db_url: str, synth: SynthCase) -> None:
    with Session(library_root=str(synth.root), db_url=db_url) as admin:
        admin.bootstrap("admin", "correct-horse-battery")
        for u, role in (("viewer1", "viewer"), ("tech1", "contourer"), ("dr1", "approver")):
            admin.create_user(u, "correct-horse-battery", role)
        # 🔴 多身分共用同一個 TestClient（同一個 event loop）；身分用 Bearer 逐 driver 帶
        viewer, tech, doc = (Session(client=admin._client) for _ in range(3))
        viewer.login("viewer1", "correct-horse-battery")
        tech.login("tech1", "correct-horse-battery")
        doc.login("dr1", "correct-horse-battery")
        assert viewer.me()["role"] == "viewer" and doc.me()["role"] == "approver"

        # contourer 開病例、編輯
        opened = tech.load_case(_selection(synth))
        # 匯入集唯讀 → 先合併進自己的工作集
        sid = tech.claim(tech.structures()[0]["structure_id"])
        edited = tech.edit(sid, offset_ijk=(0, 0, 0), array=np.ones((2, 2, 2), dtype=np.uint8), client_seq=1)
        assert edited["version_id"]
        # viewer：開病例可以（不改臨床資料），編輯 403
        viewer_opened = viewer.load_case(_selection(synth))
        assert viewer_opened["case_id"] == opened["case_id"]
        with pytest.raises(RuntimeError, match="403") as exc:
            viewer.edit(sid, offset_ijk=(0, 0, 0), array=np.ones((1, 1, 1), dtype=np.uint8), client_seq=1)
        assert "contourer" in str(exc.value)
        # contourer 不能簽核；approver 可以，事件記到 dr1
        with pytest.raises(RuntimeError, match="403") as exc:
            tech.review({sid: "approved"})
        assert "approver" in str(exc.value)
        doc.load_case(_selection(synth))
        out = doc.review({sid: "approved"}, note="ok")
        assert out["events"][0]["user"] == "dr1"
        # 非 admin 不能管帳號
        with pytest.raises(RuntimeError, match="403"):
            doc._get("/api/v1/auth/users")
        # 版本鏈記的是 tech1
        assert tech.versions(sid)["versions"][1]["created_by"] == "tech1"
        # 沒有身分（新 driver、沒 Bearer、cookie jar 已清）→ 401
        anon = Session(client=admin._client)
        with pytest.raises(RuntimeError, match="401"):
            anon._get("/api/v1/cases")


def test_grids_renegotiation_only_touches_the_requesters_session(db_url: str, synth: SynthCase) -> None:
    """`POST /studies/{id}/grids` 以前用 `by_study(study_id)`（全域 current 優先），
    b 最後開同一病例時，a 的重新協商會重建 **b** 的 session、回傳 b 的 session id。現在只找請求者自己的；
    沒有自己 session 的人 404，不能藉此改別人的。"""
    with Session(library_root=str(synth.root), db_url=db_url) as admin:
        admin.bootstrap("admin", "correct-horse-battery")
        for u in ("a", "b", "c"):
            admin.create_user(u, "correct-horse-battery")
        a, b, c = Session(client=admin._client), Session(client=admin._client), Session(client=admin._client)
        for who, drv in (("a", a), ("b", b), ("c", c)):
            drv.login(who, "correct-horse-battery")
        oa = a.load_case(_selection(synth))
        ob = b.load_case(_selection(synth))  # b 最後開 → 全域 current 是 b
        b_grid_before = b.display_grid_id
        # 交錯重新協商：各自回自己的 session id，而且不動對方的 DisplayGrid
        for i in range(5):
            ga = a.grids(webgl2=False, tier="C")
            assert ga["session_id"] == oa["session_id"], f"第 {i} 輪 a 拿到別人的 session"
            assert b.display_grid_id == b_grid_before
            gb = b.grids(webgl2=False, tier="C")
            assert gb["session_id"] == ob["session_id"], f"第 {i} 輪 b 拿到別人的 session"
            b_grid_before = b.display_grid_id
        sessions = {s["session_id"]: s for s in admin._get("/api/v1/_test/sessions")["sessions"]}
        assert {oa["session_id"], ob["session_id"]} <= set(sessions)
        # c 沒開過這個病例：不能藉 grids 重建別人的 session
        c.study_id = a.study_id
        with pytest.raises(RuntimeError, match="404"):
            c._post(f"/api/v1/studies/{a.study_id}/grids", {"series_ids": [], "client_capability": None})


def test_two_users_same_case_two_sessions_and_case_wide_push(db_url: str, synth: SynthCase) -> None:
    with Session(library_root=str(synth.root), db_url=db_url) as admin:
        admin.bootstrap("admin", "correct-horse-battery")
        admin.create_user("a", "correct-horse-battery")
        admin.create_user("b", "correct-horse-battery")
        a, b = Session(client=admin._client), Session(client=admin._client)
        a.login("a", "correct-horse-battery")
        b.login("b", "correct-horse-battery")
        oa = a.load_case(_selection(synth))
        ob = b.load_case(_selection(synth))
        assert oa["case_id"] == ob["case_id"] and oa["session_id"] != ob["session_id"]
        # 兩個 session 都在（沒有互相汰除），presence 有兩個人
        case = a._get(f"/api/v1/cases/{oa['case_id']}")
        assert case["sessions"] == 2 and {p["user"] for p in case["presence"]} == {"a", "b"}
        # 各自的 current
        assert a.state["sessionId"] == oa["session_id"] and b.state["sessionId"] == ob["session_id"]
        # a 重開同一病例：換掉 a 自己的、b 的不動
        oa2 = a.load_case(_selection(synth))
        sessions = a._get("/api/v1/_test/sessions")["sessions"]
        assert {s["session_id"] for s in sessions} == {oa2["session_id"], ob["session_id"]}
        # a 編輯 → b 的 session 也收到 mask.updated（push targets）
        imported = a.structures()[0]["structure_id"]
        sid = a.claim(imported)
        a.edit(sid, offset_ijk=(0, 0, 0), array=np.ones((2, 2, 2), dtype=np.uint8), client_seq=1)
        targets = {t["sessionId"] for t in a.state["push_targets_tail"] if t["type"] == "mask.updated"}
        assert {oa2["session_id"], ob["session_id"]} <= targets
        # b 用自己的 display_grid 抓影像（不同 session、同一病例）
        b.grids(webgl2=False, tier="C")
        header, _ = b.image()
        assert header["display_grid_id"] == b.display_grid_id
        # b 的 client_seq 水位獨立於 a（client_id 不同）
        sid_b = b.claim(imported)  # b 有自己的工作集；a 的結構對 b 唯讀
        b.edit(sid_b, offset_ijk=(0, 0, 0), array=np.zeros((2, 2, 2), dtype=np.uint8), client_seq=1, client_id="b-tab")
