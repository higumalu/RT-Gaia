/** 頂列固定資訊的純邏輯（`headerModel.ts`）：病例摘要、編輯對象、保存狀態。 */

import { describe, expect, it } from 'vitest';

import type { FrameGroup, Layer } from '../src/core';
import type { StructureMeta, StructureSetInfo } from '../src/core/panels/api';
import { caseSummaryOf, editTargetOf, formatClock, onlineOthers, saveStatusOf } from '../src/react/components/headerModel';

const layer = (over: Partial<Layer>): Layer =>
  ({ layerId: 'image:a', kind: 'image', label: 'CT', groupId: null, frameOfReferenceUid: 'for.1', contentRef: 'a', visible: true, opacity: 1, order: 0, ...over });
const fg = (uid: string, role: 'primary' | 'secondary'): FrameGroup => ({ frameOfReferenceUid: uid, role }) as unknown as FrameGroup;
const set = (id: string, kind: 'import' | 'work', owner: string | null, label: string): StructureSetInfo => ({
  structureSetId: id, label, seriesInstanceUid: null, imageSeriesUid: '', imageLabel: '', frameOfReferenceUid: 'for.1', date: '', roiCount: 0, role: 'primary', kind, owner,
});
const st = (id: string, over: Partial<StructureMeta> = {}): StructureMeta => ({ structureId: id, status: 'under_review', volumeCc: 1, name: id, ...over });

describe('病例摘要', () => {
  it('PatientID · 日期 · 主要影像；次要影像數；不含姓名；假體 → null', () => {
    const layers = [
      layer({ layerId: 'image:cbct', frameOfReferenceUid: 'for.2', modality: 'CBCT', seriesMeta: { patient_id: 'P1', study_date: '20260504', series_description: 'iCBCT', patient_name: 'X' } }),
      layer({ layerId: 'image:ct', frameOfReferenceUid: 'for.1', modality: 'CT', seriesMeta: { patient_id: 'P1', study_date: '20260420', series_description: 'Pelvis 2.0' } }),
    ];
    const s = caseSummaryOf(layers, [fg('for.2', 'secondary'), fg('for.1', 'primary')]);
    expect(s?.text).toBe('P1 · 2026-04-20 · CT Pelvis 2.0');
    expect(s?.secondaryCount).toBe(1);
    expect(JSON.stringify(s)).not.toContain('X');
    expect(caseSummaryOf([layer({})], [fg('for.1', 'primary')])).toBeNull();
  });
});

describe('編輯對象', () => {
  const sets = [set('imp', 'import', null, 'CT_20260601'), set('mine', 'work', 'wang', 'wang 的結構集'), set('lin', 'work', 'lin', 'lin 的結構集')];
  it('沒選、可改、唯讀三種文案；唯讀可合併', () => {
    expect(editTargetOf([], sets, null, 'wang').text).toBe('沒有選取結構');
    const structures = [
      st('a', { name: 'PTV', structureSetId: 'mine', editable: true, structureSetKind: 'work', structureSetOwner: 'wang' }),
      st('b', { name: 'BODY', structureSetId: 'imp', editable: false, structureSetKind: 'import' }),
      st('c', { name: 'GTV', structureSetId: 'lin', editable: false, structureSetKind: 'work', structureSetOwner: 'lin' }),
      st('d', { name: 'Old', structureSetId: 'mine', status: 'approved', editable: true }),
    ];
    expect(editTargetOf(structures, sets, 'a', 'wang')).toMatchObject({ kind: 'editable', text: '編輯中：我的結構集／PTV' });
    const b = editTargetOf(structures, sets, 'b', 'wang');
    expect(b).toMatchObject({ kind: 'readonly', text: '唯讀：CT_20260601／BODY', mergeable: true });
    expect(b.reason).toMatch(/匯入/);
    expect(editTargetOf(structures, sets, 'c', 'wang').text).toBe('唯讀：lin 的結構集／GTV');
    const d = editTargetOf(structures, sets, 'd', 'wang');
    expect(d.kind).toBe('readonly');
    expect(d.reason).toMatch(/簽核/);
    expect(d.mergeable).toBe(false);
  });
});

describe('保存狀態', () => {
  const failure = { structureId: 'PTV', frameIndex: null, pending: null, retries: 3 };
  it('失敗優先；載入中；儲存中；已保存 HH:MM；已同步', () => {
    expect(saveStatusOf({ loading: false, editsFlushed: false, failures: [failure], lastSavedAt: 1 })).toMatchObject({ kind: 'failed', text: '保存失敗 1 筆' });
    expect(saveStatusOf({ loading: false, editsFlushed: false, failures: [failure], lastSavedAt: 1 }).detail).toContain('PTV');
    expect(saveStatusOf({ loading: true, editsFlushed: true, failures: [], lastSavedAt: null }).kind).toBe('loading');
    expect(saveStatusOf({ loading: false, editsFlushed: false, failures: [], lastSavedAt: null }).kind).toBe('syncing');
    const at = new Date(2026, 8, 15, 14, 2).getTime();
    expect(saveStatusOf({ loading: false, editsFlushed: true, failures: [], lastSavedAt: at })).toMatchObject({ kind: 'saved', text: `已保存 ${formatClock(at)}` });
    expect(formatClock(at)).toBe('14:02');
    expect(saveStatusOf({ loading: false, editsFlushed: true, failures: [], lastSavedAt: null }).kind).toBe('idle');
  });
  it('其他在線人數', () => {
    expect(onlineOthers([{ user: 'wang', sessionId: '1', connections: 1, createdAt: '' }, { user: 'lin', sessionId: '2', connections: 1, createdAt: '' }, { user: 'lin', sessionId: '3', connections: 0, createdAt: '' }], 'wang')).toBe(1);
  });
});
