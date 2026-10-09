"""`run_cpu` —— CPU 工作的併發預算，名額在執行緒真的結束才還（HTTP 取消不會提早放名額）。"""

from __future__ import annotations

import asyncio
import threading
import time

import pytest
from rtgaia_core.limits import run_cpu


def test_run_cpu_respects_budget_even_when_waiters_are_cancelled(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("RTGAIA_CPU_WORKERS", "2")
    lock = threading.Lock()
    state = {"now": 0, "max": 0, "finished": 0}

    def work() -> int:
        with lock:
            state["now"] += 1
            state["max"] = max(state["max"], state["now"])
        time.sleep(0.15)
        with lock:
            state["now"] -= 1
            state["finished"] += 1
        return 1

    async def main() -> None:
        tasks = [asyncio.create_task(run_cpu(work)) for _ in range(5)]
        await asyncio.sleep(0.05)
        # 取消一個**正在跑**的等待者：執行緒照跑，名額不能在這裡就還回去
        tasks[0].cancel()
        results = await asyncio.gather(*tasks, return_exceptions=True)
        assert isinstance(results[0], asyncio.CancelledError)
        assert results[1:] == [1, 1, 1, 1]
        # 等被取消的那個執行緒也結束
        for _ in range(50):
            if state["finished"] == 5:
                break
            await asyncio.sleep(0.02)

    asyncio.run(main())
    assert state["finished"] == 5
    assert state["max"] <= 2, f"同時跑了 {state['max']} 個，超過預算 2"


def test_run_cpu_propagates_exceptions_and_releases(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("RTGAIA_CPU_WORKERS", "1")

    def boom() -> None:
        raise ValueError("壞了")

    async def main() -> None:
        with pytest.raises(ValueError, match="壞了"):
            await run_cpu(boom)
        # 名額有還：下一個照樣跑得完
        assert await asyncio.wait_for(run_cpu(lambda: 7), timeout=2) == 7

    asyncio.run(main())
