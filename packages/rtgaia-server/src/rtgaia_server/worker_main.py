"""獨立 worker 行程：`rtgaia-worker`。

與 API 共用同一個 Postgres 與 blob 目錄；領 job（`SKIP LOCKED`）、算，
進度經匯流排（outbox ＋ NOTIFY）到 API 的 WS 連線。
可以起多個。API 端以 `RTGAIA_INPROCESS_WORKER=0` 關掉自己的 worker。
"""

from __future__ import annotations

import argparse
import asyncio
import os
import signal

from rtgaia_core.api.deps import AppState

from .app import make_state


async def _run(state: AppState) -> None:
    from rtgaia_core.jobs import worker_loop

    await state.bus_async()
    stop = asyncio.Event()
    loop = asyncio.get_running_loop()
    for sig in (signal.SIGINT, signal.SIGTERM):
        try:
            loop.add_signal_handler(sig, stop.set)
        except NotImplementedError:
            pass
    task = asyncio.create_task(worker_loop(state))
    stopper = asyncio.create_task(stop.wait())
    # worker 迴圈**意外結束**（不是收到 stop）→ 行程以非零碼退出，讓服務管理器
    # （compose `restart: unless-stopped`）重啟、監控看得到；以前行程會活著等 stop，卻不再領工作。
    await asyncio.wait({task, stopper}, return_when=asyncio.FIRST_COMPLETED)
    crashed: BaseException | None = None
    if task.done() and not stop.is_set():
        crashed = task.exception() if not task.cancelled() else asyncio.CancelledError()
    stopper.cancel()
    task.cancel()
    try:
        await task
    except (asyncio.CancelledError, Exception):  # noqa: BLE001
        pass
    if state.bus is not None:
        await state.bus.stop()
    if state.catalog_store is not None:
        await state.catalog_store.dispose()
    if crashed is not None or (task.done() and not stop.is_set()):
        reason = type(crashed).__name__ if crashed else "no exception"
        print(f"rtgaia-worker: the worker loop ended unexpectedly ({reason}); exiting with a non-zero code")
        raise SystemExit(1)


def make_worker_state(*, db_url: str, library_root: str) -> AppState:
    state = make_state()
    state.db_url = db_url
    state.library_root = library_root
    state.auth_mode = "off"  # worker 不對外，不需要身分
    state.subscribe = False  # 只發布
    state.owns_live_cases = False  # 病例每次從 DB 重建：即時狀態在 API 行程
    state.inprocess_worker = True
    return state


def main() -> None:
    parser = argparse.ArgumentParser(
        prog="rtgaia-worker", description="RT-Gaia standalone job worker (exports and other non-interactive work)"
    )
    parser.add_argument("--db-url", default=os.environ.get("RTGAIA_DB_URL", ""))
    parser.add_argument(
        "--library",
        default=os.environ.get("RTGAIA_LIBRARY_ROOT", "") or (os.path.abspath("data") if os.path.isdir("data") else ""),
    )
    parser.add_argument("--data-dir", default=os.environ.get("RTGAIA_DATA_DIR", ""))
    args = parser.parse_args()
    if not args.db_url:
        raise SystemExit("rtgaia-worker needs --db-url or RTGAIA_DB_URL (a standalone worker requires PostgreSQL)")
    os.environ["RTGAIA_LIBRARY_ROOT"] = args.library
    if args.data_dir:
        os.environ["RTGAIA_DATA_DIR"] = os.path.abspath(args.data_dir)
    print(f"rtgaia-worker: database {args.db_url.split('@')[-1]}, library {args.library}")
    asyncio.run(_run(make_worker_state(db_url=args.db_url, library_root=args.library)))


if __name__ == "__main__":
    main()
