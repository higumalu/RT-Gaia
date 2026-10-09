import { describe, expect, it } from 'vitest';

import { recordQuery, recordSummary, targetText, type ExportRecord } from '../src/react/modules/export/exportRecords';

const base: ExportRecord = {
  export_id: 'job_a',
  case_id: 'c1',
  kind: 'rtstruct',
  target: 'download',
  status: 'done',
  requested_by: 'wang',
  requested_at: '2026-09-24T01:00:00+00:00',
  finished_at: null,
  patient_ids: ['P1'],
  node_id: null,
  node_label: null,
  label: 'ART fx1',
  version_ids: { s1: 'v1' },
  sop_uids_out: ['1.2.3'],
  series_uids: [],
  blob_sha256: null,
  profile: 'varian',
  anonymized: true,
  source_export_id: null,
  resend_of: null,
  error: null,
  counts: { structure_count: 3 },
  download_url: '/api/v1/jobs/job_a/download',
  resendable: true,
};

describe('匯出紀錄', () => {
  it('查詢字串：空值不帶、會 trim', () => {
    expect(recordQuery({})).toBe('');
    expect(recordQuery({ patient_id: ' P1 ', user: '', kind: '', status: 'failed', limit: 200 })).toBe('?patient_id=P1&status=failed&limit=200');
  });
  it('去哪裡', () => {
    expect(targetText(base)).toBe('下載');
    expect(targetText({ target: 'library', node_label: null })).toBe('存入資料庫');
    expect(targetText({ target: 'c-store', node_label: 'Eclipse（ECL@10.0.0.5:104）' })).toBe('→ Eclipse（ECL@10.0.0.5:104）');
  });
  it('摘要：RTSTRUCT 與送出、重送關係', () => {
    expect(recordSummary(base)).toBe('RTSTRUCT「ART fx1」 · 3 個結構 · Varian · 匿名');
    const push: ExportRecord = { ...base, kind: 'push', target: 'c-store', label: '2 個序列', counts: { sent: 90, total: 92, failed: 2 }, resend_of: 'job_z' };
    expect(recordSummary(push)).toBe('2 個序列 · 送出 90 / 92 · 失敗 2 · 重送 job_z');
  });
});
