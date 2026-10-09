"""同一個病例一次只載一份。

兩個請求同時從 DB 載同一個病例（例：重啟後兩個人同時打開），以前會各自建出一個 Case 物件，後登記的蓋掉先登記的；
兩個 session 指著不同的物件，各自寫回整份快照時互相把對方新畫的結構標成刪除。
"""

from __future__ import annotations

import asyncio
from typing import Any

from rtgaia_core.api.deps import AppState


class _Case:
    def __init__(self, case_id: str) -> None:
        self.case_id = case_id
        self.selection_hash = "sel_x"


def test_concurrent_loads_of_one_case_build_one_object(monkeypatch) -> None:  # type: ignore[no-untyped-def]
    app = AppState()
    app.db_url = "postgresql+asyncpg://unused/rtgaia_test"
    built: list[Any] = []

    async def slow_load(case_id: str, *, register: bool) -> Any:
        await asyncio.sleep(0.05)  # DB 讀取期間會讓出 event loop
        case = _Case(case_id)
        built.append(case)
        if register:
            app.store.register_case(case)  # type: ignore[arg-type]
        return case

    monkeypatch.setattr(app, "_load_case", slow_load)

    async def main() -> list[Any]:
        return await asyncio.gather(*(app.case_async("c1") for _ in range(3)), app.load_case_async("c1"))

    got = asyncio.run(main())
    assert len(built) == 1, "只從 DB 載一次"
    assert all(c is built[0] for c in got)


def test_processes_without_live_cases_load_fresh_every_time(monkeypatch) -> None:  # type: ignore[no-untyped-def]
    app = AppState()
    app.db_url = "postgresql+asyncpg://unused/rtgaia_test"
    app.owns_live_cases = False
    built: list[Any] = []

    async def load(case_id: str, *, register: bool) -> Any:
        assert register is False
        built.append(_Case(case_id))
        return built[-1]

    monkeypatch.setattr(app, "_load_case", load)

    async def main() -> list[Any]:
        return [await app.case_async("c1"), await app.case_async("c1")]

    first, second = asyncio.run(main())
    assert first is not second and app.store.cases() == []
