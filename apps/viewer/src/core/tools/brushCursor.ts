/**
 * 筆刷／橡皮擦的範圍預覽（只看設定半徑的數字沒辦法直觀知道修改範圍）。
 *
 * 純幾何：把「半徑 mm」換成「畫布上的半徑 px」——從指標所在的世界點沿平面內的一個方向走 r mm，
 * 再投影回畫布，取距離。這樣縮放、斜面、非等向 spacing 都自動正確；球與圓在當前平面上的截面同樣是這個圓。
 */

import type { Vec3 } from '../geometry';
import type { Vec2 } from '../raster/types';

export const BRUSH_PREVIEW_TOOL_IDS: ReadonlySet<string> = new Set(['brush', 'eraser', 'threshold-brush']);

export interface BrushCursorProjection {
  canvasToWorld(x: number, y: number): Vec3;
  worldToCanvas(world: Vec3): Vec2;
}

export function brushCursorPx(
  proj: BrushCursorProjection,
  centerPx: Vec2,
  radiusMm: number,
  inPlaneAxis: Vec3,
): { x: number; y: number; r: number } {
  const c = proj.canvasToWorld(centerPx.x, centerPx.y);
  const n = Math.hypot(inPlaneAxis[0], inPlaneAxis[1], inPlaneAxis[2]) || 1;
  const edge: Vec3 = [c[0] + (inPlaneAxis[0] / n) * radiusMm, c[1] + (inPlaneAxis[1] / n) * radiusMm, c[2] + (inPlaneAxis[2] / n) * radiusMm];
  const p0 = proj.worldToCanvas(c);
  const p1 = proj.worldToCanvas(edge);
  return { x: p0.x, y: p0.y, r: Math.hypot(p1.x - p0.x, p1.y - p0.y) };
}
