"""Plugin 端點的參考實作：開發者只寫 `run(ctx)`，其餘由 `PluginApp` 提供。

```python
from rtgaia_plugin_sdk import PluginApp, RunContext

def run(ctx: RunContext) -> None:
    volume, grid = ctx.fetch_image()              # (k, j, i) numpy ＋ Grid
    ctx.progress(10, "inference")
    labelmap = ...                                # 同一個 grid 上的整數 labelmap
    url = ctx.publish_nifti("seg.nii.gz", labelmap, grid)
    b = ctx.bundle()                              # BundleBuilder，module_version 已填
    b.add_structure_labelmap(name="Parotid_L", color_rgb=(255, 200, 0),
                             frame_of_reference_uid=grid.frame_of_reference_uid, url=url, value=1)
    ctx.submit(b)                                 # POST 宿主 /results；回傳 accepted／rejected

app = PluginApp(manifest=MANIFEST, run=run).app   # uvicorn plugin:app
```

* `/run` 回 202 後在背景執行緒跑 `run`；結束自動 `POST /done`（例外 → `failed` 帶訊息）。
* `execution.progress == "poll"` 時 `submit()` 只暫存，宿主用 `GET /jobs/{id}/result` 拉。
* 結果檔以 `publish_*()` 放在 plugin 自己的 `/artifacts/{job_id}/…`，
  URL 以請求的 base URL 或 `RTGAIA_PLUGIN_PUBLIC_URL` 組成。
* `RTGAIA_PLUGIN_TOKEN` 設了就驗 `Authorization: Bearer`；沒設不驗（只適合本機開發）。
"""

from __future__ import annotations

import asyncio
import os
import threading
import traceback
import uuid
from collections.abc import Callable
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import numpy as np
from fastapi import FastAPI, HTTPException, Request, Response
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from rtgaia_geom import Grid

from .bundle import BundleBuilder
from .contract import validate_bundle_structure, validate_manifest
from .geometry import grid_from_json, nifti_bytes, nifti_from_bytes
from .host_client import HostCallback


class Cancelled(Exception):
    pass


ROLE_ORDER = ("viewer", "contourer", "approver", "admin")


def actor_from_request(request: Request) -> tuple[str | None, str | None]:
    """宿主代理 `/api/v1/modules/{id}/…` 到 plugin 自訂端點時帶的身分。

    直接打 plugin（沒經宿主）時兩者都是 None —— plugin 自訂端點不要把 None 當成匿名放行。
    """
    return request.headers.get("x-rtgaia-actor"), request.headers.get("x-rtgaia-role")


def require_role(request: Request, role: str) -> str:
    """自訂端點的角色守門；回 actor 名。宿主代理時一定帶角色，沒帶就是沒經宿主 → 403。"""
    actor, got = actor_from_request(request)
    if got not in ROLE_ORDER or ROLE_ORDER.index(got) < ROLE_ORDER.index(role):
        raise HTTPException(
            403, {"code": "PL-ROLE", "message": f"requires {role}; got {got or '(not through the host)'}"}
        )
    return actor or "unknown"


@dataclass
class _Job:
    job_id: str
    request: dict[str, Any]
    status: str = "queued"
    percent: float = 0.0
    phase: str | None = None
    error: str | None = None
    result: dict[str, Any] | None = None
    cancel: threading.Event = field(default_factory=threading.Event)


class RunContext:
    """`run()` 拿到的一切。沒有宿主的其他任何東西 —— 契約之外的東西 plugin 本來就拿不到。"""

    def __init__(
        self,
        job: _Job,
        host: HostCallback,
        *,
        module_version: str,
        artifacts_dir: Path,
        public_base_url: str,
        poll_mode: bool,
    ) -> None:
        self._job = job
        self._host = host
        self._module_version = module_version
        self._artifacts = artifacts_dir
        self._public = public_base_url.rstrip("/")
        self._poll = poll_mode
        self.pending: list[dict[str, Any]] = []

    # ── 輸入 ────────────────────────────────────────────────────────────────
    @property
    def job_id(self) -> str:
        return self._job.job_id

    @property
    def params(self) -> dict[str, Any]:
        return self._job.request["inputs"].get("params", {})

    @property
    def request(self) -> dict[str, Any]:
        return self._job.request

    @property
    def input_grid(self) -> Grid:
        img = self._job.request["inputs"]["image"]
        return grid_from_json(img["grid"], frame_of_reference_uid=img["frame_of_reference_uid"])

    @property
    def parent_hash(self) -> str | None:
        return self._job.request["inputs"].get("image", {}).get("content_hash")

    def fetch_image_bytes(self) -> tuple[bytes, dict[str, str]]:
        return self._host.get_image_bytes()

    def fetch_image(self) -> tuple[np.ndarray, Grid]:
        """`manifest.inputs.image.format == "nifti"` 時：解成 (k, j, i) 體積 ＋ Grid。"""
        data, _ = self._host.get_image_bytes()
        arr, grid = nifti_from_bytes(data, frame_of_reference_uid=self.input_grid.frame_of_reference_uid)
        return arr, grid

    def fetch_structure_mask(self, structure_id: str) -> tuple[np.ndarray, Grid]:
        data = self._host.get_structure_mask(structure_id)
        return nifti_from_bytes(data, frame_of_reference_uid=self.input_grid.frame_of_reference_uid)

    # ── 進度與取消 ─────────────────────────────────────────────────────────
    def progress(self, percent: float, phase: str | None = None) -> None:
        self.check_cancelled()
        self._job.percent, self._job.phase = float(percent), phase
        try:
            self._host.progress(percent, phase)
        except Exception:  # noqa: BLE001 —— 進度回報失敗不該讓工作失敗
            pass

    def check_cancelled(self) -> None:
        if self._job.cancel.is_set():
            raise Cancelled()

    # ── 結果 ────────────────────────────────────────────────────────────────
    def publish_bytes(self, name: str, data: bytes) -> str:
        d = self._artifacts / self._job.job_id
        d.mkdir(parents=True, exist_ok=True)
        (d / name).write_bytes(data)
        return f"{self._public}/artifacts/{self._job.job_id}/{name}"

    def publish_nifti(self, name: str, volume: np.ndarray, grid: Grid) -> str:
        return self.publish_bytes(name, nifti_bytes(volume, grid, suffix=".nii.gz" if name.endswith(".gz") else ".nii"))

    def bundle(self, *, source: str = "model") -> BundleBuilder:
        return BundleBuilder(self._module_version, source=source, parent_hash=self.parent_hash)

    def submit(self, bundle: BundleBuilder | dict[str, Any]) -> dict[str, Any]:
        doc = bundle.to_dict() if isinstance(bundle, BundleBuilder) else bundle
        validate_bundle_structure(doc)
        if self._poll:
            self.pending.append(doc)
            return {"accepted": [], "rejected": [], "deferred": True}
        return self._host.results(doc)

    def audit(self, kind: str, payload: dict[str, Any]) -> None:
        self._host.audit(kind, payload)

    @property
    def kv(self) -> HostCallback:
        return self._host


RunFn = Callable[[RunContext], Any]


class PluginApp:
    def __init__(
        self,
        *,
        manifest: dict[str, Any],
        run: RunFn,
        artifacts_dir: str | Path | None = None,
        ui_dir: str | Path | None = None,
        token: str | None = None,
        public_url: str | None = None,
    ) -> None:
        validate_manifest(
            manifest, allow_licenses=manifest.get("licenses", [])
        )  # 開發者自己的授權由宿主決定收不收；這裡只驗結構
        self.manifest = manifest
        self.module_version = f"{manifest['id']}@{manifest['version']}"
        self._run = run
        self._token = token if token is not None else os.environ.get("RTGAIA_PLUGIN_TOKEN")
        self._public = public_url or os.environ.get("RTGAIA_PLUGIN_PUBLIC_URL")
        self._artifacts = Path(artifacts_dir or os.environ.get("RTGAIA_PLUGIN_ARTIFACTS", "./artifacts")).resolve()
        self._artifacts.mkdir(parents=True, exist_ok=True)
        self._jobs: dict[str, _Job] = {}
        self._lock = threading.Lock()
        self.app = FastAPI(title=manifest["label"], version=manifest["version"])
        self._routes(ui_dir)

    # ── 授權 ────────────────────────────────────────────────────────────────
    def _auth(self, request: Request) -> None:
        if self._token is None:
            return
        if request.headers.get("authorization") != f"Bearer {self._token}":
            raise HTTPException(401, {"code": "PL-SCOPE", "message": "bearer token does not match"})

    def _public_base(self, request: Request) -> str:
        return self._public or str(request.base_url).rstrip("/")

    # ── 路由 ────────────────────────────────────────────────────────────────
    def _routes(self, ui_dir: str | Path | None) -> None:
        app = self.app
        app.mount("/artifacts", StaticFiles(directory=str(self._artifacts)), name="artifacts")
        if ui_dir is not None:
            app.mount("/ui", StaticFiles(directory=str(ui_dir)), name="ui")

        @app.get("/manifest")
        def manifest(request: Request) -> dict[str, Any]:
            self._auth(request)
            return self.manifest

        @app.get("/health")
        def health(request: Request) -> dict[str, Any]:
            self._auth(request)
            return {"status": "ok", "version": self.manifest["version"]}

        @app.post("/run", status_code=202)
        async def run(request: Request) -> JSONResponse:
            self._auth(request)
            body = await request.json()
            for key in ("job_id", "callback", "case", "inputs", "actor", "timeout_s"):
                if key not in body:
                    raise HTTPException(
                        422, {"code": "PL-SCHEMA", "message": f"RunRequest is missing {key}", "pointer": f"/{key}"}
                    )
            limit = int(self.manifest["execution"]["concurrency"])
            with self._lock:
                running = sum(1 for j in self._jobs.values() if j.status in ("queued", "running"))
                if running >= limit:
                    return JSONResponse(
                        {"code": "PL-DOWN", "message": "concurrency limit reached"},
                        status_code=429,
                        headers={"Retry-After": "30"},
                    )
                job_id = str(body["job_id"]) or uuid.uuid4().hex
                job = _Job(job_id=job_id, request=body)
                self._jobs[job_id] = job
            public = self._public_base(request)
            asyncio.get_running_loop().run_in_executor(None, self._execute, job, public)
            return JSONResponse({"job_id": job_id}, status_code=202)

        @app.get("/jobs/{job_id}")
        def job_status(job_id: str, request: Request) -> dict[str, Any]:
            self._auth(request)
            job = self._jobs.get(job_id)
            if job is None:
                raise HTTPException(404, {"code": "PL-SCHEMA", "message": "no such job"})
            out: dict[str, Any] = {"status": job.status, "percent": job.percent}
            if job.phase:
                out["phase"] = job.phase
            if job.error:
                out["error"] = job.error
            return out

        @app.delete("/jobs/{job_id}", status_code=204)
        def cancel(job_id: str, request: Request) -> Response:
            self._auth(request)
            job = self._jobs.get(job_id)
            if job is not None:
                job.cancel.set()
            return Response(status_code=204)

        @app.get("/jobs/{job_id}/result")
        def result(job_id: str, request: Request) -> Any:
            self._auth(request)
            job = self._jobs.get(job_id)
            if job is None:
                raise HTTPException(404, {"code": "PL-SCHEMA", "message": "no such job"})
            if job.status != "done" or job.result is None:
                raise HTTPException(409, {"code": "PL-DOWN", "message": f"job is {job.status}; no result yet"})
            return job.result

        @app.get("/artifacts/{job_id}/{name}")
        def artifact(job_id: str, name: str) -> FileResponse:
            p = self._artifacts / job_id / name
            if not p.is_file():
                raise HTTPException(404)
            return FileResponse(str(p))

    # ── 執行 ────────────────────────────────────────────────────────────────
    def _execute(self, job: _Job, public_base_url: str) -> None:
        cb = job.request["callback"]
        poll = self.manifest["execution"]["progress"] == "poll"
        job.status = "running"
        with HostCallback(cb["base_url"], cb["token"]) as host:
            ctx = RunContext(
                job,
                host,
                module_version=self.module_version,
                artifacts_dir=self._artifacts,
                public_base_url=public_base_url,
                poll_mode=poll,
            )
            try:
                self._run(ctx)
                if poll:
                    job.result = (
                        _merge(ctx.pending)
                        if ctx.pending
                        else {
                            "bundle_version": "1",
                            "provenance": {
                                "module_version": self.module_version,
                                "source": "model",
                                "parent_hash": None,
                            },
                        }
                    )
                job.status, job.percent = "done", 100.0
                _quiet(lambda: host.done(status="done"))
            except Cancelled:
                job.status, job.error = "failed", "cancelled"
                _quiet(lambda: host.done(status="failed", error="cancelled"))
            except Exception as exc:  # noqa: BLE001 —— 任何例外都要變成 failed 帶訊息，不能悶掉
                job.status, job.error = "failed", f"{type(exc).__name__}: {exc}"
                traceback.print_exc()
                _quiet(lambda: host.done(status="failed", error=job.error))


def _quiet(fn: Callable[[], Any]) -> None:
    try:
        fn()
    except Exception:  # noqa: BLE001
        pass


def _merge(bundles: list[dict[str, Any]]) -> dict[str, Any]:
    """poll 模式：多次 submit 合成一包（provenance 取第一包）。"""
    out = dict(bundles[0])
    for b in bundles[1:]:
        for key in ("frame_groups", "images", "structures", "doses", "measurements", "reports"):
            if key in b:
                out.setdefault(key, []).extend(b[key])
    return out
