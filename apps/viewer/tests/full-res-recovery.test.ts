/**
 * 左欄把同一組的其他影像（AVG／MIP／MinIP）打開 → 全解析度上限逐出 4D 的每一幀；以前之後再關掉也補不回來
 * （前端以為抓過了）。現在被逐出的只在「有空位」時補 —— 補回來不會再逐出別的可見序列，兩個序列不會互相逐出。
 * 另外：同一組好幾張影像時每一列標出是哪一張；不透明度可以打數字。
 */

import { describe, expect, it } from 'vitest';

import { imageVolumeKey, VolumeStore } from '../src/core/scene/volumeStore';
import { imageRowName, opacityFromPercent, opacityPercent } from '../src/react/panels/dataModel';
import type { Layer } from '../src/core';

const put = (s: VolumeStore, seriesId: string, lod: number, frameIndex: number | null = null): void =>
  s.putImage({ seriesId, lod, frameIndex, grid: null as never, voxels: new Int16Array(8), defaultWindow: { center: 0, width: 1 } });

describe('被逐出的全解析度什麼時候補回來', () => {
  it('4D ＋ 3 張靜態都可見、上限 3：4D 被逐出後沒有空位；關掉靜態就有', () => {
    const s = new VolumeStore();
    for (let f = 0; f < 10; f += 1) put(s, 'ct4d', 0, f);
    for (const id of ['avg', 'mip', 'minip']) put(s, id, 0);
    const all = new Set(['ct4d', 'avg', 'mip', 'minip']);
    expect(s.enforceFullResBudget(all, 3)).toHaveLength(10); // 最早放進來的 4D 整個走
    expect(s.canHoldFullRes('ct4d', all, 3)).toBe(false); // 補了會逐出可見的靜態 → 不補
    expect(s.canHoldFullRes('ct4d', new Set(['ct4d']), 3)).toBe(true); // 靜態關掉（隱藏的會先被逐出）→ 補
  });

  it('看得見的 4D 最後才逐出 —— 先逐出最早的靜態；被逐出的靜態不會回頭逐出 4D', () => {
    const s = new VolumeStore();
    for (let f = 0; f < 10; f += 1) put(s, 'ct4d', 0, f);
    for (const id of ['avg', 'mip', 'minip']) put(s, id, 0);
    const all = new Set(['ct4d', 'avg', 'mip', 'minip']);
    const temporal = new Set(['ct4d']);
    expect(s.enforceFullResBudget(all, 3, temporal)).toEqual([imageVolumeKey('avg', 0, null)]);
    expect(s.hasImageLodAnyFrame('ct4d', 0)).toBe(true);
    expect(s.canHoldFullRes('avg', all, 3, temporal)).toBe(false); // 補 AVG 會逐出別的 → 不補
    // 4D 被逐出過（例如另一條時間軸）也補得回來：只跟時間序列搶位子
    const t = new VolumeStore();
    for (const id of ['avg', 'mip', 'minip']) put(t, id, 0);
    expect(t.canHoldFullRes('ct4d', all, 3, temporal)).toBe(true);
    expect(t.canHoldFullRes('ct4d', all, 3)).toBe(false); // 沒標時間序列 → 照舊
  });

  it('已經有一幀 lod 0 的序列再放別幀不增加計數；隱藏的不佔位', () => {
    const s = new VolumeStore();
    put(s, 'ct4d', 0, 0);
    put(s, 'a', 0);
    put(s, 'b', 0);
    expect(s.canHoldFullRes('ct4d', new Set(['ct4d', 'a', 'b']), 3)).toBe(true);
    expect(s.canHoldFullRes('c', new Set(['ct4d', 'a', 'b', 'c']), 3)).toBe(false);
    expect(s.canHoldFullRes('c', new Set(['ct4d', 'a', 'c']), 3)).toBe(true); // b 隱藏
  });
});

describe('左欄影像列', () => {
  const layer = (over: Partial<Layer>): Layer => ({ layerId: 'l', kind: 'image', label: 'CT 20261001 Average CT 3.0 Br40', temporalGroupId: null, seriesMeta: { series_description: 'Average CT 3.0 Br40' }, ...over }) as Layer;
  it('同一組好幾張才標名稱；4D 組加「4D ·」；沒有 seriesMeta 用 label', () => {
    expect(imageRowName(layer({}), 1)).toBeNull();
    expect(imageRowName(layer({}), 4)).toBe('Average CT 3.0 Br40');
    expect(imageRowName(layer({ temporalGroupId: 'tg', seriesMeta: { series_description: 'Thorax 4D 3.0 Br40 0%' } }), 4)).toBe('4D · Thorax 4D 3.0 Br40 0%');
    expect(imageRowName(layer({ seriesMeta: {} }), 2)).toBe('CT 20261001 Average CT 3.0 Br40');
  });

  it('不透明度：打 0–100 的數字；空白／非數字不改；超出夾回去', () => {
    expect(opacityFromPercent('35')).toBeCloseTo(0.35);
    expect(opacityFromPercent('0')).toBe(0);
    expect(opacityFromPercent('150')).toBe(1);
    expect(opacityFromPercent('-5')).toBe(0);
    expect(opacityFromPercent('')).toBeNull();
    expect(opacityFromPercent('abc')).toBeNull();
    expect(opacityPercent(0.5)).toBe(50);
    expect(opacityPercent(0.333)).toBe(33);
  });
});
