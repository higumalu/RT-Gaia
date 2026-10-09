"""Alembic async env。`-x url=…` 或 `sqlalchemy.url` 決定連哪裡。"""

from __future__ import annotations

import asyncio
import os

from alembic import context
from rtgaia_server.db.models import Base
from sqlalchemy.ext.asyncio import async_engine_from_config

config = context.config
# 🔴 2026-09-30 事故：以前 `RTGAIA_DB_URL` 環境變數**蓋過**程式明確給的 URL —— 測試的 `downgrade_base(測試庫)`
# 在設了 `RTGAIA_DB_URL`（開發庫）的 shell 裡跑，實際清掉的是開發庫。現在順序：`-x url=` ＞ 程式明確給的
# （`db/migrate.py` 的 `alembic_config(url)` 會標 `rtgaia_explicit_url`）＞ 環境變數 ＞ alembic.ini。
x_url = context.get_x_argument(as_dictionary=True).get("url")
if x_url:
    config.set_main_option("sqlalchemy.url", x_url)
elif not config.attributes.get("rtgaia_explicit_url") and os.environ.get("RTGAIA_DB_URL"):
    config.set_main_option("sqlalchemy.url", os.environ["RTGAIA_DB_URL"])
target_metadata = Base.metadata


def run_migrations_offline() -> None:
    context.configure(url=config.get_main_option("sqlalchemy.url"), target_metadata=target_metadata, literal_binds=True)
    with context.begin_transaction():
        context.run_migrations()


def _do_run_migrations(connection) -> None:  # type: ignore[no-untyped-def]
    context.configure(connection=connection, target_metadata=target_metadata)
    with context.begin_transaction():
        context.run_migrations()


async def run_migrations_online() -> None:
    engine = async_engine_from_config(config.get_section(config.config_ini_section) or {}, prefix="sqlalchemy.")
    async with engine.connect() as connection:
        await connection.run_sync(_do_run_migrations)
    await engine.dispose()


if context.is_offline_mode():
    run_migrations_offline()
else:
    asyncio.run(run_migrations_online())
