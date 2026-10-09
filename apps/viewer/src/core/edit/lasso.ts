/**
 * 圈選（scissors；「矩形／圓形／自由圈，在當前平面上加入或移除」）。
 *
 * 多邊形頂點是 primary 世界座標（工具從畫面點來的）。光柵化到該結構 FoR 的 mask grid：
 * 只取**目前切面那一層**的體素（|沿法線距離| ≤ 半層厚，與 disc 筆刷同一條規則），
 * 在平面內以 even-odd 判斷是否在多邊形內。輸出 `VoxelPatch`（帶 coverage）→ 走既有的
 * `applyPatch`／`endStroke`：一筆 undo、一次送出。
 */

import type { FrameGroup, MaskGrid, Vec3 } from '../geometry';
import { cross3, dot3, fromPrimaryWorld, normalize3, worldToIndex } from '../geometry';
import { normalPitch, planeNormalOnGridAxes, normalizeIndexDirection, type VoxelPatch } from './brush';

export type LassoMode = 'add' | 'subtract';

export interface LassoSpec {
  readonly mode: LassoMode;
}

export const DEFAULT_LASSO: LassoSpec = { mode: 'add' };

/** 2D even-odd。 */
export function pointInPolygon2(px: number, py: number, poly: readonly (readonly [number, number])[]): boolean {
  let inside = false;
  const n = poly.length;
  for (let i = 0, j = n - 1; i < n; j = i, i += 1) {
    const [xi, yi] = poly[i]!;
    const [xj, yj] = poly[j]!;
    if (yi > py !== yj > py && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/**
 * 多邊形（primary 世界座標，≥ 3 點）在目前平面（法線 `planeNormalPrimary`、上向量 `viewUpPrimary`）上光柵化。
 * 回 `null` ＝ 沒有任何體素被圈到（多邊形在網格外、或太小）。
 */
export function rasterizeLasso(args: {
  maskGrid: MaskGrid;
  frameGroup: FrameGroup;
  polygonPrimaryWorld: readonly Vec3[];
  planeNormalPrimary: Vec3;
  viewUpPrimary: Vec3;
  mode: LassoMode;
}): VoxelPatch | null {
  const { maskGrid, frameGroup, polygonPrimaryWorld: poly } = args;
  if (poly.length < 3) return null;
  const grid = maskGrid.grid;
  // 平面基底（該序列自己的世界座標）
  const n = normalizeIndexDirection(maskGrid, frameGroup, args.planeNormalPrimary);
  const upOwn = normalizeIndexDirection(maskGrid, frameGroup, args.viewUpPrimary);
  const right = normalize3(cross3(upOwn, n));
  const up = normalize3(cross3(n, right));
  const own = poly.map((p) => fromPrimaryWorld(frameGroup, p));
  const origin = own[0]!;
  const uv = own.map((p) => [dot3(right, [p[0] - origin[0], p[1] - origin[1], p[2] - origin[2]]), dot3(up, [p[0] - origin[0], p[1] - origin[1], p[2] - origin[2]])] as const);
  // 平面到多邊形第一點的距離為 0；每個體素中心到平面的距離 ≤ 半層厚才算這一層
  const nOnAxes = planeNormalOnGridAxes(maskGrid, frameGroup, args.planeNormalPrimary);
  const halfPitch = normalPitch(grid.spacing, nOnAxes) / 2 + 1e-9;
  // 索引包圍盒：多邊形頂點 ± 一層
  const idx = own.map((p) => worldToIndex(grid, p));
  const lo = [0, 1, 2].map((a) => Math.max(0, Math.floor(Math.min(...idx.map((q) => q[a]!)) - 1))) as [number, number, number];
  const hi = [0, 1, 2].map((a) => Math.min(grid.size[a]! - 1, Math.ceil(Math.max(...idx.map((q) => q[a]!)) + 1))) as [number, number, number];
  if (lo.some((v, a) => v > hi[a]!)) return null;
  const size = [0, 1, 2].map((a) => hi[a]! - lo[a]! + 1) as [number, number, number];
  const data = new Uint8Array(size[0] * size[1] * size[2]);
  const coverage = new Uint8Array(data.length);
  const value = args.mode === 'subtract' ? 0 : 1;
  const d = grid.direction;
  const sp = grid.spacing;
  const o = grid.origin;
  let any = false;
  for (let k = lo[2]; k <= hi[2]; k += 1) {
    for (let j = lo[1]; j <= hi[1]; j += 1) {
      for (let i = lo[0]; i <= hi[0]; i += 1) {
        // 體素中心（自身世界座標）：origin + direction · (spacing ⊙ ijk)
        const wx = o[0] + d[0]! * sp[0] * i + d[1]! * sp[1] * j + d[2]! * sp[2] * k;
        const wy = o[1] + d[3]! * sp[0] * i + d[4]! * sp[1] * j + d[5]! * sp[2] * k;
        const wz = o[2] + d[6]! * sp[0] * i + d[7]! * sp[1] * j + d[8]! * sp[2] * k;
        const rx = wx - origin[0];
        const ry = wy - origin[1];
        const rz = wz - origin[2];
        const along = rx * n[0] + ry * n[1] + rz * n[2];
        if (Math.abs(along) > halfPitch) continue;
        const u = rx * right[0] + ry * right[1] + rz * right[2];
        const v = rx * up[0] + ry * up[1] + rz * up[2];
        if (!pointInPolygon2(u, v, uv)) continue;
        const at = (k - lo[2]) * size[1] * size[0] + (j - lo[1]) * size[0] + (i - lo[0]);
        data[at] = value;
        coverage[at] = 1;
        any = true;
      }
    }
  }
  return any ? { offsetIjk: lo, sizeIjk: size, data, coverage } : null;
}

export function readLasso(params: Record<string, unknown>): LassoSpec {
  const raw = params['lasso'];
  if (raw === null || typeof raw !== 'object') return DEFAULT_LASSO;
  const mode = (raw as Partial<LassoSpec>).mode;
  return { mode: mode === 'subtract' ? 'subtract' : 'add' };
}
