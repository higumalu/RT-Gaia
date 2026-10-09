/**
 * 全解析度常駐上限：隱藏的先逐出、保留 lod 2、回報被逐出的 volumeKey。
 */

import { describe, expect, it } from 'vitest';

import { VolumeStore } from '../src/core/scene/volumeStore';
import { budgetFor, maxFullResVolumes } from '../src/core/tier/budget';

function store(series: { id: string; lods: number[] }[]): VolumeStore {
  const s = new VolumeStore();
  for (const { id, lods } of series) {
    for (const lod of lods) {
      s.putImage({ seriesId: id, lod, grid: null as never, voxels: new Int16Array(8), defaultWindow: { center: 0, width: 1 } });
    }
  }
  return s;
}

describe('VolumeStore.enforceFullResBudget', () => {
  it('在上限內什麼都不做', () => {
    const s = store([{ id: 'a', lods: [0, 2] }, { id: 'b', lods: [0, 2] }]);
    expect(s.enforceFullResBudget(new Set(['a', 'b']), 2)).toEqual([]);
  });

  it('🔴 超過上限：隱藏的先走，lod 2 留著（重新顯示時立刻有畫面）', () => {
    const s = store([
      { id: 'a', lods: [0, 2] },
      { id: 'b', lods: [0, 2] },
      { id: 'c', lods: [0, 2] },
    ]);
    const dropped = s.enforceFullResBudget(new Set(['a', 'c']), 2);
    expect(dropped).toEqual(['b@lod0']);
    expect(s.hasImageLod('b', 0)).toBe(false);
    expect(s.hasImageLod('b', 2)).toBe(true);
    expect(s.image('b')?.lod).toBe(2);
    expect(s.residentLods('b')).toEqual([2]);
    expect(s.hasImageLod('a', 0) && s.hasImageLod('c', 0)).toBe(true);
  });

  it('全部可見仍超過：最早放進來的先走', () => {
    const s = store([
      { id: 'a', lods: [0] },
      { id: 'b', lods: [0] },
      { id: 'c', lods: [0] },
    ]);
    expect(s.enforceFullResBudget(new Set(['a', 'b', 'c']), 1)).toEqual(['a@lod0', 'b@lod0']);
    expect(s.hasImageLod('c', 0)).toBe(true);
  });
});

describe('budget', () => {
  it('2 個以上序列一律用雙影像那一欄；全解析度數量依 Tier 限制', () => {
    expect(budgetFor('C', 3)).toBe(budgetFor('C', 2));
    expect(budgetFor('C', 1)).not.toBe(budgetFor('C', 2));
    expect([maxFullResVolumes('A'), maxFullResVolumes('B'), maxFullResVolumes('C')]).toEqual([4, 2, 3]);
  });
});
