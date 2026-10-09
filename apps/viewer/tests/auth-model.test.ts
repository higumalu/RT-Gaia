/** 身分的純邏輯：路由、表單檢查、錯誤文案、角色比較。 */

import { describe, expect, it } from 'vitest';

import { atLeast, describeAuthError, formProblems, generateTempPassword, loginProblems, passwordProblems, type Principal } from '../src/react/auth/authApi';
import { activeNavKey, visibleNavItems } from '../src/react/components/AppNav';
import { adminTabFromHash, hashFor, routeFromHash } from '../src/react/hooks/useHashRoute';

describe('路由', () => {
  it('#/login 是第三頁；其餘不變', () => {
    expect(routeFromHash('#/login')).toBe('login');
    expect(routeFromHash('#login?x=1')).toBe('login');
    expect(routeFromHash('#/library')).toBe('library');
    expect(routeFromHash('#/viewer')).toBe('viewer');
    expect(routeFromHash('')).toBe('viewer');
    expect(routeFromHash('#/admin/nodes')).toBe('admin');
  });
  it('管理頁分頁由 hash 決定；導覽標亮；非 admin 看不到管理項目（2026-09-15）', () => {
    expect(adminTabFromHash('#/admin/nodes')).toBe('nodes');
    expect(adminTabFromHash('#/admin/service?x=1')).toBe('service');
    expect(adminTabFromHash('#/admin')).toBe('users');
    expect(adminTabFromHash('#/admin/bogus')).toBe('users');
    expect(hashFor('admin', 'audit')).toBe('#/admin/audit');
    expect(hashFor('library')).toBe('#/library');
    expect(activeNavKey('#/admin/nodes')).toBe('nodes');
    expect(activeNavKey('#/library')).toBe('library');
    expect(activeNavKey('#/login')).toBe('');
    const admin = { user_id: 'u', username: 'a', display_name: 'A', role: 'admin' as const, source: 'local' as const };
    expect(visibleNavItems(admin).map((i) => i.key)).toEqual(['library', 'viewer', 'exports', 'trash', 'users', 'nodes', 'service', 'plugins', 'audit', 'archive']);
    expect(visibleNavItems({ ...admin, role: 'contourer' }).map((i) => i.key)).toEqual(['library', 'viewer', 'exports', 'trash']);
    expect(visibleNavItems(null).map((i) => i.key)).toEqual(['library', 'viewer', 'exports', 'trash']);
  });
});

describe('表單與錯誤', () => {
  it('帳號必填、密碼 ≥ 12、bootstrap 要一致', () => {
    expect(formProblems('', 'short')).toEqual(['請輸入帳號', '密碼至少 12 個字元']);
    expect(formProblems('', 'short', undefined, 8)).toEqual(['請輸入帳號', '密碼至少 8 個字元']);
    expect(formProblems('a', 'correct-horse', 'other')).toEqual(['兩次密碼不一致']);
    expect(formProblems('a', 'correct-horse', 'correct-horse')).toEqual([]);
    expect(formProblems('a', 'correct-horse')).toEqual([]);
  });
  it('登入只要求有填：短於現行政策的舊密碼仍能登入（2026-09-29 回報）', () => {
    expect(loginProblems('carol', 'short')).toEqual([]);
    expect(loginProblems('', '')).toEqual(['請輸入帳號', '請輸入密碼']);
    expect(formProblems('carol', 'short')).toEqual(['密碼至少 12 個字元']); // 設定密碼時才套政策
  });
  it('密碼政策：不可含帳號、不可全同字元', () => {
    expect(passwordProblems('wang-secret-pass', 'wang')).toEqual(['密碼不可包含帳號']);
    expect(passwordProblems('aaaaaaaaaaaa')).toEqual(['密碼不可全是同一個字元']);
    expect(passwordProblems('ab-secret-pass', 'ab')).toEqual([]);
    expect(generateTempPassword()).toMatch(/^[A-HJ-NP-Za-km-np-z2-9]{16}$/);
  });
  it('423 LOCKED／DISABLED、401、409、422 各有一句人話', () => {
    expect(describeAuthError(423, { code: 'LOCKED' })).toContain('鎖定');
    expect(describeAuthError(423, { code: 'DISABLED' })).toContain('停用');
    expect(describeAuthError(401, { code: 'BAD_CREDENTIALS' })).toBe('帳號或密碼錯誤');
    expect(describeAuthError(409, null)).toContain('已有使用者');
    expect(describeAuthError(500, null)).toBe('HTTP 500');
  });
  it('角色是序', () => {
    const p = (role: Principal['role']): Principal => ({ user_id: 'u', username: 'x', display_name: 'X', role, source: 'local' });
    expect(atLeast(p('viewer'), 'contourer')).toBe(false);
    expect(atLeast(p('approver'), 'contourer')).toBe(true);
    expect(atLeast(p('admin'), 'admin')).toBe(true);
    expect(atLeast(null, 'viewer')).toBe(false);
  });
});
