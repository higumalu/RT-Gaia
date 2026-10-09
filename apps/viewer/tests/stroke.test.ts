/**
 * 一筆筆畫的累積（一個 undo 區塊 = **一筆筆畫**，不是一個筆點）。
 */

import { describe, expect, it } from 'vitest';

import { StrokeAccumulator } from '../src/core/edit/stroke';

const b = (
  offset: readonly [number, number, number],
  size: readonly [number, number, number],
) => ({ offsetIjk: offset, sizeIjk: size });

/** 空白的 mask：沒有任何內容，所以新露出的格子填 0 是正確答案。 */
const emptyLive = (bounds: { sizeIjk: readonly [number, number, number] }): Uint8Array =>
  new Uint8Array(bounds.sizeIjk[0] * bounds.sizeIjk[1] * bounds.sizeIjk[2]);

/** 全滿的 mask：新露出的格子當前是 1。 */
const fullLive = (bounds: { sizeIjk: readonly [number, number, number] }): Uint8Array =>
  new Uint8Array(bounds.sizeIjk[0] * bounds.sizeIjk[1] * bounds.sizeIjk[2]).fill(1);

describe('單一筆點', () => {
  it('原樣回傳', () => {
    const acc = new StrokeAccumulator({
      bounds: b([3, 3, 1], [2, 1, 1]),
      before: new Uint8Array([0, 0]),
      after: new Uint8Array([1, 1]),
    });
    const r = acc.result();
    expect(r.bounds.offsetIjk).toEqual([3, 3, 1]);
    expect(r.dabs).toBe(1);
    expect([...r.before]).toEqual([0, 0]);
    expect([...r.after]).toEqual([1, 1]);
  });

  it('不複製輸入的 buffer 參考（之後改動輸入不得影響累積結果）', () => {
    const before = new Uint8Array([0, 0]);
    const acc = new StrokeAccumulator({
      bounds: b([0, 0, 0], [2, 1, 1]),
      before,
      after: new Uint8Array([1, 1]),
    });
    before[0] = 9;
    expect([...acc.result().before]).toEqual([0, 0]);
  });
});

describe('多個筆點併成一筆', () => {
  it('bbox 取聯集、dabs 累加', () => {
    const acc = new StrokeAccumulator({
      bounds: b([0, 0, 0], [1, 1, 1]),
      before: new Uint8Array([0]),
      after: new Uint8Array([1]),
    });
    acc.add({ bounds: b([4, 2, 0], [1, 1, 1]), before: new Uint8Array([0]), after: new Uint8Array([1]), readLive: emptyLive });
    const r = acc.result();
    expect(r.bounds.offsetIjk).toEqual([0, 0, 0]);
    expect(r.bounds.sizeIjk).toEqual([5, 3, 1]);
    expect(r.dabs).toBe(2);
  });

  it('往負方向長大時，既有內容留在同一個 mask grid 索引', () => {
    const acc = new StrokeAccumulator({
      bounds: b([5, 5, 2], [1, 1, 1]),
      before: new Uint8Array([0]),
      after: new Uint8Array([1]),
    });
    acc.add({ bounds: b([3, 4, 1], [1, 1, 1]), before: new Uint8Array([0]), after: new Uint8Array([1]), readLive: emptyLive });
    const r = acc.result();
    expect(r.bounds.offsetIjk).toEqual([3, 4, 1]);
    expect(r.bounds.sizeIjk).toEqual([3, 2, 2]);
    const at = (i: number, j: number, k: number, arr: Uint8Array): number => {
      const [w, h] = r.bounds.sizeIjk;
      const li = i - r.bounds.offsetIjk[0];
      const lj = j - r.bounds.offsetIjk[1];
      const lk = k - r.bounds.offsetIjk[2];
      return arr[(lk * h + lj) * w + li]!;
    };
    // 兩個筆點都在自己原本的全域索引上
    expect(at(5, 5, 2, r.after)).toBe(1);
    expect(at(3, 4, 1, r.after)).toBe(1);
    // 沒碰到的地方是 0
    expect(at(4, 4, 1, r.after)).toBe(0);
  });
});

describe('🔴 before 必須是「整筆下筆前」的狀態', () => {
  it('同一個體素被畫兩次，before 保留第一次的值', () => {
    const acc = new StrokeAccumulator({
      bounds: b([0, 0, 0], [1, 1, 1]),
      before: new Uint8Array([0]), // 下筆前是 0
      after: new Uint8Array([1]),
    });
    // 第二個筆點蓋到同一格：此時它看到的 before 已經是 1
    acc.add({ bounds: b([0, 0, 0], [1, 1, 1]), before: new Uint8Array([1]), after: new Uint8Array([1]), readLive: emptyLive });
    const r = acc.result();
    // 若讓第二筆覆寫 before，撤銷之後那格會留下 1 —— 撤銷不完全
    expect([...r.before]).toEqual([0]);
    expect([...r.after]).toEqual([1]);
  });

  it('🔴 橡皮擦：先擦成 0，第二個筆點不得把 before 也當成沒碰過', () => {
    // 這是 `touched` 位圖存在的唯一理由。若用「值是 0」代表沒碰過：
    // 第一筆把 before=1 記下、after=0；第二筆蓋到同一格時 before[dst] 是 1
    // （正確），但若判斷條件寫成 `if (this.before[dst] === 0)` 就會誤判成
    // 沒碰過，把 before 覆寫成第二筆看到的 0 —— 撤銷之後這格永久消失。
    const acc = new StrokeAccumulator({
      bounds: b([0, 0, 0], [1, 1, 1]),
      before: new Uint8Array([1]), // 原本有內容
      after: new Uint8Array([0]), // 擦掉
    });
    acc.add({ bounds: b([0, 0, 0], [1, 1, 1]), before: new Uint8Array([0]), after: new Uint8Array([0]), readLive: emptyLive });
    expect([...acc.result().before]).toEqual([1]);
  });

  it('🔴 長大之後新露出的格子仍算「沒碰過」，before 取該筆點的值', () => {
    const acc = new StrokeAccumulator({
      bounds: b([2, 0, 0], [1, 1, 1]),
      before: new Uint8Array([0]),
      after: new Uint8Array([1]),
    });
    // 新筆點涵蓋 [0..2]，其中 0、1 是新露出的，2 是已碰過的
    acc.add({
      bounds: b([0, 0, 0], [3, 1, 1]),
      before: new Uint8Array([1, 1, 1]), // 這三格下筆前都有內容
      after: new Uint8Array([0, 0, 0]),
      readLive: emptyLive,
    });
    const r = acc.result();
    expect(r.bounds.offsetIjk).toEqual([0, 0, 0]);
    // 索引 0、1 第一次碰到 → before 取 1
    expect(r.before[0]).toBe(1);
    expect(r.before[1]).toBe(1);
    // 索引 2 已碰過 → 保留最初的 0，不是這一筆看到的 1
    expect(r.before[2]).toBe(0);
    expect([...r.after]).toEqual([0, 0, 0]);
  });
});

describe('無效果的筆畫', () => {
  it('在已經是 1 的地方再畫一次 → isNoop', () => {
    const acc = new StrokeAccumulator({
      bounds: b([0, 0, 0], [2, 1, 1]),
      before: new Uint8Array([1, 1]),
      after: new Uint8Array([1, 1]),
    });
    expect(acc.isNoop()).toBe(true);
  });

  it('只要有一格不同就不是 noop', () => {
    const acc = new StrokeAccumulator({
      bounds: b([0, 0, 0], [2, 1, 1]),
      before: new Uint8Array([1, 1]),
      after: new Uint8Array([1, 1]),
    });
    acc.add({ bounds: b([5, 0, 0], [1, 1, 1]), before: new Uint8Array([0]), after: new Uint8Array([1]), readLive: emptyLive });
    expect(acc.isNoop()).toBe(false);
  });

  it('長大後新露出但沒碰到的格子 before === after，不會讓 noop 判斷失準', () => {
    const acc = new StrokeAccumulator({
      bounds: b([0, 0, 0], [1, 1, 1]),
      before: new Uint8Array([1]),
      after: new Uint8Array([1]),
    });
    acc.add({ bounds: b([9, 0, 0], [1, 1, 1]), before: new Uint8Array([1]), after: new Uint8Array([1]), readLive: emptyLive });
    expect(acc.result().bounds.sizeIjk).toEqual([10, 1, 1]);
    expect(acc.isNoop()).toBe(true);
  });
});

describe('🔴 空隙：筆點之間沒被碰到的格子', () => {
  it('新露出的格子用當前內容填，不是 0', () => {
    // 實測到的災難：跨過心臟畫兩個相隔的筆點，一次「復原」少掉 14 cc。
    // 原因是 undo 把 `before` **整塊**寫回 mask（`ViewerHost.applyEditOp`），
    // 而空隙格子的 before 是成長時填的 0 → 撤銷一筆順手擦掉中間那一整條。
    const acc = new StrokeAccumulator({
      bounds: b([0, 0, 0], [1, 1, 1]),
      before: new Uint8Array([0]),
      after: new Uint8Array([1]),
    });
    // 這個結構在空隙處是滿的（fullLive）
    acc.add({
      bounds: b([9, 0, 0], [1, 1, 1]),
      before: new Uint8Array([0]),
      after: new Uint8Array([1]),
      readLive: fullLive,
    });
    const r = acc.result();
    expect(r.bounds.sizeIjk).toEqual([10, 1, 1]);
    // 兩個筆點：before 0 → after 1
    expect(r.before[0]).toBe(0);
    expect(r.after[0]).toBe(1);
    expect(r.before[9]).toBe(0);
    expect(r.after[9]).toBe(1);
    // 🔴 中間 8 格沒被碰過 → before 與 after 都必須是當前值 1
    for (let i = 1; i <= 8; i += 1) {
      expect(r.before[i]).toBe(1);
      expect(r.after[i]).toBe(1);
    }
  });

  it('把 before 整塊寫回去，對空隙格子是 no-op', () => {
    const acc = new StrokeAccumulator({
      bounds: b([0, 0, 0], [1, 1, 1]),
      before: new Uint8Array([0]),
      after: new Uint8Array([1]),
    });
    acc.add({
      bounds: b([5, 0, 0], [1, 1, 1]),
      before: new Uint8Array([0]),
      after: new Uint8Array([1]),
      readLive: fullLive,
    });
    const r = acc.result();
    // 模擬 undo：整塊寫 before 回一個「當前」狀態
    const live = new Uint8Array(6).fill(1);
    live[0] = 1;
    live[5] = 1;
    live.set(r.before, 0);
    // 空隙仍然是 1，只有兩個筆點被還原成 0
    expect([...live]).toEqual([0, 1, 1, 1, 1, 0]);
  });

  it('readLive 回 null（mask 已不在倉裡）時退回填 0，不當掉', () => {
    const acc = new StrokeAccumulator({
      bounds: b([0, 0, 0], [1, 1, 1]),
      before: new Uint8Array([0]),
      after: new Uint8Array([1]),
    });
    expect(() =>
      acc.add({
        bounds: b([3, 0, 0], [1, 1, 1]),
        before: new Uint8Array([0]),
        after: new Uint8Array([1]),
        readLive: () => null,
      }),
    ).not.toThrow();
    expect(acc.result().bounds.sizeIjk).toEqual([4, 1, 1]);
  });
});

describe('一次拖曳的規模', () => {
  it('40 個筆點 → 一個 undo 區塊', () => {
    const acc = new StrokeAccumulator({
      bounds: b([0, 0, 3], [1, 1, 1]),
      before: new Uint8Array([0]),
      after: new Uint8Array([1]),
    });
    for (let n = 1; n < 40; n += 1) {
      acc.add({ bounds: b([n, 0, 3], [1, 1, 1]), before: new Uint8Array([0]), after: new Uint8Array([1]), readLive: emptyLive });
    }
    const r = acc.result();
    expect(r.dabs).toBe(40);
    expect(r.bounds.sizeIjk).toEqual([40, 1, 1]);
    expect([...r.after].filter((v) => v === 1)).toHaveLength(40);
    expect([...r.before].every((v) => v === 0)).toBe(true);
  });
});
