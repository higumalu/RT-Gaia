/**
 * γ 比較的純邏輯 —— 零 React、零 fetch。後端 `POST …/dose-ops/gamma` 的結果怎麼讀、怎麼說明。
 */

import { t } from '../../../core/i18n';
import type { DoseOpSource } from './model';

export interface GammaCriteria {
  readonly dose_pct: number;
  readonly dta_mm: number;
  readonly normalization: 'global' | 'local';
  readonly threshold_pct: number;
  readonly norm_gy: number | null;
  readonly max_gamma: number;
  readonly resolution: 3 | 5 | 10;
}

export const DEFAULT_GAMMA_CRITERIA: GammaCriteria = { dose_pct: 3, dta_mm: 2, normalization: 'global', threshold_pct: 10, norm_gy: null, max_gamma: 2, resolution: 5 };

export interface GammaStats {
  readonly criteria: GammaCriteria;
  readonly criteria_label: string;
  readonly norm_gy: number;
  readonly reference_max_gy: number;
  readonly threshold_gy: number;
  readonly candidates: number;
  readonly evaluated: number;
  readonly no_data: number;
  readonly pass_rate: number | null;
  readonly mean_gamma: number | null;
  readonly p95_gamma: number | null;
  readonly max_gamma: number | null;
  readonly capped: number;
  readonly histogram: { readonly edges: readonly number[]; readonly counts: readonly number[] };
  readonly failures: { readonly count: number; readonly high_gradient: number; readonly flat: number; readonly flat_hot: number; readonly flat_cold: number };
  readonly seconds: number;
  readonly reference_series_id: string;
  readonly evaluated_series_id: string;
  readonly reference_label: string;
  readonly evaluated_label: string;
  readonly notes: readonly string[];
}

export interface GammaRegion {
  readonly structure_id: string;
  readonly name: string;
  readonly voxels?: number;
  readonly evaluated: number;
  readonly pass_rate: number | null;
  readonly mean_gamma?: number | null;
  readonly max_gamma?: number | null;
}

/** 可以當參考或被評估的劑量：Gy、不是差值、不是 γ 圖（後端 `gamma_problems`）。 */
export function gammaEligible(s: DoseOpSource): boolean {
  return (s.gamma_problems ?? []).length === 0;
}

/** 被評估劑量的候選：同一個空間、能比、不是參考自己。 */
export function gammaCandidates(reference: DoseOpSource | undefined, sources: readonly DoseOpSource[]): DoseOpSource[] {
  if (reference === undefined) return [];
  return sources.filter((s) => s.series_id !== reference.series_id && s.frame_of_reference_uid === reference.frame_of_reference_uid && gammaEligible(s));
}

/** 表單的數字欄位 → 請求；不合理的回原因（跟後端 `check_criteria` 同一套範圍）。 */
export function gammaRequest(input: { doseText: string; dtaText: string; thresholdText: string; normalization: 'global' | 'local'; resolution: 3 | 5 | 10; maxGamma: number }): [Record<string, unknown> | null, string | null] {
  const dose = Number(input.doseText);
  const dta = Number(input.dtaText);
  const thr = Number(input.thresholdText);
  if (!(dose >= 0.1 && dose <= 20)) return [null, t('劑量差標準要在 0.1%–20%')];
  if (!(dta >= 0.1 && dta <= 10)) return [null, t('距離標準要在 0.1–10 mm')];
  if (input.thresholdText.trim() === '' || !(thr >= 0 && thr < 100)) return [null, t('低劑量門檻要在 0%–100%')];
  return [{ dose_pct: dose, dta_mm: dta, threshold_pct: thr, normalization: input.normalization, resolution: input.resolution, max_gamma: input.maxGamma }, null];
}

export function pct(v: number | null | undefined, digits = 1): string {
  return typeof v === 'number' ? `${(v * 100).toFixed(digits)}%` : '—';
}

/** TG-218 的 universal tolerance／action limit 只對「3%/2 mm、全域、10% 門檻」定義。 */
export function isTg218Criteria(c: GammaCriteria): boolean {
  return c.dose_pct === 3 && c.dta_mm === 2 && c.normalization === 'global' && c.threshold_pct === 10;
}

export type GammaVerdict = 'pass' | 'review' | 'action' | null;

/** ≥ 95% 容許、90–95% 要看、< 90% 要處理；條件不是 TG-218 的那組就不判。 */
export function gammaVerdict(g: Pick<GammaStats, 'criteria' | 'pass_rate'>): GammaVerdict {
  if (g.pass_rate === null || !isTg218Criteria(g.criteria)) return null;
  if (g.pass_rate >= 0.95) return 'pass';
  if (g.pass_rate >= 0.9) return 'review';
  return 'action';
}

/** 一行摘要：「通過率 97.3%（3%/2 mm G, 10%）」。 */
export function gammaSummaryText(g: GammaStats): string {
  return t('通過率 {rate}（{criteria}）', { rate: pct(g.pass_rate), criteria: g.criteria_label });
}

/**
 * 失敗點在說什麼：依參考劑量的梯度分「高梯度區」（位置對不上）與「平坦區」（劑量值不同，再分偏高、偏低）。
 * 回幾句話，給面板直接列出來。
 */
export function gammaExplanation(g: GammaStats): string[] {
  const out: string[] = [];
  const f = g.failures;
  out.push(t('評估 {n} 點（參考劑量 ≥ {thr} Gy）', { n: g.evaluated.toLocaleString(), thr: g.threshold_gy.toFixed(2) }));
  if (f.count === 0) {
    out.push(t('沒有失敗的點'));
  } else {
    const share = (n: number): string => `${Math.round((n / f.count) * 100)}%`;
    out.push(t('失敗 {n} 點：高梯度區 {hg}（多半是位置對不上：射野邊緣、MLC、對位）、平坦區 {flat}（劑量值不同）', { n: f.count.toLocaleString(), hg: share(f.high_gradient), flat: share(f.flat) }));
    if (f.flat > 0) {
      const hot = f.flat_hot / f.flat;
      const cold = f.flat_cold / f.flat;
      if (hot >= 0.8) out.push(t('平坦區的失敗幾乎都是被評估劑量偏高（{p}）：大片同向的偏差通常是系統性的（輸出、MU、密度換算），不是幾何', { p: pct(hot, 0) }));
      else if (cold >= 0.8) out.push(t('平坦區的失敗幾乎都是被評估劑量偏低（{p}）：大片同向的偏差通常是系統性的（輸出、MU、密度換算），不是幾何', { p: pct(cold, 0) }));
      else out.push(t('平坦區的失敗有偏高也有偏低（偏高 {hot}、偏低 {cold}）', { hot: pct(hot, 0), cold: pct(cold, 0) }));
    }
    if (g.capped > 0) out.push(t('其中 {n} 點 γ ≥ {max}（搜尋範圍內找不到相符的劑量）', { n: g.capped.toLocaleString(), max: g.criteria.max_gamma }));
  }
  return [...out, ...g.notes];
}
