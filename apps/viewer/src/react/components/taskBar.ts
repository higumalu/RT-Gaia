/**
 * 第二層工具列的**純邏輯**：分群、任務互斥、側欄收合的儲存。零 React。
 */

import type { PanelGroup, PanelRegistration } from '../../core';

/** 同時只開一個的任務模式。檢視模式（mpr／dvh／render3d）不在內：開 ROI 不該把 MPR 關掉。 */
export const TASK_MODES: readonly string[] = ['roi', 'measure', 'review', 'export', 'registration'];

export const GROUP_ORDER: readonly PanelGroup[] = ['case', 'task', 'tool', 'view', 'layout', 'readout', 'diagnostic'];

export function groupOf(p: PanelRegistration): PanelGroup {
  return p.group ?? 'tool';
}

/** 依群分組、群內照 order；沒有面板的群不出現。 */
export function groupToolbarPanels(panels: readonly PanelRegistration[]): { group: PanelGroup; panels: PanelRegistration[] }[] {
  const out: { group: PanelGroup; panels: PanelRegistration[] }[] = [];
  for (const g of GROUP_ORDER) {
    const list = panels.filter((p) => groupOf(p) === g).sort((a, b) => a.order - b.order);
    if (list.length > 0) out.push({ group: g, panels: list });
  }
  return out;
}

/** 開一個任務模式 → 其他任務模式關掉（互斥）；關閉或非任務模式照舊。回傳「要一起設定」的清單。 */
/** 任務模式：內建五個 ＋ 所有 `plugin:<id>`。同時只開一個。 */
export function isTaskMode(id: string): boolean {
  return TASK_MODES.includes(id) || id.startsWith('plugin:');
}

export function modeChanges(current: readonly string[], id: string, enabled: boolean): { id: string; enabled: boolean }[] {
  const changes: { id: string; enabled: boolean }[] = [];
  if (enabled && isTaskMode(id)) {
    for (const m of current) if (m !== id && isTaskMode(m)) changes.push({ id: m, enabled: false });
  }
  changes.push({ id, enabled });
  return changes;
}

export type SidebarSide = 'left' | 'right';
export const COLLAPSE_STORAGE_KEY = 'rtgaia.sidebar.collapsed.v1';

export interface CollapseState {
  readonly left: boolean;
  readonly right: boolean;
}

export function readCollapsed(raw: string | null | undefined): CollapseState {
  if (!raw) return { left: false, right: false };
  try {
    const v = JSON.parse(raw) as Partial<CollapseState>;
    return { left: v.left === true, right: v.right === true };
  } catch {
    return { left: false, right: false };
  }
}

/** 「專注影像」＝兩欄都收；再按一次回到按下前的狀態。 */
export function toggleFocus(state: CollapseState, remembered: CollapseState | null): { state: CollapseState; remembered: CollapseState | null } {
  const focused = state.left && state.right;
  if (focused) return { state: remembered ?? { left: false, right: false }, remembered: null };
  return { state: { left: true, right: true }, remembered: state };
}
