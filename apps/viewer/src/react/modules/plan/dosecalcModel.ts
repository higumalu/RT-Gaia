/**
 * 重算劑量（計畫面板）的純邏輯 —— 零 React、零 fetch。後端 `routes_dosecalc.py`。
 */

import { msg, t } from '../../../core/i18n';

export interface DosecalcEngine {
  readonly name: string;
  readonly ready: boolean;
  readonly reason: string;
  readonly test_only?: boolean;
  readonly version?: string;
}

export interface DosecalcSummary {
  readonly plan_sop_uid: string;
  readonly plan_label: string;
  readonly beams: readonly { number: number; name: string; mu: number; control_points: number }[];
  readonly fractions: number;
  readonly total_mu: number;
  readonly calibration: { readonly name: string; readonly demo: boolean };
  readonly calibration_fallback: boolean;
  readonly calibration_reason: string;
  readonly beam_model: { readonly model_id: string; readonly name: string; readonly demo: boolean };
  readonly dose_grid: 'tps' | 'ct';
  readonly dose_grid_voxels: number;
  readonly engine: string;
}

export interface DosecalcJob {
  readonly job_id: string;
  readonly status: 'queued' | 'running' | 'done' | 'failed';
  readonly phase: string;
  readonly percent: number;
  readonly error: string | null;
  readonly requested_by: string;
  readonly requested_at: string;
  readonly finished_at: string | null;
  readonly summary: DosecalcSummary;
  readonly loaded: readonly string[];
  readonly dosecalc?: { readonly engine: string; readonly seconds: number; readonly histories: number };
}

export const ENGINE_LABEL: Record<string, string> = {
  geant4: msg('Geant4 Monte Carlo'),
  'pipeline-test': msg('流程測試引擎（不是劑量計算）'),
};

export function engineLabel(name: string): string {
  return ENGINE_LABEL[name] ? t(ENGINE_LABEL[name]) : name;
}

/** 這份計畫的工作，最新的在前。 */
export function jobsForPlan(jobs: readonly DosecalcJob[], planSop: string | undefined): DosecalcJob[] {
  return jobs.filter((j) => j.summary?.plan_sop_uid === planSop).sort((a, b) => b.requested_at.localeCompare(a.requested_at));
}

export function isActive(j: Pick<DosecalcJob, 'status'>): boolean {
  return j.status === 'queued' || j.status === 'running';
}

/** 一行狀態：「排隊中」「計算中 42%」「完成（12.3 秒）」「已取消」「失敗：…」。 */
export function jobStatusText(j: DosecalcJob): string {
  if (j.status === 'queued') return t('排隊中');
  if (j.status === 'running') return t('計算中 {p}%', { p: j.percent });
  if (j.status === 'done') return j.dosecalc ? t('完成（{s} 秒）', { s: j.dosecalc.seconds.toFixed(1) }) : t('完成');
  if (j.error === 'cancelled') return t('已取消');
  return t('失敗：{msg}', { msg: j.error ?? '' });
}

/** 送出前後都要讓人看到的條件：示範模型、通用 CT 曲線、網格。 */
export function summaryNotes(s: DosecalcSummary): string[] {
  const out: string[] = [];
  out.push(t('射束模型：{name}', { name: s.beam_model.name }) + (s.beam_model.demo ? t('（示範用，不代表任何實機）') : ''));
  out.push(t('CT 校正曲線：{name}', { name: s.calibration.name }) + (s.calibration_fallback ? ` — ${s.calibration_reason}` : ''));
  out.push(s.dose_grid === 'tps' ? t('劑量網格：跟 TPS 劑量相同（{n} 個體素）', { n: s.dose_grid_voxels.toLocaleString() }) : t('劑量網格：CT 範圍（{n} 個體素）', { n: s.dose_grid_voxels.toLocaleString() }));
  out.push(t('{beams} 個射束、共 {mu} MU、{fx} 次（結果是全部分次的劑量）', { beams: s.beams.length, mu: Math.round(s.total_mu), fx: s.fractions }));
  return out;
}
