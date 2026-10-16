/** 重算劑量（計畫面板）—— 工作排序與篩選、狀態文字、送出前後的條件說明。 */

import { describe, expect, it } from 'vitest';

import { historyPresets, isActive, jobsForPlan, jobStatusText, sensitivityNotes, summaryNotes, tpsDvhDoseIds, tpsGammaBody, uncertaintyNotes, type DosecalcJob, type DosecalcSummary } from '../src/react/modules/plan/dosecalcModel';

const summary: DosecalcSummary = {
  plan_sop_uid: 'P',
  plan_label: 'SYNTH',
  beams: [{ number: 1, name: 'AP', mu: 200, control_points: 2 }],
  fractions: 2,
  total_mu: 200,
  calibration: { name: 'Schneider 2000', demo: true },
  calibration_fallback: true,
  calibration_reason: '沒有符合的曲線',
  beam_model: { model_id: 'demo-6x', name: 'Demo 6X', demo: true },
  dose_grid: 'tps',
  dose_grid_voxels: 123456,
  engine: 'geant4',
};
const job = (over: Partial<DosecalcJob>): DosecalcJob => ({ job_id: 'j', status: 'done', phase: 'done', percent: 100, error: null, requested_by: 'dr', requested_at: '2026-10-12T10:00:00', finished_at: null, summary, loaded: [], ...over });

describe('重算劑量', () => {
  it('只列這份計畫的工作、最新的在前', () => {
    const jobs = [job({ job_id: 'a', requested_at: '2026-10-12T09:00:00' }), job({ job_id: 'b' }), job({ job_id: 'c', summary: { ...summary, plan_sop_uid: 'Q' } })];
    expect(jobsForPlan(jobs, 'P').map((j) => j.job_id)).toEqual(['b', 'a']);
  });
  it('狀態文字', () => {
    expect(isActive(job({ status: 'running' }))).toBe(true);
    expect(jobStatusText(job({ status: 'running', percent: 42 }))).toContain('42');
    expect(jobStatusText(job({ status: 'failed', error: 'cancelled' }))).toBe('已取消');
    expect(jobStatusText(job({ status: 'failed', error: 'boom' }))).toContain('boom');
    expect(jobStatusText(job({ dosecalc: { engine: 'geant4', seconds: 12.34, histories: 1 } }))).toContain('12.3');
  });
  it('條件說明：示範模型、通用曲線的原因、網格、分次', () => {
    const notes = summaryNotes(summary);
    expect(notes[0]).toContain('示範用');
    expect(notes[1]).toContain('沒有符合的曲線');
    expect(notes[2]).toContain('TPS');
    expect(notes[3]).toContain('2 次');
    const coarse = summaryNotes({ ...summary, calc_spacing_mm: 4 });
    expect(coarse[3]).toContain('4 mm');
    expect(coarse[4]).toContain('2 次');
  });
  it('統計不確定度：中位數與最大；超過 3% 提醒雜訊', () => {
    const done = (median: number) => job({ dosecalc: { engine: 'topas', seconds: 1, histories: 1, uncertainty: { median_rel_50: median, max_rel_50: 0.2 } } });
    expect(uncertaintyNotes(done(0.012)).map((n) => n.text)).toEqual([expect.stringContaining('1.2%')]);
    const noisy = uncertaintyNotes(done(0.08));
    expect(noisy).toHaveLength(2);
    expect(noisy[1]!.noisy).toBe(true);
    expect(uncertaintyNotes(job({ status: 'running' }))).toEqual([]);
    expect(uncertaintyNotes(job({ dosecalc: { engine: 'pipeline-test', seconds: 1, histories: 1, uncertainty: null } }))).toEqual([]);
  });
  it('模型敏感度：每一組替代參數一行（階段、參數、高劑量區的差與 5–95%）；送出時的條件也說', () => {
    const rows = [
      { stage: 'head_scatter', overrides: { 'extra_focal.sigma_mm': 100, 'extra_focal.fraction': 0.3682 }, median_ratio: 1.0098, p5_ratio: 1.004, p95_ratio: 1.0151 },
      { stage: 'focal_spot', overrides: { focal_spot_sigma_mm: 0.8 }, median_ratio: 0.995, p5_ratio: 0.99, p95_ratio: 1.0 },
      { stage: 'focal_spot', overrides: { focal_spot_sigma_mm: 1.3 }, median_ratio: null, p5_ratio: null, p95_ratio: null },
    ];
    const notes = sensitivityNotes(job({ dosecalc: { engine: 'gpu', seconds: 1, histories: 1, model_sensitivity: rows } }));
    expect(notes[0]).toBe('機頭散射與反散射（extra_focal.sigma_mm 100 · extra_focal.fraction 0.3682）：高劑量區 +1.0%（5–95%：+0.4 … +1.5%）');
    expect(notes[1]).toContain('-0.5%');
    expect(notes[2]).toContain('沒有高劑量區可比');
    expect(sensitivityNotes(job({ status: 'running' }))).toEqual([]);
    expect(summaryNotes({ ...summary, model_sensitivity: true, model_alternatives: 3 }).some((n) => n.includes('3 組'))).toBe(true);
    expect(summaryNotes({ ...summary, model_sensitivity: true, model_alternatives: 0 }).some((n) => n.includes('沒有弱約束'))).toBe(true);
  });
  it('跟 TPS 比對：參考是 TPS、被評估是載入的總劑量、TG-218 條件；沒有 TPS 或還沒載入就沒有', () => {
    const withTps = { ...summary, tps_dose_series_id: 'TPS' };
    expect(tpsGammaBody(job({ summary: withTps, loaded: ['TOTAL', 'B1'] }))).toMatchObject({ reference: 'TPS', evaluated: 'TOTAL', dose_pct: 3, dta_mm: 2, threshold_pct: 10, normalization: 'global' });
    expect(tpsGammaBody(job({ summary: withTps, loaded: [] }))).toBeNull();
    expect(tpsGammaBody(job({ loaded: ['TOTAL'] }))).toBeNull();
    expect(tpsDvhDoseIds(job({ summary: withTps, loaded: ['TOTAL'] }), ['X', 'TPS'])).toEqual(['X', 'TPS', 'TOTAL']);
  });
  it('統計量的選項依引擎：GPU 大一百倍', () => {
    expect(historyPresets('topas')[1]!.value).toBe(20_000_000);
    expect(historyPresets('gpu')[1]!.value).toBe(1_000_000_000);
    expect(historyPresets('gpu').every((p) => p.value >= 100_000_000)).toBe(true);
  });
});
