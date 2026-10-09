/**
 * 劑量運算的純邏輯 —— 零 React、零 fetch。
 *
 * 本質上是讓使用者可以對劑量矩陣使用加減乘除；加減是兩個劑量之間（A ± B），
 * 乘除是乘或除一個固定值（A × k、A ÷ k）。結果一律 Gy、先暫存，可以再當運算元（多個劑量加總用串接）。
 */

import { joinClauses, msg, t } from '../../../core/i18n';

export type DoseOp = 'add' | 'sub' | 'mul' | 'div';

export const DOSE_OPS: readonly { op: DoseOp; symbol: string; title: string }[] = [
  { op: 'add', symbol: '+', title: msg('A ＋ B：兩個劑量相加') },
  { op: 'sub', symbol: '−', title: msg('A − B：兩個劑量相減（結果是差值，可能有負值）') },
  { op: 'mul', symbol: '×', title: msg('A × k：乘一個固定值（例：單次劑量 × 分次數）') },
  { op: 'div', symbol: '÷', title: msg('A ÷ k：除以一個固定值') },
];

export function needsB(op: DoseOp): boolean {
  return op === 'add' || op === 'sub';
}

export interface DoseOpSource {
  readonly series_id: string;
  readonly label: string;
  readonly frame_of_reference_uid: string;
  readonly max_gy: number | null;
  readonly min_gy: number | null;
  readonly units: string | null;
  readonly dose_type: string | null;
  readonly summation_type: string | null;
  readonly registration: { readonly kind: string; readonly matrix_type: string | null };
  readonly fractions_planned: number | null;
  readonly plan_label: string | null;
  readonly derived: boolean;
  readonly eligible: boolean;
  readonly problems: readonly string[];
  readonly notes: readonly string[];
}

export interface DoseOpSummary {
  readonly max_gy: number;
  readonly min_gy: number;
  readonly mean_gy: number | null;
  readonly covered_fraction: number;
}

export interface DoseOpResult {
  readonly series_id: string;
  readonly text: string;
  readonly op: DoseOp;
  readonly created_at: string;
  readonly created_by: string;
  readonly frame_of_reference_uid: string;
  readonly summary: DoseOpSummary;
  readonly signed: boolean;
  readonly dose_type: string;
  readonly physical_allowed: boolean;
  readonly summation_type_for_save: string | null;
  readonly save_problem: string | null;
  readonly warnings: readonly string[];
  readonly sources: readonly { series_id: string; label: string; sop_instance_uid: string }[];
  readonly plan_sop_uids: readonly string[];
  readonly registration_sop_uids: readonly string[];
  readonly layer_id?: string;
}

/**
 * 一個計畫的射束劑量（`DoseSummationType=BEAM`），能不能合成計畫劑量。
 * `GET …/dose-ops/sources` 的 `beam_groups`；`plan_sop_uid` 空 ＝ 沒有引用計畫的射束劑量（不能合成）。
 */
export interface BeamGroup {
  readonly plan_sop_uid: string;
  readonly plan_label: string;
  readonly fraction_group: number | null;
  readonly fractions_planned: number | null;
  readonly expected_beams: readonly number[];
  readonly doses: readonly { series_id: string; label: string; beams: readonly number[] }[];
  readonly missing: readonly number[];
  readonly extra: readonly number[];
  readonly duplicates: readonly number[];
  readonly problems: readonly string[];
  readonly eligible: boolean;
}

/** `計畫 BEAMS3：3 個射束劑量（射束 1, 2, 3）`。 */
export function beamGroupText(g: BeamGroup): string {
  const beams = [...new Set(g.doses.flatMap((d) => d.beams))].sort((a, b) => a - b);
  const plan = g.plan_label || (g.plan_sop_uid ? `…${g.plan_sop_uid.slice(-8)}` : t('（不明計畫）'));
  return beams.length > 0
    ? t('計畫 {plan}：{n} 個射束劑量（射束 {beams}）', { plan, n: g.doses.length, beams: beams.join(', ') })
    : t('計畫 {plan}：{n} 個射束劑量', { plan, n: g.doses.length });
}



/** k 欄位：正的有限數、≤ 1000（與後端 `check_k` 同一套）。回 `[k, 問題]`。 */
export const K_MAX = 1000;
export function parseK(text: string): [number | null, string | null] {
  const v = Number(text.trim());
  if (text.trim() === '' || !Number.isFinite(v)) return [null, t('k 要是數字')];
  if (v <= 0) return [null, t('k 必須是正數（0 與負數不允許）')];
  if (v > K_MAX) return [null, t('k 不能超過 {max}', { max: K_MAX })];
  return [v, null];
}

export function opSymbol(op: DoseOp): string {
  return DOSE_OPS.find((o) => o.op === op)?.symbol ?? op;
}

/** 下拉選單一列：「plan_0 · Dmax 22.17 Gy · 10 次」；不能用的加原因。 */
export function sourceOptionText(s: DoseOpSource): string {
  const parts = [s.label];
  if (typeof s.max_gy === 'number') parts.push(typeof s.min_gy === 'number' && s.min_gy < 0 ? t('{min} … {max} Gy', { min: s.min_gy.toFixed(2), max: s.max_gy.toFixed(2) }) : `Dmax ${s.max_gy.toFixed(2)} Gy`);
  if (s.fractions_planned) parts.push(t('{n} 次', { n: s.fractions_planned }));
  if (s.derived) parts.push(t('暫存結果'));
  return parts.join(' · ');
}

/** 運算前的預覽式子：「plan_0 × 10」「fx_1 + fx_2」；還沒選完時用 A／B／k 代替。 */
export function previewText(a: DoseOpSource | undefined, op: DoseOp, b: DoseOpSource | undefined, kText: string): string {
  const wrap = (s: DoseOpSource | undefined, fallback: string): string => (s === undefined ? fallback : s.derived ? `(${s.label})` : s.label);
  const right = needsB(op) ? wrap(b, 'B') : kText.trim() || 'k';
  return `${wrap(a, 'A')} ${opSymbol(op)} ${right}`;
}

/** 這個運算現在能不能按：回 null ＝ 可以，否則是原因。 */
export function formProblem(a: DoseOpSource | undefined, op: DoseOp, b: DoseOpSource | undefined, kText: string): string | null {
  if (a === undefined) return t('選 A');
  if (!a.eligible) return joinClauses(a.problems);
  if (needsB(op)) {
    if (b === undefined) return t('選 B');
    if (!b.eligible) return joinClauses(b.problems);
    if (b.series_id === a.series_id) return t('A 與 B 是同一個劑量');
    if (b.frame_of_reference_uid !== a.frame_of_reference_uid) return t('A 與 B 不在同一個空間：先對 B 套用 REG');
    return null;
  }
  return parseK(kText)[1];
}

/** 一行摘要：「−2.24 … 20.00 Gy · 平均 3.10 Gy · 有資料 87%」。 */
export function summaryText(r: Pick<DoseOpResult, 'summary' | 'signed'>): string {
  const s = r.summary;
  const parts = [r.signed ? t('{min} … {max} Gy', { min: s.min_gy.toFixed(2), max: s.max_gy.toFixed(2) }) : `Dmax ${s.max_gy.toFixed(2)} Gy`];
  if (s.mean_gy !== null) parts.push(t('平均 {mean} Gy', { mean: s.mean_gy.toFixed(2) }));
  if (s.covered_fraction < 0.999) parts.push(t('有資料 {pct}%', { pct: (s.covered_fraction * 100).toFixed(0) }));
  return parts.join(' · ');
}

/** 存成 RTDOSE 時的 DoseType 選擇：減法的結果預設 ERROR，全部 ≥ 0 才能改 PHYSICAL（要再確認）。 */
export type SaveDoseType = 'ERROR' | 'PHYSICAL';
export function saveBody(input: {
  purpose: 'download' | 'library';
  anonymize: boolean;
  tags: Readonly<Record<string, string>>;
  physical: boolean;
  confirmPhysical: boolean;
}): Record<string, unknown> {
  const tags = Object.fromEntries(Object.entries(input.tags).filter(([, v]) => v.trim() !== '').map(([k, v]) => [k, v.trim()]));
  return {
    purpose: input.purpose,
    anonymize: input.purpose === 'library' ? false : input.anonymize,
    ...(Object.keys(tags).length > 0 ? { tags } : {}),
    ...(input.physical ? { dose_type: 'PHYSICAL', confirm_physical: input.confirmPhysical } : {}),
  };
}

export const REGISTRATION_LABEL: Record<string, string> = {
  primary: msg('主要影像'),
  rigid: msg('剛性對位'),
  manual: msg('手動對位'),
  none: msg('沒有對位'),
  non_rigid: msg('非剛性對位'),
};


/** 一個劑量可以套用的轉換（`GET …/dose-ops/transforms`）。 */
export interface DoseTransform {
  readonly transform_id: string;
  /** `REG` ＝ 病例裡的 REG 物件；`current` ＝ 目前畫面的對位（含手動微調）。 */
  readonly kind: 'REG' | 'current';
  readonly reg_id: string | null;
  readonly sop_instance_uid: string | null;
  readonly series_date: string | null;
  readonly label: string;
  /** REG 的方向跟要的相反（用它的逆矩陣）。 */
  readonly inverse: boolean;
  readonly matrix_type: string;
  readonly source?: string;
  readonly target_frame_of_reference_uid: string;
  readonly target_label: string;
  readonly problem: string | null;
}

/** 下拉選單一列：「REG 2026-06-17 → CT 2026-06-12（主要）」「目前的對位 → CT …」。 */
export function transformText(x: DoseTransform): string {
  if (x.kind === 'current') return t('目前的對位 → {target}', { target: x.target_label });
  const date = x.series_date && x.series_date.length >= 8 ? `${x.series_date.slice(0, 4)}-${x.series_date.slice(4, 6)}-${x.series_date.slice(6, 8)}` : '';
  const name = [t('REG'), date, x.label].filter(Boolean).join(' ');
  return `${name} → ${x.target_label}${x.inverse ? t('（反向）') : ''}`;
}

/** 同一個空間裡、可以當 B 的劑量（不含 A 自己）。 */
export function sameSpaceOperands(a: DoseOpSource | undefined, sources: readonly DoseOpSource[]): DoseOpSource[] {
  if (a === undefined) return [];
  return sources.filter((s) => s.series_id !== a.series_id && s.frame_of_reference_uid === a.frame_of_reference_uid);
}
