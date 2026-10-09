/**
 * 量測的幾何。**純函式，零 DOM。**
 *
 * * `result` 永遠由 `points` 重算，不獨立儲存。
 * * `points` 是量測所屬 FoR 的世界座標（LPS mm）；要畫到 primary 的畫面上先經 FrameGroup。
 * * 面積量測綁一個平面（`viewReference`）；與目前平面不共面時只畫交線。
 */

import type { FrameGroup, Vec3, ViewReference } from '../geometry';
import { applyMat4, cross3, dot3, mat16ColumnMajorToRows, normalize3, signedDistance, sub3, toPrimaryWorld } from '../geometry';
import type { Measurement, MeasurementKind, MeasurementResult } from '../layers/types';

export function pointAt(p: Float64Array | readonly number[], i: number): [number, number, number] {
  return [p[i * 3]!, p[i * 3 + 1]!, p[i * 3 + 2]!];
}

export function pointCount(m: { points: Float64Array | readonly number[] }): number {
  return Math.floor(m.points.length / 3);
}

/** 每種量測需要幾個點才算完整（面積 ≥ 3）。 */
export function requiredPoints(kind: MeasurementKind): number {
  switch (kind) {
    case 'point':
      return 1;
    case 'distance':
    case 'roi3d':
      return 2;
    case 'area':
    case 'angle':
      return 3;
    case 'cobb':
      return 4;
    case 'curve':
    case 'landmark':
      return 2;
  }
}

/**
 * 地標對的 TRE（target registration error，mm）＝ |T(移動點) − 固定點|。`toPrimary` 把移動點（它自己 FoR 的座標）
 * 搬到 primary —— 呼叫端給**目前**的對位（含未提交的微調）。點不夠回 null。
 */
export function landmarkTre(points: Float64Array | readonly number[], toPrimary: (p: Vec3) => Vec3): number | null {
  if (points.length < 6) return null;
  const moved = toPrimary(pointAt(points, 0));
  const fixed = pointAt(points, 1);
  return Math.hypot(moved[0] - fixed[0], moved[1] - fixed[1], moved[2] - fixed[2]);
}

/** 量測要不要綁一個平面（`viewReference` 必填）。 */
export function isPlanarKind(kind: MeasurementKind): boolean {
  return kind === 'area' || kind === 'cobb';
}

/** 角 ABC（B 是頂點），度，0–180；三點重合回 0。3D 夾角，與平面無關。 */
export function angleDeg(a: Vec3, b: Vec3, c: Vec3): number {
  const u = sub3(a, b);
  const v = sub3(c, b);
  const lu = Math.hypot(u[0], u[1], u[2]);
  const lv = Math.hypot(v[0], v[1], v[2]);
  if (lu === 0 || lv === 0) return 0;
  const cos = Math.min(1, Math.max(-1, dot3(u, v) / (lu * lv)));
  return (Math.acos(cos) * 180) / Math.PI;
}

/**
 * Cobb 角：兩條線（p0–p1、p2–p3）投到量測平面後的夾角，度，0–180。
 * 每條線先轉成「朝畫面右邊」（沿平面的 right 軸分量 ≥ 0）—— 跟畫的方向無關，而且嚴重側彎（> 90°，
 * 兩條終板往相反方向傾斜超過 45°）量得出來；只取銳角的做法會把 100° 報成 80°。
 * 沒有平面（舊資料）→ 3D 直線夾角的銳角。
 */
export function cobbAngleDeg(p: Float64Array | readonly number[], view: ViewReference | null): number {
  if (p.length < 12) return 0;
  const d1 = sub3(pointAt(p, 1), pointAt(p, 0));
  const d2 = sub3(pointAt(p, 3), pointAt(p, 2));
  if (view === null) {
    const a = angleDeg(d1, [0, 0, 0], d2);
    return a > 90 ? 180 - a : a;
  }
  const right = normalize3(cross3(view.viewUp, view.viewPlaneNormal));
  const up = normalize3(view.viewUp);
  const flat = (d: Vec3): [number, number] => {
    const x = dot3(right, d);
    const y = dot3(up, d);
    return x < 0 || (x === 0 && y < 0) ? [-x, -y] : [x, y];
  };
  const [x1, y1] = flat(d1);
  const [x2, y2] = flat(d2);
  if ((x1 === 0 && y1 === 0) || (x2 === 0 && y2 === 0)) return 0;
  const a = Math.abs(Math.atan2(y1, x1) - Math.atan2(y2, x2));
  return (Math.min(a, 2 * Math.PI - a) * 180) / Math.PI;
}

/** 開放折線長度（3D，逐段相加）。 */
export function polylineLength(p: Float64Array | readonly number[]): number {
  let total = 0;
  for (let i = 3; i + 2 < p.length; i += 3) total += Math.hypot(p[i]! - p[i - 3]!, p[i + 1]! - p[i - 2]!, p[i + 2]! - p[i - 1]!);
  return total;
}

export function isComplete(m: Measurement): boolean {
  return pointCount(m) >= requiredPoints(m.kind);
}

/** 值：距離 mm（3D 歐氏）、面積 mm²（投到量測平面的 shoelace）、體積 cc（軸對齊方框）、點 0、角度／Cobb 度、曲線 mm。 */
export function measurementValue(m: Pick<Measurement, 'kind' | 'points' | 'viewReference'>): Pick<MeasurementResult, 'value' | 'unit'> {
  const p = m.points;
  switch (m.kind) {
    case 'distance': {
      if (p.length < 6) return { value: 0, unit: 'mm' };
      return { value: Math.hypot(p[3]! - p[0]!, p[4]! - p[1]!, p[5]! - p[2]!), unit: 'mm' };
    }
    case 'area': {
      const n = Math.floor(p.length / 3);
      if (n < 3 || m.viewReference === null) return { value: 0, unit: 'mm2' };
      const view = m.viewReference;
      const right = normalize3(cross3(view.viewUp, view.viewPlaneNormal));
      let area = 0;
      for (let i = 0; i < n; i += 1) {
        const j = (i + 1) % n;
        const a = pointAt(p, i);
        const b = pointAt(p, j);
        area += dot3(right, a) * dot3(view.viewUp, b) - dot3(right, b) * dot3(view.viewUp, a);
      }
      return { value: Math.abs(area) / 2, unit: 'mm2' };
    }
    case 'roi3d': {
      if (p.length < 6) return { value: 0, unit: 'cc' };
      return { value: (Math.abs(p[3]! - p[0]!) * Math.abs(p[4]! - p[1]!) * Math.abs(p[5]! - p[2]!)) / 1000, unit: 'cc' };
    }
    case 'point':
      return { value: 0, unit: 'mm' };
    case 'angle':
      return { value: p.length < 9 ? 0 : angleDeg(pointAt(p, 0), pointAt(p, 1), pointAt(p, 2)), unit: 'deg' };
    case 'cobb':
      return { value: cobbAngleDeg(p, m.viewReference), unit: 'deg' };
    case 'curve':
      return { value: polylineLength(p), unit: 'mm' };
    case 'landmark':
      // 沒有對位資訊時當成同一個座標系（host 用目前的對位覆寫，見 `landmarkTre`）
      return { value: landmarkTre(p, (q) => q) ?? 0, unit: 'mm' };
  }
}

/** 方框的 min／max 角（roi3d 的兩個點任意順序）。 */
export function boxBounds(p: Float64Array | readonly number[]): { min: [number, number, number]; max: [number, number, number] } {
  const a = pointAt(p, 0);
  const b = pointAt(p, 1);
  return {
    min: [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.min(a[2], b[2])],
    max: [Math.max(a[0], b[0]), Math.max(a[1], b[1]), Math.max(a[2], b[2])],
  };
}

/** 方框的 8 個角。 */
export function boxCorners(p: Float64Array | readonly number[]): [number, number, number][] {
  const { min, max } = boxBounds(p);
  const out: [number, number, number][] = [];
  for (const x of [min[0], max[0]]) for (const y of [min[1], max[1]]) for (const z of [min[2], max[2]]) out.push([x, y, z]);
  return out;
}

/** 把一個平面（某 FoR 自己的座標）搬到 primary 世界座標 —— `viewInFrame` 的反向。 */
export function viewToPrimary(view: ViewReference, fg: FrameGroup | null | undefined): ViewReference {
  if (!fg || fg.transformKind === 'identity') return view;
  const rows = mat16ColumnMajorToRows(fg.transformToPrimary);
  const origin = applyMat4(rows, view.planeOrigin);
  const rotate = (v: Vec3): [number, number, number] => {
    const moved = applyMat4(rows, [view.planeOrigin[0] + v[0], view.planeOrigin[1] + v[1], view.planeOrigin[2] + v[2]]);
    return normalize3(sub3(moved, origin));
  };
  return { ...view, planeOrigin: origin, viewPlaneNormal: rotate(view.viewPlaneNormal), viewUp: rotate(view.viewUp) };
}

/** 量測的點搬到 primary 世界座標（畫面與 hit-test 用）。 */
export function pointsToPrimary(m: Pick<Measurement, 'points'>, fg: FrameGroup | null | undefined): [number, number, number][] {
  const n = Math.floor(m.points.length / 3);
  const out: [number, number, number][] = [];
  for (let i = 0; i < n; i += 1) {
    const p = pointAt(m.points, i);
    out.push(fg ? toPrimaryWorld(fg, p) : p);
  }
  return out;
}

/**
 * 封閉多邊形與平面的交線（相交（斜面）只顯示交線）。
 * 回傳線段（每段兩點）；凸多邊形一段、凹多邊形可能多段。點都在 `plane` 的座標系裡。
 */
export function polygonPlaneIntersection(polygon: readonly Vec3[], plane: ViewReference): [Vec3, Vec3][] {
  const hits: Vec3[] = [];
  const n = polygon.length;
  if (n < 3) return [];
  for (let i = 0; i < n; i += 1) {
    const a = polygon[i]!;
    const b = polygon[(i + 1) % n]!;
    const da = signedDistance(plane, a);
    const db = signedDistance(plane, b);
    if ((da > 0 && db > 0) || (da < 0 && db < 0)) continue;
    if (da === 0 && db === 0) continue;
    const t = da / (da - db);
    hits.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]);
  }
  // 沿平面上的一個方向排序後兩兩配對
  const right = normalize3(cross3(plane.viewUp, plane.viewPlaneNormal));
  hits.sort((p, q) => dot3(right, p) - dot3(right, q));
  const out: [Vec3, Vec3][] = [];
  for (let i = 0; i + 1 < hits.length; i += 2) out.push([hits[i]!, hits[i + 1]!]);
  return out;
}

/** 軸對齊方框與平面的交集多邊形（畫 roi3d 在目前切面上的截面）；不相交回空。 */
export function boxPlaneSection(corners: readonly Vec3[], plane: ViewReference): Vec3[] {
  const EDGES: [number, number][] = [
    [0, 1], [2, 3], [4, 5], [6, 7], // z
    [0, 2], [1, 3], [4, 6], [5, 7], // y
    [0, 4], [1, 5], [2, 6], [3, 7], // x
  ];
  const hits: Vec3[] = [];
  for (const [i, j] of EDGES) {
    const a = corners[i]!;
    const b = corners[j]!;
    const da = signedDistance(plane, a);
    const db = signedDistance(plane, b);
    if ((da > 0 && db > 0) || (da < 0 && db < 0) || (da === 0 && db === 0)) continue;
    const t = da / (da - db);
    hits.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]);
  }
  if (hits.length < 3) return [];
  // 以質心為中心依角度排序成凸多邊形
  const c: Vec3 = hits.reduce<[number, number, number]>((acc, p) => [acc[0] + p[0], acc[1] + p[1], acc[2] + p[2]], [0, 0, 0]).map((v) => v / hits.length) as unknown as Vec3;
  const right = normalize3(cross3(plane.viewUp, plane.viewPlaneNormal));
  const angle = (p: Vec3) => Math.atan2(dot3(plane.viewUp, sub3(p, c)), dot3(right, sub3(p, c)));
  const uniq = hits.filter((p, i) => hits.findIndex((q) => Math.hypot(q[0] - p[0], q[1] - p[1], q[2] - p[2]) < 1e-6) === i);
  return uniq.sort((p, q) => angle(p) - angle(q));
}

/** 點在（平面上的）多邊形內：以平面基底的 2D 座標做 even-odd。 */
export function pointInPlanePolygon(point: Vec3, polygon: readonly Vec3[], plane: ViewReference): boolean {
  const right = normalize3(cross3(plane.viewUp, plane.viewPlaneNormal));
  const u = (p: Vec3) => dot3(right, p);
  const v = (p: Vec3) => dot3(plane.viewUp, p);
  const px = u(point);
  const py = v(point);
  let inside = false;
  const n = polygon.length;
  for (let i = 0, j = n - 1; i < n; j = i, i += 1) {
    const xi = u(polygon[i]!);
    const yi = v(polygon[i]!);
    const xj = u(polygon[j]!);
    const yj = v(polygon[j]!);
    if (yi > py !== yj > py && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** 平面法線（自己 FoR）與哪個軸平行（|n[a]| > 0.9）；不是正交切面回 null。 */
export function orthogonalAxisOf(normal: Vec3): 0 | 1 | 2 | null {
  for (const a of [0, 1, 2] as const) if (Math.abs(normal[a]) > 0.9) return a;
  return null;
}

/**
 * 拖方框截面的一個角：角原本的位置 `cornerFrom`、拖到 `cornerTo`（都是自己 FoR 的世界座標），
 * 平面內的兩軸各自改離該角較近的那一端（min 或 max）；沿法線的軸不動。回新的 6 個數（min, max）。
 */
export function dragBoxCorner(points: Float64Array | readonly number[], cornerFrom: Vec3, cornerTo: Vec3, normalAxis: 0 | 1 | 2): number[] {
  const { min, max } = boxBounds(points);
  for (const a of [0, 1, 2] as const) {
    if (a === normalAxis) continue;
    const nearMax = Math.abs(cornerFrom[a] - max[a]) < Math.abs(cornerFrom[a] - min[a]);
    if (nearMax) max[a] = cornerTo[a];
    else min[a] = cornerTo[a];
    if (min[a] > max[a]) [min[a], max[a]] = [max[a], min[a]];
    if (max[a] - min[a] < 0.5) max[a] = min[a] + 0.5;
  }
  return [...min, ...max];
}

/**
 * 拖方框截面一條邊的中點 —— 只改平面內「沿這條邊不變」的那一軸（離起點較近的那一端）。
 * `edge` 是截面上這條邊的兩端（世界座標）；不是軸對齊的邊（斜面）回原值。
 */
export function dragBoxEdge(points: Float64Array | readonly number[], edge: readonly [Vec3, Vec3], cornerTo: Vec3, normalAxis: 0 | 1 | 2): number[] {
  const { min, max } = boxBounds(points);
  const [a, b] = edge;
  const axis = ([0, 1, 2] as const).find((k) => k !== normalAxis && Math.abs(a[k] - b[k]) < 1e-6);
  if (axis === undefined) return [...min, ...max];
  const nearMax = Math.abs(a[axis] - max[axis]) < Math.abs(a[axis] - min[axis]);
  if (nearMax) max[axis] = cornerTo[axis];
  else min[axis] = cornerTo[axis];
  if (min[axis] > max[axis]) [min[axis], max[axis]] = [max[axis], min[axis]];
  if (max[axis] - min[axis] < 0.5) max[axis] = min[axis] + 0.5;
  return [...min, ...max];
}

/** 整體平移（面積：位移先投到自己的平面上）。 */
export function translatePoints(m: Pick<Measurement, 'kind' | 'points' | 'viewReference'>, delta: Vec3): number[] {
  let d: [number, number, number] = [delta[0], delta[1], delta[2]];
  if (isPlanarKind(m.kind) && m.viewReference !== null) {
    const n = m.viewReference.viewPlaneNormal;
    const k = dot3(d, n);
    d = [d[0] - n[0] * k, d[1] - n[1] * k, d[2] - n[2] * k];
  }
  const out = Array.from(m.points);
  for (let i = 0; i < out.length; i += 3) {
    out[i] = out[i]! + d[0];
    out[i + 1] = out[i + 1]! + d[1];
    out[i + 2] = out[i + 2]! + d[2];
  }
  return out;
}
