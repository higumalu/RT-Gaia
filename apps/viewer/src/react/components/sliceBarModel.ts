/**
 * 切片捲軸的純換算（2026-09-29）：捲軸上的位置 ↔ 第幾張。拇指固定高度 `THUMB_PX`，
 * 軌道可用長度是 `軌道高 − THUMB_PX`，指標對準拇指中心 —— 拖曳時拇指不會跳離游標。
 */

export const THUMB_PX = 18;

/** 第 `index` 張（共 `count`）→ 0–1（拇指在可用長度上的位置）。 */
export function fractionOf(index: number, count: number): number {
  if (count <= 1) return 0;
  return Math.max(0, Math.min(1, index / (count - 1)));
}

/** 指標在軌道內的 y（CSS px，從軌道頂端算）→ 第幾張。 */
export function indexAtY(y: number, trackPx: number, count: number): number {
  if (count <= 1) return 0;
  const usable = Math.max(1, trackPx - THUMB_PX);
  const frac = Math.max(0, Math.min(1, (y - THUMB_PX / 2) / usable));
  return Math.round(frac * (count - 1));
}

/** 滾輪一格走幾張：與 viewport 上的滾輪同一條規則（`EventLayer`：每 100 deltaY 一格、至少一格）。 */
export function wheelSteps(deltaY: number): number {
  if (deltaY === 0) return 0;
  return Math.sign(deltaY) * Math.max(1, Math.round(Math.abs(deltaY) / 100));
}
