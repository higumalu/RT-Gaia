/**
 * 介面偏好跟著帳號（`react/prefs/prefs.ts`）—— 帳號為準寫進 localStorage、帳號沒有的推上去、
 * 之後的修改合併成一次 PUT、沒有帳號時只寫本機、語言偏好立刻套用。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { getLang, LANG_STORAGE_KEY, setLang } from '../src/core/i18n';
import { loadPrefs, prefsAvailable, prefStorage, resetPrefsForTests, savePref } from '../src/react/prefs/prefs';

class MemoryStorage {
  data = new Map<string, string>();
  getItem(k: string): string | null {
    return this.data.get(k) ?? null;
  }
  setItem(k: string, v: string): void {
    this.data.set(k, v);
  }
  removeItem(k: string): void {
    this.data.delete(k);
  }
}

let store: MemoryStorage;
let puts: Record<string, unknown>[];
let remote: { available: boolean; preferences: Record<string, string> };

beforeEach(() => {
  vi.useFakeTimers();
  resetPrefsForTests();
  store = new MemoryStorage();
  puts = [];
  remote = { available: true, preferences: {} };
  vi.stubGlobal('localStorage', store);
  vi.stubGlobal('fetch', async (_url: string, init?: RequestInit) => {
    if (init?.method === 'PUT') {
      puts.push(JSON.parse(init.body as string) as Record<string, unknown>);
      return new Response('{}', { status: 200 });
    }
    return new Response(JSON.stringify(remote), { status: 200 });
  });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  void setLang('zh-TW');
});

describe('介面偏好', () => {
  it('帳號為準寫進 localStorage；帳號沒有、這台有的推上去；不同步的 key 不動', async () => {
    remote.preferences = { 'rtgaia.layout.current.v1': '1+3', 'rtgaia.density': 'compact' };
    store.setItem('rtgaia.density', 'comfortable'); // 帳號為準 → 被蓋掉
    store.setItem('rtgaia.sidebar.left.width.v1', '320'); // 帳號沒有 → 推上去
    store.setItem('rtgaia.something.local', 'x'); // 不在同步清單 → 不推
    expect(await loadPrefs()).toBe(true);
    expect(store.getItem('rtgaia.layout.current.v1')).toBe('1+3');
    expect(store.getItem('rtgaia.density')).toBe('compact');
    expect(puts).toEqual([{ 'rtgaia.sidebar.left.width.v1': '320' }]);
  });

  it('修改合併成一次 PUT；null 刪除；不同步的 key 只寫本機', async () => {
    await loadPrefs();
    savePref('rtgaia.density', 'compact');
    savePref('rtgaia.layout.current.v1', '2x2');
    savePref('rtgaia.layout.current.v1', null);
    prefStorage.setItem('rtgaia.tour.v1', 'done');
    savePref('rtgaia.something.local', 'x');
    expect(puts).toEqual([]);
    await vi.advanceTimersByTimeAsync(1000);
    expect(puts).toEqual([{ 'rtgaia.density': 'compact', 'rtgaia.layout.current.v1': null, 'rtgaia.tour.v1': 'done' }]);
    expect(store.getItem('rtgaia.layout.current.v1')).toBeNull();
    expect(store.getItem('rtgaia.something.local')).toBe('x');
  });

  it('沒有帳號（RTGAIA_AUTH=off）：只寫本機、不送 PUT', async () => {
    remote = { available: false, preferences: {} };
    expect(await loadPrefs()).toBe(false);
    expect(prefsAvailable()).toBe(false);
    savePref('rtgaia.density', 'compact');
    await vi.advanceTimersByTimeAsync(1000);
    expect(puts).toEqual([]);
    expect(store.getItem('rtgaia.density')).toBe('compact');
  });

  it('語言偏好：載入即套用；之後切換會存回帳號', async () => {
    remote.preferences = { [LANG_STORAGE_KEY]: 'en' };
    await loadPrefs();
    expect(getLang()).toBe('en');
    void setLang('zh-TW');
    await vi.advanceTimersByTimeAsync(1000);
    expect(puts.at(-1)).toEqual({ [LANG_STORAGE_KEY]: 'zh-TW' });
  });
});
