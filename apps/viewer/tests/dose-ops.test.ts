/**
 * 劑量運算 —— 表單邏輯（k、預覽、能不能按）、存檔 body、差值劑量的顯示（發散色階、±Gy 等劑量線、|值| 截止）、
 * DVH 排除差值、匯出紀錄的 RTDOSE 摘要。
 */

import { describe, expect, it } from 'vitest';

import type { Layer } from '../src/core/layers/types';
import { getColormap, registerBuiltinColormaps } from '../src/core/raster/colormaps';
import { autoDiffLevelsGy, AUTO_DIFF_MAX_LINES_PER_SIDE, doseDisplayOf, isodoseColor } from '../src/core/raster/doseModule';
import { formProblem, parseK, previewText, saveBody, sourceOptionText, summaryText, type DoseOpSource } from '../src/react/modules/doseops/model';
import { canDvh, dvhSelection, isSignedDose, noDvhReason } from '../src/react/modules/dvh/model';
import { recordSummary, type ExportRecord } from '../src/react/modules/export/exportRecords';
import { fmtLevelGy } from '../src/react/panels/doseLevels';

registerBuiltinColormaps();

const dose = (params: Record<string, unknown>, id = 'd'): Layer =>
  ({ layerId: `dose:${id}`, kind: 'dose', contentRef: id, visible: true, opacity: 0.5, params }) as unknown as Layer;

const src = (over: Partial<DoseOpSource>): DoseOpSource => ({
  series_id: 'a',
  label: 'plan_0',
  frame_of_reference_uid: 'F',
  max_gy: 22.17,
  min_gy: 0,
  units: 'GY',
  dose_type: 'PHYSICAL',
  summation_type: 'PLAN',
  registration: { kind: 'primary', matrix_type: null },
  fractions_planned: 10,
  plan_label: 'ART1',
  derived: false,
  eligible: true,
  problems: [],
  notes: [],
  ...over,
});

describe('劑量運算表單', () => {
  it('k：正的有限數、≤ 1000', () => {
    expect(parseK('10')).toEqual([10, null]);
    expect(parseK('0.5')).toEqual([0.5, null]);
    expect(parseK('0')[1]).toMatch(/正數/);
    expect(parseK('-2')[1]).toMatch(/正數/);
    expect(parseK('abc')[1]).toMatch(/數字/);
    expect(parseK('')[1]).toMatch(/數字/);
    expect(parseK('5000')[1]).toMatch(/1000/);
  });

  it('預覽式子與能不能按', () => {
    const a = src({});
    const b = src({ series_id: 'b', label: 'fx_1' });
    const sum = src({ series_id: 's', label: 'fx_1 + fx_2', derived: true });
    expect(previewText(a, 'add', b, '')).toBe('plan_0 + fx_1');
    expect(previewText(sum, 'mul', undefined, '5')).toBe('(fx_1 + fx_2) × 5');
    expect(previewText(undefined, 'sub', undefined, '')).toBe('A − B');
    expect(formProblem(a, 'add', b, '')).toBeNull();
    expect(formProblem(a, 'add', a, '')).toMatch(/同一個/);
    expect(formProblem(a, 'mul', undefined, '')).toMatch(/數字/);
    expect(formProblem(a, 'mul', undefined, '10')).toBeNull();
    expect(formProblem(src({ eligible: false, problems: ['沒有對位'] }), 'mul', undefined, '2')).toBe('沒有對位');
  });

  it('下拉選單文字帶 Dmax、分次數、差值範圍', () => {
    expect(sourceOptionText(src({}))).toBe('plan_0 · Dmax 22.17 Gy · 10 次');
    expect(sourceOptionText(src({ min_gy: -1.5, max_gy: 2, fractions_planned: null, derived: true }))).toBe('plan_0 · -1.50 … 2.00 Gy · 暫存結果');
  });

  it('結果摘要', () => {
    expect(summaryText({ signed: false, summary: { max_gy: 44.34, min_gy: 0, mean_gy: 3.1, covered_fraction: 0.87 } })).toBe('Dmax 44.34 Gy · 平均 3.10 Gy · 有資料 87%');
    expect(summaryText({ signed: true, summary: { max_gy: 1, min_gy: -2.24, mean_gy: null, covered_fraction: 1 } })).toBe('-2.24 … 1.00 Gy');
  });

  it('存檔 body：存入資料庫一律帶識別；PHYSICAL 帶確認；空標籤不送', () => {
    expect(saveBody({ purpose: 'download', anonymize: true, tags: { SeriesDescription: ' ', InstitutionName: ' Clinic A ' }, physical: false, confirmPhysical: false })).toEqual({
      purpose: 'download',
      anonymize: true,
      tags: { InstitutionName: 'Clinic A' },
    });
    expect(saveBody({ purpose: 'library', anonymize: true, tags: {}, physical: true, confirmPhysical: true })).toEqual({
      purpose: 'library',
      anonymize: false,
      dose_type: 'PHYSICAL',
      confirm_physical: true,
    });
  });
});

describe('差值劑量的顯示', () => {
  it('±Gy 等距、每邊 ≤ 5 條、0 不畫', () => {
    const levels = autoDiffLevelsGy(2.24);
    expect(levels).toEqual([2, 1.5, 1, 0.5, -0.5, -1, -1.5, -2]);
    expect(levels.filter((g) => g > 0).length).toBeLessThanOrEqual(AUTO_DIFF_MAX_LINES_PER_SIDE);
    expect(autoDiffLevelsGy(0)).toEqual([]);
  });

  it('min < 0 → signed：發散色階、對稱範圍、絕對值顯示、閾值 10% |max|', () => {
    const d = doseDisplayOf(dose({ max_gy: 1, min_gy: -2.24, units: 'GY', display: 'percent' }));
    expect(d.signed).toBe(true);
    expect(d.colormap).toBe('diverging');
    expect(d.display).toBe('absolute');
    expect(d.scaleMaxGy).toBeCloseTo(2.24);
    expect(d.thresholdGy).toBeCloseTo(0.224);
    expect(d.levelsGy.some((g) => g < 0)).toBe(true);
    // 0 Gy 落在色階正中間（白）；負的偏藍、正的偏紅
    const lut = getColormap('diverging');
    expect([lut[128 * 3], lut[128 * 3 + 1], lut[128 * 3 + 2]].every((v) => v! > 230)).toBe(true);
    const neg = isodoseColor(d, -2);
    const pos = isodoseColor(d, 2);
    expect(neg[2]).toBeGreaterThan(neg[0]);
    expect(pos[0]).toBeGreaterThan(pos[2]);
  });

  it('自己設的 level 可以是負的', () => {
    const d = doseDisplayOf(dose({ max_gy: 1, min_gy: -2, levels: [-1, 0, 0.5] }));
    expect(d.levelsGy).toEqual([0.5, -1]);
    expect(d.levelSource).toBe('custom');
    expect(fmtLevelGy(-0.25)).toBe('-0.25');
    expect(fmtLevelGy(-1.25)).toBe('-1.3');
  });

  it('一般劑量不受影響', () => {
    const d = doseDisplayOf(dose({ max_gy: 22.17, min_gy: 0, prescription_gy: [20] }));
    expect(d.signed).toBe(false);
    expect(d.colormap).toBe('jet');
    expect(d.levelsGy.every((g) => g > 0)).toBe(true);
  });
});

describe('DVH 排除差值', () => {
  it('signed 的劑量不能進 DVH、預設選取也跳過', () => {
    const diff = dose({ units: 'GY', min_gy: -1, max_gy: 1 }, 'diff');
    const plan = dose({ units: 'GY', min_gy: 0, max_gy: 20 }, 'plan');
    expect(isSignedDose(diff)).toBe(true);
    expect(canDvh(diff)).toBe(false);
    expect(canDvh(plan)).toBe(true);
    expect(noDvhReason(diff)).toMatch(/差值/);
    expect(dvhSelection([diff, plan] as never, undefined).doseIds).toEqual(['plan']);
  });
});

describe('匯出紀錄', () => {
  it('rtdose 紀錄的摘要是運算式', () => {
    const r = {
      export_id: 'j',
      case_id: 'c',
      kind: 'rtdose',
      target: 'library',
      status: 'done',
      requested_by: 'wang',
      requested_at: '',
      finished_at: null,
      patient_ids: [],
      node_id: null,
      node_label: null,
      label: '(fx_1 + fx_2) × 5',
      version_ids: {},
      sop_uids_out: [],
      series_uids: [],
      blob_sha256: null,
      profile: null,
      anonymized: false,
      source_export_id: null,
      resend_of: null,
      error: null,
      counts: {},
      download_url: null,
      resendable: true,
    } as unknown as ExportRecord;
    expect(recordSummary(r)).toBe('RTDOSE（劑量運算）「(fx_1 + fx_2) × 5」');
  });
});

describe('同一個空間才能運算、套用 REG', () => {
  it('B 只能選同一個空間的；跨空間 → 先套用 REG', async () => {
    const { sameSpaceOperands, transformText } = await import('../src/react/modules/doseops/model');
    const plan = src({ series_id: 'plan', frame_of_reference_uid: 'CT' });
    const moved = src({ series_id: 'fx1ct', frame_of_reference_uid: 'CT', derived: true });
    const fx1 = src({ series_id: 'fx1', frame_of_reference_uid: 'CB1' });
    expect(sameSpaceOperands(plan, [plan, moved, fx1]).map((s) => s.series_id)).toEqual(['fx1ct']);
    expect(formProblem(plan, 'add', fx1, '')).toMatch(/空間/);
    expect(formProblem(plan, 'add', moved, '')).toBeNull();
    const base = { transform_id: 'x', reg_id: 'r', sop_instance_uid: 's', label: '', matrix_type: 'RIGID', target_frame_of_reference_uid: 'CT', target_label: 'CT 2026-06-12（主要）', problem: null };
    expect(transformText({ ...base, kind: 'REG', series_date: '20260617', inverse: false })).toBe('REG 2026-06-17 → CT 2026-06-12（主要）');
    expect(transformText({ ...base, kind: 'REG', series_date: '20260617', inverse: true })).toBe('REG 2026-06-17 → CT 2026-06-12（主要）（反向）');
    expect(transformText({ ...base, kind: 'current', series_date: null, inverse: false })).toBe('目前的對位 → CT 2026-06-12（主要）');
  });
});

describe('色階範圍（差值要能調 color bar 的上下界）', () => {
  it('差值：預設 ±max|值|；設了範圍 → 0 仍在中間、超出飽和、可以不對稱；自動等劑量線跟著範圍', async () => {
    const { doseColorFraction } = await import('../src/core/raster/doseModule');
    const d0 = doseDisplayOf(dose({ max_gy: 2.13, min_gy: -2.14 }));
    expect([d0.rangeLoGy, d0.rangeHiGy, d0.rangeCustom]).toEqual([-2.14, 2.14, false]);
    const d = doseDisplayOf(dose({ max_gy: 2.13, min_gy: -2.14, range_lo_gy: -0.1, range_hi_gy: 0.05 }));
    expect([d.rangeLoGy, d.rangeHiGy, d.rangeCustom]).toEqual([-0.1, 0.05, true]);
    expect(doseColorFraction(d, 0)).toBe(0.5);
    expect(doseColorFraction(d, -0.05)).toBeCloseTo(0.25);
    expect(doseColorFraction(d, 0.025)).toBeCloseTo(0.75);
    expect(doseColorFraction(d, 2)).toBe(1);
    expect(doseColorFraction(d, -2)).toBe(0);
    expect(d.thresholdGy).toBeCloseTo(0.01); // 閾值預設 ＝ 範圍的 10%
    expect(d.levelsGy.every((g) => g >= -0.1 && g <= 0.05)).toBe(true);
    expect(d.levelsGy.length).toBeGreaterThan(2);
    // 下界 ≥ 0 或上界 ≤ 0（不包住 0）不接受 → 用預設那一邊
    const bad = doseDisplayOf(dose({ max_gy: 1, min_gy: -1, range_lo_gy: 0.5, range_hi_gy: -0.5 }));
    expect([bad.rangeLoGy, bad.rangeHiGy]).toEqual([-1, 1]);
  });

  it('一般劑量：下界 … 上界；預設 0 … 最大值', async () => {
    const { doseColorFraction } = await import('../src/core/raster/doseModule');
    const d = doseDisplayOf(dose({ max_gy: 20, min_gy: 0, range_lo_gy: 10, range_hi_gy: 15 }));
    expect([d.rangeLoGy, d.rangeHiGy]).toEqual([10, 15]);
    expect(doseColorFraction(d, 12.5)).toBeCloseTo(0.5);
    expect(doseColorFraction(d, 5)).toBe(0);
    expect(doseDisplayOf(dose({ max_gy: 20, min_gy: 0 })).rangeHiGy).toBe(20);
  });

  it('色階條的標籤；小數字不會四捨五入成 0', async () => {
    const { colorBar } = await import('../src/react/panels/DoseLegend');
    const bar = colorBar(doseDisplayOf(dose({ max_gy: 1, min_gy: -1, range_lo_gy: -0.08, range_hi_gy: 0.08 })));
    expect(bar.labels.map((l) => l.text)).toEqual(['-0.08', '0', '0.08 Gy']);
    expect(bar.labels[1]!.pos).toBeCloseTo(0.5);
    expect(fmtLevelGy(0.001)).toBe('0.001');
    expect(fmtLevelGy(-0.0125)).toBe('-0.013');
    expect(fmtLevelGy(0)).toBe('0');
  });
});
