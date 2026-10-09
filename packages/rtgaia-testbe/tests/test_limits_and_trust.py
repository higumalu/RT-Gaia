"""資源上限、artifact 來源、UI digest、worker 不依賴 session、public URL。

全部用**小額配額**驗「拒絕發生在配置／解碦之前」，不做破壞性壓力測試。
"""

from __future__ import annotations

import hashlib
import io
import os
import threading
import time
import zipfile
from pathlib import Path
from typing import Any

import pytest
from fastapi import FastAPI, Header, HTTPException, Response
from fastapi.testclient import TestClient
from rtgaia_core.library import Importer
from rtgaia_core.plugins import PluginError, PluginManager
from rtgaia_server.db.plugins import PluginRecord
from rtgaia_testbe import Session
from rtgaia_testbe.api import create_app
from synth_dicom import SynthCase, write_synth_case
from test_plugins import ADMIN, CONTOURER, Served, fake_plugin

DB_URL = os.environ.get("RTGAIA_TEST_DB_URL", "")


@pytest.fixture(scope="module")
def synth(tmp_path_factory) -> SynthCase:  # type: ignore[no-untyped-def]
    return write_synth_case(tmp_path_factory.mktemp("synth"))


@pytest.fixture(autouse=True)
def _no_tick(monkeypatch):  # type: ignore[no-untyped-def]
    monkeypatch.setenv("RTGAIA_PLUGIN_TICK_SECONDS", "0")


def _files(directory: Path) -> list[Path]:
    return sorted(p for p in directory.rglob("*") if p.is_file())


# ── zip 上限（宣告值就擋，不解任何成員）────────────────────────────────────────


def _zip(members: dict[str, bytes]) -> bytes:
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", compression=zipfile.ZIP_DEFLATED) as zf:
        for name, data in members.items():
            zf.writestr(name, data)
    return buf.getvalue()


def test_zip_member_count_limit(tmp_path: Path, monkeypatch) -> None:  # type: ignore[no-untyped-def]
    monkeypatch.setenv("RTGAIA_ZIP_MEMBERS_MAX", "3")
    imp = Importer(tmp_path / "lib")
    b = imp.open_batch("upload")
    items = imp.receive(b, "many.zip", _zip({f"f{i}.dcm": b"x" * 200 for i in range(4)}))
    assert len(items) == 1 and items[0].outcome == "rejected" and "成員 4 個超過上限 3" in items[0].reason
    assert not any((b.staging).glob("*")), "一個成員都不能解到暫存區"


def test_zip_declared_total_limit(tmp_path: Path, monkeypatch) -> None:  # type: ignore[no-untyped-def]
    monkeypatch.setenv("RTGAIA_ZIP_TOTAL_MAX_BYTES", "1000")
    imp = Importer(tmp_path / "lib")
    b = imp.open_batch("upload")
    items = imp.receive(b, "big.zip", _zip({"a.dcm": os.urandom(700), "b.dcm": os.urandom(700)}))
    assert items[0].outcome == "rejected" and "展開後 1400 bytes 超過上限 1000" in items[0].reason


def test_zip_bomb_ratio_limit(tmp_path: Path, monkeypatch) -> None:  # type: ignore[no-untyped-def]
    monkeypatch.setenv("RTGAIA_ZIP_RATIO_MAX", "10")
    imp = Importer(tmp_path / "lib")
    b = imp.open_batch("upload")
    bomb = _zip({"zeros.dcm": b"\0" * 2_000_000})  # 2 MB 的 0 壓成幾 KB
    assert len(bomb) < 20_000
    items = imp.receive(b, "bomb.zip", bomb)
    assert items[0].outcome == "rejected" and "zip bomb" in items[0].reason


def test_zip_within_limits_still_works(tmp_path: Path, synth: SynthCase) -> None:
    imp = Importer(tmp_path / "lib")
    b = imp.open_batch("upload")
    ct = _files(synth.plan_ct.directory)[:2]
    items = imp.receive(b, "ok.zip", _zip({p.name: p.read_bytes() for p in ct}))
    assert [it.outcome for it in items] == ["staged", "staged"]


# ── HTTP body 上限（串流累計 → 413）─────────────────────────────────────────


def test_import_body_limit_413(tmp_path: Path, monkeypatch) -> None:  # type: ignore[no-untyped-def]
    monkeypatch.setenv("RTGAIA_IMPORT_BODY_MAX_BYTES", "1000")
    root = tmp_path / "lib"
    root.mkdir()
    with Session(library_root=str(root)) as s:
        bid = s.import_open()["batch_id"]
        with pytest.raises(RuntimeError, match="413") as exc:
            s.import_put(bid, "big.dcm", b"\0" * 128 + b"DICM" + b"x" * 2000)
        assert "IMPORT_TOO_LARGE" in str(exc.value)
        # 小檔仍可（限制沒有誤傷）
        assert s.import_put(bid, "small.txt", b"hello")["items"][0]["outcome"] == "rejected"  # 非 DICOM 照常拒


# ── 出圖像素預算 ─────────────────────────────────────────────────────────────


def test_render_pixel_budget(monkeypatch) -> None:  # type: ignore[no-untyped-def]
    monkeypatch.setenv("RTGAIA_RENDER_PIXEL_BUDGET", "1000")
    with Session() as s:
        s.load("phantom:landmark")
        with pytest.raises(RuntimeError, match="RENDER_BUDGET"):
            s.reslice(output_size_px=(64, 64))
        with pytest.raises(RuntimeError, match="RENDER_BUDGET"):
            s.render3d(output_size_px=(64, 64), technique="mip")
        # 預算內照常
        header, _raw = s.reslice(output_size_px=(20, 20))
        assert header["width"] == 20


def test_event_loop_not_blocked_by_cpu_render(monkeypatch) -> None:  # type: ignore[no-untyped-def]
    """3D 出圖（CPU 路徑）在跑時，`/healthz` 仍應在幾十毫秒內回 —— 出圖在執行緒、以 await 等待。"""
    from rtgaia_core import render3d

    real = render3d.render

    def slow_render(**kw: Any) -> Any:
        time.sleep(1.2)
        return real(**kw)

    monkeypatch.setattr(render3d, "render", slow_render)
    with Session() as s:
        s.load("phantom:landmark")
        latencies: list[float] = []

        def probe() -> None:
            time.sleep(0.3)  # 等出圖真的開始
            for _ in range(3):
                t0 = time.perf_counter()
                s.health()
                latencies.append(time.perf_counter() - t0)
                time.sleep(0.1)

        t = threading.Thread(target=probe)
        t.start()
        s.render3d(output_size_px=(32, 32), technique="mip")
        t.join()
        assert latencies and max(latencies) < 0.5, latencies


# ── artifact URL 只能指向核可的 origin；憑證只給核可來源 ─────────────────────────


def _pm() -> PluginManager:
    class _App:
        async def audit(self, *_a: Any, **_k: Any) -> None:
            pass

    from rtgaia_server.db.plugins import MemoryPlugins

    return PluginManager(_App(), MemoryPlugins())


def _rec(**over: Any) -> PluginRecord:
    base = dict(plugin_id="p", endpoint="http://127.0.0.1:9/", token="secret", manifest={"artifact_origins": []})
    base.update(over)
    return PluginRecord(**base)


def test_artifact_origin_rules() -> None:
    pm = _pm()
    rec = _rec()
    assert pm._check_artifact_url(rec, "http://127.0.0.1:9/jobs/1/seg.nii.gz")  # endpoint 自己：可
    for bad in (
        "http://unregistered.invalid/x.nii.gz",  # 未核可
        "ftp://127.0.0.1:9/x",  # 協定
        "http://127.0.0.1:9/../../etc/passwd",  # 路徑
        "http://127.0.0.1:8/x",  # 同 host 不同 port ＝ 不同 origin
    ):
        with pytest.raises(PluginError) as exc:
            pm._check_artifact_url(rec, bad)
        assert exc.value.code == "PL-ARTIFACT-ORIGIN", bad
    # manifest 宣告或 admin 核可的 origin：可（院內私有 IP 也是這條路）
    assert pm._check_artifact_url(
        _rec(manifest={"artifact_origins": ["http://10.0.0.5:8080"]}), "http://10.0.0.5:8080/a"
    )
    assert pm._check_artifact_url(_rec(artifact_origins=["http://10.0.0.6:8080"]), "http://10.0.0.6:8080/a")
    # link-local／metadata 位址：即使 origin 被核可也不允許
    with pytest.raises(PluginError) as exc:
        pm._check_artifact_url(_rec(artifact_origins=["http://169.254.169.254"]), "http://169.254.169.254/latest/meta")
    assert exc.value.code == "PL-ARTIFACT-ORIGIN" and "169.254.169.254" in exc.value.message


class _FakeStream:
    def __init__(self, status: int, chunks: list[bytes], headers: dict[str, str] | None = None) -> None:
        self.status_code, self._chunks, self.headers = status, chunks, headers or {}

    def __enter__(self) -> _FakeStream:
        return self

    def __exit__(self, *a: Any) -> None:
        pass

    def raise_for_status(self) -> None:
        if self.status_code >= 400:
            raise RuntimeError(f"HTTP {self.status_code}")

    def iter_bytes(self):  # type: ignore[no-untyped-def]
        yield from self._chunks


def _fake_httpx_client(monkeypatch, responses: dict[str, _FakeStream]) -> list[tuple[str, dict[str, str]]]:  # type: ignore[no-untyped-def]
    calls: list[tuple[str, dict[str, str]]] = []
    import rtgaia_core.plugins as mod

    class _Client:
        def __init__(self, *a: Any, **k: Any) -> None:
            pass

        def __enter__(self) -> _Client:
            return self

        def __exit__(self, *a: Any) -> None:
            pass

        def stream(self, method: str, url: str, headers: dict[str, str]) -> _FakeStream:
            calls.append((url, dict(headers)))
            return responses[url]

    monkeypatch.setattr(mod.httpx, "Client", _Client)
    return calls


def test_artifact_fetcher_never_calls_unapproved_and_caps_size(monkeypatch) -> None:  # type: ignore[no-untyped-def]
    pm = _pm()
    rec = _rec()
    ok_url = "http://127.0.0.1:9/jobs/1/seg.nii.gz"
    big_url = "http://127.0.0.1:9/jobs/1/big.nii.gz"
    redirect_url = "http://127.0.0.1:9/jobs/1/redir"
    calls = _fake_httpx_client(
        monkeypatch,
        {
            ok_url: _FakeStream(200, [b"abc", b"def"]),
            big_url: _FakeStream(200, [b"x" * 600, b"x" * 600]),
            redirect_url: _FakeStream(302, [], {"location": "http://evil.invalid/"}),
        },
    )
    fetched: dict[str, bytes] = {}
    fetch = pm._artifact_fetcher(rec, fetched, cap_bytes=1000)
    # 未核可 → 一次網路呼叫都沒有（比「有呼叫但沒帶 token」更強）
    with pytest.raises(PluginError) as exc:
        fetch("http://unregistered.invalid/x.nii.gz")
    assert exc.value.code == "PL-ARTIFACT-ORIGIN" and calls == []
    # 核可 → 帶登錄 bearer
    assert fetch(ok_url) == b"abcdef" and calls[-1][1]["Authorization"] == "Bearer secret"
    # data: → 不出網
    assert fetch("data:application/octet-stream;base64,aGk=") == b"hi" and len(calls) == 1
    # 超過上限 → 下載中止（收到第二塊就停），PL-QUOTA
    with pytest.raises(PluginError) as exc:
        fetch(big_url)
    assert exc.value.code == "PL-QUOTA"
    # 重導向不跟
    with pytest.raises(PluginError) as exc:
        fetch(redirect_url)
    assert exc.value.code == "PL-ARTIFACT-ORIGIN" and "重導向" in exc.value.message
    # 拒絕原因帶 code（B7 的 reason 是 str(exc)）
    assert str(exc.value).startswith("PL-ARTIFACT-ORIGIN: ")


def test_admin_patches_artifact_origins(driver: Session) -> None:
    from test_plugins import _api

    with Served(fake_plugin()) as fp:
        assert _api(driver, "POST", "/api/v1/plugins", ADMIN, json={"endpoint": fp.url}).status_code == 201
        r = _api(
            driver, "PATCH", "/api/v1/plugins/fake-x", ADMIN, json={"artifact_origins": ["https://Store.Example:8443/"]}
        )
        assert r.status_code == 200, r.text
        assert r.json()["artifact_origins"] == ["https://store.example:8443"]
        assert fp.url.lower() in r.json()["effective_artifact_origins"]
        r = _api(driver, "PATCH", "/api/v1/plugins/fake-x", ADMIN, json={"artifact_origins": ["https://x/path"]})
        assert r.status_code == 422 and r.json()["code"] == "PL-SCHEMA"
        assert (
            _api(driver, "PATCH", "/api/v1/plugins/fake-x", CONTOURER, json={"artifact_origins": []}).status_code == 403
        )
        assert "plugin.artifact_origins" in [e["action"] for e in driver._app.state.rtgaia.audit_tail]


# ── UI bundle 只載宣告 trust 的、digest 釘住、不符就隔離 ────────────────────────


def _ui_plugin(*, trust: bool) -> tuple[FastAPI, dict[str, Any]]:
    app = fake_plugin()
    state = {"bundle": b'export default { id: "fake-x", version: "1.0.0", sdkVersion: "^0.1.0", register() {} };\n'}
    manifest_ui: dict[str, Any] = {"bundle": "/ui/index.js", "sdk_version": "^0.1.0"}
    if trust:
        manifest_ui["trust"] = "host-equivalent"
    # 把 ui 掛進 fake plugin 的 manifest（fake_plugin 的 manifest 是閉包；用一個覆蓋路由）
    base_manifest = app.routes  # noqa: F841 - 只為了確認 app 可用

    @app.get("/manifest", include_in_schema=False)
    def _manifest2(authorization: str | None = Header(default=None)) -> dict[str, Any]:
        m = {
            "id": "fake-x",
            "version": "1.0.0",
            "api_version": "1",
            "label": "Fake X",
            "licenses": ["MIT"],
            "soup": [],
            "required_role": "contourer",
            "capabilities": ["read-image", "write-transient"],
            "inputs": {"image": {"required": True, "format": "nifti"}, "params_schema": {"type": "object"}},
            "outputs": {"kinds": ["structures"], "encodings": ["labelmap"]},
            "execution": {"timeout_s": 60, "progress": "callback", "concurrency": 1},
            "ui": manifest_ui,
        }
        return m

    @app.get("/ui/{path:path}")
    def _ui(path: str) -> Response:
        if path != "index.js":
            raise HTTPException(404)
        return Response(content=state["bundle"], media_type="text/javascript")

    # FastAPI 以先註冊者優先：把新的 /manifest 移到最前面
    app.router.routes.insert(0, app.router.routes.pop())
    app.router.routes.insert(0, app.router.routes.pop())
    return app, state


def test_ui_bundle_digest_pinned_and_quarantine_on_change(driver: Session) -> None:
    from test_plugins import _api

    app, st = _ui_plugin(trust=True)
    with Served(app) as fp:
        r = _api(driver, "POST", "/api/v1/plugins", ADMIN, json={"endpoint": fp.url})
        assert r.status_code == 201, r.text
        rec = r.json()
        assert rec["has_ui"] is True and rec["ui_trust"] == "host-equivalent"
        assert rec["ui_digest"] == hashlib.sha256(st["bundle"]).hexdigest()
        # 非 admin 也拿得到 digest（前端載入前要比）
        pub = _api(driver, "GET", "/api/v1/plugins", CONTOURER).json()[0]
        assert pub["ui_digest"] == rec["ui_digest"] and pub["ui_trust"] == "host-equivalent"
        # 代理：宣告的 bundle 可取；別的路徑 404
        assert _api(driver, "GET", "/api/v1/plugins/fake-x/ui/index.js", CONTOURER).status_code == 200
        r = _api(driver, "GET", "/api/v1/plugins/fake-x/ui/other.js", CONTOURER)
        assert r.status_code == 404 and r.json()["code"] == "PL-UI-PATH"
        # plugin 端偷換 bundle → 502、plugin 隔離、之後連 run 都 503
        st["bundle"] = b"fetch('/api/v1/cases');" + st["bundle"]
        r = _api(driver, "GET", "/api/v1/plugins/fake-x/ui/index.js", CONTOURER)
        assert r.status_code == 502 and r.json()["code"] == "PL-UI-DIGEST"
        assert _api(driver, "GET", "/api/v1/plugins/fake-x", ADMIN).json()["status"] == "quarantined"
        assert _api(driver, "POST", "/api/v1/plugins/fake-x/run", CONTOURER, json={"params": {}}).status_code == 503
        assert "plugin.quarantine" in [e["action"] for e in driver._app.state.rtgaia.audit_tail]
        # admin 重新登錄 ＝ 接受新 digest
        r = _api(driver, "POST", "/api/v1/plugins", ADMIN, json={"endpoint": fp.url})
        assert r.status_code == 201 and r.json()["status"] == "active"
        assert r.json()["ui_digest"] == hashlib.sha256(st["bundle"]).hexdigest()


def test_ui_without_trust_is_not_loaded(driver: Session) -> None:
    from test_plugins import _api

    app, _ = _ui_plugin(trust=False)
    with Served(app) as fp:
        r = _api(driver, "POST", "/api/v1/plugins", ADMIN, json={"endpoint": fp.url})
        assert r.status_code == 201, r.text
        assert r.json()["has_ui"] is False and r.json()["ui_digest"] is None and r.json()["ui_trust"] is None
        r = _api(driver, "GET", "/api/v1/plugins/fake-x/ui/index.js", CONTOURER)
        assert r.status_code == 404 and r.json()["code"] == "PL-UI-PATH"


# ── 獨立 worker 的派工不依賴 API 的 session ──────────────────────────────────────


@pytest.mark.db
def test_plugin_dispatch_from_blank_worker_state(synth: SynthCase, tmp_path: Path, monkeypatch) -> None:  # type: ignore[no-untyped-def]
    """重現：API 建的 plugin job 交給空白 worker state dispatch → `KeyError: 沒有 session`。
    現在 dispatch 以 `case_async(job.case_id)` 從 DB 重建病例，RunRequest 帶正確的 case／series；
    selection 改了 → `PL-CASE-CHANGED`。"""
    if not DB_URL:
        pytest.skip("RTGAIA_TEST_DB_URL 未設")
    import asyncio

    from rtgaia_server.db.migrate import downgrade_base, upgrade_to_head
    from rtgaia_server.worker_main import make_worker_state
    from test_plugins import _api

    downgrade_base(DB_URL)
    upgrade_to_head(DB_URL)
    monkeypatch.setenv("RTGAIA_DATA_DIR", str(tmp_path / "data"))
    monkeypatch.setenv("RTGAIA_INPROCESS_WORKER", "0")  # API 行程不派工，job 停在 queued 給 worker
    monkeypatch.setenv("RTGAIA_PUBLIC_URL", "http://api.test:8080")
    selection = {
        "primary_series_uid": synth.plan_ct.series_uid,
        "image_series_uids": [synth.plan_ct.series_uid],
        "structure_set_uids": [synth.plan_rs_uid],
        "dose_uids": [],
        "registration_uids": [],
        "plan_uids": [],
    }
    with (
        Served(fake_plugin()) as fp,
        Session(library_root=str(synth.root), db_url=DB_URL, auth="off", user="bob") as api,
    ):
        opened = api.load_case(selection)
        assert _api(api, "POST", "/api/v1/plugins", ADMIN, json={"endpoint": fp.url}).status_code == 201
        r = _api(api, "POST", "/api/v1/plugins/fake-x/run", CONTOURER, json={"params": {"n": 1}})
        assert r.status_code == 202, r.text
        job_id = r.json()["job_id"]

        worker = make_worker_state(db_url=DB_URL, library_root=str(synth.root))
        sent: list[dict[str, Any]] = []

        async def main() -> tuple[Any, Any]:
            pm = await worker.plugins_async()
            queue = await worker.job_queue_async()
            job = await queue.get(job_id)
            assert job is not None and job.status == "queued"

            class _Resp:
                status_code = 202

                @staticmethod
                def json() -> dict[str, Any]:
                    return {"job_id": "plugin-side-1"}

            async def fake_post(url: str, *, json: dict[str, Any], headers: dict[str, str]) -> _Resp:
                sent.append({"url": url, "body": json, "headers": headers})
                return _Resp()

            pm._client.post = fake_post  # type: ignore[method-assign]
            assert worker.store.all() == [], "worker 沒有任何 session"
            await pm.dispatch(job)
            # selection 改了 → 拒絕
            job2 = await queue.get(job_id)
            job2.request["selection_hash"] = "not-the-same"
            job2.request["callback_token"] = "again"
            err: Any = None
            try:
                await pm.dispatch(job2)
            except PluginError as exc:
                err = exc
            await worker.catalog_store.dispose()
            return job.request.get("plugin_job_id"), err

        plugin_job_id, err = asyncio.run(main())
        assert plugin_job_id == "plugin-side-1"
        assert len(sent) == 1 and sent[0]["url"].endswith("/run")
        body = sent[0]["body"]
        assert body["case"]["case_id"] == opened["case_id"]
        assert body["inputs"]["image"]["series_id"] == synth.plan_ct.series_uid
        assert body["callback"]["base_url"].startswith("http://api.test:8080/api/v1/plugins/fake-x/jobs/")
        assert err is not None and err.code == "PL-CASE-CHANGED"


# ── public URL 是設定；偽造 Host 不改 callback、被 400 ───────────────────────────


def test_required_mode_demands_public_url(monkeypatch) -> None:  # type: ignore[no-untyped-def]
    monkeypatch.delenv("RTGAIA_PUBLIC_URL", raising=False)
    with pytest.raises(ValueError, match="RTGAIA_PUBLIC_URL"):
        create_app(db_url="postgresql+asyncpg://x:y@127.0.0.1:1/db", auth="required")
    with pytest.raises(ValueError, match="http\\(s\\)://host"):
        create_app(public_url="rtgaia.local")  # 沒有 scheme
    with pytest.raises(ValueError, match="http\\(s\\)://host"):
        create_app(public_url="http://rtgaia.local/api")  # 帶路徑
    assert create_app(public_url="https://rtgaia.local:8443").state.rtgaia.public_url == "https://rtgaia.local:8443"


def test_forged_host_is_rejected_and_never_learned(monkeypatch) -> None:  # type: ignore[no-untyped-def]
    monkeypatch.delenv("RTGAIA_PUBLIC_URL", raising=False)
    app = create_app(public_url="http://good.host", test_api=True)
    rt = app.state.rtgaia
    with TestClient(app, base_url="http://good.host") as c:
        # 第一個請求帶偽造 Host（重現時的形狀）→ 400，且 public_base_url 不受影響
        r = c.get("/api/v1/auth/status", headers={"Host": "untrusted.invalid"})
        assert r.status_code == 400 and r.json()["code"] == "BAD_HOST"
        assert rt.public_base_url() == "http://good.host"
        assert c.get("/api/v1/auth/status").status_code == 200
        assert c.get("/api/v1/auth/status", headers={"Host": "good.host:8080"}).status_code == 200  # 帶 port 也比
        assert c.get("/api/v1/auth/status", headers={"Host": "127.0.0.1"}).status_code == 200
        # /healthz 給容器健康檢查，不看 Host
        assert c.get("/healthz", headers={"Host": "untrusted.invalid"}).status_code == 200


def test_off_mode_without_public_url_has_no_host_check(monkeypatch) -> None:  # type: ignore[no-untyped-def]
    monkeypatch.delenv("RTGAIA_PUBLIC_URL", raising=False)
    app = create_app(test_api=True)
    assert app.state.rtgaia.allowed_hosts is None
    with TestClient(app) as c:
        assert c.get("/api/v1/auth/status", headers={"Host": "anything.local"}).status_code == 200
    assert app.state.rtgaia.public_base_url() == "http://127.0.0.1:8080"
