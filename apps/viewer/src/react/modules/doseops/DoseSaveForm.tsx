/**
 * 劑量運算結果「存成 RTDOSE」：下載或存入資料庫；DICOM 值可自訂（白名單同 RS 匯出、去掉結構集欄位）；
 * `DoseType`／`DoseUnits`／`DoseSummationType` 由運算決定 —— 唯一例外：減法的結果全部 ≥ 0 時可改 PHYSICAL，要再確認一次。
 * 完成後可下載、送到節點（衍生劑量要再確認）。
 */

import { useEffect, useRef, useState } from 'react';

import type { ViewerPanelProps } from '../../panels/types';
import { SendToNode } from '../export/SendToNode';
import { formatBytes, isTerminal, TAG_LABEL, tagProblems, type EditableTag, type JobInfo } from '../export/model';
import { saveBody, type DoseOpResult } from './model';
import { joinClauses, t } from '../../../core/i18n';

const POLL_MS = 600;

interface DoseJobInfo extends JobInfo {
  readonly dose_type?: string;
  readonly summation_type?: string;
  readonly series_description?: string;
}

export function DoseSaveForm({ api, result }: { api: ViewerPanelProps['api']; result: DoseOpResult }): React.JSX.Element {
  const [purpose, setPurpose] = useState<'download' | 'library'>('download');
  const [anonymize, setAnonymize] = useState(true);
  const [whitelist, setWhitelist] = useState<EditableTag[]>([]);
  const [tags, setTags] = useState<Record<string, string>>({});
  const [physical, setPhysical] = useState(false);
  const [confirmPhysical, setConfirmPhysical] = useState(false);
  const [busy, setBusy] = useState(false);
  const [job, setJob] = useState<DoseJobInfo | null>(null);
  const alive = useRef(true);
  const { http } = api;
  useEffect(() => {
    alive.current = true;
    http.getJson<{ tags: EditableTag[] }>('/export/tags?format=rtdose').then((r) => setWhitelist(r.tags), () => setWhitelist([]));
    return () => {
      alive.current = false;
    };
  }, [http]);
  const problems = tagProblems(tags, whitelist);
  const doseType = physical ? 'PHYSICAL' : result.dose_type;
  const blocked = result.save_problem !== null || problems.length > 0 || (physical && !confirmPhysical);

  const run = async (): Promise<void> => {
    setBusy(true);
    try {
      const started = await http.postJson<{ job_id: string }>(
        `/dose/${encodeURIComponent(result.series_id)}/save`,
        saveBody({ purpose, anonymize, tags, physical, confirmPhysical }),
      );
      for (;;) {
        const j = await http.getJson<DoseJobInfo>(`/jobs/${encodeURIComponent(started.job_id)}`);
        if (!alive.current) return;
        setJob(j);
        if (isTerminal(j.status)) break;
        await new Promise((r) => setTimeout(r, POLL_MS));
      }
    } catch (e) {
      api.commands.setError(t('存成 RTDOSE 失敗：{msg}', { msg: e instanceof Error ? e.message : String(e) }));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="dose-save-form">
      {result.save_problem !== null && <p className="warning">{result.save_problem}</p>}
      <dl className="small">
        <dt>DoseType</dt>
        <dd>{doseType}</dd>
        <dt>DoseSummationType</dt>
        <dd>{result.summation_type_for_save ?? '—'}</dd>
        <dt>{t('參照計畫')}</dt>
        <dd>{result.plan_sop_uids.length}</dd>
      </dl>
      {result.physical_allowed && (
        <fieldset className="dose-type-choice">
          <legend>DoseType</legend>
          <label>
            <input type="radio" name={`dt-${result.series_id}`} checked={!physical} onChange={() => setPhysical(false)} />
            {t('ERROR（差值，預設）')}
          </label>
          <label title={t('例：剩餘劑量 ＝ 計畫 − 已照；結果全部 ≥ 0 才能選')}>
            <input type="radio" name={`dt-${result.series_id}`} checked={physical} onChange={() => setPhysical(true)} />
            {t('PHYSICAL（當成一般劑量）')}
          </label>
          {physical && (
            <label className="warning">
              <input type="checkbox" checked={confirmPhysical} onChange={(e) => setConfirmPhysical(e.target.checked)} />
              {t('我了解 TPS 會把它當成一般的物理劑量')}
            </label>
          )}
        </fieldset>
      )}
      <fieldset className="export-purpose">
        <legend>{t('目的')}</legend>
        <label>
          <input type="radio" name={`dp-${result.series_id}`} checked={purpose === 'download'} onChange={() => setPurpose('download')} />
          {t('下載檔案')} <span className="muted">{t('（之後也可送到節點）')}</span>
        </label>
        <label title={t('存成 RTDOSE 進資料庫：掛在網格那組影像底下、標「衍生劑量」')}>
          <input type="radio" name={`dp-${result.series_id}`} checked={purpose === 'library'} onChange={() => setPurpose('library')} />
          {t('存入資料庫')} <span className="muted">{t('（一律帶病人識別）')}</span>
        </label>
        {purpose === 'download' && (
          <label className="anonymize sub">
            <input type="checkbox" checked={anonymize} onChange={(e) => setAnonymize(e.target.checked)} />
            {t('匿名化（病人識別以假名取代）')}
          </label>
        )}
      </fieldset>
      <details className="export-tags">
        <summary>{t('DICOM 標籤（選填，留空用預設）')}</summary>
        <div className="tag-grid">
          {whitelist.map((tag) => (
            <label key={tag.keyword} title={t('{keyword} · {vr} · 最多 {max_length} 字{p3}', { keyword: tag.keyword, vr: tag.vr, max_length: tag.max_length, p3: tag.phi ? ' · PHI' : '' })}>
              <span className={tag.phi ? 'phi' : undefined}>{t(TAG_LABEL[tag.keyword] ?? tag.keyword)}</span>
              <input
                value={tags[tag.keyword] ?? ''}
                maxLength={tag.max_length}
                placeholder={tag.keyword === 'SeriesDescription' ? t('RT-Gaia 劑量運算') : tag.phi ? (anonymize && purpose === 'download' ? t('假名') : t('沿用原影像')) : t('預設')}
                onChange={(e) => setTags((prev) => ({ ...prev, [tag.keyword]: e.target.value }))}
              />
            </label>
          ))}
        </div>
        {problems.length > 0 && <p className="warning">{joinClauses(problems)}</p>}
      </details>
      <button type="button" className="primary" disabled={busy || blocked} onClick={() => void run()}>
        {busy ? t('寫檔中…') : purpose === 'library' ? t('存入資料庫') : t('產生並下載')}
      </button>
      {job && (
        <div className={`job ${job.status}`}>
          {job.status === 'done' && (
            <>
              <p>
                <a className="download" href={job.download_url ?? '#'}>
                  {t('⤓ 下載{p0}', { p0: formatBytes(job.bytes) })}
                </a>{' '}
                <span className="muted">
                  {job.dose_type} · {job.summation_type} · {job.anonymized ? t('匿名') : t('含病人識別')}
                </span>
              </p>
              {job.saved_to_library && <p className="ok">{t('已存入資料庫：資料頁該影像底下多了一個「衍生劑量」。要在病例裡用它請重新從資料頁選取。')}</p>}
              {job.anonymize_forced_reason && <p className="muted small">{job.anonymize_forced_reason}</p>}
              <SendToNode exportJobId={job.job_id} caseId={api.state.caseId ?? null} derived />
            </>
          )}
          {job.status === 'failed' && <p className="error">{job.error}</p>}
        </div>
      )}
    </div>
  );
}
