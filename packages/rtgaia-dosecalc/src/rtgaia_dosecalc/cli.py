"""`rtgaia-dosecalc run --input DIR --output DIR`：讀計算封包、跑引擎、寫結果。API 用子行程叫它。

`rtgaia-dosecalc check-model --model ID --dataset ID --data-dir DIR --output DIR`：射束模型對射束資料（GPU）；
模型與資料集可以是內建的 id 或 JSON 檔（`--model-json`、`--dataset-json`）；報告寫 `report.json`。

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
    chk = sub.add_parser("check-model", help="Compare a beam model with a beam dataset (GPU)")
    chk.add_argument("--model", help="Built-in beam model id")
    chk.add_argument("--model-json", help="Beam model as a JSON file")
    chk.add_argument("--dataset", help="Built-in beam dataset id")
    chk.add_argument("--dataset-json", help="Beam dataset as a JSON file")
    chk.add_argument("--data-dir", required=True, help="Cache for physics tables and MU calibrations")
    chk.add_argument("--histories", type=float, default=1e9, help="Histories per 10 x 10 setup")
    chk.add_argument("--output", required=True)
    args = ap.parse_args(argv)
    if args.cmd == "engines":
        print(json.dumps(engines.available(), ensure_ascii=False))
        return 0
    if args.cmd == "check-model":
        return _check_model(args)
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


def _check_model(args: argparse.Namespace) -> int:
    from . import beam_data, beam_models, commissioning

    out = Path(args.output)
    out.mkdir(parents=True, exist_ok=True)
    try:
        if args.model_json:
            model = json.loads(Path(args.model_json).read_text(encoding="utf-8"))
        else:
            model = {m["model_id"]: m for m in beam_models.builtin_models()}[args.model]
        if args.dataset_json:
            dataset = json.loads(Path(args.dataset_json).read_text(encoding="utf-8"))
        else:
            dataset = {d["dataset_id"]: d for d in beam_data.builtin_datasets()}[args.dataset]
    except (KeyError, OSError, ValueError) as exc:
        _error(out, f"讀不了模型或資料集：{exc}")
        return 2
    write_progress(out, "starting", 0.0)

    def progress(fraction: float, what: str) -> None:
        write_progress(out, "simulating", 100.0 * fraction, what)

    try:
        report = commissioning.run_gpu(model, dataset, Path(args.data_dir), int(args.histories), progress=progress)
    except Exception as exc:  # noqa: BLE001
        _error(out, f"{type(exc).__name__}: {exc}", traceback.format_exc())
        return 1
    (out / "report.json").write_text(json.dumps(report, ensure_ascii=False), encoding="utf-8")
    write_progress(out, "done", 100.0)
    return 0


def _error(out: Path, message: str, trace: str = "") -> None:
    (out / "error.json").write_text(
        json.dumps({"message": message, "traceback": trace}, ensure_ascii=False), encoding="utf-8"
    )


if __name__ == "__main__":
    sys.exit(main())
