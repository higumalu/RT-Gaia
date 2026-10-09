/**
 * 資料頁「從資料庫移除」對話框（2026-09-15）：確認 → DELETE；有病例引用 → 顯示受影響病例，再確認一次才 force。
 * 後端不真的刪：搬進 `.rtgaia/trash/…`，對話框說明可請管理者救回。
 */

import { useState } from 'react';

import { Dialog } from '../components/Dialog';

import { CatalogInUseError, catalogApi, type AffectedCase, type DeleteResult } from './catalogApi';
import { describeAffected, describeDeleteTarget, type DeleteTarget } from './deleteModel';
import { t } from '../../core/i18n';

export function DeleteDialog(props: { target: DeleteTarget; onClose: () => void; onDeleted: (r: DeleteResult) => void }): React.JSX.Element {
  const [affected, setAffected] = useState<readonly AffectedCase[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<DeleteResult | null>(null);

  const run = async (force: boolean): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      const r = await catalogApi.delete(props.target.level, props.target.id, force);
      setDone(r);
      props.onDeleted(r);
    } catch (e) {
      if (e instanceof CatalogInUseError) setAffected(e.affectedCases);
      else setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog label={t('從資料庫移除')} className="send-dialog delete-dialog" busy={busy} onClose={props.onClose}>
        <header>
          <h3>{t('從資料庫移除')}</h3>
          <button type="button" onClick={props.onClose} aria-label={t('關閉')} disabled={busy}>
            ×
          </button>
        </header>
        <p>
          <strong>{props.target.label}</strong>
          <br />
          <span className="muted">{t('{p0}會從資料庫清單移除，之後無法在資料頁選到。復原請聯絡管理者。', { p0: describeDeleteTarget(props.target) })}</span>
          <details className="muted small">
            <summary>{t('給管理者的說明')}</summary>
            {t('檔案不會真的刪除：搬進資料庫目錄的')} <code>.rtgaia/trash/</code>{t('（含 manifest.json）。把該目錄搬回原處並按「重新掃描」即可復原。')}
          </details>
        </p>
        {done ? (
          <>
            <p className="ok">
              {t('已移除{files_moved} 個檔（{length} 個序列）{p2}。', { files_moved: done.files_moved, length: done.series_uids.length, p2: done.forced ? t('，{length} 個病例受影響', { length: done.affected_cases.length }) : '' })}
            </p>
            <div className="buttons">
              <button type="button" className="primary" onClick={props.onClose}>
                {t('關閉')}
              </button>
            </div>
          </>
        ) : (
          <>
            {affected && <p className="warning">{describeAffected(affected)}</p>}
            {error && <p className="error">{error}</p>}
            <div className="buttons">
              <button type="button" onClick={props.onClose} disabled={busy} data-autofocus>
                {t('取消')}
              </button>
              {affected ? (
                <button type="button" className="danger" disabled={busy} onClick={() => void run(true)}>
                  {busy ? t('移除中…') : t('仍要移除（{length} 個病例受影響）', { length: affected.length })}
                </button>
              ) : (
                <button type="button" className="danger" disabled={busy} onClick={() => void run(false)}>
                  {busy ? t('移除中…') : t('移除')}
                </button>
              )}
            </div>
          </>
        )}
    </Dialog>
  );
}
