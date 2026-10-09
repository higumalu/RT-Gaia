"""🔴 故障注入 —— 一種模式一個測試。

> 不變式 I1–I4 要求前端**拒絕**不合法的資料。**若測試後端永遠守規矩，
> 那些拒絕邏輯就是死碼。**

這個檔案驗證的是**兩件事**，不是一件：

1. chaos 真的把資料弄壞了（否則注入是空的）
2. **共用幾何核心會拒絕它** —— `rtgaia-geom` 是前端 `core/geometry` 的鏡像，
   因此這裡的每一條同時證明了「前端有東西可以拒絕」

前端側的一對一對照表見 `apps/viewer/tests/chaos-matrix.test.ts`。
"""

from __future__ import annotations

import time

import numpy as np
import pytest
from rtgaia_core.chaos import MODES
from rtgaia_geom import ContractViolation, DisplayGrid, Grid, MaskGrid, decode
from rtgaia_geom.codec import _PREAMBLE
from rtgaia_geom.payload import VoxelPayloadDescriptor
from starlette.websockets import WebSocketDisconnect
from websockets.exceptions import WebSocketException as WebSocketDisconnectError


def _raw_frame(client, path: str, **params: object) -> bytes:
    r = client.get(path, params=params)
    assert r.status_code == 200, r.text
    return bytes(r.content)


def _header_only(frame: bytes) -> dict:
    import json

    _magic, _v, _r, hlen = _PREAMBLE.unpack_from(frame, 0)
    return json.loads(frame[_PREAMBLE.size : _PREAMBLE.size + hlen])


def test_all_declared_modes_are_settable(driver) -> None:
    """共 9 種模式（含 push_limit）；一種都不能少。"""
    driver.load("phantom:landmark")
    assert set(MODES) == {
        "grid_mismatch",
        "fractional_offset",
        "missing_direction",
        "stale_hash",
        "latency",
        "truncate",
        "disconnect",
        "wrong_size",
        "push_limit",
    }
    for mode in MODES:
        value = {"latency": 5, "push_limit": 4096}.get(mode, True)
        state = driver.chaos(reset=True, **{mode: value})
        assert state["active"], f"{mode} 設不起來"


# ── grid_mismatch → I3 ──────────────────────────────────────────────────────


def test_grid_mismatch_corrupts_mask_grid_id(client, tilt) -> None:
    """前端應**拒絕合成並明確報錯，不得嘗試自動對齊**（I3）。"""
    good = _header_only(_raw_frame(client, "/api/v1/structures/lesion/mask", mask_grid=tilt.mask_grid_id))
    tilt.chaos(grid_mismatch=True)
    bad = _header_only(_raw_frame(client, "/api/v1/structures/lesion/mask", mask_grid=tilt.mask_grid_id))
    assert good["mask_grid_id"] == tilt.mask_grid_id
    assert bad["mask_grid_id"] != tilt.mask_grid_id
    assert "chaos_mismatch" in bad["mask_grid_id"]

    from rtgaia_geom import assert_same_family

    with pytest.raises(ContractViolation) as exc:
        assert_same_family(
            payload_grid_ref=bad["mask_grid_id"],
            session_grid_id=tilt.mask_grid_id,
            family="mask",
        )
    assert exc.value.code == "I3"


def test_grid_mismatch_also_hits_json_endpoints(client, tilt) -> None:
    """`GridSet` 也要能被弄壞，否則前端只在 payload 路徑上有防護。"""
    tilt.chaos(grid_mismatch=True)
    gs = tilt.grids(webgl2=True, tier="A", probe_fps=60)
    assert "chaos_mismatch" in gs["mask_grid"]["mask_grid_id"]


# ── fractional_offset → I1 ─────────────────────────────────────────────────


def test_fractional_offset_is_rejected_by_the_contract(client, tilt) -> None:
    """整數 offset 是 I1。非整數必須**拒絕載入**，不得四捨五入。"""
    tilt.chaos(fractional_offset=True)
    header = _header_only(_raw_frame(client, "/api/v1/structures/lesion/mask", mask_grid=tilt.mask_grid_id))
    assert header["offset_ijk"][0] != int(header["offset_ijk"][0])

    with pytest.raises(ContractViolation) as exc:
        VoxelPayloadDescriptor(
            grid_ref=header["mask_grid_id"],
            frame_of_reference_uid=header["frame_of_reference_uid"],
            offset_ijk=tuple(header["offset_ijk"]),
            size_ijk=tuple(header["size_ijk"]),
            dtype="uint8",
            components=1,
            semantics="binary_mask",
            content_hash=header["content_hash"],
        )
    assert exc.value.code == "I1"


def test_fractional_offset_hits_display_grid_too(tilt) -> None:
    tilt.chaos(fractional_offset=True)
    gs = tilt.grids(webgl2=True, tier="A", probe_fps=60)
    with pytest.raises(ContractViolation) as exc:
        DisplayGrid.from_wire(gs["display_grid"])
    assert exc.value.code == "I1"


# ── missing_direction → G4 ─────────────────────────────────────────────────


def test_missing_direction_is_rejected_not_defaulted(client, tilt) -> None:
    """🔴 **拒絕載入，不得預設為單位矩陣。**

    這是整份 chaos 清單裡最重要的一條：預設為單位矩陣**不會報錯**，只會讓
    `gantry_tilt` 的一切偏掉一點點——而那是最難查的一類 bug。
    """
    tilt.chaos(missing_direction=True)
    header = _header_only(
        _raw_frame(
            client,
            f"/api/v1/series/{tilt.grid_set['frame_groups'][0]['series_id']}/image",
            display_grid=tilt.display_grid_id,
        )
    )
    assert "direction" not in header["grid"]
    with pytest.raises(ContractViolation) as exc:
        Grid.from_wire(header["grid"])
    assert exc.value.code == "G4"


def test_missing_direction_hits_gridset(tilt) -> None:
    tilt.chaos(missing_direction=True)
    gs = tilt.grids(webgl2=True, tier="A", probe_fps=60)
    with pytest.raises(ContractViolation) as exc:
        MaskGrid.from_wire(gs["mask_grid"])
    assert exc.value.code == "G4"


# ── truncate → W6 ──────────────────────────────────────────────────────────


def test_truncate_is_detected_before_rendering(client, tilt) -> None:
    """**偵測並報錯，不得渲染半張影像。**"""
    tilt.chaos(truncate=True)
    frame = _raw_frame(
        client,
        f"/api/v1/series/{tilt.grid_set['frame_groups'][0]['series_id']}/image",
        display_grid=tilt.display_grid_id,
        lod=2,
    )
    with pytest.raises(ContractViolation) as exc:
        decode(frame)
    assert exc.value.code == "W6"


def test_truncate_keeps_declared_length_in_header(client, tilt) -> None:
    """🔴 header 的 `body_bytes` 必須**保持原值**。

    若連 header 一起改小，前端只會看到一個「比較短但自洽」的 payload——
    什麼都測不到。這一條就是在防止 chaos 自己失效。
    """
    tilt.chaos(truncate=True)
    frame = _raw_frame(
        client,
        f"/api/v1/series/{tilt.grid_set['frame_groups'][0]['series_id']}/image",
        display_grid=tilt.display_grid_id,
        lod=2,
    )
    header = _header_only(frame)
    _magic, _v, _r, hlen = _PREAMBLE.unpack_from(frame, 0)
    actual_body = len(frame) - _PREAMBLE.size - hlen
    assert header["wire"]["body_bytes"] > actual_body


# ── wrong_size → I9 ────────────────────────────────────────────────────────


def test_wrong_size_is_rejected(client, tilt) -> None:
    """`size_ijk` 與實際資料量不符 → 拒絕載入。"""
    tilt.chaos(wrong_size=True)
    frame = _raw_frame(client, "/api/v1/structures/lesion/mask", mask_grid=tilt.mask_grid_id)
    header, raw = decode(frame)  # wire 層是自洽的，錯在描述子
    d = VoxelPayloadDescriptor(
        grid_ref=header["mask_grid_id"],
        frame_of_reference_uid=header["frame_of_reference_uid"],
        offset_ijk=tuple(header["offset_ijk"]),
        size_ijk=tuple(header["size_ijk"]),
        dtype="uint8",
        components=1,
        semantics="binary_mask",
        content_hash=header["content_hash"],
    )
    with pytest.raises(ContractViolation) as exc:
        d.decode(raw)
    assert exc.value.code == "I9"


# ── stale_hash → 409 ───────────────────────────────────────────────────────


def test_stale_hash_always_conflicts(tilt) -> None:
    """前端應重取 mask ＋ 提示使用者。"""
    header, _ = tilt.mask("lesion")
    tilt.chaos(stale_hash=True)
    with pytest.raises(RuntimeError) as exc:
        tilt.edit(
            "lesion",
            offset_ijk=(300, 300, 40),
            array=np.ones((1, 2, 2), dtype=np.uint8),
            base_content_hash=header["content_hash"],
            client_seq=1,
        )
    assert "409" in str(exc.value)
    assert "chaos:stale_hash" in str(exc.value)


def test_stale_hash_reports_current_hash_for_refetch(client, tilt) -> None:
    """409 必須帶當前 hash，否則前端重取後還是不知道基準是什麼。"""
    header, _ = tilt.mask("lesion")
    tilt.chaos(stale_hash=True)
    r = client.post(
        "/api/v1/structures/lesion/edit",
        json={
            "mask_grid_id": tilt.mask_grid_id,
            "base_content_hash": header["content_hash"],
            "offset_ijk": [0, 0, 0],
            "size_ijk": [1, 1, 1],
            "data": "AQ==",
            "client_seq": 1,
            "view_reference": tilt.view_reference(),
        },
    )
    assert r.status_code == 409
    assert r.json()["content_hash"] == header["content_hash"]


# ── latency ────────────────────────────────────────────────────────────────


def test_latency_delays_every_response(driver) -> None:
    """驗證前端的載入指示、漸進式 lod、**不得出現空白畫面**。"""
    driver.load("phantom:landmark")
    driver.chaos(latency=120)
    start = time.perf_counter()
    driver.health()
    elapsed = (time.perf_counter() - start) * 1000
    assert elapsed >= 100, f"只花了 {elapsed:.0f} ms"
    driver.chaos(reset=True)


# ── disconnect ─────────────────────────────────────────────────────────────


def test_disconnect_closes_the_socket(driver) -> None:
    """驗證前端**重連並重新同步**。"""
    driver.load("phantom:landmark")
    driver.chaos(disconnect=True, disconnect_probability=1.0)
    # 收窄到真正預期的例外：blind `Exception` 連 AssertionError 與型別錯誤都會
    # 吞掉，於是「測試綠」不再代表「socket 真的被關了」。
    with pytest.raises((WebSocketDisconnect, WebSocketDisconnectError)):
        with driver._client.websocket_connect("/api/v1/session/current/events") as ws:
            ws.receive_json()  # scene.replace
            ws.send_json({"type": "ack"})
            for _ in range(5):
                ws.receive_json()
    driver.chaos(reset=True)


# ── push_limit ─────────────────────────────────────────────────────────────


def test_push_limit_sends_refetch_and_scene_is_on_http(driver) -> None:
    """`scene.replace` 超過推送上限 → 改送 `{refetch: true}`（連上時那一則也是），完整場景在
    `GET /sessions/{id}/scene`；reset 之後連上又是完整場景。"""
    driver.load("phantom:landmark")
    sid = driver.session_id
    driver.chaos(push_limit=512)
    with driver._client.websocket_connect("/api/v1/session/current/events") as ws:
        msg = ws.receive_json()
    assert msg["type"] == "scene.replace" and msg["payload"]["refetch"] is True and msg["payload"]["limit"] == 512
    assert msg["payload"]["sessionId"] == sid and "layers" not in msg["payload"]
    scene = driver._client.get(f"/api/v1/sessions/{sid}/scene").json()
    assert scene["sessionId"] == sid and scene["layers"] and scene["gridSet"]
    assert driver._client.get("/api/v1/sessions/nope/scene").status_code == 404
    driver.chaos(reset=True)
    with driver._client.websocket_connect("/api/v1/session/current/events") as ws:
        msg = ws.receive_json()
    assert "refetch" not in msg["payload"] and msg["payload"]["layers"]


# ── 反向保證：關掉之後一切正常 ──────────────────────────────────────────────


def test_reset_restores_valid_payloads(client, tilt) -> None:
    """🔴 這條與上面每一條同等重要。

    chaos 若在 reset 後仍留下殘餘，整個測試套件的其餘部分都會變成偽陰性。
    """
    tilt.chaos(grid_mismatch=True, truncate=True, fractional_offset=True, missing_direction=True)
    tilt.chaos(reset=True)
    assert tilt.chaos_state()["active"] == []
    frame = _raw_frame(client, "/api/v1/structures/lesion/mask", mask_grid=tilt.mask_grid_id)
    header, raw = decode(frame)
    assert header["mask_grid_id"] == tilt.mask_grid_id
    assert all(isinstance(v, int) for v in header["offset_ijk"])
    d = VoxelPayloadDescriptor(
        grid_ref=header["mask_grid_id"],
        frame_of_reference_uid=header["frame_of_reference_uid"],
        offset_ijk=tuple(header["offset_ijk"]),
        size_ijk=tuple(header["size_ijk"]),
        dtype="uint8",
        components=1,
        semantics="binary_mask",
        content_hash=header["content_hash"],
    )
    assert d.decode(raw).sum() > 0
