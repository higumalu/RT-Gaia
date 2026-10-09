"""獨立 DIMSE 接收端行程：`rtgaia-scp`。

收到的 instance 落 `RTGAIA_DATA_DIR/staging/scp/<batch>/`，association 結束就在 Postgres 佇列開一個 `import` job；
worker 匯入並推 `catalog.changed`。只需要 DB 與資料目錄；不對外提供 HTTP。
"""

from __future__ import annotations

import argparse
import asyncio
import os
import signal

from rtgaia_core.api.deps import AppState

from .app import make_state


async def _run(state: AppState, port: int | None, host: str | None) -> None:
    """設定來自 `app_setting.dimse`（env 預設）；`--port`／`--host` 覆寫。訂閱匯流排：`settings.changed` 就重啟。"""
    loop = asyncio.get_running_loop()
    state.loop = loop
    await state.job_queue_async()
    await state.bus_async()
    stop = asyncio.Event()
    for sig in (signal.SIGINT, signal.SIGTERM):
        try:
            loop.add_signal_handler(sig, stop.set)
        except NotImplementedError:
            pass
    state.scp_cli_override = {"scp_port": port, "scp_host": host}
    cfg = await state.dimse_settings_async(refresh=True)
    server = state.start_scp(settings=cfg)
    print(f"rtgaia-scp: AE {server.ae_title} listening on {server.host}:{server.port}, staging {server.staging_root}")
    try:
        await stop.wait()
    finally:
        state.stop_scp()
        if state.bus is not None:
            await state.bus.stop()
        if state.catalog_store is not None:
            await state.catalog_store.dispose()


def main() -> None:
    parser = argparse.ArgumentParser(prog="rtgaia-scp", description="RT-Gaia DICOM receiver (C-STORE SCP)")
    parser.add_argument("--db-url", default=os.environ.get("RTGAIA_DB_URL", ""))
    parser.add_argument(
        "--library",
        default=os.environ.get("RTGAIA_LIBRARY_ROOT", "") or (os.path.abspath("data") if os.path.isdir("data") else ""),
    )
    parser.add_argument("--data-dir", default=os.environ.get("RTGAIA_DATA_DIR", ""))
    parser.add_argument("--port", type=int, default=None, help="Override the receiver port from the settings")
    parser.add_argument("--host", default=None, help="Override the bind address from the settings")
    parser.add_argument(
        "--ae-title",
        default=None,
        help="Override RTGAIA_AE_TITLE (an AE title saved on the Service settings page still takes precedence)",
    )
    args = parser.parse_args()
    if not args.db_url:
        raise SystemExit("rtgaia-scp needs --db-url or RTGAIA_DB_URL (the job queue is in PostgreSQL)")
    os.environ["RTGAIA_LIBRARY_ROOT"] = args.library
    if args.ae_title:
        os.environ["RTGAIA_AE_TITLE"] = args.ae_title
    if args.data_dir:
        os.environ["RTGAIA_DATA_DIR"] = os.path.abspath(args.data_dir)
    os.environ["RTGAIA_SCP"] = "1"  # 這個行程存在的目的就是接收
    state = make_state()
    state.db_url = args.db_url
    state.library_root = args.library
    state.auth_mode = "off"
    state.subscribe = True  # 收 settings.changed／nodes.changed
    state.owns_live_cases = False
    asyncio.run(_run(state, args.port, args.host))


if __name__ == "__main__":
    main()
