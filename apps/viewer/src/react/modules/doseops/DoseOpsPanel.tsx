/**
 * 劑量運算結果面板 —— `right-sidebar`，`'dose-ops'` 模式開著時（工具列「劑量運算」）。
 *
 * 2026-10-02 起建立結果的操作都在左側「劑量」面板（選劑量 → 套用 REG／同一個空間的運算）；這裡列出暫存結果、
 * 差值統計、存成 RTDOSE、丟棄。左側按「存檔…」會打開這裡那個結果的存檔表單。
 */

import { useCallback, useEffect, useState } from 'react';

import type { ViewerPanelProps } from '../../panels/types';
import { DoseSaveForm } from './DoseSaveForm';
import { SignedStats } from './SignedStats';
import { DOSE_OPS_MODULE_ID, type DoseOpsModuleState } from './state';
import { summaryText, type DoseOpResult } from './model';
import { t } from '../../../core/i18n';

export function DoseOpsPanel({ api }: ViewerPanelProps): React.JSX.Element {
  const { studyId, layers } = api.state;
  const doseKey = layers
    .filter((l) => l.kind === 'dose')
    .map((l) => l.layerId)
    .join('|');
  const [results, setResults] = useState<DoseOpResult[]>([]);
  const [open, setOpen] = useState<{ id: string; what: 'save' | 'stats' } | null>(null);
  const { http } = api;
  const { setError } = api.commands;
  const focus = (api.state.modules[DOSE_OPS_MODULE_ID] as DoseOpsModuleState | undefined)?.focus;
  useEffect(() => {
    if (focus) {
      setOpen({ id: focus, what: 'save' });
      api.commands.setModuleState(DOSE_OPS_MODULE_ID, { focus: undefined });
    }
  }, [focus, api.commands]);
  const reload = useCallback(async (): Promise<void> => {
    if (!studyId) return;
    try {
      setResults((await http.getJson<{ results: DoseOpResult[] }>(`/studies/${encodeURIComponent(studyId)}/dose-ops`)).results);
    } catch (e) {
      setError(t('劑量運算：{msg}', { msg: e instanceof Error ? e.message : String(e) }));
    }
  }, [http, studyId, setError]);
  useEffect(() => {
    void reload();
  }, [reload, doseKey]);
  const discard = async (r: DoseOpResult): Promise<void> => {
    if (!studyId) return;
    try {
      await http.deleteJson(`/studies/${encodeURIComponent(studyId)}/dose-ops/${encodeURIComponent(r.series_id)}`);
      if (open?.id === r.series_id) setOpen(null);
      await reload();
    } catch (e) {
      setError(t('丟棄失敗：{msg}', { msg: e instanceof Error ? e.message : String(e) }));
    }
  };
  return (
    <div className="panel dose-ops-panel">
      <h3>{t('劑量運算')}</h3>
      <p className="muted small">{t('在左側「劑量」面板選一個劑量，再「套用 REG」或跟同一個空間的劑量運算；這裡列出結果、存成 RTDOSE。')}</p>
      <p className="muted small">{t('結果先暫存（只有你看得到、關掉病例就消失），要留下來請「存成 RTDOSE」。')}</p>
      <section className="dose-op-results">
        <h4>{t('暫存結果')}</h4>
        {results.length === 0 && <p className="muted">{t('（還沒有）')}</p>}
        <ul>
          {results.map((r) => (
            <li key={r.series_id} data-series={r.series_id} data-signed={r.signed ? 'true' : 'false'}>
              <div>
                <strong>{r.text}</strong> <span className="badge">{r.dose_type}</span>
              </div>
              <div className="muted small">{summaryText(r)}</div>
              {r.warnings.length > 0 && (
                <ul className="warning small">
                  {r.warnings.map((w) => (
                    <li key={w}>{w}</li>
                  ))}
                </ul>
              )}
              <div className="buttons small">
                {r.signed && (
                  <button type="button" aria-pressed={open?.id === r.series_id && open.what === 'stats'} onClick={() => setOpen(open?.id === r.series_id && open.what === 'stats' ? null : { id: r.series_id, what: 'stats' })}>
                    {t('差值統計')}
                  </button>
                )}
                <button type="button" aria-pressed={open?.id === r.series_id && open.what === 'save'} onClick={() => setOpen(open?.id === r.series_id && open.what === 'save' ? null : { id: r.series_id, what: 'save' })}>
                  {t('存成 RTDOSE…')}
                </button>
                <button type="button" onClick={() => void discard(r)} title={t('丟棄這個暫存結果（用過它的其他結果不受影響）')}>
                  {t('丟棄')}
                </button>
              </div>
              {open?.id === r.series_id && open.what === 'stats' && <SignedStats api={api} seriesId={r.series_id} />}
              {open?.id === r.series_id && open.what === 'save' && <DoseSaveForm api={api} result={r} />}
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
