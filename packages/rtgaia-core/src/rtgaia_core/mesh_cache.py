"""3D mesh 的上限與磁碟快取。

2026-09-23 實測：35 個結構冷啟動建 mesh 1.6 s、暖 98 ms —— 慢的是**第一次**，而且 mesh 只活在行程記憶體裡
（`render3d_vtk._Scene.surfaces`，重啟就沒了）。這裡：

* **key**：(structure_id, mask content_hash, 網格, 建 mesh 參數) 的 sha256 —— 編輯過的 mask hash 不同，自然是新 key。
* **磁碟層**：`RTGAIA_DATA_DIR/cache/mesh/<key>.vtp`（vtkXMLPolyData），LRU（mtime）壓在 `RTGAIA_MESH_CACHE_BYTES`
  以下（預設 2 GiB）。跨行程、跨 session 重用。
* **裁到 bbox**：mask 先裁到非零範圍（＋1 格邊），FlyingEdges 不再掃整個 512×512×187（2026-09-23 實測：
  35 個結構原本要 21 s；大多數 ROI 只占網格的幾 %）。
* **上限**：三角面超過 `RTGAIA_MESH_MAX_TRIANGLES`（預設 200k）用 vtkDecimatePro 壓到上限（QuadricDecimation 在
  CouchInterior 84k→50k 花了 10 s，DecimatePro 快一個量級；50k 的上限也太緊 —— 伺服器 GPU 畫 35 個全解析 mesh 只要
  56 ms）；名單（`RTGAIA_MESH_DOWNSAMPLE_NAMES`，預設 `BODY,Couch,External`）或**非零體素** > 16M 的結構先 2× 降採樣。
  上限與名單都是設定，不硬寫。

VTK 相關的函式只在有 VTK 時被呼叫；純 python 的部分（key、降採樣、修剪）不吃 VTK，測試直接跑。
"""

from __future__ import annotations

import hashlib
import os
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import numpy as np

DEFAULT_MAX_TRIANGLES = 200_000
DEFAULT_DOWNSAMPLE_NAMES = ("BODY", "Couch", "External")
DEFAULT_CACHE_BYTES = 2 * 1024**3
DOWNSAMPLE_VOXELS = 16_000_000


@dataclass(frozen=True)
class MeshSettings:
    max_triangles: int = DEFAULT_MAX_TRIANGLES
    downsample_names: tuple[str, ...] = DEFAULT_DOWNSAMPLE_NAMES
    cache_bytes: int = DEFAULT_CACHE_BYTES
    cache_dir: Path | None = None

    @classmethod
    def from_env(cls) -> MeshSettings:
        def _int(name: str, default: int) -> int:
            raw = os.environ.get(name, "").strip()
            try:
                return int(raw) if raw else default
            except ValueError:
                return default

        names_raw = os.environ.get("RTGAIA_MESH_DOWNSAMPLE_NAMES")
        names = (
            tuple(n.strip() for n in names_raw.split(",") if n.strip())
            if names_raw is not None
            else DEFAULT_DOWNSAMPLE_NAMES
        )
        cache_dir: Path | None = None
        if os.environ.get("RTGAIA_MESH_CACHE", "1").strip() not in ("0", "false", "no"):
            try:
                from .blobs import blob_root

                cache_dir = blob_root().parent / "cache" / "mesh"
            except Exception:  # noqa: BLE001  沒設資料目錄就只用記憶體
                cache_dir = None
        return cls(
            max_triangles=max(1000, _int("RTGAIA_MESH_MAX_TRIANGLES", DEFAULT_MAX_TRIANGLES)),
            downsample_names=names,
            cache_bytes=max(0, _int("RTGAIA_MESH_CACHE_BYTES", DEFAULT_CACHE_BYTES)),
            cache_dir=cache_dir,
        )

    def params_signature(self) -> str:
        return f"tri={self.max_triangles}"


def should_downsample(structure_id: str, voxel_count: int, settings: MeshSettings) -> bool:
    """名單以**前綴、不分大小寫**比對（`CouchSurface`、`CouchInterior`、`BODY`、`External`）。"""
    sid = structure_id.lower()
    if any(sid.startswith(n.lower()) for n in settings.downsample_names):
        return True
    return voxel_count > DOWNSAMPLE_VOXELS


def crop_to_bbox(mask: np.ndarray, grid: Any, margin: int = 1) -> tuple[np.ndarray, Any]:
    """裁到非零體素的外接方塊（每側留 `margin` 格，讓等值面閉合）。全零 → 原樣回傳。
    網格：size 換成裁切後的、原點沿三個索引軸平移 `lo` 格（direction 是 row-major 3×3：world = o + D @ (s ⊙ ijk)）。"""
    from dataclasses import replace

    m = np.asarray(mask)
    nz = np.nonzero(m)
    if nz[0].size == 0:
        return m, grid
    lo = [max(0, int(a.min()) - margin) for a in nz]
    hi = [min(int(n), int(a.max()) + 1 + margin) for a, n in zip(nz, m.shape, strict=True)]
    cropped = np.ascontiguousarray(m[lo[0] : hi[0], lo[1] : hi[1], lo[2] : hi[2]])
    # mask 是 kji（z, y, x）；grid.size 是 (nx, ny, nz)，索引軸 r=0 對 x
    lo_ijk = (lo[2], lo[1], lo[0])
    size = (hi[2] - lo[2], hi[1] - lo[1], hi[0] - lo[0])
    origin = tuple(
        float(grid.origin[a])
        + sum(float(grid.direction[a * 3 + r]) * float(grid.spacing[r]) * lo_ijk[r] for r in range(3))
        for a in range(3)
    )
    return cropped, replace(grid, size=size, origin=origin)


def downsample2(mask: np.ndarray) -> np.ndarray:
    """2× 降採樣（每軸），**取聯集**（任何一個子體素是 1 就是 1）—— 表面只會往外長半個體素，不會破洞。
    奇數維度補零到偶數。"""
    m = np.asarray(mask, dtype=np.uint8)
    pad = [(0, s % 2) for s in m.shape]
    if any(p[1] for p in pad):
        m = np.pad(m, pad)
    k, j, i = (s // 2 for s in m.shape)
    view = m.reshape(k, 2, j, 2, i, 2)
    return view.max(axis=(1, 3, 5)).astype(np.uint8)


def downsampled_grid(grid: Any) -> Any:
    """同原點、spacing×2、size 減半（向上取整）。`Grid` 是 frozen dataclass，用 `replace`。"""
    from dataclasses import replace

    size = tuple(int((s + 1) // 2) for s in grid.size)
    spacing = tuple(float(v) * 2.0 for v in grid.spacing)
    # 聯集取樣的中心在原本 2×2×2 塊的中心：原點往正方向挪半個原體素
    origin = tuple(
        float(grid.origin[a]) + sum(float(grid.direction[a * 3 + r]) * float(grid.spacing[r]) * 0.5 for r in range(3))
        for a in range(3)
    )
    return replace(grid, size=size, spacing=spacing, origin=origin)


def mesh_key(structure_id: str, content_hash: str, grid: Any, settings: MeshSettings, downsampled: bool) -> str:
    h = hashlib.sha256()
    parts = [
        structure_id,
        content_hash,
        ",".join(str(v) for v in grid.size),
        ",".join(f"{float(v):.6f}" for v in grid.spacing),
        ",".join(f"{float(v):.4f}" for v in grid.origin),
        ",".join(f"{float(v):.6f}" for v in grid.direction),
        settings.params_signature(),
        "ds2" if downsampled else "full",
    ]
    h.update("|".join(parts).encode("utf-8"))
    return h.hexdigest()


# ── 磁碟層 ──────────────────────────────────────────────────────────────────


def cache_path(settings: MeshSettings, key: str) -> Path | None:
    if settings.cache_dir is None or settings.cache_bytes <= 0:
        return None
    return settings.cache_dir / f"{key}.vtp"


def prune(cache_dir: Path, max_bytes: int) -> list[Path]:
    """LRU（mtime 最舊先刪）到總量 ≤ max_bytes。回傳刪掉的檔。"""
    if not cache_dir.exists():
        return []
    files = sorted(
        (p for p in cache_dir.iterdir() if p.suffix == ".vtp" and p.is_file()),
        key=lambda p: p.stat().st_mtime,
    )
    total = sum(p.stat().st_size for p in files)
    removed: list[Path] = []
    for p in files:
        if total <= max_bytes:
            break
        size = p.stat().st_size
        try:
            p.unlink()
        except OSError:
            continue
        total -= size
        removed.append(p)
    return removed


def load_polydata(settings: MeshSettings, key: str) -> Any | None:
    path = cache_path(settings, key)
    if path is None or not path.exists():
        return None
    from vtk import vtkXMLPolyDataReader

    reader = vtkXMLPolyDataReader()
    reader.SetFileName(str(path))
    reader.Update()
    pd = reader.GetOutput()
    if pd is None or pd.GetNumberOfPoints() == 0:
        return None
    try:
        path.touch()  # LRU：命中就更新 mtime
    except OSError:
        pass
    return pd


def save_polydata(settings: MeshSettings, key: str, polydata: Any) -> Path | None:
    path = cache_path(settings, key)
    if path is None:
        return None
    from vtk import vtkXMLPolyDataWriter

    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp = path.with_suffix(".vtp.tmp")
        writer = vtkXMLPolyDataWriter()
        writer.SetFileName(str(tmp))
        writer.SetInputData(polydata)
        writer.SetDataModeToBinary()
        # zlib 每個結構 60–96 ms（35 個 ≈ 1.5 s）；LZ4 快一個量級，檔案大一些（2 GiB 的預算夠）
        if hasattr(writer, "SetCompressorTypeToLZ4"):
            writer.SetCompressorTypeToLZ4()
        else:
            writer.SetCompressorTypeToZLib()
        writer.Write()
        tmp.replace(path)
        prune(path.parent, settings.cache_bytes)
    except OSError:
        return None
    return path


# ── 建 mesh（VTK） ──────────────────────────────────────────────────────────


def build_polydata(
    mask: np.ndarray, grid: Any, settings: MeshSettings, *, image_data: Any
) -> tuple[Any, dict[str, Any]]:
    """mask → 等值面 → （超過上限就）簡化。`image_data(mask, grid)` 由呼叫端提供（render3d_vtk._image_data）。
    回傳 (polydata, info)；info 記三角面數與有沒有簡化，進出圖 header。"""
    from vtk import vtkDecimatePro, vtkDiscreteFlyingEdges3D, vtkTriangleFilter

    fe = vtkDiscreteFlyingEdges3D()
    fe.SetInputData(image_data(mask, grid))
    fe.SetValue(0, 1)
    fe.ComputeNormalsOn()
    fe.Update()
    pd = fe.GetOutput()
    before = int(pd.GetNumberOfPolys())
    info: dict[str, Any] = {"triangles_before": before, "triangles": before, "decimated": False}
    if before > settings.max_triangles and before > 0:
        tri = vtkTriangleFilter()
        tri.SetInputData(pd)
        tri.Update()
        dec = vtkDecimatePro()
        dec.SetInputData(tri.GetOutput())
        dec.SetTargetReduction(1.0 - settings.max_triangles / before)
        dec.PreserveTopologyOff()
        dec.SplittingOn()
        dec.BoundaryVertexDeletionOn()
        dec.Update()
        out = dec.GetOutput()
        if out is not None and out.GetNumberOfPolys() > 0:
            pd = out
            info["triangles"] = int(pd.GetNumberOfPolys())
            info["decimated"] = True
    return pd, info
