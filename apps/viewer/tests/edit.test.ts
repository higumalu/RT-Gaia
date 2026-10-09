/**
 * 編輯路徑。
 *
 * 這個檔案最重要的一條是 **`SubmitQueue` 消除自我衝突**：
 *
 * > 原設計有一個必然發生的缺陷 —— 前端不等回應就繼續畫，於是第二筆的
 * > `base_content_hash` **必然是過期的** → 409 → 整份重取 → 清空 undo。
 * > **單人連續下筆就會觸發。**
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath, URL } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  DEFAULT_BRUSH,
  DirtyTracker,
  intersectPlane,
  unionPatchBounds,
  primaryFrameGroupOf,
  rasterizeBrush,
  SubmitQueue,
  UndoStack,
  unionBounds,
  createGrid,
  indexToWorld,
  worldToIndex,
  worldToMaskIndex,
  type ConflictInfo,
  type EditOp,
  type MaskGrid,
  type SubmitResult,
  type ViewReference,
  isEditOp,
} from '../src/core';
import { fromWire } from '../src/core/transport/wire';

const fixture = JSON.parse(
  readFileSync(fileURLToPath(new URL('./fixtures/geometry-vectors.json', import.meta.url)), 'utf8'),
) as { mask_grid: Record<string, unknown>; display_grid_cases: { cases: { display_grid: Record<string, unknown> }[] } };

const maskGrid: MaskGrid = fromWire.maskGrid(fixture.mask_grid);
const frameGroup = primaryFrameGroupOf(maskGrid.grid.frameOfReferenceUid, 'series.primary');

/** coverage 實際涵蓋幾個 k 層。 */
function coveredLayers(p: { sizeIjk: readonly [number, number, number]; coverage: Uint8Array }): number {
  let n = 0;
  const plane = p.sizeIjk[0] * p.sizeIjk[1];
  for (let k = 0; k < p.sizeIjk[2]; k += 1) {
    for (let i = 0; i < plane; i += 1) {
      if (p.coverage[k * plane + i] !== 0) { n += 1; break; }
    }
  }
  return n;
}

/** 網格中心的世界座標（筆刷測試用）。 */
function gridCenterWorld(g: MaskGrid): [number, number, number] {
  return indexToWorld(g.grid, [
    (g.grid.size[0] - 1) / 2,
    (g.grid.size[1] - 1) / 2,
    (g.grid.size[2] - 1) / 2,
  ]);
}

const view: ViewReference = {
  frameOfReferenceUid: maskGrid.grid.frameOfReferenceUid,
  displayGridId: 'dg_test',
  planeOrigin: [0, 0, 0],
  viewPlaneNormal: [0, 0, 1],
  viewUp: [0, -1, 0],
  slabThicknessMm: 0,
  temporalGroupId: null,
  frameIndex: null,
};

describe('座標轉換鏈：型別系統擋住 DisplayGrid', () => {
  it('worldToMaskIndex 只接受 MaskGrid', () => {
    const ijk = worldToMaskIndex(maskGrid, frameGroup, [0, 0, 0]);
    expect(ijk).toHaveLength(3);
  });

  it('🔴 傳 DisplayGrid 進去在編譯期就不通過', () => {
    const displayGrid = fromWire.displayGrid(fixture.display_grid_cases.cases[1]!.display_grid);
    // @ts-expect-error DisplayGrid 沒有 maskGridId，因此型別不相容 —— 這正是防護
    expect(() => worldToMaskIndex(displayGrid, frameGroup, [0, 0, 0])).toBeDefined();
  });

  it('世界座標 → mask 索引與 grid 的反變換一致', () => {
    const world = [12.5, -8.25, 3] as const;
    const viaBrush = worldToMaskIndex(maskGrid, frameGroup, world);
    const viaGrid = fromWire.grid(fixture.mask_grid.grid as Record<string, unknown>);
    const direct = worldToMaskIndexReference(viaGrid, world);
    for (let k = 0; k < 3; k += 1) {
      expect(Math.abs(viaBrush[k]! - direct[k]!)).toBeLessThan(1e-9);
    }
  });
});

function worldToMaskIndexReference(
  grid: ReturnType<typeof fromWire.grid>,
  world: readonly [number, number, number],
): [number, number, number] {
  // 以 geometry 的公開 API 再算一次，作為交叉檢查
  return worldToIndex(grid, world);
}

describe('筆刷：半徑以 mm 為單位', () => {
  it('非等向網格上筆刷仍是球，不是扁餅', () => {
    const patch = rasterizeBrush({
      maskGrid,
      frameGroup,
      centerPrimaryWorld: [0, 0, 0],
      brush: { ...DEFAULT_BRUSH, radiusMm: 6 },
    });
    expect(patch).not.toBeNull();
    const spacing = maskGrid.grid.spacing;
    // 各軸的體素半徑 = 6 mm / spacing，因此 size 反比於 spacing
    const expectedVoxels = spacing.map((s) => Math.round((6 / s) * 2) + 1);
    for (let k = 0; k < 3; k += 1) {
      expect(Math.abs(patch!.sizeIjk[k]! - expectedVoxels[k]!)).toBeLessThanOrEqual(2);
    }
  });

  it('橡皮擦寫 0 而不是不寫', () => {
    const patch = rasterizeBrush({
      maskGrid,
      frameGroup,
      centerPrimaryWorld: [0, 0, 0],
      brush: { ...DEFAULT_BRUSH, erase: true, radiusMm: 3 },
    });
    expect(patch).not.toBeNull();
    expect(patch!.data.every((v) => v === 0)).toBe(true);
  });

  it('閾值筆刷只作用於 HU 區間內的 voxel', () => {
    const patch = rasterizeBrush({
      maskGrid,
      frameGroup,
      centerPrimaryWorld: [0, 0, 0],
      brush: { ...DEFAULT_BRUSH, radiusMm: 4, huRange: [100, 200] },
      sampleHu: (ijk) => (ijk[0] % 2 === 0 ? 150 : -500),
    });
    expect(patch).not.toBeNull();
    const set = patch!.data.filter((v) => v === 1).length;
    const total = patch!.data.length;
    expect(set).toBeGreaterThan(0);
    expect(set).toBeLessThan(total);
  });

  it('筆刷落在網格外時回傳 null（不是丟例外）', () => {
    const patch = rasterizeBrush({
      maskGrid,
      frameGroup,
      centerPrimaryWorld: [100000, 0, 0],
      brush: DEFAULT_BRUSH,
    });
    expect(patch).toBeNull();
  });

  it('🔴 coverage 是球，不是外接方塊', () => {
    const patch = rasterizeBrush({
      maskGrid,
      frameGroup,
      centerPrimaryWorld: gridCenterWorld(maskGrid),
      brush: { ...DEFAULT_BRUSH, radiusMm: 6, shape: 'sphere' },
    })!;
    expect(patch).not.toBeNull();
    const n = patch.sizeIjk[0] * patch.sizeIjk[1] * patch.sizeIjk[2];
    let covered = 0;
    for (const v of patch.coverage) if (v !== 0) covered += 1;
    // 若 coverage 等於整塊，就是那個會擦掉方塊角落的 bug
    expect(covered).toBeGreaterThan(0);
    expect(covered).toBeLessThan(n);
    // 角落必須沒被覆蓋（外接方塊的八個角一定在球外）
    expect(patch.coverage[0]).toBe(0);
    expect(patch.coverage[n - 1]).toBe(0);
    // 真正的不變式（與 spacing 無關）：**每一個被覆蓋的格子都在半徑內**
    const spacing = maskGrid.grid.spacing;
    const center = worldToMaskIndex(maskGrid, frameGroup, gridCenterWorld(maskGrid));
    for (let k = 0; k < patch.sizeIjk[2]; k += 1) {
      for (let j = 0; j < patch.sizeIjk[1]; j += 1) {
        for (let i = 0; i < patch.sizeIjk[0]; i += 1) {
          const idx = (k * patch.sizeIjk[1] + j) * patch.sizeIjk[0] + i;
          if (patch.coverage[idx] === 0) continue;
          const dx = (patch.offsetIjk[0] + i - center[0]) * spacing[0];
          const dy = (patch.offsetIjk[1] + j - center[1]) * spacing[1];
          const dz = (patch.offsetIjk[2] + k - center[2]) * spacing[2];
          expect(Math.hypot(dx, dy, dz)).toBeLessThanOrEqual(6 + 1e-9);
        }
      }
    }
  });

  it('🔴 橡皮擦也有 coverage —— data 全 0 不代表要擦整塊', () => {
    const patch = rasterizeBrush({
      maskGrid,
      frameGroup,
      centerPrimaryWorld: gridCenterWorld(maskGrid),
      brush: { ...DEFAULT_BRUSH, radiusMm: 6, erase: true },
    })!;
    expect(patch).not.toBeNull();
    // data 全 0（要清除），但 coverage 只有球內
    expect([...patch.data].every((v) => v === 0)).toBe(true);
    let covered = 0;
    for (const v of patch.coverage) if (v !== 0) covered += 1;
    expect(covered).toBeGreaterThan(0);
    expect(covered).toBeLessThan(patch.data.length);
  });

  it('🔴 軸對齊網格：sphere 跨切面、disc 恰好一層', () => {
    // 真實 CT 的形狀：1.367×1.367×5 mm，軸對齊
    const axisAligned: MaskGrid = {
      grid: createGrid({
        size: [64, 64, 20],
        spacing: [1.367, 1.367, 5],
        origin: [0, 0, 0],
        direction: [1, 0, 0, 0, 1, 0, 0, 0, 1],
        frameOfReferenceUid: 'for.axis',
      }),
      maskGridId: 'mg_axis',
    };
    const fg = primaryFrameGroupOf('for.axis', 'series.axis');
    const center = indexToWorld(axisAligned.grid, [32, 32, 10]);
    const args = {
      maskGrid: axisAligned,
      frameGroup: fg,
      centerPrimaryWorld: center,
      planeNormal: [0, 0, 1] as [number, number, number],
    };
    const sphere = rasterizeBrush({ ...args, brush: { ...DEFAULT_BRUSH, radiusMm: 12, shape: 'sphere' } })!;
    const disc = rasterizeBrush({ ...args, brush: { ...DEFAULT_BRUSH, radiusMm: 12, shape: 'disc' } })!;
    expect(sphere).not.toBeNull();
    expect(disc).not.toBeNull();
    expect(coveredLayers(sphere)).toBeGreaterThan(1);
    expect(coveredLayers(disc)).toBe(1);
  });

  it('🔴 disc 在中心不落於某一層時仍然畫得出東西', () => {
    // 舊版半厚是 `min(spacing)/2`（1.367/2 = 0.68 mm），而沿 z 的層距是 5 mm，
    // 於是中心一離開切片平面整個 disc 就被剔光、`rasterizeBrush` 回 null
    // ——2D 筆刷完全畫不動，而且沒有任何錯誤。
    const axisAligned: MaskGrid = {
      grid: createGrid({
        size: [64, 64, 20],
        spacing: [1.367, 1.367, 5],
        origin: [0, 0, 0],
        direction: [1, 0, 0, 0, 1, 0, 0, 0, 1],
        frameOfReferenceUid: 'for.axis',
      }),
      maskGridId: 'mg_axis',
    };
    const disc = rasterizeBrush({
      maskGrid: axisAligned,
      frameGroup: primaryFrameGroupOf('for.axis', 'series.axis'),
      // 兩層正中間
      centerPrimaryWorld: indexToWorld(axisAligned.grid, [32, 32, 10.5]),
      planeNormal: [0, 0, 1],
      brush: { ...DEFAULT_BRUSH, radiusMm: 12, shape: 'disc' },
    });
    expect(disc).not.toBeNull();
    let covered = 0;
    for (const v of disc!.coverage) if (v !== 0) covered += 1;
    expect(covered).toBeGreaterThan(0);
  });

  it('🔴 斜面：disc 的每一個格子都在半厚之內（跨幾層是幾何結果，不是缺陷）', () => {
    // gantry tilt 的 fixture：世界法線 [0,0,1] 與網格 k 軸不平行，
    // 因此一個「單一平面」的 disc 自然會碰到多個索引層。真正的不變式是距離。
    const center = indexToWorld(maskGrid.grid, [255, 255, 49]);
    const normal: [number, number, number] = [0, 0, 1];
    const disc = rasterizeBrush({
      maskGrid,
      frameGroup,
      centerPrimaryWorld: center,
      planeNormal: normal,
      brush: { ...DEFAULT_BRUSH, radiusMm: 12, shape: 'disc' },
    })!;
    const sphere = rasterizeBrush({
      maskGrid,
      frameGroup,
      centerPrimaryWorld: center,
      planeNormal: normal,
      brush: { ...DEFAULT_BRUSH, radiusMm: 12, shape: 'sphere' },
    })!;
    expect(disc).not.toBeNull();
    expect(coveredLayers(disc)).toBeGreaterThan(1); // 斜面，本來就跨層
    // 但每個格子到平面的距離都在半個層距內，且總量遠少於球
    const spacing = maskGrid.grid.spacing;
    const d = maskGrid.grid.direction;
    const nOnAxes = [0, 1, 2].map((c) => normal[0] * d[c]! + normal[1] * d[3 + c]! + normal[2] * d[6 + c]!);
    let pitch = Infinity;
    for (let c = 0; c < 3; c += 1) {
      if (Math.abs(nOnAxes[c]!) < 1e-9) continue;
      pitch = Math.min(pitch, spacing[c]! / Math.abs(nOnAxes[c]!));
    }
    const centerIjk = worldToMaskIndex(maskGrid, frameGroup, center);
    for (let k = 0; k < disc.sizeIjk[2]; k += 1) {
      for (let j = 0; j < disc.sizeIjk[1]; j += 1) {
        for (let i = 0; i < disc.sizeIjk[0]; i += 1) {
          const idx = (k * disc.sizeIjk[1] + j) * disc.sizeIjk[0] + i;
          if (disc.coverage[idx] === 0) continue;
          const dx = (disc.offsetIjk[0] + i - centerIjk[0]) * spacing[0];
          const dy = (disc.offsetIjk[1] + j - centerIjk[1]) * spacing[1];
          const dz = (disc.offsetIjk[2] + k - centerIjk[2]) * spacing[2];
          const along = dx * nOnAxes[0]! + dy * nOnAxes[1]! + dz * nOnAxes[2]!;
          expect(Math.abs(along)).toBeLessThanOrEqual(pitch / 2 + 1e-6);
        }
      }
    }
    let dc = 0;
    for (const v of disc.coverage) if (v !== 0) dc += 1;
    let sc = 0;
    for (const v of sphere.coverage) if (v !== 0) sc += 1;
    expect(dc).toBeLessThan(sc);
  });

  it('🔴 disc 少了 planeNormal 會退化成 sphere —— 呼叫端必須傳', () => {
    // `ViewerHost` 曾經沒傳，於是「只作用當前平面」靜默畫出跨切面的球。
    // 這個測試釘住那個退化行為，好讓它是**已知的**而不是意外。
    const center = indexToWorld(maskGrid.grid, [255, 255, 49]);
    const withNormal = rasterizeBrush({
      maskGrid,
      frameGroup,
      centerPrimaryWorld: center,
      planeNormal: [0, 0, 1],
      brush: { ...DEFAULT_BRUSH, radiusMm: 12, shape: 'disc' },
    })!;
    const withoutNormal = rasterizeBrush({
      maskGrid,
      frameGroup,
      centerPrimaryWorld: center,
      brush: { ...DEFAULT_BRUSH, radiusMm: 12, shape: 'disc' },
    })!;
    let a = 0;
    for (const v of withNormal.coverage) if (v !== 0) a += 1;
    let b = 0;
    for (const v of withoutNormal.coverage) if (v !== 0) b += 1;
    expect(b).toBeGreaterThan(a);
  });

  it('unionPatchBounds 取兩塊的聯集 bbox', () => {
    const a = { offsetIjk: [0, 0, 0] as const, sizeIjk: [2, 2, 1] as const };
    const b = { offsetIjk: [5, 1, 0] as const, sizeIjk: [2, 2, 1] as const };
    const u = unionPatchBounds(a, b);
    expect(u.offsetIjk).toEqual([0, 0, 0]);
    expect(u.sizeIjk).toEqual([7, 3, 1]);
  });

  it('🔴 只回傳 bbox，不合併資料 —— 空隙不得被寫成 0', () => {
    // 這是舊 `mergePatches()` 的缺陷：兩個相隔的筆點取聯集後，中間那段沒被
    // 任何一筆覆蓋到的體素在合併結果裡是 0，而 patch 語意是整塊取代
    // （後端 `dense[block] = data`）→ 在結構中間擦掉一條長方形，毫無錯誤。
    const u = unionPatchBounds(
      { offsetIjk: [0, 0, 0], sizeIjk: [1, 1, 1] },
      { offsetIjk: [9, 0, 0], sizeIjk: [1, 1, 1] },
    );
    expect(u.sizeIjk).toEqual([10, 1, 1]);
    // 型別上就沒有 data 可以填錯
    expect('data' in u).toBe(false);
  });
});

describe('髒區以世界 bbox 累積，rAF 節流', () => {
  it('同一幀內多次 mark 只 flush 一次', () => {
    const flushed: string[] = [];
    let scheduled: (() => void) | null = null;
    const tracker = new DirtyTracker(
      (structureId) => flushed.push(structureId),
      { schedule: (cb) => { scheduled = cb; return 1; }, cancel: () => {} },
    );
    const bounds = { min: [0, 0, 0] as [number, number, number], max: [1, 1, 1] as [number, number, number] };
    tracker.mark('gtv', bounds);
    tracker.mark('gtv', bounds);
    tracker.mark('gtv', bounds);
    expect(flushed).toEqual([]);
    scheduled!();
    expect(flushed).toEqual(['gtv']);
    expect(tracker.flushCount.value).toBe(1);
  });

  it('多個結構在同一幀各 flush 一次', () => {
    const flushed: string[] = [];
    let scheduled: (() => void) | null = null;
    const tracker = new DirtyTracker(
      (structureId) => flushed.push(structureId),
      { schedule: (cb) => { scheduled = cb; return 1; }, cancel: () => {} },
    );
    const bounds = { min: [0, 0, 0] as [number, number, number], max: [1, 1, 1] as [number, number, number] };
    tracker.mark('a', bounds);
    tracker.mark('b', bounds);
    scheduled!();
    expect(flushed.sort()).toEqual(['a', 'b']);
  });

  it('髒 bbox 取聯集', () => {
    const a = { min: [0, 0, 0] as [number, number, number], max: [1, 1, 1] as [number, number, number] };
    const b = { min: [-2, 0, 0] as [number, number, number], max: [1, 5, 1] as [number, number, number] };
    expect(unionBounds(a, b)).toEqual({ min: [-2, 0, 0], max: [1, 5, 1] });
  });

  it('髒區不與當前平面相交時完全不必重算（outline 便宜的原因）', () => {
    const bounds = { min: [0, 0, 10] as [number, number, number], max: [5, 5, 15] as [number, number, number] };
    expect(intersectPlane(bounds, [0, 0, 0], [0, 0, 1])).toBeNull();
    expect(intersectPlane(bounds, [0, 0, 12], [0, 0, 1])).not.toBeNull();
  });
});

describe('Undo / Redo：逐筆子區塊差異', () => {
  function op(structureId: string, value: number): EditOp {
    return {
      structureId,
      frameIndex: null,
      offsetIjk: [0, 0, 0],
      sizeIjk: [2, 2, 1],
      before: new Uint8Array([0, 0, 0, 0]),
      after: new Uint8Array([value, value, value, value]),
      viewReference: view,
    };
  }

  it('undo 寫回 before，redo 寫回 after', () => {
    const applied: { direction: string; value: number }[] = [];
    const stack = new UndoStack((o, direction) => {
      if (!isEditOp(o)) return;
      applied.push({ direction, value: direction === 'undo' ? o.before[0]! : o.after[0]! });
    });
    stack.push(op('gtv', 1));
    expect(stack.canUndo()).toBe(true);
    stack.undo();
    expect(applied.at(-1)).toEqual({ direction: 'undo', value: 0 });
    stack.redo();
    expect(applied.at(-1)).toEqual({ direction: 'redo', value: 1 });
  });

  it('不得對整個 volume 做快照：每筆記憶體 = 2 × 子區塊', () => {
    const stack = new UndoStack(() => {});
    stack.push(op('gtv', 1));
    expect(stack.bytes()).toBe(8);
  });

  it('深度上限，超過丟棄最舊的', () => {
    const stack = new UndoStack(() => {}, 3);
    for (let n = 0; n < 5; n += 1) stack.push(op('gtv', 1));
    expect(stack.undoDepth).toBe(3);
  });

  it('新的編輯讓 redo 分支失效', () => {
    const stack = new UndoStack(() => {});
    stack.push(op('gtv', 1));
    stack.undo();
    expect(stack.canRedo()).toBe(true);
    stack.push(op('gtv', 2));
    expect(stack.canRedo()).toBe(false);
  });

  it('409 後清空該結構的 undo（只影響該結構）', () => {
    const stack = new UndoStack(() => {});
    stack.push(op('gtv', 1));
    stack.push(op('ctv', 1));
    expect(stack.invalidateStructure('gtv')).toBe(1);
    expect(stack.undoDepth).toBe(1);
    expect(stack.auditTrail()[0]!.structureId).toBe('ctv');
  });

  it('追溯：每筆 op 都記下 viewReference（不得存 slice index）', () => {
    const stack = new UndoStack(() => {});
    stack.push(op('gtv', 1));
    const trail = stack.auditTrail();
    expect(trail[0]!.viewReference.planeOrigin).toEqual([0, 0, 0]);
    expect(trail[0]!.viewReference).not.toHaveProperty('sliceIndex');
  });

  it('before/after 長度不符即拒絕', () => {
    const stack = new UndoStack(() => {});
    expect(() =>
      stack.push({ ...op('gtv', 1), after: new Uint8Array([1, 1]) }),
    ).toThrowError(/U1/);
  });
});

describe('🔴 每個結構一條送出佇列', () => {
  const bounds = { offsetIjk: [0, 0, 0] as const, sizeIjk: [2, 2, 1] as const };
  /** 佇列只累積 bbox，資料在送出前才讀（見 `unionPatchBounds`）。 */
  const readBlock = (): Uint8Array => new Uint8Array([1, 1, 1, 1]);

  it('連續下筆不會自我衝突 —— 這是整個機制存在的理由', async () => {
    const seen: { baseContentHash: string; clientSeq: number }[] = [];
    let hashCounter = 0;
    const queue = new SubmitQueue({
      readBlock,
      submit: async (request) => {
        seen.push({ baseContentHash: request.baseContentHash, clientSeq: request.clientSeq });
        hashCounter += 1;
        return { status: 'ok', contentHash: `h${hashCounter}` };
      },
      onConflict: () => {
        throw new Error('不該發生衝突');
      },
    });
    queue.register({ structureId: 'gtv', frameIndex: null, maskGridId: 'mg', contentHash: 'h0' });

    // 使用者畫得比網路快：連續五筆
    for (let n = 0; n < 5; n += 1) queue.enqueue({ structureId: 'gtv', frameIndex: null, bounds, viewReference: view });
    await queue.drain();

    // 每個請求的 baseContentHash 都是**上一次 200 回來的**，不是本地推測值
    expect(seen[0]!.baseContentHash).toBe('h0');
    for (let n = 1; n < seen.length; n += 1) {
      expect(seen[n]!.baseContentHash).toBe(`h${n}`);
    }
    // clientSeq 單調遞增
    expect(seen.map((s) => s.clientSeq)).toEqual([...seen.map((_, i) => i + 1)]);
  });

  it('in-flight 期間的多筆在送出前合併（因此請求數 < 筆數）', async () => {
    let resolveFirst: ((v: { status: 'ok'; contentHash: string }) => void) | null = null;
    let calls = 0;
    const queue = new SubmitQueue({
      readBlock,
      submit: async () => {
        calls += 1;
        if (calls === 1) {
          return new Promise((resolve) => {
            resolveFirst = resolve;
          });
        }
        return { status: 'ok', contentHash: `h${calls}` };
      },
      onConflict: () => {},
    });
    queue.register({ structureId: 'gtv', frameIndex: null, maskGridId: 'mg', contentHash: 'h0' });
    queue.enqueue({ structureId: 'gtv', frameIndex: null, bounds, viewReference: view });
    // 第一個還沒回來時再畫三筆
    for (let n = 0; n < 3; n += 1) queue.enqueue({ structureId: 'gtv', frameIndex: null, bounds, viewReference: view });
    expect(queue.stats('gtv')!.inFlight).toBe(true);
    expect(queue.stats('gtv')!.mergedCount).toBe(2);
    resolveFirst!({ status: 'ok', contentHash: 'h1' });
    await queue.drain();
    // 4 筆 → 2 個請求（第一筆 ＋ 合併後的一批）
    expect(calls).toBe(2);
  });

  it('每個 (structureId, frameIndex) 各自一條佇列', async () => {
    const targets: string[] = [];
    const queue = new SubmitQueue({
      readBlock,
      submit: async (request) => {
        targets.push(`${request.structureId}@${request.frameIndex}`);
        return { status: 'ok', contentHash: 'h1' };
      },
      onConflict: () => {},
    });
    queue.register({ structureId: 'gtv', frameIndex: 0, maskGridId: 'mg', contentHash: 'h0' });
    queue.register({ structureId: 'gtv', frameIndex: 1, maskGridId: 'mg', contentHash: 'h0' });
    queue.enqueue({ structureId: 'gtv', frameIndex: 0, bounds, viewReference: view });
    queue.enqueue({ structureId: 'gtv', frameIndex: 1, bounds, viewReference: view });
    await queue.drain();
    expect(targets.sort()).toEqual(['gtv@0', 'gtv@1']);
  });

  it('真外部衝突（409）才走重取流程，並丟棄待送 op', async () => {
    const conflicts: { structureId: string; contentHash: string; reason: string }[] = [];
    const queue = new SubmitQueue({
      readBlock,
      submit: async () => ({ status: 'conflict', contentHash: 'server-hash', reason: 'stale_hash' }),
      onConflict: (info) => conflicts.push(info),
    });
    queue.register({ structureId: 'gtv', frameIndex: null, maskGridId: 'mg', contentHash: 'h0' });
    queue.enqueue({ structureId: 'gtv', frameIndex: null, bounds, viewReference: view });
    await queue.drain();
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]!.reason).toBe('stale_hash');
    // baseContentHash 更新為後端的值，前端據此重取
    expect(queue.contentHash('gtv')).toBe('server-hash');
  });

  it('未 register 就 enqueue 會回報錯誤，而不是靜默丟掉編輯', () => {
    const errors: string[] = [];
    const queue = new SubmitQueue({
      readBlock,
      submit: async () => ({ status: 'ok', contentHash: 'h' }),
      onConflict: () => {},
      onError: (message) => errors.push(message),
    });
    queue.enqueue({ structureId: 'unknown', frameIndex: null, bounds, viewReference: view });
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('register');
  });

  it('送出失敗（網路錯誤）回報錯誤而不是當成成功', async () => {
    const errors: string[] = [];
    const queue = new SubmitQueue({
      readBlock,
      // 退避設 0：這條測的是「有沒有回報」，不是「等多久」
      retryDelayMs: () => 0,
      submit: async () => {
        throw new Error('network down');
      },
      onConflict: () => {},
      onError: (message) => errors.push(message),
    });
    queue.register({ structureId: 'gtv', frameIndex: null, maskGridId: 'mg', contentHash: 'h0' });
    queue.enqueue({ structureId: 'gtv', frameIndex: null, bounds, viewReference: view });
    await queue.drain();
    expect(errors[0]).toContain('network down');
    // 失敗後 hash 不得推進
    expect(queue.contentHash('gtv')).toBe('h0');
  });

  /**
   * 🔴 **送出失敗的編輯不得被靜默丟棄** —— 這一組是全案風險最高的回歸測試。
   *
   * 舊版 `pump()` 在 `await` **之前**就把 `pending` 清成 null，而 `ViewerHost`
   * 建佇列時**沒有給 `onError`**（`ViewerHostOptions` 連這個欄位都沒有）。三者
   * 合起來的後果是：筆畫本地畫上去、後端沒收到、沒重試、沒提示，而且
   * `baseContentHash` 沒推進所以後端也不會回 409 —— **永久且無聲**，直到匯出
   * RTSTRUCT 才發現一段輪廓不見了。
   *
   * 現有測試抓不到它，因為它們的 `submit` 從不失敗。
   */
  describe('🔴 送出失敗的編輯不得被靜默丟棄', () => {
    /** 測試一律把退避設成 0，否則整個套件會被真的 sleep 拖慢。 */
    const noDelay = (): number => 0;

    it('連續失敗後 pending 仍在，重試成功時後端拿到完整 bbox', async () => {
      const received: { offsetIjk: readonly number[]; sizeIjk: readonly number[] }[] = [];
      let attempts = 0;
      const queue = new SubmitQueue({
        readBlock: () => new Uint8Array(12).fill(1),
        retryDelayMs: noDelay,
        submit: async (request) => {
          attempts += 1;
          if (attempts <= 2) return { status: 'error', message: 'network down' };
          received.push({
            offsetIjk: request.patch.offsetIjk,
            sizeIjk: request.patch.sizeIjk,
          });
          return { status: 'ok', contentHash: 'h1' };
        },
        onConflict: () => {
          throw new Error('不該發生衝突');
        },
      });
      queue.register({ structureId: 'gtv', frameIndex: null, maskGridId: 'mg', contentHash: 'h0' });
      queue.enqueue({ structureId: 'gtv', frameIndex: null, bounds, viewReference: view });
      await queue.drain();

      expect(attempts).toBe(3);
      expect(received).toHaveLength(1);
      // 失敗兩次之後那一筆仍然送到了，而且是原本的 bbox
      expect(received[0]!.offsetIjk).toEqual([0, 0, 0]);
      expect(received[0]!.sizeIjk).toEqual([2, 2, 1]);
      expect(queue.isIdle()).toBe(true);
      expect(queue.failures()).toHaveLength(0);
      expect(queue.contentHash('gtv')).toBe('h1');
    });

    it('失敗期間新畫的一筆會與待送的取聯集，兩者都不會遺失', async () => {
      const received: { offsetIjk: readonly number[]; sizeIjk: readonly number[] }[] = [];
      let attempts = 0;
      const queue = new SubmitQueue({
        readBlock: () => new Uint8Array(64).fill(1),
        retryDelayMs: noDelay,
        submit: async (request) => {
          attempts += 1;
          if (attempts === 1) return { status: 'error', message: 'network down' };
          received.push({
            offsetIjk: request.patch.offsetIjk,
            sizeIjk: request.patch.sizeIjk,
          });
          return { status: 'ok', contentHash: `h${attempts}` };
        },
        onConflict: () => {},
      });
      queue.register({ structureId: 'gtv', frameIndex: null, maskGridId: 'mg', contentHash: 'h0' });
      queue.enqueue({ structureId: 'gtv', frameIndex: null, bounds, viewReference: view });
      // 第一筆還在飛（或剛失敗）時又畫了離得很遠的一筆
      queue.enqueue({
        structureId: 'gtv',
        frameIndex: null,
        bounds: { offsetIjk: [4, 4, 0] as const, sizeIjk: [2, 2, 1] as const },
        viewReference: view,
      });
      await queue.drain();

      expect(queue.failures()).toHaveLength(0);
      // 🔴 送出去的 bbox 必須同時涵蓋 (0,0,0)+(2,2,1) 與 (4,4,0)+(2,2,1)。
      // 少了任何一邊就是靜默資料遺失。
      const covered = received.some(
        (r) =>
          r.offsetIjk[0] === 0 &&
          r.offsetIjk[1] === 0 &&
          r.sizeIjk[0]! >= 6 &&
          r.sizeIjk[1]! >= 6,
      );
      expect(covered, `送出的 bbox: ${JSON.stringify(received)}`).toBe(true);
    });

    it('🔴 超過重試上限 → onError 被呼叫，且 isIdle() 為 false（資料還在）', async () => {
      const errors: string[] = [];
      let attempts = 0;
      const queue = new SubmitQueue({
        readBlock: () => new Uint8Array(4).fill(1),
        retryDelayMs: noDelay,
        maxRetries: 3,
        submit: async () => {
          attempts += 1;
          return { status: 'error', message: 'network down' };
        },
        onConflict: () => {},
        onError: (message) => errors.push(message),
      });
      queue.register({ structureId: 'gtv', frameIndex: null, maskGridId: 'mg', contentHash: 'h0' });
      queue.enqueue({ structureId: 'gtv', frameIndex: null, bounds, viewReference: view });
      await queue.drain();

      // 第一次 ＋ 三次重試
      expect(attempts).toBe(4);
      expect(errors).toHaveLength(1);
      expect(errors[0]).toContain('沒有存到');
      // 🔴 資料還在佇列裡 —— 「關閉病例前要等佇列清空」那條檢查因此攔得住
      expect(queue.isIdle()).toBe(false);
      const failures = queue.failures();
      expect(failures).toHaveLength(1);
      expect(failures[0]!.structureId).toBe('gtv');
      expect(failures[0]!.pending).not.toBeNull();
      // 失敗不得推進 hash（否則下次送出會用一個後端沒承認過的值當基準）
      expect(queue.contentHash('gtv')).toBe('h0');
    });

    it('重試用盡後再畫一筆會重新嘗試，成功即恢復', async () => {
      let failUntil = 4;
      let attempts = 0;
      const queue = new SubmitQueue({
        readBlock: () => new Uint8Array(4).fill(1),
        retryDelayMs: noDelay,
        maxRetries: 3,
        submit: async () => {
          attempts += 1;
          if (attempts <= failUntil) return { status: 'error', message: 'network down' };
          return { status: 'ok', contentHash: 'h1' };
        },
        onConflict: () => {},
      });
      queue.register({ structureId: 'gtv', frameIndex: null, maskGridId: 'mg', contentHash: 'h0' });
      queue.enqueue({ structureId: 'gtv', frameIndex: null, bounds, viewReference: view });
      await queue.drain();
      expect(queue.failures()).toHaveLength(1);

      // 網路回來了，使用者又畫一筆
      failUntil = 0;
      queue.enqueue({ structureId: 'gtv', frameIndex: null, bounds, viewReference: view });
      await queue.drain();
      expect(queue.failures()).toHaveLength(0);
      expect(queue.isIdle()).toBe(true);
      expect(queue.contentHash('gtv')).toBe('h1');
    });

    it('重試用盡 → 「再送一次」不用重畫；「放棄」清掉佇列、不推進 hash', async () => {
      let failUntil = 4;
      let attempts = 0;
      const make = (): SubmitQueue =>
        new SubmitQueue({
          readBlock: () => new Uint8Array(4).fill(1),
          retryDelayMs: noDelay,
          maxRetries: 3,
          submit: async () => {
            attempts += 1;
            if (attempts <= failUntil) return { status: 'error', message: 'network down' };
            return { status: 'ok', contentHash: 'h1' };
          },
          onConflict: () => {},
        });
      const queue = make();
      queue.register({ structureId: 'gtv', frameIndex: 3, maskGridId: 'mg', contentHash: 'h0' });
      queue.enqueue({ structureId: 'gtv', frameIndex: 3, bounds, viewReference: view });
      await queue.drain();
      expect(queue.failures()).toHaveLength(1);
      expect(queue.retry('gtv', 2)).toBe(false); // 別的幀沒有失敗
      failUntil = 0; // 網路回來了
      expect(queue.retry('gtv', 3)).toBe(true);
      await queue.drain();
      expect(queue.failures()).toHaveLength(0);
      expect(queue.isIdle()).toBe(true);
      expect(queue.contentHash('gtv', 3)).toBe('h1');
      expect(queue.retry('gtv', 3)).toBe(false); // 已經沒有失敗

      attempts = 0;
      failUntil = 99;
      const q2 = make();
      q2.register({ structureId: 'gtv', frameIndex: null, maskGridId: 'mg', contentHash: 'h0' });
      q2.enqueue({ structureId: 'gtv', frameIndex: null, bounds, viewReference: view });
      await q2.drain();
      expect(q2.discard('gtv')).toBe(true);
      expect(q2.failures()).toHaveLength(0);
      expect(q2.isIdle()).toBe(true); // 沒存到的已經放棄 —— 呼叫端取回後端版本
      expect(q2.contentHash('gtv')).toBe('h0');
      expect(q2.discard('gtv')).toBe(false);
    });

    it('🔴 錯誤路徑會再 pump 一次 —— 飛行期間排入的 bbox 不會卡到下一筆筆畫', async () => {
      // 舊版錯誤路徑根本不呼叫 pump()，於是即使 pending 沒被清掉，
      // 那一批也要等使用者「再畫一筆」才會被送出。
      let attempts = 0;
      let resolveFirst: ((v: SubmitResult) => void) | null = null;
      const queue = new SubmitQueue({
        readBlock: () => new Uint8Array(64).fill(1),
        retryDelayMs: noDelay,
        submit: async () => {
          attempts += 1;
          if (attempts === 1) {
            return new Promise<SubmitResult>((resolve) => {
              resolveFirst = resolve;
            });
          }
          return { status: 'ok', contentHash: `h${attempts}` };
        },
        onConflict: () => {},
      });
      queue.register({ structureId: 'gtv', frameIndex: null, maskGridId: 'mg', contentHash: 'h0' });
      queue.enqueue({ structureId: 'gtv', frameIndex: null, bounds, viewReference: view });
      // 飛行中再排一筆
      queue.enqueue({
        structureId: 'gtv',
        frameIndex: null,
        bounds: { offsetIjk: [4, 4, 0] as const, sizeIjk: [2, 2, 1] as const },
        viewReference: view,
      });
      // 第一筆失敗
      resolveFirst!({ status: 'error', message: 'network down' });
      // 沒有任何新的 enqueue —— 佇列必須自己把兩批的聯集送出去
      await queue.drain();

      expect(attempts).toBeGreaterThanOrEqual(2);
      expect(queue.isIdle()).toBe(true);
      expect(queue.failures()).toHaveLength(0);
    });

    it('本地 mask 不在倉裡時算失敗並回報，不會假裝送出成功', async () => {
      const errors: string[] = [];
      let submitted = 0;
      const queue = new SubmitQueue({
        readBlock: () => null,
        retryDelayMs: noDelay,
        submit: async () => {
          submitted += 1;
          return { status: 'ok', contentHash: 'h1' };
        },
        onConflict: () => {},
        onError: (message) => errors.push(message),
      });
      queue.register({ structureId: 'gtv', frameIndex: null, maskGridId: 'mg', contentHash: 'h0' });
      queue.enqueue({ structureId: 'gtv', frameIndex: null, bounds, viewReference: view });
      await queue.drain();
      expect(submitted).toBe(0);
      expect(errors[0]).toContain('不在倉裡');
      expect(queue.failures()).toHaveLength(1);
    });

    it('409 不重試 —— 待送的與飛行中的都被算進 discarded', async () => {
      const conflicts: ConflictInfo[] = [];
      let attempts = 0;
      const queue = new SubmitQueue({
        readBlock: () => new Uint8Array(4).fill(1),
        retryDelayMs: noDelay,
        submit: async () => {
          attempts += 1;
          return { status: 'conflict', contentHash: 'server-hash', reason: 'stale_hash' };
        },
        onConflict: (info) => conflicts.push(info),
      });
      queue.register({ structureId: 'gtv', frameIndex: null, maskGridId: 'mg', contentHash: 'h0' });
      queue.enqueue({ structureId: 'gtv', frameIndex: null, bounds, viewReference: view });
      await queue.drain();
      // 衝突是「後端已經變了」，重送同一筆只會再撞一次 —— 因此不重試
      expect(attempts).toBe(1);
      expect(conflicts).toHaveLength(1);
      expect(conflicts[0]!.discarded).toBe(1);
      expect(queue.failures()).toHaveLength(0);
    });
  });
});


describe('🔴 推送來的 mask.updated 不能蓋掉還沒送出的筆畫', () => {
  const bounds = { offsetIjk: [0, 0, 0] as const, sizeIjk: [2, 2, 1] as const };
  const readBlock = (): Uint8Array => new Uint8Array([1, 1, 1, 1]);

  /** 第一筆的回應由測試決定什麼時候回來（模擬遠端延遲）。 */
  function slowQueue(remote: { structureId: string; frameIndex: number | null; contentHash: string }[]) {
    const resolvers: ((v: { status: 'ok'; contentHash: string }) => void)[] = [];
    const queue = new SubmitQueue({
      readBlock,
      submit: () =>
        new Promise((resolve) => {
          resolvers.push(resolve);
        }),
      onConflict: () => {
        throw new Error('不該有衝突');
      },
      onRemoteChange: (info) => remote.push(info),
    });
    queue.register({ structureId: 'gtv', frameIndex: null, maskGridId: 'mg', contentHash: 'h0' });
    return { queue, resolvers };
  }

  it('自己那筆的回音在回應之前到、下一筆還在等 → 不重抓、送完也不重抓', async () => {
    const remote: { contentHash: string }[] = [];
    const { queue, resolvers } = slowQueue(remote as never);
    queue.enqueue({ structureId: 'gtv', frameIndex: null, bounds, viewReference: view });
    queue.enqueue({ structureId: 'gtv', frameIndex: null, bounds, viewReference: view }); // 第二筆在佇列裡等
    expect(queue.busy('gtv')).toBe(true);
    // 第一筆已在後端套用，回音（h1）比 HTTP 回應早到：以前這裡會重抓、蓋掉第二筆
    expect(queue.remoteUpdate('gtv', null, 'h1')).toBe(false);
    resolvers[0]!({ status: 'ok', contentHash: 'h1' });
    await Promise.resolve();
    await new Promise((r) => setTimeout(r, 0));
    expect(queue.remoteUpdate('gtv', null, 'h1')).toBe(false); // 還在送第二筆
    resolvers[1]!({ status: 'ok', contentHash: 'h2' });
    await queue.drain();
    expect(queue.busy('gtv')).toBe(false);
    // 忙的時候記下的 h1 ≠ 最後的 h2 → 保守地通知一次重抓（這時佇列是空的，重抓不會蓋掉任何東西）
    expect(remote.map((r) => r.contentHash)).toEqual(['h1']);
    // 第二筆的回音（h2）在閒著時到 → 就是最後一次 200，不重抓
    expect(queue.remoteUpdate('gtv', null, 'h2')).toBe(false);
  });

  it('閒著時：同一個 hash 不重抓，不同的（別人改的）才重抓', () => {
    const { queue } = slowQueue([]);
    expect(queue.remoteUpdate('gtv', null, 'h0')).toBe(false);
    expect(queue.remoteUpdate('gtv', null, 'h_other')).toBe(true);
    expect(queue.remoteUpdate('never-registered', null, 'x')).toBe(true);
  });

  it('忙的時候推來的就是送完後的結果 → 不通知', async () => {
    const remote: { contentHash: string }[] = [];
    const { queue, resolvers } = slowQueue(remote as never);
    queue.enqueue({ structureId: 'gtv', frameIndex: null, bounds, viewReference: view });
    expect(queue.remoteUpdate('gtv', null, 'h1')).toBe(false);
    resolvers[0]!({ status: 'ok', contentHash: 'h1' });
    await queue.drain();
    expect(remote).toEqual([]);
  });
});

describe('離開保護的單一判斷 dirtyReason', () => {
  it('八組組合：全零 → null；失敗優先；三種原因串成一句；leaveQuestion 帶動作', async () => {
    const { dirtyReason, isDirty, leaveQuestion } = await import('../src/core/edit/dirty');
    expect(dirtyReason({ unsubmitted: 0, failed: 0, unsavedTransient: 0 })).toBeNull();
    expect(dirtyReason({ unsubmitted: 1, failed: 0, unsavedTransient: 0 })).toMatch(/1 筆編輯還在送出/);
    expect(dirtyReason({ unsubmitted: 0, failed: 2, unsavedTransient: 0 })).toMatch(/2 筆編輯送出失敗/);
    expect(dirtyReason({ unsubmitted: 0, failed: 0, unsavedTransient: 1 })).toMatch(/1 組未保存的 plugin 結果/);
    const all = dirtyReason({ unsubmitted: 1, failed: 2, unsavedTransient: 3 })!;
    expect(all.indexOf('送出失敗')).toBeLessThan(all.indexOf('還在送出'));
    expect(all.split('；')).toHaveLength(3);
    expect(dirtyReason({ unsubmitted: 1, failed: 1, unsavedTransient: 0 })!.split('；')).toHaveLength(2);
    expect(dirtyReason({ unsubmitted: 1, failed: 0, unsavedTransient: 1 })!.split('；')).toHaveLength(2);
    expect(dirtyReason({ unsubmitted: 0, failed: 1, unsavedTransient: 1 })!.split('；')).toHaveLength(2);
    expect(isDirty({ unsubmitted: 0, failed: 0, unsavedTransient: 0 })).toBe(false);
    expect(leaveQuestion('1 筆編輯還在送出', '登出')).toBe('有 1 筆編輯還在送出。登出會丟掉這些內容。仍要登出？');
  });
});
