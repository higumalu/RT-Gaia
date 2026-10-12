/**
 * CT 校正曲線（HU → 密度 ＋ 材質）的純邏輯 —— 零 React、零 fetch。後端 `routes_ct_calibration.py`。
 */

import { msg, t } from '../../core/i18n';

export type CalibrationStatus = 'builtin' | 'draft' | 'active' | 'retired';

export interface CalibrationMatch {
  readonly manufacturer: string;
  readonly model: string;
  readonly kvp: number | null;
}

export interface CalibrationSummary {
  readonly calibration_id: string;
  readonly name: string;
  readonly status: CalibrationStatus;
  readonly builtin: boolean;
  readonly demo: boolean;
  readonly reference: string;
  readonly match: CalibrationMatch;
  readonly note: string;
  readonly created_by?: string | null;
  readonly created_at?: string | null;
  readonly activated_by?: string | null;
  readonly activated_at?: string | null;
  readonly retired_by?: string | null;
  readonly retired_at?: string | null;
  readonly hu_range: readonly [number, number];
  readonly points: number | null;
}

export interface SampledCurve {
  readonly hu: readonly number[];
  readonly density: readonly number[];
  readonly material: readonly number[];
}

export interface CalibrationMaterial {
  readonly index: number;
  readonly hu_lo: number;
  readonly hu_hi: number;
  readonly name: string;
  readonly class: 'air' | 'lung' | 'adipose' | 'soft_tissue' | 'bone' | 'metal';
  readonly composition: Readonly<Record<string, number>>;
}

export interface CalibrationDetail extends CalibrationSummary {
  readonly density: { readonly type: 'sections' | 'points'; readonly points?: readonly (readonly [number, number])[] };
  readonly curve: SampledCurve;
  readonly materials: readonly CalibrationMaterial[];
}

export const STATUS_LABEL: Record<CalibrationStatus, string> = {
  builtin: msg('內建'),
  draft: msg('草稿'),
  active: msg('啟用中'),
  retired: msg('已停用'),
};

export const CLASS_LABEL: Record<CalibrationMaterial['class'], string> = {
  air: msg('空氣'),
  lung: msg('肺'),
  adipose: msg('脂肪'),
  soft_tissue: msg('軟組織'),
  bone: msg('骨'),
  metal: msg('金屬'),
};

/** 「Siemens · SOMATOM go.Up · 120 kVp」；全空 ＝「（所有沒有對到的 CT）」。 */
export function matchText(m: CalibrationMatch): string {
  const parts = [m.manufacturer, m.model, m.kvp !== null ? `${m.kvp} kVp` : ''].filter(Boolean);
  return parts.length > 0 ? parts.join(' · ') : t('（所有沒有對到的 CT）');
}

/**
 * 貼上的點表 → `[HU, 密度]`。一行一點，逗號、Tab 或空白分隔；`#` 開頭與空行略過；
 * 第一行是表頭（含非數字）也略過。回 `[點, 問題]`。
 */
export function parsePoints(text: string): [Array<[number, number]>, string | null] {
  const out: Array<[number, number]> = [];
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]!.trim();
    if (line === '' || line.startsWith('#')) continue;
    const cells = line.split(/[,\t;\s]+/).filter(Boolean);
    const nums = cells.map(Number);
    if (cells.length !== 2 || nums.some((n) => !Number.isFinite(n))) {
      if (out.length === 0 && nums.some((n) => !Number.isFinite(n))) continue; // 表頭
      return [out, t('第 {n} 行要是「HU, 密度」兩個數字', { n: i + 1 })];
    }
    out.push([nums[0]!, nums[1]!]);
  }
  if (out.length < 2) return [out, t('至少要兩點')];
  return [out, null];
}

/** 畫圖：HU 軸 −1000 … 曲線最大值，密度軸 0 … 最大值的 1.1 倍；回 SVG path（`M x y L …`）與座標換算。 */
export function curvePath(curve: SampledCurve, width: number, height: number, pad = 28): { path: string; x: (hu: number) => number; y: (rho: number) => number; huMax: number; rhoMax: number } {
  const huMin = Math.min(-1000, ...curve.hu);
  const huMax = Math.max(...curve.hu, huMin + 1);
  const rhoMax = Math.max(0.5, ...curve.density) * 1.1;
  const x = (hu: number): number => pad + ((hu - huMin) / (huMax - huMin)) * (width - 2 * pad);
  const y = (rho: number): number => height - pad - (rho / rhoMax) * (height - 2 * pad);
  const path = curve.hu.map((h, i) => `${i === 0 ? 'M' : 'L'}${x(h).toFixed(1)} ${y(curve.density[i]!).toFixed(1)}`).join(' ');
  return { path, x, y, huMax, rhoMax };
}

/** 材質表的組成一格：「H 10.3% · C 10.5% · O 74.9% …」（質量分率大到小，最多 5 個）。 */
export function compositionText(c: Readonly<Record<string, number>>): string {
  return Object.entries(c)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([e, f]) => `${e} ${(f * 100).toFixed(1)}%`)
    .join(' · ');
}
