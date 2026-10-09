/**
 * `Grid` —— 幾何的唯一表示。
 *
 * **前端型別一律 camelCase，wire 一律 snake_case**，轉換只發生在
 * `core/transport/wire.ts` 這一層（命名統一）。
 */

import { ContractViolation, require_ } from './errors';
import {
  apply3,
  det3,
  DIRECTION_ORTHONORMAL_TOL,
  inverse3,
  isOrthonormal,
  mul3,
  transpose3,
  type Int3,
  type Mat9,
  type Vec3,
} from './lps';
import { t } from '../i18n';

export interface Grid {
  readonly size: Int3;
  readonly spacing: Vec3;
  /** LPS mm，**體素 0 的中心**（不是體積的角）。 */
  readonly origin: Vec3;
  /** 9 個 float，row-major。**第 c 欄是第 c 個索引軸的方向向量**（同 ITK）。 */
  readonly direction: Mat9;
  readonly frameOfReferenceUid: string;
}

/** 建立並驗證 `Grid`。**任何從網路來的 grid 都必須經過這裡。** */
export function createGrid(g: Grid): Grid {
  require_(g.size.length === 3, 'G1', t('size 必須是三個元素'), { size: g.size });
  require_(
    g.size.every((n) => Number.isInteger(n) && n > 0),
    'G1',
    t('size 必須是正整數'),
    { size: g.size },
  );
  require_(g.spacing.length === 3 && g.spacing.every((s) => s > 0), 'G2', t('spacing 每軸必須為正'), {
    spacing: g.spacing,
  });
  require_(g.origin.length === 3 && g.origin.every(Number.isFinite), 'G3', t('origin 必須是三個有限值'), {
    origin: g.origin,
  });
  require_(
    Array.isArray(g.direction) && g.direction.length === 9,
    'G4',
    t('direction 必須是 9 個 float（row-major）——不得省略，不得預設為單位矩陣'),
    { direction: g.direction },
  );
  require_(
    isOrthonormal(g.direction),
    'G5',
    t('direction 必須正交且單位長（spacing 不得混進 direction）'),
    { direction: g.direction },
  );
  // 🔴 **不得要求右手系。** 正交性（G5）已保證 |det| = 1；det 的正負號是取像
  // 幾何的一部分，不是錯誤——切片沿 −z 排列在 HFS 掃描上是常態（Philips CT
  // 就是這樣存）。舊版這裡寫 `det > 0`，於是真實臨床 CT 一載入就被拒絕。
  require_(
    Math.abs(Math.abs(det3(g.direction)) - 1) <= DIRECTION_ORTHONORMAL_TOL,
    'G6',
    t('direction 的 |det| 必須為 1（正交矩陣的必然結果）'),
    { det: det3(g.direction) },
  );
  require_(
    typeof g.frameOfReferenceUid === 'string' && g.frameOfReferenceUid.length > 0,
    'G7',
    t('frameOfReferenceUid 必填（沒有物件可以繞過空間）'),
  );
  return g;
}

/** index → world 的 3×3（direction ⊙ spacing，欄縮放）。 */
export function indexToWorldMatrix(g: Grid): number[] {
  const d = g.direction;
  const s = g.spacing;
  return [
    d[0]! * s[0], d[1]! * s[1], d[2]! * s[2],
    d[3]! * s[0], d[4]! * s[1], d[5]! * s[2],
    d[6]! * s[0], d[7]! * s[1], d[8]! * s[2],
  ];
}

export function indexToWorld(g: Grid, ijk: Vec3): [number, number, number] {
  const m = indexToWorldMatrix(g);
  const r = apply3(m, ijk);
  return [r[0] + g.origin[0], r[1] + g.origin[1], r[2] + g.origin[2]];
}

/**
 * world → 連續索引。**不做四捨五入、不做邊界裁切。**
 *
 * 這是座標轉換鏈的第三段（world → grid ijk）。
 */
export function worldToIndex(g: Grid, world: Vec3): [number, number, number] {
  const inv = inverse3(indexToWorldMatrix(g));
  if (inv === null) {
    throw new ContractViolation('G8', t('index→world 矩陣不可逆（spacing 為 0？）'), {
      spacing: g.spacing,
    });
  }
  return apply3(inv, [
    world[0] - g.origin[0],
    world[1] - g.origin[1],
    world[2] - g.origin[2],
  ]);
}

/** world → 最近的整數體素索引（四捨五入，不裁切）。 */
export function worldToNearestVoxel(g: Grid, world: Vec3): [number, number, number] {
  const c = worldToIndex(g, world);
  return [Math.round(c[0]), Math.round(c[1]), Math.round(c[2])];
}

export function containsIndex(g: Grid, ijk: Vec3): boolean {
  return ijk.every((v, i) => v >= 0 && v <= g.size[i]! - 1);
}

/**
 * index→world 的手性：`+1` 右手、`-1` 左手。
 *
 * 左手系是 DICOM 常態，**不是錯誤**。需要據此補償的只有三角形繞向
 * （mesh winding）；取樣、筆刷、量測都不受影響。
 */
export function handedness(g: Grid): 1 | -1 {
  return det3(g.direction) > 0 ? 1 : -1;
}

export function voxelCount(g: Grid): number {
  return g.size[0] * g.size[1] * g.size[2];
}

export function voxelVolumeMm3(g: Grid): number {
  return g.spacing[0] * g.spacing[1] * g.spacing[2];
}

/** 8 個角（以體素中心為準）的 LPS 座標。與 `expected.json` 的自檢欄位對應。 */
export function cornersWorld(g: Grid): [number, number, number][] {
  const [nx, ny, nz] = [g.size[0] - 1, g.size[1] - 1, g.size[2] - 1];
  const idx: Vec3[] = [
    [0, 0, 0], [nx, 0, 0], [0, ny, 0], [nx, ny, 0],
    [0, 0, nz], [nx, 0, nz], [0, ny, nz], [nx, ny, nz],
  ];
  return idx.map((i) => indexToWorld(g, i));
}

export function sameFrame(a: Grid, b: Grid): boolean {
  return a.frameOfReferenceUid === b.frameOfReferenceUid;
}

/** `worldToIndex(indexToWorld(x)) === x` 的自檢，回傳最大誤差。 */
export function roundTripError(g: Grid, samples = 32, seed = 1): number {
  let state = seed >>> 0;
  const rand = (): number => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x100000000;
  };
  let worst = 0;
  for (let n = 0; n < samples; n += 1) {
    const ijk: Vec3 = [
      rand() * (g.size[0] - 1),
      rand() * (g.size[1] - 1),
      rand() * (g.size[2] - 1),
    ];
    const back = worldToIndex(g, indexToWorld(g, ijk));
    for (let k = 0; k < 3; k += 1) worst = Math.max(worst, Math.abs(back[k]! - ijk[k]!));
  }
  return worst;
}

/** 只在除錯與測試用到的矩陣工具再匯出一次，避免呼叫端從 lps 直接抓。 */
export { mul3, transpose3 };
