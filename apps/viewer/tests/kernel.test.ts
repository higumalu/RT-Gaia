/**
 * 🔴 **核心的等效性驗證** —— 瀏覽器的 WASM 核心與後端的原生核心必須一致。
 *
 * > 允收：差異 ≤ 1 LSB，且**不得有幾何位移**。
 *
 * > 「≤ 1 LSB」需要指明是哪個位元。
 * > 這裡明確定為**輸出 8-bit 畫面**的 1 LSB（即 1/255）；float32 中間結果則以
 * > 相對誤差 1e-5 為界（同一份 Rust 程式碼，差異只可能來自 f32 累加順序）。
 *
 * 測試向量由 `scripts/emit-geometry-fixture.py` 用**原生 cdylib** 算出，這裡用
 * **wasm** 重算並比對 —— 兩者是同一份 Rust 原始碼的兩個建構目標。
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath, URL } from 'node:url';

import { beforeAll, describe, expect, it } from 'vitest';

import { createGrid, type Grid } from '../src/core/geometry';
import { fromWire } from '../src/core/transport/wire';
import {
  KERNEL_ABI_VERSION,
  WasmResliceKernel,
} from '../src/core/raster/resliceKernel';

const fixture = JSON.parse(
  readFileSync(fileURLToPath(new URL('./fixtures/geometry-vectors.json', import.meta.url)), 'utf8'),
) as {
  kernel: {
    available: boolean;
    reason?: string;
    grid: Record<string, unknown>;
    volume_kji: number[];
    samples: { world_lps: number[]; value: number }[];
    reslice: {
      view_reference: Record<string, unknown>;
      out_size_px: [number, number];
      px_mm: number;
      plane_row_major: number[];
    };
    mask_outline: {
      sphere_radius_mm: number;
      out_size_px: [number, number];
      px_mm: number;
      mask_kji: number[];
      segment_count: number;
      polyline_count: number;
      polyline_point_counts: number[];
    };
  };
};

const WASM_PATH = fileURLToPath(new URL('../public/rtgaia_reslice.wasm', import.meta.url));

/** float32 中間結果的相對容差（同一份 Rust 程式碼，差異只來自累加順序）。 */
const F32_REL_TOL = 1e-5;
/** 輸出 8-bit 畫面的允收：**1 LSB = 1/255**。 */
const LSB_8BIT = 1;

let kernel: WasmResliceKernel;
let grid: Grid;
let volume: Int16Array;

describe.skipIf(!fixture.kernel.available)('WASM 重切核心', () => {
  beforeAll(async () => {
    const bytes = readFileSync(WASM_PATH);
    kernel = await WasmResliceKernel.instantiate(
      new Uint8Array(bytes).buffer,
    );
    grid = createGrid(fromWire.grid(fixture.kernel.grid));
    volume = Int16Array.from(fixture.kernel.volume_kji);
  });

  it('ABI 版本與結構佈局在載入時就被斷言', () => {
    // instantiate() 內部已呼叫 assertAbi()；能走到這裡就代表兩者都通過
    expect(kernel.abiVersion).toBe(KERNEL_ABI_VERSION);
  });

  it('單點取樣與後端原生核心逐點一致', () => {
    for (const sample of fixture.kernel.samples) {
      const got = kernel.sampleWorldI16({
        volume,
        volumeKey: 'fixture',
        grid,
        world: sample.world_lps as [number, number, number],
        outside: -1024,
      });
      const tol = Math.max(Math.abs(sample.value) * F32_REL_TOL, 1e-3);
      expect(Math.abs(got - sample.value), `world=${JSON.stringify(sample.world_lps)}`).toBeLessThan(
        tol,
      );
    }
  });

  it('斜面重切的每一個像素都與後端一致（不得有幾何位移）', () => {
    const view = fromWire.viewReference(fixture.kernel.reslice.view_reference);
    const [w, h] = fixture.kernel.reslice.out_size_px;
    const plane = kernel.reslicePlane({
      volume,
      volumeKey: 'fixture',
      grid,
      view,
      outSizePx: [w, h],
      pxMm: fixture.kernel.reslice.px_mm,
      blend: 'center',
      outside: -1024,
    });
    expect(plane.length).toBe(w * h);
    const expected = fixture.kernel.reslice.plane_row_major;
    let worst = 0;
    for (let i = 0; i < expected.length; i += 1) {
      worst = Math.max(worst, Math.abs(plane[i]! - expected[i]!));
    }
    // 幾何位移會表現成整片偏差，不是個別像素；因此這一條同時驗證了
    // 「up = -viewUp」與平面基底在兩個宿主上完全同義
    expect(worst).toBeLessThan(1e-3);
  });

  it('window LUT 的輸出與定義一致（8-bit，1 LSB 允收）', () => {
    const plane = Float32Array.from([-1000, 40, 1000]);
    const out = kernel.windowToU8(plane, 40, 400);
    expect(Math.abs(out[0]! - 0)).toBeLessThanOrEqual(LSB_8BIT);
    expect(Math.abs(out[1]! - 128)).toBeLessThanOrEqual(LSB_8BIT);
    expect(Math.abs(out[2]! - 255)).toBeLessThanOrEqual(LSB_8BIT);
  });

  it('marching squares 的 segment 數與後端一致', () => {
    const maskVolume = Uint8Array.from(fixture.kernel.mask_outline.mask_kji);
    const view = fromWire.viewReference(fixture.kernel.reslice.view_reference);
    const [w, h] = fixture.kernel.mask_outline.out_size_px;
    const field = kernel.reslicePlane({
      volume: maskVolume,
      volumeKey: 'mask-fixture',
      grid,
      view,
      outSizePx: [w, h],
      pxMm: fixture.kernel.mask_outline.px_mm,
      blend: 'center',
      outside: 0,
    });
    const segments = kernel.marchingSquares(field, w, h, 0.5);
    expect(segments.length / 4).toBe(fixture.kernel.mask_outline.segment_count);
  });

  /**
   * 🔴 **融合入口必須與分兩步走**逐段相同**。**
   *
   * `maskOutline()` 是為了省掉那份「沒有人看」的中間 f32 平面（512² 上每結構
   * 每幀約 4 MB 的 wasm 配置週轉）。它跑的是同一份 Rust 程式碼，因此**任何差異
   * 都是包裝層寫錯了** —— 例如 scratch 沒有清乾淨、或 PlaneDesc 的欄位填錯。
   *
   * 這條測試存在的理由是：那類錯誤的症狀是「輪廓偶爾多一段、少一段」，
   * 在畫面上看起來只是「描邊有點毛」。
   */
  it('🔴 融合的 maskOutline() 與 reslicePlane() ＋ marchingSquares() 逐段相同', () => {
    const maskVolume = Uint8Array.from(fixture.kernel.mask_outline.mask_kji);
    const view = fromWire.viewReference(fixture.kernel.reslice.view_reference);
    const [w, h] = fixture.kernel.mask_outline.out_size_px;
    const pxMm = fixture.kernel.mask_outline.px_mm;

    const field = kernel.reslicePlane({
      volume: maskVolume,
      volumeKey: 'mask-two-step',
      grid,
      view,
      outSizePx: [w, h],
      pxMm,
      blend: 'center',
      outside: 0,
    });
    const twoStep = kernel.marchingSquares(field, w, h, 0.5);
    const fused = kernel.maskOutline({
      mask: maskVolume,
      volumeKey: 'mask-fused',
      grid,
      view,
      outSizePx: [w, h],
      pxMm,
    });

    expect(fused.length).toBe(twoStep.length);
    for (let i = 0; i < twoStep.length; i += 1) {
      expect(fused[i], `segment float ${i}`).toBe(twoStep[i]);
    }
    expect(fused.length / 4).toBe(fixture.kernel.mask_outline.segment_count);
  });

  it('重用的 scratch 平面不會讓連續兩次呼叫互相汙染', () => {
    const maskVolume = Uint8Array.from(fixture.kernel.mask_outline.mask_kji);
    const view = fromWire.viewReference(fixture.kernel.reslice.view_reference);
    const [w, h] = fixture.kernel.mask_outline.out_size_px;
    const pxMm = fixture.kernel.mask_outline.px_mm;
    const args = { mask: maskVolume, volumeKey: 'mask-reuse', grid, view, outSizePx: [w, h] as [number, number], pxMm };
    const first = kernel.maskOutline(args);
    // 中間插一個尺寸不同的呼叫，逼 scratch 重新配置
    kernel.maskOutline({ ...args, outSizePx: [w * 2, h * 2] });
    const third = kernel.maskOutline(args);
    expect(third.length).toBe(first.length);
    for (let i = 0; i < first.length; i += 1) expect(third[i]).toBe(first[i]);
  });

  it('縫合後的輪廓數與點數與後端一致，且輪廓閉合', () => {
    const maskVolume = Uint8Array.from(fixture.kernel.mask_outline.mask_kji);
    const view = fromWire.viewReference(fixture.kernel.reslice.view_reference);
    const [w, h] = fixture.kernel.mask_outline.out_size_px;
    const field = kernel.reslicePlane({
      volume: maskVolume,
      volumeKey: 'mask-fixture',
      grid,
      view,
      outSizePx: [w, h],
      pxMm: fixture.kernel.mask_outline.px_mm,
      blend: 'center',
      outside: 0,
    });
    const polylines = kernel.stitch(kernel.marchingSquares(field, w, h, 0.5));
    expect(polylines.length).toBe(fixture.kernel.mask_outline.polyline_count);
    // fixture 記的是**點數**；TS 的 Float32Array 是 x,y 交錯，因此長度是點數的兩倍
    expect(polylines.map((p) => p.length / 2)).toEqual(
      fixture.kernel.mask_outline.polyline_point_counts,
    );
    for (const line of polylines) {
      const n = line.length / 2;
      expect(Math.abs(line[0]! - line[(n - 1) * 2]!)).toBeLessThan(1e-3);
      expect(Math.abs(line[1]! - line[(n - 1) * 2 + 1]!)).toBeLessThan(1e-3);
    }
  });

  it('球的輪廓半徑符合解析值（幾何而非像素的驗收）', () => {
    const maskVolume = Uint8Array.from(fixture.kernel.mask_outline.mask_kji);
    const view = fromWire.viewReference(fixture.kernel.reslice.view_reference);
    const [w, h] = fixture.kernel.mask_outline.out_size_px;
    const pxMm = fixture.kernel.mask_outline.px_mm;
    const field = kernel.reslicePlane({
      volume: maskVolume,
      volumeKey: 'mask-fixture',
      grid,
      view,
      outSizePx: [w, h],
      pxMm,
      blend: 'center',
      outside: 0,
    });
    const segments = kernel.marchingSquares(field, w, h, 0.5);
    const cx = (w - 1) / 2;
    const cy = (h - 1) / 2;
    let sum = 0;
    let count = 0;
    for (let s = 0; s < segments.length / 4; s += 1) {
      const o = s * 4;
      sum += Math.hypot(segments[o]! - cx, segments[o + 1]! - cy) * pxMm;
      count += 1;
    }
    // 球心通過平面 → 交線半徑 = 球半徑；體素化誤差約 1 個體素
    expect(sum / count).toBeCloseTo(fixture.kernel.mask_outline.sphere_radius_mm, 0);
  });

  /**
   * slab 混合模式的**不變式**，而不是「平滑度」。
   *
   * ⚠️ 「mean 比 center 平滑」在**任意**資料上並不成立（例如週期性的合成
   * 圖樣，沿法線平均可能反而放大 in-plane 對比）。它成立的前提是「沿法線
   * 方向存在階梯」——那是 `anisotropic` 假體的情境，已由
   * `test_mean_blend_smooths_anisotropic_steps`（Python 端）驗證。
   *
   * 這裡驗證的是**恆成立**的關係：MIP ≥ mean ≥ min，且 center 落在
   * slab 取樣的值域內。這才是等效性測試該有的性質。
   */
  it('slab 混合模式的不變式：MIP >= mean >= slab 的最小值', () => {
    const view = fromWire.viewReference(fixture.kernel.reslice.view_reference);
    const thick = { ...view, slabThicknessMm: 9 };
    const [w, h] = fixture.kernel.reslice.out_size_px;
    const args = {
      volume,
      volumeKey: 'fixture',
      grid,
      outSizePx: [w, h] as [number, number],
      pxMm: fixture.kernel.reslice.px_mm,
      outside: -1024,
    };
    const mip = kernel.reslicePlane({ ...args, view: thick, blend: 'mip', slabSamples: 10 });
    const mean = kernel.reslicePlane({ ...args, view: thick, blend: 'mean', slabSamples: 10 });
    for (let i = 0; i < mip.length; i += 1) {
      expect(mip[i]!).toBeGreaterThanOrEqual(mean[i]! - 1e-3);
    }
    // slabSamples=1 時三種模式必須完全一致（退化情況）
    const single = kernel.reslicePlane({ ...args, view, blend: 'center' });
    const singleMip = kernel.reslicePlane({ ...args, view, blend: 'mip', slabSamples: 1 });
    for (let i = 0; i < single.length; i += 1) {
      expect(Math.abs(single[i]! - singleMip[i]!)).toBeLessThan(1e-4);
    }
  });
});
