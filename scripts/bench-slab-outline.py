#!/usr/bin/env python
"""量三種 slab 輪廓語意：成本與「差多少」。

    uv run python scripts/bench-slab-outline.py --data <CT 目錄>          # 成本
    uv run python scripts/bench-slab-outline.py --data <CT 目錄> --area   # 面積差

需要一個 CT 序列的 DICOM 目錄（`--data`，例：公開 demo 資料）與已建置的原生核心
（`./scripts/build-kernel.sh`）。

🔴 **量的是原生 cdylib，不是瀏覽器的 WASM。** 等效性測試已驗兩者逐像素等效，
但絕對時間不可與 「outline 重算」那份實測直接比（那次的 ROI 子集不同，
段數差 3.3 倍）。**有效輸出是比值。**
"""

from __future__ import annotations

import argparse
import statistics
import time
from pathlib import Path

import numpy as np
from rtgaia_core.loaders.dicom import load_dicom_dataset
from rtgaia_geom import ViewReference
from rtgaia_geom.grid import Grid
from rtgaia_geom.kernel import load_kernel
from rtgaia_testbe import phantoms

OUT_PX = (512, 512)
PX_MM = 1.0
REPS = 5
SLABS_MM = (3.0, 5.0, 10.0, 20.0)
TOP_N_STRUCTURES = 20


def slab_samples(slab_mm: float) -> int:
    """與 `kernel.plane_desc()` 的預設一致：每 1 mm 一個取樣，上限 64。"""
    if slab_mm <= 0:
        return 1
    return int(min(64, max(2, round(slab_mm) + 1)))


def load(directory: str):
    dataset = load_dicom_dataset(directory, load_structures=True)
    grid = dataset.primary.grid
    blocks = []
    for st in dataset.structures:
        block = phantoms.mask_block(dataset, st)
        if block is None:
            continue
        offset, size, data = block
        blocks.append((st.name, offset, size, np.ascontiguousarray(data, dtype=np.uint8)))
    # 體積最大的前 N 個（含 Body/Chestwall 這種橫跨全視野、也最貴的）
    blocks.sort(key=lambda x: -int(x[3].sum()))
    return dataset, grid, blocks[:TOP_N_STRUCTURES]


def block_grid(grid: Grid, offset, size) -> Grid:
    """bbox 區塊自己的網格 —— 核心直接吃區塊，不貼回全網格。"""
    return Grid(
        size=tuple(int(v) for v in size),
        spacing=grid.spacing,
        origin=tuple(float(v) for v in grid.index_to_world(list(offset))),
        direction=grid.direction,
        frame_of_reference_uid=grid.frame_of_reference_uid,
    )


OBLIQUE_DEG = 0.0
"""`--oblique N`：平面繞 x 軸（畫面的 right）傾斜 N°。量「斜面上的 slab 成本」用。"""


def make_view(grid: Grid, offset_mm: float, slab_mm: float) -> ViewReference:
    centre = np.asarray(
        grid.index_to_world([grid.size[0] / 2, grid.size[1] / 2, grid.size[2] / 2]),
        dtype=np.float64,
    )
    t = np.deg2rad(OBLIQUE_DEG)
    # 放射科慣例的軸向：從腳側往頭看（見 core/scene/cameras.ts 的 ORIENTATIONS）；
    # 繞 x 傾斜 t：normal (0,0,-1) → (0, sin t, -cos t)，view_up (0,-1,0) → (0, -cos t, -sin t)
    normal = np.array([0.0, np.sin(t), -np.cos(t)])
    up = np.array([0.0, -np.cos(t), -np.sin(t)])
    centre = centre + normal * (-offset_mm)
    return ViewReference(
        frame_of_reference_uid=grid.frame_of_reference_uid,
        display_grid_id="dg_bench",
        plane_origin=tuple(float(v) for v in centre),
        view_plane_normal=tuple(float(v) for v in normal),
        view_up=tuple(float(v) for v in up),
        slab_thickness_mm=slab_mm,
    )


def bench_cost(kernel, grid, blocks) -> None:
    bgs = [block_grid(grid, o, s) for _, o, s, _ in blocks]

    def semantics_a(_slab: float) -> int:
        """A · 中心面：單一平面，marching squares ×1。"""
        view = make_view(grid, 0.0, 0.0)
        return sum(
            len(
                kernel.marching_squares(
                    kernel.reslice(d, bg, view, out_size_px=OUT_PX, px_mm=PX_MM, blend="center", outside=0.0), 0.5
                )
            )
            for (_n, _o, _s, d), bg in zip(blocks, bgs, strict=True)
        )

    def semantics_b_mip(slab: float) -> int:
        """B · 聯集，用逐像素最大值求。

        🔴 ∪{fᵢ ≥ 0.5} == {max fᵢ ≥ 0.5} —— 因此聯集**不需要多邊形布林**，
        `Blend::Mip` 就是它。marching squares 仍然只跑一次。
        """
        view = make_view(grid, 0.0, slab)
        n = slab_samples(slab)
        return sum(
            len(
                kernel.marching_squares(
                    kernel.reslice(
                        d, bg, view, out_size_px=OUT_PX, px_mm=PX_MM, blend="mip", slab_samples=n, outside=0.0
                    ),
                    0.5,
                )
            )
            for (_n, _o, _s, d), bg in zip(blocks, bgs, strict=True)
        )

    def semantics_b_boolean(slab: float) -> int:
        """B′ · 聯集，走規格原本假設的多邊形布林路徑 —— **這是下界**。

        只含 N × (reslice ＋ MS ＋ stitch)。**布林本身沒有算進去**，因為 repo 裡
        沒有任何多邊形布林函式庫（要引入一個還得先過授權檢查）。
        """
        n = slab_samples(slab)
        half = slab / 2.0
        total = 0
        for i in range(n):
            t = -half + slab * i / max(1, n - 1)
            view = make_view(grid, t, 0.0)
            for (_name, _o, _s, d), bg in zip(blocks, bgs, strict=True):
                segs = kernel.marching_squares(
                    kernel.reslice(d, bg, view, out_size_px=OUT_PX, px_mm=PX_MM, blend="center", outside=0.0), 0.5
                )
                kernel.stitch(segs)
                total += len(segs)
        return total

    def semantics_c(slab: float) -> int:
        """C · 每個取樣面各一條，全部畫出來。"""
        n = slab_samples(slab)
        half = slab / 2.0
        total = 0
        for i in range(n):
            t = -half + slab * i / max(1, n - 1)
            view = make_view(grid, t, 0.0)
            for (_name, _o, _s, d), bg in zip(blocks, bgs, strict=True):
                total += len(
                    kernel.marching_squares(
                        kernel.reslice(d, bg, view, out_size_px=OUT_PX, px_mm=PX_MM, blend="center", outside=0.0), 0.5
                    )
                )
        return total

    def timed(fn, slab: float) -> tuple[float, int]:
        samples, segs = [], 0
        for _ in range(REPS):
            t0 = time.perf_counter()
            segs = fn(slab)
            samples.append((time.perf_counter() - t0) * 1000)
        return statistics.median(samples), segs

    base_ms, base_segs = timed(semantics_a, 0.0)
    print(f"\n基準（slab = 0）：{base_ms:.1f} ms、{base_segs} 段、{len(blocks)} 個結構\n")
    print("| slab | N | A 中心面 | B 聯集(MIP) | B′ 聯集(多邊形下界) | C 堆疊 |")
    print("|---|---|---|---|---|---|")
    for slab in SLABS_MM:
        n = slab_samples(slab)
        a_ms, a_segs = timed(semantics_a, slab)
        b_ms, b_segs = timed(semantics_b_mip, slab)
        bb_ms, _ = timed(semantics_b_boolean, slab)
        c_ms, c_segs = timed(semantics_c, slab)
        print(
            f"| {slab:.0f} mm | {n} | {a_ms:.1f} ms ({a_segs} 段) "
            f"| {b_ms:.1f} ms ({b_segs} 段, ×{b_ms / a_ms:.1f}) "
            f"| {bb_ms:.1f} ms (×{bb_ms / a_ms:.1f}) "
            f"| {c_ms:.1f} ms ({c_segs} 段, ×{c_ms / a_ms:.1f}) |"
        )


def bench_area(kernel, grid, blocks) -> None:
    """A 與 B 圈住的東西差多少 —— 臨床要判斷的是這個，不是毫秒數。"""
    print(f"\n切片厚 {grid.spacing[2]} mm；slab 橫跨的切片數 = slab / {grid.spacing[2]}\n")
    print("| slab | 範圍 | 中心面 | 聯集 | 增加 |")
    print("|---|---|---|---|---|")
    for slab in SLABS_MM:
        n = slab_samples(slab)
        rows, tot_a, tot_b = [], 0.0, 0.0
        for name, o, s, data in blocks:
            bg = block_grid(grid, o, s)
            fa = kernel.reslice(
                data, bg, make_view(grid, 0.0, 0.0), out_size_px=OUT_PX, px_mm=PX_MM, blend="center", outside=0.0
            )
            fb = kernel.reslice(
                data,
                bg,
                make_view(grid, 0.0, slab),
                out_size_px=OUT_PX,
                px_mm=PX_MM,
                blend="mip",
                slab_samples=n,
                outside=0.0,
            )
            # 判準與 marching squares 同為 field >= 0.5，因此兩者一致
            a = float((fa >= 0.5).sum()) * PX_MM * PX_MM / 100.0  # cm²
            b = float((fb >= 0.5).sum()) * PX_MM * PX_MM / 100.0
            if a < 0.5:
                continue  # 這一面上幾乎沒有這個結構
            tot_a += a
            tot_b += b
            rows.append((name, a, b, (b - a) / a * 100.0))
        if not rows:
            continue
        rows.sort(key=lambda r: -r[3])
        worst = rows[0]
        print(
            f"| {slab:.0f} mm | 合計 {len(rows)} 個 | {tot_a:.1f} cm² | {tot_b:.1f} cm² "
            f"| **+{(tot_b - tot_a) / tot_a * 100:.1f}%** |"
        )
        print(f"| | 差最多：{worst[0]} | {worst[1]:.1f} cm² | {worst[2]:.1f} cm² | **+{worst[3]:.1f}%** |")
    print("\n🔴 要看的是「差最多」那一列，不是合計 —— 合計被 Body／Chestwall 這種")
    print("   在 z 方向幾乎不變的大結構稀釋。真正會差的是沿 z 快速收斂的結構。")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--data", required=True, help="CT 序列的 DICOM 目錄")
    parser.add_argument("--area", action="store_true", help="量面積差而不是成本")
    parser.add_argument("--oblique", type=float, default=0.0, help="平面繞 x 傾斜 N°（斜面上的成本）")
    args = parser.parse_args()
    global OBLIQUE_DEG  # noqa: PLW0603 - 腳本層級的設定
    OBLIQUE_DEG = args.oblique

    if not Path(args.data).is_dir():
        raise SystemExit(f"找不到 {args.data} —— 真實 DICOM 不進版控")

    _phantom, grid, blocks = load(args.data)
    kernel = load_kernel()
    print(f"grid={grid.size} spacing={grid.spacing} oblique={OBLIQUE_DEG}°")
    print(f"結構 {len(blocks)} 個：{', '.join(n for n, *_ in blocks[:6])} …")
    if args.area:
        bench_area(kernel, grid, blocks)
    else:
        bench_cost(kernel, grid, blocks)


if __name__ == "__main__":
    main()
