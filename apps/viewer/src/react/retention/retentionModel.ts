/** 暫存區／封存區頁面的純邏輯：剩幾天、日期顯示、錯誤翻譯。 */

import { formatDateTime, t } from '../../core/i18n';

export function daysLeft(expiresAt: string | null | undefined, now: Date = new Date()): number | null {
  if (!expiresAt) return null;
  const t = new Date(expiresAt).getTime();
  if (Number.isNaN(t)) return null;
  return Math.max(0, Math.ceil((t - now.getTime()) / 86_400_000));
}

export function fmtTime(v: string | null | undefined): string {
  if (!v) return '';
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? v : formatDateTime(d);
}

export function fmtStudy(date: string, desc: string): string {
  const d = /^\d{8}$/.test(date) ? `${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)}` : date;
  return [d, desc].filter(Boolean).join(' ');
}

export function describeRetentionError(message: string): string {
  if (message.includes('ID_TAKEN')) return t('病例裡已有同 id 的結構，先改名或刪掉那一個再救回。');
  if (message.includes('NOT_DELETER')) return t('只有刪除它的人或管理者可以救回／清除。');
  if (message.includes('ADMIN_ONLY') || message.includes('403')) return t('這個動作只有管理者可以做。');
  if (message.includes('NO_DB')) return t('暫存區與封存區需要資料庫。');
  if (message.includes('404')) return t('找不到這一筆（可能已被清除）。');
  return message;
}
