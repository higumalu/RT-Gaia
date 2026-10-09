/**
 * DOM 事件 → 指令（`interaction/eventLayer.ts`）。
 *
 * > **vtk.js widget 接不進來**（Cornerstone 沒有掛 vtk interactor），
 * > 因此互動一律自建。這也讓 GPU 與 CPU 兩條路徑**共用同一個事件層**——
 * > 它只產生指令，不碰任何 vtk 物件。
 *
 * ## 品質狀態的唯一觸發點
 *
 * `pointerdown` → `beginInteraction()`；`pointerup` → `endInteraction()`。
 * 高品質重切、outline 全解析度補算、「停止互動後補到
 * 全解析度」都吊在這一個時機點上（同一次 flush）。
 */

import type { SvgHandle } from '../overlay/svgOverlay';
import type { Vec2 } from '../raster/types';
import {
  buttonOf,
  DEFAULT_BINDINGS,
  modifiersOf,
  resolveDrag,
  resolveWheel,
  type InteractionAction,
  type MouseBindings,
  type Modifiers,
} from './bindings';

export interface InteractionCommand {
  action: InteractionAction;
  viewportId: string;
  /** canvas 像素座標。 */
  position: Vec2;
  /** 相對上一個事件的位移（像素）。 */
  delta: Vec2;
  /** 滾輪的刻度數（正值 = 向下／遠離使用者）。 */
  wheelTicks: number;
  phase: 'begin' | 'move' | 'end';
  /** `action === 'handle-drag'` 時：按下時命中的 handle（整段拖曳都帶同一個）。 */
  handle?: SvgHandle;
  /** 按下當下的修飾鍵（整段拖曳都帶同一個）—— 工具據此分流（例：十字線導航要 Shift）。 */
  modifiers: Modifiers;
}

export interface EventLayerOptions {
  viewportId: string;
  bindings?: MouseBindings;
  onCommand: (command: InteractionCommand) => void;
  /** 互動開始／結束的通知 —— 品質狀態的唯一觸發點。 */
  onInteractionBegin?: () => void;
  onInteractionEnd?: () => void;
  /**
   * 指標位置（容器內 CSS 像素），離開時為 null —— 讀數探測點。
   *
   * 🔴 **與 `onCommand` 刻意分開。** `InteractionCommand` 是「綁定表解析出來的
   * 動作」，而 hover 不是動作：它沒有按鍵、不可設定、也不該出現在綁定表裡。
   * 混進去的代價是每個 `switch (command.action)` 都要處理一個
   * 不是動作的東西。
   */
  onHover?: (position: Vec2 | null, modifiers?: Modifiers) => void;
  /**
   * 🔴 hit-test **優先於綁定表**：左鍵按在 handle 上就是 `handle-drag`，
   * 不進 `active-tool` —— 否則筆刷會蓋掉 handle，症狀是「筆刷偶爾點不到」。
   * 座標是容器內 CSS 像素（與 `onHover` 同一套）。
   */
  hitTest?: (position: Vec2) => SvgHandle | null;
}

export interface PointerLike {
  clientX: number;
  clientY: number;
  button: number;
  shiftKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  metaKey?: boolean;
  preventDefault?: () => void;
}

export interface WheelLike {
  clientX: number;
  clientY: number;
  deltaY: number;
  shiftKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  metaKey?: boolean;
  preventDefault?: () => void;
}

/**
 * 純邏輯的事件層 —— **不 import 任何 DOM 型別以外的東西**。
 *
 * 因此它可以在 Node 下完整測試（滑鼠綁定與拖曳語意是手感的核心，
 * 不該只能靠手動試）。
 */
export class EventLayer {
  private readonly bindings: MouseBindings;
  private active: { action: InteractionAction; last: Vec2; modifiers: Modifiers; handle?: SvgHandle } | null = null;
  /** 目前螢幕座標的來源矩形（由呼叫端在 resize 時更新）。 */
  private origin: Vec2 = { x: 0, y: 0 };

  constructor(private readonly options: EventLayerOptions) {
    this.bindings = options.bindings ?? DEFAULT_BINDINGS;
  }

  setOrigin(origin: Vec2): void {
    this.origin = origin;
  }

  private local(event: { clientX: number; clientY: number }): Vec2 {
    return { x: event.clientX - this.origin.x, y: event.clientY - this.origin.y };
  }

  pointerDown(event: PointerLike): InteractionCommand | null {
    // 讀數要先更新：按下但不移動也該看到值
    this.options.onHover?.(this.local(event), modifiersOf(event));
    const button = buttonOf(event.button);
    if (button === null) return null;
    const position = this.local(event);
    // 左鍵先問 hit-test；命中 handle 就不看綁定表
    const handle = button === 'left' ? (this.options.hitTest?.(position) ?? null) : null;
    const action: InteractionAction =
      handle !== null ? 'handle-drag' : resolveDrag(this.bindings, button, modifiersOf(event));
    if (action === 'none') return null;
    // 右鍵拖曳 WW/WL 必須擋掉瀏覽器選單，否則手感直接壞掉
    event.preventDefault?.();
    const modifiers = modifiersOf(event);
    this.active = { action, last: position, modifiers, ...(handle ? { handle } : {}) };
    this.options.onInteractionBegin?.();
    const command: InteractionCommand = {
      action,
      viewportId: this.options.viewportId,
      position,
      delta: { x: 0, y: 0 },
      wheelTicks: 0,
      phase: 'begin',
      modifiers,
      ...(handle ? { handle } : {}),
    };
    this.options.onCommand(command);
    return command;
  }

  pointerMove(event: PointerLike): InteractionCommand | null {
    // 🔴 **在 early return 之前。** 沒有拖曳時也要有讀數 —— 那正是常見用法
    // （移過去看一下 HU），而舊版在這裡直接 return，因此完全沒有 hover 事件。
    this.options.onHover?.(this.local(event), modifiersOf(event));
    if (this.active === null) return null;
    const position = this.local(event);
    const delta = { x: position.x - this.active.last.x, y: position.y - this.active.last.y };
    this.active.last = position;
    const command: InteractionCommand = {
      action: this.active.action,
      viewportId: this.options.viewportId,
      position,
      delta,
      wheelTicks: 0,
      phase: 'move',
      modifiers: this.active.modifiers,
      ...(this.active.handle ? { handle: this.active.handle } : {}),
    };
    this.options.onCommand(command);
    return command;
  }

  pointerUp(event: PointerLike): InteractionCommand | null {
    if (this.active === null) return null;
    const position = this.local(event);
    const command: InteractionCommand = {
      action: this.active.action,
      viewportId: this.options.viewportId,
      position,
      delta: { x: position.x - this.active.last.x, y: position.y - this.active.last.y },
      wheelTicks: 0,
      phase: 'end',
      modifiers: this.active.modifiers,
      ...(this.active.handle ? { handle: this.active.handle } : {}),
    };
    this.active = null;
    this.options.onCommand(command);
    // 🔴 「停止互動後補到全解析度」吊在這裡
    this.options.onInteractionEnd?.();
    return command;
  }

  wheel(event: WheelLike): InteractionCommand | null {
    const action = resolveWheel(this.bindings, modifiersOf(event));
    if (action === 'none') return null;
    event.preventDefault?.();
    const position = this.local(event);
    const command: InteractionCommand = {
      action,
      viewportId: this.options.viewportId,
      position,
      delta: { x: 0, y: 0 },
      // 一格 ≈ 100 px 的 deltaY（跨瀏覽器差異大，因此正規化成刻度）
      wheelTicks: Math.sign(event.deltaY) * Math.max(1, Math.round(Math.abs(event.deltaY) / 100)),
      phase: 'begin',
      modifiers: modifiersOf(event),
    };
    this.options.onCommand(command);
    // 滾輪是離散事件：立刻結束互動，讓 settle 計時器重新開始
    this.options.onInteractionBegin?.();
    this.options.onInteractionEnd?.();
    return command;
  }

  /** 指標離開 viewport —— 讀數改為「凍結」（R3 註記）。 */
  pointerLeave(): void {
    this.options.onHover?.(null);
  }

  isActive(): boolean {
    return this.active !== null;
  }

  cancel(): void {
    if (this.active === null) return;
    this.active = null;
    this.options.onInteractionEnd?.();
  }
}

/**
 * ⚠️ **這不是 viewport 的 zoom。** viewport 的 zoom 是
 * `core/scene/cameras.ts` 的 `zoomCameraAtCursor()`（它改的是相機的 `pxMm`
 * 與 `planeOrigin`）。
 *
 * 這一個改的是 **overlay 的 2D 仿射變換** ——
 * 「**Pan / Zoom 不讓輪廓失效：對既有 polyline 做 2D 仿射變換，這是精確的**」
 * 那條路徑。
 *
 * 🔴 **兩者同名曾經造成實際損害**：這一個有測試但沒有人呼叫，而真正在跑的
 * viewport zoom 是一段沒有測試的內聯數學、方向還寫反了。看到「zoom 有測試」
 * 就以為 zoom 沒問題，是那個 bug 能出貨的原因。
 *
 * 同樣以游標為中心：回傳新的 `PlaneToCanvas`，使 `cursor` 這一點在
 * 縮放前後落在同一個 canvas 像素上。
 */
export function zoomAtCursor(
  transform: { scale: number; offsetX: number; offsetY: number },
  cursor: Vec2,
  factor: number,
): { scale: number; offsetX: number; offsetY: number } {
  const scale = transform.scale * factor;
  return {
    scale,
    offsetX: cursor.x - (cursor.x - transform.offsetX) * factor,
    offsetY: cursor.y - (cursor.y - transform.offsetY) * factor,
  };
}
