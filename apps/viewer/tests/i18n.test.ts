/**
 * 多語系的防退步：
 * 1. `tests/i18n-pending.json` 以外的檔案，不得有 `t()`／`msg()` 以外的中文字面值（新檔案一律要處理；遷移完就從清單拿掉）。
 * 2. 每個 `t()`／`msg()` 的原文在英文字典都有譯文，且 `{佔位符}` 一致。
 * 3. 清單裡的檔案若已經乾淨，要從清單拿掉（清單只會縮小）。
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { lookup, setLang, t, getLang } from '../src/core/i18n';
import { scanTree } from './i18n-scan';

const ROOT = join(__dirname, '..');
const pending = new Set<string>(JSON.parse(readFileSync(join(__dirname, 'i18n-pending.json'), 'utf8')) as string[]);
const results = scanTree(join(ROOT, 'src'), ROOT);
const placeholders = (s: string): string[] => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]!).sort();

describe('多語系', () => {
  it('遷移過的檔案沒有 t()／msg() 以外的中文字面值', () => {
    const bad = [...results.entries()]
      .filter(([f]) => !pending.has(f))
      .flatMap(([, r]) => [...r.untranslated, ...r.dynamic])
      .map((x) => `${x.file}:${x.line} ${x.text}`);
    expect(bad).toEqual([]);
  });

  it('待遷移清單只會縮小：已經乾淨的要拿掉', () => {
    const clean = [...pending].filter((f) => {
      const r = results.get(f);
      return r === undefined || r.untranslated.length + r.dynamic.length === 0;
    });
    expect(clean).toEqual([]);
  });

  it('每個原文都有英文譯文、佔位符一致', () => {
    const missing: string[] = [];
    const mismatch: string[] = [];
    for (const r of results.values()) {
      for (const s of r.sources) {
        const entry = lookup('en', s.source, s.ctx);
        if (entry === undefined) missing.push(`${s.file}:${s.line} ${s.ctx ? `${s.ctx}|` : ''}${s.source}`);
        else if (typeof entry === 'string' && placeholders(entry).join() !== placeholders(s.source).join()) mismatch.push(`${s.file}:${s.line} ${s.source} → ${entry}`);
      }
    }
    expect(missing).toEqual([]);
    expect(mismatch).toEqual([]);
  });

  it('t：繁中回原文、英文查字典、插值、缺譯文退回原文、ctx', () => {
    const before = getLang();
    try {
      void setLang('zh-TW');
      expect(t('登入')).toBe('登入');
      expect(t('結構（{p0}）', { p0: 3 })).toBe('結構（3）');
      void setLang('en');
      expect(t('登入')).toBe('Sign in');
      expect(t('結構（{p0}）', { p0: 3 })).toBe('Structures ({p0})'.replace('{p0}', '3'));
      expect(t('這一句沒有譯文 {x}', { x: 1 })).toBe('這一句沒有譯文 1');
    } finally {
      void setLang(before);
    }
  });
});

describe('預設語言', () => {
  it('沒有 ?lang=、也沒選過語言 → 英文（介面預設英文）', async () => {
    vi.resetModules();
    const fresh = await import('../src/core/i18n');
    expect(fresh.DEFAULT_LANG).toBe('en');
    expect(fresh.getLang()).toBe('en');
  });

  it('index.html 的開機字樣跟同一個預設（沒選過 → 英文；選了繁中才是中文）', () => {
    const html = readFileSync(join(__dirname, '../index.html'), 'utf8');
    expect(html).toContain('<html lang="en">');
    expect(html).toContain('Loading RT-Gaia…');
    expect(html).toContain("saved !== 'zh-TW'");
  });
});

