/** 匯出模組的純邏輯：預設選取、草稿警示、body、摘要。 */

import { describe, expect, it } from 'vitest';

import type { FrameGroup, Layer, StructureMeta } from '../src/core';
import { defaultSelection, exportBody, exportSummary, exportTargets, hasUnapproved, isTerminal, phaseLabel, summarizeJob, tagProblems } from '../src/react/modules/export/model';

const s = (id: string, status: string): StructureMeta => ({ structureId: id, status, volumeCc: 1, name: id });

describe('選取', () => {
  it('有已簽核只選已簽核；沒有就全選', () => {
    expect([...defaultSelection([s('a', 'approved'), s('b', 'edited')])]).toEqual(['a']);
    expect([...defaultSelection([s('a', 'edited'), s('b', 'edited')])]).toEqual(['a', 'b']);
    expect(hasUnapproved([s('a', 'approved'), s('b', 'edited')], new Set(['a']))).toBe(false);
    expect(hasUnapproved([s('a', 'approved'), s('b', 'edited')], new Set(['a', 'b']))).toBe(true);
  });
  it('body', () => {
    expect(exportBody(new Set(['a']), 'for.1')).toEqual({ format: 'rtstruct', structure_ids: ['a'], anonymize: true, target_frame_of_reference_uid: 'for.1' });
    expect(exportBody(new Set(), null)).toEqual({ format: 'rtstruct', structure_ids: [], anonymize: true });
    expect(exportBody(new Set(['a']), null, false)).toEqual({ format: 'rtstruct', structure_ids: ['a'], anonymize: false });
    // 標籤（空的不送、去頭尾空白）與存入資料庫
    expect(exportBody(new Set(['a']), null, { anonymize: true, tags: { StructureSetLabel: ' v2 ', SeriesDescription: '' }, saveToLibrary: true })).toEqual({
      format: 'rtstruct',
      structure_ids: ['a'],
      anonymize: true,
      tags: { StructureSetLabel: 'v2' },
      save_to_library: true,
    });
  });
  it('標籤本機檢查', () => {
    const wl = [
      { keyword: 'StructureSetLabel', vr: 'SH', max_length: 16, phi: false },
      { keyword: 'PatientBirthDate', vr: 'DA', max_length: 8, phi: true },
      { keyword: 'PatientSex', vr: 'CS', max_length: 1, phi: true },
      { keyword: 'SeriesNumber', vr: 'IS', max_length: 12, phi: false },
    ];
    expect(tagProblems({ StructureSetLabel: 'ok', PatientBirthDate: '', PatientSex: 'f', SeriesNumber: '7' }, wl)).toEqual([]);
    expect(tagProblems({ StructureSetLabel: 'x'.repeat(17) }, wl)).toEqual(['結構集標籤（Label） 最多 16 個字元']);
    expect(tagProblems({ PatientBirthDate: '2026-01-01' }, wl)).toEqual(['出生日期（YYYYMMDD） 要 YYYYMMDD']);
    expect(tagProblems({ PatientSex: 'X' }, wl)).toEqual(['性別（M／F／O） 只能是 M／F／O']);
    expect(tagProblems({ SeriesNumber: 'a' }, wl)).toEqual(['序列號 要整數']);
    expect(tagProblems({ Manufacturer: 'x' }, wl)).toEqual(['Manufacturer 不在可改的標籤清單']);
  });
});

describe('job 文案', () => {
  it('摘要與階段', () => {
    expect(summarizeJob({ job_id: 'j', status: 'done', phase: 'done', percent: 100, structure_count: 3, contour_count: 412, bytes: 1_200_000, skipped: [{ structure_id: 'x', reason: 'not_in_target_frame' }] })).toBe(
      '3 個結構 · 412 條輪廓 · 1.2 MB · 跳過 1',
    );
    expect(summarizeJob({ job_id: 'j', status: 'failed', phase: 'failed', percent: 50, error: 'boom' })).toBe('boom');
    expect(summarizeJob({ job_id: 'j', status: 'done', phase: 'done', percent: 100, structure_count: 1, anonymized: true })).toBe('1 個結構 · 匿名');
    expect(summarizeJob({ job_id: 'j', status: 'done', phase: 'done', percent: 100, structure_count: 1, anonymized: false, patient_id: 'P1' })).toBe('1 個結構 · 含病人識別（P1）');
    expect(summarizeJob({ job_id: 'j', status: 'done', phase: 'done', percent: 100, structure_count: 1, structure_set_label: 'V1', anonymized: false, saved_to_library: true })).toBe('1 個結構 · 「V1」 · 含病人識別 · 已存入資料庫');
    expect(phaseLabel('extract_contours')).toBe('重抽輪廓');
    expect(isTerminal('running')).toBe(false);
    expect(isTerminal('failed')).toBe(true);
  });

  it('英文介面的進度階段是英文（以前直接回翻譯 key，顯示「完成 100%」）', async () => {
    const { setLang } = await import('../src/core/i18n');
    await setLang('en');
    try {
      expect(phaseLabel('done')).toBe('Done');
      expect(phaseLabel('extract_contours')).toBe('Extracting contours');
      expect(phaseLabel('mystery')).toBe('mystery');
    } finally {
      await setLang('zh-TW');
    }
  });
});


describe('執行前摘要', () => {
  it('與 payload 一致：目的、識別、草稿、標籤', () => {
    expect(exportSummary({ count: 3, targetLabel: '主要影像', draftCount: 2, purpose: 'download', anonymize: true, tagCount: 0 })).toBe('3 個結構 · 目標 主要影像 · 含 2 個草稿 · 匿名 · 下載檔案');
    expect(exportSummary({ count: 1, targetLabel: null, draftCount: 0, purpose: 'library', anonymize: true, tagCount: 2 })).toBe('1 個結構 · 含病人識別 · 存入資料庫 · 改 2 個標籤');
    expect(exportSummary({ count: 1, targetLabel: null, draftCount: 0, purpose: 'download', anonymize: false, tagCount: 0 })).toBe('1 個結構 · 含病人識別 · 下載檔案');
  });
});

describe('匯出 profile', () => {
  it('exportBody 帶 profile；沒選就不送（用後端預設）；改動描述', async () => {
    const { exportBody, describeProfileWarning } = await import('../src/react/modules/export/model');
    expect(exportBody(new Set(['a']), null, { anonymize: true, profile: 'varian' })['profile']).toBe('varian');
    expect('profile' in exportBody(new Set(['a']), null, { anonymize: true })).toBe(false);
    expect(describeProfileWarning({ field: 'ROIName', from: 'Parotid_Left_Superficial', to: 'Parotid_Left_Sup', reason: '超過 16 字元' })).toBe(
      'ROI 名稱 Parotid_Left_Superficial → Parotid_Left_Sup：超過 16 字元',
    );
  });
});

describe('匯出目標以影像名稱呈現', () => {
  const img = (id: string, forUid: string, modality: string, date: string, desc: string, order = 0): Layer =>
    ({
      layerId: id,
      kind: 'image',
      label: id,
      groupId: null,
      frameOfReferenceUid: forUid,
      contentRef: id,
      visible: true,
      opacity: 1,
      order,
      blendMode: 'normal',
      temporalGroupId: null,
      modality,
      seriesMeta: { series_date: date, series_description: desc },
    }) as unknown as Layer;
  const fg = (uid: string, role: 'primary' | 'secondary'): FrameGroup => ({ frameOfReferenceUid: uid, role }) as unknown as FrameGroup;

  it('模態＋日期＋描述；主要影像標（主要）；FoR 放 detail', () => {
    const targets = exportTargets(
      [img('ct', '1.2.3.PLAN', 'CT', '20260612', 'Pelvis 3.0'), img('cb', '1.2.3.CBCT17', 'CBCT', '20260617', 'ART_Pelvic')],
      [fg('1.2.3.PLAN', 'primary'), fg('1.2.3.CBCT17', 'secondary')],
    );
    expect(targets.map((x) => x.label)).toEqual(['CT 2026-06-12 Pelvis 3.0（主要）', 'CBCT 2026-06-17 ART_Pelvic']);
    expect(targets[1]!.detail).toBe('FoR 1.2.3.CBCT17');
  });

  it('同名（同一天、同描述的兩個 CBCT）才補 FoR 尾碼', () => {
    const targets = exportTargets(
      [img('a', 'for.aaaaaa111111', 'CBCT', '20260617', 'ART'), img('b', 'for.bbbbbb222222', 'CBCT', '20260617', 'ART')],
      [fg('for.aaaaaa111111', 'secondary'), fg('for.bbbbbb222222', 'secondary')],
    );
    expect(targets.map((x) => x.label)).toEqual(['CBCT 2026-06-17 ART …111111', 'CBCT 2026-06-17 ART …222222']);
  });
});
