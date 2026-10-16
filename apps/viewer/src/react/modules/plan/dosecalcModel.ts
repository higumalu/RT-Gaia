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
  readonly calc_spacing_mm?: number | null;
  /** 要算模型敏感度（擬合裡一樣好的其他參數各重算一次）；`model_alternatives` 是幾組。 */
  readonly model_sensitivity?: boolean;
  readonly model_alternatives?: number;
  /** 參照這份計畫的 TPS 劑量（病例裡有的話）：重算結果跟它比。 */
  readonly tps_dose_series_id?: string | null;
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
  readonly dosecalc?: {
    readonly engine: string;
    readonly seconds: number;
    readonly histories: number;
    readonly uncertainty?: { readonly median_rel_50: number | null; readonly max_rel_50: number | null } | null;
    readonly model_sensitivity?: readonly ModelAlternative[] | null;
  };
}

/** 模型敏感度的一列：擬合裡一樣好的另一組參數，重算後高劑量區的劑量 ÷ 主計算。 */
export interface ModelAlternative {
  readonly stage: string;
  readonly overrides: Readonly<Record<string, number>>;
  readonly median_ratio: number | null;
  readonly p5_ratio: number | null;
  readonly p95_ratio: number | null;
}

const SENSITIVITY_STAGE: Record<string, string> = {
  electron_contamination: msg('電子污染'),
  focal_spot: msg('焦點'),
  head_scatter: msg('機頭散射與反散射'),
};

function shortNumber(v: number): string {
  if (v !== 0 && (Math.abs(v) < 1e-3 || Math.abs(v) >= 1e5)) return v.toExponential(2);
  return String(Math.round(v * 10000) / 10000);
}

/** 完成的工作的模型敏感度：每一組一行「機頭散射與反散射（extra_focal.sigma_mm 100 · …）：高劑量區 +1.0%（5–95%：+0.6 … +1.4%）」。 */
export function sensitivityNotes(j: Pick<DosecalcJob, 'status' | 'dosecalc'>): string[] {
  const rows = j.status === 'done' ? j.dosecalc?.model_sensitivity : null;
  if (!rows) return [];
  const pct = (r: number): string => `${r >= 1 ? '+' : ''}${((r - 1) * 100).toFixed(1)}`;
  return rows.map((r) => {
    const stage = SENSITIVITY_STAGE[r.stage] ? t(SENSITIVITY_STAGE[r.stage]!) : r.stage;
    const params = Object.entries(r.overrides).map(([k, v]) => `${k} ${shortNumber(v)}`).join(' · ');
    if (r.median_ratio === null) return t('{stage}（{params}）：沒有高劑量區可比', { stage, params });
    return t('{stage}（{params}）：高劑量區 {med}%（5–95%：{lo} … {hi}%）', {
      stage, params, med: pct(r.median_ratio), lo: pct(r.p5_ratio ?? r.median_ratio), hi: pct(r.p95_ratio ?? r.median_ratio),
    });
  });
}

export const ENGINE_LABEL: Record<string, string> = {
  topas: msg('OpenTOPAS（Geant4）Monte Carlo'),
  gpu: msg('GPU Monte Carlo（RT-Gaia）'),
  'pipeline-test': msg('流程測試引擎（不是劑量計算）'),
};

export function engineLabel(name: string): string {
  return ENGINE_LABEL[name] ? t(ENGINE_LABEL[name]) : name;
}

/** 統計量：歷史數越多不確定度越小、越慢（大約跟歷史數成正比）。GPU 每秒能跑的歷史數是 OpenTOPAS 的百倍上下，選項也大一百倍。 */
export const HISTORY_PRESETS: readonly { value: number; label: string }[] = [
  { value: 2_000_000, label: msg('快速（2 百萬個歷史）') },
  { value: 20_000_000, label: msg('標準（2 千萬個歷史）') },
  { value: 100_000_000, label: msg('精細（1 億個歷史）') },
];
export const GPU_HISTORY_PRESETS: readonly { value: number; label: string }[] = [
  { value: 200_000_000, label: msg('快速（2 億個歷史）') },
  { value: 1_000_000_000, label: msg('標準（10 億個歷史）') },
  { value: 4_000_000_000, label: msg('精細（40 億個歷史）') },
];

export function historyPresets(engine: string): readonly { value: number; label: string }[] {
  return engine === 'gpu' ? GPU_HISTORY_PRESETS : HISTORY_PRESETS;
}

/** Monte Carlo 計分網格：粗一點雜訊少（∝ 體素體積的 −1/2 次方）、跑得快，結果內插回劑量網格；`null` ＝ 直接算在劑量網格上。 */
export const CALC_SPACINGS: readonly { value: number | null; label: string }[] = [
  { value: 4, label: msg('計算網格 4 mm（建議）') },
  { value: 3, label: msg('計算網格 3 mm') },
  { value: 5, label: msg('計算網格 5 mm') },
  { value: null, label: msg('計算網格跟劑量網格相同') },
];

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
  if (s.calc_spacing_mm) out.push(t('Monte Carlo 算在 {mm} mm 的網格上，再內插回劑量網格', { mm: s.calc_spacing_mm }));
  if (s.model_sensitivity) out.push(s.model_alternatives ? t('模型敏感度：擬合裡一樣好的其他 {n} 組參數各重算一次', { n: s.model_alternatives }) : t('模型敏感度：這個射束模型沒有弱約束的參數'));
  out.push(t('{beams} 個射束、共 {mu} MU、{fx} 次（結果是全部分次的劑量）', { beams: s.beams.length, mu: Math.round(s.total_mu), fx: s.fractions }));
  return out;
}

/** 統計不確定度的中位數超過這個值就提醒：γ 3% 的判準下，雜訊本身就會造成失敗。 */
export const NOISY_UNCERTAINTY = 0.03;

/** 完成的工作的統計不確定度（高劑量區）：一行說明 ＋ 雜訊偏大時的提醒。沒有（測試引擎、舊工作）回空陣列。 */
export function uncertaintyNotes(j: Pick<DosecalcJob, 'status' | 'dosecalc'>): { text: string; noisy: boolean }[] {
  const u = j.status === 'done' ? j.dosecalc?.uncertainty : null;
  if (!u || u.median_rel_50 === null || u.max_rel_50 === null) return [];
  const pct = (v: number): string => (v * 100).toFixed(1);
  const out = [{ text: t('統計不確定度（1σ，劑量 ≥ 50% 的區域）：中位數 {med}%、最大 {max}%', { med: pct(u.median_rel_50), max: pct(u.max_rel_50) }), noisy: false }];
  if (u.median_rel_50 > NOISY_UNCERTAINTY) out.push({ text: t('雜訊偏大：γ 的失敗有一部分是統計雜訊。可以加歷史數或用較粗的計算網格再算一次'), noisy: true });
  return out;
}

/**
 * 「跟 TPS 比對」的 γ 請求：參考 ＝ TPS 劑量、被評估 ＝ 載入的總劑量（`loaded[0]`）、TG-218 的 3%/2 mm 全域 10% 門檻。
 * 病例裡沒有 TPS 劑量、或還沒載入 → null。
 */
export function tpsGammaBody(j: Pick<DosecalcJob, 'summary' | 'loaded'>): Record<string, unknown> | null {
  const tps = j.summary.tps_dose_series_id;
  const total = j.loaded[0];
  if (!tps || !total) return null;
  return { reference: tps, evaluated: total, dose_pct: 3, dta_mm: 2, threshold_pct: 10, normalization: 'global', resolution: 5, max_gamma: 2 };
}

/** 「DVH 對照」：TPS 劑量與重算的總劑量一起放進 DVH（保留原本選的）。 */
export function tpsDvhDoseIds(j: Pick<DosecalcJob, 'summary' | 'loaded'>, current: readonly string[]): string[] {
  const add = [j.summary.tps_dose_series_id, j.loaded[0]].filter((x): x is string => typeof x === 'string' && x.length > 0);
  return [...current, ...add.filter((x) => !current.includes(x))];
}
