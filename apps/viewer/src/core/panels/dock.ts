/**
 * 側欄面板是**可拖的 dock** —— 使用者可以把面板移到另一側、調順序、摺起來。
 *
 * 模組照舊以 `slot: 'left-sidebar' | 'right-sidebar'` ＋ `order` 註冊（那是預設位置）；使用者的擺法是一層覆寫：
 * `placement[panelId] = {side, order}`、`folded[]`。沒覆寫的面板留在註冊的位置。覆寫依面板 id 存（跟著帳號同步），
 * 沒載入的面板（plugin 停用）覆寫留著，回來時回到使用者放的位置。純函式、零 React。
 */

import type { PanelRegistration } from './registry';

export type DockSide = 'left' | 'right';

export interface DockPlacement {
  readonly side: DockSide;
  readonly order: number;
}

export interface DockState {
  readonly placement: Readonly<Record<string, DockPlacement>>;
  readonly folded: readonly string[];
}

export const DOCK_STORAGE_KEY = 'rtgaia.dock.v1';
export const EMPTY_DOCK: DockState = { placement: {}, folded: [] };

export function isSidebarPanel(p: PanelRegistration): boolean {
  return p.slot === 'left-sidebar' || p.slot === 'right-sidebar';
}

export function dockSideOf(p: PanelRegistration, dock: DockState): DockSide {
  return dock.placement[p.id]?.side ?? (p.slot === 'left-sidebar' ? 'left' : 'right');
}

function dockOrderOf(p: PanelRegistration, dock: DockState): number {
  return dock.placement[p.id]?.order ?? p.order;
}

/** 某一側的面板（依使用者擺法；同順序以註冊順序、再以 id 定）。`panels` 通常是已套 `visibleWhen` 的清單。 */
export function panelsOnSide(panels: readonly PanelRegistration[], side: DockSide, dock: DockState): PanelRegistration[] {
  return panels
    .filter((p) => isSidebarPanel(p) && dockSideOf(p, dock) === side)
    .sort((a, b) => dockOrderOf(a, dock) - dockOrderOf(b, dock) || a.order - b.order || a.id.localeCompare(b.id));
}

/**
 * 把 `panelId` 移到 `side` 的 `beforeId` 前面（`null` ＝ 最後）。
 * `all` 是**所有**側欄面板（含目前不顯示的）：目標側整排重新編號，不顯示的面板相對位置不變。
 */
export function movePanel(dock: DockState, all: readonly PanelRegistration[], panelId: string, side: DockSide, beforeId: string | null): DockState {
  if (!all.some((p) => p.id === panelId && isSidebarPanel(p)) || beforeId === panelId) return dock;
  const column = panelsOnSide(all, side, dock).filter((p) => p.id !== panelId).map((p) => p.id);
  const at = beforeId === null ? -1 : column.indexOf(beforeId);
  column.splice(at < 0 ? column.length : at, 0, panelId);
  const placement: Record<string, DockPlacement> = { ...dock.placement };
  column.forEach((id, i) => {
    placement[id] = { side, order: (i + 1) * 10 };
  });
  return { ...dock, placement };
}

/** 在同一側上移（-1）／下移（+1）一格 —— 只看 `visible` 的相鄰面板（使用者看得到的順序）。 */
export function shiftPanel(dock: DockState, all: readonly PanelRegistration[], visible: readonly PanelRegistration[], panelId: string, delta: -1 | 1): DockState {
  const target = all.find((p) => p.id === panelId);
  if (target === undefined) return dock;
  const side = dockSideOf(target, dock);
  const column = panelsOnSide(visible, side, dock).map((p) => p.id);
  const i = column.indexOf(panelId);
  if (i < 0) return dock;
  if (delta < 0) {
    if (i === 0) return dock;
    return movePanel(dock, all, panelId, side, column[i - 1]!);
  }
  if (i === column.length - 1) return dock;
  return movePanel(dock, all, panelId, side, column[i + 2] ?? null);
}

export function toggleFolded(dock: DockState, panelId: string): DockState {
  const folded = dock.folded.includes(panelId) ? dock.folded.filter((id) => id !== panelId) : [...dock.folded, panelId];
  return { ...dock, folded };
}

export function isDockCustomized(dock: DockState): boolean {
  return Object.keys(dock.placement).length > 0 || dock.folded.length > 0;
}

export function serializeDock(dock: DockState): string {
  return JSON.stringify(dock);
}

/** 壞掉的字串 → 空的擺法，不拋；形狀不對的項目丟掉。 */
export function parseDock(text: string | null | undefined): DockState {
  if (!text) return EMPTY_DOCK;
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return EMPTY_DOCK;
  }
  if (typeof raw !== 'object' || raw === null) return EMPTY_DOCK;
  const r = raw as Record<string, unknown>;
  const placement: Record<string, DockPlacement> = {};
  if (typeof r['placement'] === 'object' && r['placement'] !== null) {
    for (const [id, v] of Object.entries(r['placement'] as Record<string, unknown>)) {
      const p = v as Record<string, unknown> | null;
      if ((p?.['side'] === 'left' || p?.['side'] === 'right') && typeof p['order'] === 'number' && Number.isFinite(p['order'])) {
        placement[id] = { side: p['side'], order: p['order'] };
      }
    }
  }
  const folded = Array.isArray(r['folded']) ? [...new Set(r['folded'].filter((x): x is string => typeof x === 'string'))] : [];
  return { placement, folded };
}
