/**
 * CI 的效能門檻：效能預算裡**純計算**的幾項，Tier C（CPU）那一欄。
 *
 * 量的是畫面每一幀真正跑的核心呼叫（WASM 重切、window LUT、融合輪廓），不含 canvas 繪製與 React：
 * 互動中的格子（1/4 解析度）、停止後補全解析度、20 個結構的輪廓（互動中 1/2、補算全解析度）、WW/WL。
 * 每一項跑 N 次取中位數（第一次是暖身，WASM 上傳體積不算），對照預算 × `RTGAIA_PERF_SLACK`（預設 1）。
 * 結果印成一張表（CI 記錄裡看得到數字走勢），任何一項超過 → 紅。
 *
 *   npm run test:perf                         # apps/viewer；要先有 public/rtgaia_reslice.wasm（scripts/build-kernel.sh）
 *   RTGAIA_PERF_SLACK=1.5 npm run test:perf   # CI runner 比較慢時放寬（CI 用 1）
 *
 * 不在這裡：首張畫面／全解析度常駐（網路 ＋ 後端，見 `scripts/perf/ci_gate.py`）、3D、筆刷延遲（DOM 事件）。
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath, URL } from 'node:url';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createGrid, createViewReference, type Grid, type ViewReference } from '../../src/core/geometry';
import { WasmResliceKernel } from '../../src/core/raster/resliceKernel';

const SLACK = Number(process.env.RTGAIA_PERF_SLACK ?? '1') || 1;
const FOR = '1.2.826.0.1.3680043.8.498.104';
// 512 × 512 × 160、0.98 × 0.98 × 2.5 mm（典型的胸腹 CT；int16 80 MB）
const NI = 512;
const NJ = 512;
const NK = 160;
const SP: [number, number, number] = [0.98, 0.98, 2.5];
const ORIGIN: [number, number, number] = [-250, -250, -200];
const STRUCTURES = 20;
const RUNS = 15;

const results: { item: string; budgetMs: number; medianMs: number; worstMs: number }[] = [];

function measure(item: string, budgetMs: number, fn: (i: number) => void): void {
  fn(0); // 暖身（上傳體積、配置暫存）
  const times: number[] = [];
  for (let i = 1; i <= RUNS; i += 1) {
    const t0 = performance.now();
    fn(i);
    times.push(performance.now() - t0);
  }
  times.sort((a, b) => a - b);
  const medianMs = times[Math.floor(times.length / 2)]!;
  results.push({ item, budgetMs, medianMs, worstMs: times[times.length - 1]! });
  expect(medianMs, `${item}：中位數 ${medianMs.toFixed(1)} ms，預算 ${budgetMs} ms × ${SLACK}`).toBeLessThan(budgetMs * SLACK);
}

function axialView(z: number): ViewReference {
  return createViewReference({
    frameOfReferenceUid: FOR,
    displayGridId: 'perf',
    planeOrigin: [0, 0, z],
    viewPlaneNormal: [0, 0, 1],
    viewUp: [0, -1, 0],
    slabThicknessMm: 0,
    temporalGroupId: null,
    frameIndex: null,
  });
}

/** 繞 L–R 軸傾斜 `deg` 度的斜面（旋轉互動）。 */
function obliqueView(deg: number): ViewReference {
  const a = (deg * Math.PI) / 180;
  return createViewReference({
    frameOfReferenceUid: FOR,
    displayGridId: 'perf',
    planeOrigin: [0, 0, 0],
    viewPlaneNormal: [0, -Math.sin(a), Math.cos(a)],
    viewUp: [0, -Math.cos(a), -Math.sin(a)],
    slabThicknessMm: 0,
    temporalGroupId: null,
    frameIndex: null,
  });
}

let kernel: WasmResliceKernel;
let grid: Grid;
let volume: Int16Array;
const masks: { key: string; grid: Grid; mask: Uint8Array }[] = [];

beforeAll(async () => {
  kernel = await WasmResliceKernel.instantiate(new Uint8Array(readFileSync(fileURLToPath(new URL('../../public/rtgaia_reslice.wasm', import.meta.url)))).buffer);
  grid = createGrid({ size: [NI, NJ, NK], spacing: SP, origin: ORIGIN, direction: [1, 0, 0, 0, 1, 0, 0, 0, 1], frameOfReferenceUid: FOR });
  // 體模：橢圓的身體（0 HU 附近、帶紋理）、外面空氣 −1000；確定性
  volume = new Int16Array(NI * NJ * NK);
  for (let k = 0; k < NK; k += 1) {
    for (let j = 0; j < NJ; j += 1) {
      const y = (j - NJ / 2) / (NJ * 0.32);
      for (let i = 0; i < NI; i += 1) {
        const x = (i - NI / 2) / (NI * 0.42);
        volume[i + NI * (j + NJ * k)] = x * x + y * y < 1 ? ((i * 7 + j * 13 + k * 3) % 80) - 40 : -1000;
      }
    }
  }
  // 20 個結構：各自的區塊網格（跟 VolumeStore 的 mask 區塊一樣），球、半徑 12–30 mm
  for (let s = 0; s < STRUCTURES; s += 1) {
    const r = 12 + (s % 7) * 3;
    const cx = -120 + (s % 5) * 60;
    const cy = -60 + Math.floor(s / 5) * 40;
    const cz = -40 + (s % 3) * 30;
    const n = [Math.ceil((2 * r) / SP[0]) + 2, Math.ceil((2 * r) / SP[1]) + 2, Math.ceil((2 * r) / SP[2]) + 2] as const;
    const o: [number, number, number] = [cx - r - SP[0], cy - r - SP[1], cz - r - SP[2]];
    const g = createGrid({ size: [n[0], n[1], n[2]], spacing: SP, origin: o, direction: [1, 0, 0, 0, 1, 0, 0, 0, 1], frameOfReferenceUid: FOR });
    const m = new Uint8Array(n[0] * n[1] * n[2]);
    for (let k = 0; k < n[2]; k += 1)
      for (let j = 0; j < n[1]; j += 1)
        for (let i = 0; i < n[0]; i += 1) {
          const dx = o[0] + i * SP[0] - cx;
          const dy = o[1] + j * SP[1] - cy;
          const dz = o[2] + k * SP[2] - cz;
          if (dx * dx + dy * dy + dz * dz <= r * r) m[i + n[0] * (j + n[1] * k)] = 1;
        }
    masks.push({ key: `m${s}`, grid: g, mask: m });
  }
});

afterAll(() => {
  const rows = results.map((r) => `${r.item.padEnd(34)} ${r.medianMs.toFixed(1).padStart(7)} ms  (最慢 ${r.worstMs.toFixed(1)})  預算 ${r.budgetMs} ms${SLACK !== 1 ? ` × ${SLACK}` : ''}`);
  console.log(['', `效能門檻（Tier C，${RUNS} 次中位數）`, ...rows].join('\n'));
});

describe('效能預算（Tier C、純計算）', () => {
  // 互動中 1/4 解析度：512 → 128 px、px 4 倍
  it('MPR 捲動：1/4 解析度重切 ＋ window LUT（≥ 20 fps → < 50 ms）', () => {
    measure('MPR 捲動（1/4）', 50, (i) => {
      const plane = kernel.reslicePlane({ volume, volumeKey: 'ct', grid, view: axialView(-150 + i * 7), outSizePx: [128, 128], pxMm: 3.92, outside: -1024 });
      kernel.windowToU8(plane, 40, 400);
    });
  });
  it('斜面旋轉：1/4 解析度（≥ 12 fps → < 83 ms）', () => {
    measure('斜面旋轉（1/4）', 83, (i) => {
      const plane = kernel.reslicePlane({ volume, volumeKey: 'ct', grid, view: obliqueView(5 + i * 4), outSizePx: [128, 128], pxMm: 3.92, outside: -1024 });
      kernel.windowToU8(plane, 40, 400);
    });
  });
  it('停止互動後補到全解析度（< 250 ms）', () => {
    measure('補全解析度（512²）', 250, (i) => {
      const plane = kernel.reslicePlane({ volume, volumeKey: 'ct', grid, view: obliqueView(10 + i * 3), outSizePx: [512, 512], pxMm: 0.98, outside: -1024 });
      kernel.windowToU8(plane, 40, 400);
    });
  });
  it('WW/WL 拖曳：只重跑 LUT（≥ 20 fps → < 50 ms）', () => {
    const plane = kernel.reslicePlane({ volume, volumeKey: 'ct', grid, view: axialView(0), outSizePx: [512, 512], pxMm: 0.98, outside: -1024 });
    measure('WW/WL（512² LUT）', 50, (i) => {
      kernel.windowToU8(plane, 40 + i * 10, 400 + i * 20);
    });
  });
  const outlines = (view: ViewReference, size: number, pxMm: number): number => {
    let segments = 0;
    for (const m of masks) segments += kernel.maskOutline({ mask: m.mask, volumeKey: m.key, grid: m.grid, view, outSizePx: [size, size], pxMm }).length;
    return segments;
  };
  it('20 個結構的輪廓，互動中 1/2 解析度（< 20 ms）', () => {
    expect(outlines(axialView(-40), 256, 1.96)).toBeGreaterThan(0);
    measure('輪廓 ×20 互動中（256²）', 20, (i) => {
      outlines(axialView(-60 + i * 2.5), 256, 1.96);
    });
  });
  it('20 個結構的輪廓，停止後全解析度（< 80 ms）', () => {
    measure('輪廓 ×20 全解析度（512²）', 80, (i) => {
      outlines(axialView(-60 + i * 2.5), 512, 0.98);
    });
  });
});
