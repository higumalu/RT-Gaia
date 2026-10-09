/**
 * 觸控手勢狀態機（`core/interaction/touchGestures.ts`）。時鐘與計時器是假的，逐步推進。
 */
import { describe, expect, it } from 'vitest';

import { LONG_PRESS_MS, SCROLL_PX_PER_SLICE, TOOL_COMMIT_MS, TouchGestures, type TouchMode, type TouchOp } from '../src/core/interaction/touchGestures';

function rig(mode: TouchMode) {
  let now = 0;
  const timers: { at: number; fn: () => void; id: number }[] = [];
  let nextId = 1;
  const ops: TouchOp[] = [];
  let currentMode = mode;
  const g = new TouchGestures({
    mode: () => currentMode,
    emit: (op) => ops.push(op),
    now: () => now,
    setTimer: (fn, ms) => {
      const id = nextId++;
      timers.push({ at: now + ms, fn, id });
      return id;
    },
    clearTimer: (h) => {
      const i = timers.findIndex((t) => t.id === h);
      if (i >= 0) timers.splice(i, 1);
    },
  });
  const advance = (ms: number): void => {
    now += ms;
    for (;;) {
      const due = timers.filter((t) => t.at <= now).sort((a, b) => a.at - b.at)[0];
      if (!due) break;
      timers.splice(timers.indexOf(due), 1);
      due.fn();
    }
  };
  return { g, ops, advance, setMode: (m: TouchMode) => (currentMode = m), kinds: () => ops.map((o) => (o.kind === 'tool' ? `tool:${o.phase}` : o.kind)) };
}

describe('觸控手勢', () => {
  it('scroll 模式：一指拖曳 → 換切片（每 12 px 一張，累積到才發）', () => {
    const r = rig('scroll');
    r.g.down({ id: 1, x: 100, y: 100 });
    r.g.move({ id: 1, x: 100, y: 105 }); // 還在容許範圍內
    expect(r.ops).toEqual([]);
    r.g.move({ id: 1, x: 100, y: 100 + 3 * SCROLL_PX_PER_SLICE + 2 });
    r.g.up({ id: 1, x: 100, y: 140 });
    expect(r.kinds()).toEqual(['begin', 'scroll', 'end']);
    const scroll = r.ops.find((o) => o.kind === 'scroll');
    expect(scroll && scroll.kind === 'scroll' ? scroll.ticks : 0).toBe(3);
  });

  it('scroll 模式：往上拖是負的', () => {
    const r = rig('scroll');
    r.g.down({ id: 1, x: 0, y: 200 });
    r.g.move({ id: 1, x: 0, y: 200 - 2 * SCROLL_PX_PER_SLICE - 1 });
    const scroll = r.ops.find((o) => o.kind === 'scroll');
    expect(scroll && scroll.kind === 'scroll' ? scroll.ticks : 0).toBe(-2);
  });

  it('點一下 → tap（讀數）；長按 → long-press（十字線），放開後不再有動作', () => {
    const r = rig('scroll');
    r.g.down({ id: 1, x: 10, y: 20 });
    r.g.up({ id: 1, x: 10, y: 20 });
    expect(r.kinds()).toEqual(['tap']);
    r.g.down({ id: 2, x: 30, y: 40 });
    r.advance(LONG_PRESS_MS + 1);
    r.g.move({ id: 2, x: 80, y: 90 });
    r.g.up({ id: 2, x: 80, y: 90 });
    expect(r.kinds()).toEqual(['tap', 'long-press']);
  });

  it('雙指 → pinch（縮放比例與中點位移）；放開一隻後剩下那隻不會變成拖曳', () => {
    const r = rig('scroll');
    r.g.down({ id: 1, x: 100, y: 100 });
    r.g.down({ id: 2, x: 200, y: 100 });
    r.g.move({ id: 2, x: 300, y: 100 }); // 距離 100 → 200
    const pinch = r.ops.find((o) => o.kind === 'pinch');
    expect(pinch && pinch.kind === 'pinch' ? pinch.scale : 0).toBeCloseTo(2);
    expect(pinch && pinch.kind === 'pinch' ? pinch.pan : null).toEqual({ x: 50, y: 0 });
    r.g.up({ id: 1, x: 100, y: 100 });
    r.g.move({ id: 2, x: 300, y: 300 });
    r.g.up({ id: 2, x: 300, y: 300 });
    expect(r.kinds()).toEqual(['begin', 'pinch', 'end']);
  });

  it('工具模式：等 90 ms 才下筆；在那之前第二隻手指到了 → 完全不畫，改成雙指', () => {
    const r = rig('tool');
    r.g.down({ id: 1, x: 50, y: 50 });
    r.advance(TOOL_COMMIT_MS - 30);
    r.g.down({ id: 2, x: 150, y: 50 });
    r.g.move({ id: 2, x: 160, y: 50 });
    r.g.up({ id: 1, x: 50, y: 50 });
    r.g.up({ id: 2, x: 160, y: 50 });
    expect(r.kinds()).not.toContain('tool:down');
    expect(r.kinds()[0]).toBe('begin');
  });

  it('工具模式：放著超過 90 ms → 下筆，拖曳跟著畫，放開收筆', () => {
    const r = rig('tool');
    r.g.down({ id: 1, x: 50, y: 50 });
    r.advance(TOOL_COMMIT_MS + 1);
    r.g.move({ id: 1, x: 70, y: 50 });
    r.g.up({ id: 1, x: 70, y: 50 });
    expect(r.kinds()).toEqual(['tool:down', 'tool:move', 'tool:up']);
  });

  it('工具模式：一落下就拖超過容許範圍 → 立刻下筆（不用等計時器）', () => {
    const r = rig('tool');
    r.g.down({ id: 1, x: 50, y: 50 });
    r.g.move({ id: 1, x: 70, y: 50 });
    expect(r.kinds()).toEqual(['tool:down', 'tool:move']);
  });

  it('工具模式：畫到一半第二隻手指到了 → 先收筆，再變雙指', () => {
    const r = rig('tool');
    r.g.down({ id: 1, x: 50, y: 50 });
    r.g.move({ id: 1, x: 70, y: 50 });
    r.g.down({ id: 2, x: 200, y: 50 });
    expect(r.kinds()).toEqual(['tool:down', 'tool:move', 'tool:up', 'begin']);
  });

  it('工具模式：點兩下 → double-tap（＝ 雙擊收口），第二下不是一個新頂點', () => {
    const r = rig('tool');
    r.g.down({ id: 1, x: 50, y: 50 });
    r.g.up({ id: 1, x: 50, y: 50 });
    r.advance(150);
    r.g.down({ id: 2, x: 55, y: 52 });
    r.g.up({ id: 2, x: 55, y: 52 });
    expect(r.kinds()).toEqual(['tool:down', 'tool:up', 'double-tap']);
  });

  it('工具模式：兩下隔太久 → 兩次點擊', () => {
    const r = rig('tool');
    r.g.down({ id: 1, x: 50, y: 50 });
    r.g.up({ id: 1, x: 50, y: 50 });
    r.advance(600);
    r.g.down({ id: 2, x: 50, y: 50 });
    r.g.up({ id: 2, x: 50, y: 50 });
    expect(r.kinds()).toEqual(['tool:down', 'tool:up', 'tool:down', 'tool:up']);
  });

  it('window 模式：一指拖曳 → 調窗（帶位移）', () => {
    const r = rig('window');
    r.g.down({ id: 1, x: 0, y: 0 });
    r.g.move({ id: 1, x: 20, y: 5 });
    r.g.up({ id: 1, x: 20, y: 5 });
    expect(r.kinds()).toEqual(['begin', 'window', 'end']);
    const w = r.ops.find((o) => o.kind === 'window');
    expect(w && w.kind === 'window' ? w.delta : null).toEqual({ x: 20, y: 5 });
  });

  it('模式在手指落下時決定（拖到一半改模式不影響這一段）', () => {
    const r = rig('scroll');
    r.g.down({ id: 1, x: 0, y: 0 });
    r.setMode('tool');
    r.g.move({ id: 1, x: 0, y: 30 });
    r.g.up({ id: 1, x: 0, y: 30 });
    expect(r.kinds()).toEqual(['begin', 'scroll', 'end']);
  });

  it('pointercancel：還沒開始的手勢直接丟掉，不算點擊', () => {
    const r = rig('scroll');
    r.g.down({ id: 1, x: 0, y: 0 });
    r.g.cancel({ id: 1, x: 0, y: 0 });
    r.advance(LONG_PRESS_MS + 10);
    expect(r.ops).toEqual([]);
    expect(r.g.isActive()).toBe(false);
  });
});
