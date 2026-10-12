"""`rtgaia-dosecalc run --input DIR --output DIR`：讀計算封包、跑引擎、寫結果。API 用子行程叫它。

退出碼：0 成功；2 輸入有問題；1 引擎失敗（`error.json` 寫原因）。
"""

from __future__ import annotations

import argparse
import json
import sys
import time
import traceback
from pathlib import Path

from . import engines
from .package import CalcInput, write_progress


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(prog="rtgaia-dosecalc")
    sub = ap.add_subparsers(dest="cmd", required=True)
    run = sub.add_parser("run", help="Run a calculation package")
    run.add_argument("--input", required=True)
    run.add_argument("--output", required=True)
    run.add_argument("--engine", default=None, help="Override the engine named in the package (testing)")
    sub.add_parser("engines", help="List the engines available on this machine")
    args = ap.parse_args(argv)
    if args.cmd == "engines":
        print(json.dumps(engines.available(), ensure_ascii=False))
        return 0
    out = Path(args.output)
    out.mkdir(parents=True, exist_ok=True)
    try:
        inp = CalcInput.read(args.input)
    except Exception as exc:  # noqa: BLE001 - 輸入壞掉要說清楚
        _error(out, f"讀不了計算封包：{exc}")
        return 2
    name = args.engine or inp.engine
    try:
        engine = engines.get(name)
    except (KeyError, ImportError) as exc:
        _error(out, str(exc))
        return 2
    write_progress(out, "starting", 0.0)
    last = [0.0]

    def progress(phase: str, percent: float, message: str = "") -> None:
        now = time.time()
        if now - last[0] >= 0.5 or percent >= 100:
            last[0] = now
            write_progress(out, phase, percent, message)

    try:
        result = engine(inp, out, progress)
        result.write(out)
    except Exception as exc:  # noqa: BLE001
        _error(out, f"{type(exc).__name__}: {exc}", traceback.format_exc())
        return 1
    write_progress(out, "done", 100.0)
    return 0


def _error(out: Path, message: str, trace: str = "") -> None:
    (out / "error.json").write_text(
        json.dumps({"message": message, "traceback": trace}, ensure_ascii=False), encoding="utf-8"
    )


if __name__ == "__main__":
    sys.exit(main())
