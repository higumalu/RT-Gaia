"""🔴 真 socket 的 end-to-end（不是行程內 TestClient）。

其餘測試走 ASGI 的記憶體傳輸，因此**這些東西從來沒被執行過**：

* 真的 HTTP：chunked 傳輸、`Content-Type`、CORS 與 COOP/COEP 標頭、query 編碼
* 真的 WebSocket：握手、frame 邊界、關閉碼
* uvicorn 的 ASGI 實作（`httptools` / `websockets`），而不是 starlette 的測試替身
* 二進位 payload 經過真的 socket 之後**位元組完全一致**

標記為 `e2e`：`pytest -m "not e2e"` 可跳過（CI 的快速回圈用）。
"""

from __future__ import annotations

import json
import socket
import threading
import time
from collections.abc import Iterator

import numpy as np
import pytest
import uvicorn
import websockets.sync.client as wsc
from rtgaia_geom import ContractViolation, Grid, decode
from rtgaia_testbe import Session
from rtgaia_testbe.api import create_app
from rtgaia_testbe.asgi import app as _default_app

pytestmark = pytest.mark.e2e


def _free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return int(s.getsockname()[1])


class LiveServer:
    """在背景執行緒跑一個真的 uvicorn。"""

    def __init__(self) -> None:
        self.port = _free_port()
        self.app = create_app(test_api=True)
        config = uvicorn.Config(self.app, host="127.0.0.1", port=self.port, log_level="warning", access_log=False)
        self._server = uvicorn.Server(config)
        self._thread = threading.Thread(target=self._server.run, daemon=True)

    @property
    def http(self) -> str:
        return f"http://127.0.0.1:{self.port}"

    @property
    def ws(self) -> str:
        return f"ws://127.0.0.1:{self.port}"

    def start(self, timeout: float = 20.0) -> None:
        self._thread.start()
        deadline = time.time() + timeout
        while time.time() < deadline:
            if self._server.started:
                return
            time.sleep(0.02)
        raise TimeoutError("uvicorn 未在時限內啟動")

    def stop(self) -> None:
        self._server.should_exit = True
        self._thread.join(timeout=10)


@pytest.fixture(scope="module")
def live() -> Iterator[LiveServer]:
    server = LiveServer()
    server.start()
    try:
        yield server
    finally:
        server.stop()


@pytest.fixture
def s(live: LiveServer) -> Iterator[Session]:
    """driver 走**真的 base_url** —— 與行程內 fixture 的唯一差別。"""
    with Session(live.http) as session:
        session.chaos(reset=True)
        yield session
        session.chaos(reset=True)


# ── 伺服器本身 ──────────────────────────────────────────────────────────────


def test_server_is_reachable_over_a_real_socket(s: Session) -> None:
    health = s.health()
    assert health["ok"] is True
    assert health["geom_version"]


def test_coop_coep_headers_survive_the_real_server(live: LiveServer) -> None:
    """Tier C 的 `SharedArrayBuffer` 需要這兩個標頭。

    行程內測試驗證的是中介層有加；**這裡驗證 uvicorn 真的送出來了**。
    """
    import httpx

    response = httpx.get(f"{live.http}/healthz", timeout=10)
    assert response.headers["cross-origin-opener-policy"] == "same-origin"
    assert response.headers["cross-origin-embedder-policy"] == "require-corp"


def test_cors_preflight_allows_the_dev_server(live: LiveServer) -> None:
    """前端 dev server 在不同 port，preflight 必須過。"""
    import httpx

    response = httpx.options(
        f"{live.http}/api/v1/_test/state",
        headers={
            "Origin": "http://localhost:5173",
            "Access-Control-Request-Method": "GET",
        },
        timeout=10,
    )
    assert response.status_code < 400
    assert response.headers.get("access-control-allow-origin")


# ── 完整流程（資料流骨架）──────────────────────────────────────────────


def test_full_flow_over_real_http(s: Session) -> None:
    """load → grids → image → mask → mesh → edit → postprocess → export。"""
    s.load("phantom:gantry_tilt")

    # 兩個網格，且 mask grid 不隨影像降採樣
    grids = s.grids(webgl2=True, tier="A", probe_fps=58, has_norm16=True, max_texture_3d=2048)
    assert grids["assigned_tier"] == "A"
    assert grids["display_grid"]["display_grid_id"].startswith("dg_")
    assert grids["mask_grid"]["mask_grid_id"].startswith("mg_")

    # header 帶完整 direction，且傾斜真的傳過來了
    header, image = s.image(lod=2)
    grid = Grid.from_wire(header["grid"])
    step = grid.index_to_world([0, 0, 1]) - grid.index_to_world([0, 0, 0])
    assert abs(step[1]) > 0.7, "gantry tilt 沒有經過真 socket 傳過來"
    assert image.dtype == np.int16

    # mask 已裁切到 bbox
    mask_header, mask = s.mask("lesion")
    assert mask.shape == (
        mask_header["size_ijk"][2],
        mask_header["size_ijk"][1],
        mask_header["size_ijk"][0],
    )
    assert mask[0].any() and mask[-1].any()

    # mesh 的頂點是世界座標
    mesh_header, vertices, triangles = s.mesh("lesion", lod=1)
    assert mesh_header["vertex_space"] == "world_lps_mm"
    radii = np.linalg.norm(vertices - np.array([51.2, 14.3, 0.0]), axis=1)
    assert radii.mean() == pytest.approx(12.0, abs=1.5)
    assert int(triangles.max()) < len(vertices)

    # 編輯 ＋ provenance
    edit = s.edit(
        "lesion",
        offset_ijk=(300, 300, 40),
        array=np.ones((2, 4, 4), dtype=np.uint8),
        client_seq=1,
    )
    assert edit["provenance"]["source"] == "user-edit"
    assert edit["provenance"]["view_reference"] is not None

    # 後處理
    post = s.postprocess("lesion", "smooth", sigma_mm=1.5)
    assert post["provenance"]["source"] == "post-process"
    assert post["provenance"]["parent_hash"] == edit["content_hash"]

    # RTSTRUCT 輸出（背景 job ＋ 下載）
    job = s.wait_for_job(s.export_rtstruct(["lesion"])["job_id"])
    assert job["status"] == "done"
    dicom_bytes = s.download_job(job["job_id"])
    assert dicom_bytes[128:132] == b"DICM"


def test_binary_payload_is_byte_identical_over_the_wire(s: Session, live: LiveServer) -> None:
    """🔴 二進位 payload 經過真 socket 之後必須逐位元組相同。

    行程內測試拿到的是同一個 `bytes` 物件；**這裡才會抓到「transfer-encoding
    把它切塊之後少了尾巴」這類問題**。
    """
    import httpx

    s.load("phantom:landmark")
    series_id = s.grid_set["frame_groups"][0]["series_id"]
    url = f"{live.http}/api/v1/series/{series_id}/image"
    params = {"display_grid": s.display_grid_id, "lod": "0"}

    first = httpx.get(url, params=params, timeout=60).content
    second = httpx.get(url, params=params, timeout=60).content
    assert first == second, "同一個請求兩次拿到不同 bytes"

    header, body = decode(first)
    size = header["size_ijk"]
    assert len(body) == size[0] * size[1] * size[2] * 2

    # 且解出來的體素真的是 landmark 假體的那一顆
    from rtgaia_testbe.phantoms.library import LANDMARK_IJK

    volume = np.frombuffer(body, dtype=np.int16).reshape(size[2], size[1], size[0])
    assert volume[LANDMARK_IJK[2], LANDMARK_IJK[1], LANDMARK_IJK[0]] == 3000


def test_large_payload_survives_chunking(s: Session, live: LiveServer) -> None:
    """`overlap_set` 的全解析度影像約 10 MB —— 會被真的切成多個 TCP segment。"""
    import httpx

    s.load("phantom:overlap_set")
    series_id = s.grid_set["frame_groups"][0]["series_id"]
    response = httpx.get(
        f"{live.http}/api/v1/series/{series_id}/image",
        params={"display_grid": s.display_grid_id, "lod": "0"},
        timeout=120,
    )
    header, body = decode(response.content)
    size = header["size_ijk"]
    assert len(body) == size[0] * size[1] * size[2] * 2
    assert len(body) > 5_000_000


# ── WebSocket ───────────────────────────────────────────────────────────────


def test_websocket_handshake_and_scene_push(s: Session, live: LiveServer) -> None:
    """連上就收到 `scene.replace`（前端不必先打 HTTP 才有東西可畫）。"""
    s.load("phantom:two_series")
    with wsc.connect(f"{live.ws}/api/v1/session/current/events", open_timeout=10) as ws:
        message = json.loads(ws.recv(timeout=10))
    assert message["type"] == "scene.replace"
    scene = message["payload"]
    assert len(scene["layers"]) == 4
    assert {f["role"] for f in scene["gridSet"]["frame_groups"]} == {"primary", "secondary"}


def test_websocket_hello_and_mask_updated(s: Session, live: LiveServer) -> None:
    """編輯 → 伺服器主動推 `mask.updated`（**只送 metadata**）。"""
    s.load("phantom:gantry_tilt")
    with wsc.connect(f"{live.ws}/api/v1/session/current/events", open_timeout=10) as ws:
        assert json.loads(ws.recv(timeout=10))["type"] == "scene.replace"
        ws.send(json.dumps({"type": "session.hello", "payload": {"webgl2": True, "tier": "A"}}))
        assert json.loads(ws.recv(timeout=10))["payload"]["phase"] == "acknowledged"

        s.edit(
            "lesion",
            offset_ijk=(300, 300, 40),
            array=np.ones((1, 2, 2), dtype=np.uint8),
            client_seq=1,
        )
        pushed = json.loads(ws.recv(timeout=10))
    assert pushed["type"] == "mask.updated"
    assert pushed["payload"]["structureId"] == "lesion"
    assert "data" not in pushed["payload"]


def test_websocket_job_progress_reaches_the_client(s: Session, live: LiveServer) -> None:
    s.load("phantom:overlap_set")
    with wsc.connect(f"{live.ws}/api/v1/session/current/events", open_timeout=10) as ws:
        assert json.loads(ws.recv(timeout=10))["type"] == "scene.replace"
        job_id = s.export_rtstruct(["gtv"])["job_id"]
        phases = []
        deadline = time.time() + 20
        while time.time() < deadline:
            message = json.loads(ws.recv(timeout=10))
            if message["type"] == "job.progress":
                phases.append(message["payload"]["phase"])
                if message["payload"]["percent"] == 100:
                    break
    assert job_id
    assert "done" in phases


def test_websocket_disconnect_close_code(s: Session, live: LiveServer) -> None:
    """chaos: `disconnect` —— 伺服器以 1012（Service Restart）關閉。

    關閉碼在行程內測試看不到；前端的重連策略要靠它區分「正常關閉」與「該重連」。
    """
    from websockets.exceptions import ConnectionClosed

    s.load("phantom:landmark")
    s.chaos(disconnect=True, disconnect_probability=1.0)
    closed_code: int | None = None
    with wsc.connect(f"{live.ws}/api/v1/session/current/events", open_timeout=10) as ws:
        ws.recv(timeout=10)  # scene.replace
        ws.send(json.dumps({"type": "ack"}))
        try:
            for _ in range(5):
                ws.recv(timeout=5)
        except ConnectionClosed as exc:
            closed_code = exc.rcvd.code if exc.rcvd else None
    assert closed_code == 1012


# ── chaos 在真 socket 上仍然有效 ────────────────────────────────────────────


def test_chaos_truncate_over_real_http(s: Session, live: LiveServer) -> None:
    """🔴 `truncate` 在真 socket 上尤其重要。

    行程內傳輸不會自己補齊；但真的 HTTP **有 `Content-Length`**——若伺服器
    宣告的長度與實際 body 不符，客戶端可能先在 HTTP 層就爆掉。這一條確認
    chaos 的注入方式在真實傳輸下仍然是「header 說有 N、body 只有 N/2」，
    因此**由前端的 W6 檢查抓到**，而不是變成一個網路錯誤。
    """
    import httpx

    s.load("phantom:gantry_tilt")
    series_id = s.grid_set["frame_groups"][0]["series_id"]
    s.chaos(truncate=True)
    response = httpx.get(
        f"{live.http}/api/v1/series/{series_id}/image",
        params={"display_grid": s.display_grid_id, "lod": "2"},
        timeout=30,
    )
    assert response.status_code == 200
    with pytest.raises(ContractViolation) as exc:
        decode(response.content)
    assert exc.value.code == "W6"


def test_chaos_latency_over_real_http(s: Session) -> None:
    s.load("phantom:landmark")
    s.chaos(latency=150)
    start = time.perf_counter()
    s.health()
    assert (time.perf_counter() - start) * 1000 >= 120


def test_412_status_line_over_real_http(s: Session, live: LiveServer) -> None:
    """N1 的解法要在真 HTTP 上驗一次：412 ＋ body 已帶 assigned_tier。"""
    import httpx

    loaded = s.load("phantom:landmark")
    series_ids = [f["series_id"] for f in loaded["scene"]["gridSet"]["frame_groups"]]
    response = httpx.post(
        f"{live.http}/api/v1/studies/{s.study_id}/grids",
        json={
            "primary_series_id": series_ids[0],
            "series_ids": series_ids,
            "client_capability": {"webgl2": False, "tier": "A"},
        },
        timeout=30,
    )
    assert response.status_code == 412
    body = response.json()
    assert body["reason"] == "no_webgl2"
    assert body["assigned_tier"] == "C"
    # 前端不必再打一次：完整 GridSet 已在 body 裡
    assert body["display_grid"]["display_grid_id"].startswith("dg_")


def test_default_asgi_app_is_importable(s: Session) -> None:
    """`rtgaia_testbe.asgi:app` 是 CLI 的進入點，必須可 import 且是同一種 app。"""
    assert _default_app.title.startswith("RT-Gaia")
