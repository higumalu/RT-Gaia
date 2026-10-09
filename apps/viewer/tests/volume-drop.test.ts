/** 卸載體素回傳釋放的 bytes；lod 2 留著讓畫面不空白。 */
import { describe, expect, it } from 'vitest';

import { VolumeStore } from '../src/core/scene/volumeStore';
import type { Grid } from '../src/core/geometry';

const grid = { origin: [0, 0, 0], spacing: [1, 1, 1], size: [4, 4, 4], direction: [1, 0, 0, 0, 1, 0, 0, 0, 1] } as unknown as Grid;

describe('VolumeStore.dropImage / dropMask', () => {
  it('丟 lod 0 回傳 bytes、lod 2 仍在；再丟一次是 0', () => {
    const store = new VolumeStore();
    store.putImage({ seriesId: 'ct', lod: 0, grid, voxels: new Int16Array(64), defaultWindow: { center: 0, width: 1 } });
    store.putImage({ seriesId: 'ct', lod: 2, grid, voxels: new Int16Array(8), defaultWindow: { center: 0, width: 1 } });
    expect(store.dropImage('ct', 0)).toBe(128);
    expect(store.hasImageLod('ct', 0)).toBe(false);
    expect(store.hasImageLod('ct', 2)).toBe(true);
    expect(store.dropImage('ct', 0)).toBe(0);
    expect(store.residentBytes().image).toBe(16);
  });
  it('丟 mask 回傳 bytes', () => {
    const store = new VolumeStore();
    store.putMask({ structureId: 'gtv', frameIndex: null, blockGrid: grid, offsetIjk: [0, 0, 0], sizeIjk: [4, 4, 4], voxels: new Uint8Array(64), contentHash: 'h', revision: 0 });
    expect(store.dropMask('gtv')).toBe(64);
    expect(store.dropMask('gtv')).toBe(0);
    expect(store.mask('gtv')).toBeUndefined();
  });
});
