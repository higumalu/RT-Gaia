"""啟動／關閉從棄用的 `on_event` 換成 lifespan。

* 建 app 不再出 `on_event` 的 DeprecationWarning（以前每建一個 app 一則，整套測試上千則）。
* 進場：行程內 worker、背景工作起來、記住 event loop；離場：全部取消、匯流排停掉。
* 啟動途中出例外（例：DIMSE 設定讀不到）不擋 API；離場照樣收乾淨。
"""

from __future__ import annotations

import warnings

from fastapi.testclient import TestClient
from rtgaia_testbe.app import create_app


def test_lifespan_starts_and_stops_background_tasks(monkeypatch) -> None:  # type: ignore[no-untyped-def]
    monkeypatch.delenv("RTGAIA_DB_URL", raising=False)
    monkeypatch.setenv("RTGAIA_PLUGIN_TICK_SECONDS", "60")
    monkeypatch.setenv("RTGAIA_RETENTION_TICK_SECONDS", "0")
    with warnings.catch_warnings(record=True) as caught:
        warnings.simplefilter("always")
        app = create_app(test_api=True)
    assert not [w for w in caught if "on_event" in str(w.message)]
    state = app.state.rtgaia
    with TestClient(app) as client:
        assert client.get("/healthz").status_code == 200
        assert state.loop is not None
        worker, plugin_ticks = state.worker_task, state.plugin_tick_task
        assert worker is not None and not worker.done() and plugin_ticks is not None and not plugin_ticks.done()
    assert worker.done() and plugin_ticks.done()


def test_startup_failure_in_one_part_does_not_block(monkeypatch) -> None:  # type: ignore[no-untyped-def]
    monkeypatch.delenv("RTGAIA_DB_URL", raising=False)
    app = create_app(test_api=True)
    state = app.state.rtgaia

    async def broken(*_a, **_k):  # type: ignore[no-untyped-def]
        raise RuntimeError("設定讀不到")

    monkeypatch.setattr(state, "dimse_settings_async", broken)
    with TestClient(app) as client:
        assert client.get("/healthz").status_code == 200
        assert "設定讀不到" in (state.scp_error or "")
        worker = state.worker_task
    assert worker is not None and worker.done()
