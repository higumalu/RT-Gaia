/**
 * 4D ↔ 多個 3D —— 攤開的那一張固定看自己的幀、每一格可以鎖相位、
 * 需要哪幾幀的全解析度、組成對話框的預設、鎖定狀態存在瀏覽器。
 */

import { describe, expect, it } from 'vitest';

import { VolumeStore } from '../src/core/scene/volumeStore';
import {
  backendMessage,
  compareFrames,
  defaultFrameLabel,
  defaultFrameOrder,
  isExpanded,
  looksDerived,
  neededFullResFrames,
  PHASE_LOCKS_KEY,
  readPhaseLocks,
  temporalSignature,
  writePhaseLocks,
} from '../src/react/modules/temporal/model';
import { imageRowName } from '../src/react/panels/dataModel';
import type { Layer } from '../src/core';

const put = (s: VolumeStore, seriesId: string, lod: number, frameIndex: number | null, fill: number): void =>
  s.putImage({ seriesId, lod, frameIndex, grid: null as never, voxels: new Int16Array(8).fill(fill), defaultWindow: { center: 0, width: 1 } });

const img = (over: Partial<Layer>): Layer => ({ layerId: 'l', kind: 'image', label: 'x', groupId: null, frameOfReferenceUid: 'F', contentRef: 'ct4d', visible: true, opacity: 1, order: 0, ...over });

describe('取哪一幀', () => {
  const store = new VolumeStore();
  for (let f = 0; f < 4; f += 1) put(store, 'ct4d', 0, f, f);
  store.setFrameResolver(() => 1); // 游標在第 1 幀
  store.setSeriesFrame('ct4d', 1);
  const fill = (layer: Layer, override?: (g: string) => number | undefined): number => (store.forLayer(layer, override)!.voxels as Int16Array)[0]!;

  it('跟游標的取游標；攤開的那一張固定自己的幀；靜態序列 null', () => {
    expect(store.frameOf(img({ temporalGroupId: 'tg' }))).toBe(1);
    expect(store.frameOf(img({ temporalGroupId: 'tg', frameIndex: 3 }))).toBe(3);
    expect(store.frameOf(img({ temporalGroupId: null }))).toBeNull();
    expect(fill(img({ temporalGroupId: 'tg' }))).toBe(1);
    expect(fill(img({ temporalGroupId: 'tg', frameIndex: 3 }))).toBe(3);
  });

  it('這一格鎖了相位 → 那一幀；沒鎖的群組照游標；攤開的那一張不受鎖影響', () => {
    const lock = (g: string): number | undefined => (g === 'tg' ? 2 : undefined);
    expect(fill(img({ temporalGroupId: 'tg' }), lock)).toBe(2);
    expect(fill(img({ temporalGroupId: 'other' }), lock)).toBe(1);
    expect(fill(img({ temporalGroupId: 'tg', frameIndex: 0 }), lock)).toBe(0);
  });
});

describe('需要哪幾幀的全解析度', () => {
  const temporal = [{ temporalGroupId: 'tg', cursor: 4, playing: false }];
  it('游標那一幀 ＋ 每一格鎖定的；攤開的各自的幀；隱藏的不算；靜態 null', () => {
    const layers = [
      img({ layerId: 'a', temporalGroupId: 'tg' }),
      img({ layerId: 'b', contentRef: 'avg', temporalGroupId: null }),
      img({ layerId: 'c', contentRef: 'hidden', temporalGroupId: null, visible: false }),
    ];
    const out = neededFullResFrames(layers, temporal, { 'compare-left': { tg: 4 }, 'compare-right': { tg: 9 } });
    expect([...out.get('ct4d')!].sort()).toEqual([4, 9]);
    expect([...out.get('avg')!]).toEqual([null]);
    expect(out.has('hidden')).toBe(false);
    const expanded = [img({ layerId: 'f0', frameIndex: 0, temporalGroupId: 'tg' }), img({ layerId: 'f5', frameIndex: 5, temporalGroupId: 'tg' }), img({ layerId: 'f7', frameIndex: 7, temporalGroupId: 'tg', visible: false })];
    expect([...neededFullResFrames(expanded, temporal, {}).get('ct4d')!].sort()).toEqual([0, 5]);
  });

  it('播放中：游標那一幀不算（播放用低解析度），鎖定的格子照算', () => {
    const out = neededFullResFrames([img({ temporalGroupId: 'tg' })], [{ temporalGroupId: 'tg', cursor: 4, playing: true }], { left: { tg: 2 } });
    expect([...out.get('ct4d')!]).toEqual([2]);
  });
});

describe('時間軸列與對話框', () => {
  it('攤開判斷、組成前後比對、並排的兩幀、後端訊息', () => {
    expect(isExpanded([img({ temporalGroupId: 'tg', frameIndex: 0 })], 'tg')).toBe(true);
    expect(isExpanded([img({ temporalGroupId: 'tg' })], 'tg')).toBe(false);
    expect(temporalSignature([{ temporal_group_id: 'b' }, { temporal_group_id: 'a' }])).toBe(temporalSignature([{ temporal_group_id: 'a' }, { temporal_group_id: 'b' }]));
    expect(temporalSignature([])).not.toBe(temporalSignature([{ temporal_group_id: 'a' }]));
    // 同一條時間軸、幀數變了（重新取樣補進相位）→ 不同
    expect(temporalSignature([{ temporal_group_id: 'a', frame_count: 8 }])).not.toBe(temporalSignature([{ temporal_group_id: 'a', frame_count: 10 }]));
    expect(compareFrames(0, 10)).toEqual([0, 5]);
    expect(compareFrames(7, 10)).toEqual([7, 2]);
    expect(compareFrames(0, 1)).toEqual([0, 0]);
    expect(backendMessage(new Error('HTTP 409 /studies/x/temporal-groups/tg: {"detail":{"code":"TA16","message":"這條時間軸上有 1 個只屬某一幀的結構"}}'))).toBe('這條時間軸上有 1 個只屬某一幀的結構');
    expect(backendMessage(new Error('network down'))).toBe('network down');
  });

  it('預設名稱、順序、衍生影像不勾', () => {
    expect(defaultFrameLabel({ series_description: 'CT Chest 3.0, Gated, 40.0%' }, 0)).toBe('40%');
    expect(defaultFrameLabel({ series_description: 't1_fl3d_tra_dyn', series_number: '23' }, 3)).toBe('#23');
    expect(defaultFrameLabel(undefined, 2)).toBe('#3');
    const order = defaultFrameOrder([
      { id: 'b', seriesMeta: { series_description: 'Thorax 4D 50%' } },
      { id: 'a', seriesMeta: { series_description: 'Thorax 4D 0%' } },
      { id: 'c', seriesMeta: { series_description: 'Thorax 4D 10%' } },
    ]).map((x) => x.id);
    expect(order).toEqual(['a', 'c', 'b']);
    expect(defaultFrameOrder([{ id: 'y', seriesMeta: { series_number: '12' } }, { id: 'x', seriesMeta: { series_number: '9' } }]).map((x) => x.id)).toEqual(['x', 'y']);
    expect(looksDerived({ series_description: 'Average CT 3.0 Br40' })).toBe(true);
    expect(looksDerived({ series_description: 'T-MIP 3.0' })).toBe(true);
    expect(looksDerived({ series_description: 'Thorax 4D 3.0 Br40 40%' })).toBe(false);
  });

  it('左欄：攤開的每一張標出是哪一幀', () => {
    const layer = img({ temporalGroupId: 'tg', frameIndex: 3, frameLabel: '30%', seriesMeta: { series_description: 'Thorax 4D' } });
    expect(imageRowName(layer, 10)).toBe('Thorax 4D · 30%');
    expect(imageRowName(img({ temporalGroupId: 'tg', frameIndex: 3, seriesMeta: { series_description: 'X' } }), 10)).toBe('X · #4');
  });
});

describe('每一格鎖定的相位存在瀏覽器（依病例）', () => {
  const memory = (): Pick<Storage, 'getItem' | 'setItem'> & { data: Map<string, string> } => {
    const data = new Map<string, string>();
    return { data, getItem: (k) => data.get(k) ?? null, setItem: (k, v) => void data.set(k, v) };
  };
  it('寫了讀得回來；空的就刪；壞資料不炸；最多 20 個病例', () => {
    const store = memory();
    writePhaseLocks(store, 'case_a', { 'compare-left': { tg: 0 }, 'compare-right': { tg: 5 } });
    expect(readPhaseLocks(store, 'case_a')).toEqual({ 'compare-left': { tg: 0 }, 'compare-right': { tg: 5 } });
    expect(readPhaseLocks(store, 'case_b')).toEqual({});
    writePhaseLocks(store, 'case_a', {});
    expect(readPhaseLocks(store, 'case_a')).toEqual({});
    store.data.set(PHASE_LOCKS_KEY, '{not json');
    expect(readPhaseLocks(store, 'case_a')).toEqual({});
    store.data.set(PHASE_LOCKS_KEY, JSON.stringify({ case_a: { axial: { tg: -1, ok: 2 } } }));
    expect(readPhaseLocks(store, 'case_a')).toEqual({ axial: { ok: 2 } });
    for (let i = 0; i < 25; i += 1) writePhaseLocks(store, `c${i}`, { axial: { tg: i } });
    const all = JSON.parse(store.data.get(PHASE_LOCKS_KEY)!) as Record<string, unknown>;
    expect(Object.keys(all)).toHaveLength(20);
    expect(readPhaseLocks(store, 'c24')).toEqual({ axial: { tg: 24 } });
    expect(readPhaseLocks(null, 'c24')).toEqual({});
  });
});
