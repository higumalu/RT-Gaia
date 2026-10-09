/**
 * 等劑量線在面板上的文字（純函式，給 `DoseRow` 與圖例用、可測）。
 */

import type { DoseDisplay, IsodoseLevelSource } from '../../core';
import { t } from '../../core/i18n';

/** 等劑量線換成 % 參考劑量（取到 0.1）；參考劑量是 0 時回空。 */
export function percentsOf(d: Pick<DoseDisplay, 'levelsGy' | 'referenceGy'>): number[] {
  if (!(d.referenceGy > 0)) return [];
  return d.levelsGy.map((g) => Math.round((g / d.referenceGy) * 1000) / 10);
}

/** level 欄位的文字：自己設過的照原樣；否則依顯示單位（% 取整數、Gy 取到 0.1，小於 1 Gy 取到 0.01）。 */
export function isodoseLevelsText(d: Pick<DoseDisplay, 'levelsGy' | 'referenceGy' | 'display'>, params: Record<string, unknown>): string {
  if (Array.isArray(params['levels'])) return (params['levels'] as number[]).join(',');
  if (d.display === 'percent') return percentsOf(d).map((p) => Math.round(p)).join(',');
  return d.levelsGy.map((g) => fmtLevelGy(g)).join(',');
}

export function fmtLevelGy(g: number): string {
  // 小的差值（0.001 Gy）不能四捨五入成 0 —— 小於 0.1 取兩位有效數字
  const a = Math.abs(g);
  if (a === 0) return '0';
  if (a < 0.1) return String(+g.toPrecision(2));
  return String(+g.toFixed(a < 1 ? 2 : 1));
}

export function isodoseSourceLabel(source: IsodoseLevelSource): string {
  switch (source) {
    case 'custom':
      return t('（只有這個劑量）');
    case 'user-default':
      return t('（我的預設）');
    case 'prescription':
      return t('（% 處方）');
    case 'auto':
      return t('（自動等距）');
  }
}
