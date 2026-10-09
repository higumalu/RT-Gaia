/** 資料頁「從資料庫移除」的純文案（2026-09-15）。零 React。 */

import type { AffectedCase } from './catalogApi';
import { joinClauses, msg, t } from '../../core/i18n';

export type DeleteLevel = 'patients' | 'studies' | 'series';

export interface DeleteTarget {
  readonly level: DeleteLevel;
  readonly id: string;
  readonly label: string;
  readonly seriesCount?: number;
  readonly instanceCount?: number;
}

export const DELETE_LEVEL_LABEL: Record<DeleteLevel, string> = { patients: msg('整位病人'), studies: msg('整個 study'), series: msg('這個序列') };

export function describeDeleteTarget(target: DeleteTarget): string {
  const parts: string[] = [];
  if (target.seriesCount !== undefined) parts.push(t('{seriesCount} 個序列', { seriesCount: target.seriesCount }));
  if (target.instanceCount !== undefined) parts.push(t('{instanceCount} 檔', { instanceCount: target.instanceCount }));
  return t('{p0}{p1}', { p0: t(DELETE_LEVEL_LABEL[target.level]), p1: parts.length ? t('（{p0}）', { p0: parts.join(' · ') }) : '' });
}

/** 409 IN_USE 的說明：哪些病例會打不開。 */
export function describeAffected(cases: readonly AffectedCase[]): string {
  if (cases.length === 0) return '';
  const names = cases.slice(0, 3).map((c) => c.description || c.case_id);
  return t('{length} 個病例的選取引用到這些資料{p1}{p2}。刪了之後那些病例會打不開（裡面的編輯與簽核紀錄仍在資料庫）。', { length: cases.length, p1: names.length ? t('：{p0}', { p0: joinClauses(names) }) : '', p2: cases.length > 3 ? '…' : '' });
}
