"""uvicorn 的進入點（`rtgaia-server`）：讀環境變數。

`--load dicom:<dir>` 預載一個病例；合成假體在 `rtgaia_testbe.asgi`。"""

from __future__ import annotations

import os

from rtgaia_core.state import build_session
from rtgaia_core.tiers import ClientCapability

from .app import create_app

app = create_app(latency_ms=int(os.environ.get("RTGAIA_TESTBE_LATENCY", "0") or 0))

_preload = os.environ.get("RTGAIA_TESTBE_LOAD", "")
if _preload:
    if _preload.startswith("dicom:"):
        from rtgaia_core.loaders.dicom import load_dicom_dataset

        _dataset = load_dicom_dataset(_preload.split(":", 1)[1])
    else:
        raise SystemExit(
            f'rtgaia-server --load only accepts "dicom:<directory>" (use rtgaia-testbe for synthetic phantoms); '
            f"got {_preload!r}"
        )
    app.state.rtgaia.store.put(build_session(dataset=_dataset, capability=ClientCapability(), source=_preload))
