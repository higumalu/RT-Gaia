/**
 * 剛性變換的組合與分解（對位微調）。
 *
 * 全部以 **column-major 16**（wire 格式）進出；內部以 row-major 4×4 計算。
 * 這裡的動作都是在 **primary 世界座標** 裡對一個 `transformToPrimary` 做前乘：
 * `M' = T · M` —— 影像、劑量、結構、讀數一起動，因為它們都經 `frameGroupFor()`。
 *
 * 零 React、零 DOM；`registration-module.test.ts` 直接測。
 */

import { applyMat4, inverseMat4, mat16ColumnMajorToRows, rowsToMat16ColumnMajor, type Mat16, type Vec3 } from './lps';

export type RigidAxis = 'x' | 'y' | 'z';

export const IDENTITY_MAT16: Mat16 = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

function mulRows(a: number[][], b: number[][]): number[][] {
  const out: number[][] = [];
  for (let r = 0; r < 4; r += 1) {
    const row: number[] = [];
    for (let c = 0; c < 4; c += 1) {
      let s = 0;
      for (let k = 0; k < 4; k += 1) s += a[r]![k]! * b[k]![c]!;
      row.push(s);
    }
    out.push(row);
  }
  return out;
}

/** `a · b`（column-major 進出）。 */
export function mat16Multiply(a: Mat16, b: Mat16): number[] {
  return rowsToMat16ColumnMajor(mulRows(mat16ColumnMajorToRows(a), mat16ColumnMajorToRows(b)));
}

export function mat16Inverse(m: Mat16): number[] {
  return rowsToMat16ColumnMajor(inverseMat4(mat16ColumnMajorToRows(m)));
}

export function translationMat16(d: Vec3): number[] {
  return [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, d[0], d[1], d[2], 1];
}

/** 繞 LPS 軸旋轉（右手定則），與後端 `rigid_matrix` 的 Rx／Ry／Rz 同一個定義。 */
export function rotationMat16(axis: RigidAxis, angleDeg: number): number[] {
  const t = (angleDeg * Math.PI) / 180;
  const c = Math.cos(t);
  const s = Math.sin(t);
  const rows =
    axis === 'x'
      ? [
          [1, 0, 0, 0],
          [0, c, -s, 0],
          [0, s, c, 0],
          [0, 0, 0, 1],
        ]
      : axis === 'y'
        ? [
            [c, 0, s, 0],
            [0, 1, 0, 0],
            [-s, 0, c, 0],
            [0, 0, 0, 1],
          ]
        : [
            [c, -s, 0, 0],
            [s, c, 0, 0],
            [0, 0, 1, 0],
            [0, 0, 0, 1],
          ];
  return rowsToMat16ColumnMajor(rows);
}

/** 在 primary 世界座標裡把一個 `transformToPrimary` 平移 `d` mm。 */
export function translateTransform(m: Mat16, d: Vec3): number[] {
  return mat16Multiply(translationMat16(d), m);
}

/**
 * 在 primary 世界座標裡繞 `pivot`（primary 座標，mm）的 `axis` 轉 `angleDeg`。
 * 樞紐通常是該序列的體積中心 —— 轉的時候影像不會「飛走」。
 */
export function rotateTransformAboutPivot(m: Mat16, axis: RigidAxis, angleDeg: number, pivot: Vec3): number[] {
  const toOrigin = translationMat16([-pivot[0], -pivot[1], -pivot[2]]);
  const back = translationMat16(pivot);
  const r = mat16Multiply(back, mat16Multiply(rotationMat16(axis, angleDeg), toOrigin));
  return mat16Multiply(r, m);
}

export function applyMat16(m: Mat16, p: Vec3): [number, number, number] {
  return applyMat4(mat16ColumnMajorToRows(m), p);
}

export interface RigidDelta {
  /** `pivot` 這一點在兩個變換下的位移（primary mm）。 */
  readonly translationMm: [number, number, number];
  /** 相對旋轉的 Euler 角（Rz·Ry·Rx 分解，度）。 */
  readonly rotationDeg: [number, number, number];
  /** 總旋轉夾角（度）。 */
  readonly totalRotationDeg: number;
}

/**
 * `current` 相對 `reference`（例如 REG 原始矩陣）差多少：`D = current · reference⁻¹`。
 * 旋轉以 Rz·Ry·Rx 分解（與 `rigid_matrix` 的順序一致）；平移報的是 `pivot` 的位移，
 * 不是 D 的平移欄 —— 後者在旋轉非零時是「原點的位移」，對使用者沒有意義。
 */
export function rigidDelta(current: Mat16, reference: Mat16, pivot: Vec3): RigidDelta {
  const d = mat16ColumnMajorToRows(mat16Multiply(current, mat16Inverse(reference)));
  const r00 = d[0]![0]!;
  const r10 = d[1]![0]!;
  const r20 = d[2]![0]!;
  const r21 = d[2]![1]!;
  const r22 = d[2]![2]!;
  const ry = Math.asin(Math.max(-1, Math.min(1, -r20)));
  const cy = Math.cos(ry);
  let rx: number;
  let rz: number;
  if (Math.abs(cy) > 1e-9) {
    rx = Math.atan2(r21, r22);
    rz = Math.atan2(r10, r00);
  } else {
    // gimbal：把全部繞 z 的量給 rz
    rx = 0;
    rz = Math.atan2(-d[0]![1]!, d[1]![1]!);
  }
  const trace = r00 + d[1]![1]! + r22;
  const total = Math.acos(Math.max(-1, Math.min(1, (trace - 1) / 2)));
  const a = applyMat16(current, pivot);
  const b = applyMat16(reference, pivot);
  const deg = (v: number) => {
    const out = (v * 180) / Math.PI;
    return Math.abs(out) < 1e-9 ? 0 : out;
  };
  return {
    translationMm: [a[0] - b[0], a[1] - b[1], a[2] - b[2]],
    rotationDeg: [deg(rx), deg(ry), deg(rz)],
    totalRotationDeg: deg(total),
  };
}

export function isSameMat16(a: Mat16, b: Mat16, tol = 1e-9): boolean {
  for (let i = 0; i < 16; i += 1) if (Math.abs(a[i]! - b[i]!) > tol) return false;
  return true;
}
