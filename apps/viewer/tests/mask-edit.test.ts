/**
 * mask 的本地編輯。
 *
 * 🔴 **最容易寫錯的一段**：mask 一律裁切到 bbox，而筆畫可能落在 bbox 之外。
 * 兩種做錯的方式都**不會報錯**：
 *
 * 1. **不長大** → 超出 bbox 的部分被靜默丟掉（「筆刷在邊緣畫不上去」）
 * 2. **長大時複製錯位** → 既有內容整體位移（「畫一筆，整個結構跳掉」）
 */

import { describe, expect, it } from 'vitest';

import { createGrid, type Grid, type Int3 } from '../src/core/geometry';
import { blockGridOf, maskVolumeKey, VolumeStore, type MaskEntry } from '../src/core/scene/volumeStore';

const maskGrid: Grid = createGrid({
  size: [64, 64, 20],
  spacing: [1, 1, 3],
  origin: [-31.5, -31.5, -28.5],
  direction: [1, 0, 0, 0, 1, 0, 0, 0, 1],
  frameOfReferenceUid: 'for.mask',
});

/** 在 `offset` 放一個全為 1 的 `size` 區塊。 */
function seed(store: VolumeStore, offset: Int3, size: Int3, fill = 1): MaskEntry {
  const entry: MaskEntry = {
    structureId: 'gtv',
    frameIndex: null,
    blockGrid: blockGridOf(maskGrid, offset, size),
    offsetIjk: offset,
    sizeIjk: size,
    voxels: new Uint8Array(size[0] * size[1] * size[2]).fill(fill),
    contentHash: 'mh_seed',
    revision: 0,
  };
  store.putMask(entry);
  return entry;
}

/** 讀某個 mask grid 索引在區塊裡的值；落在區塊外回 0。 */
function valueAt(entry: MaskEntry, ijk: Int3): number {
  const [i, j, k] = [
    ijk[0] - entry.offsetIjk[0],
    ijk[1] - entry.offsetIjk[1],
    ijk[2] - entry.offsetIjk[2],
  ];
  if (i < 0 || j < 0 || k < 0) return 0;
  if (i >= entry.sizeIjk[0] || j >= entry.sizeIjk[1] || k >= entry.sizeIjk[2]) return 0;
  return entry.voxels[(k * entry.sizeIjk[1] + j) * entry.sizeIjk[0] + i]!;
}

describe('筆畫落在既有 bbox 內', () => {
  it('寫入生效，bbox 不變', () => {
    const store = new VolumeStore();
    seed(store, [10, 10, 5], [4, 4, 2], 0);
    const result = store.applyMaskPatch({
      structureId: 'gtv',
      frameIndex: null,
      offsetIjk: [11, 11, 5],
      sizeIjk: [2, 2, 1],
      data: new Uint8Array([1, 1, 1, 1]),
      maskGrid,
    });
    expect(result).not.toBeNull();
    const entry = result!.entry;
    expect(entry.offsetIjk).toEqual([10, 10, 5]);
    expect(entry.sizeIjk).toEqual([4, 4, 2]);
    expect(valueAt(entry, [11, 11, 5])).toBe(1);
    expect(valueAt(entry, [12, 12, 5])).toBe(1);
    expect(valueAt(entry, [10, 10, 5])).toBe(0);
  });

  it('before/after 只涵蓋筆畫的子區塊（不做整份快照）', () => {
    const store = new VolumeStore();
    seed(store, [10, 10, 5], [8, 8, 4], 0);
    const result = store.applyMaskPatch({
      structureId: 'gtv',
      frameIndex: null,
      offsetIjk: [11, 11, 5],
      sizeIjk: [2, 2, 1],
      data: new Uint8Array([1, 1, 1, 1]),
      maskGrid,
    })!;
    expect(result.before).toHaveLength(4);
    expect(result.after).toHaveLength(4);
    expect([...result.before]).toEqual([0, 0, 0, 0]);
    expect([...result.after]).toEqual([1, 1, 1, 1]);
    // 而不是整個區塊的 8×8×4 = 256
    expect(result.before.length).toBeLessThan(256);
  });
});

describe('🔴 筆畫超出既有 bbox：區塊必須長大', () => {
  it('往負方向超出 → offset 前移、size 變大', () => {
    const store = new VolumeStore();
    seed(store, [10, 10, 5], [4, 4, 2]);
    const entry = store.applyMaskPatch({
      structureId: 'gtv',
      frameIndex: null,
      offsetIjk: [7, 8, 4],
      sizeIjk: [2, 2, 1],
      data: new Uint8Array([1, 1, 1, 1]),
      maskGrid,
    })!.entry;
    expect(entry.offsetIjk).toEqual([7, 8, 4]);
    // 從 7 到 14（10+4）＝ 7；從 8 到 14 ＝ 6；從 4 到 7 ＝ 3
    expect(entry.sizeIjk).toEqual([7, 6, 3]);
  });

  it('往正方向超出 → offset 不變、size 變大', () => {
    const store = new VolumeStore();
    seed(store, [10, 10, 5], [4, 4, 2]);
    const entry = store.applyMaskPatch({
      structureId: 'gtv',
      frameIndex: null,
      offsetIjk: [13, 13, 6],
      sizeIjk: [3, 3, 2],
      data: new Uint8Array(18).fill(1),
      maskGrid,
    })!.entry;
    expect(entry.offsetIjk).toEqual([10, 10, 5]);
    expect(entry.sizeIjk).toEqual([6, 6, 3]);
  });

  it('🔴 長大之後既有內容必須留在**同一個 mask grid 索引上**（不得整體位移）', () => {
    const store = new VolumeStore();
    // 只在 (10,10,5) 這一個 voxel 放 1
    const size: Int3 = [4, 4, 2];
    const entry0: MaskEntry = {
      structureId: 'gtv',
      frameIndex: null,
      blockGrid: blockGridOf(maskGrid, [10, 10, 5], size),
      offsetIjk: [10, 10, 5],
      sizeIjk: size,
      voxels: new Uint8Array(32),
      contentHash: 'mh_seed',
      revision: 0,
    };
    entry0.voxels[0] = 1; // 區塊局部 (0,0,0) = 全域 (10,10,5)
    entry0.voxels[(1 * 4 + 2) * 4 + 3] = 1; // 局部 (3,2,1) = 全域 (13,12,6)
    store.putMask(entry0);

    const grown = store.applyMaskPatch({
      structureId: 'gtv',
      frameIndex: null,
      offsetIjk: [5, 6, 3],
      sizeIjk: [1, 1, 1],
      data: new Uint8Array([1]),
      maskGrid,
    })!.entry;

    expect(grown.offsetIjk).toEqual([5, 6, 3]);
    // 兩個原本的 1 必須還在原本的**全域**索引上
    expect(valueAt(grown, [10, 10, 5])).toBe(1);
    expect(valueAt(grown, [13, 12, 6])).toBe(1);
    // 新寫的那一點也在
    expect(valueAt(grown, [5, 6, 3])).toBe(1);
    // 而其他地方是 0（沒有被複製錯位而多出東西）
    let ones = 0;
    for (const v of grown.voxels) if (v !== 0) ones += 1;
    expect(ones).toBe(3);
  });

  it('長大後 blockGrid 的 origin 跟著移動（否則輪廓會畫錯位置）', () => {
    const store = new VolumeStore();
    seed(store, [10, 10, 5], [4, 4, 2]);
    const grown = store.applyMaskPatch({
      structureId: 'gtv',
      frameIndex: null,
      offsetIjk: [6, 6, 3],
      sizeIjk: [1, 1, 1],
      data: new Uint8Array([1]),
      maskGrid,
    })!.entry;
    const expected = blockGridOf(maskGrid, [6, 6, 3], grown.sizeIjk);
    expect(grown.blockGrid.origin).toEqual(expected.origin);
    expect(grown.blockGrid.size).toEqual(grown.sizeIjk);
  });
});

describe('🔴 修訂號：核心的上傳快取 key 必須改變', () => {
  it('每次編輯 revision +1，key 隨之改變', () => {
    const store = new VolumeStore();
    const seeded = seed(store, [10, 10, 5], [4, 4, 2], 0);
    const key0 = maskVolumeKey(seeded);
    const first = store.applyMaskPatch({
      structureId: 'gtv',
      frameIndex: null,
      offsetIjk: [11, 11, 5],
      sizeIjk: [1, 1, 1],
      data: new Uint8Array([1]),
      maskGrid,
    })!;
    expect(first.previousKey).toBe(key0);
    expect(first.entry.revision).toBe(1);
    expect(maskVolumeKey(first.entry)).not.toBe(key0);

    const second = store.applyMaskPatch({
      structureId: 'gtv',
      frameIndex: null,
      offsetIjk: [12, 11, 5],
      sizeIjk: [1, 1, 1],
      data: new Uint8Array([1]),
      maskGrid,
    })!;
    expect(second.entry.revision).toBe(2);
    expect(maskVolumeKey(second.entry)).not.toBe(maskVolumeKey(first.entry));
  });

  it('後端的 contentHash **不因本地編輯而改變**（要等 POST /edit 回來）', () => {
    const store = new VolumeStore();
    seed(store, [10, 10, 5], [4, 4, 2], 0);
    const result = store.applyMaskPatch({
      structureId: 'gtv',
      frameIndex: null,
      offsetIjk: [11, 11, 5],
      sizeIjk: [1, 1, 1],
      data: new Uint8Array([1]),
      maskGrid,
    })!;
    expect(result.entry.contentHash).toBe('mh_seed');
  });
});

describe('🔴 coverage：只寫球內，不寫外接方塊', () => {
  /** 一個「球」的 coverage：3×3×1 的方塊裡，只有十字（不含四角）被覆蓋。 */
  const crossCoverage = new Uint8Array([0, 1, 0, 1, 1, 1, 0, 1, 0]);

  it('筆刷：方塊四角既有的內容不得被擦掉', () => {
    const store = new VolumeStore();
    seed(store, [10, 10, 5], [5, 5, 1], 1); // 全部是 1
    const result = store.applyMaskPatch({
      structureId: 'gtv',
      frameIndex: null,
      offsetIjk: [11, 11, 5],
      sizeIjk: [3, 3, 1],
      data: new Uint8Array([0, 1, 0, 1, 1, 1, 0, 1, 0]),
      coverage: crossCoverage,
      maskGrid,
    })!;
    // 四角沒被覆蓋 → 保持原本的 1
    expect(valueAt(result.entry, [11, 11, 5])).toBe(1);
    expect(valueAt(result.entry, [13, 11, 5])).toBe(1);
    expect(valueAt(result.entry, [11, 13, 5])).toBe(1);
    expect(valueAt(result.entry, [13, 13, 5])).toBe(1);
    // 沒有任何格子變 0
    let ones = 0;
    for (const v of result.entry.voxels) if (v !== 0) ones += 1;
    expect(ones).toBe(25);
  });

  it('🔴 橡皮擦：擦掉的是球，不是整個方塊', () => {
    const store = new VolumeStore();
    seed(store, [10, 10, 5], [5, 5, 1], 1);
    const result = store.applyMaskPatch({
      structureId: 'gtv',
      frameIndex: null,
      offsetIjk: [11, 11, 5],
      sizeIjk: [3, 3, 1],
      data: new Uint8Array(9), // 橡皮擦：全 0
      coverage: crossCoverage,
      maskGrid,
    })!;
    // 十字被擦掉（5 格）、四角留著
    expect(valueAt(result.entry, [12, 12, 5])).toBe(0);
    expect(valueAt(result.entry, [11, 12, 5])).toBe(0);
    expect(valueAt(result.entry, [11, 11, 5])).toBe(1);
    expect(valueAt(result.entry, [13, 13, 5])).toBe(1);
    let ones = 0;
    for (const v of result.entry.voxels) if (v !== 0) ones += 1;
    expect(ones).toBe(20); // 25 − 5
  });

  it('沒被覆蓋的格子 before === after（undo 整塊寫回時是 no-op）', () => {
    const store = new VolumeStore();
    seed(store, [10, 10, 5], [5, 5, 1], 1);
    const result = store.applyMaskPatch({
      structureId: 'gtv',
      frameIndex: null,
      offsetIjk: [11, 11, 5],
      sizeIjk: [3, 3, 1],
      data: new Uint8Array(9),
      coverage: crossCoverage,
      maskGrid,
    })!;
    for (let i = 0; i < 9; i += 1) {
      if (crossCoverage[i] === 0) expect(result.before[i]).toBe(result.after[i]);
    }
    // 被覆蓋的確實變了
    expect(result.before[4]).toBe(1);
    expect(result.after[4]).toBe(0);
  });

  it('不給 coverage 時整塊寫入（undo／redo 的路徑）', () => {
    const store = new VolumeStore();
    seed(store, [10, 10, 5], [5, 5, 1], 1);
    const entry = store.writeMaskBlock({
      structureId: 'gtv',
      frameIndex: null,
      offsetIjk: [11, 11, 5],
      sizeIjk: [3, 3, 1],
      data: new Uint8Array(9),
      maskGrid,
    })!;
    // 整個 3×3 都被清掉
    expect(valueAt(entry, [11, 11, 5])).toBe(0);
    expect(valueAt(entry, [13, 13, 5])).toBe(0);
    let ones = 0;
    for (const v of entry.voxels) if (v !== 0) ones += 1;
    expect(ones).toBe(16); // 25 − 9
  });
});

describe('橡皮擦：寫 0', () => {
  it('清除既有內容，且 before 記下原本的 1', () => {
    const store = new VolumeStore();
    seed(store, [10, 10, 5], [4, 4, 2], 1);
    const result = store.applyMaskPatch({
      structureId: 'gtv',
      frameIndex: null,
      offsetIjk: [11, 11, 5],
      sizeIjk: [2, 2, 1],
      data: new Uint8Array(4), // 全 0
      maskGrid,
    })!;
    expect([...result.before]).toEqual([1, 1, 1, 1]);
    expect([...result.after]).toEqual([0, 0, 0, 0]);
    expect(valueAt(result.entry, [11, 11, 5])).toBe(0);
    expect(valueAt(result.entry, [10, 10, 5])).toBe(1);
  });
});

describe('undo/redo 的往返', () => {
  it('寫入 → 寫回 before → 內容回到原狀', () => {
    const store = new VolumeStore();
    seed(store, [10, 10, 5], [4, 4, 2], 0);
    const applied = store.applyMaskPatch({
      structureId: 'gtv',
      frameIndex: null,
      offsetIjk: [11, 11, 5],
      sizeIjk: [2, 2, 1],
      data: new Uint8Array([1, 1, 1, 1]),
      maskGrid,
    })!;
    expect(valueAt(applied.entry, [11, 11, 5])).toBe(1);

    const undone = store.writeMaskBlock({
      structureId: 'gtv',
      frameIndex: null,
      offsetIjk: [11, 11, 5],
      sizeIjk: [2, 2, 1],
      data: applied.before,
      maskGrid,
    })!;
    expect(valueAt(undone, [11, 11, 5])).toBe(0);
    let ones = 0;
    for (const v of undone.voxels) if (v !== 0) ones += 1;
    expect(ones).toBe(0);
  });

  it('undo 一筆長大過的編輯：bbox 不縮回去，但內容正確', () => {
    const store = new VolumeStore();
    seed(store, [10, 10, 5], [2, 2, 1], 1);
    const applied = store.applyMaskPatch({
      structureId: 'gtv',
      frameIndex: null,
      offsetIjk: [4, 4, 2],
      sizeIjk: [2, 2, 1],
      data: new Uint8Array([1, 1, 1, 1]),
      maskGrid,
    })!;
    const undone = store.writeMaskBlock({
      structureId: 'gtv',
      frameIndex: null,
      offsetIjk: [4, 4, 2],
      sizeIjk: [2, 2, 1],
      data: applied.before,
      maskGrid,
    })!;
    // bbox 留著（不縮回去是刻意的：縮回去要重新掃全區塊，而且下一筆很可能又長大）
    expect(undone.offsetIjk).toEqual([4, 4, 2]);
    // 但只有原本的 4 個 voxel 是 1
    let ones = 0;
    for (const v of undone.voxels) if (v !== 0) ones += 1;
    expect(ones).toBe(4);
    expect(valueAt(undone, [10, 10, 5])).toBe(1);
    expect(valueAt(undone, [4, 4, 2])).toBe(0);
  });
});

describe('沒有這個 mask 時不得靜默建立', () => {
  it('回傳 null 而不是憑空造一個區塊', () => {
    const store = new VolumeStore();
    const result = store.applyMaskPatch({
      structureId: 'never-loaded',
      frameIndex: null,
      offsetIjk: [0, 0, 0],
      sizeIjk: [1, 1, 1],
      data: new Uint8Array([1]),
      maskGrid,
    });
    expect(result).toBeNull();
  });
});

describe('常駐記帳', () => {
  it('編輯後 residentBytes 反映新的區塊大小', () => {
    const store = new VolumeStore();
    seed(store, [10, 10, 5], [4, 4, 2]);
    expect(store.residentBytes().mask).toBe(32);
    store.applyMaskPatch({
      structureId: 'gtv',
      frameIndex: null,
      offsetIjk: [4, 4, 2],
      sizeIjk: [1, 1, 1],
      data: new Uint8Array([1]),
      maskGrid,
    });
    // 從 (4,4,2) 到 (14,14,7) → 10×10×5 = 500
    expect(store.residentBytes().mask).toBe(500);
  });
});
