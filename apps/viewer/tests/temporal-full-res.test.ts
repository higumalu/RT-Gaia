/**
 * 時間序列像影片一樣播放 —— 預算放得下就每一幀都留全解析度；全解析度上限以序列計數（10 個相位合算一個）；
 * 時間軸列的「高清 n／N」。
 */

import { describe, expect, it } from 'vitest';

import { VolumeStore } from '../src/core/scene/volumeStore';
import { budgetFor } from '../src/core/tier/budget';
import { FULL_RES_TEMPORAL_FRACTION, fullResText, keepAllFramesFullRes } from '../src/react/modules/temporal/model';

const put = (s: VolumeStore, seriesId: string, lod: number, frameIndex: number | null = null): void =>
  s.putImage({ seriesId, lod, frameIndex, grid: null as never, voxels: new Int16Array(8), defaultWindow: { center: 0, width: 1 } });

describe('全解析度上限以序列計數', () => {
  it('4DCT 10 個相位的 lod 0 合算一個：上限 1 也不逐出', () => {
    const s = new VolumeStore();
    for (let f = 0; f < 10; f += 1) {
      put(s, 'ct4d', 2, f);
      put(s, 'ct4d', 0, f);
    }
    expect(s.enforceFullResBudget(new Set(['ct4d']), 1)).toEqual([]);
    expect(s.residentFrames('ct4d', 0)).toHaveLength(10);
  });

  it('超過上限時整個序列一起逐出（每一幀的 lod 0），lod 2 留著', () => {
    const s = new VolumeStore();
    for (let f = 0; f < 3; f += 1) {
      put(s, 'ct4d', 2, f);
      put(s, 'ct4d', 0, f);
    }
    put(s, 'cbct', 0);
    const dropped = s.enforceFullResBudget(new Set(['cbct']), 1); // 4D 隱藏 → 先走
    expect(dropped).toEqual(['ct4d@lod0#f0', 'ct4d@lod0#f1', 'ct4d@lod0#f2']);
    expect(s.residentFrames('ct4d', 0)).toEqual([]);
    expect(s.residentFrames('ct4d', 2)).toEqual([0, 1, 2]);
    expect(s.hasImageLod('cbct', 0)).toBe(true);
  });
});

describe('每一幀都留全解析度的預算', () => {
  const MB = 1_000_000;
  it('4D-Lung（69 MB × 10）：Tier A、C 放得下，B 放不下；已佔用的要算進去', () => {
    const frame = 512 * 512 * 132 * 2;
    expect(keepAllFramesFullRes(frame, 10, budgetFor('A', 1).imageBytes)).toBe(true);
    expect(keepAllFramesFullRes(frame, 10, budgetFor('C', 1).imageBytes)).toBe(true);
    expect(keepAllFramesFullRes(frame, 10, budgetFor('B', 1).imageBytes)).toBe(false);
    expect(keepAllFramesFullRes(frame, 10, budgetFor('C', 1).imageBytes, 200 * MB)).toBe(false);
    expect(keepAllFramesFullRes(100 * MB, 8, 1000 * MB)).toBe(FULL_RES_TEMPORAL_FRACTION >= 0.8);
  });

  it('不知道大小（還沒抓過 lod 0）或沒有幀 → 不做', () => {
    expect(keepAllFramesFullRes(0, 10, 1000 * MB)).toBe(false);
    expect(keepAllFramesFullRes(Number.NaN, 10, 1000 * MB)).toBe(false);
    expect(keepAllFramesFullRes(MB, 0, 1000 * MB)).toBe(false);
  });

  it('時間軸列「高清 n／N」：全部到了就不顯示', () => {
    expect(fullResText({ frameCount: 10, fullResFrames: [0, 1, 2] })).toBe('高清 3／10');
    expect(fullResText({ frameCount: 10, fullResFrames: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9] })).toBeNull();
    expect(fullResText({ frameCount: null, fullResFrames: [] })).toBeNull();
  });
});
