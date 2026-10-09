/**
 * 3D 相機的純邏輯：軌道旋轉（左鍵）、前進後退（滾輪）、平移（右鍵／中鍵／Shift＋左鍵）。
 * 全部在 primary 世界座標（LPS mm）。輸出後端出圖用的 camera（focal＝plane_origin、normal＝position−focal、up、distance、fov）。
 */

import type { Vec3 } from '../../../core';

export interface Camera3d {
  readonly position: Vec3;
  readonly focalPoint: Vec3;
  readonly viewUp: Vec3;
  readonly viewAngleDeg: number;
}

export const ORBIT_DEG_PER_PX = 0.4;
export const DOLLY_STEP = 1.15;
export const MIN_DISTANCE_MM = 10;
export const MAX_DISTANCE_MM = 20000;
export const DEFAULT_FOV_DEG = 30;

const sub = (a: Vec3, b: Vec3): [number, number, number] => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a: Vec3, b: Vec3): [number, number, number] => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const scale = (a: Vec3, s: number): [number, number, number] => [a[0] * s, a[1] * s, a[2] * s];
const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: Vec3, b: Vec3): [number, number, number] => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const len = (a: Vec3): number => Math.hypot(a[0], a[1], a[2]);
const unit = (a: Vec3): [number, number, number] => {
  const l = len(a) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
};

/** Rodrigues：向量 v 繞單位軸 k 轉 θ。 */
export function rotateAroundAxis(v: Vec3, k: Vec3, thetaRad: number): [number, number, number] {
  const c = Math.cos(thetaRad);
  const s = Math.sin(thetaRad);
  const kxv = cross(k, v);
  const kdv = dot(k, v);
  return [
    v[0] * c + kxv[0] * s + k[0] * kdv * (1 - c),
    v[1] * c + kxv[1] * s + k[1] * kdv * (1 - c),
    v[2] * c + kxv[2] * s + k[2] * kdv * (1 - c),
  ];
}

/** 預設：從病人前方看（相機在 −y），焦點＝包圍盒中心，距離＝對角線 × 1.2，畫面上＝S。 */
export function defaultCamera(bounds: { min: Vec3; max: Vec3 }): Camera3d {
  const focal: [number, number, number] = [(bounds.min[0] + bounds.max[0]) / 2, (bounds.min[1] + bounds.max[1]) / 2, (bounds.min[2] + bounds.max[2]) / 2];
  const diag = len(sub(bounds.max, bounds.min)) || 500;
  return { position: [focal[0], focal[1] - diag * 1.2, focal[2]], focalPoint: focal, viewUp: [0, 0, 1], viewAngleDeg: DEFAULT_FOV_DEG };
}

export function distanceOf(cam: Camera3d): number {
  return len(sub(cam.position, cam.focalPoint));
}

/** 視線方向（從相機看向焦點）與畫面右。 */
export function axesOf(cam: Camera3d): { forward: [number, number, number]; right: [number, number, number]; up: [number, number, number] } {
  const forward = unit(sub(cam.focalPoint, cam.position));
  const right = unit(cross(forward, cam.viewUp));
  const up = unit(cross(right, forward));
  return { forward, right, up };
}

/** 左鍵拖曳：繞焦點轉。水平拖繞 viewUp，垂直拖繞 right；viewUp 跟著轉（trackball 風格）。 */
export function orbit(cam: Camera3d, dxPx: number, dyPx: number, degPerPx = ORBIT_DEG_PER_PX): Camera3d {
  const { up } = axesOf(cam);
  const rel = sub(cam.position, cam.focalPoint);
  const yaw = (-dxPx * degPerPx * Math.PI) / 180;
  const pitch = (-dyPx * degPerPx * Math.PI) / 180;
  let r = rotateAroundAxis(rel, up, yaw);
  let u = up;
  const right2 = unit(cross(unit(scale(r, -1)), u));
  r = rotateAroundAxis(r, right2, pitch);
  u = unit(rotateAroundAxis(u, right2, pitch));
  return { ...cam, position: add(cam.focalPoint, r), viewUp: u };
}

/** 滾輪：沿視線前進／後退（往上放大 ＝ 靠近）。距離夾在 [10, 20000] mm。 */
export function dolly(cam: Camera3d, factor: number): Camera3d {
  const rel = sub(cam.position, cam.focalPoint);
  const d = len(rel) || 1;
  const nd = Math.max(MIN_DISTANCE_MM, Math.min(MAX_DISTANCE_MM, d * factor));
  return { ...cam, position: add(cam.focalPoint, scale(unit(rel), nd)) };
}

export function dollyByWheel(cam: Camera3d, deltaY: number): Camera3d {
  return dolly(cam, deltaY < 0 ? 1 / DOLLY_STEP : DOLLY_STEP);
}

/** 焦點距離處 1 px 對應幾 mm（透視）。 */
export function mmPerPx(cam: Camera3d, viewportHeightPx: number): number {
  const h = 2 * distanceOf(cam) * Math.tan((cam.viewAngleDeg * Math.PI) / 360);
  return h / Math.max(1, viewportHeightPx);
}

/** 平移：焦點與相機一起在視平面上移；拖曳往右，畫面內容跟著往右（相機往左）。 */
export function pan(cam: Camera3d, dxPx: number, dyPx: number, viewportHeightPx: number): Camera3d {
  const { right, up } = axesOf(cam);
  const k = mmPerPx(cam, viewportHeightPx);
  const delta = add(scale(right, -dxPx * k), scale(up, dyPx * k));
  return { ...cam, position: add(cam.position, delta), focalPoint: add(cam.focalPoint, delta) };
}

/** 保留方向、重設距離到「剛好塞滿」。 */
export function fitDistance(cam: Camera3d, bounds: { min: Vec3; max: Vec3 }): Camera3d {
  const diag = len(sub(bounds.max, bounds.min)) || 500;
  const focal: [number, number, number] = [(bounds.min[0] + bounds.max[0]) / 2, (bounds.min[1] + bounds.max[1]) / 2, (bounds.min[2] + bounds.max[2]) / 2];
  const dir = unit(sub(cam.position, cam.focalPoint));
  return { ...cam, focalPoint: focal, position: add(focal, scale(dir, diag * 1.2)) };
}

/** 後端出圖用的 camera（snake_case）。 */
export function cameraToWire(cam: Camera3d, frameOfReferenceUid: string, displayGridId: string): Record<string, unknown> {
  const rel = sub(cam.position, cam.focalPoint);
  const normal = unit(rel);
  const { up } = axesOf(cam);
  return {
    frame_of_reference_uid: frameOfReferenceUid,
    display_grid_id: displayGridId,
    plane_origin: [...cam.focalPoint],
    view_plane_normal: normal,
    view_up: up,
    slab_thickness_mm: 0,
    temporal_group_id: null,
    frame_index: null,
    distance_mm: len(rel),
    fov_deg: cam.viewAngleDeg,
  };
}

/** 顯示用：相對「正面」的方位／仰角。 */
export function anglesOf(cam: Camera3d): { azimuthDeg: number; elevationDeg: number } {
  const n = unit(sub(cam.position, cam.focalPoint));
  const el = (Math.asin(Math.max(-1, Math.min(1, n[2]))) * 180) / Math.PI;
  let az = (Math.atan2(n[0], -n[1]) * 180) / Math.PI;
  if (az < 0) az += 360;
  return { azimuthDeg: Number(az.toFixed(1)), elevationDeg: Number(el.toFixed(1)) };
}

export function isValidCamera(c: unknown): c is Camera3d {
  if (typeof c !== 'object' || c === null) return false;
  const o = c as Record<string, unknown>;
  const v3 = (v: unknown) => Array.isArray(v) && v.length === 3 && v.every((x) => Number.isFinite(x));
  return v3(o['position']) && v3(o['focalPoint']) && v3(o['viewUp']) && typeof o['viewAngleDeg'] === 'number';
}

/** 焦點搬到十字線位置、相機平移同樣的向量（方向、距離、視角不變）。 */
export function followCrosshair(cam: Camera3d, target: readonly [number, number, number]): Camera3d {
  const d: Vec3 = [target[0] - cam.focalPoint[0], target[1] - cam.focalPoint[1], target[2] - cam.focalPoint[2]];
  if (Math.hypot(d[0], d[1], d[2]) < 1e-6) return cam;
  return {
    ...cam,
    focalPoint: [target[0], target[1], target[2]],
    position: [cam.position[0] + d[0], cam.position[1] + d[1], cam.position[2] + d[2]],
  };
}
