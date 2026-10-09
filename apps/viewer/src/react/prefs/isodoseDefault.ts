/**
 * 等劑量線「存成預設」—— 存在帳號偏好（換電腦跟著走），**只存 % 參考劑量**：
 * 處方不同的病例套同一組 Gy 沒有意義。核心的 `doseDisplayOf` 不碰 localStorage，這裡讀出來交給
 * `setUserIsodoseDefault`。
 */

import { setUserIsodoseDefault } from '../../core';
import { prefStorage } from './prefs';

export const ISODOSE_PREF_KEY = 'rtgaia.dose.isodose.v1';

/** 讀偏好：`{ percents: number[] }`；壞掉或沒有 → `null`。 */
export function parseIsodoseDefault(raw: string | null): number[] | null {
  if (raw === null) return null;
  try {
    const v = JSON.parse(raw) as { percents?: unknown };
    const p = Array.isArray(v.percents) ? v.percents.filter((x): x is number => typeof x === 'number' && Number.isFinite(x) && x > 0) : [];
    return p.length > 0 ? p : null;
  } catch {
    return null;
  }
}

/** 啟動與登入同步之後各呼叫一次：偏好 → 核心。 */
export function applyIsodoseDefault(storage: Pick<Storage, 'getItem'> = prefStorage): number[] | null {
  const p = parseIsodoseDefault(storage.getItem(ISODOSE_PREF_KEY));
  setUserIsodoseDefault(p);
  return p;
}

/** 存（`null` ＝ 清掉、回到內建規則）：偏好 ＋ 核心。% 取到 0.1。 */
export function saveIsodoseDefault(percents: readonly number[] | null, storage: Pick<Storage, 'setItem' | 'removeItem'> = prefStorage): void {
  const clean = percents === null ? null : [...new Set(percents.filter((x) => Number.isFinite(x) && x > 0).map((x) => Math.round(x * 10) / 10))].sort((a, b) => b - a);
  if (clean === null || clean.length === 0) {
    storage.removeItem(ISODOSE_PREF_KEY);
    setUserIsodoseDefault(null);
  } else {
    storage.setItem(ISODOSE_PREF_KEY, JSON.stringify({ percents: clean }));
    setUserIsodoseDefault(clean);
  }
}
