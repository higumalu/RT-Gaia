/**
 * 改密碼。兩種用法：使用者選單的「改密碼」（可關閉）；臨時密碼登入後強制改（`forced`：不能關，伺服器也會擋其他 API）。
 * 成功後伺服器作廢其他裝置上的 token，這個瀏覽器當場換新的 cookie。
 */
import { useState } from 'react';

import { Dialog } from '../components/Dialog';
import { authApi, passwordProblems, type Principal } from './authApi';
import { joinClauses, t } from '../../core/i18n';

export function ChangePasswordDialog(props: { user: Principal; forced?: boolean; minLength?: number; onDone: (user: Principal) => void; onClose?: () => void }): React.JSX.Element {
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const problems = [...passwordProblems(next, props.user.username, props.minLength), ...(confirm && confirm !== next ? [t('兩次密碼不一致')] : [])];
  const submit = (): void => {
    if (busy || !current || !next || problems.length > 0 || confirm !== next) return;
    setBusy(true);
    setError(null);
    authApi
      .changePassword(current, next)
      .then((r) => props.onDone(r.user))
      .catch((e: unknown) => {
        setBusy(false);
        setError(e instanceof Error ? e.message : String(e));
      });
  };
  return (
    <Dialog label={t('修改密碼')} className="change-password-dialog" busy={busy} onClose={props.forced ? () => undefined : (props.onClose ?? (() => undefined))}>
      <h3>{props.forced ? t('請先修改臨時密碼') : t('修改密碼')}</h3>
      {props.forced && <p className="muted">{t('這是管理者設定的臨時密碼；改完才能使用其他功能。')}</p>}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <label>
          {t('目前的密碼')}
          <input type="password" autoComplete="current-password" data-autofocus value={current} onChange={(e) => setCurrent(e.target.value)} />
        </label>
        <label>
          {t('新密碼')}
          <input type="password" autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)} />
        </label>
        <label>
          {t('再輸入一次')}
          <input type="password" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} />
        </label>
        {next && problems.length > 0 && <p className="warning">{joinClauses(problems)}</p>}
        {error && <p className="error">{error}</p>}
        <div className="dialog-actions">
          {!props.forced && (
            <button type="button" onClick={props.onClose} disabled={busy}>
              {t('取消')}
            </button>
          )}
          <button type="submit" className="primary" disabled={busy || !current || !next || confirm !== next || problems.length > 0}>
            {t('修改')}
          </button>
        </div>
      </form>
    </Dialog>
  );
}
