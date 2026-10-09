/**
 * 英文單複數（`en.ts` 的 `pl`／`plural`）。2026-10-09 錄 demo 時看到資料頁「1 images · 3 RT objects」、計畫「20 Gy · 1 fractions」。
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { EN } from '../src/core/i18n/en';
import { installEnglish, setLang, t, type MessageParams } from '../src/core/i18n';

const PLURALS =
  /(^|[^\d.])1 (?:[A-Z]{2,} )?(structures|files|characters|phases|frames|versions|times|steps|images|items|pairs|cases|events|days|voxels|sets|contours|drafts|tags|results|points|handles|patients|objects|instances|associations|shots|edits|fractions)\b/;

beforeAll(async () => {
  installEnglish(EN);
  await setLang('en');
});
afterAll(async () => {
  await setLang('zh-TW');
});

describe('英文單複數', () => {
  it('計數 1 用單數、其他用複數，一句裡可以有好幾個計數', () => {
    expect(t('{image_series_count} 個影像 · {p1}個 RT 物件', { image_series_count: 1, p1: 3 })).toBe('1 image · 3 RT objects');
    expect(t('{image_series_count} 個影像 · {p1}個 RT 物件', { image_series_count: 2, p1: 1 })).toBe('2 images · 1 RT object');
    expect(t('{n} 次', { n: 1 })).toBe('1 fraction');
    expect(t('{n} 次', { n: 25 })).toBe('25 fractions');
  });

  it('動詞跟著變的句子', () => {
    expect(t('{unsubmitted} 筆編輯還在送出', { unsubmitted: 1 })).toBe('1 edit is still being sent');
    expect(t('{unsubmitted} 筆編輯還在送出', { unsubmitted: 3 })).toBe('3 edits are still being sent');
    expect(t('{unsavedTransient} 組未保存的 plugin 結果', { unsavedTransient: 1 })).toBe('1 unsaved set of plugin results');
  });

  it('每一條會算數量的譯文：參數全是 1 時不會出現「1 ＋ 複數名詞」', () => {
    const ones = new Proxy({}, { get: () => 1 }) as MessageParams;
    const bad = Object.entries(EN)
      .filter(([, v]) => typeof v === 'function')
      .map(([k, v]) => [k, (v as (p: MessageParams) => string)(ones)] as const)
      .filter(([, out]) => PLURALS.test(out));
    expect(bad).toEqual([]);
  });
});
