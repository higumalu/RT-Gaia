"""遠端推論服務（remote 模式的另一端）：放在有 GPU 的機器上，plugin 只轉發。

介面刻意極小，任何實作都能替換：
* `GET /health` → `{"status": "ok", "engine": …}`
* `GET /labels` → `{"1": {"name", "color", "tg263"}, …}`
* `POST /predict`（multipart：`image`=.nii.gz、`structures`=JSON 名稱陣列，空＝全部）→ `.nii.gz` labelmap（同輸入網格）

`RTGAIA_SEG_REMOTE_TOKEN` 設了就要 bearer。跑：`uv run uvicorn server:app --port 8710`。
"""

from __future__ import annotations

import json
import os
import tempfile
from pathlib import Path
from typing import Any

from engine import make_engine
from fastapi import FastAPI, File, Form, HTTPException, Request, UploadFile
from fastapi.responses import Response

ENGINE = make_engine()
TOKEN = os.environ.get("RTGAIA_SEG_REMOTE_TOKEN")
app = FastAPI(title="RT-Gaia segmentation server", version="0.2.0")


def _auth(request: Request) -> None:
    if TOKEN and request.headers.get("authorization") != f"Bearer {TOKEN}":
        raise HTTPException(401, {"code": "PL-SCOPE", "message": "bearer token does not match"})


@app.get("/health")
def health(request: Request) -> dict[str, Any]:
    _auth(request)
    return {"status": "ok", **ENGINE.health()}


@app.get("/labels")
def labels(request: Request) -> dict[str, Any]:
    _auth(request)
    return {str(k): v for k, v in ENGINE.labels().items()}


@app.post("/predict")
async def predict(request: Request, image: UploadFile = File(...), structures: str = Form("[]")) -> Response:  # noqa: B008
    _auth(request)
    roi = [str(s) for s in json.loads(structures or "[]")] or None
    with tempfile.TemporaryDirectory() as tmp:
        in_path = Path(tmp) / "ct.nii.gz"
        in_path.write_bytes(await image.read())
        try:
            out = ENGINE.predict(in_path, Path(tmp), roi, lambda p, ph: None)
        except Exception as exc:  # noqa: BLE001
            raise HTTPException(500, {"code": "PL-DOWN", "message": f"inference failed: {exc}"}) from exc
        return Response(out.read_bytes(), media_type="application/gzip", headers={"X-RTGaia-Engine": ENGINE.id})
