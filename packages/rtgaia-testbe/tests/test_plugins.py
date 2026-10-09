"""宿主端 plugin：登錄／清單／角色可見度、授權拒載、健康檢查與版本協商、代理與標頭、KV、
以及（e2e）`POST /plugins/{id}/run` → worker 派工 → hello plugin 回呼（影像、進度、結果、done）→ job done。

plugin 一律真的起 uvicorn（宿主要用 HTTP 去抓 manifest）；派工那段宿主也要真的 socket（plugin 要回呼）。
"""

from __future__ import annotations

import asyncio
import importlib.util
import os
import socket
import sys
import threading
import time
from pathlib import Path
from typing import Any

import httpx
import pytest
import uvicorn
from fastapi import FastAPI, Header, HTTPException, Request
from rtgaia_testbe import Session

REPO = Path(__file__).resolve().parents[3]
ADMIN = {"X-RTGaia-User": "alice", "X-RTGaia-Role": "admin"}
CONTOURER = {"X-RTGaia-User": "bob", "X-RTGaia-Role": "contourer"}
VIEWER = {"X-RTGaia-User": "vic", "X-RTGaia-Role": "viewer"}


def _free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return int(s.getsockname()[1])


class Served:
    def __init__(self, app: Any) -> None:
        self.port = _free_port()
        self.server = uvicorn.Server(
            uvicorn.Config(app, host="127.0.0.1", port=self.port, log_level="warning", access_log=False)
        )
        self.thread = threading.Thread(target=self.server.run, daemon=True)

    def __enter__(self) -> Served:
        self.thread.start()
        for _ in range(400):
            if self.server.started:
                return self
            time.sleep(0.02)
        raise RuntimeError("uvicorn 沒起來")

    def __exit__(self, *exc: object) -> None:
        self.server.should_exit = True
        self.thread.join(timeout=10)

    @property
    def url(self) -> str:
        return f"http://127.0.0.1:{self.port}"


def fake_plugin(*, version: str = "1.0.0", licenses: list[str] | None = None, token: str = "") -> FastAPI:
    """只有 manifest／health／自訂端點的假 plugin（不派工）。`version` 可事後改（測版本協商）。"""
    app = FastAPI()
    state = {"version": version, "manifest_hits": 0, "health_ok": True}
    manifest = {
        "id": "fake-x",
        "version": version,
        "api_version": "1",
        "label": "Fake X",
        "licenses": licenses or ["MIT"],
        "soup": [],
        "required_role": "contourer",
        "capabilities": ["read-image", "write-transient"],
        "inputs": {
            "image": {"required": True, "format": "nifti"},
            "params_schema": {"type": "object", "properties": {"n": {"type": "integer"}}},
        },
        "outputs": {"kinds": ["structures"], "encodings": ["labelmap"]},
        "execution": {"timeout_s": 60, "progress": "callback", "concurrency": 1},
    }
    app.state.fake = state

    def auth(authorization: str | None) -> None:
        if token and authorization != f"Bearer {token}":
            raise HTTPException(401)

    @app.get("/manifest")
    def _manifest(authorization: str | None = Header(default=None)) -> dict[str, Any]:
        auth(authorization)
        state["manifest_hits"] += 1
        return {**manifest, "version": state["version"]}

    @app.get("/health")
    def _health(authorization: str | None = Header(default=None)) -> dict[str, Any]:
        auth(authorization)
        if not state["health_ok"]:
            raise HTTPException(503)
        return {"status": "ok", "version": state["version"]}

    @app.get("/whoami")
    def _whoami(request: Request) -> dict[str, Any]:
        return {
            "actor": request.headers.get("x-rtgaia-actor"),
            "role": request.headers.get("x-rtgaia-role"),
            "auth": request.headers.get("authorization"),
        }

    return app


@pytest.fixture(autouse=True)
def _no_background_tick(monkeypatch):
    monkeypatch.setenv("RTGAIA_PLUGIN_TICK_SECONDS", "0")


def _api(s: Session, method: str, path: str, headers: dict[str, str], **kw: Any) -> httpx.Response:
    return s._client.request(method, path, headers=headers, **kw)


# ── 登錄、清單、角色 ────────────────────────────────────────────────────────────


def test_register_list_visibility_and_remove(driver: Session) -> None:
    with Served(fake_plugin(token="t0k")) as fp:
        r = _api(driver, "POST", "/api/v1/plugins", CONTOURER, json={"endpoint": fp.url, "token": "t0k"})
        assert r.status_code == 403  # 登錄是系統設定
        r = _api(driver, "POST", "/api/v1/plugins", ADMIN, json={"endpoint": fp.url, "token": "wrong"})
        assert r.status_code == 502 and r.json()["code"] == "PL-DOWN"
        r = _api(driver, "POST", "/api/v1/plugins", ADMIN, json={"endpoint": fp.url, "token": "t0k"})
        assert r.status_code == 201, r.text
        full = r.json()
        assert (
            full["plugin_id"] == "fake-x" and full["endpoint"] == fp.url and full["token_set"] and "token" not in full
        )
        assert full["manifest"]["version"] == "1.0.0"

        # 非 admin 只看公開欄位 ＋ allowed
        rows = _api(driver, "GET", "/api/v1/plugins", VIEWER).json()
        assert [p["plugin_id"] for p in rows] == ["fake-x"]
        assert "endpoint" not in rows[0] and rows[0]["allowed"] is False
        assert _api(driver, "GET", "/api/v1/plugins", CONTOURER).json()[0]["allowed"] is True

        # 停用 → 代理 503；刪除 → 404
        assert (
            _api(driver, "PATCH", "/api/v1/plugins/fake-x", ADMIN, json={"enabled": False}).json()["status"]
            == "disabled"
        )
        assert _api(driver, "GET", "/api/v1/modules/fake-x/whoami", CONTOURER).status_code == 503
        assert (
            _api(driver, "PATCH", "/api/v1/plugins/fake-x", ADMIN, json={"enabled": True}).json()["status"] == "active"
        )
        assert _api(driver, "DELETE", "/api/v1/plugins/fake-x", ADMIN).status_code == 204
        assert _api(driver, "GET", "/api/v1/plugins/fake-x", ADMIN).status_code == 404
        actions = [e["action"] for e in driver._app.state.rtgaia.audit_tail]
        assert {"plugin.register", "plugin.disable", "plugin.enable", "plugin.remove"} <= set(actions)


def test_license_gate_and_override(driver: Session) -> None:
    with Served(fake_plugin(licenses=["GPL-3.0-only"])) as fp:
        r = _api(driver, "POST", "/api/v1/plugins", ADMIN, json={"endpoint": fp.url})
        assert r.status_code == 422 and r.json()["code"] == "PL-LICENSE"
        r = _api(
            driver, "POST", "/api/v1/plugins", ADMIN, json={"endpoint": fp.url, "allow_licenses": ["GPL-3.0-only"]}
        )
        assert r.status_code == 201 and r.json()["allow_licenses"] == ["GPL-3.0-only"]
        assert "plugin.license_override" in [e["action"] for e in driver._app.state.rtgaia.audit_tail]


def test_proxy_adds_identity_headers_and_checks_role(driver: Session) -> None:
    with Served(fake_plugin(token="pt")) as fp:
        assert (
            _api(driver, "POST", "/api/v1/plugins", ADMIN, json={"endpoint": fp.url, "token": "pt"}).status_code == 201
        )
        r = _api(driver, "GET", "/api/v1/modules/fake-x/whoami", CONTOURER)
        assert r.status_code == 200 and r.json() == {"actor": "bob", "role": "contourer", "auth": "Bearer pt"}
        assert (
            _api(driver, "GET", "/api/v1/modules/fake-x/whoami", VIEWER).status_code == 403
        )  # required_role contourer
        assert _api(driver, "GET", "/api/v1/modules/nope/whoami", CONTOURER).status_code == 404


def test_health_failures_version_bump_and_recovery(driver: Session) -> None:
    app = fake_plugin()
    with Served(app) as fp:
        assert _api(driver, "POST", "/api/v1/plugins", ADMIN, json={"endpoint": fp.url}).status_code == 201
        app.state.fake["health_ok"] = False
        for _ in range(2):
            assert _api(driver, "POST", "/api/v1/plugins/fake-x/refresh", ADMIN).json()["status"] == "active"
        assert _api(driver, "POST", "/api/v1/plugins/fake-x/refresh", ADMIN).json()["status"] == "failed"  # 第 3 次
        app.state.fake["health_ok"] = True
        app.state.fake["version"] = "1.1.0"
        rec = _api(driver, "POST", "/api/v1/plugins/fake-x/refresh", ADMIN).json()
        assert rec["status"] == "active" and rec["version"] == "1.1.0" and rec["manifest"]["version"] == "1.1.0"
        assert app.state.fake["manifest_hits"] == 2  # 登錄一次、版本變了再抓一次


def test_user_kv_namespaces(driver: Session) -> None:
    with Served(fake_plugin()) as fp:
        assert _api(driver, "POST", "/api/v1/plugins", ADMIN, json={"endpoint": fp.url}).status_code == 201
        assert _api(driver, "PUT", "/api/v1/plugins/fake-x/kv/user/last", CONTOURER, json={"n": 1}).status_code == 204
        assert _api(driver, "GET", "/api/v1/plugins/fake-x/kv/user/last", CONTOURER).json() == {"n": 1}
        assert _api(driver, "GET", "/api/v1/plugins/fake-x/kv/user/last", ADMIN).status_code == 404  # 每人各自
        assert _api(driver, "PUT", "/api/v1/plugins/fake-x/kv/plugin/shared", CONTOURER, json=1).status_code == 403
        assert _api(driver, "PUT", "/api/v1/plugins/fake-x/kv/plugin/shared", ADMIN, json={"a": 1}).status_code == 204
        assert _api(driver, "GET", "/api/v1/plugins/fake-x/kv/plugin/shared", CONTOURER).json() == {"a": 1}
        assert _api(driver, "GET", "/api/v1/plugins/fake-x/kv/bogus", CONTOURER).status_code == 422


def test_run_validates_params_and_role(driver: Session) -> None:
    driver.load("phantom:landmark")
    with Served(fake_plugin()) as fp:
        assert _api(driver, "POST", "/api/v1/plugins", ADMIN, json={"endpoint": fp.url}).status_code == 201
        r = _api(driver, "POST", "/api/v1/plugins/fake-x/run", CONTOURER, json={"params": {"n": "x"}})
        assert r.status_code == 422 and r.json()["code"] == "PL-SCHEMA"
        assert _api(driver, "POST", "/api/v1/plugins/fake-x/run", VIEWER, json={"params": {}}).status_code == 403


def test_run_uses_the_chosen_image_series(driver: Session) -> None:
    """nnU-Net plugin 要能選擇要 infer 哪一組 CT：面板以前送 `image_layer_id`，宿主只認
    `image_series_id` → 參數被忽略、永遠推論 primary。宿主現在也驗：必須是這個病例裡的**影像**序列。"""
    driver.load("phantom:two_series")
    series = [fg["series_id"] for fg in driver.grid_set["frame_groups"]]
    assert len(series) >= 2
    rt = driver._app.state.rtgaia
    with Served(fake_plugin()) as fp:
        assert _api(driver, "POST", "/api/v1/plugins", ADMIN, json={"endpoint": fp.url}).status_code == 201
        # 指定第二組影像 → job 記的是它
        body = {"params": {"n": 1}, "image_series_id": series[1], "study_id": driver.study_id}
        r = _api(driver, "POST", "/api/v1/plugins/fake-x/run", CONTOURER, json=body)
        assert r.status_code == 202, r.text
        queue = asyncio.run(rt.job_queue_async())
        assert queue.jobs[r.json()["job_id"]].request["series_id"] == series[1]
        # 沒指定 → primary（既有行為）。要帶 study_id：bob 自己沒有 session，不會退回別人的 current（2026-10-09）
        r = _api(
            driver,
            "POST",
            "/api/v1/plugins/fake-x/run",
            CONTOURER,
            json={"params": {"n": 1}, "study_id": driver.study_id},
        )
        assert queue.jobs[r.json()["job_id"]].request["series_id"] == series[0]
        # 不是這個病例的序列 → 422 PL-SCHEMA（以前會照樣建 job、派工時才炸）
        bad = {"params": {"n": 1}, "image_series_id": "1.2.3.nope", "study_id": driver.study_id}
        r = _api(driver, "POST", "/api/v1/plugins/fake-x/run", CONTOURER, json=bad)
        assert r.status_code == 422 and r.json()["code"] == "PL-SCHEMA"


# ── e2e：真宿主 ＋ hello plugin ────────────────────────────────────────────────


def _load_example(name: str) -> Any:
    path = REPO / "examples" / name / "plugin.py"
    if str(path.parent) not in sys.path:
        sys.path.insert(0, str(path.parent))
    spec = importlib.util.spec_from_file_location(f"testbe_example_{name.replace('-', '_')}", path)
    assert spec and spec.loader
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod.app


def _wait_job(client: httpx.Client, job_id: str, headers: dict[str, str], timeout: float = 60.0) -> dict[str, Any]:
    deadline = time.time() + timeout
    while time.time() < deadline:
        j = client.get(f"/api/v1/jobs/{job_id}", headers=headers).json()
        if j["status"] in ("done", "failed"):
            return j
        time.sleep(0.2)
    raise TimeoutError(f"job {job_id} 沒結束")


@pytest.mark.e2e
def test_run_hello_plugin_end_to_end(tmp_path, monkeypatch) -> None:
    from rtgaia_testbe.api import create_app

    monkeypatch.setenv("RTGAIA_PLUGIN_ARTIFACTS", str(tmp_path / "artifacts"))
    monkeypatch.setenv("RTGAIA_PLUGIN_TICK_SECONDS", "0.5")
    host_port = _free_port()
    monkeypatch.setenv("RTGAIA_PUBLIC_URL", f"http://127.0.0.1:{host_port}")
    host_app = create_app(test_api=True)
    host = Served.__new__(Served)
    host.port = host_port
    host.server = uvicorn.Server(
        uvicorn.Config(host_app, host="127.0.0.1", port=host_port, log_level="warning", access_log=False)
    )
    host.thread = threading.Thread(target=host.server.run, daemon=True)
    with host, Served(_load_example("plugin-hello-python")) as hello:
        c = httpx.Client(base_url=host.url, timeout=30.0)
        s = Session(base_url=host.url, user="bob")
        loaded = s.load("phantom:landmark")
        study_id = loaded.get("studyId") or loaded.get("study_id") or "current"
        assert c.post("/api/v1/plugins", json={"endpoint": hello.url}, headers=ADMIN).status_code == 201
        listed = c.get("/api/v1/plugins", headers=CONTOURER).json()
        assert listed[0]["plugin_id"] == "hello-threshold" and listed[0]["allowed"]

        r = c.post(
            "/api/v1/plugins/hello-threshold/run",
            json={"params": {"hu_min": 0, "name": "Sphere"}, "study_id": study_id},
            headers=CONTOURER,
        )
        assert r.status_code == 202, r.text
        job_id = r.json()["job_id"]
        job = _wait_job(c, job_id, CONTOURER)
        assert job["status"] == "done", job.get("error")
        assert job["kind"] == "plugin:hello-threshold" and job["accepted"] == 1 and job["rejected"] == 0
        assert job["module_version"] == "hello-threshold@0.1.1"
        bundle = job["bundles"][0]
        assert bundle["accepted"][0]["kind"] == "structure" and bundle["accepted"][0]["voxels"] > 0
        assert bundle["files"], "抓回的 labelmap 要落 blob store"
        assert "token_sha256" not in job  # to_wire 不含 request；job.request 的 token 在 done 後抹掉（見下）
        rt = host_app.state.rtgaia
        stored = [j for j in rt.store.case(job["case_id"]).jobs.values() if j["job_id"] == job_id]
        assert stored and stored[0]["status"] == "done"

        # 回呼 token 用完即失效（job 的 request 裡已經沒有它的雜湊）。以前這裡包在永遠不成立的 if 裡、什麼都沒驗
        async def _get() -> Any:
            return await (await rt.job_queue_async()).get(job_id)

        pm_job = asyncio.run_coroutine_threadsafe(_get(), rt.loop).result(10)
        assert "token_sha256" not in pm_job.request
        r = c.post(
            f"/api/v1/plugins/hello-threshold/jobs/{job_id}/progress",
            json={"percent": 1},
            headers={"Authorization": "Bearer nope"},
        )
        assert r.status_code == 403
        actions = [e["action"] for e in rt.audit_tail]
        assert "plugin.results" in actions and "plugin.hello.run" in actions

        # ── 結果落地成暫存結構，只有 bob 看得到、可編輯、不能簽核；保存後進工作集大家都看得到 ──
        assert job["materialized"] == 1
        mine = c.get(f"/api/v1/studies/{study_id}/structures", headers=CONTOURER).json()
        tr = [e for e in mine if e.get("structure_set_kind") == "transient"]
        assert (
            len(tr) == 1
            and tr[0]["name"] == "Sphere"
            and tr[0]["editable"] is True
            and tr[0]["status"] == "ai_generated"
        )
        others = c.get(f"/api/v1/studies/{study_id}/structures", headers=ADMIN).json()
        assert not [e for e in others if e.get("structure_set_kind") == "transient"], "別人不該看到暫存結果"
        sets_bob = c.get(f"/api/v1/cases/{job['case_id']}/structure-sets", headers=CONTOURER).json()
        assert [x["kind"] for x in sets_bob].count("transient") == 1 and next(
            x for x in sets_bob if x["kind"] == "transient"
        )["mine"]
        assert not [
            x
            for x in c.get(f"/api/v1/cases/{job['case_id']}/structure-sets", headers=ADMIN).json()
            if x["kind"] == "transient"
        ]
        summary = c.get(f"/api/v1/cases/{job['case_id']}/transient", headers=CONTOURER).json()
        assert summary["count"] == 1 and summary["bytes"] > 0
        sid = tr[0]["structure_id"]
        r = c.post(
            f"/api/v1/studies/{study_id}/review",
            json={"structure_statuses": {sid: "approved"}},
            headers={**CONTOURER, "X-RTGaia-Role": "approver"},
        )
        assert r.status_code == 409 and r.json()["detail"]["code"] == "TRANSIENT_NOT_SIGNABLE"
        r = c.post(f"/api/v1/cases/{job['case_id']}/transient/save", json={"structure_ids": [sid]}, headers=CONTOURER)
        assert r.status_code == 200 and r.json()["saved"] == [sid]
        after = {e["structure_id"]: e for e in c.get(f"/api/v1/studies/{study_id}/structures", headers=ADMIN).json()}
        assert after[sid]["structure_set_kind"] == "work" and after[sid]["structure_set_owner"] == "bob"
        assert c.get(f"/api/v1/cases/{job['case_id']}/transient", headers=CONTOURER).json()["count"] == 0

        # 再跑一次 → 丟棄
        r = c.post(
            "/api/v1/plugins/hello-threshold/run",
            json={"params": {"name": "Sphere2"}, "study_id": study_id},
            headers=CONTOURER,
        )
        job2 = _wait_job(c, r.json()["job_id"], CONTOURER)
        assert job2["status"] == "done"
        r = c.post(f"/api/v1/cases/{job['case_id']}/transient/discard", json={}, headers=CONTOURER)
        assert r.status_code == 200 and len(r.json()["discarded"]) == 1
        names = [e["name"] for e in c.get(f"/api/v1/studies/{study_id}/structures", headers=CONTOURER).json()]
        assert "Sphere2" not in names and "Sphere" in names


@pytest.mark.e2e
def test_poll_mode_rejected_bundle_fails_job(tmp_path, monkeypatch) -> None:
    """poll 模式 ＋ 回錯網格：宿主輪詢拿到結果 → B3 全拒 → job failed 帶原因。"""
    import numpy as np
    from rtgaia_geom import Grid
    from rtgaia_plugin_sdk import PluginApp, RunContext
    from rtgaia_testbe.api import create_app

    monkeypatch.setenv("RTGAIA_PLUGIN_TICK_SECONDS", "0.3")
    monkeypatch.setenv("RTGAIA_PLUGIN_HEALTH_SECONDS", "0")
    host_port = _free_port()
    monkeypatch.setenv("RTGAIA_PUBLIC_URL", f"http://127.0.0.1:{host_port}")

    def run(ctx: RunContext) -> None:
        g = ctx.input_grid
        bad = Grid(
            size=g.size,
            spacing=(9.0, 9.0, 9.0),
            origin=g.origin,
            direction=g.direction,
            frame_of_reference_uid=g.frame_of_reference_uid,
        )
        url = ctx.publish_nifti("seg.nii.gz", np.ones(tuple(reversed(g.size)), dtype=np.uint8), bad)
        ctx.submit(
            ctx.bundle().add_structure_labelmap(
                name="Bad", color_rgb=(1, 1, 1), frame_of_reference_uid=g.frame_of_reference_uid, url=url, value=1
            )
        )

    manifest = {
        "id": "bad-grid",
        "version": "0.0.1",
        "api_version": "1",
        "label": "bad",
        "licenses": ["MIT"],
        "soup": [],
        "required_role": "contourer",
        "capabilities": ["write-transient"],
        "inputs": {"image": {"required": True, "format": "nifti"}, "params_schema": {"type": "object"}},
        "outputs": {"kinds": ["structures"], "encodings": ["labelmap"]},
        "execution": {"timeout_s": 60, "progress": "poll", "concurrency": 1},
    }
    host_app = create_app(test_api=True)
    host = Served.__new__(Served)
    host.port = host_port
    host.server = uvicorn.Server(
        uvicorn.Config(host_app, host="127.0.0.1", port=host_port, log_level="warning", access_log=False)
    )
    host.thread = threading.Thread(target=host.server.run, daemon=True)
    plugin = PluginApp(manifest=manifest, run=run, artifacts_dir=tmp_path / "a").app
    with host, Served(plugin) as p:
        c = httpx.Client(base_url=host.url, timeout=30.0)
        s = Session(base_url=host.url, user="bob")
        s.load("phantom:landmark")
        assert c.post("/api/v1/plugins", json={"endpoint": p.url}, headers=ADMIN).status_code == 201
        r = c.post("/api/v1/plugins/bad-grid/run", json={"params": {}}, headers=CONTOURER)
        assert r.status_code == 202, r.text
        job = _wait_job(c, r.json()["job_id"], CONTOURER)
        assert job["status"] == "failed" and "B3" in (job["error"] or ""), job


def test_dispatch_failure_revokes_the_callback_token(driver: Session) -> None:
    """派工失敗（plugin 回 429 或不是 202）時，回呼 token 以前沒撤銷 —— 只有 finish() 會清，
    回呼驗證又不看工作狀態，plugin 拿著那個 token 還能回報進度、送結果。文件說 job 結束 token 就失效。"""
    driver.load("phantom:landmark")
    plugin = fake_plugin()
    seen: dict[str, Any] = {}

    @plugin.post("/run")
    async def _busy(request: Request) -> Any:
        seen.update(await request.json())
        raise HTTPException(429)

    with Served(plugin) as fp:
        assert _api(driver, "POST", "/api/v1/plugins", ADMIN, json={"endpoint": fp.url}).status_code == 201
        body = {"params": {"n": 1}, "study_id": driver.study_id}
        r = _api(driver, "POST", "/api/v1/plugins/fake-x/run", CONTOURER, json=body)
        assert r.status_code == 202, r.text
        job = _wait_job(driver._client, r.json()["job_id"], CONTOURER)
        assert job["status"] == "failed" and "429" in (job["error"] or ""), job
        token = seen["callback"]["token"]
        late = _api(
            driver,
            "POST",
            f"/api/v1/plugins/fake-x/jobs/{job['job_id']}/progress",
            {"Authorization": f"Bearer {token}"},
            json={"percent": 50},
        )
        assert late.status_code in (403, 409), late.text
        assert _api(driver, "GET", f"/api/v1/jobs/{job['job_id']}", CONTOURER).json()["percent"] != 50


@pytest.mark.e2e
def test_poll_mode_results_are_accepted_once(tmp_path, monkeypatch) -> None:  # type: ignore[no-untyped-def]
    """poll 模式下 plugin 做完會打 `/done`（提早通知，宿主去拉結果），宿主的輪詢也會拉 —— 以前兩邊各拿一份副本
    各收一次，暫存結構落地兩次。這裡把結果檢查放慢，讓輪詢一定在 `/done` 處理到一半時進來。"""
    import numpy as np
    from rtgaia_core import plugins as host_plugins
    from rtgaia_plugin_sdk import PluginApp, RunContext
    from rtgaia_testbe.api import create_app

    monkeypatch.setenv("RTGAIA_PLUGIN_TICK_SECONDS", "0.2")
    monkeypatch.setenv("RTGAIA_PLUGIN_HEALTH_SECONDS", "0")
    host_port = _free_port()
    monkeypatch.setenv("RTGAIA_PUBLIC_URL", f"http://127.0.0.1:{host_port}")
    real_check = host_plugins.check_bundle_semantics

    def slow_check(*args: Any, **kwargs: Any) -> Any:
        time.sleep(1.0)
        return real_check(*args, **kwargs)

    monkeypatch.setattr(host_plugins, "check_bundle_semantics", slow_check)

    def run(ctx: RunContext) -> None:
        g = ctx.input_grid
        url = ctx.publish_nifti("seg.nii.gz", np.ones(tuple(reversed(g.size)), dtype=np.uint8), g)
        ctx.submit(
            ctx.bundle().add_structure_labelmap(
                name="Once", color_rgb=(1, 1, 1), frame_of_reference_uid=g.frame_of_reference_uid, url=url, value=1
            )
        )

    manifest = {
        "id": "poll-once",
        "version": "0.0.1",
        "api_version": "1",
        "label": "poll once",
        "licenses": ["MIT"],
        "soup": [],
        "required_role": "contourer",
        "capabilities": ["write-transient"],
        "inputs": {"image": {"required": True, "format": "nifti"}, "params_schema": {"type": "object"}},
        "outputs": {"kinds": ["structures"], "encodings": ["labelmap"]},
        "execution": {"timeout_s": 60, "progress": "poll", "concurrency": 1},
    }
    host_app = create_app(test_api=True)
    host = Served.__new__(Served)
    host.port = host_port
    host.server = uvicorn.Server(
        uvicorn.Config(host_app, host="127.0.0.1", port=host_port, log_level="warning", access_log=False)
    )
    host.thread = threading.Thread(target=host.server.run, daemon=True)
    plugin = PluginApp(manifest=manifest, run=run, artifacts_dir=tmp_path / "a").app
    with host, Served(plugin) as p:
        c = httpx.Client(base_url=host.url, timeout=30.0)
        s = Session(base_url=host.url, user="bob")
        s.load("phantom:landmark")
        assert c.post("/api/v1/plugins", json={"endpoint": p.url}, headers=ADMIN).status_code == 201
        r = c.post("/api/v1/plugins/poll-once/run", json={"params": {}}, headers=CONTOURER)
        assert r.status_code == 202, r.text
        job = _wait_job(c, r.json()["job_id"], CONTOURER)
        time.sleep(1.5)  # 晚到的那一次（若有）也做完
        job = c.get(f"/api/v1/jobs/{job['job_id']}", headers=CONTOURER).json()
        assert job["status"] == "done", job
        assert len(job["bundles"]) == 1 and job["accepted"] == 1 and job["materialized"] == 1, job
        mine = [e for e in s.structures() if e["name"] == "Once"]
        assert len(mine) == 1, [e["structure_id"] for e in mine]


def test_transient_set_rules_and_drop_on_last_session(driver: Session) -> None:
    """暫存集：擁有者可編輯、別人看不到；擁有者最後一個 session 走了就銷毀。"""
    import numpy as np
    from rtgaia_core.state import StructureState
    from rtgaia_geom import Provenance, payload_content_hash

    driver.load("phantom:landmark")
    rt = driver._app.state.rtgaia
    session = rt.store.current()
    case = session.case
    for_uid = session.mask_grid.grid.frame_of_reference_uid
    tset = case.transient_set_for("bob", for_uid, module_version="x@1")
    block = np.ones((2, 2, 2), dtype=np.uint8)
    st = StructureState(
        structure_id="pl_test_000",
        name="T",
        color_rgb=(1, 2, 3),
        frame_of_reference_uid=for_uid,
        offset_ijk=(0, 0, 0),
        size_ijk=(2, 2, 2),
        block=block,
        content_hash=payload_content_hash(offset_ijk=(0, 0, 0), size_ijk=(2, 2, 2), data=block.tobytes(), prefix="mh_"),
        provenance=Provenance(source="model", module_version="x@1"),
        structure_set_id=tset["structure_set_id"],
    )
    case.structures[st.key] = st
    assert case.can_edit(st, user="bob") == (True, None)
    assert case.can_edit(st, user="alice", is_admin=True) == (False, "NOT_OWNER")
    assert "pl_test_000" in [e["structure_id"] for e in case.structure_list(user="bob")]
    assert "pl_test_000" not in [e["structure_id"] for e in case.structure_list(user="alice")]
    assert "pl_test_000" in [e["structure_id"] for e in case.structure_list()]  # 內部（無使用者）全看得到
    # bob 沒有 session：模擬 bob 的 session 建立再被清
    from rtgaia_core.state import Session as S

    bob = S(
        session_id="s_bob",
        case=case,
        tier_decision=session.tier_decision,
        display_grid=session.display_grid,
        grid_notes={},
        user="bob",
    )
    rt.store.put(bob)
    rt.store._drop_session("s_bob")
    assert case.transient_structures("bob") == [] and not [
        s for s in case.structure_sets if s.get("kind") == "transient"
    ]


DB_URL = os.environ.get("RTGAIA_TEST_DB_URL", "")


@pytest.mark.db
def test_plugin_job_kind_fits_db_column(tmp_path, monkeypatch) -> None:
    """🔴 `job.kind` 原本 varchar(16)，`plugin:nnunet-oar` 17 字 → 500（實測撞到）。

    migration 0011 放寬到 64。"""
    if not DB_URL:
        pytest.skip("RTGAIA_TEST_DB_URL 未設")
    from test_jobs_audit import downgrade_base, upgrade_to_head

    monkeypatch.setenv("RTGAIA_DATA_DIR", str(tmp_path / "data"))
    downgrade_base(DB_URL)
    upgrade_to_head(DB_URL)
    app = fake_plugin()
    with Served(app) as fp, Session(db_url=DB_URL, auth="off", user="bob") as s:
        s.load("phantom:landmark")
        # plugin id 故意超過 16 字（含前綴 plugin:）
        app.state.fake["version"] = "1.0.0"
        assert _api(s, "POST", "/api/v1/plugins", ADMIN, json={"endpoint": fp.url}).status_code == 201
        r = _api(s, "POST", "/api/v1/plugins/fake-x/run", CONTOURER, json={"params": {"n": 1}})
        assert r.status_code == 202, r.text
        job = _api(s, "GET", f"/api/v1/jobs/{r.json()['job_id']}", CONTOURER).json()
        assert job["kind"] == "plugin:fake-x"
        # 登錄也進了 DB（重建 store 後還在）
        import asyncio

        from rtgaia_server.db.plugins import DbPlugins

        rt = s._app.state.rtgaia
        rows = asyncio.run_coroutine_threadsafe(DbPlugins(rt.catalog_store.engine).list(), rt.loop).result(10)
        assert [p.plugin_id for p in rows] == ["fake-x"]  # 以前包在永遠不成立的 if 裡
