/**
 * 地標對與 TG-132 TRE 的**純邏輯**：列、摘要、CSV、建立。零 React。
 *
 * 一個地標對是一筆 `kind: 'landmark'` 的量測（存後端、進 undo、跟病例走）：
 * `frameOfReferenceUid` ＝ 移動（次要）序列的 FoR，`pairFrameOfReferenceUid` ＝ 固定（primary）的 FoR，
 * `points` ＝ [移動點（自己的座標）, 固定點（primary 座標）]。TRE 由 host 用**目前**的對位算好放在 `result`。
 */

import type { Layer } from '../../../core';
import { t } from '../../../core/i18n';

export interface LandmarkRow {
  readonly measurementId: string;
  readonly label: string;
  readonly tre: number;
  /** 固定點（primary 世界座標）：點列時十字線移過去。 */
  readonly fixed: readonly [number, number, number];
  readonly moving: readonly [number, number, number];
}

export const DEFAULT_TRE_THRESHOLD_MM = 2;

/** 某個次要序列的地標對（依建立順序）。 */
export function landmarkRows(layers: readonly Layer[], movingFrameOfReferenceUid: string): LandmarkRow[] {
  const out: LandmarkRow[] = [];
  for (const l of layers) {
    const m = l.measurement;
    if (l.kind !== 'measurement' || m === undefined || m.kind !== 'landmark' || m.frameOfReferenceUid !== movingFrameOfReferenceUid || m.points.length < 6) continue;
    out.push({
      measurementId: m.measurementId,
      label: m.label,
      tre: m.result?.value ?? 0,
      moving: [m.points[0]!, m.points[1]!, m.points[2]!],
      fixed: [m.points[3]!, m.points[4]!, m.points[5]!],
    });
  }
  return out;
}

export interface TreSummary {
  readonly n: number;
  readonly mean: number;
  readonly rms: number;
  readonly max: number;
  /** 超過門檻的對數。 */
  readonly over: number;
}

export function treSummary(rows: readonly Pick<LandmarkRow, 'tre'>[], thresholdMm: number): TreSummary {
  if (rows.length === 0) return { n: 0, mean: 0, rms: 0, max: 0, over: 0 };
  const tres = rows.map((r) => r.tre);
  return {
    n: tres.length,
    mean: tres.reduce((a, b) => a + b, 0) / tres.length,
    rms: Math.sqrt(tres.reduce((a, b) => a + b * b, 0) / tres.length),
    max: Math.max(...tres),
    over: tres.filter((v) => v > thresholdMm).length,
  };
}

function csvCell(v: string | number): string {
  const s = String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** QA 紀錄用 CSV：名稱、TRE、固定點（primary LPS）、移動點（次要序列自己的 LPS）、兩個 FoR。 */
export function landmarkCsv(rows: readonly LandmarkRow[], fixedUid: string, movingUid: string): string {
  const lines = [['label', 'tre_mm', 'fixed_x', 'fixed_y', 'fixed_z', 'moving_x', 'moving_y', 'moving_z', 'fixed_frame_of_reference_uid', 'moving_frame_of_reference_uid'].join(',')];
  for (const r of rows) {
    lines.push([r.label, r.tre.toFixed(3), ...r.fixed.map((v) => v.toFixed(2)), ...r.moving.map((v) => v.toFixed(2)), fixedUid, movingUid].map(csvCell).join(','));
  }
  return lines.join('\n');
}

/** 下一個地標的名稱：「地標 N」（N ＝ 現有「地標 k」的最大 k ＋ 1；前綴依建立當下的語言）。 */
export function nextLandmarkLabel(existing: readonly string[]): string {
  const prefix = t('地標');
  let max = 0;
  for (const label of existing) {
    const m = new RegExp(`^${prefix} (\\d+)$`).exec(label);
    if (m) max = Math.max(max, Number(m[1]));
  }
  return `${prefix} ${max + 1}`;
}
