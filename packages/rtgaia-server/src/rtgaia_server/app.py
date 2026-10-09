"""`rtgaia-server`：正式配置的 `create_app()` ＝ core 的 app ＋ SQL adapters。

**不掛** `/api/v1/_test/*`（沒有 installer 可傳）。"""

from __future__ import annotations

from typing import Any

from fastapi import FastAPI
from rtgaia_core.api import create_app as _create_core_app
from rtgaia_core.api.deps import AppState

from .adapters import SqlAdapters


def create_app(**kwargs: Any) -> FastAPI:
    kwargs.setdefault("adapters", SqlAdapters())
    # 生產配置永遠不掛測試端點：就算環境變數設了 RTGAIA_TEST_API 也一樣（拆層後在型別上就不可能）
    kwargs["test_api"] = False
    return _create_core_app(**kwargs)


def make_state(**fields: Any) -> AppState:
    """獨立行程（worker、scp）用：帶 SQL adapters 的 `AppState`。"""
    state = AppState()
    state.adapters = SqlAdapters()
    for k, v in fields.items():
        setattr(state, k, v)
    return state
