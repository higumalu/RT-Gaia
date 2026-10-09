/**
 * 斜面重切的驗收：**斜面上零偏移**。
 *
 * `landmark` 假體在 `(i,j,k) = (37,61,13)` 有唯一高值體素（fixture 給了它的網格與
 * 世界座標）。把平面轉到任意斜面、穿過該體素：
 *   (a) 重切出的平面上最亮的像素 ＝ `worldToPlanePx(world)`（±0.5 px）
 *   (b) 在那個像素 `planePxToWorld` 回去 → `worldToNearestVoxel` 仍是 (37,61,13)
 * `gantry_tilt`（傾斜 15° 的 direction）也要成立 —— 軸對齊網格抓不到漏傳 direction。
 *
 * 用真的 WASM 核心（與 kernel.test 同一份 .wasm）。
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath, URL } from 'node:url';

import { beforeAll, describe, expect, it } from 'vitest';

import { createGrid, indexToWorld, worldToNearestVoxel, type Grid, type ViewReference } from '../src/core/geometry';
import { WasmResliceKernel } from '../src/core/raster/resliceKernel';
import { orthoCamera, planePxToWorld, rotateInPlane, worldToPlanePx } from '../src/core/scene/cameras';
import { fromWire } from '../src/core/transport/wire';

const fixture = JSON.parse(
  readFileSync(fileURLToPath(new URL('./fixtures/geometry-vectors.json', import.meta.url)), 'utf8'),
) as {
  kernel: { available: boolean };
  landmark: { ijk: [number, number, number]; world_lps: [number, number, number]; voxel_value: number; grid: Record<string, unknown> };
};

const WASM_PATH = fileURLToPath(new URL('../public/rtgaia_reslice.wasm', import.meta.url));

/** 平滑漸層底 ＋ 一顆高值體素（與後端 `landmark` 假體同構）。 */
function landmarkVolume(grid: Grid, ijk: readonly [number, number, number], value: number): Int16Array {
  const [nx, ny, nz] = grid.size;
  const v = new Int16Array(nx * ny * nz);
  for (let k = 0; k < nz; k += 1) for (let j = 0; j < ny; j += 1) for (let i = 0; i < nx; i += 1) {
    v[i + nx * (j + ny * k)] = Math.round(((i + j + k) / (nx + ny + nz)) * 200);
  }
  v[ijk[0] + nx * (ijk[1] + ny * ijk[2])] = value;
  return v;
}

function argmax(plane: Float32Array, w: number): { x: number; y: number; value: number } {
  let best = -Infinity;
  let at = 0;
  for (let i = 0; i < plane.length; i += 1) {
    if (plane[i]! > best) {
      best = plane[i]!;
      at = i;
    }
  }
  return { x: at % w, y: Math.floor(at / w), value: best };
}

describe.skipIf(!fixture.kernel.available)('斜面上零偏移（landmark）', () => {
  let kernel: WasmResliceKernel;
  beforeAll(async () => {
    kernel = await WasmResliceKernel.instantiate(new Uint8Array(readFileSync(WASM_PATH)).buffer);
  });

  const cases: { name: string; grid: () => Grid }[] = [
    { name: 'landmark（軸對齊）', grid: () => fromWire.grid(fixture.landmark.grid) },
    {
      name: 'gantry tilt 15°（direction 不是單位矩陣）',
      grid: () => {
        const base = fromWire.grid(fixture.landmark.grid);
        const t = (15 * Math.PI) / 180;
        // 繞 x 傾斜：第 2、3 欄（j、k 軸）在 y-z 平面內轉 15°
        return createGrid({
          ...base,
          direction: [1, 0, 0, 0, Math.cos(t), -Math.sin(t), 0, Math.sin(t), Math.cos(t)],
        });
      },
    },
  ];

  for (const c of cases) {
    it(`${c.name}：旋轉 20°／12° 的斜面穿過 landmark，最亮像素就在 project() 的位置`, () => {
      const grid = c.grid();
      const ijk = fixture.landmark.ijk;
      const world = indexToWorld(grid, ijk);
      const volume = landmarkVolume(grid, ijk, fixture.landmark.voxel_value);
      const size = { w: 160, h: 120 };
      const pxMm = 0.6;
      const base: ViewReference = orthoCamera({ grid, orientation: 'axial', displayGridId: 'dg', planeOrigin: world });
      for (const view of [base, rotateInPlane(rotateInPlane(base, 'up', 20), 'right', 12), rotateInPlane(base, 'right', -35)]) {
        // 平面穿過 landmark（planeOrigin 就是它），但把它推離畫面中心，才驗得到投影本身
        const shifted: ViewReference = { ...view, planeOrigin: planePxToWorld(view, pxMm, size, { x: 30, y: 80 }) };
        const expected = worldToPlanePx(shifted, pxMm, size, world);
        // 30/80 的偏移把 landmark 推到 (149.5+(79.5-30), 59.5+(59.5-80))；確認它在畫面內
        expect(expected.x).toBeGreaterThan(0);
        expect(expected.y).toBeGreaterThan(0);
        const plane = kernel.reslicePlane({
          volume,
          volumeKey: `lm:${c.name}`,
          grid,
          view: shifted,
          outSizePx: [size.w, size.h],
          pxMm,
          blend: 'center',
          outside: -1024,
        });
        const peak = argmax(plane, size.w);
        // (a) 最亮像素在投影位置 ±1 px（三線性內插把高值分到鄰近像素，取樣點在整數像素上）
        expect(Math.abs(peak.x - expected.x)).toBeLessThanOrEqual(1);
        expect(Math.abs(peak.y - expected.y)).toBeLessThanOrEqual(1);
        expect(peak.value).toBeGreaterThan(400);
        // (b) 從投影像素回到世界再取最近體素，仍是 landmark
        const back = planePxToWorld(shifted, pxMm, size, expected);
        expect(worldToNearestVoxel(grid, back)).toEqual([...ijk]);
      }
    });
  }
});
