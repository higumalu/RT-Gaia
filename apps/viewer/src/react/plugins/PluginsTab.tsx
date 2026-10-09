/**
 * 管理頭「Plugins」分頁 —— 登錄（endpoint ＋ bearer）、狀態、啟用／停用、重新檢查、移除。
 * 純邏輯在 `model.ts`，fetch 在 `pluginsApi.ts`。UI bundle 的執行期載入與任務列入口在 `loader.ts`／`menu/`。
 */

import { useCallback, useEffect, useState } from 'react';

import { licenseNotice, parseAllowLicenses, registerProblems, sortRows, STATUS_LABEL, statusClass } from './model';
import { pluginsApi, type PluginRow } from './pluginsApi';
import { t } from '../../core/i18n';

export function PluginsTab(): React.JSX.Element {
  const [rows, setRows] = useState<PluginRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [endpoint, setEndpoint] = useState('');
  const [token, setToken] = useState('');
  const [allow, setAllow] = useState('');
  const [formError, setFormError] = useState<string | null>(null);

  const load = useCallback(() => {
    pluginsApi.list().then((r) => setRows(sortRows(r)), (e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  }, []);
  useEffect(load, [load]);

  const run = async (id: string, fn: () => Promise<unknown>): Promise<void> => {
    setBusy(id);
    setError(null);
    try {
      await fn();
      load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const register = (): Promise<void> => {
    const problem = registerProblems(endpoint, token);
    setFormError(problem);
    if (problem) return Promise.resolve();
    return run('new', async () => {
      await pluginsApi.register({ endpoint: endpoint.trim(), token, allow_licenses: parseAllowLicenses(allow) });
      setEndpoint('');
      setToken('');
      setAllow('');
    });
  };

  return (
    <section className="plugins-tab">
      <h2>Plugins</h2>
      <p className="muted">
        {t('行程外的 plugin 服務。登錄後宿主每 30 秒健康檢查；版本變了自動更新，開著的頁面會提示重新載入。 只登錄你審過的 plugin：它能把結果寫進使用者的暫存區。')}
      </p>
      {error && <p className="error">{error}</p>}

      <form
        className="plugin-register"
        onSubmit={(e) => {
          e.preventDefault();
          void register();
        }}
      >
        <label>
          endpoint <input value={endpoint} onChange={(e) => setEndpoint(e.target.value)} placeholder="http://plugin-nnunet:8702" />
        </label>
        <label>
          bearer token <input value={token} onChange={(e) => setToken(e.target.value)} type="password" autoComplete="off" />
        </label>
        <label title={t('不在白名單（MIT／BSD／Apache-2.0）的程式授權要在這裡明示放行，會寫進稽核')}>
          {t('放行授權')} <input value={allow} onChange={(e) => setAllow(e.target.value)} placeholder={t('例：GPL-3.0-only')} />
        </label>
        <button className="primary" type="submit" disabled={busy === 'new'}>
          {t('登錄')}
        </button>
        {formError && <p className="error-text">{formError}</p>}
      </form>

      {rows === null ? (
        <p className="muted">{t('載入中…')}</p>
      ) : rows.length === 0 ? (
        <p className="muted">{t('還沒有 plugin。')}</p>
      ) : (
        <table className="admin-table">
          <thead>
            <tr>
              <th>plugin</th>
              <th>{t('版本')}</th>
              <th>{t('狀態')}</th>
              <th>endpoint</th>
              <th>{t('最低角色')}</th>
              <th>UI</th>
              <th>{t('最後看到')}</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {rows.map((p) => (
              <tr key={p.plugin_id} className={p.enabled ? '' : 'muted'}>
                <td>
                  {p.icon ? `${p.icon} ` : ''}
                  <strong>{t(p.label)}</strong> <span className="muted small">{p.plugin_id}</span>
                  {p.description && <div className="muted small">{t(p.description)}</div>}
                  {licenseNotice(p) && <div className="warning small">{licenseNotice(p)}</div>}
                </td>
                <td>{p.version}</td>
                <td>
                  <span className={statusClass(p.status)}>{t(STATUS_LABEL[p.status])}</span>
                  {p.error && <div className="error-text small">{p.error}</div>}
                </td>
                <td>
                  <code>{p.endpoint}</code>
                  {p.token_set === false && <div className="warning small">{t('沒有 token')}</div>}
                </td>
                <td>{p.required_role}</td>
                <td>{p.has_ui ? t('有') : '—'}</td>
                <td className="muted small">{p.last_seen_at ?? '—'}</td>
                <td className="buttons">
                  <button disabled={busy === p.plugin_id} onClick={() => void run(p.plugin_id, () => pluginsApi.refresh(p.plugin_id))}>
                    {t('重新檢查')}
                  </button>
                  <button
                    disabled={busy === p.plugin_id}
                    onClick={() => void run(p.plugin_id, () => pluginsApi.update(p.plugin_id, { enabled: !p.enabled }))}
                  >
                    {p.enabled ? t('停用') : t('啟用')}
                  </button>
                  <button
                    className="linkish"
                    disabled={busy === p.plugin_id}
                    onClick={() => {
                      if (confirm(t('移除 plugin {label}？進行中的工作會失敗；暫存區既有結果不受影響。', { label: t(p.label) }))) void run(p.plugin_id, () => pluginsApi.remove(p.plugin_id));
                    }}
                  >
                    {t('移除')}
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
