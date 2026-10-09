"""起真 uvicorn 的 helper（e2e 用）。範例 plugin 以檔案路徑載入，不裝進 venv。"""

from __future__ import annotations

import importlib.util
import os
import socket
import sys
import threading
import time
from collections.abc import Iterator
from pathlib import Path

import pytest
import uvicorn
from fastapi import FastAPI

REPO = Path(__file__).resolve().parents[3]
EXAMPLES = REPO / "examples"


def load_plugin_app(example: str, env: dict[str, str] | None = None, module: str = "plugin") -> FastAPI:
    for k, v in (env or {}).items():
        os.environ[k] = v
    path = EXAMPLES / example / f"{module}.py"
    if str(path.parent) not in sys.path:  # plugin.py 可能 import 同目錄的模組（engine.py）
        sys.path.insert(0, str(path.parent))
    spec = importlib.util.spec_from_file_location(f"example_{example.replace('-', '_')}_{module}", path)
    assert spec and spec.loader
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod.app


def free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return int(s.getsockname()[1])


class Served:
    def __init__(self, app: FastAPI) -> None:
        self.port = free_port()
        self.server = uvicorn.Server(uvicorn.Config(app, host="127.0.0.1", port=self.port, log_level="warning"))
        self.thread = threading.Thread(target=self.server.run, daemon=True)

    def __enter__(self) -> Served:
        self.thread.start()
        for _ in range(200):
            if self.server.started:
                return self
            time.sleep(0.05)
        raise RuntimeError("uvicorn 沒起來")

    def __exit__(self, *exc: object) -> None:
        self.server.should_exit = True
        self.thread.join(timeout=5)

    @property
    def url(self) -> str:
        return f"http://127.0.0.1:{self.port}"


@pytest.fixture
def artifacts_dir(tmp_path: Path) -> Iterator[Path]:
    d = tmp_path / "artifacts"
    d.mkdir()
    old = os.environ.get("RTGAIA_PLUGIN_ARTIFACTS")
    os.environ["RTGAIA_PLUGIN_ARTIFACTS"] = str(d)
    yield d
    if old is None:
        os.environ.pop("RTGAIA_PLUGIN_ARTIFACTS", None)
    else:
        os.environ["RTGAIA_PLUGIN_ARTIFACTS"] = old
