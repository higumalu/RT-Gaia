/**
 * 髒區累積與 rAF 節流 flush。
 *
 * ## 兩條路徑，兩種髒區單位
 *
 * | 模式 | 編輯回饋的實際路徑 | 髒區單位 |
 * |---|---|---|
 * | **outline（預設）** | 改體素 → **重跑受影響區域的 marching squares** → 更新 polyline。**完全沒有 texture 上傳** | **世界空間 bbox** |
 * | fill（選配、GPU） | 改體素 → 更新打包 texture（read-modify-write） | **slice index** |
 * | fill（選配、Tier C） | 改體素 → 重新合成受影響區域 | 世界空間 bbox |
 *
 * > 🔴 outline 模式累積的是**世界空間的髒 bbox，不是 slice index**
 * > （slice index 是 texture 的概念，這裡沒有 texture）。
 *
 * ## 為什麼一定要節流
 *
 * **不得每個 `mousemove` 都上傳。** 斜面筆刷一筆會橫跨多張 slice，每張都得
 * 重傳整張（512×512 uint8 ＝ 262 KB，跨 20 張 ＝ 5 MB）。
 */

import type { Bounds } from '../raster/types';

export interface DirtyRegion {
  /** 世界空間 bbox（LPS mm）。outline 路徑用這個。 */
  worldBounds: Bounds;
  /** 受影響的 mask grid slice index（k 軸）。**只有 fill × GPU 路徑用。** */
  sliceIndices: Set<number>;
}

export type FlushFn = (structureId: string, region: DirtyRegion) => void;

export interface DirtyTrackerOptions {
  /** 注入用；預設 `requestAnimationFrame`，Node 測試傳同步函式。 */
  schedule?: (cb: () => void) => unknown;
  cancel?: (handle: unknown) => void;
}

export class DirtyTracker {
  private readonly regions = new Map<string, DirtyRegion>();
  private handle: unknown = null;
  private readonly schedule: (cb: () => void) => unknown;
  private readonly cancel: (handle: unknown) => void;
  readonly flushCount = { value: 0 };

  constructor(
    private readonly flush: FlushFn,
    options: DirtyTrackerOptions = {},
  ) {
    this.schedule =
      options.schedule ??
      ((cb) =>
        typeof requestAnimationFrame === 'function' ? requestAnimationFrame(cb) : setTimeout(cb, 0));
    this.cancel =
      options.cancel ??
      ((h) => {
        if (typeof cancelAnimationFrame === 'function' && typeof h === 'number') {
          cancelAnimationFrame(h);
        } else if (h !== null) {
          clearTimeout(h as ReturnType<typeof setTimeout>);
        }
      });
  }

  /** 標記一塊髒區。**同一幀內多次呼叫只會 flush 一次。** */
  mark(
    structureId: string,
    worldBounds: Bounds,
    sliceIndices: readonly number[] = [],
  ): void {
    const existing = this.regions.get(structureId);
    if (existing) {
      existing.worldBounds = unionBounds(existing.worldBounds, worldBounds);
      for (const k of sliceIndices) existing.sliceIndices.add(k);
    } else {
      this.regions.set(structureId, {
        worldBounds: cloneBounds(worldBounds),
        sliceIndices: new Set(sliceIndices),
      });
    }
    if (this.handle === null) {
      this.handle = this.schedule(() => {
        this.handle = null;
        this.flushNow();
      });
    }
  }

  /** 立刻 flush（測試與「送出前必須先把畫面補齊」時用）。 */
  flushNow(): void {
    if (this.regions.size === 0) return;
    const pending = [...this.regions.entries()];
    this.regions.clear();
    this.flushCount.value += 1;
    for (const [structureId, region] of pending) this.flush(structureId, region);
  }

  pendingStructures(): string[] {
    return [...this.regions.keys()];
  }

  get pendingCount(): number {
    return this.regions.size;
  }

  dispose(): void {
    if (this.handle !== null) this.cancel(this.handle);
    this.handle = null;
    this.regions.clear();
  }
}

export function cloneBounds(b: Bounds): Bounds {
  return { min: [b.min[0], b.min[1], b.min[2]], max: [b.max[0], b.max[1], b.max[2]] };
}

export function unionBounds(a: Bounds, b: Bounds): Bounds {
  return {
    min: [
      Math.min(a.min[0], b.min[0]),
      Math.min(a.min[1], b.min[1]),
      Math.min(a.min[2], b.min[2]),
    ],
    max: [
      Math.max(a.max[0], b.max[0]),
      Math.max(a.max[1], b.max[1]),
      Math.max(a.max[2], b.max[2]),
    ],
  };
}

/**
 * 髒 bbox 與當前平面求交 → 平面上的矩形。
 *
 * 回傳 null = 髒區不與此平面相交，**這一幀完全不必重算輪廓**。
 * 這是 outline 路徑便宜的原因：捲動到別處時，剛剛畫的那筆不用付任何成本。
 */
export function intersectPlane(
  bounds: Bounds,
  planeOrigin: readonly [number, number, number],
  planeNormal: readonly [number, number, number],
): { minDistance: number; maxDistance: number } | null {
  let min = Infinity;
  let max = -Infinity;
  for (let corner = 0; corner < 8; corner += 1) {
    const p: [number, number, number] = [
      corner & 1 ? bounds.max[0] : bounds.min[0],
      corner & 2 ? bounds.max[1] : bounds.min[1],
      corner & 4 ? bounds.max[2] : bounds.min[2],
    ];
    const d =
      (p[0] - planeOrigin[0]) * planeNormal[0] +
      (p[1] - planeOrigin[1]) * planeNormal[1] +
      (p[2] - planeOrigin[2]) * planeNormal[2];
    min = Math.min(min, d);
    max = Math.max(max, d);
  }
  if (min > 0 || max < 0) return null;
  return { minDistance: min, maxDistance: max };
}
