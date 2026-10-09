"""密碼政策（≥12、不含帳號、不可全同字元、不可常見）、鎖定可設定、管理者解鎖、
自己改密碼（舊 token 作廢、這一個換新）、臨時密碼強制改（伺服器端擋）、批次匯入帳號。需要 Postgres。"""

from __future__ import annotations

import os

import pytest
from rtgaia_core.auth import generate_temp_password, password_problems
from rtgaia_testbe import Session
from synth_dicom import SynthCase, write_synth_case

DB_URL = os.environ.get("RTGAIA_TEST_DB_URL", "")
ADMIN_PW = "correct-horse-battery"


@pytest.fixture(scope="module")
def synth(tmp_path_factory) -> SynthCase:  # type: ignore[no-untyped-def]
    return write_synth_case(tmp_path_factory.mktemp("synth"))


def test_policy_rules(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("RTGAIA_PASSWORD_MIN_LENGTH", raising=False)
    assert password_problems("short-pw") == ["密碼至少 12 個字元"]
    assert "密碼不可包含帳號" in password_problems("alice-long-enough-pw", "alice")
    assert "密碼不可全是同一個字元" in password_problems("aaaaaaaaaaaaaa")
    assert "密碼太常見" in password_problems("password12")
    assert password_problems("a-perfectly-fine-pw", "bob") == []
    monkeypatch.setenv("RTGAIA_PASSWORD_MIN_LENGTH", "16")
    assert password_problems("fifteen-chars-x") == ["密碼至少 16 個字元"]
    t = generate_temp_password()
    assert len(t) >= 16 and not password_problems(t) and not set("0O1lI") & set(t)


def _raw(s: Session, method: str, path: str, **kw):  # type: ignore[no-untyped-def]
    return s._client.request(method, path, headers=s._headers, **kw)


@pytest.mark.db
def test_accounts_flow(synth: SynthCase, tmp_path, monkeypatch) -> None:  # type: ignore[no-untyped-def]
    if not DB_URL:
        pytest.skip("RTGAIA_TEST_DB_URL 未設")
    from rtgaia_server.db.migrate import downgrade_base, upgrade_to_head

    monkeypatch.setenv("RTGAIA_DATA_DIR", str(tmp_path / "data"))
    monkeypatch.setenv("RTGAIA_LOGIN_MAX_FAILURES", "2")
    downgrade_base(DB_URL)
    upgrade_to_head(DB_URL)
    with Session(library_root=str(synth.root), db_url=DB_URL) as admin:
        st = admin._get("/api/v1/auth/status")
        assert st["password_policy"] == {"min_length": 12, "max_failures": 2, "lockout_minutes": 15}
        with pytest.raises(RuntimeError, match="WEAK_PASSWORD"):
            admin.bootstrap("boss", "short")
        admin.bootstrap("boss", ADMIN_PW)
        # 批次匯入：CSV 有標題；一列沒密碼 → 臨時密碼；一列密碼太弱 → 錯誤；一列重複 → 錯誤
        out = admin._post(
            "/api/v1/auth/users/batch",
            {
                "csv": (
                    "username,display_name,role,password\n"
                    "wang,王醫師,approver,\nlin,林劑量師,contourer,short\nwang,重複,viewer,\n"
                )
            },
        )
        assert [c["username"] for c in out["created"]] == ["wang"]
        temp = out["created"][0]["temp_password"]
        assert {e["line"] for e in out["errors"]} == {3, 4}  # 文字的實際行號（標題是第 1 行）
        users = {u["username"]: u for u in admin._get("/api/v1/auth/users")}
        assert users["wang"]["must_change_password"] is True and users["wang"]["role"] == "approver"
        # 臨時密碼登入：可以登入，但除了改密碼什麼都不能做
        wang = Session(client=admin._client)
        wang._headers = {}
        wang.login("wang", temp)
        assert _raw(wang, "GET", "/api/v1/library").status_code == 403
        assert _raw(wang, "GET", "/api/v1/auth/me").json()["must_change_password"] is True
        old_token = wang._headers["Authorization"]
        r = _raw(wang, "POST", "/api/v1/auth/me/password", json={"current_password": "nope", "new_password": "x"})
        assert r.status_code == 403 and r.json()["detail"]["code"] == "BAD_CURRENT_PASSWORD"
        r = _raw(
            wang, "POST", "/api/v1/auth/me/password", json={"current_password": temp, "new_password": "wang-is-my-pw!!"}
        )
        assert r.status_code == 422  # 含帳號
        r = _raw(
            wang,
            "POST",
            "/api/v1/auth/me/password",
            json={"current_password": temp, "new_password": "a-new-strong-secret"},
        )
        assert r.status_code == 200 and r.json()["user"]["must_change_password"] is False
        wang.set_bearer(r.json()["token"])
        assert _raw(wang, "GET", "/api/v1/library").status_code == 200
        # 改密碼之前簽的 token 作廢
        stale = Session(client=admin._client)
        stale._headers = {"Authorization": old_token}
        assert _raw(stale, "GET", "/api/v1/auth/me").status_code == 401
        # 鎖定（這裡設成 2 次）→ 管理者解鎖
        for _ in range(2):
            assert (
                _raw(
                    Session(client=admin._client),
                    "POST",
                    "/api/v1/auth/login",
                    json={"username": "wang", "password": "bad"},
                ).status_code
                == 401
            )  # noqa: E501
        locked = _raw(
            Session(client=admin._client),
            "POST",
            "/api/v1/auth/login",
            json={"username": "wang", "password": "a-new-strong-secret"},
        )  # noqa: E501
        assert locked.status_code == 423
        uid = users["wang"]["user_id"]
        assert (
            admin._unwrap(
                admin._client.patch(f"/api/v1/auth/users/{uid}", json={"unlock": True}, headers=admin._headers)
            )["locked_until"]
            is None
        )  # noqa: E501
        again = Session(client=admin._client)
        again._headers = {}
        again.login("wang", "a-new-strong-secret")
        # 管理者重設密碼 → 對方下次登入要改；原本的 token 立刻失效
        admin._unwrap(
            admin._client.patch(
                f"/api/v1/auth/users/{uid}", json={"password": "reset-by-admin-pw"}, headers=admin._headers
            )
        )  # noqa: E501
        assert _raw(again, "GET", "/api/v1/auth/me").status_code == 401
        after = Session(client=admin._client)
        after._headers = {}
        after.login("wang", "reset-by-admin-pw")
        assert _raw(after, "GET", "/api/v1/library").status_code == 403


@pytest.mark.db
def test_preferences_follow_the_account(synth: SynthCase, tmp_path, monkeypatch) -> None:  # type: ignore[no-untyped-def]
    """介面偏好存在帳號上（跨電腦）—— 合併寫入、null 刪除、key／值／總量的限制、只看得到自己的。"""
    if not DB_URL:
        pytest.skip("RTGAIA_TEST_DB_URL 未設")
    from rtgaia_server.db.migrate import downgrade_base, upgrade_to_head

    monkeypatch.setenv("RTGAIA_DATA_DIR", str(tmp_path / "data"))
    downgrade_base(DB_URL)
    upgrade_to_head(DB_URL)
    with Session(library_root=str(synth.root), db_url=DB_URL) as admin:
        admin.bootstrap("boss", ADMIN_PW)
        admin.create_user("wang", "river-secret-Passw0rd", role="contourer")
        assert admin._get("/api/v1/auth/me/preferences") == {"available": True, "preferences": {}}
        out = admin._client.put(
            "/api/v1/auth/me/preferences",
            json={"rtgaia.lang": "en", "rtgaia.layout.trees.v1": '{"2x2":{}}'},
            headers=admin._headers,
        ).json()
        assert out["preferences"] == {"rtgaia.lang": "en", "rtgaia.layout.trees.v1": '{"2x2":{}}'}
        # 合併、null 刪除
        out = admin._client.put(
            "/api/v1/auth/me/preferences",
            json={"rtgaia.lang": None, "rtgaia.ui.density": "compact"},
            headers=admin._headers,
        ).json()
        assert out["preferences"] == {"rtgaia.layout.trees.v1": '{"2x2":{}}', "rtgaia.ui.density": "compact"}
        # 限制
        for bad, code in (
            ({"Bad Key": "x"}, 422),
            ({"rtgaia.x": 3}, 422),
            ({"rtgaia.x": "x" * (64 * 1024 + 1)}, 422),
            ({}, 422),
        ):
            assert (
                admin._client.put("/api/v1/auth/me/preferences", json=bad, headers=admin._headers).status_code == code
            )
        big = {f"rtgaia.k{i}": "x" * 60_000 for i in range(5)}
        assert admin._client.put("/api/v1/auth/me/preferences", json=big, headers=admin._headers).status_code == 413
        # 另一個人：看不到 boss 的
        wang = Session(client=admin._client)
        wang.login("wang", "river-secret-Passw0rd")
        assert wang._get("/api/v1/auth/me/preferences")["preferences"] == {}
        # 未登入 401（清掉 bootstrap／login 留下的 cookie）
        admin._client.cookies.clear()
        assert admin._client.get("/api/v1/auth/me/preferences").status_code == 401


@pytest.mark.db
def test_concurrent_bad_passwords_still_hit_the_lockout_threshold(monkeypatch: pytest.MonkeyPatch) -> None:
    """失敗次數以前是「讀舊值 → 加一 → 寫回」，同時五個錯誤密碼可能都從 0 開始、永遠鎖不住。
    現在原子加一：同時五個錯誤 → 鎖；鎖住後對的密碼也進不去；過了鎖定時間（這裡直接清）再用對的 → ok 且歸零。
    也驗 Argon2 不在 event loop 上：五個驗證進行中，event loop 還能跑別的協程。"""
    if not DB_URL:
        pytest.skip("RTGAIA_TEST_DB_URL 未設")
    import asyncio

    from rtgaia_server.db.migrate import downgrade_base, upgrade_to_head
    from rtgaia_server.db.users import UserStore
    from sqlalchemy.ext.asyncio import create_async_engine

    monkeypatch.setenv("RTGAIA_LOGIN_MAX_FAILURES", "5")
    monkeypatch.setenv("RTGAIA_PASSWORD_WORKERS", "5")
    downgrade_base(DB_URL)
    upgrade_to_head(DB_URL)

    async def main() -> None:
        engine = create_async_engine(DB_URL)
        try:
            users = UserStore(engine)
            await users.create(username="carol", password=ADMIN_PW)
            ticks = 0
            stop = asyncio.Event()

            async def ticker() -> None:
                nonlocal ticks
                while not stop.is_set():
                    ticks += 1
                    await asyncio.sleep(0.001)

            t = asyncio.create_task(ticker())
            results = await asyncio.gather(*(users.authenticate("carol", "wrong-password-xx") for _ in range(5)))
            stop.set()
            await t
            assert [r for _, r in results] == ["bad_password"] * 5
            assert ticks > 5, "Argon2 驗證期間 event loop 沒在跑（又在 event loop 上同步算了？）"
            row, reason = await users.authenticate("carol", ADMIN_PW)
            assert (row, reason) == (None, "locked")
            stored = await users.by_username("carol")
            assert stored is not None and stored.locked_until and int(stored.failed_logins or 0) == 0
            await users.update(stored.user_id, unlock=True)
            row, reason = await users.authenticate("carol", ADMIN_PW)
            assert reason == "ok" and row is not None
            assert await users.authenticate("nobody-here", ADMIN_PW) == (None, "no_such_user")
        finally:
            await engine.dispose()

    asyncio.run(main())


@pytest.mark.db
def test_concurrent_preference_updates_keep_every_key_and_respect_total() -> None:
    """偏好以前是「讀 JSON → Python 合併 → 整份寫回」、沒有鎖 —— 兩台裝置同時改不同 key，
    後寫的蓋掉先寫的。總量檢查也跟寫入分開。現在同一個持鎖交易；總量以 UTF-8 bytes 算。"""
    if not DB_URL:
        pytest.skip("RTGAIA_TEST_DB_URL 未設")
    import asyncio

    from rtgaia_core.auth import PreferencesTooLarge
    from rtgaia_server.db.migrate import downgrade_base, upgrade_to_head
    from rtgaia_server.db.users import UserStore
    from sqlalchemy.ext.asyncio import create_async_engine

    downgrade_base(DB_URL)
    upgrade_to_head(DB_URL)

    async def main() -> None:
        engine = create_async_engine(DB_URL, pool_size=10)
        try:
            users = UserStore(engine)
            row = await users.create(username="dave", password=ADMIN_PW)
            # 20 個「裝置」同時各寫一個不同的 key
            await asyncio.gather(*(users.update_preferences(row.user_id, {f"k{i}": str(i)}) for i in range(20)))
            prefs = await users.preferences(row.user_id)
            assert {f"k{i}" for i in range(20)} <= set(prefs), f"有 key 被蓋掉：{sorted(prefs)}"
            # 總量（bytes）：每個值 30 個中文字 ＝ 90 bytes；上限 1000 bytes → 同時寫 20 個，只有塞得下的會成功
            big = "劑" * 30
            results = await asyncio.gather(
                *(
                    users.update_preferences(row.user_id, {f"zh{i}": big}, max_total_bytes=1000)
                    for i in range(20)
                ),
                return_exceptions=True,
            )
            assert any(isinstance(r, PreferencesTooLarge) for r in results)
            import json

            final = await users.preferences(row.user_id)
            assert len(json.dumps(final, ensure_ascii=False).encode("utf-8")) <= 1000
        finally:
            await engine.dispose()

    asyncio.run(main())
