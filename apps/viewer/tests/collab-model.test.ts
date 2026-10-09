/** 多人「各自新增、可合併」的純邏輯（`src/react/collab/model.ts`）。 */

import { describe, expect, it } from 'vitest';

import type { PresenceUser, StructureMeta, StructureSetInfo } from '../src/core/panels/api';
import { defaultExportSelection, defaultResolutions, isMine, isOnline, lockedEntries, mergeCandidates, onlineUsers, readOnlyReason, replaceAllowed, setBadge, summarizeMerge } from '../src/react/collab/model';

const set = (kind: 'import' | 'work' | 'transient', owner: string | null): StructureSetInfo => ({
  structureSetId: `${kind}:${owner ?? 'rs'}`,
  label: 'x',
  seriesInstanceUid: null,
  imageSeriesUid: '',
  imageLabel: '',
  frameOfReferenceUid: 'for',
  date: '',
  roiCount: 0,
  role: kind === 'work' ? 'work' : 'primary',
  kind,
  owner,
});
const st = (id: string, over: Partial<StructureMeta> = {}): StructureMeta => ({ structureId: id, status: 'under_review', volumeCc: 1, name: id, ...over });

describe('集的身分', () => {
  it('我的／匯入／他人 徽章', () => {
    expect(isMine(set('work', 'wang'), 'wang')).toBe(true);
    expect(isMine(set('work', 'wang'), 'lin')).toBe(false);
    expect(isMine(set('import', null), 'wang')).toBe(false);
    expect(setBadge(set('import', null), 'wang')).toEqual({ text: '匯入', tone: 'import' });
    // plugin 結果（暫存集）不是匯入的
    expect(setBadge(set('transient', 'wang'), 'wang')).toEqual({ text: '未儲存', tone: 'mine' });
    expect(setBadge(set('work', 'wang'), 'wang')).toEqual({ text: '我的', tone: 'mine' });
    expect(setBadge(set('work', 'lin'), 'wang')).toEqual({ text: 'lin', tone: 'other' });
  });
});

describe('唯讀原因與鎖', () => {
  it('已簽核優先；匯入集；別人的；可改 → null', () => {
    expect(readOnlyReason(st('a', { status: 'approved', editable: true }))).toMatch(/簽核/);
    expect(readOnlyReason(st('a', { editable: false, structureSetKind: 'import' }))).toMatch(/匯入的結構集唯讀/);
    expect(readOnlyReason(st('a', { editable: false, structureSetKind: 'work', structureSetOwner: 'lin' }))).toMatch(/lin 的結構集/);
    expect(readOnlyReason(st('a', { editable: true }))).toBeNull();
    expect(readOnlyReason(st('a'))).toBeNull(); // 舊後端沒有 editable → 可改
    const locks = lockedEntries([st('a', { status: 'approved' }), st('b', { editable: false, structureSetKind: 'import' }), st('c', { editable: true })]);
    expect(locks.map((l) => l.structureId)).toEqual(['a', 'b']);
  });
});

describe('合併', () => {
  it('預設覆蓋；候選＝來源集的結構；摘要', () => {
    expect(defaultResolutions([{ structure_id: 'x', name: 'BODY', existing_structure_id: 'y' }])).toEqual({ x: 'replace' });
    // 目標已簽核：不能覆蓋（後端 409 APPROVED_LOCKED）→ 預設改名
    expect(defaultResolutions([{ structure_id: 'x', name: 'BODY', existing_structure_id: 'y', existing_status: 'approved' }])).toEqual({ x: 'rename' });
    expect(replaceAllowed({ existing_status: 'approved' })).toBe(false);
    expect(replaceAllowed({ existing_status: 'edited' })).toBe(true);
    expect(replaceAllowed({})).toBe(true);
    const structures = [st('a', { structureSetId: 's1' }), st('b', { structureSetId: 's2' }), st('c', { structureSetId: 's1' })];
    expect(mergeCandidates(structures, 's1').map((s) => s.structureId)).toEqual(['a', 'c']);
    expect(summarizeMerge([{ action: 'add' }, { action: 'add' }, { action: 'replace' }, { action: 'skip' }, { action: 'already' }])).toBe('新增 2 · 覆蓋 1 · 跳過 1 · 已在我的集 1');
    expect(summarizeMerge([])).toBe('（沒有變更）');
  });
});

describe('presence 與匯出預設', () => {
  const presence: PresenceUser[] = [
    { user: 'wang', sessionId: '1', connections: 1, createdAt: '' },
    { user: 'lin', sessionId: '2', connections: 0, createdAt: '' },
    { user: 'wang', sessionId: '3', connections: 2, createdAt: '' },
    { user: 'chen', sessionId: '4', connections: 1, createdAt: '' },
  ];
  it('在線＝有連線，去重排序；可排除自己', () => {
    expect(onlineUsers(presence)).toEqual(['chen', 'wang']);
    expect(onlineUsers(presence, 'wang')).toEqual(['chen']);
    expect(isOnline(presence, 'lin')).toBe(false);
    expect(isOnline(presence, 'wang')).toBe(true);
  });
  it('匯出預設：我的工作集 → 只選我的；沒有 → 舊規則', () => {
    const structures = [
      st('imp', { structureSetKind: 'import', status: 'approved' }),
      st('mine1', { structureSetKind: 'work', structureSetOwner: 'wang' }),
      st('lin1', { structureSetKind: 'work', structureSetOwner: 'lin' }),
    ];
    expect([...defaultExportSelection(structures, 'wang')]).toEqual(['mine1']);
    expect([...defaultExportSelection(structures, 'chen')]).toEqual(['imp']); // 沒有我的 → 已簽核
    expect([...defaultExportSelection([st('a'), st('b')], 'chen')]).toEqual(['a', 'b']);
  });
});
