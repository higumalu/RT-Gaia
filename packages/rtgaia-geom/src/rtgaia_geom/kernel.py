"""CPU 重切核心的 Python 綁定。

**與前端載入的是同一份 Rust 程式碼**（`packages/rtgaia-reslice`）：後端經
`ctypes` 載入 cdylib，瀏覽器經 `WebAssembly.instantiate` 載入 wasm。兩個宿主
看到同一組 `extern "C"` 符號，因此 GPU／CPU 的等效性是「由建構保證」。

核心未建置時 `load_kernel()` 拋 `KernelUnavailable`；呼叫端可據此退回
SimpleITK 路徑（後端的高品質重切本來就走 SimpleITK 的 B-spline）。
"""

from __future__ import annotations

import ctypes
import os
from dataclasses import dataclass
from pathlib import Path
from typing import Literal

import numpy as np

from .grid import Grid
from .provenance import ViewReference

BlendMode = Literal["center", "mip", "mean", "composite"]
BLEND_CODE: dict[str, int] = {"center": 0, "mip": 1, "mean": 2, "composite": 3}

ERR = {-1: "ERR_NULL", -2: "ERR_LENGTH", -3: "ERR_CAPACITY", -4: "ERR_STITCH"}
ABI_VERSION = 1


class KernelUnavailable(RuntimeError):
    """重切核心未建置或載入失敗。"""


class _GridDesc(ctypes.Structure):
    _fields_ = [
        ("size", ctypes.c_uint32 * 3),
        ("spacing", ctypes.c_double * 3),
        ("origin", ctypes.c_double * 3),
        ("direction", ctypes.c_double * 9),
    ]


class _PlaneDesc(ctypes.Structure):
    _fields_ = [
        ("origin", ctypes.c_double * 3),
        ("right", ctypes.c_double * 3),
        ("up", ctypes.c_double * 3),
        ("normal", ctypes.c_double * 3),
        ("out_w", ctypes.c_uint32),
        ("out_h", ctypes.c_uint32),
        ("px_mm", ctypes.c_double),
        ("slab_mm", ctypes.c_double),
        ("slab_samples", ctypes.c_uint32),
        ("blend", ctypes.c_uint32),
        ("outside", ctypes.c_float),
        ("composite_window", ctypes.c_double * 2),
    ]


def _candidate_paths() -> list[Path]:
    env = os.environ.get("RTGAIA_RESLICE_LIB")
    here = Path(__file__).resolve()
    repo = here.parents[4] if len(here.parents) > 4 else here.parent
    names = ["librtgaia_reslice.so", "librtgaia_reslice.dylib", "rtgaia_reslice.dll"]
    out = [Path(env)] if env else []
    out += [here.parent / "_native" / n for n in names]
    out += [repo / "packages" / "rtgaia-reslice" / "target" / "release" / n for n in names]
    return out


@dataclass
class ResliceKernel:
    """`ResliceKernel` 的原生實作（前端 `CpuContext.resampler` 的對應物）。"""

    lib: ctypes.CDLL
    library_path: Path

    # ── 載入 ────────────────────────────────────────────────────────────────

    @classmethod
    def load(cls, path: str | Path | None = None) -> ResliceKernel:
        candidates = [Path(path)] if path else _candidate_paths()
        tried: list[str] = []
        for candidate in candidates:
            if not candidate.exists():
                tried.append(f"{candidate} (不存在)")
                continue
            try:
                lib = ctypes.CDLL(str(candidate))
            except OSError as exc:  # pragma: no cover - 平台相關
                tried.append(f"{candidate} ({exc})")
                continue
            k = cls(lib=lib, library_path=candidate)
            k._bind()
            k._assert_abi()
            return k
        raise KernelUnavailable(
            "找不到 CPU 重切核心。先跑 `scripts/build-kernel.sh`，或設定 "
            "RTGAIA_RESLICE_LIB。已嘗試：\n  " + "\n  ".join(tried)
        )

    def _bind(self) -> None:
        f32p = ctypes.POINTER(ctypes.c_float)
        u8p = ctypes.POINTER(ctypes.c_uint8)
        u32p = ctypes.POINTER(ctypes.c_uint32)
        i16p = ctypes.POINTER(ctypes.c_int16)
        gp = ctypes.POINTER(_GridDesc)
        pp = ctypes.POINTER(_PlaneDesc)
        sig = {
            "rt_version": ([], ctypes.c_uint32),
            "rt_struct_sizes": ([u32p], ctypes.c_int32),
            "rt_reslice_i16": ([i16p, ctypes.c_size_t, gp, pp, f32p, ctypes.c_size_t], ctypes.c_int32),
            "rt_reslice_u8": ([u8p, ctypes.c_size_t, gp, pp, f32p, ctypes.c_size_t], ctypes.c_int32),
            "rt_reslice_f32": ([f32p, ctypes.c_size_t, gp, pp, f32p, ctypes.c_size_t], ctypes.c_int32),
            "rt_sample_world_i16": (
                [i16p, ctypes.c_size_t, gp, ctypes.c_double, ctypes.c_double, ctypes.c_double, ctypes.c_float, f32p],
                ctypes.c_int32,
            ),
            "rt_window_to_u8": ([f32p, ctypes.c_size_t, ctypes.c_double, ctypes.c_double, u8p], ctypes.c_int32),
            "rt_gray_to_rgba": ([u8p, ctypes.c_size_t, u8p], ctypes.c_int32),
            "rt_composite_mask_rgba": (
                [
                    u8p,
                    f32p,
                    ctypes.c_size_t,
                    ctypes.c_uint8,
                    ctypes.c_uint8,
                    ctypes.c_uint8,
                    ctypes.c_float,
                    ctypes.c_float,
                ],
                ctypes.c_int32,
            ),
            "rt_marching_squares": (
                [f32p, ctypes.c_size_t, ctypes.c_size_t, ctypes.c_float, f32p, ctypes.c_size_t],
                ctypes.c_int32,
            ),
            "rt_stitch_polylines": (
                [f32p, ctypes.c_size_t, f32p, ctypes.c_size_t, u32p, ctypes.c_size_t, u32p],
                ctypes.c_int32,
            ),
            "rt_mask_outline_u8": (
                [u8p, ctypes.c_size_t, gp, pp, ctypes.c_float, f32p, ctypes.c_size_t, f32p, ctypes.c_size_t],
                ctypes.c_int32,
            ),
        }
        for name, (argtypes, restype) in sig.items():
            fn = getattr(self.lib, name)
            fn.argtypes = argtypes
            fn.restype = restype

    def _assert_abi(self) -> None:
        version = int(self.lib.rt_version())
        if version != ABI_VERSION:
            raise KernelUnavailable(f"核心 ABI 版本 {version}，預期 {ABI_VERSION}")
        sizes = (ctypes.c_uint32 * 2)()
        self.lib.rt_struct_sizes(sizes)
        expected = (ctypes.sizeof(_GridDesc), ctypes.sizeof(_PlaneDesc))
        if tuple(sizes) != expected:
            raise KernelUnavailable(
                f"結構佈局與 Rust 的 repr(C) 不符——會取到別的欄位而不報錯。 Rust={tuple(sizes)} ctypes={expected}"
            )

    # ── 呼叫 ────────────────────────────────────────────────────────────────

    def reslice(
        self,
        volume: np.ndarray,
        grid: Grid,
        view: ViewReference,
        *,
        out_size_px: tuple[int, int],
        px_mm: float,
        blend: BlendMode = "center",
        slab_samples: int | None = None,
        outside: float = -1024.0,
        composite_window: tuple[float, float] = (40.0, 400.0),
    ) -> np.ndarray:
        """在 `view` 描述的平面上重切，回傳 `(h, w)` 的 float32。"""
        w, h = int(out_size_px[0]), int(out_size_px[1])
        plane = plane_desc(
            view,
            out_size_px=(w, h),
            px_mm=px_mm,
            blend=blend,
            slab_samples=slab_samples,
            outside=outside,
            composite_window=composite_window,
        )
        gd = grid_desc(grid)
        out = np.empty(w * h, dtype=np.float32)
        vol = np.ascontiguousarray(volume)
        entry, ptr_type = {
            np.dtype(np.int16): ("rt_reslice_i16", ctypes.c_int16),
            np.dtype(np.uint8): ("rt_reslice_u8", ctypes.c_uint8),
            np.dtype(np.float32): ("rt_reslice_f32", ctypes.c_float),
        }[vol.dtype]
        rc = getattr(self.lib, entry)(
            vol.ctypes.data_as(ctypes.POINTER(ptr_type)),
            vol.size,
            ctypes.byref(gd),
            ctypes.byref(plane),
            out.ctypes.data_as(ctypes.POINTER(ctypes.c_float)),
            out.size,
        )
        _check(rc)
        return out.reshape(h, w)

    def sample_world(self, volume: np.ndarray, grid: Grid, world: object, outside: float = -1024.0) -> float:
        """單點取樣。與前端對同一個 LPS 座標必須一致。"""
        vol = np.ascontiguousarray(volume, dtype=np.int16)
        gd = grid_desc(grid)
        out = ctypes.c_float(0.0)
        wx, wy, wz = (float(v) for v in np.asarray(world, dtype=np.float64))
        rc = self.lib.rt_sample_world_i16(
            vol.ctypes.data_as(ctypes.POINTER(ctypes.c_int16)),
            vol.size,
            ctypes.byref(gd),
            wx,
            wy,
            wz,
            ctypes.c_float(outside),
            ctypes.byref(out),
        )
        _check(rc)
        return float(out.value)

    def window_to_u8(self, plane: np.ndarray, center: float, width: float) -> np.ndarray:
        src = np.ascontiguousarray(plane, dtype=np.float32).ravel()
        out = np.empty(src.size, dtype=np.uint8)
        _check(
            self.lib.rt_window_to_u8(
                src.ctypes.data_as(ctypes.POINTER(ctypes.c_float)),
                src.size,
                center,
                width,
                out.ctypes.data_as(ctypes.POINTER(ctypes.c_uint8)),
            )
        )
        return out.reshape(plane.shape)

    def marching_squares(self, field: np.ndarray, level: float = 0.5, *, max_segments: int = 1 << 18) -> np.ndarray:
        """回傳 `(n, 4)` 的 segment 陣列（平面像素座標）。"""
        f = np.ascontiguousarray(field, dtype=np.float32)
        h, w = f.shape
        out = np.empty(max_segments * 4, dtype=np.float32)
        rc = self.lib.rt_marching_squares(
            f.ctypes.data_as(ctypes.POINTER(ctypes.c_float)),
            w,
            h,
            ctypes.c_float(level),
            out.ctypes.data_as(ctypes.POINTER(ctypes.c_float)),
            out.size,
        )
        _check(rc)
        return out[: rc * 4].reshape(rc, 4).copy()

    def stitch(self, segments: np.ndarray) -> list[np.ndarray]:
        """把 segment soup 縫成 polyline 清單，每條為 `(n, 2)`。"""
        segs = np.ascontiguousarray(segments, dtype=np.float32).ravel()
        seg_count = segs.size // 4
        xy = np.empty(max(seg_count * 4, 8), dtype=np.float32)
        lens = np.empty(max(seg_count + 1, 8), dtype=np.uint32)
        counts = (ctypes.c_uint32 * 2)()
        rc = self.lib.rt_stitch_polylines(
            segs.ctypes.data_as(ctypes.POINTER(ctypes.c_float)),
            seg_count,
            xy.ctypes.data_as(ctypes.POINTER(ctypes.c_float)),
            xy.size,
            lens.ctypes.data_as(ctypes.POINTER(ctypes.c_uint32)),
            lens.size,
            counts,
        )
        _check(rc)
        polylines: list[np.ndarray] = []
        cursor = 0
        for i in range(int(counts[1])):
            n = int(lens[i])
            polylines.append(xy[cursor * 2 : (cursor + n) * 2].reshape(n, 2).copy())
            cursor += n
        return polylines


def grid_desc(grid: Grid) -> _GridDesc:
    return _GridDesc(
        size=(ctypes.c_uint32 * 3)(*(int(v) for v in grid.size)),
        spacing=(ctypes.c_double * 3)(*(float(v) for v in grid.spacing)),
        origin=(ctypes.c_double * 3)(*(float(v) for v in grid.origin)),
        direction=(ctypes.c_double * 9)(*(float(v) for v in grid.direction)),
    )


def plane_desc(
    view: ViewReference,
    *,
    out_size_px: tuple[int, int],
    px_mm: float,
    blend: BlendMode = "center",
    slab_samples: int | None = None,
    outside: float = -1024.0,
    composite_window: tuple[float, float] = (40.0, 400.0),
) -> _PlaneDesc:
    """由 `ViewReference` 組出核心的平面描述。

    🔴 **`up` 欄位是「輸出列增加的方向」，等於 `-view_up`。**
    `ViewReference.view_up` 是螢幕上的「上」，而影像第 0 列在畫面**頂端**——
    寫錯的症狀是畫面上下顛倒，而在對稱假體上完全看不出來。
    """
    w, h = int(out_size_px[0]), int(out_size_px[1])
    samples = slab_samples
    if samples is None:
        if blend == "center" or view.slab_thickness_mm <= 0.0:
            samples = 1
        else:
            # 每 1 mm 一個取樣，至少 2 個；上限 64 免得厚板把互動態的效能預算吃光
            samples = int(min(64, max(2, round(view.slab_thickness_mm) + 1)))
    return _PlaneDesc(
        origin=(ctypes.c_double * 3)(*(float(v) for v in view.plane_origin)),
        right=(ctypes.c_double * 3)(*(float(v) for v in view.right)),
        up=(ctypes.c_double * 3)(*(float(-v) for v in view.up)),
        normal=(ctypes.c_double * 3)(*(float(v) for v in view.view_plane_normal)),
        out_w=w,
        out_h=h,
        px_mm=float(px_mm),
        slab_mm=float(view.slab_thickness_mm),
        slab_samples=int(samples),
        blend=BLEND_CODE[blend],
        outside=float(outside),
        composite_window=(ctypes.c_double * 2)(*(float(v) for v in composite_window)),
    )


def _check(rc: int) -> None:
    if rc < 0:
        raise RuntimeError(f"重切核心回傳錯誤 {ERR.get(rc, rc)}")


_cached: ResliceKernel | None = None


def load_kernel(path: str | Path | None = None, *, cache: bool = True) -> ResliceKernel:
    global _cached
    if cache and _cached is not None and path is None:
        return _cached
    k = ResliceKernel.load(path)
    if cache and path is None:
        _cached = k
    return k
