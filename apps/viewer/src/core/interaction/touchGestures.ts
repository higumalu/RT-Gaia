/**
 * 觸控手勢 → 抽象操作。**純邏輯**（時鐘與計時器由呼叫端注入），跟 `EventLayer` 一樣可以在 Node 下完整測試。
 *
 * | 手勢 | `scroll`（沒選畫圖工具） | `tool`（選了畫圖工具、手指可以畫） | `window`（工具列「調窗」開著） |
 * |---|---|---|---|
 * | 一指拖曳 | 換切片 | 用工具（交給 `EventLayer`，跟滑鼠左鍵同一條路） | 調窗寬窗位 |
 * | 一指點一下 | 讀數 | 工具點一下（圈選加一個頂點…） | 讀數 |
 * | 一指點兩下 | — | 結束目前工具的動作（＝ 滑鼠雙擊；圈選收口） | — |
 * | 長按 | 讀數 ＋ 十字線移到那裡 | —（按住不動就是畫一點） | 同 `scroll` |
 * | 雙指 | 縮放 ＋ 平移 | 同左（不用換工具就能放大修邊） | 同左 |
 *
 * 🔴 **一指不立刻開始。** 雙指縮放時兩隻手指幾乎不會同時落下 —— 第一隻手指一落下就開始畫，
 * 第二隻到的時候已經畫了一點。所以一指要等：移動超過 `TOUCH_SLOP_PX`、或過了 `TOOL_COMMIT_MS`（工具模式）
 * 才算數；在那之前第二隻手指到了，就整個當成雙指。
 *
 * 座標一律是 client 座標（CSS 像素）；換成格子內的座標是呼叫端的事。
 */

import type { Vec2 } from '../raster/types';

export type TouchMode = 'scroll' | 'tool' | 'window';

export interface TouchPoint {
  readonly id: number;
  readonly x: number;
  readonly y: number;
}

export type TouchOp =
  /** 互動開始／結束（品質狀態；工具模式不發 —— `EventLayer` 自己會發）。 */
  | { readonly kind: 'begin' }
  | { readonly kind: 'end' }
  | { readonly kind: 'scroll'; readonly ticks: number; readonly position: Vec2 }
  | { readonly kind: 'window'; readonly delta: Vec2; readonly position: Vec2 }
  /** `scale` ＞ 1 ＝ 放大；`pan` ＝ 兩指中點這一步移了多少。 */
  | { readonly kind: 'pinch'; readonly center: Vec2; readonly scale: number; readonly pan: Vec2 }
  | { readonly kind: 'tool'; readonly phase: 'down' | 'move' | 'up'; readonly position: Vec2 }
  | { readonly kind: 'tap'; readonly position: Vec2 }
  | { readonly kind: 'double-tap'; readonly position: Vec2 }
  | { readonly kind: 'long-press'; readonly position: Vec2 };

/** 手指抖動的容許範圍（CSS px）；超過才算拖曳。 */
export const TOUCH_SLOP_PX = 8;
/** 工具模式：手指放著這麼久還沒有第二隻手指 → 開始畫。 */
export const TOOL_COMMIT_MS = 90;
export const LONG_PRESS_MS = 500;
/** 換切片：手指移動這麼多 px ＝ 一張。 */
export const SCROLL_PX_PER_SLICE = 12;
export const DOUBLE_TAP_MS = 350;
export const DOUBLE_TAP_PX = 24;

export interface TouchGestureOptions {
  /** 手指落下的當下用哪一種模式（之後整段手勢不變）。 */
  readonly mode: () => TouchMode;
  readonly emit: (op: TouchOp) => void;
  readonly now?: () => number;
  readonly setTimer?: (fn: () => void, ms: number) => unknown;
  readonly clearTimer?: (handle: unknown) => void;
}

type State =
  | { readonly kind: 'idle' }
  | { readonly kind: 'pending'; readonly id: number; readonly mode: TouchMode; readonly start: Vec2; last: Vec2; readonly t0: number; timer: unknown }
  | { readonly kind: 'drag'; readonly id: number; readonly mode: TouchMode; readonly start: Vec2; last: Vec2; readonly t0: number; moved: number; scrollAcc: number }
  | { readonly kind: 'pinch'; readonly points: Map<number, Vec2>; lastDist: number; lastCenter: Vec2 }
  /** 多指手勢收尾：剩下的手指全部放開之前什麼都不做（不讓最後一隻手指變成拖曳或畫圖）。 */
  | { readonly kind: 'tail'; readonly ids: Set<number> };

const dist = (a: Vec2, b: Vec2): number => Math.hypot(a.x - b.x, a.y - b.y);
const mid = (a: Vec2, b: Vec2): Vec2 => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });

export class TouchGestures {
  private state: State = { kind: 'idle' };
  private lastTap: { position: Vec2; t: number } | null = null;
  private readonly now: () => number;
  private readonly setTimer: (fn: () => void, ms: number) => unknown;
  private readonly clearTimer: (handle: unknown) => void;

  constructor(private readonly options: TouchGestureOptions) {
    this.now = options.now ?? (() => Date.now());
    this.setTimer = options.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimer = options.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
  }

  /** 有沒有手指在畫面上（host 用來決定 hover 該不該處理）。 */
  isActive(): boolean {
    return this.state.kind !== 'idle';
  }

  down(p: TouchPoint): void {
    const s = this.state;
    const at = { x: p.x, y: p.y };
    switch (s.kind) {
      case 'idle': {
        const mode = this.options.mode();
        if (mode === 'tool' && this.lastTap !== null && this.now() - this.lastTap.t < DOUBLE_TAP_MS && dist(this.lastTap.position, at) < DOUBLE_TAP_PX) {
          this.lastTap = null;
          this.options.emit({ kind: 'double-tap', position: at });
          this.state = { kind: 'tail', ids: new Set([p.id]) };
          return;
        }
        const pending: State = { kind: 'pending', id: p.id, mode, start: at, last: at, t0: this.now(), timer: null };
        pending.timer = mode === 'tool' ? this.setTimer(() => this.commit(), TOOL_COMMIT_MS) : this.setTimer(() => this.longPress(), LONG_PRESS_MS);
        this.state = pending;
        return;
      }
      case 'pending':
        this.clearTimer(s.timer);
        this.startPinch(s.id, s.last, p.id, at);
        return;
      case 'drag':
        // 已經在畫／換切片時第二隻手指到了 → 收掉一指的動作，改成雙指
        if (s.mode === 'tool') this.options.emit({ kind: 'tool', phase: 'up', position: s.last });
        else this.options.emit({ kind: 'end' });
        this.startPinch(s.id, s.last, p.id, at);
        return;
      case 'pinch':
        // 第三隻手指：不參與，放開時跟著收尾
        return;
      case 'tail':
        s.ids.add(p.id);
        return;
    }
  }

  move(p: TouchPoint): void {
    const s = this.state;
    const at = { x: p.x, y: p.y };
    if (s.kind === 'pending') {
      if (p.id !== s.id) return;
      s.last = at;
      if (dist(s.start, at) > TOUCH_SLOP_PX) {
        this.commit();
        this.move(p);
      }
      return;
    }
    if (s.kind === 'drag') {
      if (p.id !== s.id) return;
      const delta = { x: at.x - s.last.x, y: at.y - s.last.y };
      s.last = at;
      s.moved = Math.max(s.moved, dist(s.start, at));
      if (s.mode === 'tool') {
        this.options.emit({ kind: 'tool', phase: 'move', position: at });
      } else if (s.mode === 'window') {
        this.options.emit({ kind: 'window', delta, position: at });
      } else {
        s.scrollAcc += delta.y;
        const ticks = Math.trunc(s.scrollAcc / SCROLL_PX_PER_SLICE);
        if (ticks !== 0) {
          s.scrollAcc -= ticks * SCROLL_PX_PER_SLICE;
          this.options.emit({ kind: 'scroll', ticks, position: at });
        }
      }
      return;
    }
    if (s.kind === 'pinch') {
      if (!s.points.has(p.id)) return;
      s.points.set(p.id, at);
      const [a, b] = [...s.points.values()] as [Vec2, Vec2];
      const d = dist(a, b);
      const c = mid(a, b);
      const scale = s.lastDist > 0 && d > 0 ? d / s.lastDist : 1;
      const pan = { x: c.x - s.lastCenter.x, y: c.y - s.lastCenter.y };
      s.lastDist = d;
      s.lastCenter = c;
      if (scale !== 1 || pan.x !== 0 || pan.y !== 0) this.options.emit({ kind: 'pinch', center: c, scale, pan });
    }
  }

  up(p: TouchPoint): void {
    const s = this.state;
    const at = { x: p.x, y: p.y };
    switch (s.kind) {
      case 'idle':
        return;
      case 'pending': {
        if (p.id !== s.id) return;
        this.clearTimer(s.timer);
        this.state = { kind: 'idle' };
        if (s.mode === 'tool') {
          // 點一下：照樣是一次完整的工具動作（圈選加頂點、筆刷點一點）
          this.options.emit({ kind: 'tool', phase: 'down', position: s.start });
          this.options.emit({ kind: 'tool', phase: 'up', position: s.start });
          this.lastTap = { position: s.start, t: this.now() };
        } else {
          this.options.emit({ kind: 'tap', position: s.start });
        }
        return;
      }
      case 'drag': {
        if (p.id !== s.id) return;
        this.state = { kind: 'idle' };
        if (s.mode === 'tool') {
          this.options.emit({ kind: 'tool', phase: 'up', position: at });
          // 計時器先觸發了、但手指幾乎沒動 → 仍算一下「點」（雙擊收口要認得出來）
          this.lastTap = s.moved <= TOUCH_SLOP_PX && this.now() - s.t0 < DOUBLE_TAP_MS ? { position: s.start, t: this.now() } : null;
        } else {
          this.options.emit({ kind: 'end' });
        }
        return;
      }
      case 'pinch': {
        if (!s.points.has(p.id)) return;
        s.points.delete(p.id);
        this.options.emit({ kind: 'end' });
        this.state = { kind: 'tail', ids: new Set(s.points.keys()) };
        if (s.points.size === 0) this.state = { kind: 'idle' };
        return;
      }
      case 'tail':
        s.ids.delete(p.id);
        if (s.ids.size === 0) this.state = { kind: 'idle' };
        return;
    }
  }

  /** `pointercancel`（瀏覽器接手、手指滑出去）：跟放開一樣收尾，但不算「點」。 */
  cancel(p: TouchPoint): void {
    const s = this.state;
    if (s.kind === 'pending' && p.id === s.id) {
      this.clearTimer(s.timer);
      this.state = { kind: 'idle' };
      return;
    }
    this.up(p);
  }

  private commit(): void {
    const s = this.state;
    if (s.kind !== 'pending') return;
    this.clearTimer(s.timer);
    this.state = { kind: 'drag', id: s.id, mode: s.mode, start: s.start, last: s.start, t0: s.t0, moved: 0, scrollAcc: 0 };
    if (s.mode === 'tool') this.options.emit({ kind: 'tool', phase: 'down', position: s.start });
    else this.options.emit({ kind: 'begin' });
    // 落下之後已經移動的那一段（超過容許範圍才 commit 的情況）由呼叫端接著的 move 處理
  }

  private longPress(): void {
    const s = this.state;
    if (s.kind !== 'pending' || s.mode === 'tool') return;
    this.state = { kind: 'tail', ids: new Set([s.id]) };
    this.options.emit({ kind: 'long-press', position: s.start });
  }

  private startPinch(idA: number, a: Vec2, idB: number, b: Vec2): void {
    this.state = { kind: 'pinch', points: new Map([[idA, a], [idB, b]]), lastDist: dist(a, b), lastCenter: mid(a, b) };
    this.lastTap = null;
    this.options.emit({ kind: 'begin' });
  }
}
