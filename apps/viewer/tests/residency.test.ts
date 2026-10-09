/**
 * LRU 常駐與逐出。
 *
 * > **這是記憶體預算能成立的唯一機制。**
 */

import { afterEach, describe, expect, it } from 'vitest';

import {
  clearSharedResources,
  handleKey,
  makeStubHandle,
  parseHandleKey,
  ResidencyManager,
  sharedResourceCount,
} from '../src/core';

afterEach(() => clearSharedResources());

const MB = 1_000_000;

describe('記帳按 handle，不按 layer', () => {
  it('同一個 layer 的 outline 與 fill handle 各自記帳', () => {
    const outline = makeStubHandle({
      viewportId: 'axial',
      layerId: 'mask:gtv',
      rendererId: 'mask-outline',
      ownBytes: 0, // outline 的 GPU 常駐 ≈ 0
    });
    const fill = makeStubHandle({
      viewportId: 'axial',
      layerId: 'mask:gtv',
      rendererId: 'mask-fill',
      resource: { key: 'pack:0', bytes: 236 * MB },
    });
    expect(outline.residentBytes()).toBe(0);
    expect(fill.residentBytes()).toBe(236 * MB);
    // 按 layer 記帳會把兩者算成同一筆，逐出機制就失去解析度
    expect(handleKey('axial', 'mask:gtv', 'mask-outline')).not.toBe(
      handleKey('axial', 'mask:gtv', 'mask-fill'),
    );
  });

  it('handle 鍵是三元組，且可解析回來', () => {
    const key = handleKey('coronal', 'image:ct', 'image');
    expect(parseHandleKey(key)).toEqual({
      viewportId: 'coronal',
      layerId: 'image:ct',
      rendererId: 'image',
    });
  });
});

describe('共用資源一律回報攤分值', () => {
  it('跨 viewport 共用：四格版面不得把記憶體算成 4 倍', () => {
    const handles = ['axial', 'coronal', 'sagittal', 'volume3d'].map((vp) =>
      makeStubHandle({
        viewportId: vp,
        layerId: 'image:ct',
        rendererId: 'image',
        resource: { key: 'volume:ct', bytes: 400 * MB },
      }),
    );
    const total = handles.reduce((acc, h) => acc + h.residentBytes(), 0);
    expect(sharedResourceCount()).toBe(1);
    // 攤分：4 × (400/4) = 400 MB，不是 1600 MB
    expect(total).toBe(400 * MB);
  });

  it('跨結構共用：一張 pack texture 最多 8 個結構，不得高估 8 倍', () => {
    const handles = Array.from({ length: 8 }, (_, n) =>
      makeStubHandle({
        viewportId: 'axial',
        layerId: `mask:s${n}`,
        rendererId: 'mask-fill',
        resource: { key: 'pack:0', bytes: 78.6 * MB },
      }),
    );
    const total = handles.reduce((acc, h) => acc + h.residentBytes(), 0);
    expect(Math.round(total / MB)).toBe(79);
  });

  it('釋放最後一個 ref 才真正 free', () => {
    const a = makeStubHandle({
      viewportId: 'axial',
      layerId: 'l',
      rendererId: 'image',
      resource: { key: 'volume:x', bytes: 100 * MB },
    });
    const b = makeStubHandle({
      viewportId: 'coronal',
      layerId: 'l',
      rendererId: 'image',
      resource: { key: 'volume:x', bytes: 100 * MB },
    });
    expect(sharedResourceCount()).toBe(1);
    a.dispose();
    expect(sharedResourceCount()).toBe(1);
    // 剩下一個 ref → 回報整份大小
    expect(b.residentBytes()).toBe(100 * MB);
    b.dispose();
    expect(sharedResourceCount()).toBe(0);
    expect(b.residentBytes()).toBe(0);
  });
});

describe('visible 直接驅動常駐', () => {
  function setup(budgetMb: number, keepHidden = 0): ResidencyManager {
    return new ResidencyManager({ budgetBytes: budgetMb * MB, keepHiddenCount: keepHidden });
  }

  it('未超預算時不逐出任何東西', () => {
    const rm = setup(1000);
    rm.add(
      makeStubHandle({ viewportId: 'a', layerId: 'l1', rendererId: 'image', ownBytes: 100 * MB }),
      true,
    );
    const result = rm.evictToBudget();
    expect(result.evicted).toEqual([]);
    expect(result.stillOverBudget).toBe(false);
  });

  it('只逐出不可見的，最舊的先走', () => {
    const rm = setup(250);
    for (const [id, visible] of [
      ['l1', false],
      ['l2', false],
      ['l3', true],
    ] as const) {
      rm.add(
        makeStubHandle({ viewportId: 'a', layerId: id, rendererId: 'image', ownBytes: 100 * MB }),
        visible,
      );
    }
    const result = rm.evictToBudget();
    expect(result.evicted).toEqual([handleKey('a', 'l1', 'image')]);
    expect(rm.residentBytes()).toBe(200 * MB);
  });

  it('🔴 可見的 layer 永不逐出（逐出它是靜默的功能損失，不是記憶體管理）', () => {
    const rm = setup(50);
    for (const id of ['l1', 'l2', 'l3']) {
      rm.add(
        makeStubHandle({ viewportId: 'a', layerId: id, rendererId: 'image', ownBytes: 100 * MB }),
        true,
      );
    }
    const result = rm.evictToBudget();
    expect(result.evicted).toEqual([]);
    // 仍超標必須明確回報，讓呼叫端降 lod 或減少可見結構
    expect(result.stillOverBudget).toBe(true);
  });

  it('隱藏一個 layer 就讓它變成逐出候選', () => {
    const rm = setup(150);
    for (const id of ['l1', 'l2']) {
      rm.add(
        makeStubHandle({ viewportId: 'a', layerId: id, rendererId: 'image', ownBytes: 100 * MB }),
        true,
      );
    }
    expect(rm.evictToBudget().evicted).toEqual([]);
    rm.setVisible(handleKey('a', 'l1', 'image'), false);
    expect(rm.evictToBudget().evicted).toEqual([handleKey('a', 'l1', 'image')]);
  });
});

describe('最近 N 個隱藏的保留在 CPU 端', () => {
  it('保留窗內的隱藏 handle 優先不逐出（開關顯示是高頻操作）', () => {
    const rm = new ResidencyManager({ budgetBytes: 250 * MB, keepHiddenCount: 2 });
    for (const id of ['l1', 'l2', 'l3', 'l4']) {
      rm.add(
        makeStubHandle({ viewportId: 'a', layerId: id, rendererId: 'image', ownBytes: 100 * MB }),
        false,
      );
    }
    const result = rm.evictToBudget();
    // 4 個隱藏、保留 2 個 → 最舊的 2 個中逐出到符合預算為止
    expect(result.evicted).toEqual([handleKey('a', 'l1', 'image'), handleKey('a', 'l2', 'image')]);
    expect(rm.residentBytes()).toBe(200 * MB);
  });

  it('保留窗不足時，第二輪會連保留窗一起放掉（但仍不動可見的）', () => {
    const rm = new ResidencyManager({ budgetBytes: 100 * MB, keepHiddenCount: 8 });
    for (const id of ['l1', 'l2', 'l3']) {
      rm.add(
        makeStubHandle({ viewportId: 'a', layerId: id, rendererId: 'image', ownBytes: 100 * MB }),
        false,
      );
    }
    rm.add(
      makeStubHandle({ viewportId: 'a', layerId: 'visible', rendererId: 'image', ownBytes: 100 * MB }),
      true,
    );
    const result = rm.evictToBudget();
    expect(result.evicted).toHaveLength(3);
    expect(rm.residentBytes()).toBe(100 * MB);
    expect(result.stillOverBudget).toBe(false);
  });

  it('touch 更新使用時間，因此剛用過的不會先被逐出', () => {
    const rm = new ResidencyManager({ budgetBytes: 150 * MB, keepHiddenCount: 0 });
    for (const id of ['l1', 'l2']) {
      rm.add(
        makeStubHandle({ viewportId: 'a', layerId: id, rendererId: 'image', ownBytes: 100 * MB }),
        false,
      );
    }
    rm.touch(handleKey('a', 'l1', 'image'));
    expect(rm.evictToBudget().evicted).toEqual([handleKey('a', 'l2', 'image')]);
  });
});

describe('常駐明細（狀態列與除錯）', () => {
  it('依大小排序，且標明 renderer 與可見性', () => {
    const rm = new ResidencyManager({ budgetBytes: 10_000 * MB });
    rm.add(
      makeStubHandle({ viewportId: 'a', layerId: 'mask:gtv', rendererId: 'mask-outline', ownBytes: 0 }),
      true,
    );
    rm.add(
      makeStubHandle({ viewportId: 'a', layerId: 'image:ct', rendererId: 'image', ownBytes: 400 * MB }),
      true,
    );
    const breakdown = rm.breakdown();
    expect(breakdown[0]!.rendererId).toBe('image');
    expect(breakdown[1]!.bytes).toBe(0);
  });
});
