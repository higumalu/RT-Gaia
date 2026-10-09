"""接收端交批。

每個 instance 寫進暫存區就回 0x0000，所以暫存區裡的每一批都一定要進匯入佇列。以前交批錯誤被吞掉（future 沒人看、
`except Exception: pass`、event loop 還沒設就略過），對方以為送成功、資料停在暫存區，沒有 log。
現在：失敗記下來、清掃執行緒重試；行程重啟時把沒有 `.queued` 的批次補交。
"""

from __future__ import annotations

import json
import shutil
import time
from pathlib import Path
from typing import Any

import pytest
from rtgaia_core import dimse
from rtgaia_core.api.deps import AppState
from test_dimse import _free_port


def _batch(staging: Path, batch_id: str, calling_aet: str = "PACS") -> dict[str, Any]:
    d = staging / batch_id
    d.mkdir(parents=True)
    (d / "1.2.3.dcm").write_bytes(b"DICM")
    return {"batch_id": batch_id, "dir": d, "calling_aet": calling_aet, "received": 1, "unsupported": 0, "last_at": 0}


def test_failed_handoff_is_recorded_and_retried(tmp_path: Path) -> None:
    staging = tmp_path / "scp"
    calls: list[tuple[str, dict[str, Any]]] = []
    down = {"on": True}

    def on_batch(d: Path, meta: dict[str, Any]) -> None:
        if down["on"]:
            raise RuntimeError("queue down")
        calls.append((d.name, meta))

    scp = dimse.ReceiveServer(staging_root=staging, on_batch=on_batch, ae_title="GAIA_T", port=_free_port())
    scp._finish(_batch(staging, "scp_a"))  # association 結束 → 交批失敗：不能弄掛接收端
    st = scp.status()
    assert st["unqueued_batches"] == 1 and st["handoff_failures"] == 1 and "queue down" in st["last_handoff_error"]
    assert not (staging / "scp_a.queued").exists() and (staging / "scp_a").is_dir()

    down["on"] = False
    assert scp.retry_unhanded() == 1
    assert [c[0] for c in calls] == ["scp_a"] and calls[0][1]["calling_aet"] == "PACS"
    assert (staging / "scp_a.queued").exists() and scp.status()["unqueued_batches"] == 0


def test_restart_queues_batches_left_in_the_staging_area(tmp_path: Path) -> None:
    staging = tmp_path / "scp"
    queued_before = _batch(staging, "scp_done")
    (staging / "scp_done.queued").write_text("x", encoding="utf-8")
    _batch(staging, "scp_left")  # 上次交批失敗、或行程在交批前停掉
    (staging / "scp_left.json").write_text(json.dumps({"batch_id": "scp_left", "calling_aet": "TPS"}), encoding="utf-8")
    calls: list[tuple[str, dict[str, Any]]] = []
    scp = dimse.ReceiveServer(
        staging_root=staging, on_batch=lambda d, m: calls.append((d.name, m)), ae_title="GAIA_T", port=_free_port()
    )
    assert scp.recover_orphans() == 1
    assert calls == [("scp_left", {"batch_id": "scp_left", "calling_aet": "TPS", "recovered": True})]
    assert scp.recover_orphans() == 0  # 交過的不再交
    # 匯入完、暫存目錄清掉了 → 旁邊的標記也清掉
    shutil.rmtree(queued_before["dir"])
    scp.recover_orphans()
    assert not (staging / "scp_done.queued").exists()
    assert sorted(p.name for p in staging.iterdir()) == ["scp_left", "scp_left.json", "scp_left.queued"]


def test_sweeper_thread_recovers_and_retries(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """接收端起來時清掃執行緒先補交暫存區裡的批次；之後交批失敗的按間隔重試（這裡縮短成 0.2 秒）。"""
    monkeypatch.setattr(dimse, "HANDOFF_RETRY_SECONDS", 0.2)
    staging = tmp_path / "scp"
    _batch(staging, "scp_left")
    calls: list[str] = []
    down = {"on": False}

    def on_batch(d: Path, _meta: dict[str, Any]) -> None:
        if down["on"]:
            raise RuntimeError("queue down")
        calls.append(d.name)

    scp = dimse.ReceiveServer(
        staging_root=staging, on_batch=on_batch, ae_title="GAIA_T", port=_free_port(), host="127.0.0.1"
    )
    scp.start()
    try:
        deadline = time.time() + 10
        while "scp_left" not in calls and time.time() < deadline:
            time.sleep(0.05)
        assert calls == ["scp_left"]
        down["on"] = True
        scp._finish(_batch(staging, "scp_new"))
        assert scp.status()["unqueued_batches"] == 1
        down["on"] = False
        deadline = time.time() + 10
        while "scp_new" not in calls and time.time() < deadline:
            time.sleep(0.05)
        assert calls == ["scp_left", "scp_new"] and scp.status()["unqueued_batches"] == 0
    finally:
        scp.stop()


def test_enqueue_without_an_event_loop_raises_instead_of_dropping_the_batch() -> None:
    app = AppState()
    with pytest.raises(RuntimeError, match="event loop"):
        app.enqueue_import_threadsafe("/tmp/x", source="dimse:PACS", detail={})
