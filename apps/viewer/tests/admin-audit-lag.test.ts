/** 管理頁稽核落後的文字；TaskBar 密度偏好。 */
import { describe, expect, it } from 'vitest';

import { auditLagText } from '../src/react/auth/AdminPage';
import { applyDensity, readDensity } from '../src/react/components/TaskBar';

describe('auditLagText', () => {
  it('沒有 DB／沒資料 → null；無落後 ok；待送 warn 帶秒數；放棄 error 優先；查不到 error', () => {
    expect(auditLagText(null)).toBeNull();
    expect(auditLagText({ db: false, tail: 3, lag: null })).toBeNull();
    expect(auditLagText({ db: true, tail: 3, lag: { pending: 0, oldest_age_s: null, gave_up: 0 } })).toEqual({ text: '稽核無落後', kind: 'ok' });
    const warn = auditLagText({ db: true, tail: 3, lag: { pending: 2, oldest_age_s: 12.6, gave_up: 0 } })!;
    expect(warn.kind).toBe('warn');
    expect(warn.text).toMatch(/2 筆稽核待送（最舊 13 秒）/);
    const err = auditLagText({ db: true, tail: 3, lag: { pending: 5, oldest_age_s: 100, gave_up: 1 } })!;
    expect(err.kind).toBe('error');
    expect(err.text).toMatch(/1 筆稽核重送已放棄/);
    expect(auditLagText({ db: true, tail: 0, lag: { pending: null, oldest_age_s: null, gave_up: null, error: 'boom' } })!.kind).toBe('error');
  });
});

describe('density', () => {
  it('預設緊湊；applyDensity 寫 <html data-density> 與 localStorage；readDensity 讀回（Node 環境以最小替身模擬）', () => {
    const attrs = new Map<string, string>();
    const store = new Map<string, string>();
    const g = globalThis as unknown as { document?: unknown; localStorage?: unknown };
    const prevDoc = g.document;
    const prevLs = g.localStorage;
    g.document = { documentElement: { setAttribute: (k: string, v: string) => attrs.set(k, v) } };
    g.localStorage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => store.set(k, v) };
    try {
      expect(readDensity()).toBe('compact');
      applyDensity('comfortable');
      expect(attrs.get('data-density')).toBe('comfortable');
      expect(readDensity()).toBe('comfortable');
      applyDensity('compact');
      expect(readDensity()).toBe('compact');
    } finally {
      g.document = prevDoc;
      g.localStorage = prevLs;
    }
  });
  it('沒有 document／localStorage（SSR、測試）時不炸、回緊湊', () => {
    expect(readDensity()).toBe('compact');
    expect(() => applyDensity('comfortable')).not.toThrow();
  });
});
