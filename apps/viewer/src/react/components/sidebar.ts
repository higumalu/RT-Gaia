/** 側欄寬度的純邏輯（2026-09-09 變更）：夾限、讀寫瀏覽器儲存。 */

export type SidebarSide = 'left' | 'right';

export const SIDEBAR_DEFAULT_WIDTH: Record<SidebarSide, number> = { left: 320, right: 280 };
export const SIDEBAR_MIN_WIDTH = 200;
export const SIDEBAR_MAX_WIDTH: Record<SidebarSide, number> = { left: 640, right: 720 };

export function sidebarStorageKey(side: SidebarSide): string {
  return `rtgaia.sidebar.${side}.width.v1`;
}

export function clampSidebarWidth(side: SidebarSide, width: number): number {
  if (!Number.isFinite(width)) return SIDEBAR_DEFAULT_WIDTH[side];
  return Math.round(Math.min(SIDEBAR_MAX_WIDTH[side], Math.max(SIDEBAR_MIN_WIDTH, width)));
}

/** 壞值／沒存 → 預設。 */
export function readSidebarWidth(side: SidebarSide, raw: string | null | undefined): number {
  if (raw === null || raw === undefined || raw === '') return SIDEBAR_DEFAULT_WIDTH[side];
  const n = Number(raw);
  return Number.isFinite(n) ? clampSidebarWidth(side, n) : SIDEBAR_DEFAULT_WIDTH[side];
}

/** 拖曳：起點寬度 ＋ 指標位移（右欄往左拖是變寬）。 */
export function draggedSidebarWidth(side: SidebarSide, startWidth: number, deltaX: number): number {
  return clampSidebarWidth(side, side === 'left' ? startWidth + deltaX : startWidth - deltaX);
}
