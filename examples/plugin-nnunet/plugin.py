"""nnU-Net 系自動圈選 plugin（契約 v1）—— 兩種模式、ROI 可選。

| 模式 | 意思 | 設定 |
|---|---|---|
| `local` | 引擎在 **這個 plugin 行程** 裡跑（與 RT-Gaia 同 compose 部署；GPU 在本機） | `RTGAIA_SEG_ENGINE` |
| `remote` | 只轉發：把 CT 送到遠端推論服務（`server.py`）拿回 labelmap | 面板填 URL 與 port（admin） |

面板（`ui/`）用到的自訂端點（宿主代理 `/api/v1/modules/nnunet-oar/…` → 這裡，帶 `X-RTGaia-Actor`／`X-RTGaia-Role`）：
`GET /labels`（可選 ROI 清單）、`GET /settings`、`PATCH /settings`（admin）、`POST /remote/health`（測試連線）。
ROI 選擇走契約的 `params.structures`（名稱陣列）；沒選＝全部。

環境：`RTGAIA_SEG_ENGINE`（預設 totalseg）、`RTGAIA_SEG_DEVICE`（gpu|cpu）、`RTGAIA_TOTALSEG_FAST`（預設 1）、
`RTGAIA_PLUGIN_DATA`（settings.json 放哪，預設 ./data）、`RTGAIA_SEG_MODE`（local|remote 的初始值）、
`RTGAIA_SEG_REMOTE_URL`／`RTGAIA_SEG_REMOTE_PORT`（remote 初始值）。
"""

from __future__ import annotations

import json
import os
import tempfile
import threading
from pathlib import Path
from typing import Any

import httpx
import numpy as np
from engine import Engine, make_engine
from fastapi import HTTPException, Request
from rtgaia_plugin_sdk import PluginApp, RunContext, read_nifti, require_role, write_nifti

PLUGIN_ID = "nnunet-oar"
VERSION = "0.2.2"
DATA_DIR = Path(os.environ.get("RTGAIA_PLUGIN_DATA", "./data")).resolve()
UI_DIR = Path(__file__).parent / "ui" / "dist"


# ── 設定（plugin 級；remote 的 URL／port 是基礎設施事實，不是個人偏好）──────────
class Settings:
    def __init__(self) -> None:
        self._lock = threading.Lock()
        self.path = DATA_DIR / "settings.json"
        self.data: dict[str, Any] = {
            "mode": os.environ.get("RTGAIA_SEG_MODE", "local"),
            "remote_url": os.environ.get("RTGAIA_SEG_REMOTE_URL", ""),
            "remote_port": int(os.environ.get("RTGAIA_SEG_REMOTE_PORT", "8710")),
            "remote_token": os.environ.get("RTGAIA_SEG_REMOTE_TOKEN", ""),
        }
        if self.path.is_file():
            self.data.update(json.loads(self.path.read_text(encoding="utf-8")))

    def get(self) -> dict[str, Any]:
        with self._lock:
            return dict(self.data)

    def patch(self, patch: dict[str, Any]) -> dict[str, Any]:
        allowed = {"mode", "remote_url", "remote_port", "remote_token"}
        bad = set(patch) - allowed
        if bad:
            raise HTTPException(422, {"code": "PL-SCHEMA", "message": f"unknown fields {sorted(bad)}"})
        if "mode" in patch and patch["mode"] not in ("local", "remote"):
            raise HTTPException(
                422, {"code": "PL-SCHEMA", "message": "mode must be local or remote", "pointer": "/mode"}
            )
        if "remote_port" in patch and not (1 <= int(patch["remote_port"]) <= 65535):
            raise HTTPException(422, {"code": "PL-SCHEMA", "message": "port 1–65535", "pointer": "/remote_port"})
        if (
            "remote_url" in patch
            and patch["remote_url"]
            and not str(patch["remote_url"]).startswith(("http://", "https://"))
        ):
            raise HTTPException(
                422,
                {"code": "PL-SCHEMA", "message": "URL must start with http:// or https://", "pointer": "/remote_url"},
            )
        with self._lock:
            self.data.update(patch)
            if "remote_port" in patch:
                self.data["remote_port"] = int(patch["remote_port"])
            DATA_DIR.mkdir(parents=True, exist_ok=True)
            self.path.write_text(json.dumps(self.data, ensure_ascii=False, indent=2), encoding="utf-8")
            return dict(self.data)

    def remote_base(self) -> str:
        d = self.get()
        url = d["remote_url"].rstrip("/")
        if not url:
            raise RuntimeError("remote mode needs a URL")
        # URL 本身沒帶 port 時補上面板填的 port
        from urllib.parse import urlsplit, urlunsplit

        parts = urlsplit(url)
        if parts.port is None and d["remote_port"]:
            netloc = f"{parts.hostname}:{d['remote_port']}"
            url = urlunsplit((parts.scheme, netloc, parts.path, "", ""))
        return url

    def remote_headers(self) -> dict[str, str]:
        tok = self.get().get("remote_token")
        return {"Authorization": f"Bearer {tok}"} if tok else {}


SETTINGS = Settings()
ENGINE: Engine = make_engine()

# TotalSegmentator／nnU-Net 內部會開 multiprocessing.Pool（Linux 預設 fork）。這個伺服器行程有很多執行緒、
# 也初始化過 CUDA，fork 出來的子行程可能繼承到被鎖住的鎖而永遠卡住（job 停在「prepare」、GPU 0%；
# 2026-10-09 錄 demo 時遇到）→ 真的引擎一律 spawn。fake 引擎（契約測試）不改：同一個測試行程的其他測試可能依賴 fork。
if ENGINE.id != "fake":
    import multiprocessing

    multiprocessing.set_start_method("spawn", force=True)


def _public(d: dict[str, Any]) -> dict[str, Any]:
    out = {k: v for k, v in d.items() if k != "remote_token"}
    out["remote_token_set"] = bool(d.get("remote_token"))
    out["engine"] = ENGINE.id
    return out


# ── labels：local 問引擎；remote 問遠端服務 ─────────────────────────────────
def current_labels() -> dict[int, dict[str, Any]]:
    if SETTINGS.get()["mode"] == "remote":
        r = httpx.get(SETTINGS.remote_base() + "/labels", headers=SETTINGS.remote_headers(), timeout=30)
        r.raise_for_status()
        return {int(k): v for k, v in r.json().items()}
    return ENGINE.labels()


# ── manifest ──────────────────────────────────────────────────────────────────
MANIFEST: dict[str, Any] = {
    "id": PLUGIN_ID,
    "version": VERSION,
    "api_version": "1",
    "label": "AI 圈選（nnU-Net）",
    "description": "nnU-Net 系器官自動圈選。local：引擎在本 plugin 內；remote：轉發到遠端推論服務。"
    "權重預設 TotalSegmentator（非商業授權）。",
    "icon": "🧠",
    "licenses": ["Apache-2.0"],
    "soup": ENGINE.soup,
    "required_role": "contourer",
    "capabilities": ["read-image", "write-transient", "audit"],
    "inputs": {
        "image": {"required": True, "format": "nifti", "modalities": ["CT"]},
        "params_schema": {
            "type": "object",
            "properties": {
                "structures": {
                    "type": "array",
                    "title": "Structures to compute (empty = all)",
                    "description": "Names come from GET /labels",
                    "items": {"type": "string"},
                },
            },
        },
    },
    "outputs": {"kinds": ["structures"], "encodings": ["labelmap"]},
    "execution": {"timeout_s": 3600, "progress": "callback", "concurrency": 1},
}
if UI_DIR.is_dir():
    # `trust: host-equivalent`：UI bundle 以宿主權限執行；沒宣告宿主不載
    MANIFEST["ui"] = {
        "bundle": "/ui/index.js",
        "sdk_version": "^0.1.1",
        "trust": "host-equivalent",
        "panels": [f"{PLUGIN_ID}.panel"],
    }


# ── 執行 ──────────────────────────────────────────────────────────────────────
def _predict_local(in_path: Path, out_dir: Path, roi: list[str] | None, ctx: RunContext) -> Path:
    return ENGINE.predict(in_path, out_dir, roi, lambda p, ph: ctx.progress(p, ph))


def _predict_remote(in_path: Path, out_dir: Path, roi: list[str] | None, ctx: RunContext) -> Path:
    base = SETTINGS.remote_base()
    ctx.progress(15, f"remote {base}")
    with open(in_path, "rb") as f, httpx.Client(timeout=float(ctx.request.get("timeout_s", 3600))) as client:
        data = {"structures": json.dumps(roi or [])}
        r = client.post(
            base + "/predict",
            files={"image": ("ct.nii.gz", f, "application/gzip")},
            data=data,
            headers=SETTINGS.remote_headers(),
        )
    if r.status_code != 200:
        raise RuntimeError(f"remote inference failed: HTTP {r.status_code}: {r.text[:500]}")
    out = out_dir / "seg.nii.gz"
    out.write_bytes(r.content)
    ctx.progress(75, "remote done")
    return out


def run(ctx: RunContext) -> None:
    volume, grid = ctx.fetch_image()
    ctx.progress(5, "prepare")
    roi = [str(s) for s in (ctx.params.get("structures") or [])] or None
    labels = current_labels()
    if roi:
        known = {v["name"] for v in labels.values()}
        unknown = sorted(set(roi) - known)
        if unknown:
            raise RuntimeError(f"unknown structures: {unknown} (GET /labels lists them)")
    mode = SETTINGS.get()["mode"]
    with tempfile.TemporaryDirectory() as tmp:
        tmpdir = Path(tmp)
        in_path = tmpdir / "ct.nii.gz"
        write_nifti(volume, grid, in_path)
        seg_path = (_predict_remote if mode == "remote" else _predict_local)(in_path, tmpdir, roi, ctx)
        ctx.progress(80, "publish")
        seg, seg_grid = read_nifti(seg_path, frame_of_reference_uid=grid.frame_of_reference_uid)
        if seg.shape != volume.shape:
            raise RuntimeError(f"output shape {seg.shape} differs from the input {volume.shape}")
        url = ctx.publish_nifti("seg.nii.gz", seg.astype(np.uint8 if seg.max() < 256 else np.uint16), seg_grid)

    present = set(np.unique(seg).tolist())
    bundle = ctx.bundle()
    count = 0
    for value, info in sorted(labels.items()):
        if roi and info["name"] not in roi:
            continue
        bundle.add_structure_labelmap(
            name=info["name"],
            color_rgb=tuple(info["color"]),
            frame_of_reference_uid=grid.frame_of_reference_uid,
            url=url,
            value=value,
            tg263_code=info.get("tg263"),
            allow_empty=value not in present,
        )
        count += 1
    ctx.progress(95, "submit")
    outcome = ctx.submit(bundle)
    ctx.audit(
        "nnunet.run",
        {
            "mode": mode,
            "engine": ENGINE.id if mode == "local" else "remote",
            "requested": roi,
            "structures": count,
            "accepted": len(outcome.get("accepted", [])),
            "rejected": len(outcome.get("rejected", [])),
        },
    )
    ctx.progress(100, "done")


plugin = PluginApp(manifest=MANIFEST, run=run, ui_dir=UI_DIR if UI_DIR.is_dir() else None)
app = plugin.app


# ── 面板用的自訂端點（宿主代理，帶身分標頭）─────────────────────────────────
@app.get("/labels")
def labels_route(request: Request) -> dict[str, Any]:
    require_role(request, "viewer")
    try:
        return {str(k): v for k, v in current_labels().items()}
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(503, {"code": "PL-DOWN", "message": f"cannot get the structure list: {exc}"}) from exc


@app.get("/settings")
def settings_get(request: Request) -> dict[str, Any]:
    require_role(request, "viewer")
    return _public(SETTINGS.get())


@app.patch("/settings")
async def settings_patch(request: Request) -> dict[str, Any]:
    require_role(request, "admin")
    return _public(SETTINGS.patch(await request.json()))


@app.post("/remote/health")
def remote_health(request: Request) -> dict[str, Any]:
    require_role(request, "viewer")
    try:
        base = SETTINGS.remote_base()
        r = httpx.get(base + "/health", headers=SETTINGS.remote_headers(), timeout=10)
        r.raise_for_status()
        return {"ok": True, "url": base, **r.json()}
    except Exception as exc:  # noqa: BLE001
        return {"ok": False, "error": str(exc)}


@app.get("/engine/health")
def engine_health(request: Request) -> dict[str, Any]:
    require_role(request, "viewer")
    return ENGINE.health()
