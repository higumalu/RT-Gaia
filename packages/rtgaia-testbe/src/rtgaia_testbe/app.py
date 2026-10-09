"""`rtgaia-testbe` 的 `create_app()`：正式後端 ＋ `/api/v1/_test/*`（假體載入、任意推送、注入 mask、全域 chaos）。

測試端點是**這裡**掛的：core 不認識 testbe、server 永不掛。"""

from __future__ import annotations

import os
from typing import Any

from fastapi import FastAPI
from rtgaia_core.api import create_app as _create_core_app
from rtgaia_core.api.deps import AppState
from rtgaia_server.adapters import SqlAdapters


def install_test_api(app: FastAPI, state: AppState) -> None:
    from .api.routes_test import router

    app.include_router(router)


def create_app(**kwargs: Any) -> FastAPI:
    """與舊 `rtgaia_testbe.api.create_app` 同參數。`test_api`：參數 > 環境變數 `RTGAIA_TEST_API` > False。"""
    kwargs.setdefault("adapters", SqlAdapters())
    test_api = kwargs.get("test_api")
    if test_api is None:
        test_api = os.environ.get("RTGAIA_TEST_API", "").strip().lower() in ("1", "true", "yes")
    kwargs["test_api"] = bool(test_api)
    if kwargs["test_api"]:
        kwargs.setdefault("test_api_installer", install_test_api)
    return _create_core_app(**kwargs)
