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
  /** 有效密度比（葉間漏射、鎢合金；擬合出來的模型才有）。 */
  readonly density_factor?: number;
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
  readonly electron_contamination?: { readonly fraction: number; readonly mean_energy_mev: number; readonly sigma_mm: number; readonly distance_below_target_mm: number } | null;
  readonly monitor_backscatter?: { readonly per_mm_x: number; readonly per_mm_y: number } | null;
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

export type UserModelStatus = 'draft' | 'active' | 'retired';

/** 擬合出來的模型（清單）：`BeamModel` ＋ 狀態、機器名稱、擬合摘要、比對摘要。 */
export interface UserBeamModel extends BeamModel {
  readonly status: UserModelStatus;
  readonly machines: readonly string[];
  readonly fit: { readonly prior_model_id: string; readonly datasets: readonly string[]; readonly unconstrained: readonly string[] } | null;
  readonly checks: readonly CheckSummary[];
  readonly job_id?: string | null;
  readonly created_by?: string | null;
  readonly created_at?: string | null;
  readonly activated_by?: string | null;
  readonly activated_at?: string | null;
}

export interface CheckSummary {
  readonly dataset_id: string;
  readonly role: 'fit' | 'validation';
  readonly points: number;
  readonly compared: number;
  readonly pass: number;
  readonly fail: number;
  readonly unsupported: number;
  readonly max_abs_in_tolerance: number | null;
}

export interface FitStage {
  readonly name: string;
  readonly round: number;
  readonly parameters: Readonly<Record<string, unknown>>;
  readonly uncertainty: Readonly<Record<string, unknown>>;
  readonly measurements: readonly string[];
  readonly cost_before: number | null;
  readonly cost_after: number | null;
  readonly weakly_constrained: boolean;
  /** 停在搜尋範圍邊上的參數（資料可能要求模型沒有的東西）。 */
  readonly at_bounds?: readonly string[];
  readonly alternatives: readonly Readonly<Record<string, unknown>>[];
  readonly note: string;
}

export interface CheckRow {
  readonly measurement_id: string;
  readonly label: string;
  readonly quantity: string;
  readonly x: number | null;
  readonly measured: number;
  readonly model: number | null;
  readonly u_model?: number | null;
  readonly diff?: number;
  readonly in_tolerance?: number;
  readonly status: 'pass' | 'fail' | 'unsupported' | 'error';
  readonly reason?: string;
  readonly note?: string;
}

export interface UserBeamModelDetail extends Omit<UserBeamModel, keyof BeamModel> {
  readonly model_id: string;
  readonly fit_report: { readonly stages: readonly FitStage[]; readonly unconstrained: readonly string[]; readonly seconds?: number; readonly basis_simulations?: number } | null;
  readonly check_reports: readonly { readonly dataset_id: string; readonly role: 'fit' | 'validation'; readonly summary: CheckSummary; readonly checks: readonly CheckRow[] }[];
}

export const USER_STATUS_LABEL: Record<UserModelStatus, string> = { draft: msg('草稿'), active: msg('啟用中'), retired: msg('已停用') };

export const STAGE_LABEL: Record<string, string> = {
  spectrum: msg('能譜'),
  electron_contamination: msg('電子污染'),
  focal_spot: msg('焦點'),
  head_scatter: msg('機頭散射與反散射'),
  collimator_density: msg('準直器有效密度'),
  angular_spread: msg('FFF 角分佈'),
  dlg: msg('DLG（葉端）'),
  radial_fluence: msg('徑向通量（離軸）'),
};

function num(v: unknown): string {
  if (typeof v !== 'number') return String(v);
  if (v !== 0 && (Math.abs(v) < 1e-3 || Math.abs(v) >= 1e5)) return v.toExponential(2);
  return String(Math.round(v * 10000) / 10000);
}

/** 一段的參數 → 「fraction 0.0038 · mean_energy_mev 1.5」（巢狀的攤平成 a.b）。 */
export function parameterText(params: Readonly<Record<string, unknown>>): string {
  const out: string[] = [];
  const walk = (prefix: string, v: unknown): void => {
    if (v !== null && typeof v === 'object' && !Array.isArray(v)) {
      for (const [k, x] of Object.entries(v as Record<string, unknown>)) walk(prefix ? `${prefix}.${k}` : k, x);
    } else if (Array.isArray(v)) {
      out.push(`${prefix} [${v.map(num).join(', ')}]`);
    } else {
      out.push(`${prefix} ${num(v)}`);
    }
  };
  walk('', params);
  return out.join(' · ');
}

/** 「18／26 在容許內」；沒有可比的點 → 「沒有可比的點」。 */
export function checkText(c: CheckSummary): string {
  if (!c.compared) return t('沒有可比的點');
  return t('{p}／{n} 在容許內', { p: c.pass, n: c.compared }) + (c.unsupported ? ` · ${t('{n} 點還不支援', { n: c.unsupported })}` : '');
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
  if (c.density_factor !== undefined && c.density_factor !== 1) parts.push(t('有效密度 × {f}', { f: c.density_factor }));
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
