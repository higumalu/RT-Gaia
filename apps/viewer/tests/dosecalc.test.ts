/** 重算劑量（計畫面板）—— 工作排序與篩選、狀態文字、送出前後的條件說明。 */

import { describe, expect, it } from 'vitest';

import { isActive, jobsForPlan, jobStatusText, summaryNotes, uncertaintyNotes, type DosecalcJob, type DosecalcSummary } from '../src/react/modules/plan/dosecalcModel';

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
});
