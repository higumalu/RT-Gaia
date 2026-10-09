/** 側欄寬度的純邏輯（2026-09-09 變更）。 */

import { describe, expect, it } from 'vitest';

import { estimateTextWidthPx } from '../src/core';
import { clampSidebarWidth, draggedSidebarWidth, readSidebarWidth, sidebarStorageKey } from '../src/react/components/sidebar';

describe('側欄寬度', () => {
  it('夾限：最小 200、左最大 640、右最大 720；非數字回預設', () => {
    expect(clampSidebarWidth('left', 50)).toBe(200);
    expect(clampSidebarWidth('left', 9999)).toBe(640);
    expect(clampSidebarWidth('right', 9999)).toBe(720);
    expect(clampSidebarWidth('right', Number.NaN)).toBe(280);
    expect(clampSidebarWidth('right', 333.6)).toBe(334);
  });

  it('讀儲存：沒存／壞值回預設；有存夾限後回', () => {
    expect(readSidebarWidth('right', null)).toBe(280);
    expect(readSidebarWidth('left', 'abc')).toBe(320);
    expect(readSidebarWidth('right', '400')).toBe(400);
    expect(readSidebarWidth('right', '10')).toBe(200);
    expect(sidebarStorageKey('right')).toBe('rtgaia.sidebar.right.width.v1');
  });

  it('拖曳：右欄往左拖變寬、左欄往右拖變寬', () => {
    expect(draggedSidebarWidth('right', 280, -100)).toBe(380);
    expect(draggedSidebarWidth('right', 280, 100)).toBe(200);
    expect(draggedSidebarWidth('left', 320, 100)).toBe(420);
  });
});

describe('量測標籤的估字寬', () => {
  it('CJK 一個字一 em、拉丁半個多；空字串 0', () => {
    expect(estimateTextWidthPx('')).toBe(0);
    expect(estimateTextWidthPx('距離')).toBe(26);
    expect(estimateTextWidthPx('12.3 mm')).toBe(Math.ceil(7 * 13 * 0.55));
  });
});
