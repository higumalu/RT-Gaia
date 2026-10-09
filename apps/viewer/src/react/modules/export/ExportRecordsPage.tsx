/**
 * 匯出紀錄頁 —— `#/exports`，所有角色可看（重送要勾畫以上，後端擋）。
 * 每次資料離開系統一筆：下載 RTSTRUCT、存入資料庫、C-STORE 送出；依 PatientID／匯出的人／種類／狀態篩選。
 * 檢視器匯出面板底下是同一份清單的「這個病例」版本。
 */

import { useCallback, useEffect, useState } from 'react';

import type { Principal } from '../../auth/authApi';
import { BrandMenu } from '../../components/AppNav';
import { ExportRecordList } from './ExportRecordList';
import { exportRecordsApi, type ExportRecord, type RecordFilters } from './exportRecords';
import { t } from '../../../core/i18n';

export function ExportRecordsPage(props: { user: Principal | null }): React.JSX.Element {
  const [filters, setFilters] = useState<RecordFilters>({ patient_id: '', user: '', kind: '', status: '', limit: 200 });
  const [records, setRecords] = useState<ExportRecord[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const reload = useCallback(() => {
    exportRecordsApi.list(filters).then(
      (r) => {
        setRecords(r.items);
        setError(null);
      },
      (e: unknown) => setError(e instanceof Error ? e.message : String(e)),
    );
  }, [filters]);
  useEffect(() => {
    const t = setTimeout(reload, 200);
    return () => clearTimeout(t);
  }, [reload]);
  const set = (patch: Partial<RecordFilters>): void => setFilters((f) => ({ ...f, ...patch }));
  return (
    <div className="library export-records-page">
      <header className="library-header">
        <BrandMenu user={props.user} section={t('匯出紀錄')} />
      </header>
      <div className="library-body">
        <section className="library-main">
          <p className="muted">{t('每次下載 RTSTRUCT、存入資料庫、送到節點都有一筆（成功與失敗都記）：誰、何時、哪些版本、送去哪。可以重新下載當時那份檔，或重送到節點。')}</p>
          <form className="library-search" onSubmit={(e) => e.preventDefault()}>
            <label>
              PatientID
              <input value={filters.patient_id ?? ''} onChange={(e) => set({ patient_id: e.target.value })} />
            </label>
            <label>
              {t('匯出的人')}
              <input value={filters.user ?? ''} onChange={(e) => set({ user: e.target.value })} />
            </label>
            <label>
              {t('種類')}
              <select value={filters.kind ?? ''} onChange={(e) => set({ kind: e.target.value as RecordFilters['kind'] })}>
                <option value="">{t('全部')}</option>
                <option value="rtstruct">{t('RTSTRUCT（下載／存入資料庫）')}</option>
                <option value="push">{t('送到節點')}</option>
              </select>
            </label>
            <label>
              {t('狀態')}
              <select value={filters.status ?? ''} onChange={(e) => set({ status: e.target.value as RecordFilters['status'] })}>
                <option value="">{t('全部')}</option>
                <option value="done">{t('完成')}</option>
                <option value="failed">{t('失敗')}</option>
              </select>
            </label>
          </form>
          {error && <p className="error">{error}</p>}
          {records === null ? <p className="muted">{t('載入中…')}</p> : <ExportRecordList records={records} onChanged={reload} showPatient />}
        </section>
      </div>
    </div>
  );
}
