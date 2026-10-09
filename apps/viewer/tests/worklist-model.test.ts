/** 工作清單純邏輯。 */
import { describe, expect, it } from 'vitest';

import type { WorklistCase } from '../src/react/data/catalogApi';
import { caseByStudy, countsText, filterWorklist, sortWorklist } from '../src/react/data/worklist';

const base = (over: Partial<WorklistCase>): WorklistCase => ({
  case_id: 'c', study_id: 's', source: '', description: '', selection: {}, created_by: 'dr', created_at: null, updated_at: '2026-09-24T10:00',
  status: 'in_progress', counts: { work_total: 1, approved: 0, under_review: 0, edited: 0, rejected: 0, import_total: 2 },
  last_export_at: null, open_users: [], patient_id: 'P1', study_date: '20260924', study_description: '', ...over,
});

describe('worklist model', () => {
  it('篩選狀態與「與我有關」；排序最近更新在前', () => {
    const a = base({ case_id: 'a', status: 'review', updated_at: '2026-09-24T09:00', created_by: 'x', counts: { ...base({}).counts, work_total: 0 } });
    const b = base({ case_id: 'b', status: 'approved', updated_at: '2026-09-24T11:00' });
    const c = base({ case_id: 'c', status: 'none', created_by: 'x', open_users: ['dr'], counts: { ...base({}).counts, work_total: 0 } });
    expect(sortWorklist([a, b, c]).map((x) => x.case_id)).toEqual(['b', 'c', 'a']);
    expect(filterWorklist([a, b, c], 'approved', null).map((x) => x.case_id)).toEqual(['b']);
    expect(filterWorklist([a, b, c], 'all', 'dr').map((x) => x.case_id)).toEqual(['b', 'c']); // a：別人建、沒工作結構、我不在線
  });
  it('同一 study 多病例取狀態最靠前的；計數文字', () => {
    const m = caseByStudy([base({ case_id: '1', status: 'in_progress' }), base({ case_id: '2', status: 'approved' }), base({ case_id: '3', study_id: null })]);
    expect(m.get('s')?.case_id).toBe('2');
    expect(countsText(base({ counts: { work_total: 0, approved: 0, under_review: 0, edited: 0, rejected: 0, import_total: 3 } }))).toBe('3 個匯入結構');
    expect(countsText(base({ counts: { work_total: 4, approved: 2, under_review: 1, edited: 0, rejected: 0, import_total: 0 } }))).toBe('4 個工作結構、2 已簽核、1 待審');
  });
});
