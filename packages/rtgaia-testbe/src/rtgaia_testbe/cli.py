"""`rtgaia-testbe` 命令列。

與 `rtgaia-server` 同參數，多 `--test-api`、`--chaos`、`--load phantom:<id>`。"""

from __future__ import annotations

from rtgaia_server.cli import build_parser, run


def main() -> None:
    run(build_parser(prog="rtgaia-testbe", test_api=True).parse_args(), asgi="rtgaia_testbe.asgi:app")


if __name__ == "__main__":
    main()
