"""`UserStore` —— 本地帳號的持久層。"""

from __future__ import annotations

import uuid
from datetime import UTC, datetime, timedelta
from typing import Any

from rtgaia_core.auth import (
    ROLES,
    PreferencesTooLarge,
    Principal,
    hash_password,
    lockout_seconds,
    max_failed_logins,
    verify_password,
)
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncEngine, async_sessionmaker

from .models import UserRow


def _now() -> datetime:
    return datetime.now(UTC)


def _iso(dt: datetime) -> str:
    return dt.isoformat(timespec="seconds")


BOOTSTRAP_LOCK_KEY = 0x52544741  # "RTGA"：bootstrap 專用的 advisory lock 號碼

_DUMMY_HASH: str | None = None


async def _hash(password: str) -> str:
    """Argon2 雜湊移出 event loop。"""
    from rtgaia_core.limits import run_password

    return await run_password(hash_password, password)


async def _dummy_hash() -> str:
    """不存在的帳號也驗一次（跟真的帳號花一樣久）；雜湊只算一次。"""
    global _DUMMY_HASH
    if _DUMMY_HASH is None:
        _DUMMY_HASH = await _hash("rtgaia-no-such-user-timing-equalizer")
    return _DUMMY_HASH


class UserStore:
    def __init__(self, engine: AsyncEngine) -> None:
        self.sessions = async_sessionmaker(engine, expire_on_commit=False)

    async def count(self) -> int:
        async with self.sessions() as s:
            return int((await s.execute(select(func.count()).select_from(UserRow))).scalar() or 0)

    async def by_username(self, username: str) -> UserRow | None:
        async with self.sessions() as s:
            return (
                await s.execute(select(UserRow).where(UserRow.username == username.strip().lower()))
            ).scalar_one_or_none()

    async def by_id(self, user_id: str) -> UserRow | None:
        async with self.sessions() as s:
            return await s.get(UserRow, user_id)

    async def preferences(self, user_id: str) -> dict[str, Any]:
        row = await self.by_id(user_id)
        return dict(row.preferences or {}) if row is not None else {}

    async def update_preferences(
        self, user_id: str, patch: dict[str, Any], *, max_total_bytes: int | None = None
    ) -> dict[str, Any]:
        """合併寫入；值為 None ＝ 刪掉那個 key。

        `SELECT … FOR UPDATE` 鎖住這一列再合併 —— 兩台裝置同時改不同 key 都會留下；
        總量（UTF-8 bytes）在同一個交易裡、以合併後的結果判斷，超過就丟 `PreferencesTooLarge`（整筆不寫）。
        """
        import json

        async with self.sessions() as s:
            async with s.begin():
                row = (
                    await s.execute(select(UserRow).where(UserRow.user_id == user_id).with_for_update())
                ).scalar_one_or_none()
                if row is None:
                    raise KeyError(f"沒有使用者 {user_id}")
                merged = dict(row.preferences or {})
                for k, v in patch.items():
                    if v is None:
                        merged.pop(k, None)
                    else:
                        merged[k] = v
                if max_total_bytes is not None:
                    size = len(json.dumps(merged, ensure_ascii=False).encode("utf-8"))
                    if size > max_total_bytes:
                        raise PreferencesTooLarge(f"偏好設定總量 {size} bytes 超過 {max_total_bytes}")
                row.preferences = merged
                return merged

    async def list(self) -> list[UserRow]:
        async with self.sessions() as s:
            return list((await s.execute(select(UserRow).order_by(UserRow.created_at))).scalars().all())

    async def create(
        self,
        *,
        username: str,
        password: str,
        role: str = "contourer",
        display_name: str = "",
        created_by: str = "",
        must_change_password: bool = False,
    ) -> UserRow:
        username = username.strip().lower()
        if not username:
            raise ValueError("username 必填")
        if role not in ROLES:
            raise ValueError(f"role 必須是 {'/'.join(ROLES)}")
        if await self.by_username(username) is not None:
            raise ValueError(f"帳號 {username} 已存在")
        password_hash = await _hash(password)
        row = UserRow(
            user_id=f"u_{uuid.uuid4().hex[:12]}",
            username=username,
            display_name=display_name.strip() or username,
            role=role,
            password_hash=password_hash,
            disabled=False,
            created_at=_iso(_now()),
            created_by=created_by,
            must_change_password=must_change_password,
            password_changed_at=_now().isoformat(),
        )
        async with self.sessions() as s:
            async with s.begin():
                s.add(row)
        return row

    async def create_first_admin(self, *, username: str, password: str, display_name: str = "") -> UserRow | None:
        """bootstrap（第一個 admin）的**原子**版本：同一個交易裡先拿 Postgres advisory lock、再數使用者、是 0 才建。

        以前是 route 先 `count()`、再 `create()` —— 兩個瀏覽器同時按「建立管理者」會各建一個 admin（兩個都看到 0）。
        advisory xact lock 讓同時的 bootstrap 排隊，第二個進來時已經數到 1 → 回 None（route 回 409）。
        """
        from sqlalchemy import text

        username = username.strip().lower()
        if not username:
            raise ValueError("username 必填")
        password_hash = await _hash(password)
        async with self.sessions() as s:
            async with s.begin():
                await s.execute(text("SELECT pg_advisory_xact_lock(:k)"), {"k": BOOTSTRAP_LOCK_KEY})
                if int((await s.execute(select(func.count()).select_from(UserRow))).scalar() or 0) > 0:
                    return None
                row = UserRow(
                    user_id=f"u_{uuid.uuid4().hex[:12]}",
                    username=username,
                    display_name=display_name.strip() or username,
                    role="admin",
                    password_hash=password_hash,
                    disabled=False,
                    created_at=_iso(_now()),
                    created_by="bootstrap",
                    must_change_password=False,
                    password_changed_at=_now().isoformat(),
                )
                s.add(row)
        return row

    async def update(self, user_id: str, **fields: Any) -> UserRow:
        new_hash = await _hash(str(fields["password"])) if "password" in fields else None
        async with self.sessions() as s:
            async with s.begin():
                row = await s.get(UserRow, user_id)
                if row is None:
                    raise KeyError(f"沒有使用者 {user_id}")
                if "role" in fields:
                    if fields["role"] not in ROLES:
                        raise ValueError(f"role 必須是 {'/'.join(ROLES)}")
                    row.role = fields["role"]
                if "disabled" in fields:
                    row.disabled = bool(fields["disabled"])
                if "display_name" in fields:
                    row.display_name = str(fields["display_name"]).strip() or row.username
                if "password" in fields:
                    row.password_hash = new_hash
                    row.failed_logins = 0
                    row.locked_until = None
                    row.password_changed_at = _now().isoformat()  # 微秒；比這更早簽的 token 作廢
                    row.must_change_password = bool(fields.get("must_change_password", False))
                elif "must_change_password" in fields:
                    row.must_change_password = bool(fields["must_change_password"])
                if fields.get("unlock"):
                    row.failed_logins = 0
                    row.locked_until = None
            return row

    async def authenticate(self, username: str, password: str) -> tuple[UserRow | None, str]:
        """回 (row, reason)。reason ∈ ok | no_such_user | disabled | locked | bad_password。連續失敗 5 次鎖 15 分鐘。

        * Argon2 驗證在有界執行緒池（`run_password`），**不持 DB 交易、不卡 event loop**。
        * 失敗次數以原子 SQL 加一（`failed_logins = failed_logins + 1 … RETURNING`）—— 以前讀出舊值、加一、寫回，
          同時五個錯誤密碼可能都從 0 開始算，鎖定門檻依時序而變。
        * 成功登入以條件式更新落地：這段時間被別的失敗請求鎖住了 → 回 locked，不會把鎖蓋掉。
        * 沒有這個帳號也跑一次驗證（假雜湊），「帳號存不存在」不會從回應時間看出來。
        """
        from rtgaia_core.limits import run_password
        from sqlalchemy import or_, update

        name = username.strip().lower()
        async with self.sessions() as s:
            row = (await s.execute(select(UserRow).where(UserRow.username == name))).scalar_one_or_none()
        if row is None:
            await run_password(verify_password, await _dummy_hash(), password)
            return None, "no_such_user"
        if row.disabled:
            return None, "disabled"
        if row.locked_until and datetime.fromisoformat(row.locked_until) > _now():
            return None, "locked"
        ok = await run_password(verify_password, row.password_hash, password)
        now = _now()
        async with self.sessions() as s:
            async with s.begin():
                if not ok:
                    count = (
                        await s.execute(
                            update(UserRow)
                            .where(UserRow.user_id == row.user_id)
                            .values(failed_logins=func.coalesce(UserRow.failed_logins, 0) + 1)
                            .returning(UserRow.failed_logins)
                        )
                    ).scalar_one()
                    if int(count) >= max_failed_logins():
                        await s.execute(
                            update(UserRow)
                            .where(UserRow.user_id == row.user_id)
                            .values(locked_until=_iso(now + timedelta(seconds=lockout_seconds())), failed_logins=0)
                        )
                    return None, "bad_password"
                done = (
                    await s.execute(
                        update(UserRow)
                        .where(UserRow.user_id == row.user_id)
                        .where(or_(UserRow.locked_until.is_(None), UserRow.locked_until <= _iso(now)))
                        .values(failed_logins=0, locked_until=None, last_login_at=_iso(now))
                        .returning(UserRow.user_id)
                    )
                ).scalar_one_or_none()
                if done is None:
                    return None, "locked"
        row.failed_logins, row.locked_until, row.last_login_at = 0, None, _iso(now)
        return row, "ok"

    @staticmethod
    def principal(row: UserRow) -> Principal:
        return Principal(
            user_id=row.user_id,
            username=row.username,
            display_name=row.display_name,
            role=row.role,
            must_change_password=bool(getattr(row, "must_change_password", False)),
        )

    @staticmethod
    def to_wire(row: UserRow) -> dict[str, Any]:
        return {
            "user_id": row.user_id,
            "username": row.username,
            "display_name": row.display_name,
            "role": row.role,
            "disabled": bool(row.disabled),
            "created_at": row.created_at,
            "created_by": row.created_by,
            "last_login_at": row.last_login_at,
            "locked_until": row.locked_until,
            "must_change_password": bool(row.must_change_password),
            "password_changed_at": row.password_changed_at,
        }
