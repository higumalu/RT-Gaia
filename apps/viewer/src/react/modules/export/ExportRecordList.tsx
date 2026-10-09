/**
 * 匯出紀錄清單：檢視器匯出面板（這個病例）與管理頁「匯出紀錄」分頁（全部、可篩選）共用。
 * 每列：狀態、時間、人、去哪裡、摘要；動作：⤓ 重新下載當時那份檔、重送（選節點 → `POST /export-records/{id}/resend`）。
 */

import { useState } from 'react';

import { SendToNode } from './SendToNode';
import { recordSummary, targetText, type ExportRecord } from './exportRecords';
import { formatDateTime, joinList, t } from '../../../core/i18n';

export function ExportRecordList(props: { records: readonly ExportRecord[]; onChanged?: (() => void) | undefined; showPatient?: boolean }): React.JSX.Element {
  const [open, setOpen] = useState<string | null>(null);
  if (props.records.length === 0) return <p className="muted">{t('（還沒有）')}</p>;
  return (
    <ul className="export-records small">
      {props.records.map((r) => (
        <li key={r.export_id} data-status={r.status}>
          <div>
            <span className={`status ${r.status}`}>{r.status === 'done' ? t('完成') : t('失敗')}</span> {formatDateTime(r.requested_at)} · {r.requested_by} ·{' '}
            <strong>{targetText(r)}</strong> · {recordSummary(r)}
            {props.showPatient && r.patient_ids.length > 0 && <span className="muted"> · {joinList(r.patient_ids)}</span>}
            {r.download_url && (
              <>
                {' '}
                <a className="download" href={r.download_url} title={t('下載當時產生的那份檔')}>
                  ⤓
                </a>
              </>
            )}
            {r.resendable && (
              <button type="button" className="link" onClick={() => setOpen(open === r.export_id ? null : r.export_id)}>
                {open === r.export_id ? t('收起') : r.status === 'failed' ? t('重試') : t('重送')}
              </button>
            )}
          </div>
          {r.error && <div className="error">{r.error}</div>}
          {open === r.export_id && <SendToNode resendOf={r.export_id} caseId={r.case_id || null} defaultNodeId={r.node_id} onDone={props.onChanged} derived={r.kind === 'rtdose'} />}
        </li>
      ))}
    </ul>
  );
}
