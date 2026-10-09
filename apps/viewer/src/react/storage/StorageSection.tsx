/**
 * 管理 › 服務設定裡的「儲存空間」—— 各磁碟使用率（門檻）、完整性巡檢摘要、立刻巡檢、問題清單與「重設基準」。
 */

import { useCallback, useEffect, useState } from 'react';

import { formatDateTime, t } from '../../core/i18n';
import { formatSize, volumeLabel } from './model';
import { storageApi, type IntegritySummary, type StorageStatus } from './storageApi';

export function StorageSection(): React.JSX.Element {
  const [status, setStatus] = useState<StorageStatus | null>(null);
  const [integrity, setIntegrity] = useState<IntegritySummary | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(() => {
    storageApi.status().then(setStatus, (e: unknown) => setError(e instanceof Error ? e.message : String(e)));
    storageApi.integrity().then(setIntegrity, (e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  }, []);
  useEffect(load, [load]);

  const run = async (all: boolean): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      await storageApi.runIntegrity(all ? Math.max(1, integrity?.total_files ?? 1) : undefined);
      load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="storage-section" data-storage-section="true">
      <h3>{t('儲存空間')}</h3>
      {error && <p className="error">{error}</p>}
      {status && (
        <>
          <p className="muted small">{t('超過 {threshold}% 時所有使用者都會看到提醒（環境變數 RTGAIA_DISK_WARN_PERCENT）；系統不會自動刪除資料。', { threshold: status.threshold })}</p>
          <table className="admin-table storage-volumes">
            <thead>
              <tr>
                <th>{t('用途')}</th>
                <th>{t('位置')}</th>
                <th>{t('已用')}</th>
                <th>{t('可用')}</th>
                <th>{t('使用率')}</th>
              </tr>
            </thead>
            <tbody>
              {status.volumes.map((v) => (
                <tr key={v.path ?? v.labels.join()} className={v.warn ? 'is-warn' : ''}>
                  <td>{volumeLabel(v)}</td>
                  <td className="muted uid">{v.path ?? '—'}</td>
                  <td>{formatSize(v.used)} / {formatSize(v.total)}</td>
                  <td>{formatSize(v.free)}</td>
                  <td>
                    <span className="storage-bar" aria-hidden="true">
                      <i style={{ width: `${Math.min(100, v.percent)}%` }} />
                    </span>{' '}
                    {v.percent.toFixed(1)}%{v.warn ? ` ⚠` : ''}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
      <h4>{t('完整性巡檢')}</h4>
      <p className="muted small">{t('每天重算一批 DICOM 檔的 sha256（最久沒驗的先），缺檔或內容被改就列在下面並記稽核。')}</p>
      {integrity && (
        <>
          <p data-integrity-verified={integrity.verified}>
            {t('資料庫 {total} 個檔，已驗過 {verified} 個', { total: integrity.total_files, verified: integrity.verified })}
            {integrity.oldest_verified_at ? t('；最久的驗證在 {when}', { when: formatDateTime(integrity.oldest_verified_at) }) : ''}
            {integrity.last_run?.ran_at ? t('；上一輪 {when} 驗了 {n} 個', { when: formatDateTime(integrity.last_run.ran_at), n: integrity.last_run.checked }) : ''}
          </p>
          <p>
            <button type="button" disabled={busy} onClick={() => void run(false)}>
              {busy ? t('巡檢中…') : t('巡檢一輪（{n} 個）', { n: integrity.batch })}
            </button>{' '}
            <button type="button" disabled={busy} onClick={() => void run(true)} title={t('檔案多時會花一段時間')}>
              {t('全部驗一次')}
            </button>
          </p>
          {integrity.problems.length === 0 ? (
            <p className="ok small">{t('目前沒有問題')}</p>
          ) : (
            <table className="admin-table storage-problems">
              <thead>
                <tr>
                  <th>{t('狀態')}</th>
                  <th>{t('檔案')}</th>
                  <th>{t('說明')}</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {integrity.problems.map((p) => (
                  <tr key={p.path} data-problem={p.verify_status}>
                    <td className="error-text">{p.verify_status === 'missing' ? t('缺檔') : t('內容被改')}</td>
                    <td className="uid">{p.path}</td>
                    <td className="muted">{p.detail}</td>
                    <td>
                      {p.verify_status === 'mismatch' && (
                        <button
                          type="button"
                          className="linkish"
                          title={t('確認這是合法的變動：以現在的內容為新基準（會留稽核）')}
                          onClick={() => void storageApi.rebaseline([p.path]).then(load, (e: unknown) => setError(e instanceof Error ? e.message : String(e)))}
                        >
                          {t('重設基準')}
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </>
      )}
    </section>
  );
}
