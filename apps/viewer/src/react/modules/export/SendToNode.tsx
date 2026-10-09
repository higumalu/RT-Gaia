/**
 * 匯出面板的「送到節點」：匯出完成 → 選節點 → `POST /dimse/nodes/{id}/send {export_job_id}` → 進度。
 * `resendOf` ＝ 從匯出紀錄重送（`POST /export-records/{id}/resend {node_id}`，新紀錄帶 `resend_of`）；
 * `defaultNodeId` 預設選原節點。
 */

import { useEffect, useState } from 'react';

import { dimseApi, type DicomNode, type RemoteJob } from '../../dimse/dimseApi';
import { SEND_PHASE_LABEL, storeTargets, summarizeSend } from '../../dimse/model';
import { exportRecordsApi } from './exportRecords';
import { t } from '../../../core/i18n';

const POLL_MS = 600;

export function SendToNode(props: {
  exportJobId?: string | undefined;
  caseId: string | null;
  resendOf?: string | undefined;
  defaultNodeId?: string | null | undefined;
  onDone?: (() => void) | undefined;
  /** 送的是 RT-Gaia 算出的衍生劑量 → 多一道確認（後端沒收到 `confirm_derived` 回 409）。 */
  derived?: boolean | undefined;
}): React.JSX.Element | null {
  const [nodes, setNodes] = useState<DicomNode[] | null>(null);
  const [nodeId, setNodeId] = useState('');
  const [job, setJob] = useState<RemoteJob | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  // 呼叫端知道是衍生劑量就一開始問；不知道（例：重送一筆送出紀錄）時後端回 409 再問
  const [needConfirm, setNeedConfirm] = useState(props.derived === true);

  useEffect(() => {
    dimseApi.nodes().then(
      (all) => {
        const t = storeTargets(all);
        setNodes(t);
        const preferred = t.find((n) => n.node_id === props.defaultNodeId)?.node_id;
        setNodeId((cur) => cur || preferred || t[0]?.node_id || '');
      },
      () => setNodes([]),
    );
  }, [props.defaultNodeId]);

  if (nodes === null) return null;
  if (nodes.length === 0) return props.resendOf ? <p className="muted small">{t('沒有可送出的節點（管理頁「DICOM 節點」設定）。')}</p> : null;

  const send = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      const confirm = needConfirm && confirmed ? { confirm_derived: true } : {};
      let j = props.resendOf
        ? await exportRecordsApi.resend(props.resendOf, nodeId, confirm)
        : await dimseApi.send(nodeId, { ...(props.exportJobId ? { export_job_id: props.exportJobId } : {}), ...(props.caseId ? { case_id: props.caseId } : {}), ...confirm });
      setJob(j);
      while (j.status !== 'done' && j.status !== 'failed') {
        await new Promise((r) => setTimeout(r, POLL_MS));
        j = await dimseApi.job(j.job_id);
        setJob(j);
      }
      props.onDone?.();
    } catch (e) {
      const text = e instanceof Error ? e.message : String(e);
      if (/DERIVED_DOSE_CONFIRM/.test(text)) {
        setNeedConfirm(true);
        setError(t('這次送出含 RT-Gaia 算出的衍生劑量：勾選確認後再送'));
      } else {
        setError(text);
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="send-to-node">
      <label>
        {t('送到節點')}
        <select value={nodeId} disabled={busy} onChange={(e) => setNodeId(e.target.value)}>
          {nodes.map((n) => (
            <option key={n.node_id} value={n.node_id}>
              {t('{name}（{ae_title}）', { name: n.name, ae_title: n.ae_title })}
            </option>
          ))}
        </select>
      </label>
      {needConfirm && (
        <label className="derived-confirm warning">
          <input type="checkbox" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} />
          {t('我了解這是 RT-Gaia 算出的衍生劑量，不是 TPS 計算結果')}
        </label>
      )}
      <button type="button" disabled={busy || !nodeId || (needConfirm && !confirmed)} onClick={() => void send()}>
        {busy ? t('傳送中…') : props.resendOf ? t('重送') : t('C-STORE 送出')}
      </button>
      {job && (
        <span className={`status ${job.status}`}>
          {t(SEND_PHASE_LABEL[job.phase] ?? job.phase)} {job.status !== 'done' && job.status !== 'failed' ? `${job.percent}%` : ''} {summarizeSend(job)}
        </span>
      )}
      {error && <span className="error">{error}</span>}
    </div>
  );
}
