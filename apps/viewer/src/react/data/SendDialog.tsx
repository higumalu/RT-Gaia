/**
 * 資料頁「送到節點」對話框：一列（病人／study／序列）→ 選節點 → `POST /dimse/nodes/{id}/send`
 * （study／病人由後端展開成目錄裡的全部序列）→ job 進度 → 結果。純邏輯在 `../dimse/model.ts`。
 */

import { useEffect, useState } from 'react';

import { Dialog } from '../components/Dialog';

import { dimseApi, type DicomNode, type RemoteJob } from '../dimse/dimseApi';
import { describeSendTarget, SEND_PHASE_LABEL, sendBody, storeTargets, summarizeSend, type SendTarget } from '../dimse/model';
import { t } from '../../core/i18n';

const POLL_MS = 600;

export function SendDialog(props: { target: SendTarget; onClose: () => void }): React.JSX.Element {
  const [nodes, setNodes] = useState<DicomNode[] | null>(null);
  const [nodeId, setNodeId] = useState('');
  const [job, setJob] = useState<RemoteJob | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    dimseApi.nodes().then(
      (all) => {
        const t = storeTargets(all);
        setNodes(t);
        setNodeId((cur) => cur || t[0]?.node_id || '');
      },
      (e: unknown) => {
        setNodes([]);
        setError(e instanceof Error ? e.message : String(e));
      },
    );
  }, []);

  // 內容含 RT-Gaia 劑量運算存的 RTDOSE → 後端回 409 → 勾選確認後再送（寫進稽核）
  const [needConfirm, setNeedConfirm] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const send = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      let j = await dimseApi.send(nodeId, { ...sendBody(props.target), ...(needConfirm && confirmed ? { confirm_derived: true } : {}) });
      setJob(j);
      while (j.status !== 'done' && j.status !== 'failed') {
        await new Promise((r) => setTimeout(r, POLL_MS));
        j = await dimseApi.job(j.job_id);
        setJob(j);
      }
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

  const node = nodes?.find((n) => n.node_id === nodeId);
  return (
    <Dialog label={t('送到節點')} className="send-dialog" busy={busy} onClose={props.onClose}>
        <header>
          <h3>{t('以 C-STORE 送到節點')}</h3>
          <button type="button" onClick={props.onClose} aria-label={t('關閉')} disabled={busy}>
            ×
          </button>
        </header>
        <p>
          <strong>{props.target.label}</strong>
          <br />
          <span className="muted">{t('{p0}；原始 DICOM 逐檔送出，不轉碼。', { p0: describeSendTarget(props.target) })}</span>
        </p>
        {nodes === null ? (
          <p className="muted">{t('載入節點…')}</p>
        ) : nodes.length === 0 ? (
          <p className="muted">{t('還沒有可送出的節點。請管理者在「管理 › DICOM 節點」新增一個可送出、支援 STORE 的 PACS／TPS。')}</p>
        ) : (
          <label>
            {t('節點')}
            <select value={nodeId} disabled={busy || job !== null} onChange={(e) => setNodeId(e.target.value)}>
              {nodes.map((n) => (
                <option key={n.node_id} value={n.node_id}>
                  {t('{name}（{ae_title} · {host}:{port}）', { name: n.name, ae_title: n.ae_title, host: n.host, port: n.port })}
                </option>
              ))}
            </select>
          </label>
        )}
        {node && node.last_echo_ok === false && <p className="warning">{t('這個節點最近一次 ECHO 失敗，送出可能連不上。')}</p>}
        {job && (
          <div className={`job ${job.status}`}>
            <p>
              {t(SEND_PHASE_LABEL[job.phase] ?? job.phase)} {job.status !== 'done' && job.status !== 'failed' ? `${job.percent}%` : ''}{' '}
              <span className={job.status === 'failed' ? 'error-text' : 'muted'}>{summarizeSend(job)}</span>
            </p>
            <progress value={job.percent} max={100} />
            {job.failed && job.failed.length > 0 && job.status === 'done' && (
              <details>
                <summary className="muted small">{t('失敗的檔')}</summary>
                <ul className="small">
                  {job.failed.slice(0, 20).map((f) => (
                    <li key={f.path}>
                      {f.path.split('/').pop()} <span className="muted">— {String(f.status)}</span>
                    </li>
                  ))}
                </ul>
              </details>
            )}
          </div>
        )}
        {error && <p className="error">{error}</p>}
        {needConfirm && (
          <label className="derived-confirm warning">
            <input type="checkbox" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} />
            {t('我了解這是 RT-Gaia 算出的衍生劑量，不是 TPS 計算結果')}
          </label>
        )}
        <div className="buttons">
          <button type="button" onClick={props.onClose} disabled={busy} data-autofocus>
            {job ? t('關閉') : t('取消')}
          </button>
          {(!job || job.status === 'failed') && (
            <button type="button" className="primary" disabled={busy || !nodeId || (needConfirm && !confirmed)} onClick={() => void send()}>
              {busy ? t('傳送中…') : job ? t('重試') : t('送出')}
            </button>
          )}
        </div>
    </Dialog>
  );
}
