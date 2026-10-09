/**
 * 匯入面板的「從節點拉」區塊：選節點 → C-FIND（study 列可展 series）→ 勾 →
 * 拉回（節點支援 C-GET 就 get，否則 move）→ job 進度 → 完成後通知資料頁刷新。
 * 純邏輯在 `../dimse/model.ts`。
 */

import { useEffect, useState } from 'react';

import { dimseApi, type DicomNode, type RemoteJob } from '../dimse/dimseApi';
import {
  EMPTY_REMOTE_QUERY,
  hasRemoteQuery,
  pageOf,
  queryableNodes,
  RETRIEVE_PHASE_LABEL,
  retrieveBody,
  retrieveMethod,
  sortSeries,
  studyQuery,
  summarizeRetrieve,
  toRemoteSeries,
  toRemoteStudy,
  type RemoteQuery,
  type RemoteSeries,
  type RemoteStudy,
} from '../dimse/model';
import { formatDicomDate } from './selection';
import { t } from '../../core/i18n';

const POLL_MS = 800;
/** study 結果一頁幾筆（C-FIND 一次拿滿上限 500，前端分頁）。 */
const PAGE_SIZE = 25;

export function RemotePull(props: { onImported: () => void }): React.JSX.Element {
  const [nodes, setNodes] = useState<DicomNode[] | null>(null);
  const [nodeId, setNodeId] = useState('');
  const [query, setQuery] = useState<RemoteQuery>(EMPTY_REMOTE_QUERY);
  const [studies, setStudies] = useState<RemoteStudy[] | null>(null);
  const [truncated, setTruncated] = useState<number | null>(null);
  const [page, setPage] = useState(0);
  const [series, setSeries] = useState<Record<string, RemoteSeries[] | 'loading'>>({});
  const [pickedStudies, setPickedStudies] = useState<Set<string>>(new Set());
  const [pickedSeries, setPickedSeries] = useState<Set<string>>(new Set());
  const [job, setJob] = useState<RemoteJob | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    dimseApi.nodes().then(
      (all) => {
        const q = queryableNodes(all);
        setNodes(q);
        if (q[0] && !nodeId) setNodeId(q[0].node_id);
      },
      () => setNodes([]),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 只在掛載時載一次節點
  }, []);

  const node = nodes?.find((n) => n.node_id === nodeId) ?? null;

  const search = async (): Promise<void> => {
    if (!node) return;
    setBusy(true);
    setError(null);
    setStudies(null);
    setSeries({});
    setPickedStudies(new Set());
    setPickedSeries(new Set());
    try {
      const r = await dimseApi.find(node.node_id, 'study', studyQuery(query));
      setStudies(r.rows.map(toRemoteStudy).filter((s) => s.studyUid));
      setTruncated(r.truncated ? (r.max_results ?? r.total) : null);
      setPage(0);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const expand = async (s: RemoteStudy): Promise<void> => {
    if (!node || series[s.studyUid]) {
      if (series[s.studyUid] && series[s.studyUid] !== 'loading') setSeries((m) => {
        const next = { ...m };
        delete next[s.studyUid];
        return next;
      });
      return;
    }
    setSeries((m) => ({ ...m, [s.studyUid]: 'loading' }));
    try {
      const r = await dimseApi.find(node.node_id, 'series', { StudyInstanceUID: s.studyUid });
      setSeries((m) => ({ ...m, [s.studyUid]: sortSeries(r.rows.map(toRemoteSeries).filter((x) => x.seriesUid)) }));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setSeries((m) => {
        const next = { ...m };
        delete next[s.studyUid];
        return next;
      });
    }
  };

  const toggleStudy = (uid: string): void => {
    setPickedStudies((prev) => {
      const next = new Set(prev);
      if (next.has(uid)) next.delete(uid);
      else next.add(uid);
      return next;
    });
    // 勾了整個 study 就不必留它底下的 series
    setPickedSeries((prev) => {
      const list = series[uid];
      if (!Array.isArray(list)) return prev;
      const next = new Set(prev);
      for (const s of list) next.delete(s.seriesUid);
      return next;
    });
  };
  const toggleSeries = (s: RemoteSeries): void =>
    setPickedSeries((prev) => {
      const next = new Set(prev);
      if (next.has(s.seriesUid)) next.delete(s.seriesUid);
      else next.add(s.seriesUid);
      return next;
    });

  const pull = async (): Promise<void> => {
    if (!node) return;
    setBusy(true);
    setError(null);
    try {
      const method = retrieveMethod(node);
      let j = await dimseApi.retrieve(node.node_id, retrieveBody(pickedStudies, pickedSeries, method));
      setJob(j);
      while (j.status !== 'done' && j.status !== 'failed') {
        await new Promise((r) => setTimeout(r, POLL_MS));
        j = await dimseApi.job(j.job_id);
        setJob(j);
      }
      if (j.status === 'done') {
        setPickedStudies(new Set());
        setPickedSeries(new Set());
        props.onImported();
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const picked = pickedStudies.size + pickedSeries.size;
  if (nodes !== null && nodes.length === 0) {
    return (
      <section className="remote-pull">
        <h4>{t('從節點拉（C-FIND → C-MOVE／C-GET）')}</h4>
        <p className="muted">{t('還沒有可查詢的節點。請管理者在「管理 › DICOM 節點」新增一個可送出、支援 FIND 的 PACS／TPS。')}</p>
      </section>
    );
  }
  return (
    <section className="remote-pull">
      <h4>{t('從節點拉（C-FIND → C-MOVE／C-GET）')}</h4>
      <form
        className="remote-query"
        onSubmit={(e) => {
          e.preventDefault();
          if (!busy && node) void search();
        }}
      >
        <label>
          {t('節點')}
          <select value={nodeId} onChange={(e) => setNodeId(e.target.value)}>
            {(nodes ?? []).map((n) => (
              <option key={n.node_id} value={n.node_id}>
                {t('{name}（{ae_title}）', { name: n.name, ae_title: n.ae_title })}
              </option>
            ))}
          </select>
        </label>
        <label>
          PatientID
          <input value={query.patientId} onChange={(e) => setQuery({ ...query, patientId: e.target.value })} />
        </label>
        <label>
          {t('姓名')}
          <input value={query.patientName} onChange={(e) => setQuery({ ...query, patientName: e.target.value })} />
        </label>
        <label>
          {t('日期從')}
          <input type="date" onChange={(e) => setQuery({ ...query, dateFrom: e.target.value.replace(/-/g, '') })} />
        </label>
        <label>
          {t('到')}
          <input type="date" onChange={(e) => setQuery({ ...query, dateTo: e.target.value.replace(/-/g, '') })} />
        </label>
        <label>
          {t('模態')}
          <input value={query.modality} placeholder="CT" onChange={(e) => setQuery({ ...query, modality: e.target.value })} />
        </label>
        <button type="submit" disabled={busy || !node}>
          {busy && studies === null ? t('查詢中…') : t('查詢')}
        </button>
        {!hasRemoteQuery(query) && <span className="muted small">{t('沒有條件會列出對方全部 study（可能很多）。')}</span>}
      </form>
      {error && <p className="error">{error}</p>}
      {studies !== null && (
        <div className="remote-results">
          {(() => {
            const pg = pageOf(studies, page, PAGE_SIZE);
            return (
              <p className="muted small remote-paging" data-page={pg.page} data-pages={pg.pages}>
                {t('{length} 個 study', { length: studies.length })}
                {pg.pages > 1 && (
                  <>
                    {' · '}
                    {t('第 {from}–{to} 筆', { from: pg.from, to: pg.to })}{' '}
                    <button type="button" className="linkish" disabled={pg.page === 0} onClick={() => setPage(pg.page - 1)}>
                      {t('上一頁')}
                    </button>{' '}
                    <button type="button" className="linkish" disabled={pg.page >= pg.pages - 1} onClick={() => setPage(pg.page + 1)}>
                      {t('下一頁')}
                    </button>
                  </>
                )}
                {truncated !== null && <span className="error-text">{' · '}{t('結果超過 {n} 筆，只收了前 {n} 筆 —— 請縮小條件（日期、PatientID、模態）', { n: truncated })}</span>}
              </p>
            );
          })()}
          <ul className="remote-studies">
            {pageOf(studies, page, PAGE_SIZE).items.map((s) => {
              const kids = series[s.studyUid];
              const open = kids !== undefined;
              return (
                <li key={s.studyUid} data-picked={pickedStudies.has(s.studyUid) ? 'true' : undefined}>
                  <div className="remote-study-row">
                    <input type="checkbox" checked={pickedStudies.has(s.studyUid)} onChange={() => toggleStudy(s.studyUid)} title={t('拉整個 study')} />
                    <button type="button" className="linkish" onClick={() => void expand(s)} aria-expanded={open}>
                      {open ? '▾' : '▸'}
                    </button>
                    <span className="pid">{s.patientId}</span>
                    {s.patientName && <span className="muted">{s.patientName}</span>}
                    <span>{formatDicomDate(s.date)}</span>
                    <span className="muted">{s.description}</span>
                    <span className="muted">{s.modalities.join('/')}</span>
                    {s.instanceCount !== null && <span className="muted">{t('{instanceCount} 檔', { instanceCount: s.instanceCount })}</span>}
                  </div>
                  {kids === 'loading' && <p className="muted small">{t('載入 series…')}</p>}
                  {Array.isArray(kids) && (
                    <ul className="remote-series">
                      {kids.map((x) => (
                        <li key={x.seriesUid}>
                          <label>
                            <input type="checkbox" disabled={pickedStudies.has(s.studyUid)} checked={pickedStudies.has(s.studyUid) || pickedSeries.has(x.seriesUid)} onChange={() => toggleSeries(x)} />
                            <span className={`badge ${x.modality.toLowerCase()}`}>{x.modality}</span> #{x.number} {x.description}
                            {x.instanceCount !== null && <span className="muted"> {t('· {instanceCount} 檔', { instanceCount: x.instanceCount })}</span>}
                          </label>
                        </li>
                      ))}
                      {kids.length === 0 && <li className="muted">{t('（沒有 series）')}</li>}
                    </ul>
                  )}
                </li>
              );
            })}
          </ul>
          <div className="buttons">
            <button type="button" className="primary" disabled={busy || picked === 0 || !node} onClick={() => void pull()}>
              {node ? t('拉回 {picked} 項（{p1}）', { picked, p1: retrieveMethod(node) === 'get' ? 'C-GET' : 'C-MOVE' }) : t('拉回')}
            </button>
            {node && retrieveMethod(node) === 'move' && <span className="muted small">{t('C-MOVE：對方要先登錄我方 AE Title（{move_destination_aet}）。', { move_destination_aet: node.move_destination_aet })}</span>}
          </div>
        </div>
      )}
      {job && (
        <div className={`job ${job.status}`}>
          <p>
            {t(RETRIEVE_PHASE_LABEL[job.phase] ?? job.phase)} {job.percent}% <span className="muted">{summarizeRetrieve(job)}</span>
          </p>
          <progress value={job.percent} max={100} />
        </div>
      )}
    </section>
  );
}
