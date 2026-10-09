/**
 * 參考線（顯示目前十字線位置在其他兩個切面上的位置）的**純幾何**。
 *
 * 做法同 Slicer 的 slice intersections：對本格的切面 P₀（origin o₀、法線 n₀），把另一格的切面 P₁ 與 P₀ 的
 * **交線**畫出來 —— 三格互畫，兩條線的交點就是十字線（三個平面的共同點）。全部在世界座標（LPS mm），
 * 交給 painter 的 `project()` 換像素（overlayRegistry P3）。零 React。
 */

import { cross3, dot3, normalize3, norm3, scale3, sub3, add3, type OrthoOrientation, type Vec3, type ViewReference } from '../../../core';

/** 顏色沿用放射科慣例（Slicer）：軸向紅、冠狀綠、矢狀黃；斜面用它「出發的」方位色。 */
export const ORIENTATION_COLOR: Record<OrthoOrientation, string> = {
  axial: 'rgba(230, 76, 76, 0.9)',
  coronal: 'rgba(76, 200, 120, 0.9)',
  sagittal: 'rgba(240, 200, 60, 0.9)',
};

const PARALLEL_EPS = 1e-4;

/**
 * 平面 P₁ 與 P₀ 的交線：回 `{point, dir}`（單位向量），平行（或同一平面）→ null。
 * 點取交線上離 P₁ 原點最近的那一點，這樣把 ±extent 的線段畫出來時大致以十字線為中心。
 */
export function planeIntersection(p0: ViewReference, p1: ViewReference): { point: Vec3; dir: Vec3 } | null {
  const n0 = normalize3(p0.viewPlaneNormal);
  const n1 = normalize3(p1.viewPlaneNormal);
  const dir = cross3(n0, n1);
  const len = norm3(dir);
  if (len < PARALLEL_EPS) return null;
  const d = scale3(dir, 1 / len);
  // 從 P₁ 的原點出發，沿「在 P₁ 內、垂直於交線」的方向走到 P₀ 上：t = n0·(o0 − o1) / n0·u，u = n1 × d
  const u = cross3(n1, d);
  const denom = dot3(n0, u);
  if (Math.abs(denom) < PARALLEL_EPS) return null;
  const t = dot3(n0, sub3(p0.planeOrigin, p1.planeOrigin)) / denom;
  return { point: add3(p1.planeOrigin, scale3(u, t)), dir: d };
}

/** 交線上以 `center` 為中心、半長 `halfMm` 的線段兩端。 */
export function segmentEndpoints(line: { point: Vec3; dir: Vec3 }, halfMm: number): [Vec3, Vec3] {
  return [add3(line.point, scale3(line.dir, -halfMm)), add3(line.point, scale3(line.dir, halfMm))];
}

/** 要在 viewport `self` 上畫的參考線：其他每一個（不同平面的）2D viewport 一條。 */
export function referenceLinesFor(
  self: { viewportId: string; camera: ViewReference },
  all: readonly { viewportId: string; orientation: OrthoOrientation; camera: ViewReference }[],
  halfMm: number,
): { viewportId: string; color: string; ends: [Vec3, Vec3] }[] {
  const out: { viewportId: string; color: string; ends: [Vec3, Vec3] }[] = [];
  for (const other of all) {
    if (other.viewportId === self.viewportId) continue;
    if (other.camera.frameOfReferenceUid !== self.camera.frameOfReferenceUid) continue;
    const line = planeIntersection(self.camera, other.camera);
    if (line === null) continue; // 同方位的兩格（平行）不畫
    out.push({ viewportId: other.viewportId, color: ORIENTATION_COLOR[other.orientation], ends: segmentEndpoints(line, halfMm) });
  }
  return out;
}

/** 同步游標的顏色（青色、虛線）—— 和三個方位色都不同，一眼知道它是「游標」不是「切面」。 */
export const CURSOR_COLOR = 'rgba(90, 209, 255, 0.95)';

/** 兩格切面平行（同方位；例如並排比較的左右兩格）。 */
export function isParallel(a: ViewReference, b: ViewReference): boolean {
  return planeIntersection(a, b) === null;
}

/** 把世界座標點投到切面上（沿法線）。 */
export function projectOntoPlane(view: ViewReference, p: Vec3): Vec3 {
  const n = normalize3(view.viewPlaneNormal);
  const d = dot3(n, sub3(p, view.planeOrigin));
  return sub3(p, scale3(n, d));
}

/**
 * 平行格的同步游標（平行的格子也要有，兩組影像才方便比較）：
 * 指標在另一格、且那一格和本格切面**平行**（交線畫不出來）時，把指標位置投到本格，畫一個橫＋直的虛線十字。
 * 指標在本格自己、或在不平行的格（那邊已有交線）、或別的 FoR → 不畫。
 */
export function parallelCursorFor(
  self: { viewportId: string; camera: ViewReference },
  all: readonly { viewportId: string; camera: ViewReference }[],
  cursor: { viewportId: string; world: Vec3 } | null,
  halfMm: number,
): [Vec3, Vec3][] {
  if (cursor === null || cursor.viewportId === self.viewportId) return [];
  const source = all.find((v) => v.viewportId === cursor.viewportId);
  if (source === undefined) return [];
  if (source.camera.frameOfReferenceUid !== self.camera.frameOfReferenceUid) return [];
  if (!isParallel(self.camera, source.camera)) return [];
  const p = projectOntoPlane(self.camera, cursor.world);
  const up = normalize3(self.camera.viewUp);
  const right = normalize3(cross3(up, normalize3(self.camera.viewPlaneNormal)));
  return [
    [add3(p, scale3(right, -halfMm)), add3(p, scale3(right, halfMm))],
    [add3(p, scale3(up, -halfMm)), add3(p, scale3(up, halfMm))],
  ];
}
