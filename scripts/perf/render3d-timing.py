"""直打 `/render3d`：冷（只影像／+1／8／35 結構）→ 暖 → 拖曳尺寸。要量冷就先 `stack.sh stop && start && load`。"""

from __future__ import annotations

import time

import httpx

B = "http://127.0.0.1:8091"
st = httpx.get(B + "/api/v1/_test/state", timeout=30).json()
dg = st["gridSet"]["display_grid"]
g = dg["grid"]
o, sp, sz = g["origin"], g["spacing"], g["size"]
# 3 軸 direction 可能是矩陣；只算中心用 origin+spacing*size/2 近似即可
center = [o[i] + sp[i] * sz[i] / 2 for i in range(3)]
primary_for = next(f for f in st["gridSet"]["frame_groups"] if f["role"] == "primary")["frame_of_reference_uid"]
ct = next(layer for layer in st["layers"] if layer["kind"] == "image" and layer["frameOfReferenceUid"] == primary_for)
masks = [
    layer for layer in st["layers"] if layer["kind"] == "mask" and layer["groupId"].startswith("rs:1.2.246.352.205")
]


def cam() -> dict:
    return {
        "frame_of_reference_uid": primary_for,
        "display_grid_id": dg["display_grid_id"],
        "plane_origin": center,
        "view_plane_normal": [0, -1, 0],
        "view_up": [0, 0, 1],
        "slab_thickness_mm": 0,
        "temporal_group_id": None,
        "frame_index": None,
        "distance_mm": 1500,
        "fov_deg": 30,
    }


def run(n: int, size: int = 512, label: str = "") -> None:
    layers = [{"renderer": "volume-3d", "series_id": ct["contentRef"], "opacity": 1.0}] + [
        {"renderer": "mesh", "structure_id": m["contentRef"], "color": [1, 0, 0], "opacity": 0.5} for m in masks[:n]
    ]
    body = {
        "display_grid_id": dg["display_grid_id"],
        "camera": cam(),
        "output_size_px": [size, size],
        "frame_index": None,
        "layers": layers,
        "technique": "composite",
        "mapper": "auto",
    }
    t = time.perf_counter()
    r = httpx.post(B + f"/api/v1/studies/{st['studyId']}/render3d", json=body, timeout=900)
    dt = time.perf_counter() - t
    kb = len(r.content) // 1024
    print(f"{label:>14} n={n:2d} size={size} -> {r.status_code} {dt * 1000:8.0f} ms  {kb} KB", flush=True)


for n, lab in [(0, "cold image"), (1, "cold +1"), (8, "cold 8"), (35, "cold 35")]:
    run(n, label=lab)
run(35, label="warm 35")
run(35, size=224, label="warm 35 drag")
run(35, size=224, label="warm 35 drag")
