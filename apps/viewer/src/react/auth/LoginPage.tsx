/**
 * 登入頁 —— `#/login`。第一次啟動（沒有任何使用者）變成「建立第一個管理者」。
 * 純邏輯（表單檢查、錯誤文案）在 `authApi.ts`；這裡只有版面。
 */

import { Brand } from '../components/Brand';

import { useEffect, useState } from 'react';

import { navigate } from '../hooks/useHashRoute';
import { authApi, formProblems, loginProblems, type AuthStatus } from './authApi';
import { getLang, joinClauses, LANG_LABEL, LANGS, setLang, t } from '../../core/i18n';

export function LoginPage(props: { onLoggedIn: () => void }): React.JSX.Element {
  const [status, setStatus] = useState<AuthStatus | null>(null);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showPassword, setShowPassword] = useState(false);

  useEffect(() => {
    void authApi.status().then(
      (s) => {
        setStatus(s);
        if (s.mode === 'off' || s.user) {
          props.onLoggedIn();
          navigate('viewer');
        }
      },
      (e: unknown) => setError(e instanceof Error ? e.message : String(e)),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const bootstrap = status?.bootstrap_needed === true;
  // 建第一個管理者＝設定密碼 → 套政策；登入 → 只要求有填（舊帳號的密碼可能短於現行政策）
  const problems = bootstrap ? formProblems(username, password, confirm) : loginProblems(username, password);

  const submit = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      if (bootstrap) await authApi.bootstrap(username, password, displayName);
      else await authApi.login(username, password);
      props.onLoggedIn();
      navigate('viewer');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="login-page">
      <form
        className="login-card"
        onSubmit={(e) => {
          e.preventDefault();
          if (problems.length === 0 && !busy) void submit();
        }}
      >
        <Brand />
        {/* 登入前也要能切語言（登入頁沒有品牌選單） */}
        <div className="login-lang" role="radiogroup" aria-label="Language">
          {LANGS.map((lang) => (
            <button key={lang} type="button" role="radio" aria-checked={getLang() === lang} onClick={() => void setLang(lang)}>
              {LANG_LABEL[lang]}
            </button>
          ))}
        </div>
        <p className="tagline muted">{t('放射治療影像檢視、結構編輯與簽核')}</p>
        {status === null ? (
          <p className="muted">{t('連線中…')}</p>
        ) : bootstrap ? (
          <>
            <h2>{t('建立第一個管理者')}</h2>
            <p className="muted">{t('這台後端還沒有任何使用者。第一個帳號是管理者，之後由它建其他人的帳號。')}</p>
          </>
        ) : (
          <h2>{t('登入')}</h2>
        )}
        <label>
          {t('帳號')}
          <input autoFocus autoComplete="username" value={username} onChange={(e) => setUsername(e.target.value)} />
        </label>
        {bootstrap && (
          <label>
            {t('顯示名稱')}
            <input value={displayName} placeholder={t('例：王醫師')} onChange={(e) => setDisplayName(e.target.value)} />
          </label>
        )}
        <label>
          {t('密碼')}
          <span className="password-row">
            <input type={showPassword ? 'text' : 'password'} autoComplete={bootstrap ? 'new-password' : 'current-password'} value={password} onChange={(e) => setPassword(e.target.value)} />
            <button type="button" className="show-password" aria-pressed={showPassword} onClick={() => setShowPassword((v) => !v)} title={showPassword ? t('隱藏密碼') : t('顯示密碼')}>
              {showPassword ? t('隱藏') : t('顯示')}
            </button>
          </span>
        </label>
        {bootstrap && (
          <label>
            {t('再輸入一次')}
            <input type={showPassword ? 'text' : 'password'} autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} />
          </label>
        )}
        {username && password && problems.length > 0 && <p className="warning">{joinClauses(problems)}</p>}
        {error && (
          <p className="error" role="alert">
            {error}
            {/連線|HTTP 5|Failed to fetch|NetworkError/i.test(error) && (
              <button type="button" className="linkish" onClick={() => void submit()} disabled={busy || problems.length > 0}>
                {t('重試')}
              </button>
            )}
          </p>
        )}
        <button type="submit" className="primary" disabled={busy || problems.length > 0 || status === null}>
          {busy ? t('請稍候…') : bootstrap ? t('建立並登入') : t('登入')}
        </button>
        <p className="muted small">{bootstrap ? t('這個帳號之後可以建立其他使用者並指定角色。') : t('請使用管理者提供的帳號登入。連續錯 5 次會鎖 15 分鐘。')}</p>
      </form>
    </div>
  );
}
