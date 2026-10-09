/**
 * 介面偏好跨電腦跟著帳號走（`GET/PUT /api/v1/auth/me/preferences`，存在 `app_user.preferences`）。
 *
 * 做法：程式各處照舊讀 localStorage（同步、簡單）；這裡在**登入後、檢視器掛上之前**把帳號上的偏好寫進 localStorage，
 * 之後的修改走 `savePref()`（寫 localStorage ＋ 合併成一次 PUT）。沒有資料庫帳號（`RTGAIA_AUTH=off`）時
 * `available=false`，只剩這台瀏覽器。第一次同步時，帳號上沒有、這台瀏覽器有的偏好會推上去（不丟掉已經調好的設定）。
 *
 * 只同步介面偏好（版面、側欄、密度、語言、3D TF、W/L 預設集、導覽看過沒…）—— 不放病人資料。
 */

import { getLang, LANG_STORAGE_KEY, onLangChange, setLang } from '../../core/i18n';

/** 會同步到帳號的 localStorage key（其他 key 只留在這台瀏覽器）。 */
export const SYNCED_PREF_KEYS: readonly string[] = [
  'rtgaia.layout.overrides.v1',
  'rtgaia.layout.trees.v1',
  'rtgaia.layout.current.v1',
  'rtgaia.sidebar.collapsed.v1',
  'rtgaia.sidebar.left.width.v1',
  'rtgaia.sidebar.right.width.v1',
  'rtgaia.dock.v1',
  'rtgaia.density',
  'rtgaia.render3d.tf.v1',
  'rtgaia.wl.presets.v1',
  'rtgaia.download.compress',
  'rtgaia.tour.v1',
  'rtgaia.measure.templates.v1',
  'rtgaia.dose.isodose.v1',
  LANG_STORAGE_KEY,
];

const FLUSH_MS = 800;

let available = false;
let pending: Record<string, string | null> = {};
let timer: ReturnType<typeof setTimeout> | null = null;
let langHooked = false;

function storage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

async function put(patch: Record<string, string | null>): Promise<void> {
  try {
    await fetch('/api/v1/auth/me/preferences', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(patch) });
  } catch {
    /* 離線：下次修改會再送；localStorage 已經有了 */
  }
}

function flush(): void {
  timer = null;
  const patch = pending;
  pending = {};
  if (available && Object.keys(patch).length > 0) void put(patch);
}

/** 寫一個偏好：localStorage ＋（有帳號時）排進下一次 PUT。`null` ＝ 刪掉。 */
export function savePref(key: string, value: string | null): void {
  const s = storage();
  try {
    if (value === null) s?.removeItem(key);
    else s?.setItem(key, value);
  } catch {
    /* 私密視窗：只活在這次 */
  }
  if (!available || !SYNCED_PREF_KEYS.includes(key)) return;
  pending[key] = value;
  if (timer === null) timer = setTimeout(flush, FLUSH_MS);
}

/** 給吃 `Storage` 參數的純函式用（`writeUserPresets`、`markTourDone`…）：讀 localStorage、寫走 `savePref`。 */
export const prefStorage: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> = {
  getItem: (key) => storage()?.getItem(key) ?? null,
  setItem: (key, value) => savePref(key, value),
  removeItem: (key) => savePref(key, null),
};

export function prefsAvailable(): boolean {
  return available;
}

/**
 * 登入後呼叫一次：帳號上的偏好 → localStorage（帳號為準）；帳號上沒有、這台有的推上去。
 * 回傳是否有帳號偏好可用。語言偏好立刻套用。
 */
export async function loadPrefs(): Promise<boolean> {
  let body: { available?: boolean; preferences?: Record<string, unknown> };
  try {
    const r = await fetch('/api/v1/auth/me/preferences');
    if (!r.ok) return (available = false);
    body = (await r.json()) as typeof body;
  } catch {
    return (available = false);
  }
  available = body.available === true;
  if (!available) return false;
  const remote = body.preferences ?? {};
  const s = storage();
  const upload: Record<string, string> = {};
  for (const key of SYNCED_PREF_KEYS) {
    const value = remote[key];
    if (typeof value === 'string') {
      try {
        s?.setItem(key, value);
      } catch {
        /* 私密視窗 */
      }
    } else {
      const local = s?.getItem(key);
      if (local !== null && local !== undefined) upload[key] = local;
    }
  }
  if (Object.keys(upload).length > 0) void put(upload);
  const lang = s?.getItem(LANG_STORAGE_KEY);
  if (lang === 'en' || lang === 'zh-TW') void setLang(lang);
  if (!langHooked) {
    langHooked = true;
    onLangChange(() => savePref(LANG_STORAGE_KEY, getLang()));
  }
  return true;
}

/** 測試用：回到初始狀態。 */
export function resetPrefsForTests(): void {
  available = false;
  pending = {};
  if (timer !== null) clearTimeout(timer);
  timer = null;
}
