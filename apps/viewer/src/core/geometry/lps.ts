/**
 * LPS 慣例與 index↔world 轉換。
 *
 * 🔴 **座標慣例一律 LPS。系統內任何地方不得出現 RAS。**
 *
 * ## 為什麼這裡不用 gl-matrix
 *
 * `gl-matrix` 的 `mat4` 預設是 `Float32Array`。以 mm 為單位的 LPS 座標在
 * float32 下只有約 7 位有效數字：座標 −255.5 的最小可分辨增量約 1.5e-5 mm，
 * 單看沒問題，但矩陣連乘（世界→FrameGroup→網格→體素）之後誤差會累積到
 * **次體素等級**，而症狀正是「看起來像分割不準」那一類。
 *
 * 因此契約層的所有幾何都用 `number[]`（IEEE-754 double），與 Python 的 float64
 * 和 Rust 的 `f64` 完全一致。gl-matrix 留給相機／投影這種**只影響像素**的計算。
 */

import { t } from '../i18n';

export type Vec3 = readonly [number, number, number];
export type Int3 = readonly [number, number, number];
export type Mat9 = readonly number[]; // 9，row-major
export type Mat16 = readonly number[]; // 16，column-major（與 wire 格式一致）

export const IDENTITY_DIRECTION: Mat9 = [1, 0, 0, 0, 1, 0, 0, 0, 1];

/** direction 正交性容差 —— 與 Python 端同值。 */
export const DIRECTION_ORTHONORMAL_TOL = 1e-6;

/** 3×3 row-major 相乘。 */
export function mul3(a: Mat9, b: Mat9): number[] {
  const out = new Array<number>(9).fill(0);
  for (let r = 0; r < 3; r += 1) {
    for (let c = 0; c < 3; c += 1) {
      let sum = 0;
      for (let k = 0; k < 3; k += 1) sum += (a[r * 3 + k] ?? 0) * (b[k * 3 + c] ?? 0);
      out[r * 3 + c] = sum;
    }
  }
  return out;
}

export function transpose3(m: Mat9): number[] {
  return [m[0]!, m[3]!, m[6]!, m[1]!, m[4]!, m[7]!, m[2]!, m[5]!, m[8]!];
}

export function det3(m: Mat9): number {
  const [a, b, c, d, e, f, g, h, i] = m as number[];
  return a! * (e! * i! - f! * h!) - b! * (d! * i! - f! * g!) + c! * (d! * h! - e! * g!);
}

/** 3×3 解析求逆。奇異矩陣回傳 null（呼叫端必須處理，不得靜默用單位矩陣）。 */
export function inverse3(m: Mat9): number[] | null {
  const [a, b, c, d, e, f, g, h, i] = m as number[];
  const det = det3(m);
  if (Math.abs(det) < 1e-300) return null;
  const s = 1 / det;
  return [
    (e! * i! - f! * h!) * s,
    (c! * h! - b! * i!) * s,
    (b! * f! - c! * e!) * s,
    (f! * g! - d! * i!) * s,
    (a! * i! - c! * g!) * s,
    (c! * d! - a! * f!) * s,
    (d! * h! - e! * g!) * s,
    (b! * g! - a! * h!) * s,
    (a! * e! - b! * d!) * s,
  ];
}

export function apply3(m: Mat9, v: Vec3): [number, number, number] {
  return [
    m[0]! * v[0] + m[1]! * v[1] + m[2]! * v[2],
    m[3]! * v[0] + m[4]! * v[1] + m[5]! * v[2],
    m[6]! * v[0] + m[7]! * v[1] + m[8]! * v[2],
  ];
}

export function add3(a: Vec3, b: Vec3): [number, number, number] {
  return [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
}

export function sub3(a: Vec3, b: Vec3): [number, number, number] {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

export function scale3(a: Vec3, s: number): [number, number, number] {
  return [a[0] * s, a[1] * s, a[2] * s];
}

export function dot3(a: Vec3, b: Vec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

export function cross3(a: Vec3, b: Vec3): [number, number, number] {
  return [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
}

export function norm3(a: Vec3): number {
  return Math.sqrt(dot3(a, a));
}

export function normalize3(a: Vec3): [number, number, number] {
  const n = norm3(a);
  if (n === 0) throw new Error(t('無法正規化零向量'));
  return scale3(a, 1 / n);
}

/** direction 是否正交且單位長。**spacing 混進 direction 是真實發生過的錯誤。** */
export function isOrthonormal(direction: Mat9, tol = DIRECTION_ORTHONORMAL_TOL): boolean {
  const dtd = mul3(transpose3(direction), direction);
  for (let i = 0; i < 9; i += 1) {
    const expected = i % 4 === 0 ? 1 : 0;
    if (Math.abs((dtd[i] ?? 0) - expected) > tol) return false;
  }
  return true;
}

/** column-major 16 → row-major 4×4 巡覽（`FrameGroup.transformToPrimary`）。 */
export function mat16ColumnMajorToRows(m: Mat16): number[][] {
  return [
    [m[0]!, m[4]!, m[8]!, m[12]!],
    [m[1]!, m[5]!, m[9]!, m[13]!],
    [m[2]!, m[6]!, m[10]!, m[14]!],
    [m[3]!, m[7]!, m[11]!, m[15]!],
  ];
}

export function rowsToMat16ColumnMajor(rows: number[][]): number[] {
  const out: number[] = [];
  for (let c = 0; c < 4; c += 1) for (let r = 0; r < 4; r += 1) out.push(rows[r]![c]!);
  return out;
}

/** 4×4 齊次矩陣（row-major 陣列）套用到一個點。 */
export function applyMat4(rows: number[][], v: Vec3): [number, number, number] {
  return [
    rows[0]![0]! * v[0] + rows[0]![1]! * v[1] + rows[0]![2]! * v[2] + rows[0]![3]!,
    rows[1]![0]! * v[0] + rows[1]![1]! * v[1] + rows[1]![2]! * v[2] + rows[1]![3]!,
    rows[2]![0]! * v[0] + rows[2]![1]! * v[1] + rows[2]![2]! * v[2] + rows[2]![3]!,
  ];
}

/** 4×4 反矩陣（一般情況，Gauss-Jordan）。 */
export function inverseMat4(rows: number[][]): number[][] {
  const a = rows.map((r, i) => [...r, ...[0, 0, 0, 0].map((_, j) => (i === j ? 1 : 0))]);
  for (let col = 0; col < 4; col += 1) {
    let pivot = col;
    for (let r = col + 1; r < 4; r += 1) {
      if (Math.abs(a[r]![col]!) > Math.abs(a[pivot]![col]!)) pivot = r;
    }
    if (Math.abs(a[pivot]![col]!) < 1e-300) throw new Error(t('4×4 矩陣不可逆'));
    [a[col], a[pivot]] = [a[pivot]!, a[col]!];
    const d = a[col]![col]!;
    for (let c = 0; c < 8; c += 1) a[col]![c] = a[col]![c]! / d;
    for (let r = 0; r < 4; r += 1) {
      if (r === col) continue;
      const factor = a[r]![col]!;
      if (factor === 0) continue;
      for (let c = 0; c < 8; c += 1) a[r]![c] = a[r]![c]! - factor * a[col]![c]!;
    }
  }
  return a.map((r) => r.slice(4));
}
