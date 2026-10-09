/** 結構清單以結構集分層的純邏輯（`structureGroups.ts`）。 */

import { describe, expect, it } from 'vitest';

import type { StructureSetInfo } from '../src/core/panels/api';
import { defaultSetFor, filterRows, groupRows, OTHER_GROUP_KEY, setLabel, setTitle, shouldGroup, usesStructureSetsOf } from '../src/react/components/structureGroups';
import { setLang } from '../src/core/i18n';

const set = (id: string, over: Partial<StructureSetInfo> = {}): StructureSetInfo => ({
  structureSetId: id,
  label: `RS_${id}`,
  seriesInstanceUid: `1.2.${id}`,
  imageSeriesUid: `img.${id}`,
  imageLabel: `CT 2026060${id}`,
  frameOfReferenceUid: `for.${id}`,
  date: `2026060${id}`,
  roiCount: 2,
  role: id === '1' ? 'primary' : 'secondary',
  kind: 'import',
  owner: null,
  ...over,
});
type Row = { id: string; set: string | null; visible: boolean };
const row = (id: string, s: string | null, visible = true): Row => ({ id, set: s, visible });
const group = (rows: Row[], sets: StructureSetInfo[]) => groupRows(rows, sets, (r) => r.set, (r) => r.visible);

describe('病例是否適用結構集（2026-09-24）', () => {
  it('後端有送就照送；舊後端沒送 → 有集才算', () => {
    expect(usesStructureSetsOf({ usesStructureSets: true, structureSets: [] })).toBe(true);
    expect(usesStructureSetsOf({ usesStructureSets: false, structureSets: [{}] })).toBe(false);
    expect(usesStructureSetsOf({ structureSets: [{}] })).toBe(true);
    expect(usesStructureSetsOf({ structureSets: [] })).toBe(false);
    expect(usesStructureSetsOf({})).toBe(false);
  });
});

describe('分層判定', () => {
  it('有集就分層（只剩一套也要有標題列：名稱與編輯／刪除／只看在上面）；零套且列沒有集 id 才平鋪', () => {
    expect(shouldGroup([set('1'), set('2')], ['1', '2'])).toBe(true);
    // 2026-09-24 回報的 bug：只剩一套時標題列消失
    expect(shouldGroup([set('1')], ['1', '1'])).toBe(true);
    expect(shouldGroup([set('1')], [])).toBe(true);
    expect(shouldGroup([set('1')], ['1', null])).toBe(true);
    expect(shouldGroup([], [null, null])).toBe(false);
    expect(shouldGroup([], ['orphan'])).toBe(true);
  });
  it('標題：label · 影像；相同就不重複', () => {
    expect(setTitle(set('1'))).toBe('RS_1 · CT 20260601');
    expect(setTitle(set('1', { label: 'CT 20260601' }))).toBe('CT 20260601');
    expect(setTitle(set('1', { label: '', imageLabel: '' }))).toBe('1.2.1');
  });
});

describe('工作集的預設名稱依介面語言顯示', () => {
  it('後端寫入的「<帳號> 的結構集」與空名稱 → 翻譯；改過的名稱照原樣；匯入集不動', async () => {
    const work = (label: string) => ({ kind: 'work' as const, owner: 'lin', label });
    expect(setLabel(work('lin 的結構集'))).toBe('lin 的結構集');
    await setLang('en');
    try {
      expect(setLabel(work('lin 的結構集'))).toBe("lin's structure set");
      expect(setLabel(work(''))).toBe("lin's structure set");
      expect(setLabel(work('Boost plan'))).toBe('Boost plan');
      expect(setLabel({ kind: 'import' as const, owner: null, label: 'RTstruct' })).toBe('RTstruct');
    } finally {
      await setLang('zh-TW');
    }
  });
});

describe('分組', () => {
  it('照 sets 順序、其他最後、可見計數；空的已知集仍列（讓人知道它一個 ROI 都沒有）', () => {
    const groups = group([row('b1', '2'), row('a1', '1'), row('a2', '1', false), row('n', null), row('x', 'unknown')], [set('1'), set('2'), set('3')]);
    expect(groups.map((g) => g.key)).toEqual(['1', '2', '3', OTHER_GROUP_KEY]);
    expect(groups[0]!.rows.map((r) => r.id)).toEqual(['a1', 'a2']);
    expect(groups[0]!.visibleCount).toBe(1);
    expect(groups[2]!.rows).toEqual([]);
    expect(groups[3]!.rows.map((r) => r.id)).toEqual(['n', 'x']);
    expect(groups[3]!.set).toBeNull();
  });
  it('沒有「其他」就不出現那一組', () => {
    expect(group([row('a', '1')], [set('1')]).map((g) => g.key)).toEqual(['1']);
  });
});

describe('新建結構的預設集', () => {
  it('目前編輯對象的集 → 同 FoR 的第一套 → 第一套 → null', () => {
    const sets = [set('1'), set('2')];
    expect(defaultSetFor(sets, '2', 'for.1')).toBe('2');
    expect(defaultSetFor(sets, 'gone', 'for.2')).toBe('2');
    expect(defaultSetFor(sets, null, 'for.9')).toBe('1');
    expect(defaultSetFor([], null, 'for.1')).toBeNull();
  });
});


describe('結構篩選（C2）', () => {
  type R = { name: string; visible: boolean; status: string; editable: boolean | undefined };
  const rows: R[] = [
    { name: 'BODY', visible: true, status: 'under_review', editable: false },
    { name: 'Parotid_L', visible: false, status: 'edited', editable: true },
    { name: 'parotid_r', visible: true, status: 'approved', editable: true },
  ];
  const pick = (r: R): R => r;
  it('文字不分大小寫；可編輯／待審／可見', () => {
    expect(filterRows(rows, { text: 'parotid', kind: 'all' }, pick).map((r) => r.name)).toEqual(['Parotid_L', 'parotid_r']);
    expect(filterRows(rows, { text: '', kind: 'mine' }, pick).map((r) => r.name)).toEqual(['Parotid_L', 'parotid_r']);
    expect(filterRows(rows, { text: '', kind: 'review' }, pick).map((r) => r.name)).toEqual(['BODY', 'Parotid_L']);
    expect(filterRows(rows, { text: '', kind: 'visible' }, pick).map((r) => r.name)).toEqual(['BODY', 'parotid_r']);
    expect(filterRows(rows, { text: 'x', kind: 'all' }, pick)).toEqual([]);
  });
});
