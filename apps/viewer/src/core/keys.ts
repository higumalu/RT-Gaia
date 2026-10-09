/**
 * 快捷鍵與滑鼠操作的**單一來源**。
 *
 * 之前散落：`ViewerHost.handleKey`（Delete／Backspace／Escape）、`AppNav`／`PluginsMenu`（方向鍵）、`Sidebar`
 * （←／→ 調寬）、`bindings.ts`（滑鼠）。這裡不接管那些處理器（它們各自在正確的作用域），只做兩件事：
 * (1) 列表 —— 說明面板與導覽從這裡產生；(2) `resolveGlobalKey()` —— App 層的全域鍵（工具字母鍵、Ctrl+Z／Y、`?`）。
 * 工具的字母鍵從 `ToolPlugin.hotkey` 讀，plugin 註冊的工具自然也在表裡。
 */

import { DEFAULT_BINDINGS, type InteractionAction, type MouseBindings } from './interaction/bindings';
import { listTools, type ToolPlugin } from './tools/registry';
import { msg, t } from './i18n';

export type KeyScope = 'global' | 'viewport' | 'sidebar' | 'menu' | 'dialog';

export interface KeyBinding {
  readonly id: string;
  /** 顯示用（例：`Ctrl+Z`、`Delete／Backspace`）。 */
  readonly keys: string;
  readonly label: string;
  readonly scope: KeyScope;
}

/** 核心固定的鍵（不含工具字母鍵 —— 那些由 `toolKeyBindings()` 從註冊表產生）。 */
export const CORE_KEYS: readonly KeyBinding[] = [
  { id: 'undo', keys: 'Ctrl+Z', label: msg('復原上一筆編輯'), scope: 'global' },
  { id: 'redo', keys: msg('Ctrl+Y／Ctrl+Shift+Z'), label: msg('重做'), scope: 'global' },
  { id: 'help', keys: msg('?／F1'), label: msg('開關快捷鍵說明'), scope: 'global' },
  { id: 'escape', keys: 'Esc', label: msg('取消選取的量測／結束頂點編輯／關閉對話框與選單'), scope: 'viewport' },
  { id: 'delete-measurement', keys: msg('Delete／Backspace'), label: msg('刪除選取的量測'), scope: 'viewport' },
  { id: 'finish-polygon', keys: msg('Enter／雙擊'), label: msg('結束面積多邊形'), scope: 'viewport' },
  { id: 'slice-step', keys: msg('↑／↓'), label: msg('上一張／下一張切片'), scope: 'viewport' },
  { id: 'slice-page', keys: msg('PageUp／PageDown'), label: msg('跳 10 張切片'), scope: 'viewport' },
  { id: 'slice-ends', keys: msg('Home／End'), label: msg('跳到第一張／最後一張'), scope: 'viewport' },
  { id: 'sidebar-width', keys: msg('←／→（Shift 加速）；雙擊或 Enter 回預設'), label: msg('側欄分隔線：調整寬度'), scope: 'sidebar' },
  { id: 'menu-nav', keys: msg('↑／↓／Home／End'), label: msg('選單內移動；Esc 關閉'), scope: 'menu' },
];

export interface MouseBindingRow {
  readonly gesture: string;
  readonly label: string;
}

const ACTION_LABEL: Record<InteractionAction, string> = {
  'active-tool': msg('作用中的工具（十字線＝移動十字線；筆刷＝畫）'),
  pan: msg('平移'),
  'window-level': msg('WW／WL（作用中的影像）'),
  'scroll-slice': msg('換切片'),
  zoom: msg('縮放（以游標為中心）'),
  'handle-drag': msg('拖曳控制點'),
  none: '—',
};

function modifierText(m: { shift?: boolean; ctrl?: boolean; alt?: boolean }): string {
  const parts = [m.ctrl ? 'Ctrl' : '', m.shift ? 'Shift' : '', m.alt ? 'Alt' : ''].filter(Boolean);
  return parts.length === 0 ? '' : `${parts.join('+')}+`;
}

const BUTTON_LABEL = { left: msg('左鍵拖曳'), middle: msg('中鍵拖曳'), right: msg('右鍵拖曳') } as const;

/** 2D 格的滑鼠操作表 —— 由 `bindings.ts` 的實際綁定產生，不另外手寫一份。 */
export function mouseBindingRows(bindings: MouseBindings = DEFAULT_BINDINGS): MouseBindingRow[] {
  const rows: MouseBindingRow[] = bindings.drags.map((b) => ({
    gesture: `${modifierText(b.modifiers)}${t(BUTTON_LABEL[b.button])}`,
    label: t(ACTION_LABEL[b.action]),
  }));
  for (const w of bindings.wheels) rows.push({ gesture: t('{p0}滾輪', { p0: modifierText(w.modifiers) }), label: t(ACTION_LABEL[w.action]) });
  rows.push({ gesture: t('右緣切片捲軸：拖曳或點一下'), label: t('快速換切片（滾輪在捲軸上也可以）') });
  rows.push({ gesture: t('3D 格：左鍵轉 · 滾輪前後 · 右鍵／Shift+左鍵平移'), label: t('3D 靜態出圖的相機') });
  return rows;
}

/** 工具字母鍵：從註冊表讀（含 plugin 的工具）；沒有 `hotkey` 的工具不列。 */
export function toolKeyBindings(tools: readonly ToolPlugin[] = listTools()): KeyBinding[] {
  return tools
    .filter((tool) => typeof tool.hotkey === 'string' && tool.hotkey.length === 1 && tool.hidden !== true)
    .map((tool) => ({ id: `tool:${tool.id}`, keys: tool.hotkey!.toUpperCase(), label: t('工具：{label}', { label: t(tool.label) }), scope: 'global' as const }));
}

/** 同一個字母被兩個工具用到 → 回傳衝突的字母（plugin 註冊時可用來警告）。 */
export function duplicateHotkeys(tools: readonly ToolPlugin[] = listTools()): string[] {
  const seen = new Map<string, number>();
  for (const t of tools) if (t.hotkey) seen.set(t.hotkey.toUpperCase(), (seen.get(t.hotkey.toUpperCase()) ?? 0) + 1);
  return [...seen].filter(([, n]) => n > 1).map(([k]) => k);
}

export type GlobalKeyAction = { kind: 'undo' } | { kind: 'redo' } | { kind: 'help' } | { kind: 'tool'; toolId: string };

export interface KeyEventLike {
  readonly key: string;
  readonly ctrlKey: boolean;
  readonly metaKey?: boolean;
  readonly shiftKey: boolean;
  readonly altKey?: boolean;
  /** 事件目標是不是文字輸入（input／textarea／select／contentEditable）—— 是就不攔。 */
  readonly inTextInput: boolean;
}

/** App 層全域鍵的判定。回 null ＝ 不歸這裡管（讓瀏覽器或 viewport 的處理器去）。 */
export function resolveGlobalKey(e: KeyEventLike, tools: readonly ToolPlugin[] = listTools()): GlobalKeyAction | null {
  if (e.inTextInput) return null;
  const ctrl = e.ctrlKey || e.metaKey === true;
  const k = e.key;
  if (ctrl && !e.altKey) {
    if (k === 'z' || k === 'Z') return e.shiftKey ? { kind: 'redo' } : { kind: 'undo' };
    if (k === 'y' || k === 'Y') return { kind: 'redo' };
    return null;
  }
  if (k === '?' || k === 'F1') return { kind: 'help' };
  if (k.length !== 1 || e.altKey) return null;
  const upper = k.toUpperCase();
  const tool = tools.find((t) => t.hidden !== true && t.hotkey?.toUpperCase() === upper);
  return tool ? { kind: 'tool', toolId: tool.id } : null;
}

/** DOM 事件 → `KeyEventLike`。 */
export function keyEventOf(e: KeyboardEvent): KeyEventLike {
  const t = e.target as HTMLElement | null;
  const tag = t?.tagName?.toLowerCase() ?? '';
  const inTextInput = tag === 'input' || tag === 'textarea' || tag === 'select' || t?.isContentEditable === true;
  return { key: e.key, ctrlKey: e.ctrlKey, metaKey: e.metaKey, shiftKey: e.shiftKey, altKey: e.altKey, inTextInput };
}
