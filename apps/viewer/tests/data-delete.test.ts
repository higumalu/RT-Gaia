/** 2026-09-15 —— 資料頁「從資料庫移除」的文案。 */

import { describe, expect, it } from 'vitest';

import { describeAffected, describeDeleteTarget } from '../src/react/data/deleteModel';

describe('移除文案', () => {
  it('層級與數量', () => {
    expect(describeDeleteTarget({ level: 'patients', id: 'P1', label: 'x', seriesCount: 9 })).toBe('整位病人（9 個序列）');
    expect(describeDeleteTarget({ level: 'studies', id: 's', label: 'x', seriesCount: 5 })).toBe('整個 study（5 個序列）');
    expect(describeDeleteTarget({ level: 'series', id: 's', label: 'x', instanceCount: 187 })).toBe('這個序列（187 檔）');
    expect(describeDeleteTarget({ level: 'series', id: 's', label: 'x' })).toBe('這個序列');
  });
  it('受影響病例：最多列三個、說明後果', () => {
    expect(describeAffected([])).toBe('');
    const text = describeAffected([
      { case_id: 'c1', description: 'DICOM 病例 A', series_uids: ['1'] },
      { case_id: 'c2', description: '', series_uids: ['1'] },
      { case_id: 'c3', description: 'C', series_uids: ['1'] },
      { case_id: 'c4', description: 'D', series_uids: ['1'] },
    ]);
    expect(text).toContain('4 個病例');
    expect(text).toContain('DICOM 病例 A；c2；C…');
    expect(text).toContain('打不開');
  });
});
