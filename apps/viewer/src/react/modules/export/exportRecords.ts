/**
 * 匯出紀錄：wire 型別、API、給人看的文字。後端 `routes_export_records.py`／`rtgaia_core.export_records`。
 * 一筆 ＝ 一次資料離開系統（下載 RTSTRUCT、存入資料庫、C-STORE 送出），成功失敗都記；可重送。
 */

import { call, json, type RemoteJob } from '../../dimse/dimseApi';
import { t } from '../../../core/i18n';

export type RecordKind = 'rtstruct' | 'rtdose' | 'push';
export type RecordTarget = 'download' | 'library' | 'c-store';

export interface ExportRecord {
  readonly export_id: string;
  readonly case_id: string;
  readonly kind: RecordKind;
  readonly target: RecordTarget;
  readonly status: 'done' | 'failed';
  readonly requested_by: string;
  readonly requested_at: string;
  readonly finished_at: string | null;
  readonly patient_ids: readonly string[];
  readonly node_id: string | null;
  readonly node_label: string | null;
  readonly label: string;
  readonly version_ids: Readonly<Record<string, string>>;
  readonly sop_uids_out: readonly string[];
  readonly series_uids: readonly string[];
  readonly blob_sha256: string | null;
  readonly profile: string | null;
  readonly anonymized: boolean | null;
  readonly source_export_id: string | null;
  readonly resend_of: string | null;
  readonly error: string | null;
  readonly counts: Readonly<Record<string, number>>;
  readonly download_url: string | null;
  readonly resendable: boolean;
}

export interface RecordFilters {
  case_id?: string | undefined;
  patient_id?: string | undefined;
  user?: string | undefined;
  kind?: RecordKind | '' | undefined;
  status?: 'done' | 'failed' | '' | undefined;
  limit?: number | undefined;
}

/** 空值不帶；`limit` 預設後端 100。 */
export function recordQuery(f: RecordFilters): string {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(f)) {
    const s = v === undefined || v === null ? '' : String(v).trim();
    if (s) q.set(k, s);
  }
  const str = q.toString();
  return str ? `?${str}` : '';
}

export const exportRecordsApi = {
  list: (f: RecordFilters = {}): Promise<{ items: ExportRecord[] }> => call(`/export-records${recordQuery(f)}`),
  resend: (id: string, nodeId?: string, extra: Record<string, unknown> = {}): Promise<RemoteJob> =>
    call(`/export-records/${encodeURIComponent(id)}/resend`, json('POST', { ...(nodeId ? { node_id: nodeId } : {}), ...extra })),
};

/** 去哪裡：下載／存入資料庫／→ 節點。 */
export function targetText(r: Pick<ExportRecord, 'target' | 'node_label'>): string {
  if (r.target === 'download') return t('下載');
  if (r.target === 'library') return t('存入資料庫');
  return t('→ {p0}', { p0: r.node_label ?? t('節點') });
}

/** 一行摘要：內容 ＋ 數量 ＋（匿名／profile）＋ 重送關係。 */
export function recordSummary(r: ExportRecord): string {
  const parts: string[] = [];
  if (r.kind === 'rtstruct') {
    parts.push(t('RTSTRUCT「{p0}」', { p0: r.label || '—' }));
    if (r.counts.structure_count !== undefined) parts.push(t('{structure_count} 個結構', { structure_count: r.counts.structure_count }));
    if (r.profile) parts.push(r.profile === 'varian' ? 'Varian' : t('通用'));
    if (r.anonymized === true) parts.push(t('匿名'));
  } else if (r.kind === 'rtdose') {
    // 劑量運算存成的 RTDOSE（label 是運算式）
    parts.push(t('RTDOSE（劑量運算）「{p0}」', { p0: r.label || '—' }));
    if (r.anonymized === true) parts.push(t('匿名'));
  } else {
    parts.push(r.label);
    if (r.counts.sent !== undefined) parts.push(t('送出 {sent}{p1}', { sent: r.counts.sent, p1: r.counts.total !== undefined ? ` / ${r.counts.total}` : '' }));
    if (r.counts.failed) parts.push(t('失敗 {failed}', { failed: r.counts.failed }));
  }
  if (r.resend_of) parts.push(t('重送 {resend_of}', { resend_of: r.resend_of }));
  return parts.join(' · ');
}
