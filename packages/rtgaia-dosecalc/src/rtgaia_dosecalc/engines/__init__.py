"""引擎登錄：名字 → `run(input, workdir, progress) -> CalcResult`。引擎在自己的行程裡跑（`cli.py`）。"""

from __future__ import annotations

import os
from collections.abc import Callable
from typing import Any

PIPELINE_TEST = "pipeline-test"
GEANT4 = "geant4"

Progress = Callable[[str, float, str], None]


def get(name: str) -> Callable[..., Any]:
    if name == PIPELINE_TEST:
        from .pipeline_test import run

        return run
    if name == GEANT4:
        from .geant4 import run

        return run
    raise KeyError(f"沒有引擎 {name}")


def available() -> list[dict[str, Any]]:
    """這台機器上能用的引擎（API 列給介面）：Geant4 要裝了 `geant4` extra；測試引擎只在
    `RTGAIA_DOSECALC_TEST_ENGINE=1` 時列出（它不是劑量計算）。"""
    out: list[dict[str, Any]] = []
    try:
        from .geant4 import status

        out.append({"name": GEANT4, **status()})
    except ImportError as exc:
        out.append({"name": GEANT4, "ready": False, "reason": f"沒有安裝 Geant4（{exc}）"})
    if os.environ.get("RTGAIA_DOSECALC_TEST_ENGINE") == "1":
        out.append({"name": PIPELINE_TEST, "ready": True, "reason": "", "test_only": True})
    return out
