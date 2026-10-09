/**
 * 重切／輪廓結果快取。
 * 2026-09-23 profile：全顯示的 5 秒裡 95% 是在同樣的相機、同樣的體積上重算同樣的平面與輪廓。
 */
import { describe, expect, it } from 'vitest';

import { CachingResliceKernel, outlineCacheKey, planeCacheKey } from '../src/core/raster/resliceCache';
import type { MaskOutlineArgs, ReslicePlaneArgs, ResliceKernel } from '../src/core/raster/types';
import type { Grid, ViewReference } from '../src/core/geometry';

const grid: Grid = {
  origin: [0, 0, 0],
  spacing: [1, 1, 1],
  size: [8, 8, 8],
  direction: [1, 0, 0, 0, 1, 0, 0, 0, 1],
} as unknown as Grid;

const view = (z: number): ViewReference => ({
  frameOfReferenceUid: 'f',
  displayGridId: 'dg',
  planeOrigin: [4, 4, z],
  viewPlaneNormal: [0, 0, 1],
  viewUp: [0, -1, 0],
  slabThicknessMm: 0,
  temporalGroupId: null,
  frameIndex: null,
});

function fakeKernel(): ResliceKernel & { calls: { plane: number; outline: number; window: number } } {
  const calls = { plane: 0, outline: 0, window: 0 };
  return {
    calls,
    abiVersion: 1,
    reslicePlane: (args) => {
      calls.plane += 1;
      return new Float32Array(args.outSizePx[0] * args.outSizePx[1]);
    },
    windowToU8: (plane) => {
      calls.window += 1;
      return new Uint8Array(plane.length);
    },
    marchingSquares: () => new Float32Array(0),
    stitch: () => [],
    maskOutline: () => {
      calls.outline += 1;
      return new Float32Array(8);
    },
    dispose: () => {},
  };
}

const planeArgs = (volumeKey: string, z = 0): ReslicePlaneArgs & { volumeKey: string } => ({
  volume: new Int16Array(512),
  volumeKey,
  grid,
  view: view(z),
  outSizePx: [4, 4],
  pxMm: 1,
  blend: 'center',
  outside: -1024,
});
const outlineArgs = (volumeKey: string, z = 0): MaskOutlineArgs => ({
  mask: new Uint8Array(512),
  volumeKey,
  grid,
  view: view(z),
  outSizePx: [4, 4],
  pxMm: 1,
});

describe('CachingResliceKernel', () => {
  it('同樣輸入第二次不呼叫 kernel；相機一動就重算', () => {
    const inner = fakeKernel();
    const cache = new CachingResliceKernel(inner);
    const a = cache.reslicePlane(planeArgs('ct@lod0'));
    const b = cache.reslicePlane(planeArgs('ct@lod0'));
    expect(b).toBe(a);
    expect(inner.calls.plane).toBe(1);
    cache.reslicePlane(planeArgs('ct@lod0', 1));
    expect(inner.calls.plane).toBe(2);
    expect(cache.stats.hits).toBe(1);
    expect(cache.stats.misses).toBe(2);
  });

  it('mask 的 volumeKey 含修訂號 → 編輯後自然失效；同一個結構其他格的快取不受影響', () => {
    const inner = fakeKernel();
    const cache = new CachingResliceKernel(inner);
    cache.maskOutline(outlineArgs('mask:GTV@static#0'));
    cache.maskOutline(outlineArgs('mask:GTV@static#0'));
    expect(inner.calls.outline).toBe(1);
    cache.maskOutline(outlineArgs('mask:GTV@static#1'));
    expect(inner.calls.outline).toBe(2);
    expect(outlineCacheKey(outlineArgs('a'))).not.toBe(outlineCacheKey(outlineArgs('a', 1)));
    expect(planeCacheKey(planeArgs('a'))).toBe(planeCacheKey(planeArgs('a')));
  });

  it('windowToU8 以平面身分＋window 記憶；換 window 就重算', () => {
    const inner = fakeKernel();
    const cache = new CachingResliceKernel(inner);
    const plane = cache.reslicePlane(planeArgs('ct@lod0'));
    cache.windowToU8(plane, 40, 400);
    cache.windowToU8(plane, 40, 400);
    expect(inner.calls.window).toBe(1);
    cache.windowToU8(plane, 300, 1500);
    expect(inner.calls.window).toBe(2);
  });

  it('LRU：超過預算丟最舊；invalidateVolume 只丟該體積', () => {
    const inner = fakeKernel();
    // 每個 4×4 f32 平面 64 bytes；預算放兩個
    const cache = new CachingResliceKernel(inner, 128);
    cache.reslicePlane(planeArgs('a'));
    cache.reslicePlane(planeArgs('b'));
    cache.reslicePlane(planeArgs('c'));
    expect(cache.stats.entries).toBe(2);
    cache.reslicePlane(planeArgs('a')); // a 已被逐出 → 重算
    expect(inner.calls.plane).toBe(4);
    expect(cache.invalidateVolume('a')).toBe(1);
    expect(cache.stats.entries).toBe(1);
    cache.clear();
    expect(cache.stats.bytes).toBe(0);
  });
});
