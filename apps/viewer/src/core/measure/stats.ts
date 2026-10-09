/**
 * 面積／體積 ROI 的 HU 統計（HU 統計是必要輸出，不是加分項）。
 * 前端已有體素資料，本地算；影像還沒到 lod 0 就標 `approximate`（與讀數 R1c 同規則）。
 *
 * 取樣網格：面積 ＝ 在量測平面上以影像最細間距步進、落在多邊形內的點（最近體素）；
 * 體積 ROI ＝ 方框內的體素中心。體積超過 `MAX_SAMPLES` 時等距跳點（結果標 approximate）。
 */

import type { Vec3, ViewReference } from '../geometry';
import { containsIndex, cross3, dot3, indexToWorld, normalize3, worldToIndex, worldToNearestVoxel } from '../geometry';
import type { Measurement, MeasurementResult } from '../layers/types';
import type { ImageEntry } from '../scene/volumeStore';
import { boxBounds, pointAt, pointInPlanePolygon } from './geometry';

export const MAX_SAMPLES = 400_000;

export interface MeasurementStats extends NonNullable<MeasurementResult['stats']> {
  readonly approximate: boolean;
}

function accumulate(values: number[], approximate: boolean): MeasurementStats | null {
  if (values.length === 0) return null;
  let sum = 0;
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  for (const v of values) {
    sum += v;
    if (v < min) min = v;
    if (v > max) max = v;
  }
  const mean = sum / values.length;
  let ss = 0;
  for (const v of values) ss += (v - mean) * (v - mean);
  return { mean, min, max, stdev: Math.sqrt(ss / values.length), voxelCount: values.length, approximate };
}

export function voxelAt(entry: Pick<ImageEntry, 'grid' | 'voxels'>, ijk: readonly [number, number, number]): number | null {
  if (!containsIndex(entry.grid, ijk)) return null;
  const [nx, ny] = entry.grid.size;
  return entry.voxels[ijk[0] + nx * (ijk[1] + ny * ijk[2])] ?? null;
}

/** 面積量測：多邊形內的取樣點（量測平面上、**同一個 FoR** 的世界座標）。 */
export function areaStats(m: Measurement, entry: ImageEntry): MeasurementStats | null {
  const view = m.viewReference;
  const n = Math.floor(m.points.length / 3);
  if (view === null || n < 3) return null;
  const polygon: Vec3[] = [];
  for (let i = 0; i < n; i += 1) polygon.push(pointAt(m.points, i));
  const right = normalize3(cross3(view.viewUp, view.viewPlaneNormal));
  const up = view.viewUp;
  const step = Math.min(...entry.grid.spacing);
  let u0 = Number.POSITIVE_INFINITY;
  let u1 = Number.NEGATIVE_INFINITY;
  let v0 = Number.POSITIVE_INFINITY;
  let v1 = Number.NEGATIVE_INFINITY;
  for (const p of polygon) {
    const u = dot3(right, p);
    const v = dot3(up, p);
    u0 = Math.min(u0, u);
    u1 = Math.max(u1, u);
    v0 = Math.min(v0, v);
    v1 = Math.max(v1, v);
  }
  // 平面上的原點：把多邊形第一點沿 right／up 分解，剩下的就是平面內的常數部分
  const anchor = polygon[0]!;
  const base: Vec3 = [
    anchor[0] - right[0] * dot3(right, anchor) - up[0] * dot3(up, anchor),
    anchor[1] - right[1] * dot3(right, anchor) - up[1] * dot3(up, anchor),
    anchor[2] - right[2] * dot3(right, anchor) - up[2] * dot3(up, anchor),
  ];
  const values: number[] = [];
  const seen = new Set<number>();
  const [nx, ny] = entry.grid.size;
  for (let v = v0 + step / 2; v < v1; v += step) {
    for (let u = u0 + step / 2; u < u1; u += step) {
      const world: Vec3 = [base[0] + right[0] * u + up[0] * v, base[1] + right[1] * u + up[1] * v, base[2] + right[2] * u + up[2] * v];
      if (!pointInPlanePolygon(world, polygon, view)) continue;
      const ijk = worldToNearestVoxel(entry.grid, world);
      const value = voxelAt(entry, ijk);
      if (value === null) continue;
      const key = ijk[0] + nx * (ijk[1] + ny * ijk[2]);
      if (seen.has(key)) continue; // 取樣比體素細時同一體素只算一次
      seen.add(key);
      values.push(value);
    }
  }
  return accumulate(values, entry.lod > 0);
}

/** 體積 ROI：方框內的體素中心。 */
export function boxStats(m: Measurement, entry: ImageEntry): MeasurementStats | null {
  if (m.points.length < 6) return null;
  const { min, max } = boxBounds(m.points);
  // 索引空間的包圍盒（網格可能有方向餘弦，取 8 角的極值）
  const corners: Vec3[] = [];
  for (const x of [min[0], max[0]]) for (const y of [min[1], max[1]]) for (const z of [min[2], max[2]]) corners.push([x, y, z]);
  const lo = [Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY];
  const hi = [Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY];
  for (const c of corners) {
    const idx = worldToIndex(entry.grid, c);
    for (let a = 0; a < 3; a += 1) {
      lo[a] = Math.min(lo[a]!, idx[a]!);
      hi[a] = Math.max(hi[a]!, idx[a]!);
    }
  }
  const size = entry.grid.size;
  const i0 = Math.max(0, Math.ceil(lo[0]!));
  const j0 = Math.max(0, Math.ceil(lo[1]!));
  const k0 = Math.max(0, Math.ceil(lo[2]!));
  const i1 = Math.min(size[0] - 1, Math.floor(hi[0]!));
  const j1 = Math.min(size[1] - 1, Math.floor(hi[1]!));
  const k1 = Math.min(size[2] - 1, Math.floor(hi[2]!));
  if (i1 < i0 || j1 < j0 || k1 < k0) return null;
  const total = (i1 - i0 + 1) * (j1 - j0 + 1) * (k1 - k0 + 1);
  const stride = Math.max(1, Math.ceil(Math.cbrt(total / MAX_SAMPLES)));
  const values: number[] = [];
  for (let k = k0; k <= k1; k += stride) {
    for (let j = j0; j <= j1; j += stride) {
      for (let i = i0; i <= i1; i += stride) {
        const w = indexToWorld(entry.grid, [i, j, k]);
        if (w[0] < min[0] || w[0] > max[0] || w[1] < min[1] || w[1] > max[1] || w[2] < min[2] || w[2] > max[2]) continue;
        const value = voxelAt(entry, [i, j, k]);
        if (value !== null) values.push(value);
      }
    }
  }
  return accumulate(values, entry.lod > 0 || stride > 1);
}

/** 標記點：那一個體素的值（`voxelCount` 1）。 */
export function pointStats(m: Measurement, entry: ImageEntry): MeasurementStats | null {
  if (m.points.length < 3) return null;
  const value = voxelAt(entry, worldToNearestVoxel(entry.grid, pointAt(m.points, 0)));
  return value === null ? null : { mean: value, min: value, max: value, stdev: 0, voxelCount: 1, approximate: entry.lod > 0 };
}

export function measurementStats(m: Measurement, entry: ImageEntry | undefined): MeasurementStats | null {
  if (entry === undefined) return null;
  switch (m.kind) {
    case 'area':
      return areaStats(m, entry);
    case 'roi3d':
      return boxStats(m, entry);
    case 'point':
      return pointStats(m, entry);
    case 'distance':
    case 'angle':
    case 'cobb':
    case 'curve':
    case 'landmark':
      return null;
  }
}

export type { ViewReference as MeasurementPlane };
