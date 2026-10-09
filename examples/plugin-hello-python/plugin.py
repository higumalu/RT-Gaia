"""最小 plugin：把輸入 CT 裡 HU > 0 的連通區當一個結構回傳。驗證用，不是臨床工具。

跑：`uv run uvicorn plugin:app --port 8701`（在這個目錄）
驗：`uv run rtgaia-plugin-check http://127.0.0.1:8701`
"""

from __future__ import annotations

import numpy as np
from rtgaia_plugin_sdk import PluginApp, RunContext

MANIFEST = {
    "id": "hello-threshold",
    "version": "0.1.1",
    "api_version": "1",
    "label": "Hello threshold",
    "description": "Example: HU threshold to one structure (labelmap).",
    "icon": "👋",
    "licenses": ["MIT"],
    "soup": [{"name": "numpy", "version": "1.26", "license": "BSD-3-Clause", "kind": "library"}],
    "required_role": "contourer",
    "capabilities": ["read-image", "write-transient", "audit"],
    "inputs": {
        "image": {"required": True, "format": "nifti", "modalities": ["CT"]},
        "params_schema": {
            "type": "object",
            "properties": {
                "hu_min": {"type": "number", "default": 0, "title": "Minimum HU", "x-ui-widget": "number"},
                "name": {"type": "string", "default": "Hello", "title": "Structure name"},
            },
        },
    },
    "outputs": {"kinds": ["structures"], "encodings": ["labelmap"]},
    "execution": {"timeout_s": 300, "progress": "callback", "concurrency": 2},
}


def run(ctx: RunContext) -> None:
    volume, grid = ctx.fetch_image()
    ctx.progress(20, "threshold")
    hu_min = float(ctx.params.get("hu_min", 0))
    labelmap = (volume > hu_min).astype(np.uint8)
    ctx.progress(70, "publish")
    url = ctx.publish_nifti("seg.nii.gz", labelmap, grid)
    bundle = ctx.bundle().add_structure_labelmap(
        name=str(ctx.params.get("name", "Hello")),
        color_rgb=(255, 200, 0),
        frame_of_reference_uid=grid.frame_of_reference_uid,
        url=url,
        value=1,
    )
    outcome = ctx.submit(bundle)
    ctx.audit("hello.run", {"voxels": int(labelmap.sum()), "outcome": outcome})
    ctx.progress(100, "done")


app = PluginApp(manifest=MANIFEST, run=run).app
