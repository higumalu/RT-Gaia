/** 容量提醒的純邏輯（文字、用途名稱）。零 React。 */

import { joinList, msg, t } from '../../core/i18n';
import type { StorageStatus, StorageVolume } from './storageApi';

const LABEL: Record<string, string> = { library: msg('DICOM 資料庫'), blobs: msg('結構版本與匯出檔'), cache: msg('快取') };

export function volumeLabel(v: Pick<StorageVolume, 'labels'>): string {
  return joinList(v.labels.map((l) => (LABEL[l] ? t(LABEL[l]) : l)));
}

/** 橫幅文字：沒有超過 → null；超過 → 最滿的那一顆的用途與百分比。 */
export function bannerText(s: StorageStatus | null): string | null {
  if (s === null || !s.warn) return null;
  const worst = [...s.volumes].filter((v) => v.warn).sort((a, b) => b.percent - a.percent)[0];
  if (worst === undefined) return null;
  return t('儲存空間已用 {percent}%（{what}），超過 {threshold}% 的提醒門檻。系統不會自動刪除資料 —— 請管理者擴充磁碟或整理。', {
    percent: worst.percent.toFixed(0),
    what: volumeLabel(worst),
    threshold: s.threshold,
  });
}

export function formatSize(bytes: number): string {
  if (bytes >= 1e12) return `${(bytes / 1e12).toFixed(2)} TB`;
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(1)} GB`;
  return `${Math.round(bytes / 1e6)} MB`;
}
