/** 自訂 WW/WL 預設集、3D 相機跟十字線、簽核依集篩選。 */
import { describe, expect, it } from 'vitest';

import type { StructureMeta } from '../src/core/panels/api';
import { followCrosshair, type Camera3d } from '../src/react/modules/render3d/camera3d';
import { countBySet, filterBySet } from '../src/react/modules/review/model';
import { addUserPreset, allPresets, presetIdFor, readUserPresets, removeUserPreset, WINDOW_PRESETS, writeUserPresets } from '../src/react/panels/dataModel';

describe('user window presets', () => {
  it('新增／同名覆寫／刪除；presetIdFor 認得自訂；壞資料讀成空', () => {
    const r1 = addUserPreset([], ' 我的肺 ', { center: -500, width: 1400.4 });
    expect('preset' in r1 && r1.preset.label === '我的肺' && r1.preset.width === 1400 && r1.preset.id.startsWith('user:')).toBe(true);
    if (!('presets' in r1)) throw new Error();
    const r2 = addUserPreset(r1.presets, '我的肺', { center: -600, width: 1500 });
    if (!('presets' in r2)) throw new Error();
    expect(r2.presets.length).toBe(1);
    expect(r2.presets[0]!.center).toBe(-600);
    expect(addUserPreset([], '', { center: 0, width: 1 })).toEqual({ error: '名稱必填' });
    expect('error' in addUserPreset([], 'x', { center: 0, width: 0 })).toBe(true);
    expect(presetIdFor({ center: -600, width: 1500 }, allPresets(r2.presets))).toBe('lung'); // 內建優先
    expect(presetIdFor({ center: -600, width: 1500 }, allPresets(r1.presets))).toBe('lung');
    expect(presetIdFor({ center: -500, width: 1400 }, allPresets(r1.presets))).toBe(r1.preset.id);
    expect(removeUserPreset(r2.presets, r2.presets[0]!.id)).toEqual([]);
    const store = new Map<string, string>();
    const fake = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) };
    writeUserPresets(fake, r1.presets);
    expect(readUserPresets(fake)).toEqual(r1.presets);
    store.set('rtgaia.wl.presets.v1', '[{"id":"soft","label":"x","center":1,"width":2},{"bad":true}]');
    expect(readUserPresets(fake)).toEqual([]); // 不是 user: 前綴、壞形狀都丟
    expect(readUserPresets(null)).toEqual([]);
    expect(WINDOW_PRESETS.length).toBe(5);
  });
});

describe('followCrosshair', () => {
  it('焦點搬到目標、相機平移同向量；沒動就回同一個物件', () => {
    const cam: Camera3d = { position: [0, -500, 0], focalPoint: [0, 0, 0], viewUp: [0, 0, 1], viewAngleDeg: 30 };
    const next = followCrosshair(cam, [10, 20, 30]);
    expect(next.focalPoint).toEqual([10, 20, 30]);
    expect(next.position).toEqual([10, -480, 30]);
    expect(followCrosshair(cam, [0, 0, 0])).toBe(cam);
  });
});

describe('review by set', () => {
  const s = (id: string, set: string | null): StructureMeta => ({ structureId: id, name: id, status: 'edited', structureSetId: set } as unknown as StructureMeta);
  it('篩選與計數', () => {
    const all = [s('a', 'S1'), s('b', 'S2'), s('c', null)];
    expect(filterBySet(all, null).length).toBe(3);
    expect(filterBySet(all, 'S1').map((x) => x.structureId)).toEqual(['a']);
    expect(countBySet(all).get('S2')).toBe(1);
    expect(countBySet(all).get(null)).toBe(1);
  });
});
