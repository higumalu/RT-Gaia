/**
 * 管理頁「服務設定」分頁 —— 我方 SCP／SCU 設定（可改，存 DB、接收端熱重啟）、
 * 接收端狀態、唯讀的環境變數區。純邏輯在 `model.ts`。
 */

import { useCallback, useEffect, useState } from 'react';

import { dimseApi, type DimseSettings, type SettingsView } from './dimseApi';
import { needsRestart, peerSyncWarnings, SETTING_LABEL, settingsPatch, settingsProblems } from './model';
import { joinClauses, t } from '../../core/i18n';

export function ServiceTab(): React.JSX.Element {
  const [view, setView] = useState<SettingsView | null>(null);
  const [form, setForm] = useState<DimseSettings | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    dimseApi.settings().then(
      (v) => {
        setView(v);
        setForm({ ...v.dimse });
      },
      (e: unknown) => setError(e instanceof Error ? e.message : String(e)),
    );
  }, []);
  useEffect(load, [load]);

  if (view === null || form === null) return error ? <p className="error">{error}</p> : <p className="muted">{t('載入中…')}</p>;

  const patch = settingsPatch(view.dimse, form);
  const dirty = Object.keys(patch).length > 0;
  const problems = settingsProblems(form);
  const warnings = peerSyncWarnings(view.dimse, form);
  const set = <K extends keyof DimseSettings>(k: K, v: DimseSettings[K]): void => setForm({ ...form, [k]: v });
  const src = (k: keyof DimseSettings): string => (view.sources[k] === 'db' ? t('已在頁面上改過') : t('環境變數／預設'));

  const save = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const restart = needsRestart(patch);
      const v = await dimseApi.putSettings(patch);
      // 後端回完整的 view；萬一少欄位（舊版後端）也不要讓唯讀區的 .map 炸掉整頁
      setView({ ...view, ...v, readonly: v.readonly ?? view.readonly });
      setForm({ ...v.dimse });
      setNotice(restart ? (v.scp?.running ? t('已儲存，接收端已重啟（AE {ae_title}，port {port}）', { ae_title: v.scp.ae_title, port: v.scp.port }) : v.dimse.scp_enabled ? t('已儲存，但接收端沒有起來{p0}', { p0: v.scp_error ? t('：{scp_error}', { scp_error: v.scp_error }) : '' }) : t('已儲存，接收端已關閉')) : t('已儲存，即時生效'));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const restart = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      const r = await dimseApi.restartScp();
      setNotice(r.running ? t('接收端已重啟（port {port}）', { port: r.scp?.port }) : t('接收端沒有起來{p0}', { p0: r.error ? t('：{error}', { error: r.error }) : '' }));
      load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const scp = view.scp;
  return (
    <div className="dimse-service">
      <section className="scp-status">
        <h3>{t('接收端狀態')}</h3>
        {scp ? (
          <ul className="small">
            <li>
              <span className="ok">{t('監聽中 ✓')}</span> AE <code>{scp.ae_title}</code> {t('· {host}:{port} · 自 {p2}', { host: scp.host, port: scp.port, p2: scp.started_at ? new Date(scp.started_at).toLocaleString() : '—' })}
            </li>
            <li>
              {t('收到{received_total} 個 instance · 拒絕 {rejected_total} 條連線 · 進行中 {open_associations}{p3}', { received_total: scp.received_total, rejected_total: scp.rejected_total, open_associations: scp.open_associations, p3: scp.verify_callers ? t(' · 只接受登錄的來源') : t(' · 接受任何來源') })}
            </li>
            {scp.last_batch && (
              <li className="muted">
                {t('最近一批：{calling_aet}（{remote}）{received}檔{p3} · {p4}', { calling_aet: scp.last_batch.calling_aet, remote: scp.last_batch.remote, received: scp.last_batch.received, p3: scp.last_batch.unsupported ? t('，不支援 {unsupported}', { unsupported: scp.last_batch.unsupported }) : '', p4: new Date(scp.last_batch.finished_at).toLocaleString() })}
              </li>
            )}
            {scp.last_rejected && (
              <li className="warning">
                {t('最近拒絕：{p0} 從 {remote} · {p2}（未登錄為「可接收」節點）', { p0: scp.last_rejected.calling_aet || t('（空 AE Title）'), remote: scp.last_rejected.remote, p2: new Date(scp.last_rejected.at).toLocaleString() })}
              </li>
            )}
          </ul>
        ) : (
          <p className={view.dimse.scp_enabled ? 'error' : 'muted'}>
            {!view.scp_owner ? t('這個 API 行程不負責接收（RTGAIA_SCP_OWNER=0）；接收端由獨立 rtgaia-scp 行程提供，設定改了它會自己重啟。') : view.dimse.scp_enabled ? t('接收端沒有在跑{p0}', { p0: view.scp_error ? t('：{scp_error}', { scp_error: view.scp_error }) : '' }) : t('接收端關閉。')}
          </p>
        )}
        <button type="button" disabled={busy || !view.dimse.scp_enabled || !view.scp_owner} onClick={() => void restart()}>
          {t('重啟接收端')}
        </button>
      </section>

      <form
        className="settings-form"
        onSubmit={(e) => {
          e.preventDefault();
          if (dirty && problems.length === 0 && !busy) void save();
        }}
      >
        <h3>{t('DIMSE 設定')}</h3>
        <label title={src('ae_title')}>
          {t(SETTING_LABEL.ae_title)}
          <input value={form.ae_title} onChange={(e) => set('ae_title', e.target.value.toUpperCase())} />
        </label>
        <label className="check" title={src('scp_enabled')}>
          <input type="checkbox" checked={form.scp_enabled} onChange={(e) => set('scp_enabled', e.target.checked)} />
          {t('{scp_enabled}開啟', { scp_enabled: t(SETTING_LABEL.scp_enabled) })}
        </label>
        <div className="row">
          <label title={src('scp_port')}>
            {t(SETTING_LABEL.scp_port)}
            <input type="number" min={1} max={65535} value={form.scp_port} onChange={(e) => set('scp_port', Number(e.target.value))} />
          </label>
          <label title={src('scp_host')}>
            {t(SETTING_LABEL.scp_host)}
            <input value={form.scp_host} onChange={(e) => set('scp_host', e.target.value)} />
          </label>
        </div>
        <label className="check" title={src('accept_unknown_callers')}>
          <input type="checkbox" checked={form.accept_unknown_callers} onChange={(e) => set('accept_unknown_callers', e.target.checked)} />
          {t(SETTING_LABEL.accept_unknown_callers)}
          <span className="muted">{t('（關：只有「可接收」節點清單裡的 AE Title 送得進來；生產建議關）')}</span>
        </label>
        <label title={src('unsupported_sop_policy')}>
          {t(SETTING_LABEL.unsupported_sop_policy)}
          <select value={form.unsupported_sop_policy} onChange={(e) => set('unsupported_sop_policy', e.target.value as DimseSettings['unsupported_sop_policy'])}>
            <option value="store">{t('收下並標記（對方傳輸不會失敗）')}</option>
            <option value="reject">{t('拒絕該 instance（回 SOP Class not supported）')}</option>
          </select>
        </label>
        <div className="row">
          <label title={src('idle_seconds')}>
            {t(SETTING_LABEL.idle_seconds)}
            <input type="number" min={3} max={60} step={1} value={form.idle_seconds} onChange={(e) => set('idle_seconds', Number(e.target.value))} />
          </label>
          <label title={src('acse_timeout')}>
            {t(SETTING_LABEL.acse_timeout)}
            <input type="number" min={1} max={3600} value={form.acse_timeout} onChange={(e) => set('acse_timeout', Number(e.target.value))} />
          </label>
          <label title={src('dimse_timeout')}>
            {t(SETTING_LABEL.dimse_timeout)}
            <input type="number" min={1} max={3600} value={form.dimse_timeout} onChange={(e) => set('dimse_timeout', Number(e.target.value))} />
          </label>
          <label title={src('network_timeout')}>
            {t(SETTING_LABEL.network_timeout)}
            <input type="number" min={1} max={3600} value={form.network_timeout} onChange={(e) => set('network_timeout', Number(e.target.value))} />
          </label>
          <label title={t('{p0}；對關機或被防火牆丟包的節點，ECHO／送出最多等這麼久', { p0: src('connect_timeout') })}>
            {t(SETTING_LABEL.connect_timeout)}
            <input type="number" min={1} max={60} value={form.connect_timeout ?? 5} onChange={(e) => set('connect_timeout', Number(e.target.value))} />
          </label>
        </div>
        {warnings.map((w) => (
          <p key={w} className="warning">
            ⚠ {w}
          </p>
        ))}
        {dirty && problems.length > 0 && <p className="warning">{joinClauses(problems)}</p>}
        {dirty && needsRestart(patch) && problems.length === 0 && <p className="muted small">{t('儲存後接收端會重啟（進行中的傳輸會中斷）。')}</p>}
        <div className="buttons">
          <button type="button" disabled={!dirty || busy} onClick={() => setForm({ ...view.dimse })}>
            {t('還原')}
          </button>
          <button type="submit" className="primary" disabled={!dirty || busy || problems.length > 0}>
            {t('儲存')}
          </button>
          {view.updated && (
            <span className="muted small">
              {t('上次修改：{updated_by} · {p1}', { updated_by: view.updated.updated_by, p1: new Date(view.updated.updated_at).toLocaleString() })}
            </span>
          )}
        </div>
        {notice && <p className="ok">{notice}</p>}
        {error && <p className="error">{error}</p>}
      </form>

      <section className="readonly-settings">
        <h3>
          {t('行程設定')} <span className="muted small">{t('（環境變數；改 deploy/.env 後重啟行程）')}</span>
        </h3>
        <table className="admin-table">
          <tbody>
            {view.readonly.map((r) => (
              <tr key={r.key}>
                <td>{r.label}</td>
                <td>
                  <code>{r.key}</code>
                </td>
                <td className="muted">{r.value}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </div>
  );
}
