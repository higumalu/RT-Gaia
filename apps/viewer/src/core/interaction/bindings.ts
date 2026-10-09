/**
 * 滑鼠綁定。
 *
 * > **這是全新的介面，沒有既有慣例可繼承。**
 * > 綁定是一個真正的設計決定，不是遷移約束。
 *
 * 取自兩個外部慣例：**放射科工作站的既有習慣**（右鍵 WW/WL）與 **3D Slicer**
 * （其餘）。與 Slicer 唯一的刻意分歧是**右鍵**：Slicer 預設是 Zoom，本規格採
 * 放射科慣例的 WW/WL——理由是目標使用者是放射腫瘤科臨床端，不是影像研究者。
 *
 * **綁定必須可設定**，並在使用者設定中持久化。
 */

export type InteractionAction =
  | 'active-tool'
  | 'pan'
  | 'window-level'
  | 'scroll-slice'
  | 'zoom'
  /** 拖曳 svg overlay 上的 handle（十字線旋轉等）。**不在綁定表裡**：由 hit-test 決定。 */
  | 'handle-drag'
  | 'none';

export type MouseButton = 'left' | 'middle' | 'right';

export interface Modifiers {
  shift: boolean;
  ctrl: boolean;
  alt: boolean;
}

export const NO_MODIFIERS: Modifiers = { shift: false, ctrl: false, alt: false };

export interface DragBinding {
  button: MouseButton;
  modifiers: Partial<Modifiers>;
  action: InteractionAction;
}

export interface WheelBinding {
  modifiers: Partial<Modifiers>;
  action: InteractionAction;
}

export interface MouseBindings {
  drags: DragBinding[];
  wheels: WheelBinding[];
}

/** 預設綁定表。 */
export const DEFAULT_BINDINGS: MouseBindings = {
  drags: [
    { button: 'left', modifiers: {}, action: 'active-tool' },
    { button: 'middle', modifiers: {}, action: 'pan' },
    // 放射科慣例（Slicer 預設是 Zoom，此處刻意分歧）
    { button: 'right', modifiers: {}, action: 'window-level' },
    // Shift＋左鍵交給工具（十字線導航要 Shift，免得裸左鍵誤觸）
    { button: 'left', modifiers: { shift: true }, action: 'active-tool' },
    // 給只有左鍵的環境：Ctrl＋左鍵 pan
    { button: 'left', modifiers: { ctrl: true }, action: 'pan' },
  ],
  wheels: [
    { modifiers: { ctrl: true }, action: 'zoom' },
    { modifiers: {}, action: 'scroll-slice' },
  ],
};

function matches(required: Partial<Modifiers>, actual: Modifiers): boolean {
  for (const key of ['shift', 'ctrl', 'alt'] as const) {
    const want = required[key];
    if (want === undefined) continue;
    if (want !== actual[key]) return false;
  }
  return true;
}

/** 具體性（指定的修飾鍵越多）優先，因此 `Shift+左鍵` 會贏過 `左鍵`。 */
function specificity(modifiers: Partial<Modifiers>): number {
  return Object.values(modifiers).filter((v) => v !== undefined).length;
}

export function resolveDrag(
  bindings: MouseBindings,
  button: MouseButton,
  modifiers: Modifiers,
): InteractionAction {
  const candidates = bindings.drags
    .filter((b) => b.button === button && matches(b.modifiers, modifiers))
    .sort((a, b) => specificity(b.modifiers) - specificity(a.modifiers));
  return candidates[0]?.action ?? 'none';
}

export function resolveWheel(bindings: MouseBindings, modifiers: Modifiers): InteractionAction {
  const candidates = bindings.wheels
    .filter((b) => matches(b.modifiers, modifiers))
    .sort((a, b) => specificity(b.modifiers) - specificity(a.modifiers));
  return candidates[0]?.action ?? 'none';
}

/** DOM `MouseEvent.button` → 語意化按鍵。 */
export function buttonOf(domButton: number): MouseButton | null {
  if (domButton === 0) return 'left';
  if (domButton === 1) return 'middle';
  if (domButton === 2) return 'right';
  return null;
}

export function modifiersOf(event: {
  shiftKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  metaKey?: boolean;
}): Modifiers {
  return {
    shift: event.shiftKey,
    // macOS 的 Cmd 與 Ctrl 在此等價（zoom 的手感一致比平台純度重要）
    ctrl: event.ctrlKey || Boolean(event.metaKey),
    alt: event.altKey,
  };
}
