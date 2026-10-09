/**
 * 工作清單：所有病例依狀態分類，一鍵開啟。資料頁的日常入口 ——
 * 回答「哪些病例待簽核／已簽核／已匯出」。
 */
import { useEffect, useState } from 'react';

import { catalogApi, type WorklistCase } from './catalogApi';
import { countsText, filterWorklist, sortWorklist, STATUS_LABEL, STATUS_ORDER, type WorklistFilter } from './worklist';
import { joinList, t } from '../../core/i18n';

function fmtDate(v: string | null | undefined): string {
  if (!v) return '';
  if (/^\d{8}$/.test(v)) return `${v.slice(0, 4)}-${v.slice(4, 6)}-${v.slice(6, 8)}`;
  return v.replace('T', ' ').slice(0, 16);
}

export function WorklistPanel(props: { me: string | null; onOpen: (c: WorklistCase) => void; onClose: () => void; opening: boolean }): React.JSX.Element {
  const [cases, setCases] = useState<WorklistCase[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<WorklistFilter>('all');
  const [onlyMine, setOnlyMine] = useState(false);
  useEffect(() => {
    let cancelled = false;
    catalogApi.worklist().then(
      (rows) => {
        if (!cancelled) setCases(rows);
      },
      (e: unknown) => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      },
    );
    return () => {
      cancelled = true;
    };
  }, []);
  const shown = cases ? sortWorklist(filterWorklist(cases, filter, onlyMine ? props.me : null)) : [];
  const countOf = (f: WorklistFilter): number => (cases ? filterWorklist(cases, f, onlyMine ? props.me : null).length : 0);
  return (
    <section className="worklist" aria-label={t('工作清單')}>
      <header>
        <strong>{t('工作清單')}</strong>
        <span className="chips">
          {(['all', ...STATUS_ORDER] as WorklistFilter[]).map((f) => (
            <button key={f} type="button" aria-pressed={filter === f} onClick={() => setFilter(f)}>
              {f === 'all' ? t('全部') : STATUS_LABEL[f]} {cases ? `(${countOf(f)})` : ''}
            </button>
          ))}
        </span>
        {props.me && (
          <label className="only-mine">
            <input type="checkbox" checked={onlyMine} onChange={(e) => setOnlyMine(e.target.checked)} /> {t('只看與我有關')}
          </label>
        )}
        <button type="button" className="close" onClick={props.onClose} title={t('關閉工作清單')}>
          ×
        </button>
      </header>
      {error && <p className="error">{error}</p>}
      {cases === null && !error && <p className="muted">{t('載入中…')}</p>}
      {cases !== null && shown.length === 0 && <p className="muted">{t('沒有符合的病例。')}</p>}
      {shown.length > 0 && (
        <table className="worklist-table">
          <thead>
            <tr>
              <th>{t('狀態')}</th>
              <th>{t('病歷號')}</th>
              <th>Study</th>
              <th>{t('結構')}</th>
              <th>{t('最近更新')}</th>
              <th>{t('在線')}</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {shown.map((c) => (
              <tr key={c.case_id} data-status={c.status}>
                <td>
                  <span className={`badge case-status case-status-${c.status}`}>{t(STATUS_LABEL[c.status])}</span>
                </td>
                <td>{c.patient_id ?? <span className="muted">—</span>}</td>
                <td>
                  {fmtDate(c.study_date)} <span className="muted">{c.study_description || c.description}</span>
                </td>
                <td className="muted">{countsText(c)}</td>
                <td className="muted" title={c.last_export_at ? t('最近匯出 {p0}', { p0: fmtDate(c.last_export_at) }) : undefined}>
                  {fmtDate(c.updated_at)} {c.created_by ? <span className="muted">· {c.created_by}</span> : null}
                </td>
                <td className="muted">{joinList(c.open_users)}</td>
                <td className="actions">
                  <button type="button" className="primary" disabled={props.opening || !c.selection} onClick={() => props.onOpen(c)} title={t('以這個病例的選取開啟檢視器')}>
                    {t('開啟')}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
