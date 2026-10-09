/**
 * 封存區：已簽核的結構被刪除時放這裡，**不自動清除**。獨立頁面，只有管理者能看、改備註、救回、永久刪除。
 * 每一列可展開看完整版本鏈與簽核事件（誰畫的、誰核可、誰刪除）。
 */
import { useCallback, useEffect, useState } from 'react';

import type { Principal } from '../auth/authApi';
import { roleLabel } from '../auth/authApi';
import { BrandMenu } from '../components/AppNav';
import { retentionApi, type ArchiveDetail, type DeletedStructure } from './retentionApi';
import { describeRetentionError, fmtStudy, fmtTime } from './retentionModel';
import { t } from '../../core/i18n';

export function ArchivePage(props: { user: Principal | null }): React.JSX.Element {
  const isAdmin = props.user?.role === 'admin';
  const [items, setItems] = useState<DeletedStructure[] | null>(null);
  const [available, setAvailable] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [detail, setDetail] = useState<ArchiveDetail | null>(null);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const reload = useCallback(() => {
    if (!isAdmin) return;
    retentionApi.archive().then(
      (r) => {
        setItems(r.items);
        setAvailable(r.available);
      },
      (e: unknown) => setError(describeRetentionError(String(e))),
    );
  }, [isAdmin]);
  useEffect(reload, [reload]);
  const toggle = (it: DeletedStructure): void => {
    const key = `${it.case_id}/${it.structure_id}`;
    if (open === key) {
      setOpen(null);
      setDetail(null);
      return;
    }
    setOpen(key);
    setDetail(null);
    setNote(it.archive_note);
    retentionApi.archiveDetail(it.case_id, it.structure_id).then(setDetail, (e: unknown) => setError(describeRetentionError(String(e))));
  };
  const act = (run: () => Promise<unknown>, after?: () => void): void => {
    setBusy(true);
    setError(null);
    run()
      .then(() => {
        after?.();
        reload();
      })
      .catch((e: unknown) => setError(describeRetentionError(e instanceof Error ? e.message : String(e))))
      .finally(() => setBusy(false));
  };
  return (
    <div className="library retention-page archive-page">
      <header className="library-header">
        <BrandMenu user={props.user} section={t('封存區')} />
      </header>
      <div className="library-body">
        <section className="library-main">
          {!isAdmin ? (
            <p className="warning">{t('封存區只有管理者可以存取（你是 {p0}）。', { p0: props.user ? roleLabel(props.user.role) : t('未登入') })}</p>
          ) : (
            <>
              <p className="muted">{t('已簽核的結構被刪除時放這裡，不會自動清除。可以寫備註、救回到原病例，或永久刪除。')}</p>
              {error && <p className="error">{error}</p>}
              {!available && <p className="warning">{t('沒有資料庫：封存區不可用。')}</p>}
              {items && items.length === 0 && <p className="muted">{t('封存區是空的。')}</p>}
              {items && items.length > 0 && (
                <table className="retention-table">
                  <thead>
                    <tr>
                      <th>{t('結構')}</th>
                      <th>{t('原結構集')}</th>
                      <th>{t('病例')}</th>
                      <th>{t('刪除', { ctx: '欄位' })}</th>
                      <th>{t('備註')}</th>
                      <th />
                    </tr>
                  </thead>
                  <tbody>
                    {items.map((it) => {
                      const key = `${it.case_id}/${it.structure_id}`;
                      const isOpen = open === key;
                      return (
                        <ArchiveRow
                          key={key}
                          it={it}
                          isOpen={isOpen}
                          detail={isOpen ? detail : null}
                          note={note}
                          busy={busy}
                          onToggle={() => toggle(it)}
                          onNote={setNote}
                          onSaveNote={() => act(() => retentionApi.archiveNote(it.case_id, it.structure_id, note))}
                          onRestore={() => {
                            if (window.confirm(t('把「{name}」救回原病例？它會以「已簽核」狀態回到原結構集。', { name: it.name }))) {
                              act(() => retentionApi.restoreArchived(it.case_id, it.structure_id), () => setOpen(null));
                            }
                          }}
                          onPurge={() => {
                            if (
                              window.confirm(t('永久刪除已簽核的「{name}」與它的 {version_count} 個版本？不可復原。', { name: it.name, version_count: it.version_count })) &&
                              window.confirm(t('再確認一次：這是已簽核的臨床資料，刪除後無法救回（簽核與稽核紀錄會保留）。'))
                            ) {
                              act(() => retentionApi.purgeArchived(it.case_id, it.structure_id), () => setOpen(null));
                            }
                          }}
                        />
                      );
                    })}
                  </tbody>
                </table>
              )}
            </>
          )}
        </section>
      </div>
    </div>
  );
}

function ArchiveRow(props: {
  it: DeletedStructure;
  isOpen: boolean;
  detail: ArchiveDetail | null;
  note: string;
  busy: boolean;
  onToggle: () => void;
  onNote: (v: string) => void;
  onSaveNote: () => void;
  onRestore: () => void;
  onPurge: () => void;
}): React.JSX.Element {
  const { it } = props;
  return (
    <>
      <tr className={props.isOpen ? 'open' : undefined}>
        <td>
          <button type="button" className="linkish" onClick={props.onToggle} aria-expanded={props.isOpen}>
            {props.isOpen ? '▾' : '▸'}
          </button>{' '}
          <span className="swatch" style={{ background: `rgb(${it.color_rgb.join(',')})` }} /> {it.name}
          <span className="muted small"> {t('· {version_count} 版', { version_count: it.version_count })}</span>
        </td>
        <td>{it.set_label}</td>
        <td>
          {it.patient_id ?? '—'} <span className="muted">{fmtStudy(it.study_date, it.study_description)}</span>
        </td>
        <td className="muted">
          {it.deleted_by} · {fmtTime(it.deleted_at)}
        </td>
        <td className="muted">{it.archive_note}</td>
        <td className="actions">
          <button type="button" disabled={props.busy} onClick={props.onRestore}>
            {t('救回')}
          </button>
          <button type="button" className="danger" disabled={props.busy} onClick={props.onPurge}>
            {t('永久刪除')}
          </button>
        </td>
      </tr>
      {props.isOpen && (
        <tr className="archive-detail">
          <td colSpan={6}>
            <label className="archive-note">
              {t('備註')}
              <textarea value={props.note} rows={2} maxLength={2000} onChange={(e) => props.onNote(e.target.value)} />
              <button type="button" disabled={props.busy} onClick={props.onSaveNote}>
                {t('儲存備註')}
              </button>
            </label>
            {props.detail === null ? (
              <p className="muted">{t('載入中…')}</p>
            ) : (
              <div className="archive-history">
                <div>
                  <h4>{t('簽核事件')}</h4>
                  <ul>
                    {props.detail.review_events.map((e) => (
                      <li key={e.event_id}>
                        {t('{p0} {user}：{from_status} → {to_status}{p4}{p5}', { p0: fmtTime(e.at), user: e.user, from_status: e.from_status, to_status: e.to_status, p4: e.note ? t('「{note}」', { note: e.note }) : '', p5: e.tier ? t('（Tier {tier}）', { tier: e.tier }) : '' })}
                      </li>
                    ))}
                  </ul>
                </div>
                <div>
                  <h4>{t('版本（{length}）', { length: props.detail.versions.length })}</h4>
                  <ul>
                    {props.detail.versions.map((v) => (
                      <li key={v.version_id}>
                        {t('{p0} {created_by} · {kind} · {voxel_count} 體素{p4}', { p0: fmtTime(v.created_at), created_by: v.created_by, kind: v.kind, voxel_count: v.voxel_count, p4: v.note ? ` · ${v.note}` : '' })}
                      </li>
                    ))}
                  </ul>
                </div>
              </div>
            )}
          </td>
        </tr>
      )}
    </>
  );
}
