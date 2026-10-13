/**
 * 管理頁「射束模型」的純邏輯 —— 零 React、零 fetch。後端 `GET /dosecalc/beam-models`。
 */

import { joinList, msg, t } from '../../core/i18n';

export interface Collimator {
  readonly device: string;
  readonly kind: 'jaw' | 'mlc' | 'fixed';
  readonly source_to_upstream_mm: number;
  readonly thickness_mm: number;
  readonly material: string;
  readonly leaf_length_mm?: number;
  readonly half_field_mm?: number;
}

export interface BeamModel {
  readonly model_id: string;
  readonly name: string;
  readonly demo: boolean;
  readonly energy_mv: number;
  readonly fluence_mode: string;
  readonly mlc_devices: readonly string[];
  readonly model_hash: string;
  readonly reference: string;
  readonly limitations: readonly string[];
  readonly spectrum: { readonly energies_mev: readonly number[]; readonly weights: readonly number[]; readonly mean_mev: number };
  readonly focal_spot_sigma_mm: number | null;
  readonly angular_sigma_deg: number | null;
  readonly extra_focal: { readonly fraction: number; readonly distance_below_target_mm: number; readonly sigma_mm: number } | null;
  readonly field_margin_mm: number | null;
  readonly collimators: readonly Collimator[];
  readonly calibration: { readonly field_mm: number; readonly ssd_mm: number; readonly depth: string; readonly gy_per_mu: number };
  readonly calibrated: {
    readonly engine_version: string;
    readonly histories: number;
    readonly dmax_mm: number;
    readonly histories_per_mu: number;
    /** `[深度 mm, 相對值（最大 1）]`。 */
    readonly pdd: readonly (readonly [number, number])[];
  } | null;
}

export const COLLIMATOR_KIND_LABEL: Record<Collimator['kind'], string> = {
  jaw: msg('jaw（跟著控制點動）'),
  fixed: msg('固定主準直器（開口不動）'),
  mlc: 'MLC',
};

const MATERIAL_LABEL: Record<string, string> = { G4_W: msg('鎢'), G4_Pb: msg('鉛'), G4_Cu: msg('銅') };

export function materialLabel(material: string): string {
  return MATERIAL_LABEL[material] ? t(MATERIAL_LABEL[material]) : material;
}

/** 一個準直器一行：「鎢 78 mm、距靶 280 mm」＋ 葉片長度或固定開口。 */
export function collimatorText(c: Collimator): string {
  const parts = [t('{m} {mm} mm', { m: materialLabel(c.material), mm: c.thickness_mm }), t('距靶 {mm} mm', { mm: c.source_to_upstream_mm })];
  if (c.leaf_length_mm !== undefined) parts.push(t('葉片長 {mm} mm（等中心投影）', { mm: c.leaf_length_mm }));
  if (c.half_field_mm !== undefined) parts.push(t('開口 ± {mm} mm', { mm: c.half_field_mm }));
  return joinList(parts);
}

/** 能譜的柱：x 是每段的上界（MeV）、高度正規化到最大 1。 */
export function spectrumBars(energies: readonly number[], weights: readonly number[]): { lo: number; hi: number; height: number }[] {
  const peak = Math.max(1e-12, ...weights);
  return energies.map((hi, i) => ({ lo: i === 0 ? 0 : energies[i - 1]!, hi, height: (weights[i] ?? 0) / peak }));
}

/** PDD 在某深度的值（線性內插；超出範圍 null）。 */
export function pddAt(pdd: readonly (readonly [number, number])[], depthMm: number): number | null {
  for (let i = 1; i < pdd.length; i += 1) {
    const [d0, v0] = pdd[i - 1]!;
    const [d1, v1] = pdd[i]!;
    if (depthMm >= d0 && depthMm <= d1) return v0 + ((v1 - v0) * (depthMm - d0)) / Math.max(1e-9, d1 - d0);
  }
  return null;
}

/** SVG polyline 的 points：深度 0 → maxDepth 對到 0 → width，相對值 0 → 1 對到 height → 0。 */
export function pddPoints(pdd: readonly (readonly [number, number])[], width: number, height: number, maxDepth: number): string {
  return pdd
    .filter(([d]) => d <= maxDepth)
    .map(([d, v]) => `${((d / maxDepth) * width).toFixed(1)},${((1 - Math.max(0, Math.min(1, v))) * height).toFixed(1)}`)
    .join(' ');
}

/** 每 MU 歷史數：「3.44 × 10^12」。 */
export function scientific(v: number): string {
  if (!(v > 0)) return '—';
  const e = Math.floor(Math.log10(v));
  return `${(v / 10 ** e).toFixed(2)} × 10^${e}`;
}

/** MU 校正的參考條件一行。 */
export function calibrationText(c: BeamModel['calibration']): string {
  return t('{f} × {f} cm²、SSD {ssd} cm、水中 {depth}：1 MU ＝ {cgy} cGy', { f: c.field_mm / 10, ssd: c.ssd_mm / 10, depth: c.depth, cgy: c.gy_per_mu * 100 });
}
