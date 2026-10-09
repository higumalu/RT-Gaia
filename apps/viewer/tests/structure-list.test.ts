/**
 * 結構清單的點擊語意（編輯對象選取）。
 *
 * ⚠️ **這是原始碼層級的守衛，不是行為測試。** 這個專案沒有 jsdom／React 元件
 * 測試環境（見 `vitest.config.ts`），而 `tests/boundaries.test.ts` 已經確立了
 * 「用靜態原始碼檢查守住無法在單元測試裡執行的性質」這個做法。真正的行為驗證
 * 屬於 Playwright 那一層。
 *
 * 守的是什麼：
 *
 * 一列裡有兩個**語意完全不同**的點擊目標：
 *
 * | 目標 | 動作 |
 * |---|---|
 * | 勾選框 | 顯示／隱藏（純檢視） |
 * | 色塊＋名稱 | **設為編輯對象**（筆刷會寫進去的那個結構） |
 *
 * 🔴 原本 `<li>` 的 `onClick` 是 `onSelect`，而 `<label>` 同時包住勾選框與名稱，
 * 於是**點勾選框想看一下某個結構，就順手把筆刷的作用對象換成了它**。畫面上
 * 唯一的線索是那一列的高亮，很容易錯過。實測：點 `Body` 的勾選框後
 * `activeStructureId` 變成 `Body`，接著在心臟上畫的一筆真的送出了
 * `POST /structures/Body/edit` 並被後端接受（`status: edited`）。
 *
 * 對一個描邊產品來說，「編輯打到錯的結構且不留痕跡」是最不能有的那類缺陷。
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath, URL } from 'node:url';

import { describe, expect, it } from 'vitest';

const source = readFileSync(
  fileURLToPath(new URL('../src/react/components/StructureList.tsx', import.meta.url)),
  'utf8',
);

describe('可見性切換不得改變編輯對象', () => {
  it('勾選框所在的 label 有 stopPropagation', () => {
    // `<li>` 的 onClick 會設定編輯對象；勾選框是它的子節點，因此必須攔住冒泡。
    // 注意不能用 `<label[^>]*>` 之類的寫法找開頭標籤 —— `onClick={(e) =>` 裡的
    // 箭號本身就有 `>`，會提早收尾。直接取整個 label 區塊。
    const block = (source.match(/<label[\s\S]*?<\/label>/g) ?? []).find((b) =>
      b.includes('className="visibility"'),
    );
    expect(block).toBeDefined();
    expect(block!).toContain('type="checkbox"');
    expect(block!).toContain('stopPropagation');
  });

  it('勾選框沒有和名稱共用同一個 label', () => {
    // 共用的話「點名字」會同時切換可見性與設定編輯對象——兩個動作黏在一起
    const labelBlocks = source.match(/<label[\s\S]*?<\/label>/g) ?? [];
    for (const block of labelBlocks) {
      if (!block.includes('type="checkbox"')) continue;
      expect(block).not.toContain('className="name"');
    }
  });

  it('名稱本身仍然是設定編輯對象的目標（否則沒辦法選）', () => {
    expect(source).toMatch(/className="name"[\s\S]{0,80}點一下設為編輯對象/);
    expect(source).toContain('props.onSelect?.(row.layer.contentRef)');
  });
});
