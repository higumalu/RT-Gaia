/**
 * 筆刷：螢幕座標 → world → **mask grid** voxel。
 *
 * ## 🔴 型別系統擋住最貴的那個錯誤
 *
 * > **編輯一律換算到 `MaskGrid`，絕不可換算到 `DisplayGrid`。**
 * > 這兩個網格在 Tier A 未降採樣時**數值恰好相同**，所以寫錯不會有任何錯誤
 * > 訊息、在開發機上也完全正常——**只有在 Tier B 降採樣時才會顯現，而症狀是
 * > 輪廓變成階梯並寫進輸出的 RTSTRUCT**。
 *
 * **強制手段**：本檔所有座標轉換函式的簽章只接受 `MaskGrid`。
 * `DisplayGrid` 沒有 `maskGridId` 欄位，因此傳錯在編譯期就不通過——
 * 靠型別，不靠註解。
 *
 * ## 座標轉換鏈
 *
 * ```
 * canvas px → world LPS mm → 序列自身 world → mask grid ijk → 減 offset → voxel
 *              ^ viewport 逆投影   ^ FrameGroup 逆變換    ^ MaskGrid 逆變換
 * ```
 *
 * 第二段（FrameGroup 逆變換）**只有在編輯非 primary 序列的結構時才會非單位
 * 矩陣**。漏了的症狀是「在融合畫面上對第二組影像的結構下筆，筆刷落在偏移的
 * 位置」。
 */

import {
  fromPrimaryWorld,
  require_,
  worldToIndex,
  type FrameGroup,
  type MaskGrid,
  type Vec3,
} from '../geometry';
import { t } from '../i18n';

export interface BrushSpec {
  /** 半徑，**以 mm 為單位**（不是 voxel）——非等向資料上才會是球而不是橢球。 */
  radiusMm: number;
  /** 3D 球形（跨切面）或 2D 圓形（只作用於當前平面）。 */
  shape: 'sphere' | 'disc';
  /** 橡皮擦 = 寫 0。 */
  erase: boolean;
  /** 閾值筆刷：只作用於 HU 區間內的 voxel。null = 不設限。 */
  huRange: readonly [number, number] | null;
}

/**
 * 閾值筆刷的預設 HU 區間（軟組織）。
 *
 * 🔴 `BrushSpec.huRange` 為 `null` 時閾值筆刷**與普通筆刷完全一樣**，
 * 使用者按下去看不出差別——又是一個「點得下去但沒有作用」。因此 UI 必須給出
 * 一個區間，而不是讓它留 null。
 */
export const DEFAULT_THRESHOLD_HU: readonly [number, number] = [-200, 300];

export const DEFAULT_BRUSH: BrushSpec = {
  radiusMm: 3,
  // 預設只作用當前平面（原本 3D 球）
  shape: 'disc',
  erase: false,
  huRange: null,
};

/** 一個區塊在 MaskGrid 索引空間的位置與大小（不含資料）。 */
export interface PatchBounds {
  readonly offsetIjk: readonly [number, number, number];
  readonly sizeIjk: readonly [number, number, number];
}

/** 一筆筆刷寫入的結果：**子區塊**，不是全網格。 */
export interface VoxelPatch {
  offsetIjk: readonly [number, number, number];
  sizeIjk: readonly [number, number, number];
  /** `(k, j, i)` 排列的 uint8，長度 = size 的乘積。 */
  data: Uint8Array;
  /**
   * 這一筆**實際作用到**哪些格子（1 = 有、0 = 沒有）。
   *
   * 🔴 **沒有這個欄位就一定會擦掉不該擦的東西。** 筆刷是球，但區塊是球的
   * **外接方塊**：方塊裡球外的格子（約佔 1 − π/6 ≈ 48%）在 `data` 裡是 0。
   * 若把整塊寫進 mask：
   *
   * - 筆刷：每一個筆點都會**擦掉自己方塊的八個角**，在結構邊界上畫一筆
   *   反而把周圍咬掉一圈
   * - 橡皮擦：`data` 全是 0，於是擦掉的是**整個方塊**而不是球
   *
   * 實測：橡皮擦一個筆點少 0.40 cc（方塊），球應該是 0.14 cc；筆刷畫過心臟
   * 一筆反而少 6.8 cc。兩者都不會有任何錯誤訊息。
   *
   * 這是**本地欄位**：送到後端的 patch 是從本地 mask 讀出來的完整區塊
   * （見 `unionPatchBounds`），線路上不需要 coverage。
   */
  coverage: Uint8Array;
}

/**
 * world LPS → mask grid 的連續索引。
 *
 * `frameGroup` 為該結構所屬 FrameGroup；primary 傳它自己即可。
 */
export function worldToMaskIndex(
  maskGrid: MaskGrid,
  frameGroup: FrameGroup,
  primaryWorld: Vec3,
): [number, number, number] {
  const selfWorld = fromPrimaryWorld(frameGroup, primaryWorld);
  return worldToIndex(maskGrid.grid, selfWorld);
}

/**
 * 光柵化一筆筆刷為 `VoxelPatch`。
 *
 * **半徑在世界空間是球，因此索引空間的範圍要用 spacing 反推**——直接用
 * `radiusMm / spacing[0]` 當三軸半徑，在 1×1×5 mm 的資料上會畫出扁 5 倍的餅。
 */
export function rasterizeBrush(args: {
  maskGrid: MaskGrid;
  frameGroup: FrameGroup;
  /** 筆刷中心，primary 世界座標。 */
  centerPrimaryWorld: Vec3;
  brush: BrushSpec;
  /** `shape='disc'` 時的平面法線（primary 世界座標）。 */
  planeNormal?: Vec3;
  /** 閾值筆刷用的取樣函式（回傳該 mask grid 索引處的 HU）。 */
  sampleHu?: (ijk: readonly [number, number, number]) => number;
}): VoxelPatch | null {
  const { maskGrid, frameGroup, brush } = args;
  const grid = maskGrid.grid;
  require_(brush.radiusMm > 0, 'B1', t('筆刷半徑必須為正'), { radiusMm: brush.radiusMm });

  const centerIjk = worldToMaskIndex(maskGrid, frameGroup, args.centerPrimaryWorld);
  const radiusVoxels = [0, 1, 2].map((i) => brush.radiusMm / grid.spacing[i]!) as [
    number,
    number,
    number,
  ];

  const lo = [0, 1, 2].map((i) =>
    Math.max(0, Math.floor(centerIjk[i]! - radiusVoxels[i]!)),
  ) as [number, number, number];
  const hi = [0, 1, 2].map((i) =>
    Math.min(grid.size[i]! - 1, Math.ceil(centerIjk[i]! + radiusVoxels[i]!)),
  ) as [number, number, number];
  if (lo.some((v, i) => v > hi[i]!)) return null;

  const size = [0, 1, 2].map((i) => hi[i]! - lo[i]! + 1) as [number, number, number];
  const data = new Uint8Array(size[0] * size[1] * size[2]);
  const coverage = new Uint8Array(data.length);
  const value = brush.erase ? 0 : 1;
  const r2 = brush.radiusMm * brush.radiusMm;

  // disc 用：平面法線**投影到網格自己的軸上**，以及沿該法線的取樣間距
  const discNormal =
    brush.shape === 'disc' && args.planeNormal
      ? planeNormalOnGridAxes(maskGrid, frameGroup, args.planeNormal)
      : null;
  const discHalfThickness = discNormal ? normalPitch(grid.spacing, discNormal) / 2 : 0;

  for (let k = lo[2]; k <= hi[2]; k += 1) {
    for (let j = lo[1]; j <= hi[1]; j += 1) {
      for (let i = lo[0]; i <= hi[0]; i += 1) {
        // 距離在**世界空間**量（乘 spacing），因此非等向資料上仍是球
        const dx = (i - centerIjk[0]) * grid.spacing[0];
        const dy = (j - centerIjk[1]) * grid.spacing[1];
        const dz = (k - centerIjk[2]) * grid.spacing[2];
        if (dx * dx + dy * dy + dz * dz > r2) continue;
        if (discNormal !== null) {
          // disc：只作用於當前平面所在的那一層
          const along = dx * discNormal[0] + dy * discNormal[1] + dz * discNormal[2];
          if (Math.abs(along) > discHalfThickness + 1e-9) continue;
        }
        if (brush.huRange && args.sampleHu) {
          const hu = args.sampleHu([i, j, k]);
          if (hu < brush.huRange[0] || hu > brush.huRange[1]) continue;
        }
        const idx =
          (k - lo[2]) * size[1] * size[0] + (j - lo[1]) * size[0] + (i - lo[0]);
        data[idx] = value;
        coverage[idx] = 1;
      }
    }
  }
  // 完全沒作用到任何格子（畫在網格外、或閾值全不符）→ 不是一筆編輯
  if (!coverage.some((v) => v !== 0)) return null;
  return { offsetIjk: lo, sizeIjk: size, data, coverage };
}

/**
 * 平面法線 → **投影到 mask grid 三個軸上的分量**。
 *
 * 🔴 這一步不能省。迴圈裡的 `dx/dy/dz` 是「索引差 × spacing」，也就是**網格自己
 * 的座標系**；平面法線卻是世界座標。直接把兩者做內積在 `direction` 是單位矩陣時
 * 剛好正確，在 gantry tilt／斜面取像上就是錯的——而開發機上的資料通常是軸對齊的，
 * 所以這個錯誤不會在開發時顯現。
 *
 * 世界位移 = Σ_c axis_c · (Δ_c · spacing_c)，因此
 * `along = n · 世界位移 = Σ_c (n · axis_c) · (Δ_c · spacing_c)`。
 * 回傳的就是那組 `n · axis_c`（`direction` 為 row-major、第 c 欄是第 c 軸）。
 */
export function planeNormalOnGridAxes(
  maskGrid: MaskGrid,
  frameGroup: FrameGroup,
  primaryNormal: Vec3,
): [number, number, number] {
  const n = normalizeIndexDirection(maskGrid, frameGroup, primaryNormal);
  const d = maskGrid.grid.direction;
  return [0, 1, 2].map((c) => n[0] * d[c]! + n[1] * d[3 + c]! + n[2] * d[6 + c]!) as [
    number,
    number,
    number,
  ];
}

/**
 * 沿某個法線方向、相鄰兩層體素之間的距離。
 *
 * 🔴 舊版用 `min(spacing) / 2` 當半厚。在 1.367×1.367×**5** mm 的資料上那是
 * 0.68 mm，而沿 z 的層距是 5 mm ——**筆刷中心只要不是恰好落在某一層上，
 * 整個 disc 就會被剔光，`rasterizeBrush` 回傳 `null`，2D 筆刷完全畫不動**。
 *
 * 正確的是**沿該法線**的層距：`min over c of spacing_c / |n·axis_c|`。
 * 正交視圖會精確退化成該軸的 spacing（與 `cameras.ts` 的 `normalSpacing()`
 * 同一條式子，那裡是用來算「一格滾輪 = 一張切片」）。
 */
export function normalPitch(
  spacing: readonly [number, number, number],
  normalOnAxes: readonly [number, number, number],
): number {
  let pitch = Infinity;
  for (let c = 0; c < 3; c += 1) {
    const component = Math.abs(normalOnAxes[c]!);
    if (component < 1e-9) continue;
    pitch = Math.min(pitch, spacing[c]! / component);
  }
  return Number.isFinite(pitch) ? pitch : Math.min(...spacing);
}

/** primary 世界方向 → 該序列自身的世界方向（只轉旋轉，不加位移）。 */
export function normalizeIndexDirection(
  maskGrid: MaskGrid,
  frameGroup: FrameGroup,
  primaryDirection: Vec3,
): [number, number, number] {
  const origin = fromPrimaryWorld(frameGroup, [0, 0, 0]);
  const tip = fromPrimaryWorld(frameGroup, primaryDirection);
  const d: Vec3 = [tip[0] - origin[0], tip[1] - origin[1], tip[2] - origin[2]];
  const n = Math.hypot(d[0], d[1], d[2]);
  return n === 0 ? [0, 0, 1] : [d[0] / n, d[1] / n, d[2] / n];
}

/**
 * 兩個區塊 bbox 的聯集。
 *
 * 🔴 **不要合併 `data`。** 早期版本有一個 `mergePatches()` 把兩塊的資料寫進
 * 聯集區塊、未被覆蓋的體素留 `0`。但送出的 patch 語意是**整塊取代**
 * （後端 `dense[block] = data`），於是兩個相隔的筆點之間那段空隙會被寫成 0
 * ——在結構中間擦掉一條長方形，而且不會有任何錯誤。
 *
 * 正確做法是只累積 bbox，送出前**從本地 mask 讀出該 bbox 的當前內容**：
 * 本地編輯是立即套用的，所以本地內容就是想要的結果狀態，沒有空隙可言。
 */
export function unionPatchBounds(a: PatchBounds, b: PatchBounds): PatchBounds {
  const lo = [0, 1, 2].map((i) => Math.min(a.offsetIjk[i]!, b.offsetIjk[i]!)) as [
    number,
    number,
    number,
  ];
  const hi = [0, 1, 2].map((i) =>
    Math.max(a.offsetIjk[i]! + a.sizeIjk[i]!, b.offsetIjk[i]! + b.sizeIjk[i]!),
  ) as [number, number, number];
  return {
    offsetIjk: lo,
    sizeIjk: [hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]],
  };
}
