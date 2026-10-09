"""VTK 體積渲染（`technique: composite`）。

* **GPU 優先、CPU 備援**：`vtkGPUVolumeRayCastMapper` 在 EGL 離屏視窗上可用就用它，
  否則 `vtkFixedPointVolumeRayCastMapper`；`mapper: cpu` 可強制。
* 每個 session 一個常駐的離屏 `vtkRenderWindow`（EGL；不需要 X）；volume／等值面 actor 依 content_hash 快取 ——
  VTK 內部的加速結構才吃得到「之後每張 0.01 s」。
* Scalar opacity／color mapping 直接對應 `vtkPiecewiseFunction`／`vtkColorTransferFunction`（Slicer 同一顆引擎）。
* 結構 → `vtkDiscreteFlyingEdges3D` 等值面（Slicer 的 3D 段落就是這樣畫）。
* 次要 FoR 的序列與結構：actor 套 `transform_to_primary`（即 userMatrix）—— 對位在 3D 裡也成立。
* 🔴 VTK／EGL 是執行緒親和的：所有 VTK 呼叫都在 **同一條** 工作執行緒（`run_in_vtk_thread`）。

沒裝 VTK（或 GL 裝置建不起來）→ `available()` False，端點退回 MIP 並在 header 標明。
* 🔴 那道退路**只有在 probe 走子行程時才成立**：沒有 GL 裝置的機器上 `Render()` 是 SIGSEGV 而不是例外，
  在行程內問會把後端（或 pytest）整個打死。見 `probe_subprocess`。`RTGAIA_DISABLE_VTK=1` 可直接關掉。
"""

from __future__ import annotations

import json
import os
import signal
import subprocess
import sys
import threading
import time
from concurrent.futures import Future, ThreadPoolExecutor
from dataclasses import dataclass, field
from typing import Any

import numpy as np
from rtgaia_geom import Provenance
from rtgaia_geom.grid import Grid

from . import mesh_cache

_EXECUTOR = ThreadPoolExecutor(max_workers=1, thread_name_prefix="vtk")
_LOCK = threading.Lock()
_STATE: dict[str, Any] = {"checked": False, "available": False, "gpu": False, "reason": None}

PROBE_MARKER = "<<<rtgaia-vtk-probe>>>"
PROBE_TIMEOUT_S = float(os.environ.get("RTGAIA_VTK_PROBE_TIMEOUT_S", "120"))

# 🔴 **這段程式碼跑在子行程裡，理由是它會 SIGSEGV。**
#
# 沒有 GL 裝置的機器上（容器、CI runner、沒有 /dev/dri 的伺服器），`rw.Render()`
# 不是丟例外而是直接把行程打死 —— `except Exception` 攔不到訊號。原本這段在
# 行程內跑，後果是：
#
# * `pytest` 在 collect `test_render3d_vtk.py` 時就以 exit 139 整個死掉（343 條
#   測試一條都沒跑到，GitHub CI 因此紅了九天）；
# * **更要緊的是**正式環境：第一個 `/render3d` 請求會把整個後端打掛，而不是
#   照設計退回 MIP。`available()` 回 False 就退 MIP 的那條退路，攔不住
#   native crash 就等於不存在。
#
# 子行程被訊號打死 → returncode 為負 → 這裡判成「沒有 VTK」，主行程活著。
PROBE_SOURCE = f"""\
import json, sys
out = {{"available": False, "gpu": False, "reason": None}}
try:
    from vtk import vtkRenderer, vtkRenderWindow

    rw = vtkRenderWindow()
    rw.SetOffScreenRendering(1)
    rw.SetSize(8, 8)
    ren = vtkRenderer()
    rw.AddRenderer(ren)
    rw.Render()  # ← 沒有 GL 裝置時，這一行是 SIGSEGV 而不是例外
    out["available"] = True
    out["window_class"] = rw.GetClassName()
    try:
        from vtk import vtkGPUVolumeRayCastMapper, vtkVolumeProperty

        out["gpu"] = bool(vtkGPUVolumeRayCastMapper().IsRenderSupported(rw, vtkVolumeProperty()))
    except Exception as exc:
        out["gpu"] = False
        out["gpu_reason"] = str(exc)[:200]
    rw.Finalize()
except Exception as exc:
    out["reason"] = "%s: %s" % (type(exc).__name__, str(exc)[:200])
# VTK 自己會往 stdout 印警告，因此結果用標記隔開
sys.stdout.write("{PROBE_MARKER}" + json.dumps(out))
"""


PICK_OPACITY_ISOVALUE = 0.1
"""反向 pick：volume 沿視線第一個「傳遞函數不透明度 ≥ 這個值」的體素算打到（太低會打在空氣的雜訊上）。"""


def run_in_vtk_thread(fn: Any, *args: Any, **kwargs: Any) -> Any:
    """所有 VTK 呼叫都走這裡（單一執行緒）。**同步等待** —— 只給同步呼叫端（probe、shutdown、測試）。"""
    fut: Future[Any] = _EXECUTOR.submit(fn, *args, **kwargs)
    return fut.result()


async def run_in_vtk_thread_async(fn: Any, *args: Any, **kwargs: Any) -> Any:
    """async route 用這個：同一條 VTK 執行緒，但呼叫端 `await`，事件迴圈不被 `Future.result()` 卡住
    （先前 render3d 在跑時 `/healthz` 也要等它畫完）。"""
    import asyncio

    fut: Future[Any] = _EXECUTOR.submit(fn, *args, **kwargs)
    return await asyncio.wrap_future(fut)


def _exit_reason(returncode: int) -> str:
    if returncode < 0:
        try:
            return f"probe 子行程被 {signal.Signals(-returncode).name} 打死"
        except ValueError:
            return f"probe 子行程被訊號 {-returncode} 打死"
    return f"probe 子行程 exit {returncode}"


def probe_subprocess(source: str = PROBE_SOURCE, timeout_s: float | None = None) -> dict[str, Any]:
    """在子行程裡問一次「這台機器畫得動嗎」，回一份 `_STATE` 的更新。

    任何形式的死法（訊號、非零離開、逾時、沒印出結果）都收斂成
    `{"available": False, "reason": ...}` —— 呼叫端只需要看 `available`。
    """
    try:
        proc = subprocess.run(  # noqa: S603
            [sys.executable, "-c", source],
            capture_output=True,
            timeout=PROBE_TIMEOUT_S if timeout_s is None else timeout_s,
        )
    except subprocess.TimeoutExpired:
        return {"available": False, "gpu": False, "reason": f"probe 子行程逾時（{timeout_s or PROBE_TIMEOUT_S}s）"}
    except OSError as exc:  # noqa: BLE001
        return {"available": False, "gpu": False, "reason": f"probe 子行程起不來：{type(exc).__name__}: {exc}"}

    out = proc.stdout.decode("utf-8", "replace")
    if proc.returncode == 0 and PROBE_MARKER in out:
        try:
            parsed = json.loads(out.rsplit(PROBE_MARKER, 1)[1])
        except ValueError as exc:  # noqa: BLE001
            return {"available": False, "gpu": False, "reason": f"probe 子行程的結果不是 JSON：{exc}"}
        if isinstance(parsed, dict):
            return {"gpu": False, **parsed}
        return {"available": False, "gpu": False, "reason": "probe 子行程的結果不是物件"}

    tail = ""
    lines = [ln for ln in proc.stderr.decode("utf-8", "replace").splitlines() if ln.strip()]
    if lines:
        tail = f"；stderr 末行：{lines[-1][:200]}"
    if proc.returncode == 0:
        return {"available": False, "gpu": False, "reason": f"probe 子行程沒印出結果{tail}"}
    return {"available": False, "gpu": False, "reason": _exit_reason(proc.returncode) + tail}


def _probe() -> None:
    if os.environ.get("RTGAIA_DISABLE_VTK", "").strip() not in ("", "0"):
        _STATE.update({"available": False, "gpu": False, "reason": "RTGAIA_DISABLE_VTK 已設"})
        return
    _STATE.update(probe_subprocess())


def available() -> bool:
    """🔴 probe 走子行程，所以這裡**不**進 VTK 執行緒。

    進去會死鎖：`_render` 本身就跑在那條唯一的工作執行緒上，而它會經
    `_pick_mapper` → `gpu_available()` → 這裡。
    """
    with _LOCK:
        if not _STATE["checked"]:
            _STATE["checked"] = True
            _probe()
        return bool(_STATE["available"])


def gpu_available() -> bool:
    return available() and bool(_STATE["gpu"])


def status() -> dict[str, Any]:
    available()
    return {k: v for k, v in _STATE.items() if k != "checked"}


# ── 每個 session 一個場景 ─────────────────────────────────────────────────────


@dataclass
class _Scene:
    rw: Any
    ren: Any
    volumes: dict[Any, Any] = field(default_factory=dict)
    """key → (vtkVolume, mapper, mapper_kind, tf_signature)。"""
    surfaces: dict[Any, Any] = field(default_factory=dict)
    """key → vtkActor。"""
    order: list[Any] = field(default_factory=list)


_SCENES: dict[str, _Scene] = {}
MAX_ACTORS_PER_SCENE = 48


def _scene(session_id: str) -> _Scene:
    sc = _SCENES.get(session_id)
    if sc is None:
        from vtk import vtkRenderer, vtkRenderWindow

        rw = vtkRenderWindow()
        rw.SetOffScreenRendering(1)
        rw.SetMultiSamples(0)
        ren = vtkRenderer()
        ren.SetBackground(0.0, 0.0, 0.0)
        rw.AddRenderer(ren)
        sc = _Scene(rw=rw, ren=ren)
        _SCENES[session_id] = sc
    return sc


def drop_scene(session_id: str) -> None:
    """session 走了 → 它的離屏視窗與 actor 一起走。

    🔴 這支原本**沒有任何呼叫端**，於是每個畫過 3D 的 session 都把一個
    `vtkRenderWindow` 留到行程結束。兩個後果：長跑的後端會一路長胖（`MAX_ACTORS_PER_SCENE`
    只管單一場景裡的 actor 數，管不到場景本身），以及在 X 上跑時，行程結束前那些
    視窗會在**主執行緒**被解構，而它們的 GLX context 屬於 VTK 工作執行緒 ——
    `X_GLXMakeCurrent` BadAccess，Xlib 的預設處理器讓行程 exit 1。
    測試全過而 CI 紅，就是這樣來的。
    """
    if session_id not in _SCENES:
        return  # 沒畫過 3D 的 session 佔大多數 —— 不必為它們喚醒 VTK 執行緒

    def _drop() -> None:
        sc = _SCENES.pop(session_id, None)
        if sc is not None:
            sc.rw.Finalize()

    run_in_vtk_thread(_drop)


def shutdown_scenes() -> None:
    """行程收工前把所有場景收掉（API 的 shutdown 事件呼叫）。

    🔴 **不能靠 `atexit`**：`ThreadPoolExecutor` 用 `threading._register_atexit`
    註冊自己的收尾，而那跑在 `atexit` 之前 —— 等 `atexit` 執行時 VTK 執行緒已經
    沒了，`submit()` 直接 `RuntimeError: cannot schedule new futures after shutdown`。
    所以收場景這件事必須發生在關機路徑上，不是解構子裡。
    """
    if not _SCENES:
        return

    def _drop_all() -> None:
        for sc in _SCENES.values():
            sc.rw.Finalize()
        _SCENES.clear()

    run_in_vtk_thread(_drop_all)


def _evict(sc: _Scene) -> None:
    while len(sc.order) > MAX_ACTORS_PER_SCENE:
        key = sc.order.pop(0)
        sc.volumes.pop(key, None)
        sc.surfaces.pop(key, None)


def _touch(sc: _Scene, key: Any) -> None:
    if key in sc.order:
        sc.order.remove(key)
    sc.order.append(key)
    _evict(sc)


# ── numpy ↔ VTK ────────────────────────────────────────────────────────────────


def _image_data(volume_kji: np.ndarray, grid: Grid, vtk_type: int) -> Any:
    from vtk import vtkImageData
    from vtk.util import numpy_support

    img = vtkImageData()
    img.SetDimensions(int(grid.size[0]), int(grid.size[1]), int(grid.size[2]))
    img.SetSpacing(float(grid.spacing[0]), float(grid.spacing[1]), float(grid.spacing[2]))
    img.SetOrigin(float(grid.origin[0]), float(grid.origin[1]), float(grid.origin[2]))
    d = grid.direction_matrix
    img.SetDirectionMatrix(*[float(v) for v in d.reshape(-1)])
    # VTK 的點序是 x 最快 —— 我們的 (k, j, i) C-order ravel 正好
    arr = numpy_support.numpy_to_vtk(np.ascontiguousarray(volume_kji).ravel(order="C"), deep=True, array_type=vtk_type)
    img.GetPointData().SetScalars(arr)
    return img


def _matrix4(m: np.ndarray | None) -> Any:
    from vtk import vtkMatrix4x4

    out = vtkMatrix4x4()
    if m is not None:
        for r in range(4):
            for c in range(4):
                out.SetElement(r, c, float(m[r, c]))
    return out


def _tf_signature(layer: dict[str, Any]) -> tuple[Any, ...]:
    return (
        tuple(tuple(round(float(v), 4) for v in p) for p in layer.get("scalar_opacity") or ()),
        tuple(tuple(round(float(v), 4) for v in p) for p in layer.get("scalar_color") or ()),
        tuple(tuple(round(float(v), 4) for v in p) for p in layer.get("gradient_opacity") or ()),
        bool(layer.get("shade", True)),
        round(float(layer.get("ambient", 0.2)), 3),
        round(float(layer.get("diffuse", 0.7)), 3),
        round(float(layer.get("specular", 0.2)), 3),
        round(float(layer.get("opacity", 1.0)), 3),
    )


DEFAULT_SCALAR_OPACITY = [[-1000.0, 0.0], [-300.0, 0.0], [200.0, 0.3], [1000.0, 0.8], [3000.0, 0.9]]
DEFAULT_SCALAR_COLOR = [
    [-1000.0, 0.0, 0.0, 0.0],
    [-200.0, 0.6, 0.3, 0.2],
    [300.0, 1.0, 0.9, 0.8],
    [1500.0, 1.0, 1.0, 1.0],
]


def _apply_property(prop: Any, layer: dict[str, Any]) -> None:
    from vtk import vtkColorTransferFunction, vtkPiecewiseFunction

    opacity_pts = layer.get("scalar_opacity") or DEFAULT_SCALAR_OPACITY
    color_pts = layer.get("scalar_color") or DEFAULT_SCALAR_COLOR
    layer_opacity = float(layer.get("opacity", 1.0))
    op = vtkPiecewiseFunction()
    for x, a in opacity_pts:
        op.AddPoint(float(x), max(0.0, min(1.0, float(a) * layer_opacity)))
    color = vtkColorTransferFunction()
    for x, r, g, b in color_pts:
        color.AddRGBPoint(float(x), float(r), float(g), float(b))
    prop.SetScalarOpacity(op)
    prop.SetColor(color)
    grad = layer.get("gradient_opacity")
    if grad:
        gp = vtkPiecewiseFunction()
        for x, a in grad:
            gp.AddPoint(float(x), float(a))
        prop.SetGradientOpacity(gp)
        prop.DisableGradientOpacityOff()
    else:
        prop.DisableGradientOpacityOn()
    prop.SetInterpolationTypeToLinear()
    if layer.get("shade", True):
        prop.ShadeOn()
    else:
        prop.ShadeOff()
    prop.SetAmbient(float(layer.get("ambient", 0.2)))
    prop.SetDiffuse(float(layer.get("diffuse", 0.7)))
    prop.SetSpecular(float(layer.get("specular", 0.2)))
    prop.SetSpecularPower(10.0)
    prop.SetScalarOpacityUnitDistance(1.0)


def _make_mapper(kind: str) -> Any:
    from vtk import vtkFixedPointVolumeRayCastMapper, vtkGPUVolumeRayCastMapper

    if kind == "gpu":
        m = vtkGPUVolumeRayCastMapper()
        m.SetAutoAdjustSampleDistances(1)
        m.SetUseJittering(0)
        return m
    m = vtkFixedPointVolumeRayCastMapper()
    m.SetAutoAdjustSampleDistances(1)
    return m


def _pick_mapper(requested: str) -> str:
    if requested == "cpu":
        return "cpu"
    if requested == "gpu":
        return "gpu" if gpu_available() else "cpu"
    return "gpu" if gpu_available() else "cpu"


def _crop_planes_own(crop: dict[str, Any] | None, to_primary: np.ndarray | None) -> tuple[float, ...] | None:
    """primary 世界的方框 → 該 actor 自己座標的 AABB（cropping planes 吃 data 座標）。"""
    if not crop:
        return None
    mn = np.asarray(crop["min"], dtype=np.float64)
    mx = np.asarray(crop["max"], dtype=np.float64)
    corners = np.array([[x, y, z] for x in (mn[0], mx[0]) for y in (mn[1], mx[1]) for z in (mn[2], mx[2])])
    if to_primary is not None:
        inv = np.linalg.inv(to_primary)
        corners = corners @ inv[:3, :3].T + inv[:3, 3]
    lo = corners.min(axis=0)
    hi = corners.max(axis=0)
    return (float(lo[0]), float(hi[0]), float(lo[1]), float(hi[1]), float(lo[2]), float(hi[2]))


# ── 主流程 ──────────────────────────────────────────────────────────────────────


# ── mesh（上限、降採樣、磁碟快取） ─────────────────────────

_MESH_SETTINGS: mesh_cache.MeshSettings | None = None


def mesh_settings() -> mesh_cache.MeshSettings:
    global _MESH_SETTINGS
    if _MESH_SETTINGS is None:
        _MESH_SETTINGS = mesh_cache.MeshSettings.from_env()
    return _MESH_SETTINGS


def reset_mesh_settings() -> None:
    """測試用：換了 env 之後重讀。"""
    global _MESH_SETTINGS
    _MESH_SETTINGS = None


def _surface_polydata(
    sid: str, frame: Any, *, mask_for: Any, grid_for_structure: Any, mask_key_for: Any
) -> tuple[Any, dict[str, Any]]:
    """磁碟快取 → 沒有就建（名單／大結構先 2× 降採樣，超過三角面上限就簡化）→ 寫回磁碟。VTK 執行緒上呼叫。"""
    settings = mesh_settings()
    grid = grid_for_structure(sid, frame)
    mask = np.asarray(mask_for(sid, frame)).astype(np.uint8, copy=False)
    # 名單以外靠**非零體素數**判斷（整個網格 512×512×187 是 49M，每個結構都會超過 —— 2026-09-23 踩過）
    downsample = mesh_cache.should_downsample(sid, int(np.count_nonzero(mask)), settings)
    key = mesh_cache.mesh_key(sid, str(mask_key_for(sid, frame)), grid, settings, downsample)
    cached = mesh_cache.load_polydata(settings, key)
    if cached is not None:
        return cached, {"source": "disk", "downsampled": downsample, "triangles": int(cached.GetNumberOfPolys())}
    mask, grid = mesh_cache.crop_to_bbox(mask, grid)
    if downsample:
        mask = mesh_cache.downsample2(mask)
        grid = mesh_cache.downsampled_grid(grid)
    from vtk import VTK_UNSIGNED_CHAR

    t0 = time.perf_counter()
    pd, info = mesh_cache.build_polydata(
        mask, grid, settings, image_data=lambda m, g: _image_data(m, g, VTK_UNSIGNED_CHAR)
    )
    t1 = time.perf_counter()
    mesh_cache.save_polydata(settings, key, pd)
    t2 = time.perf_counter()
    info = {**info, "build_ms": round((t1 - t0) * 1000), "save_ms": round((t2 - t1) * 1000)}
    if os.environ.get("RTGAIA_MESH_DEBUG"):
        print(f"[mesh] {sid}: voxels={mask.size} ds={downsample} {info}", file=sys.stderr, flush=True)
    return pd, {"source": "built", "downsampled": downsample, **info}


def _surface_actor(
    sid: str, frame: Any, *, mask_for: Any, grid_for_structure: Any, transform_for: Any, mask_key_for: Any
) -> tuple[Any, dict[str, Any]]:
    from vtk import vtkActor, vtkPolyDataMapper

    pd, info = _surface_polydata(
        sid, frame, mask_for=mask_for, grid_for_structure=grid_for_structure, mask_key_for=mask_key_for
    )
    pm = vtkPolyDataMapper()
    pm.SetInputData(pd)
    pm.ScalarVisibilityOff()
    actor = vtkActor()
    actor.SetMapper(pm)
    actor.SetUserMatrix(_matrix4(transform_for(sid, structure=True)))
    return actor, info


def _prepare_meshes(
    *,
    session_id: str,
    structure_ids: list[str],
    mask_for: Any,
    grid_for_structure: Any,
    transform_for: Any,
    mask_key_for: Any,
) -> dict[str, Any]:
    """把這些結構的 mesh 建好放進場景快取（沒有就建、磁碟有就讀）。給前端分批預熱＋顯示進度用。"""
    sc = _scene(session_id)
    built = disk = memory = 0
    for sid in structure_ids:
        key = ("mesh", sid, mask_key_for(sid, None))
        if key in sc.surfaces:
            memory += 1
            _touch(sc, key)
            continue
        actor, info = _surface_actor(
            sid,
            None,
            mask_for=mask_for,
            grid_for_structure=grid_for_structure,
            transform_for=transform_for,
            mask_key_for=mask_key_for,
        )
        sc.surfaces[key] = actor
        _touch(sc, key)
        if info.get("source") == "disk":
            disk += 1
        else:
            built += 1
    return {"built": built, "from_disk": disk, "in_memory": memory, "total": len(structure_ids)}


async def prepare_meshes_async(**kwargs: Any) -> dict[str, Any]:
    return await run_in_vtk_thread_async(_prepare_meshes, **kwargs)


def render(
    *,
    session_id: str,
    layers: list[dict[str, Any]],
    volume_for: Any,
    mask_for: Any,
    grid_for_series: Any,
    grid_for_structure: Any,
    transform_for: Any,
    mask_key_for: Any,
    camera: dict[str, Any],
    size_px: tuple[int, int],
    crop: dict[str, Any] | None,
    zoom: float,
    mapper: str,
    module_version: str,
    interactive: bool = False,
    pick_px: tuple[int, int] | None = None,
) -> tuple[bytes, dict[str, Any]]:
    """在 VTK 執行緒上跑 `_render`（同步等待；async route 請用 `render_async`）。"""
    return run_in_vtk_thread(
        _render,
        session_id=session_id,
        layers=layers,
        volume_for=volume_for,
        mask_for=mask_for,
        grid_for_series=grid_for_series,
        grid_for_structure=grid_for_structure,
        transform_for=transform_for,
        mask_key_for=mask_key_for,
        camera=camera,
        size_px=size_px,
        crop=crop,
        zoom=zoom,
        mapper=mapper,
        module_version=module_version,
        interactive=interactive,
        pick_px=pick_px,
    )


async def render_async(**kwargs: Any) -> tuple[bytes, dict[str, Any]]:
    """`render()` 的 awaitable 版本：同一條 VTK 執行緒，呼叫端不阻塞事件迴圈。"""
    return await run_in_vtk_thread_async(_render, **kwargs)


def _primitive_actors(layer: dict[str, Any]) -> list[Any]:
    """`{lines: [{points | segments, color, width, opacity}], polys: [{quads, color, opacity}]}` → vtkActor。"""
    from vtk import vtkActor, vtkCellArray, vtkPoints, vtkPolyData, vtkPolyDataMapper

    actors = []

    def actor_of(points: list[list[float]], cells: list[list[int]], *, polys: bool) -> Any:
        pts = vtkPoints()
        for p in points:
            pts.InsertNextPoint(float(p[0]), float(p[1]), float(p[2]))
        arr = vtkCellArray()
        for c in cells:
            arr.InsertNextCell(len(c))
            for i in c:
                arr.InsertCellPoint(i)
        pd = vtkPolyData()
        pd.SetPoints(pts)
        if polys:
            pd.SetPolys(arr)
        else:
            pd.SetLines(arr)
        m = vtkPolyDataMapper()
        m.SetInputData(pd)
        a = vtkActor()
        a.SetMapper(m)
        return a

    for line in layer.get("lines") or []:
        if line.get("points"):
            pts = line["points"]
            cells = [list(range(len(pts)))]
        else:
            segs = line.get("segments") or []
            pts = [p for seg in segs for p in seg]
            cells = [[2 * i, 2 * i + 1] for i in range(len(segs))]
        if not pts:
            continue
        a = actor_of(pts, cells, polys=False)
        prop = a.GetProperty()
        prop.SetColor(*[float(v) for v in line.get("color", (1.0, 1.0, 1.0))])
        prop.SetLineWidth(float(line.get("width", 1.0)))
        prop.SetOpacity(float(line.get("opacity", 1.0)))
        prop.LightingOff()
        actors.append(a)
    for poly in layer.get("polys") or []:
        quads = poly.get("quads") or []
        if not quads:
            continue
        pts = [p for q in quads for p in q]
        cells = [[4 * i, 4 * i + 1, 4 * i + 2, 4 * i + 3] for i in range(len(quads))]
        a = actor_of(pts, cells, polys=True)
        prop = a.GetProperty()
        prop.SetColor(*[float(v) for v in poly.get("color", (1.0, 1.0, 0.0))])
        prop.SetOpacity(float(poly.get("opacity", 0.5)))
        prop.LightingOff()
        actors.append(a)
    return actors


def _render(
    *,
    session_id: str,
    layers: list[dict[str, Any]],
    volume_for: Any,
    mask_for: Any,
    grid_for_series: Any,
    grid_for_structure: Any,
    transform_for: Any,
    mask_key_for: Any,
    camera: dict[str, Any],
    size_px: tuple[int, int],
    crop: dict[str, Any] | None,
    zoom: float,
    mapper: str,
    module_version: str,
    interactive: bool = False,
    pick_px: tuple[int, int] | None = None,
) -> tuple[bytes, dict[str, Any]]:
    """`pick_px`（畫面像素，原點左上）給了 ＝ 反向點選：場景照樣建、照樣算相機，但不出圖，
    只回 `header["pick"] = {hit, world}`（primary 世界座標；volume 取第一個不透明度超過門檻的體素、mesh 取表面）。"""
    from vtk import (
        VTK_FLOAT,
        VTK_SHORT,
        vtkVolume,
        vtkVolumeProperty,
        vtkWindowToImageFilter,
    )
    from vtk.util import numpy_support

    from .render3d import encode_png

    sc = _scene(session_id)
    ren = sc.ren
    rw = sc.rw
    w, h = size_px
    rw.SetSize(int(w), int(h))
    ren.RemoveAllViewProps()
    mapper_kind = _pick_mapper(mapper)
    used: list[dict[str, Any]] = []

    for layer in layers:
        renderer = layer.get("renderer")
        if renderer in ("volume-3d", "dose-3d"):
            if interactive and any(lay.get("renderer") == "mesh" for lay in layers):
                # 拖曳中只畫 mesh（volume ray-cast 是每幀最貴的一項）；放手後那張是完整的
                used.append({"renderer": renderer, "series_id": layer["series_id"], "skipped": "interactive"})
                continue
            sid = layer["series_id"]
            is_dose = renderer == "dose-3d"
            # 時間序列每個相位是不同的體積 —— 快取 key 要帶相位（以前永遠用相位 0 那份）
            key = ("dose" if is_dose else "vol", sid, mapper_kind, layer.get("frame_index"))
            entry = sc.volumes.get(key)
            if entry is None:
                grid = grid_for_series(sid)
                vol = np.asarray(volume_for(sid))
                if is_dose:
                    # 劑量是 float Gy（`read_dose_pixels` 已乘 DoseGridScaling）—— 轉 int16 會截成整數 Gy
                    img = _image_data(vol.astype(np.float32, copy=False), grid, VTK_FLOAT)
                else:
                    img = _image_data(vol.astype(np.int16, copy=False), grid, VTK_SHORT)
                m = _make_mapper(mapper_kind)
                m.SetInputData(img)
                prop = vtkVolumeProperty()
                v = vtkVolume()
                v.SetMapper(m)
                v.SetProperty(prop)
                v.SetUserMatrix(_matrix4(transform_for(sid)))
                entry = {"volume": v, "mapper": m, "prop": prop, "sig": None, "to_primary": transform_for(sid)}
                sc.volumes[key] = entry
            if is_dose and not layer.get("scalar_opacity"):
                raise ValueError("dose-3d 要帶 scalar_opacity／scalar_color（Gy；前端依劑量的閾值、上限與色階產生）")
            sig = _tf_signature(layer)
            if entry["sig"] != sig:
                _apply_property(entry["prop"], {"shade": False, **layer} if is_dose else layer)
                entry["sig"] = sig
            planes = _crop_planes_own(crop, entry["to_primary"])
            if planes is None:
                entry["mapper"].CroppingOff()
            else:
                entry["mapper"].CroppingOn()
                entry["mapper"].SetCroppingRegionPlanes(*planes)
                entry["mapper"].SetCroppingRegionFlagsToSubVolume()
            ren.AddVolume(entry["volume"])
            _touch(sc, key)
            used.append({"renderer": renderer, "series_id": sid, "mapper": mapper_kind})
        elif renderer == "mesh":
            sid = layer["structure_id"]
            frame = layer.get("frame_index")
            key = ("mesh", sid, mask_key_for(sid, frame))
            actor = sc.surfaces.get(key)
            if actor is None:
                actor, _info = _surface_actor(
                    sid,
                    frame,
                    mask_for=mask_for,
                    grid_for_structure=grid_for_structure,
                    transform_for=transform_for,
                    mask_key_for=mask_key_for,
                )
                sc.surfaces[key] = actor
            color = layer.get("color", [1.0, 0.0, 0.0])
            actor.GetProperty().SetColor(float(color[0]), float(color[1]), float(color[2]))
            actor.GetProperty().SetOpacity(float(layer.get("opacity", 0.5)))
            actor.GetProperty().SetSpecular(0.1)
            ren.AddActor(actor)
            _touch(sc, key)
            used.append({"renderer": renderer, "structure_id": sid})
        elif renderer == "primitives":
            # 計畫射束的線與面（primary 座標，路由已算好）—— 便宜，不快取
            for actor in _primitive_actors(layer):
                ren.AddActor(actor)
            used.append({"renderer": renderer, "key": layer.get("key")})
        else:
            raise ValueError(
                f"後端不認識 renderer {renderer!r}。不可轉譯者不得宣告 server-render 退路，只能宣告 to:'hidden'"
            )

    # 相機：ViewReference 超集 —— focal = plane_origin、position = focal + normal × distance、up、fov
    cam = ren.GetActiveCamera()
    focal = np.asarray(camera["plane_origin"], dtype=np.float64)
    normal = np.asarray(camera["view_plane_normal"], dtype=np.float64)
    normal = normal / (np.linalg.norm(normal) or 1.0)
    up = np.asarray(camera["view_up"], dtype=np.float64)
    distance = float(camera.get("distance_mm", 500.0)) / max(0.05, float(zoom))
    fov = float(camera.get("fov_deg", 30.0))
    pos = focal + normal * distance
    cam.ParallelProjectionOff()
    cam.SetFocalPoint(*focal)
    cam.SetPosition(*pos)
    cam.SetViewUp(*up)
    cam.SetViewAngle(fov)
    ren.ResetCameraClippingRange()
    rw.Render()

    if pick_px is not None:
        # 反向 pick：3D 上點一下 → 2D 十字線跳過去。VTK 的顯示座標原點在左下
        from vtk import vtkCellPicker

        picker = vtkCellPicker()
        picker.SetTolerance(0.0005)
        picker.SetVolumeOpacityIsovalue(PICK_OPACITY_ISOVALUE)
        px, py = int(pick_px[0]), int(pick_px[1])
        hit = bool(picker.Pick(px, int(h) - 1 - py, 0, ren)) and picker.GetProp3D() is not None
        world = [float(v) for v in picker.GetPickPosition()] if hit else None
        return b"", {"pick": {"hit": hit, "world": world, "x": px, "y": py}, "layers_used": used}

    w2i = vtkWindowToImageFilter()
    w2i.SetInput(rw)
    w2i.SetInputBufferTypeToRGB()
    w2i.ReadFrontBufferOff()
    w2i.Update()
    out = w2i.GetOutput()
    dims = out.GetDimensions()
    rgb = numpy_support.vtk_to_numpy(out.GetPointData().GetScalars()).reshape(dims[1], dims[0], 3)
    rgb = np.ascontiguousarray(rgb[::-1])  # VTK 的原點在左下
    png = encode_png(rgb.astype(np.uint8))
    from rtgaia_geom.hashing import digest_bytes

    header = {
        "mime": "image/png",
        "width": int(dims[0]),
        "height": int(dims[1]),
        "technique_used": "composite",
        "mapper_used": mapper_kind,
        "camera_used": {**camera, "distance_mm": distance, "position": [float(v) for v in pos]},
        "crop_used": crop,
        "zoom_used": float(zoom),
        "layers_used": used,
        "content_hash": digest_bytes(png, prefix="png_"),
        "provenance": Provenance(
            source="post-process", module_version=module_version, parent_hash=digest_bytes(png, prefix="png_")
        ).to_wire(),
        "note": f"VTK {mapper_kind} ray cast（{_STATE.get('window_class', '')}）",
    }
    return png, header
