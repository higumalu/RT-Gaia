/**
 * 暫存區：刪除的結構與資料頁移除的 DICOM 放這裡，`days` 天後自動永久清除；期間可救回或手動清除。
 * 一般使用者看到自己刪的；管理者看到全部，外加資料頁移除的 DICOM。已簽核的被刪會進封存區（`#/archive`），不在這裡。
 */
import { useCallback, useEffect, useState } from 'react';

import type { Principal } from '../auth/authApi';
import { BrandMenu } from '../components/AppNav';
import { retentionApi, type TrashListing } from './retentionApi';
import { daysLeft, describeRetentionError, fmtStudy, fmtTime } from './retentionModel';
import { t } from '../../core/i18n';

export function TrashPage(props: { user: Principal | null }): React.JSX.Element {
  const [data, setData] = useState<TrashListing | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const reload = useCallback(() => {
    retentionApi.trash().then(setData, (e: unknown) => setError(describeRetentionError(String(e))));
  }, []);
  useEffect(reload, [reload]);
  const act = (key: string, run: () => Promise<unknown>): void => {
    setBusy(key);
    setError(null);
    run()
      .then(reload)
      .catch((e: unknown) => setError(describeRetentionError(e instanceof Error ? e.message : String(e))))
      .finally(() => setBusy(null));
  };
  return (
    <div className="library retention-page">
      <header className="library-header">
        <BrandMenu user={props.user} section={t('暫存區')} />
      </header>
      <div className="library-body">
        <section className="library-main">
          <p className="muted">
            {t('刪除的東西先放這裡，{p0}天後自動永久清除；期間可以救回，也可以手動清除。已簽核的結構被刪除時會進封存區（只有管理者可見）。{p1}', { p0: data?.days ?? 14, p1: data && !data.is_admin ? t(' 這裡只列出你自己刪除的。') : '' })}
          </p>
          {error && <p className="error">{error}</p>}
          {data && !data.available && <p className="warning">{t('沒有資料庫：刪除的結構不會進暫存區。')}</p>}
          <h3>{t('結構（{p0}）', { p0: data?.items.length ?? 0 })}</h3>
          {data && data.items.length === 0 && <p className="muted">{t('暫存區是空的。')}</p>}
          {data && data.items.length > 0 && (
            <table className="retention-table">
              <thead>
                <tr>
                  <th>{t('結構')}</th>
                  <th>{t('原結構集')}</th>
                  <th>{t('病例')}</th>
                  <th>{t('刪除', { ctx: '欄位' })}</th>
                  <th>{t('剩餘')}</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {data.items.map((it) => {
                  const key = `${it.case_id}/${it.structure_id}`;
                  const left = daysLeft(it.expires_at);
                  return (
                    <tr key={key}>
                      <td>
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
                      <td className={left !== null && left <= 2 ? 'warning' : 'muted'}>{left === null ? '' : t('{left} 天', { left })}</td>
                      <td className="actions">
                        <button type="button" disabled={busy !== null} onClick={() => act(key, () => retentionApi.restoreStructure(it.case_id, it.structure_id))}>
                          {t('救回')}
                        </button>
                        <button
                          type="button"
                          className="danger"
                          disabled={busy !== null}
                          onClick={() => {
                            if (window.confirm(t('永久清除「{name}」與它的 {version_count} 個版本？不可復原（簽核與稽核紀錄會保留）。', { name: it.name, version_count: it.version_count }))) {
                              act(key, () => retentionApi.purgeStructure(it.case_id, it.structure_id));
                            }
                          }}
                        >
                          {t('永久清除')}
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
          {data?.is_admin && (
            <>
              <h3>{t('資料頁移除的 DICOM（{length}）', { length: data.library.length })}</h3>
              {data.library.length === 0 && <p className="muted">{t('沒有。')}</p>}
              {data.library.length > 0 && (
                <table className="retention-table">
                  <thead>
                    <tr>
                      <th>{t('層級')}</th>
                      <th>{t('鍵')}</th>
                      <th>{t('檔案')}</th>
                      <th>{t('刪除', { ctx: '欄位' })}</th>
                      <th>{t('剩餘')}</th>
                      <th />
                    </tr>
                  </thead>
                  <tbody>
                    {data.library.map((it) => {
                      const left = daysLeft(it.expires_at);
                      return (
                        <tr key={it.item_id}>
                          <td>{it.level}</td>
                          <td className="mono small">{it.key}</td>
                          <td>{it.file_count}</td>
                          <td className="muted">
                            {it.deleted_by} · {fmtTime(it.deleted_at)}
                          </td>
                          <td className="muted">{left === null ? '' : t('{left} 天', { left })}</td>
                          <td className="actions">
                            <button type="button" disabled={busy !== null} onClick={() => act(it.item_id, () => retentionApi.restoreLibrary(it.item_id))}>
                              {t('救回')}
                            </button>
                            <button
                              type="button"
                              className="danger"
                              disabled={busy !== null}
                              onClick={() => {
                                if (window.confirm(t('永久刪除這 {file_count} 個 DICOM 檔？不可復原。', { file_count: it.file_count }))) act(it.item_id, () => retentionApi.purgeLibrary(it.item_id));
                              }}
                            >
                              {t('永久清除')}
                            </button>
                          </td>
                        </tr>
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
