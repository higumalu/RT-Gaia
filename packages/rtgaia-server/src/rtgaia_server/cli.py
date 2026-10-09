"""`rtgaia-server` 命令列：正式後端。合成假體、chaos、`--test-api` 在 `rtgaia-testbe`（`rtgaia_testbe.cli`）。"""

from __future__ import annotations

import argparse
import os

import uvicorn


def build_parser(*, prog: str = "rtgaia-server", test_api: bool = False) -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog=prog,
        description="RT-Gaia API server"
        + ("; synthetic phantoms and fault-injection endpoints are mounted only with --test-api" if test_api else ""),
    )
    parser.add_argument("--port", type=int, default=8080)
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--data", default="", help="Fixtures directory (real DICOM)")
    parser.add_argument("--latency", type=int, default=0, help="Delay every response by N ms (chaos)")
    parser.add_argument(
        "--chaos",
        default="",
        help="Chaos modes enabled at startup, comma-separated, for example grid_mismatch,truncate",
    )
    parser.add_argument(
        "--load",
        default="",
        help=(
            "Source loaded at startup: phantom:<id> or dicom:<directory>"
            if test_api
            else "Case loaded at startup: dicom:<directory>"
        )
        + " (every CT, RTSTRUCT, RTDOSE and REG file in it)",
    )
    parser.add_argument(
        "--library",
        default="",
        help="Library root directory (what the Library page searches); also RTGAIA_LIBRARY_ROOT. "
        "Default: ./data if it exists",
    )
    parser.add_argument(
        "--show-patient-names",
        action="store_true",
        help="Send PatientName to the Library page (by default only PatientID)",
    )
    parser.add_argument(
        "--data-dir",
        default="",
        help="Data directory for stored files, staging and caches; also RTGAIA_DATA_DIR. "
        "Without it, hidden directories inside the library root are used (<library>/.rtgaia, <library>/.cache)",
    )
    parser.add_argument(
        "--db-url",
        default="",
        help="PostgreSQL URL of the catalog, for example postgresql+asyncpg://rtgaia:rtgaia@127.0.0.1:5433/rtgaia; "
        "also RTGAIA_DB_URL. Without it, only an in-memory index and JSON caches are used",
    )
    if test_api:
        parser.add_argument(
            "--test-api",
            action="store_true",
            help="Mount /api/v1/_test/* (phantom loading, arbitrary pushes, mask injection, global chaos) for "
            "development and end-to-end tests. Never in production: it bypasses ownership, sign-off locks and "
            "auditing. Also RTGAIA_TEST_API=1",
        )
    parser.add_argument(
        "--public-url",
        default="",
        help="External URL of this server (plugin callbacks, Host allow-list), for example "
        "https://rtgaia.hospital.local; also RTGAIA_PUBLIC_URL. Required when RTGAIA_AUTH=required",
    )
    parser.add_argument("--reload", action="store_true")
    return parser


def run(args: argparse.Namespace, *, asgi: str) -> None:
    if args.public_url:
        os.environ["RTGAIA_PUBLIC_URL"] = args.public_url

    os.environ.setdefault("RTGAIA_TESTBE_DATA", args.data)
    os.environ["RTGAIA_TESTBE_LATENCY"] = str(args.latency)
    os.environ["RTGAIA_TESTBE_CHAOS"] = args.chaos
    os.environ["RTGAIA_TESTBE_LOAD"] = args.load
    if getattr(args, "test_api", False):
        os.environ["RTGAIA_TEST_API"] = "1"
    library = args.library or os.environ.get("RTGAIA_LIBRARY_ROOT", "")
    if not library and os.path.isdir("data"):
        library = os.path.abspath("data")
    os.environ["RTGAIA_LIBRARY_ROOT"] = library
    if args.show_patient_names:
        os.environ["RTGAIA_LIBRARY_SHOW_NAMES"] = "1"
    if args.db_url:
        os.environ["RTGAIA_DB_URL"] = args.db_url
    if args.data_dir:
        os.environ["RTGAIA_DATA_DIR"] = os.path.abspath(args.data_dir)

    uvicorn.run(
        asgi,
        host=args.host,
        port=args.port,
        reload=args.reload,
        log_level="info",
    )


def main() -> None:
    run(build_parser().parse_args(), asgi="rtgaia_server.asgi:app")


if __name__ == "__main__":
    main()
