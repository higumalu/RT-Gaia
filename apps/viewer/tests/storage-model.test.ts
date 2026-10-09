/** 容量提醒文字與用途名稱。 */

import { describe, expect, it } from 'vitest';

import { bannerText, formatSize, volumeLabel } from '../src/react/storage/model';

const vol = (labels: string[], percent: number, warn: boolean) => ({ labels, total: 1e12, used: percent * 1e10, free: (100 - percent) * 1e10, percent, warn });

describe('容量提醒', () => {
  it('沒超過不顯示；超過顯示最滿的那一顆', () => {
    expect(bannerText(null)).toBeNull();
    expect(bannerText({ checked_at: '', threshold: 90, warn: false, volumes: [vol(['library'], 50, false)] })).toBeNull();
    const text = bannerText({ checked_at: '', threshold: 90, warn: true, volumes: [vol(['cache'], 91, true), vol(['library', 'blobs'], 96.4, true)] });
    expect(text).toContain('96%');
    expect(text).toContain('DICOM 資料庫、結構版本與匯出檔');
    expect(text).toContain('90%');
    expect(text).toContain('不會自動刪除');
  });
  it('用途名稱與大小', () => {
    expect(volumeLabel({ labels: ['library', 'other'] })).toBe('DICOM 資料庫、other');
    expect(formatSize(2.5e12)).toBe('2.50 TB');
    expect(formatSize(3.2e9)).toBe('3.2 GB');
    expect(formatSize(5e8)).toBe('500 MB');
  });
});
