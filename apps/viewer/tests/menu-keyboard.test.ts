/**
 * 共用選單鍵盤的純換算與項目選取（語言項目 menuitemradio 也在循環裡）。
 */
import { describe, expect, it } from 'vitest';

import { MENU_ITEM_SELECTOR, nextMenuIndex } from '../src/react/components/useMenuKeyboard';

describe('nextMenuIndex', () => {
  it('↓／↑ 循環、Home／End 到頭；焦點不在選單裡時 ↓ 到第一項、↑ 到最後一項', () => {
    expect(nextMenuIndex('ArrowDown', 0, 3)).toBe(1);
    expect(nextMenuIndex('ArrowDown', 2, 3)).toBe(0);
    expect(nextMenuIndex('ArrowUp', 0, 3)).toBe(2);
    expect(nextMenuIndex('ArrowDown', -1, 3)).toBe(0);
    expect(nextMenuIndex('ArrowUp', -1, 3)).toBe(2);
    expect(nextMenuIndex('Home', 2, 3)).toBe(0);
    expect(nextMenuIndex('End', 0, 3)).toBe(2);
  });

  it('不是選單鍵、或沒有項目 → null（不攔）', () => {
    expect(nextMenuIndex('a', 0, 3)).toBeNull();
    expect(nextMenuIndex('Enter', 0, 3)).toBeNull();
    expect(nextMenuIndex('ArrowDown', -1, 0)).toBeNull();
  });

  it('項目選取器涵蓋 menuitem、menuitemradio（語言）、menuitemcheckbox（plugin 開關）', () => {
    for (const role of ['menuitem', 'menuitemradio', 'menuitemcheckbox']) expect(MENU_ITEM_SELECTOR).toContain(`[role="${role}"]`);
  });
});
