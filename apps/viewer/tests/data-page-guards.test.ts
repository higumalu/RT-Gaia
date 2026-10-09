/**
 * 資料頁的原始碼守衛（沒有 jsdom；做法同 `structure-list.test.ts`）。
 *
 * 病人／study 列的 `<tr onClick>` 會展開，列裡的箭頭 button 也會展開 ——
 * 箭頭不擋冒泡就切換兩次，看起來像「點箭頭沒反應」。守住：expander 的 onClick 有 stopPropagation，且列內操作
 * （送出、下載、刪除）也都擋冒泡。
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath, URL } from 'node:url';

import { describe, expect, it } from 'vitest';

const source = readFileSync(fileURLToPath(new URL('../src/react/data/DataPage.tsx', import.meta.url)), 'utf8');

describe('資料頁列內按鈕不得冒泡到整列的展開', () => {
  it('展開箭頭有 stopPropagation 與 aria-expanded', () => {
    const block = (source.match(/<button[\s\S]*?className="expander"[\s\S]*?<\/button>/g) ?? [])[0];
    expect(block).toBeDefined();
    expect(block!).toContain('stopPropagation');
    expect(block!).toContain('aria-expanded');
  });
  it('送出／刪除按鈕與下載連結都擋冒泡', () => {
    for (const name of ['SendButton', 'DeleteButton', 'DownloadLink']) {
      const start = source.indexOf(`function ${name}(`);
      expect(start).toBeGreaterThan(-1);
      const end = source.indexOf('\n}\n', start);
      expect(source.slice(start, end)).toContain('stopPropagation');
    }
  });
});
