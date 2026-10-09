/**
 * 身分 API：`/api/v1/auth/*`。純 fetch 與型別；登入頁在 `LoginPage.tsx`。
 *
 * 後端 `RTGAIA_AUTH=off`（沒有 Postgres 的開發／測試）時 `status.mode === 'off'`，前端不顯示登入頁、
 * 也不顯示使用者（身分是 stub）。`required` 時所有 `/api/v1/*` 都要 cookie；401 → 導到 `#/login`。
 */

import { joinClauses, msg, t } from '../../core/i18n';

export type Role = 'viewer' | 'contourer' | 'approver' | 'admin';

export interface Principal {
  readonly user_id: string;
  readonly username: string;
  readonly display_name: string;
  readonly role: Role;
  readonly source: 'local' | 'stub';
  /** 臨時密碼 → 登入後必須先改（伺服器端也會擋其他 API）。 */
  readonly must_change_password?: boolean;
}

export interface AuthStatus {
  readonly mode: 'required' | 'off';
  readonly bootstrap_needed: boolean;
  readonly user: Principal | null;
  readonly password_policy?: { readonly min_length: number; readonly max_failures: number; readonly lockout_minutes: number };
}

export const ROLE_LABEL: Record<Role, string> = { viewer: msg('檢視'), contourer: msg('勾畫'), approver: msg('審核'), admin: msg('管理') };

/** 角色的顯示名（跟語言走；`ROLE_LABEL` 是原文）。 */
export function roleLabel(role: Role): string {
  return t(ROLE_LABEL[role]);
}
const ROLE_RANK: Record<Role, number> = { viewer: 0, contourer: 1, approver: 2, admin: 3 };

export function atLeast(p: Principal | null, role: Role): boolean {
  return p !== null && ROLE_RANK[p.role] >= ROLE_RANK[role];
}

export const MIN_PASSWORD_LENGTH = 12;

/** 登入／bootstrap 表單的本機檢查（與後端 `password_problems` 同一條規則）。 */
export function formProblems(username: string, password: string, confirm?: string, minLength: number = MIN_PASSWORD_LENGTH): string[] {
  const out: string[] = [];
  if (!username.trim()) out.push(t('請輸入帳號'));
  out.push(...passwordProblems(password, username, minLength));
  if (confirm !== undefined && confirm !== password) out.push(t('兩次密碼不一致'));
  return out;
}

/**
 * 登入表單的本機檢查：**只要求有填**。密碼政策只在「設定密碼」時用（建帳號、改密碼、bootstrap）——
 * 政策上線前建的帳號密碼可能不到 12 個字元，登入時擋掉就再也進不來。
 */
export function loginProblems(username: string, password: string): string[] {
  const out: string[] = [];
  if (!username.trim()) out.push(t('請輸入帳號'));
  if (!password) out.push(t('請輸入密碼'));
  return out;
}

/** 與後端 `password_problems` 同規則的本機檢查（伺服器仍是最後把關；「太常見」只在伺服器判）。 */
export function passwordProblems(password: string, username = '', minLength: number = MIN_PASSWORD_LENGTH): string[] {
  const out: string[] = [];
  if (password.length < minLength) out.push(t('密碼至少 {minLength} 個字元', { minLength }));
  const u = username.trim().toLowerCase();
  if (u.length >= 3 && password.toLowerCase().includes(u)) out.push(t('密碼不可包含帳號'));
  if (password.length > 0 && new Set(password).size === 1) out.push(t('密碼不可全是同一個字元'));
  return out;
}

const TEMP_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';

/** 管理者重設密碼時的臨時密碼（與後端 `generate_temp_password` 同字母表，去掉 0Oo1lI）。 */
export function generateTempPassword(length = 16): string {
  const bytes = new Uint32Array(length);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => TEMP_ALPHABET[b % TEMP_ALPHABET.length]).join('');
}

/** 後端 401／423 的 detail → 給人看的一句話。 */
export function describeAuthError(status: number, detail: unknown): string {
  const code = typeof detail === 'object' && detail !== null ? (detail as { code?: string }).code : undefined;
  if (status === 423 && code === 'LOCKED') return t('連續錯誤太多次，帳號暫時鎖定（請稍後再試或請管理者解鎖）');
  if (code === 'BAD_CURRENT_PASSWORD') return t('目前的密碼不對');
  if (code === 'PASSWORD_CHANGE_REQUIRED') return t('請先修改臨時密碼');
  if (status === 422 && typeof detail === 'object' && detail !== null && Array.isArray((detail as { problems?: unknown }).problems)) {
    return joinClauses((detail as { problems: string[] }).problems);
  }
  if (status === 423 && code === 'DISABLED') return t('帳號已停用，請聯絡管理者');
  if (status === 401) return t('帳號或密碼錯誤');
  if (status === 409) return t('已有使用者，請直接登入');
  if (status === 422) return t('帳號或密碼不符合規則');
  return `HTTP ${status}`;
}

const API = '/api/v1/auth';

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const r = await fetch(`${API}${path}`, init);
  if (!r.ok) {
    let detail: unknown = null;
    try {
      detail = ((await r.json()) as { detail?: unknown }).detail ?? null;
    } catch {
      /* 非 JSON */
    }
    throw new AuthError(r.status, detail);
  }
  return (await r.json()) as T;
}

export class AuthError extends Error {
  constructor(
    readonly status: number,
    readonly detail: unknown,
  ) {
    super(describeAuthError(status, detail));
  }
}

export const authApi = {
  status: (): Promise<AuthStatus> => call('/status'),
  me: (): Promise<Principal> => call('/me'),
  login: (username: string, password: string): Promise<{ user: Principal }> =>
    call('/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username, password }) }),
  bootstrap: (username: string, password: string, displayName: string): Promise<{ user: Principal }> =>
    call('/bootstrap', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username, password, display_name: displayName }),
    }),
  logout: (): Promise<{ ok: boolean }> => call('/logout', { method: 'POST' }),
  changePassword: (currentPassword: string, newPassword: string): Promise<{ user: Principal }> =>
    call('/me/password', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ current_password: currentPassword, new_password: newPassword }),
    }),
};

let installed = false;

/**
 * 任何 `/api/v1/*`（非 auth）回 401 → 呼叫 `onUnauthorized`（導到登入頁）。只裝一次。
 * 用包 `window.fetch` 而不是每個呼叫點各自判斷：目錄頁、匯入面板、transport 三處都打 API，漏一處就是一個永遠轉圈的畫面。
 */
export function installUnauthorizedRedirect(onUnauthorized: () => void): void {
  if (installed || typeof window === 'undefined') return;
  installed = true;
  const original = window.fetch.bind(window);
  window.fetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const response = await original(input, init);
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (response.status === 401 && url.includes('/api/v1/') && !url.includes('/api/v1/auth/')) onUnauthorized();
    return response;
  });
}
