/** 斜面判定、是否要高品質、快取 key 與 drawImage 同源。 */
import { describe, expect, it } from 'vitest';

import { imageResliceArgs } from '../src/core/raster/cpuBackends';
import { CachingResliceKernel, planeCacheKey } from '../src/core/raster/resliceCache';
import type { ResliceKernel } from '../src/core/raster/types';
import { cameraKey, isObliqueCamera, shouldRequestHighQuality } from '../src/core/scene/hybridReslice';
import type { Grid, ViewReference } from '../src/core/geometry';

const grid = { origin: [0, 0, 0], spacing: [1, 1, 1], size: [8, 8, 8], direction: [1, 0, 0, 0, 1, 0, 0, 0, 1] } as unknown as Grid;
const view = (normal: [number, number, number]): ViewReference => ({
  frameOfReferenceUid: 'f', displayGridId: 'dg', planeOrigin: [4, 4, 4], viewPlaneNormal: normal, viewUp: [0, -1, 0], slabThicknessMm: 0, temporalGroupId: null, frameIndex: null,
});

describe('hybrid reslice', () => {
  it('軸向不算斜面；轉 3° 以上算', () => {
    expect(isObliqueCamera(view([0, 0, 1]))).toBe(false);
    expect(isObliqueCamera(view([1, 0, 0]))).toBe(false);
    const a = (5 * Math.PI) / 180;
    expect(isObliqueCamera(view([Math.sin(a), 0, Math.cos(a)]))).toBe(true);
    expect(shouldRequestHighQuality({ view: view([0.3, 0, 0.954]), alreadyHighQuality: false, visibleImages: 1 })).toBe(true);
    expect(shouldRequestHighQuality({ view: view([0.3, 0, 0.954]), alreadyHighQuality: true, visibleImages: 1 })).toBe(false);
    expect(shouldRequestHighQuality({ view: view([0.3, 0, 0.954]), alreadyHighQuality: false, visibleImages: 0 })).toBe(false);
    expect(cameraKey(view([0, 0, 1]))).not.toBe(cameraKey(view([0, 0.001, 1])));
  });
  it('伺服器平面放進快取的 key ＝ drawImage 會用的 key → 下一幀命中、不再叫 kernel', () => {
    let calls = 0;
    const inner: ResliceKernel = {
      abiVersion: 1,
      reslicePlane: () => { calls += 1; return new Float32Array(16); },
      windowToU8: () => new Uint8Array(16),
      marchingSquares: () => new Float32Array(0),
      stitch: () => [],
      maskOutline: () => new Float32Array(0),
      dispose: () => {},
    };
    const cache = new CachingResliceKernel(inner);
    const entry = { voxels: new Int16Array(512), volumeKey: 'ct@lod0', grid };
    const args = imageResliceArgs(entry, view([0.3, 0, 0.954]), [4, 4], 1);
    const key = planeCacheKey(args);
    const hq = new Float32Array(16).fill(7);
    cache.putPlane(key, hq, 'ct@lod0');
    expect(cache.isHighQuality(key)).toBe(true);
    expect(cache.reslicePlane(args)).toBe(hq);
    expect(calls).toBe(0);
    cache.invalidateVolume('ct@lod0');
    expect(cache.isHighQuality(key)).toBe(false);
  });
});
