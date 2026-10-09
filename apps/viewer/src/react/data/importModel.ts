/**
 * 匯入面板的**純邏輯**：DICOM 前導判斷、上傳併行、結果彙整。零 React、零 fetch
 * —— `data-import.test.ts` 直接測。
 */

import { t } from '../../core/i18n';

export type ImportOutcome = 'staged' | 'accepted' | 'duplicate_same' | 'duplicate_diff' | 'rejected';
export type ImportStatus = 'open' | 'running' | 'done' | 'failed' | 'discarded';

export interface ImportItem {
  readonly relative_path: string;
  readonly outcome: ImportOutcome;
  readonly reason: string;
  readonly sop_instance_uid: string;
  readonly modality: string;
  readonly size: number;
}

export interface ImportBatch {
  readonly batch_id: string;
  readonly source: 'upload' | 'server_path';
  readonly detail: Record<string, unknown>;
  readonly created_by: string;
  readonly status: ImportStatus;
  readonly phase: string;
  readonly percent: number;
  readonly created_at: string;
  readonly started_at: string | null;
  readonly finished_at: string | null;
  readonly error: string | null;
  readonly counts: Record<string, number>;
  readonly touched_patient_ids: readonly string[];
  readonly items?: readonly ImportItem[];
  /** 收下了、但壓縮格式目前解不了的影像序列（檔案照樣存著，可下載／轉送，檢視器開不了）。舊後端沒有。 */
  readonly undecodable?: readonly { series_instance_uid: string; modality: string; count: number; transfer_syntax: string; reason: string }[];
}

/** 一個待上傳的檔（瀏覽器 `File` 的最小投影，方便測試）。 */
export interface Candidate {
  readonly relativePath: string;
  readonly size: number;
  /** 讀前 132 bytes（`File.slice(0, 132)`）。 */
  readonly head: () => Promise<Uint8Array>;
}

export const DICM_OFFSET = 128;
export const UPLOAD_CONCURRENCY = 6;
export const MAX_FILES_SUGGESTED = 5000;

/** 前 132 bytes 有 `DICM` 前導。**不解標頭**（不在瀏覽器解 DICOM），只看這四個字。 */
export function hasDicmPreamble(head: Uint8Array): boolean {
  if (head.length < DICM_OFFSET + 4) return false;
  return head[DICM_OFFSET] === 0x44 && head[DICM_OFFSET + 1] === 0x49 && head[DICM_OFFSET + 2] === 0x43 && head[DICM_OFFSET + 3] === 0x4d;
}

export function isZip(relativePath: string, head?: Uint8Array): boolean {
  if (head && head.length >= 4 && head[0] === 0x50 && head[1] === 0x4b && head[2] === 0x03 && head[3] === 0x04) return true;
  return relativePath.toLowerCase().endsWith('.zip');
}

export interface Precheck {
  readonly upload: readonly Candidate[];
  readonly skipped: readonly { relativePath: string; reason: string }[];
  readonly bytes: number;
}

/**
 * 上傳前先在本機篩：zip 直接送（伺服器端解）；其餘要有 `DICM` 前導；隱藏檔跳過。
 * 這一步省的是**網路**——一個 500 MB 的資料夾裡常有 DICOMDIR、報告 PDF、縮圖。
 */
export async function precheck(candidates: readonly Candidate[]): Promise<Precheck> {
  const upload: Candidate[] = [];
  const skipped: { relativePath: string; reason: string }[] = [];
  let bytes = 0;
  for (const c of candidates) {
    const base = c.relativePath.split('/').pop() ?? c.relativePath;
    if (base.startsWith('.')) {
      skipped.push({ relativePath: c.relativePath, reason: t('隱藏檔') });
      continue;
    }
    if (isZip(c.relativePath)) {
      upload.push(c);
      bytes += c.size;
      continue;
    }
    if (c.size < DICM_OFFSET + 4) {
      skipped.push({ relativePath: c.relativePath, reason: t('太小，不是 DICOM') });
      continue;
    }
    const head = await c.head();
    if (isZip(c.relativePath, head) || hasDicmPreamble(head)) {
      upload.push(c);
      bytes += c.size;
    } else {
      skipped.push({ relativePath: c.relativePath, reason: t('沒有 DICM 前導') });
    }
  }
  return { upload, skipped, bytes };
}

/** 固定併行數跑完全部工作；單一失敗不中斷其他，結果照原順序回。 */
export async function runWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>,
  onProgress?: (done: number, total: number) => void,
): Promise<PromiseSettledResult<R>[]> {
  const results: PromiseSettledResult<R>[] = Array.from({ length: items.length }, () => ({ status: 'rejected' as const, reason: new Error(t('未執行')) }));
  let next = 0;
  let done = 0;
  const lanes = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (next < items.length) {
      const i = next++;
      try {
        results[i] = { status: 'fulfilled', value: await worker(items[i]!, i) };
      } catch (reason) {
        results[i] = { status: 'rejected', reason };
      }
      done += 1;
      onProgress?.(done, items.length);
    }
  });
  await Promise.all(lanes);
  return results;
}

export function isTerminal(status: ImportStatus): boolean {
  return status === 'done' || status === 'failed' || status === 'discarded';
}

/** 批次的一行摘要：「接受 187 · 重複 3 · 拒絕 1」。 */
export function summarizeCounts(counts: Record<string, number>): string {
  const parts: string[] = [];
  const n = (k: string): number => counts[k] ?? 0;
  if (n('accepted')) parts.push(t('接受 {p0}', { p0: n('accepted') }));
  if (n('duplicate_same')) parts.push(t('重複 {p0}', { p0: n('duplicate_same') }));
  if (n('duplicate_diff')) parts.push(t('同 UID 不同內容 {p0}', { p0: n('duplicate_diff') }));
  if (n('rejected')) parts.push(t('拒絕 {p0}', { p0: n('rejected') }));
  if (n('staged')) parts.push(t('待處理 {p0}', { p0: n('staged') }));
  return parts.join(' · ') || t('（空）');
}

/** 需要人看的項目：拒絕與「同 UID 不同內容」。重複（相同內容）不列 —— 那是正常的重送。 */
export function attention(items: readonly ImportItem[]): ImportItem[] {
  return items.filter((it) => it.outcome === 'rejected' || it.outcome === 'duplicate_diff');
}

export function formatBytesShort(bytes: number): string {
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(2)} GB`;
  if (bytes >= 1e6) return `${Math.round(bytes / 1e6)} MB`;
  return `${Math.round(bytes / 1e3)} KB`;
}
