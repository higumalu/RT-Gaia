"""引擎登錄：名字 → `run(input, workdir, progress) -> CalcResult`。引擎在自己的行程裡跑（`cli.py`）。"""

from __future__ import annotations

import os
from collections.abc import Callable
from typing import Any

PIPELINE_TEST = "pipeline-test"
TOPAS = "topas"
GPU = "gpu"

Progress = Callable[[str, float, str], None]


def get(name: str) -> Callable[..., Any]:
    if name == PIPELINE_TEST:
        from .pipeline_test import run

        return run
    if name == TOPAS:
        from .topas import run

        return run
    if name == GPU:
        from ..gpumc.engine import run

        return run
    raise KeyError(f"沒有引擎 {name}")


def available() -> list[dict[str, Any]]:
    """這台機器上能用的引擎（API 列給介面）：OpenTOPAS 要有 docker、映像與 Geant4 物理資料；GPU 引擎另外要 CuPy 與
    NVIDIA GPU；測試引擎只在
    `RTGAIA_DOSECALC_TEST_ENGINE=1` 時列出（它不是劑量計算）。"""
    from .. import gpumc
    from .topas import status

    topas_status = status()
    out: list[dict[str, Any]] = [{"name": TOPAS, **topas_status}]
    gpu = gpumc.status()
    if gpu["ready"] and not topas_status["ready"]:
        # 物理表在 OpenTOPAS 映像裡的 Geant4 產生：映像不能用，GPU 引擎也不能用
        gpu = {"ready": False, "reason": f"物理表要用 OpenTOPAS 映像產生：{topas_status.get('reason')}"}
    if gpu["ready"]:
        from ..gpumc.engine import ENGINE_VERSION

        gpu = {**gpu, "version": ENGINE_VERSION}
    # 能用 GPU 就排第一（介面預設選第一個能用的）：統計量大一百倍，雜訊不再主導比對結果；OpenTOPAS 當參考引擎
    out.insert(0 if gpu["ready"] else len(out), {"name": GPU, **gpu})
    if os.environ.get("RTGAIA_DOSECALC_TEST_ENGINE") == "1":
        out.append({"name": PIPELINE_TEST, "ready": True, "reason": "", "test_only": True})
    return out


def cancel(label: str) -> None:
    """停掉這個工作在引擎那邊還在跑的東西（OpenTOPAS 的容器）。引擎行程本身由呼叫端殺掉。"""
    from .topas import cancel as topas_cancel

    try:
        topas_cancel(label)
    except Exception:  # noqa: BLE001 - 取消是盡力而為：沒有 docker 也不能讓取消失敗
        pass
