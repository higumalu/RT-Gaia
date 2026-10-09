"""`rtgaia-plugin-check <endpoint>`：模擬宿主把契約走一遍。

1. `GET /manifest` → schema、授權白名單、`api_version`
2. `GET /health`
3. 起一個本機「宿主回呼」伺服器（合成 CT：64×64×48、spacing 1×1×2、球體 +200 HU），`POST /run`
4. 等 `/done`（callback）或輪詢 `/jobs/{id}`（poll），期間收 `/progress`、`/results`
5. 每包過 `validate_bundle_structure` ＋ `check_bundle_semantics`（B1–B8，含 labelmap 網格 ＝ MaskGrid）
6. `manifest.ui` 有的話抓 bundle：只允許四個 external、入口 id／version 與 manifest 相同

程式化用法：`report = run_check(endpoint, token=None, public_host=None, timeout_s=600)`；`report.ok`。
"""

from __future__ import annotations

import argparse
import json
import re
import socket
import sys
import threading
import time
from dataclasses import dataclass, field
from typing import Any

import httpx
import numpy as np
import uvicorn
from fastapi import FastAPI, Header, HTTPException, Request, Response
from rtgaia_geom import Grid, digest_bytes

from .contract import (
    BundleRejection,
    ContractError,
    check_bundle_semantics,
    validate_bundle_structure,
    validate_manifest,
)
from .geometry import grid_to_json, nifti_bytes

PHANTOM_FOR = "1.2.826.0.1.3680043.8.498.99999.1"
ALLOWED_EXTERNALS = ("react", "react-dom", "react/jsx-runtime", "@rtgaia/sdk")


def phantom() -> tuple[np.ndarray, Grid]:
    grid = Grid(
        size=(64, 64, 48),
        spacing=(1.0, 1.0, 2.0),
        origin=(-32.0, -32.0, -48.0),
        direction=(1, 0, 0, 0, 1, 0, 0, 0, 1),
        frame_of_reference_uid=PHANTOM_FOR,
    )
    k, j, i = np.mgrid[0:48, 0:64, 0:64]
    x = grid.origin[0] + i * grid.spacing[0]
    y = grid.origin[1] + j * grid.spacing[1]
    z = grid.origin[2] + k * grid.spacing[2]
    vol = np.full((48, 64, 64), -1000, dtype=np.int16)
    vol[(x**2 + y**2 + z**2) <= 20.0**2] = 200
    return vol, grid


@dataclass
class CheckReport:
    steps: list[tuple[str, bool, str]] = field(default_factory=list)
    accepted: list[dict[str, Any]] = field(default_factory=list)
    rejected: list[BundleRejection] = field(default_factory=list)
    progress: list[dict[str, Any]] = field(default_factory=list)
    audits: list[dict[str, Any]] = field(default_factory=list)
    done: dict[str, Any] | None = None

    def step(self, name: str, ok: bool, detail: str = "") -> None:
        self.steps.append((name, ok, detail))

    @property
    def ok(self) -> bool:
        return all(ok for _, ok, _ in self.steps)

    def render(self) -> str:
        lines = [f"{'✅' if ok else '❌'} {name}" + (f" —— {d}" if d else "") for name, ok, d in self.steps]
        for r in self.rejected:
            lines.append(f"   ✗ {r.kind}[{r.index}] {r.code}: {r.reason}")
        for a in self.accepted:
            extra = f" voxels={a['voxels']}" if "voxels" in a else ""
            lines.append(f"   ✓ {a['kind']}[{a['index']}] {a.get('name', a.get('label', ''))}{extra}")
        return "\n".join(lines)


class MockHost:
    """宿主回呼端點的最小實作。所有 `/api/v1/plugins/{pid}/jobs/{jid}/…` 都收，token 要對。"""

    def __init__(
        self,
        *,
        plugin_id: str,
        job_id: str,
        token: str,
        module_version: str,
        quota_bytes: int,
        plugin_fetch: httpx.Client,
        report: CheckReport | None = None,
        image: tuple[np.ndarray, Grid] | None = None,
    ) -> None:
        self.report = report or CheckReport()
        self.finished = threading.Event()
        self.volume, self.grid = image if image is not None else phantom()
        self.nifti = nifti_bytes(self.volume, self.grid)
        self.content_hash = digest_bytes(self.nifti, prefix="sha256:", length=64)
        self._token = token
        self._mv = module_version
        self._quota = quota_bytes
        self._fetch = plugin_fetch
        self.kv: dict[str, Any] = {}
        self.app = FastAPI()
        base = f"/api/v1/plugins/{plugin_id}/jobs/{job_id}"
        app, rep = self.app, self.report

        def auth(authorization: str | None) -> None:
            if authorization != f"Bearer {token}":
                raise HTTPException(403, {"code": "PL-SCOPE", "message": "token does not match"})

        @app.get(base + "/inputs/image")
        def image(authorization: str | None = Header(default=None)) -> Response:
            auth(authorization)
            return Response(
                self.nifti,
                media_type="application/gzip",
                headers={
                    "X-RTGaia-Grid": json.dumps(grid_to_json(self.grid)),
                    "X-RTGaia-Content-Hash": self.content_hash,
                },
            )

        @app.get(base + "/inputs/structures")
        def structures(authorization: str | None = Header(default=None)) -> list[dict[str, Any]]:
            auth(authorization)
            return []

        @app.post(base + "/progress", status_code=204)
        async def progress(request: Request, authorization: str | None = Header(default=None)) -> Response:
            auth(authorization)
            rep.progress.append(await request.json())
            return Response(status_code=204)

        @app.post(base + "/results")
        async def results(request: Request, authorization: str | None = Header(default=None)) -> dict[str, Any]:
            auth(authorization)
            bundle = await request.json()
            return self.accept(bundle)

        @app.post(base + "/done", status_code=204)
        async def done(request: Request, authorization: str | None = Header(default=None)) -> Response:
            auth(authorization)
            rep.done = await request.json()
            self.finished.set()
            return Response(status_code=204)

        @app.post(base + "/audit", status_code=204)
        async def audit(request: Request, authorization: str | None = Header(default=None)) -> Response:
            auth(authorization)
            rep.audits.append(await request.json())
            return Response(status_code=204)

        @app.get(base + "/kv/{key:path}")
        def kv_get(key: str, authorization: str | None = Header(default=None)) -> Any:
            auth(authorization)
            if key not in self.kv:
                raise HTTPException(404, {"code": "PL-SCHEMA", "message": "no such key"})
            return self.kv[key]

        @app.put(base + "/kv/{key:path}", status_code=204)
        async def kv_put(key: str, request: Request, authorization: str | None = Header(default=None)) -> Response:
            auth(authorization)
            self.kv[key] = await request.json()
            return Response(status_code=204)

        @app.delete(base + "/kv/{key:path}", status_code=204)
        def kv_del(key: str, authorization: str | None = Header(default=None)) -> Response:
            auth(authorization)
            self.kv.pop(key, None)
            return Response(status_code=204)

    def accept(self, bundle: dict[str, Any]) -> dict[str, Any]:
        try:
            validate_bundle_structure(bundle)
        except ContractError as exc:
            self.report.step("results: bundle schema", False, str(exc))
            raise HTTPException(422, {"code": exc.code, "message": exc.message, "pointer": exc.pointer}) from exc
        self.report.step("results: bundle schema", True)

        def fetch(url: str) -> bytes:
            r = self._fetch.get(url)
            r.raise_for_status()
            return r.content

        accepted, rejected = check_bundle_semantics(
            bundle,
            expected_module_version=self._mv,
            known_frame_of_reference_uids=[self.grid.frame_of_reference_uid],
            mask_grids={self.grid.frame_of_reference_uid: self.grid},
            quota_bytes=self._quota,
            fetch=fetch,
        )
        self.report.accepted.extend(accepted)
        self.report.rejected.extend(rejected)
        self.report.step("results: B1–B8", not rejected, f"accepted {len(accepted)}, rejected {len(rejected)}")
        return {
            "accepted": [
                {"kind": a["kind"], "index": a["index"], "id": f"mock-{a['kind']}-{a['index']}"} for a in accepted
            ],
            "rejected": [r.to_wire() for r in rejected],
        }


def load_image_nifti(path: str, *, frame_of_reference_uid: str = PHANTOM_FOR) -> tuple[np.ndarray, Grid]:
    """`--image x.nii.gz`：NIfTI 沒有 FoR，這裡給一個固定的；plugin 只會原樣帶回。"""
    from .geometry import read_nifti

    arr, grid = read_nifti(path, frame_of_reference_uid=frame_of_reference_uid)
    return arr.astype(np.int16, copy=False), grid


def _free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return int(s.getsockname()[1])


def _serve(app: FastAPI, port: int) -> uvicorn.Server:
    server = uvicorn.Server(uvicorn.Config(app, host="0.0.0.0", port=port, log_level="warning"))
    threading.Thread(target=server.run, daemon=True).start()
    for _ in range(100):
        if server.started:
            break
        time.sleep(0.05)
    return server


def check_ui_bundle(js: str, manifest: dict[str, Any], report: CheckReport) -> None:
    specs = re.findall(r'(?:import|from)\s*["\']([^"\']+)["\']', js) + re.findall(r'import\(\s*["\']([^"\']+)["\']', js)
    bare = sorted({s for s in specs if not s.startswith((".", "/"))})
    disallowed = [s for s in bare if s not in ALLOWED_EXTERNALS]
    report.step(
        "ui: imports only allowed externals",
        not disallowed,
        f"{bare}" + (f" not allowed: {disallowed}" if disallowed else ""),
    )
    report.step("ui: React is not bundled", "react.production" not in js and "__SECRET_INTERNALS_DO_NOT_USE" not in js)
    # 靜態檢查只能看字面值：bundle 內必須出現 manifest 的 id 與 version 字串
    has_id = f'"{manifest["id"]}"' in js or f"'{manifest['id']}'" in js
    has_ver = f'"{manifest["version"]}"' in js or f"'{manifest['version']}'" in js
    report.step("ui: entry id and version match the manifest", has_id and has_ver)


def run_check(
    endpoint: str,
    *,
    token: str | None = None,
    public_host: str | None = None,
    timeout_s: float = 600.0,
    quota_bytes: int = 2 * 1024**3,
    params: dict[str, Any] | None = None,
    image: tuple[np.ndarray, Grid] | None = None,
) -> CheckReport:
    """`image`：用真實 CT 取代合成假體（(k, j, i) 體積 ＋ Grid；`load_image_nifti()` 可從 NIfTI 讀）。"""
    headers = {"Authorization": f"Bearer {token}"} if token else {}
    plugin = httpx.Client(base_url=endpoint.rstrip("/"), headers=headers, timeout=60.0)
    report = CheckReport()

    # 1. manifest
    try:
        r = plugin.get("/manifest")
        r.raise_for_status()
        manifest = r.json()
        validate_manifest(manifest)
        report.step("manifest: schema, licenses, api_version", True, f"{manifest['id']}@{manifest['version']}")
    except (httpx.HTTPError, ContractError, ValueError) as exc:
        report.step("manifest: schema, licenses, api_version", False, str(exc))
        return report

    # 2. health
    try:
        h = plugin.get("/health")
        h.raise_for_status()
        ok = h.json().get("status") in ("ok", "degraded") and h.json().get("version") == manifest["version"]
        report.step("health", ok, json.dumps(h.json()))
    except (httpx.HTTPError, ValueError) as exc:
        report.step("health", False, str(exc))
        return report

    if manifest["inputs"]["image"]["format"] != "nifti":
        report.step(
            "run",
            False,
            f"the checker only simulates NIfTI input (the manifest asks for {manifest['inputs']['image']['format']})",
        )
        return report

    # 3. mock host
    job_id = "chk_" + digest_bytes(str(time.time()).encode(), length=8)
    job_token = "tok_" + digest_bytes(job_id.encode(), length=24)
    mv = f"{manifest['id']}@{manifest['version']}"
    host = MockHost(
        plugin_id=manifest["id"],
        job_id=job_id,
        token=job_token,
        module_version=mv,
        quota_bytes=quota_bytes,
        plugin_fetch=plugin,
        report=report,
        image=image,
    )
    port = _free_port()
    server = _serve(host.app, port)
    base_url = f"http://{public_host or '127.0.0.1'}:{port}/api/v1/plugins/{manifest['id']}/jobs/{job_id}"
    try:
        run_req = {
            "job_id": job_id,
            "callback": {"base_url": base_url, "token": job_token, "expires_at": "2099-01-01T00:00:00Z"},
            "case": {"case_id": "chk-case", "primary_frame_of_reference_uid": host.grid.frame_of_reference_uid},
            "inputs": {
                "image": {
                    "series_id": "chk-ct",
                    "frame_of_reference_uid": host.grid.frame_of_reference_uid,
                    "modality": "CT",
                    "grid": grid_to_json(host.grid),
                    "content_hash": host.content_hash,
                    "url": base_url + "/inputs/image",
                },
                "structures": [],
                "params": params or {},
            },
            "actor": {"username": "plugin-check", "role": "contourer"},
            "timeout_s": int(timeout_s),
        }
        r = plugin.post("/run", json=run_req)
        if r.status_code != 202:
            report.step("run: 202", False, f"HTTP {r.status_code} {r.text[:200]}")
            return report
        pid = r.json().get("job_id")
        report.step("run: 202", True, f"job_id={pid}")

        # 4. wait
        poll = manifest["execution"]["progress"] == "poll"
        deadline = time.time() + timeout_s
        status: dict[str, Any] = {}
        while time.time() < deadline:
            if not poll and host.finished.is_set():
                break
            s = plugin.get(f"/jobs/{pid}")
            status = s.json() if s.status_code == 200 else {"status": f"http {s.status_code}"}
            if status.get("status") in ("done", "failed"):
                break
            time.sleep(0.5)
        if poll:
            report.step("jobs: done", status.get("status") == "done", json.dumps(status))
            if status.get("status") == "done":
                res = plugin.get(f"/jobs/{pid}/result")
                if res.status_code == 200:
                    try:
                        host.accept(res.json())
                    except HTTPException:
                        pass
                else:
                    report.step("jobs/result", False, f"HTTP {res.status_code}")
        else:
            report.step(
                "done: callback",
                report.done is not None and report.done.get("status") == "done",
                json.dumps(report.done) if report.done else "no /done received",
            )
        report.step(
            "progress: at least one report", len(report.progress) > 0 or poll, f"{len(report.progress)} received"
        )
        if not report.accepted and not report.rejected:
            report.step("results: at least one bundle", False)

        # 6. ui
        ui = manifest.get("ui")
        if ui:
            report.step(
                "ui: declares trust: host-equivalent (otherwise the host does not load the bundle "
                "and uses the declarative panel)",
                ui.get("trust") == "host-equivalent",
                str(ui.get("trust")),
            )
            r = plugin.get(ui["bundle"])
            if r.status_code != 200:
                report.step("ui: bundle can be fetched", False, f"HTTP {r.status_code}")
            else:
                report.step("ui: bundle can be fetched", True, f"{len(r.content)} bytes")
                check_ui_bundle(r.text, manifest, report)
    finally:
        server.should_exit = True
        plugin.close()
    return report


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(
        prog="rtgaia-plugin-check", description="Run a plugin through the contract with a simulated host"
    )
    p.add_argument("endpoint")
    p.add_argument("--token", default=None, help="The plugin's bearer token (the one entered when it is registered)")
    p.add_argument(
        "--public-host",
        default=None,
        help="Host name the plugin uses to reach this machine (for a plugin in a container, for example "
        "host.docker.internal)",
    )
    p.add_argument("--timeout", type=float, default=600.0)
    p.add_argument("--params", default="{}", help="JSON for RunRequest.inputs.params")
    p.add_argument(
        "--image",
        default=None,
        help="Use this NIfTI file (.nii or .nii.gz) as the input CT instead of the synthetic phantom",
    )
    args = p.parse_args(argv)
    image = load_image_nifti(args.image) if args.image else None
    report = run_check(
        args.endpoint,
        token=args.token,
        public_host=args.public_host,
        timeout_s=args.timeout,
        params=json.loads(args.params),
        image=image,
    )
    print(report.render())
    print("PASS" if report.ok else "FAIL")
    return 0 if report.ok else 1


if __name__ == "__main__":
    sys.exit(main())
