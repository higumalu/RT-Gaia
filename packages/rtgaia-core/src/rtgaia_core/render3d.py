"""3D 靜態出圖 —— `FallbackSpec.to='server-render'` 的唯一端點。

`server-render` 退路先前指向一個不存在的東西；這裡把它做成真的可以走。

## ⚠️ 誠實記錄：這是 MIP，不是體積渲染

正式後端有 ≥ 12 GB VRAM，會用真的 ray-cast（transfer function、光照、多層混合）。
**測試後端沒有 GPU 假設，因此以 MIP 代替**：

* `volume-3d` 圖層 → 沿相機方向的最大強度投影，套該層的 window
* `mesh` 圖層 → 該結構 mask 的最大強度投影，以該層顏色著色後 alpha 疊上

因此它**在幾何上正確**（相機、姿態、遮擋順序都對），在**外觀上不是**產品畫面。
前端測試該斷言的是 `camera_used`、尺寸、`provenance` 與「有沒有東西」，
不是像素外觀。
"""

from __future__ import annotations

import struct
import zlib
from dataclasses import dataclass
from typing import Any

import numpy as np
from rtgaia_geom import Provenance, ViewReference
from rtgaia_geom.grid import Grid


@dataclass(frozen=True)
class Camera:
    """`ViewReference` 的超集。"""

    view: ViewReference
    distance_mm: float | None = None
    """相機到焦點的距離；None ＝ 請求沒給（MIP 是正交投影，只在有給時把它換成縮放，見 `dolly_zoom`）。"""
    fov_deg: float = 30.0

    def to_wire(self) -> dict[str, Any]:
        return {**self.view.to_wire(), "distance_mm": self.distance_mm or 500.0, "fov_deg": self.fov_deg}


FIT_DISTANCE_FACTOR = 1.2
"""前端 `camera3d.fitDistance`／`defaultCamera`：距離 ＝ 包圍盒對角線 × 1.2 時「剛好塞滿」。與這裡的 `zoom=1` 對齊。"""


def dolly_zoom(camera: Camera, grid: Grid) -> float:
    """相機前進／後退 → 正交縮放倍率（MIP 的滾輪要跟體積渲染一樣有前後）。

    MIP 沒有透視，距離本身不改變投影；把「距離 ÷ 剛好塞滿的距離」倒過來當倍率：靠近一半 → 放大兩倍。
    請求沒給 `distance_mm` → 1（舊行為）。"""
    if camera.distance_mm is None:
        return 1.0
    extent = float(np.linalg.norm(np.asarray(grid.size) * np.asarray(grid.spacing))) or 500.0
    return (FIT_DISTANCE_FACTOR * extent) / max(1.0, float(camera.distance_mm))


def encode_png(rgb: np.ndarray) -> bytes:
    """最小 PNG 編碼器（8-bit RGB）。

    刻意不引入 Pillow：SOUP 清單每多一個相依就要記錄版本、授權、用途與已知缺陷，
    而這裡只需要 30 行 zlib。
    """
    h, w, c = rgb.shape
    assert c == 3, "只支援 RGB"
    raw = b"".join(b"\x00" + rgb[y].tobytes() for y in range(h))

    def chunk(tag: bytes, data: bytes) -> bytes:
        return struct.pack(">I", len(data)) + tag + data + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)

    return (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 2, 0, 0, 0))
        + chunk(b"IDAT", zlib.compress(raw, 6))
        + chunk(b"IEND", b"")
    )


def _mip(volume: np.ndarray, grid: Grid, camera: Camera, size_px: tuple[int, int], zoom: float = 1.0) -> np.ndarray:
    """沿相機法線的最大強度投影，輸出 `(h, w)` float32。

    以 `rtgaia-reslice` 的 MIP 混合實作（同一份核心）；核心未建置時
    退回 numpy 的逐平面取樣。`zoom`（正交縮放）：1 ＝ 整個網格對角線剛好塞滿短邊，2 ＝ 放大兩倍。
    """
    w, h = size_px
    extent = float(np.linalg.norm(np.asarray(grid.size) * np.asarray(grid.spacing)))
    view = ViewReference(
        frame_of_reference_uid=camera.view.frame_of_reference_uid,
        display_grid_id=camera.view.display_grid_id,
        plane_origin=camera.view.plane_origin,
        view_plane_normal=camera.view.view_plane_normal,
        view_up=camera.view.view_up,
        slab_thickness_mm=extent,
        temporal_group_id=camera.view.temporal_group_id,
        frame_index=camera.view.frame_index,
    )
    px_mm = extent / (max(w, h) * max(0.05, float(zoom)))
    samples = int(min(512, max(64, extent / min(grid.spacing))))
    try:
        from rtgaia_geom.kernel import load_kernel

        kernel = load_kernel()
        return kernel.reslice(
            np.ascontiguousarray(volume),
            grid,
            view,
            out_size_px=(w, h),
            px_mm=px_mm,
            blend="mip",
            slab_samples=samples,
            outside=float(volume.min()),
        )
    except Exception:  # noqa: BLE001 - 核心未建置時的退路，不該讓端點失敗
        return _mip_numpy(volume, grid, view, (w, h), px_mm, samples)


def _mip_numpy(
    volume: np.ndarray,
    grid: Grid,
    view: ViewReference,
    size_px: tuple[int, int],
    px_mm: float,
    samples: int,
) -> np.ndarray:
    w, h = size_px
    right = np.asarray(view.right)
    rows = -np.asarray(view.up)
    normal = np.asarray(view.view_plane_normal)
    xs = (np.arange(w) - (w - 1) / 2) * px_mm
    ys = (np.arange(h) - (h - 1) / 2) * px_mm
    gx, gy = np.meshgrid(xs, ys)
    base = np.asarray(view.plane_origin) + gx[..., None] * right + gy[..., None] * rows
    offsets = np.linspace(-view.slab_thickness_mm / 2, view.slab_thickness_mm / 2, samples)
    out = np.full((h, w), float(volume.min()), dtype=np.float32)
    size = np.asarray(grid.size)
    for off in offsets:
        pts = (base + normal * off).reshape(-1, 3)
        idx = np.rint(grid.world_to_index(pts)).astype(np.int64)
        ok = np.all((idx >= 0) & (idx < size), axis=1)
        vals = np.full(len(idx), float(volume.min()), dtype=np.float32)
        sel = idx[ok]
        vals[ok] = volume[sel[:, 2], sel[:, 1], sel[:, 0]]
        out = np.maximum(out, vals.reshape(h, w))
    return out


class EmptyCrop(ValueError):
    """裁切方框與網格不相交。"""


def crop_index_box(grid: Grid, crop: dict[str, Any]) -> tuple[np.ndarray, np.ndarray]:
    """世界方框（LPS mm，min／max）→ 夾到網格內的索引包圍盒 `(lo, hi)`（含 hi）。

    網格可能有方向餘弦，因此取 8 個角的索引極值；不相交拋 `EmptyCrop`。
    """
    mn = np.asarray(crop["min"], dtype=np.float64)
    mx = np.asarray(crop["max"], dtype=np.float64)
    corners = np.array([[x, y, z] for x in (mn[0], mx[0]) for y in (mn[1], mx[1]) for z in (mn[2], mx[2])])
    idx = grid.world_to_index(corners)
    lo = np.floor(idx.min(axis=0)).astype(np.int64)
    hi = np.ceil(idx.max(axis=0)).astype(np.int64)
    size = np.asarray(grid.size)
    lo = np.clip(lo, 0, size - 1)
    hi = np.clip(hi, 0, size - 1)
    if np.any(hi < lo) or np.any(idx.max(axis=0) < 0) or np.any(idx.min(axis=0) > size - 1):
        raise EmptyCrop("裁切方框與網格不相交")
    return lo, hi


def crop_volume(
    volume: np.ndarray, grid: Grid, crop: dict[str, Any] | None
) -> tuple[np.ndarray, Grid, dict[str, Any] | None]:
    """依方框切出子體積 `(k, j, i)` 與子網格（原點跟著移）。沒有 crop 就原樣回。"""
    if not crop:
        return volume, grid, None
    lo, hi = crop_index_box(grid, crop)
    sub = volume[lo[2] : hi[2] + 1, lo[1] : hi[1] + 1, lo[0] : hi[0] + 1]
    origin = grid.index_to_world(lo.astype(np.float64))
    sub_grid = Grid(
        size=(int(hi[0] - lo[0] + 1), int(hi[1] - lo[1] + 1), int(hi[2] - lo[2] + 1)),
        spacing=grid.spacing,
        origin=(float(origin[0]), float(origin[1]), float(origin[2])),
        direction=grid.direction,
        frame_of_reference_uid=grid.frame_of_reference_uid,
    )
    used = {
        "index_lo": lo.tolist(),
        "index_hi": hi.tolist(),
        "world_min": grid.index_to_world(lo.astype(np.float64)).tolist(),
        "world_max": grid.index_to_world(hi.astype(np.float64)).tolist(),
    }
    return np.ascontiguousarray(sub), sub_grid, used


class _Lru:
    """小小的 LRU（dict 有序）。"""

    def __init__(self, capacity: int) -> None:
        self.capacity = capacity
        self.items: dict[Any, Any] = {}

    def get(self, key: Any) -> Any | None:
        v = self.items.get(key)
        if v is not None:
            self.items.pop(key)
            self.items[key] = v
        return v

    def put(self, key: Any, value: Any) -> None:
        self.items.pop(key, None)
        self.items[key] = value
        while len(self.items) > self.capacity:
            self.items.pop(next(iter(self.items)))

    def clear(self) -> None:
        self.items.clear()


# 投影快取：換視窗／開關結構／改顏色都不必重投影（2026-09-09：8 個結構一張 3.4 s 的主因）
_PROJ_CACHE = _Lru(96)
# 結構的降解析度 mask 快取（key = content_hash）：dense 512³ 每次重建要 0.1–0.3 s
_MASK_CACHE = _Lru(64)
_EXECUTOR: Any = None


def _executor() -> Any:
    global _EXECUTOR
    if _EXECUTOR is None:
        import os
        from concurrent.futures import ThreadPoolExecutor

        _EXECUTOR = ThreadPoolExecutor(max_workers=max(2, min(8, (os.cpu_count() or 4))))
    return _EXECUTOR


def clear_caches() -> None:
    _PROJ_CACHE.clear()
    _MASK_CACHE.clear()


def downsample2_mask(mask: np.ndarray, grid: Grid) -> tuple[np.ndarray, Grid]:
    """二值 mask 以 2×2×2 的「任一為真」降到一半解析度（MIP 用；輸出像素多半比體素粗）。"""
    k, j, i = mask.shape
    pk, pj, pi = (-k) % 2, (-j) % 2, (-i) % 2
    m = np.pad(mask, ((0, pk), (0, pj), (0, pi)))
    small = m.reshape(m.shape[0] // 2, 2, m.shape[1] // 2, 2, m.shape[2] // 2, 2).max(axis=(1, 3, 5))
    origin = grid.index_to_world([0.5, 0.5, 0.5])
    g = Grid(
        size=(small.shape[2], small.shape[1], small.shape[0]),
        spacing=tuple(float(sp) * 2 for sp in grid.spacing),
        origin=(float(origin[0]), float(origin[1]), float(origin[2])),
        direction=grid.direction,
        frame_of_reference_uid=grid.frame_of_reference_uid,
    )
    return np.ascontiguousarray(small), g


def _camera_key(camera: Camera) -> tuple[Any, ...]:
    v = camera.view
    return (
        tuple(round(float(x), 3) for x in v.plane_origin),
        tuple(round(float(x), 6) for x in v.view_plane_normal),
        tuple(round(float(x), 6) for x in v.view_up),
        None if camera.distance_mm is None else round(float(camera.distance_mm), 2),
    )


def _crop_key(crop: dict[str, Any] | None) -> tuple[Any, ...] | None:
    if not crop:
        return None
    return (tuple(round(float(x), 2) for x in crop["min"]), tuple(round(float(x), 2) for x in crop["max"]))


def render(
    *,
    layers: list[dict[str, Any]],
    volume_for: Any,
    mask_for: Any,
    grid: Grid,
    camera: Camera,
    size_px: tuple[int, int],
    module_version: str,
    crop: dict[str, Any] | None = None,
    zoom: float = 1.0,
    mask_key_for: Any = None,
) -> tuple[bytes, dict[str, Any]]:
    """把 `layers` 條目算成一張 PNG。

    🔴 **只接受後端可自行重建的圖層**。不認識的 renderer 一律拒絕，而不是
    靜默忽略——否則型別上看起來有退路，執行期才發現畫面少了一層。

    `crop`（2026-09-09，Slicer Volume Rendering 的 Crop）：先切子體積再投影，
    `px_mm` 由子網格算 —— 裁得小，東西就放大。

    速度（2026-09-09）：各圖層的投影**並行**（ctypes 呼叫釋放 GIL）並依
    `(圖層, 相機, 尺寸, 裁切, 倍率)` **快取** —— 換視窗、開關結構、改顏色只重合成不重投影；
    結構的 mask 先降到 ½ 解析度（`mask_key_for` 給 content_hash 當快取鍵）。
    """
    w, h = size_px
    for layer in layers:
        if layer.get("renderer") not in ("volume-3d", "mesh"):
            raise ValueError(
                f"後端不認識 renderer {layer.get('renderer')!r}。"
                "不可轉譯者不得宣告 server-render 退路，只能宣告 to:'hidden'"
            )
    cam_key = _camera_key(camera)
    ck = _crop_key(crop)
    crop_used: dict[str, Any] | None = None
    dolly = dolly_zoom(camera, grid)
    zoom = float(zoom) * dolly  # 之後全部用有效倍率（快取鍵、投影、回報）

    def proj_key(layer: dict[str, Any]) -> tuple[Any, ...]:
        if layer["renderer"] == "volume-3d":
            ident: Any = ("vol", layer["series_id"])
        else:
            sid = layer["structure_id"]
            ident = ("mask", sid, mask_key_for(sid, layer.get("frame_index")) if mask_key_for else None)
        return (ident, cam_key, (w, h), ck, round(float(zoom), 4))

    def compute(layer: dict[str, Any]) -> tuple[np.ndarray, dict[str, Any] | None]:
        if layer["renderer"] == "volume-3d":
            vol, g, cu = crop_volume(volume_for(layer["series_id"]), grid, crop)
            return _mip(vol, g, camera, (w, h), zoom), cu
        sid = layer["structure_id"]
        mkey = ("mask", sid, mask_key_for(sid, layer.get("frame_index")) if mask_key_for else None)
        small = _MASK_CACHE.get(mkey)
        if small is None:
            small = downsample2_mask(mask_for(sid, layer.get("frame_index")).astype(np.uint8), grid)
            _MASK_CACHE.put(mkey, small)
        m, g = small
        # 裁切方框以降解析度的網格算（子網格）
        mask, g2, cu = crop_volume(m.astype(np.float32), g, crop)
        return _mip(mask, g2, camera, (w, h), zoom), cu

    keys = [proj_key(layer) for layer in layers]
    projections: dict[tuple[Any, ...], np.ndarray] = {}
    todo: list[tuple[tuple[Any, ...], dict[str, Any]]] = []
    for key, layer in zip(keys, layers, strict=True):
        cached = _PROJ_CACHE.get(key)
        if cached is not None:
            projections[key] = cached
        elif key not in {k for k, _ in todo}:
            todo.append((key, layer))
    if todo:
        results = list(_executor().map(lambda kl: compute(kl[1]), todo))
        for (key, _layer), (proj, cu) in zip(todo, results, strict=True):
            projections[key] = proj
            _PROJ_CACHE.put(key, proj)
            if cu is not None:
                crop_used = cu
    if crop_used is None and crop:
        # 全部命中快取：仍要回報 crop_used —— 以主網格算索引盒
        try:
            lo, hi = crop_index_box(grid, crop)
            crop_used = {
                "index_lo": lo.tolist(),
                "index_hi": hi.tolist(),
                "world_min": grid.index_to_world(lo.astype(np.float64)).tolist(),
                "world_max": grid.index_to_world(hi.astype(np.float64)).tolist(),
            }
        except EmptyCrop:
            raise

    canvas = np.zeros((h, w, 3), dtype=np.float32)
    used: list[dict[str, Any]] = []
    for key, layer in zip(keys, layers, strict=True):
        proj = projections[key]
        opacity = float(layer.get("opacity", 1.0))
        if layer["renderer"] == "volume-3d":
            window = layer.get("window") or {"center": 40.0, "width": 400.0}
            lo_v = window["center"] - window["width"] / 2
            gray = np.clip((proj - lo_v) / max(window["width"], 1e-6), 0.0, 1.0)
            canvas = canvas * (1 - opacity) + gray[..., None] * 255.0 * opacity
        else:
            alpha = (np.clip(proj, 0.0, 1.0) * opacity)[..., None]
            color = np.asarray(layer.get("color", [1.0, 0.0, 0.0]), dtype=np.float32) * 255.0
            canvas = canvas * (1 - alpha) + color * alpha
        used.append({"renderer": layer["renderer"], "opacity": opacity})
    rgb = np.clip(canvas, 0, 255).astype(np.uint8)
    png = encode_png(rgb)
    from rtgaia_geom.hashing import digest_bytes

    header = {
        "mime": "image/png",
        "width": w,
        "height": h,
        "technique_used": "mip",
        "mapper_used": "rust-mip",
        "camera_used": camera.to_wire(),
        "crop_used": crop_used,
        "zoom_used": float(zoom),
        "dolly_zoom": float(dolly),
        "layers_used": used,
        "content_hash": digest_bytes(png, prefix="png_"),
        "provenance": Provenance(
            source="post-process",
            module_version=module_version,
            parent_hash=digest_bytes(png, prefix="png_"),
        ).to_wire(),
        "note": "測試後端以 MIP 代替體積渲染，幾何正確但外觀不是產品畫面（見 render3d 模組說明）",
    }
    return png, header
