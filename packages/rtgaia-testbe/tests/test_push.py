"""Push 通道。"""

from __future__ import annotations

import asyncio

import numpy as np
import pytest
from rtgaia_core.push import MAX_MESSAGE_BYTES, SERVER_MESSAGES, SLOW_PEER_CLOSE_CODE, PushHub


def test_scene_is_pushed_on_connect(client, tilt) -> None:
    """連上就先送一次完整場景，前端不必先打 HTTP 才有東西可畫。"""
    with client.websocket_connect("/api/v1/session/current/events") as ws:
        message = ws.receive_json()
    assert message["type"] == "scene.replace"
    scene = message["payload"]
    assert scene["gridSet"]["mask_grid"]["mask_grid_id"] == tilt.mask_grid_id
    assert any(layer["kind"] == "mask" for layer in scene["layers"])


def test_hello_is_acknowledged(client, landmark) -> None:
    with client.websocket_connect("/api/v1/session/current/events") as ws:
        ws.receive_json()
        ws.send_json({"type": "session.hello", "payload": {"webgl2": True, "tier": "A"}})
        ack = ws.receive_json()
    assert ack["payload"]["phase"] == "acknowledged"


def test_unknown_client_message_gets_error(client, landmark) -> None:
    with client.websocket_connect("/api/v1/session/current/events") as ws:
        ws.receive_json()
        ws.send_json({"type": "nonsense"})
        err = ws.receive_json()
    assert err["type"] == "error"
    assert err["payload"]["code"] == "UNKNOWN_CLIENT_MESSAGE"


def test_mask_updated_is_pushed_after_edit(client, tilt) -> None:
    """通知前端該結構已變（**前端自行重取**，不推體素）。"""
    with client.websocket_connect("/api/v1/session/current/events") as ws:
        ws.receive_json()
        tilt.edit(
            "lesion",
            offset_ijk=(300, 300, 40),
            array=np.ones((1, 2, 2), dtype=np.uint8),
            client_seq=1,
        )
        message = ws.receive_json()
    assert message["type"] == "mask.updated"
    assert message["payload"]["structureId"] == "lesion"
    assert message["payload"]["contentHash"].startswith("mh_")
    assert "data" not in message["payload"]


def test_layer_add_is_pushed_on_injection(client, landmark) -> None:
    with client.websocket_connect("/api/v1/session/current/events") as ws:
        ws.receive_json()
        arr = np.ones((2, 4, 4), dtype=np.uint8)
        landmark.push_mask("Injected", arr, offset_ijk=(10, 10, 5))
        message = ws.receive_json()
    assert message["type"] == "layer.add"
    assert message["payload"]["kind"] == "mask"
    assert message["payload"]["renderStyle"] == "outline"


def test_job_progress_is_pushed_during_export(client, driver) -> None:
    driver.load("phantom:overlap_set")
    with client.websocket_connect("/api/v1/session/current/events") as ws:
        ws.receive_json()
        job_id = driver.export_rtstruct(["gtv"])["job_id"]
        phases = []
        for _ in range(6):
            message = ws.receive_json()
            if message["type"] == "job.progress":
                phases.append(message["payload"]["phase"])
                if message["payload"]["percent"] == 100:
                    break
    assert job_id
    assert "done" in phases


@pytest.mark.asyncio
async def test_message_size_cap_is_enforced() -> None:
    """🔴 **推送只送 metadata；體素資料一律走 HTTP GET。**

    這條規則以執行期斷言表達，不是註解——否則第一個「先塞進 WS 試試」的改動
    會靜默通過。
    """
    hub = PushHub()
    with pytest.raises(ValueError) as exc:
        await hub.send("s1", "layer.add", {"blob": "x" * (MAX_MESSAGE_BYTES + 1)})
    assert "體素" in str(exc.value)


@pytest.mark.asyncio
async def test_oversized_scene_becomes_refetch_notice() -> None:
    """`scene.replace` 是 metadata，大小隨圖層數長（CCTH-A06 攤開 62 幀 385 KB）——
    撞上限改送 `{refetch: true}`，前端走 `GET /sessions/{id}/scene`；以前丟例外 → 畫面不動、連上時整片黑。"""
    hub = PushHub()
    big = {"sessionId": "s1", "caseId": "c1", "layers": ["x" * (MAX_MESSAGE_BYTES + 1)]}
    await hub.send("s1", "scene.replace", big)
    (msg,) = hub.history
    assert msg["type"] == "scene.replace" and msg["payload"]["refetch"] is True
    assert msg["payload"]["sessionId"] == "s1" and msg["payload"]["caseId"] == "c1"
    assert msg["payload"]["bytes"] > MAX_MESSAGE_BYTES == msg["payload"]["limit"]
    assert "layers" not in msg["payload"] and hub.oversized == 1


@pytest.mark.asyncio
async def test_undefined_message_type_is_refused() -> None:
    hub = PushHub()
    with pytest.raises(ValueError):
        await hub.send("s1", "layer.explode", {})
    assert set(SERVER_MESSAGES) == {
        "scene.replace",
        "layer.add",
        "layer.update",
        "layer.remove",
        "mask.updated",
        "camera.set",
        "job.progress",
        "error",
        "catalog.changed",
        "presence",
        "structure_sets.changed",
        "plugins.changed",
        "service.received",
    }


def test_camera_set_carries_full_view_reference(client, landmark) -> None:
    """斜面沒有 slice index，因此 camera.set 必須帶完整平面。"""
    with client.websocket_connect("/api/v1/session/current/events") as ws:
        ws.receive_json()
        landmark.set_camera(
            view_plane_normal=(0.0, 0.5, 0.8660254037844386),
            view_up=(0.0, 0.8660254037844386, -0.5),
            slab_mm=3.0,
        )
        message = ws.receive_json()
    view = message["payload"]["viewReference"]
    assert message["type"] == "camera.set"
    assert view["slab_thickness_mm"] == 3.0
    assert view["display_grid_id"] == landmark.display_grid_id
    assert "slice_index" not in view


# ── 一個慢的接收端不能拖住其他人 ───────────────────────────


class _FakeWs:
    """`send_text` 可以卡住（`gate` 沒開就一直等）；記錄收到的訊息與 close code。"""

    def __init__(self, *, blocked: bool = False) -> None:
        self.got: list[dict] = []
        self.closed: int | None = None
        self.gate = asyncio.Event()
        if not blocked:
            self.gate.set()

    async def accept(self) -> None:
        return None

    async def send_text(self, text: str) -> None:
        await self.gate.wait()
        import json

        self.got.append(json.loads(text))

    async def close(self, code: int = 1000) -> None:
        self.closed = code


async def _settle() -> None:
    await asyncio.sleep(0.05)  # 讓每條連線的送出 task 跑完排隊中的訊息


@pytest.mark.asyncio
async def test_slow_peer_does_not_block_others_and_times_out() -> None:
    """重現：第一個 socket 永遠等、第二個正常 → 以前第二個收不到、呼叫 publish 的請求也卡住。"""
    hub = PushHub(send_timeout_s=0.2)
    slow, fast = _FakeWs(blocked=True), _FakeWs()
    c_slow = await hub.connect("s1", slow)
    await hub.connect("s1", fast)
    n = await asyncio.wait_for(hub.send("s1", "layer.add", {"layerId": "mask:a"}), timeout=0.05)
    assert n == 2
    await _settle()
    assert [m["payload"]["layerId"] for m in fast.got] == ["mask:a"]
    await asyncio.sleep(0.35)  # 慢的那條逾時 → 斷線（1013）、從 session 拿掉
    assert slow.closed == SLOW_PEER_CLOSE_CODE and c_slow.closed and hub.count("s1") == 1 and hub.evicted == 1
    await hub.send("s1", "layer.add", {"layerId": "mask:b"})
    await _settle()
    assert [m["payload"]["layerId"] for m in fast.got] == ["mask:a", "mask:b"]


@pytest.mark.asyncio
async def test_queue_is_bounded_and_scene_progress_coalesce_in_order() -> None:
    hub = PushHub(max_queued_messages=5)
    ws = _FakeWs(blocked=True)
    conn = await hub.connect("s1", ws)
    await hub.send("s1", "layer.add", {"layerId": "first"})  # 送出中（卡住）
    await _settle()
    await hub.send("s1", "scene.replace", {"n": 1})
    await hub.send("s1", "layer.add", {"layerId": "L"})
    await hub.send("s1", "job.progress", {"jobId": "j", "phase": "a", "percent": 10})
    await hub.send("s1", "scene.replace", {"n": 2})
    await hub.send("s1", "job.progress", {"jobId": "j", "phase": "b", "percent": 50})
    assert len(conn.pending) == 3 and conn.coalesced == 2  # 舊的 scene、舊的進度不用送
    ws.gate.set()
    await _settle()
    assert [(m["type"], m["payload"]) for m in ws.got] == [
        ("layer.add", {"layerId": "first"}),
        ("layer.add", {"layerId": "L"}),
        ("scene.replace", {"n": 2}),
        ("job.progress", {"jobId": "j", "phase": "b", "percent": 50}),
    ]
    # 不能合併的訊息排超過上限 → 斷線，佇列清掉（記憶體有上限）
    ws2 = _FakeWs(blocked=True)
    c2 = await hub.connect("s2", ws2)
    for n in range(7):
        await hub.send("s2", "layer.add", {"layerId": f"m{n}"})
    await _settle()
    assert c2.closed and ws2.closed == SLOW_PEER_CLOSE_CODE and len(c2.pending) == 0 and hub.count("s2") == 0
