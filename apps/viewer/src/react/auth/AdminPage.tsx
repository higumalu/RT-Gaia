/**
 * 管理頁 —— `#/admin`，admin 專用：使用者（建帳號、改角色、停用、重設密碼）與稽核事件；
 * 另有「DICOM 節點」與「服務設定」兩個分頁（`../dimse/`）。
 * 解除鎖定、重設密碼可自動產生臨時密碼、首次登入須改密碼、CSV 批次建帳號（`POST /auth/users/batch`）。
 * 後端 `GET/POST/PATCH /auth/users`、`GET /audit`、`/dimse/*`、`/settings`。
 */


import { useCallback, useEffect, useState } from 'react';

import { NodesTab } from '../dimse/NodesTab';
import { ServiceTab } from '../dimse/ServiceTab';
import { StorageSection } from '../storage/StorageSection';
import { PluginsTab } from '../plugins/PluginsTab';
import { BrandMenu } from '../components/AppNav';
import { adminTabFromHash, navigate, useHash, type AdminTab } from '../hooks/useHashRoute';
import { authApi, formProblems, generateTempPassword, MIN_PASSWORD_LENGTH, passwordProblems, roleLabel, type Principal, type Role } from './authApi';
import { formatDate, formatDateTime, joinClauses, msg, t } from '../../core/i18n';

interface UserRow {
  user_id: string;
  username: string;
  display_name: string;
  role: Role;
  disabled: boolean;
  created_at: string;
  created_by: string;
  last_login_at: string | null;
  locked_until: string | null;
  must_change_password?: boolean;
  password_changed_at?: string | null;
}

/** 批次建帳號的回應：沒給密碼的列帶一次性 `temp_password`（只出現這一次）。 */
interface BatchResult {
  created: { username: string; display_name: string; role: Role; temp_password?: string }[];
  errors: { line: number; username: string; message: string }[];
}

/** 一次性顯示的臨時密碼（重設或批次建立），關掉就看不到了。 */
interface IssuedPassword {
  username: string;
  password: string;
}

interface AuditRow {
  event_id: string;
  at: string;
  user: string;
  action: string;
  status: number;
  object_type: string | null;
  object_id: string | null;
  case_id: string | null;
  remote_addr: string | null;
}

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const r = await fetch(`/api/v1${path}`, init);
  if (!r.ok) throw new Error(t('HTTP {status}：{p1}', { status: r.status, p1: (await r.text()).slice(0, 200) }));
  return (await r.json()) as T;
}
const json = (method: string, body: unknown): RequestInit => ({ method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

const ROLES: Role[] = ['viewer', 'contourer', 'approver', 'admin'];

const TAB_LABEL: Record<AdminTab, string> = { users: msg('使用者'), audit: msg('稽核'), nodes: msg('DICOM 節點'), service: msg('服務設定'), plugins: 'Plugins' };

export function AdminPage(props: { user: Principal | null }): React.JSX.Element {
  // 2026-09-15：分頁由 `#/admin/<tab>` 決定（全站導覽 `AppNav` 直接切）
  const tab = adminTabFromHash(useHash());
  const setTab = (t: AdminTab): void => navigate('admin', t);
  const isAdmin = props.user?.role === 'admin';
  return (
    <div className="library admin-page">
      <header className="library-header">
        <BrandMenu user={props.user} section={t(TAB_LABEL[tab])} />
      </header>
      <div className="library-body">
        <section className="library-main">
          {!isAdmin ? (
            <p className="warning">{t('這一頁需要管理者角色（你是 {p0}）。', { p0: props.user ? roleLabel(props.user.role) : t('未登入') })}</p>
          ) : tab === 'users' ? (
            <UsersTab me={props.user} />
          ) : tab === 'audit' ? (
            <AuditTab />
          ) : tab === 'nodes' ? (
            <NodesTab onOpenService={() => setTab('service')} />
          ) : tab === 'plugins' ? (
            <PluginsTab />
          ) : (
            <>
              <ServiceTab />
              <StorageSection />
            </>
          )}
        </section>
      </div>
    </div>
  );
}

function UsersTab(props: { me: Principal | null }): React.JSX.Element {
  const [users, setUsers] = useState<UserRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [username, setUsername] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [password, setPassword] = useState('');
  const [role, setRole] = useState<Role>('contourer');
  const [mustChange, setMustChange] = useState(true);
  const [busy, setBusy] = useState(false);
  const [minLength, setMinLength] = useState(MIN_PASSWORD_LENGTH);
  const [issued, setIssued] = useState<IssuedPassword[]>([]);
  const [batchText, setBatchText] = useState('');
  const [batchErrors, setBatchErrors] = useState<BatchResult['errors']>([]);
  const load = useCallback(() => {
    api<UserRow[]>('/auth/users').then(setUsers, (e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  }, []);
  useEffect(load, [load]);
  useEffect(() => {
    authApi.status().then(
      (s) => setMinLength(s.password_policy?.min_length ?? MIN_PASSWORD_LENGTH),
      () => undefined,
    );
  }, []);

  const problems = formProblems(username, password, undefined, minLength);
  const create = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      await api('/auth/users', json('POST', { username, password, role, display_name: displayName, must_change_password: mustChange }));
      setUsername('');
      setPassword('');
      setDisplayName('');
      load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  const patch = async (u: UserRow, body: Record<string, unknown>): Promise<boolean> => {
    try {
      await api(`/auth/users/${encodeURIComponent(u.user_id)}`, json('PATCH', body));
      load();
      return true;
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      return false;
    }
  };
  const resetPassword = async (u: UserRow): Promise<void> => {
    // 留空 ＝ 產生臨時密碼（只顯示這一次）；兩種都會要求對方下次登入改密碼、舊登入立刻失效
    const typed = window.prompt(t('為 {username} 設定新密碼（至少 {minLength} 個字元；留空＝自動產生臨時密碼）。對方的登入會立刻失效，下次登入須改密碼。', { username: u.username, minLength }));
    if (typed === null) return;
    const pw = typed || generateTempPassword();
    const bad = passwordProblems(pw, u.username, minLength);
    if (bad.length > 0) {
      setError(joinClauses(bad));
      return;
    }
    if ((await patch(u, { password: pw, must_change_password: true })) && !typed) setIssued([{ username: u.username, password: pw }]);
  };
  const batchCreate = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      const r = await api<BatchResult>('/auth/users/batch', json('POST', { csv: batchText }));
      setIssued(r.created.filter((c) => c.temp_password).map((c) => ({ username: c.username, password: c.temp_password ?? '' })));
      setBatchErrors(r.errors);
      if (r.errors.length === 0) setBatchText('');
      load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  const locked = (u: UserRow): boolean => !!u.locked_until && new Date(u.locked_until) > new Date();

  return (
    <div className="admin-users">
      <form
        className="create-user"
        onSubmit={(e) => {
          e.preventDefault();
          if (problems.length === 0 && !busy) void create();
        }}
      >
        <h3>{t('新增使用者')}</h3>
        <label>
          {t('帳號')}
          <input value={username} onChange={(e) => setUsername(e.target.value)} />
        </label>
        <label>
          {t('顯示名稱')}
          <input value={displayName} onChange={(e) => setDisplayName(e.target.value)} />
        </label>
        <label>
          {t('密碼')}
          <input type="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} />
        </label>
        <label>
          {t('角色')}
          <select value={role} onChange={(e) => setRole(e.target.value as Role)}>
            {ROLES.map((r) => (
              <option key={r} value={r}>
                {t('{p0}（{r}）', { p0: roleLabel(r), r })}
              </option>
            ))}
          </select>
        </label>
        <label className="inline">
          <input type="checkbox" checked={mustChange} onChange={(e) => setMustChange(e.target.checked)} />
          {t('首次登入須改密碼')}
        </label>
        <button type="submit" className="primary" disabled={busy || problems.length > 0}>
          {t('新增')}
        </button>
        {username && password && problems.length > 0 && <span className="warning">{joinClauses(problems)}</span>}
      </form>
      <details className="batch-users">
        <summary>{t('批次建立帳號（CSV）')}</summary>
        <p className="muted">
          {t('每行一個帳號：')}<code>{t('帳號,顯示名稱,角色,密碼')}</code>{t('（第一行可以是標題）。角色空白＝勾畫；密碼空白＝產生臨時密碼。 全部帳號首次登入都須改密碼；一次最多 500 行，一行失敗不影響其他行。')}
        </p>
        <textarea rows={5} value={batchText} placeholder={t('username,display_name,role,password\nwang,王醫師,contourer,\nchen,陳物理師,approver,')} onChange={(e) => setBatchText(e.target.value)} />
        <button type="button" className="primary" disabled={busy || !batchText.trim()} onClick={() => void batchCreate()}>
          {t('建立')}
        </button>
        {batchErrors.length > 0 && (
          <ul className="error">
            {batchErrors.map((b) => (
              <li key={b.line}>
                {b.username ? t('第 {line} 行（{username}）：{message}', { line: b.line, username: b.username, message: b.message }) : t('第 {line} 行：{message}', { line: b.line, message: b.message })}
              </li>
            ))}
          </ul>
        )}
      </details>
      {issued.length > 0 && (
        <div className="issued-passwords" role="alert">
          <p>
            <strong>{t('臨時密碼只顯示這一次')}</strong> {t('請現在抄下並以安全管道交給本人；對方登入後會被要求改密碼。')}
          </p>
          <table className="admin-table">
            <tbody>
              {issued.map((i) => (
                <tr key={i.username}>
                  <td>{i.username}</td>
                  <td>
                    <code>{i.password}</code>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <button type="button" onClick={() => setIssued([])}>
            {t('我已抄下，關閉')}
          </button>
        </div>
      )}
      {error && <p className="error">{error}</p>}
      {users === null ? (
        <p className="muted">{t('載入中…')}</p>
      ) : (
        <table className="admin-table">
          <thead>
            <tr>
              <th>{t('帳號')}</th>
              <th>{t('顯示名稱')}</th>
              <th>{t('角色')}</th>
              <th>{t('狀態')}</th>
              <th>{t('最後登入')}</th>
              <th>{t('建立')}</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {users.map((u) => {
              const self = props.me?.username === u.username;
              return (
                <tr key={u.user_id} data-disabled={u.disabled ? 'true' : undefined}>
                  <td>{u.username}</td>
                  <td>{u.display_name}</td>
                  <td>
                    <select value={u.role} disabled={self} title={self ? t('不能改自己的角色') : ''} onChange={(e) => void patch(u, { role: e.target.value })}>
                      {ROLES.map((r) => (
                        <option key={r} value={r}>
                          {roleLabel(r)}
                        </option>
                      ))}
                    </select>
                  </td>
                  <td>
                    {u.disabled ? t('停用') : locked(u) ? t('鎖定中') : t('正常')}
                    {u.must_change_password && <span className="muted">{t('（待改密碼）')}</span>}
                  </td>
                  <td className="muted">{u.last_login_at ? formatDateTime(u.last_login_at) : '—'}</td>
                  <td className="muted">
                    {formatDate(u.created_at)} · {u.created_by}
                  </td>
                  <td className="actions">
                    <button type="button" onClick={() => void resetPassword(u)}>
                      {t('重設密碼')}
                    </button>
                    {locked(u) && (
                      <button type="button" onClick={() => void patch(u, { unlock: true })}>
                        {t('解除鎖定')}
                      </button>
                    )}
                    <button type="button" disabled={self} onClick={() => void patch(u, { disabled: !u.disabled })}>
                      {u.disabled ? t('啟用') : t('停用')}
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </div>
  );
}

interface AuditLag {
  db: boolean;
  tail: number;
  lag: { pending: number | null; oldest_age_s: number | null; gave_up: number | null; error?: string } | null;
}

/** 稽核待送（outbox）狀態 —— 有待送就是「有操作已執行但稽核還沒落主表」，要顯眼。 */
export function auditLagText(status: AuditLag | null): { text: string; kind: 'ok' | 'warn' | 'error' } | null {
  if (status === null || !status.db || status.lag === null) return null;
  const { pending, oldest_age_s: age, gave_up: gaveUp } = status.lag;
  if (status.lag.error) return { text: t('稽核狀態查不到：{error}', { error: status.lag.error }), kind: 'error' };
  if ((gaveUp ?? 0) > 0) return { text: t('{gaveUp} 筆稽核重送已放棄（需人工處理）；待送 {p1} 筆', { gaveUp, p1: pending ?? 0 }), kind: 'error' };
  if ((pending ?? 0) > 0) return { text: t('{pending} 筆稽核待送（最舊 {p1} 秒）——主表暫時寫不進去，背景每 5 秒重送', { pending, p1: Math.round(age ?? 0) }), kind: 'warn' };
  return { text: t('稽核無落後'), kind: 'ok' };
}

function AuditTab(): React.JSX.Element {
  const [rows, setRows] = useState<AuditRow[] | null>(null);
  const [user, setUser] = useState('');
  const [caseId, setCaseId] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [lag, setLag] = useState<AuditLag | null>(null);
  useEffect(() => {
    const tick = (): void => {
      api<AuditLag>('/audit/status').then(setLag, () => setLag(null));
    };
    tick();
    const t = setInterval(tick, 10_000);
    return () => clearInterval(t);
  }, []);
  const lagText = auditLagText(lag);
  useEffect(() => {
    const p = new URLSearchParams({ limit: '200' });
    if (user.trim()) p.set('user', user.trim());
    if (caseId.trim()) p.set('case_id', caseId.trim());
    const t = setTimeout(() => {
      api<AuditRow[]>(`/audit?${p.toString()}`).then(setRows, (e: unknown) => setError(e instanceof Error ? e.message : String(e)));
    }, 200);
    return () => clearTimeout(t);
  }, [user, caseId]);
  return (
    <div className="admin-audit">
      <form className="library-search" onSubmit={(e) => e.preventDefault()}>
        <label>
          {t('使用者')}
          <input value={user} onChange={(e) => setUser(e.target.value)} />
        </label>
        <label>
          {t('病例 id')}
          <input value={caseId} onChange={(e) => setCaseId(e.target.value)} />
        </label>
        <span className="muted">{rows ? t('{length} 筆（最新在前）', { length: rows.length }) : ''}</span>
        {lagText && (
          <span className={`audit-lag audit-lag-${lagText.kind}`} role="status">
            {lagText.kind === 'ok' ? '✓ ' : '⚠ '}
            {lagText.text}
          </span>
        )}
      </form>
      {error && <p className="error">{error}</p>}
      {rows && (
        <table className="admin-table">
          <thead>
            <tr>
              <th>{t('時間')}</th>
              <th>{t('使用者')}</th>
              <th>{t('動作')}</th>
              <th>{t('物件')}</th>
              <th>{t('病例')}</th>
              <th>{t('狀態')}</th>
              <th>{t('來源')}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.event_id}>
                <td className="muted">{formatDateTime(r.at)}</td>
                <td>{r.user}</td>
                <td>
                  <code>{r.action}</code>
                </td>
                <td className="muted">{r.object_type ? `${r.object_type} ${r.object_id ?? ''}` : ''}</td>
                <td className="muted">{r.case_id ? `…${r.case_id.slice(-6)}` : ''}</td>
                <td>{r.status}</td>
                <td className="muted">{r.remote_addr ?? ''}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
