"""uvicorn 的進入點（`rtgaia-testbe`）：讀環境變數，`--load phantom:<id>`／`dicom:<dir>` 都支援。"""

from __future__ import annotations

import os

from rtgaia_core.state import build_session
from rtgaia_core.tiers import ClientCapability

from .app import create_app
from .phantoms import build

chaos = {mode: True for mode in os.environ.get("RTGAIA_TESTBE_CHAOS", "").split(",") if mode}
app = create_app(latency_ms=int(os.environ.get("RTGAIA_TESTBE_LATENCY", "0") or 0), chaos=chaos)

_preload = os.environ.get("RTGAIA_TESTBE_LOAD", "")
if _preload:
    # `phantom:` 與 `dicom:` 都要支援 —— 只認 phantom 的話 `--load dicom:...` 會靜默無效（實際踩過）。
    if _preload.startswith("phantom:"):
        _dataset = build(_preload.split(":", 1)[1])
    elif _preload.startswith("dicom:"):
        from rtgaia_core.loaders.dicom import load_dicom_dataset

        _dataset = load_dicom_dataset(_preload.split(":", 1)[1])
    else:
        raise SystemExit(f'--load must start with "phantom:" or "dicom:"; got {_preload!r}')
    app.state.rtgaia.store.put(build_session(dataset=_dataset, capability=ClientCapability(), source=_preload))
