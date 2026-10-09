/** 右上角的使用者：名字、角色、改密碼、登出。`mode === 'off'` 時不顯示。管理頁入口在 `AppNav`。 */

import { useState } from 'react';

import { navigate } from '../hooks/useHashRoute';
import { ChangePasswordDialog } from './ChangePasswordDialog';
import { authApi, roleLabel, type Principal } from './authApi';
import { t } from '../../core/i18n';

export function UserBadge(props: {
  user: Principal | null;
  onLoggedOut: () => void;
  /** 回 false 就不登出（有未提交編輯等）。檢視器頁傳 `confirmLeave('登出')`；資料頁不需要。 */
  beforeLogout?: () => boolean;
  /** 自己改完密碼後的新身分（`must_change_password` 清掉）。 */
  onUserChanged?: (user: Principal) => void;
}): React.JSX.Element | null {
  const [changing, setChanging] = useState(false);
  const user = props.user;
  if (user === null || user.source === 'stub') return null;
  const logout = async (): Promise<void> => {
    if (props.beforeLogout && !props.beforeLogout()) return;
    try {
      await authApi.logout();
    } finally {
      props.onLoggedOut();
      navigate('login');
    }
  };
  return (
    <span className="user-badge" title={`${user.username} · ${roleLabel(user.role)}`}>
      <span className="name">{user.display_name || user.username}</span>
      <span className="role">{roleLabel(user.role)}</span>
      <button type="button" onClick={() => setChanging(true)} title={t('修改自己的密碼')}>
        {t('改密碼')}
      </button>
      <button type="button" onClick={() => void logout()}>
        {t('登出')}
      </button>
      {changing && (
        <ChangePasswordDialog
          user={user}
          onClose={() => setChanging(false)}
          onDone={(u) => {
            setChanging(false);
            props.onUserChanged?.(u);
          }}
        />
      )}
    </span>
  );
}
