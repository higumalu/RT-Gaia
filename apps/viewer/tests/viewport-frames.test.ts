/**
 * 每一格鎖定的相位從 ViewerHost 搬成 `ViewportFrameLocks` —— 行為跟搬之前一樣。
 */

import { describe, expect, it } from 'vitest';

import { ViewportFrameLocks } from '../src/core/scene/viewportFrames';

describe('每一格鎖定的相位', () => {
  it('鎖、夾在範圍內、解除、快照、最後按過的那一格', () => {
    const l = new ViewportFrameLocks();
    l.set('left', 'tg', 7.4, 10);
    l.set('right', 'tg', 99, 10); // 夾到 9
    l.set('right', 'other', -3, 4); // 夾到 0
    expect(l.snapshot()).toEqual({ left: { tg: 7 }, right: { tg: 9, other: 0 } });
    expect(l.overrideFor('left')('tg')).toBe(7);
    expect(l.overrideFor('axial')('tg')).toBeUndefined();
    expect(l.drawingLock('tg')).toBeUndefined();
    l.lastPointerViewportId = 'right';
    expect(l.drawingLock('tg')).toBe(9);
    l.set('right', 'tg', null, 10);
    l.set('right', 'other', 2, null); // 時間軸不在了 ＝ 解除
    expect(l.snapshot()).toEqual({ left: { tg: 7 } });
    expect([...l.allLockedFrames()].map((m) => Object.fromEntries(m))).toEqual([{ tg: 7 }]);
  });
});
