/**
 * 一筆筆畫的累積。
 *
 * 一次拖曳會產生**幾十個筆點**。若每個筆點各記一筆 undo，使用者要按幾十次
 * 才能撤銷一筆——「一個 undo 區塊」指的是**一筆筆畫**，不是一個筆點。
 *
 * 這裡累積整筆的 `before`／`after` 子區塊：
 *
 * | 體素 | `before` | `after` |
 * |---|---|---|
 * | 這筆第一次碰到 | 該筆點的 before（＝下筆前的狀態） | 該筆點的 after |
 * | 這筆已經碰過 | **保留原本的**（仍是下筆前的狀態） | 更新為最新值 |
 *
 * 🔴 需要 `touched` 位圖才能分辨這兩種情況：`0` 是合法的體素值，不能用
 * 「值是 0」代表「還沒碰過」——否則橡皮擦擦過的地方會被當成沒碰過，
 * `before` 被後來的筆點覆寫成 0，撤銷之後那塊就永久消失了。
 */

import { unionPatchBounds, type PatchBounds } from './brush';

/**
 * 把一個區塊搬到更大的 bbox 裡。索引平移用**新舊 offset 的差**。
 *
 * `base` 是新區塊的底色（長度須等於 `to` 的體素數）。給 `null` 時填 0——
 * 🔴 **只有在「填 0 是正確答案」時才可以給 null**。見 `StrokeAccumulator.add()`。
 */
function growBlock(
  data: Uint8Array,
  from: PatchBounds,
  to: PatchBounds,
  base: Uint8Array | null,
): Uint8Array {
  const [tw, th, td] = to.sizeIjk;
  const out = base === null ? new Uint8Array(tw * th * td) : new Uint8Array(base);
  const d = [
    from.offsetIjk[0] - to.offsetIjk[0],
    from.offsetIjk[1] - to.offsetIjk[1],
    from.offsetIjk[2] - to.offsetIjk[2],
  ];
  const [fw, fh, fd] = from.sizeIjk;
  for (let k = 0; k < fd; k += 1) {
    for (let j = 0; j < fh; j += 1) {
      const src = (k * fh + j) * fw;
      const dst = ((k + d[2]!) * th + (j + d[1]!)) * tw + d[0]!;
      out.set(data.subarray(src, src + fw), dst);
    }
  }
  return out;
}

function sameBounds(a: PatchBounds, b: PatchBounds): boolean {
  return (
    a.offsetIjk[0] === b.offsetIjk[0] &&
    a.offsetIjk[1] === b.offsetIjk[1] &&
    a.offsetIjk[2] === b.offsetIjk[2] &&
    a.sizeIjk[0] === b.sizeIjk[0] &&
    a.sizeIjk[1] === b.sizeIjk[1] &&
    a.sizeIjk[2] === b.sizeIjk[2]
  );
}

export class StrokeAccumulator {
  private bounds: PatchBounds;
  private before: Uint8Array;
  private after: Uint8Array;
  private touched: Uint8Array;
  private dabs = 0;

  constructor(args: { bounds: PatchBounds; before: Uint8Array; after: Uint8Array }) {
    this.bounds = args.bounds;
    this.before = new Uint8Array(args.before);
    this.after = new Uint8Array(args.after);
    this.touched = new Uint8Array(args.before.length).fill(1);
    this.dabs = 1;
  }

  /**
   * 併入一個筆點。
   *
   * `readLive` 讀出**本地 mask 當前**在某個 bbox 的內容。
   *
   * 🔴 **bbox 長大時新露出的格子必須用當前內容填，不能填 0。**
   * 一筆筆畫的兩個筆點若相隔一段距離，聯集 bbox 會涵蓋**沒有任何筆點碰過**的
   * 格子。`before`／`after` 在那些格子填 0，而 undo 是把 `before` **整塊寫回
   * 去**（`ViewerHost.applyEditOp`）→ 撤銷一筆會順手擦掉筆點之間那一整條。
   * 實測：跨過心臟畫兩個筆點，一次復原就少掉 14 cc，而且沒有任何錯誤訊息。
   *
   * 這些格子在整筆過程中沒被改過，所以「當前內容」同時就是它們正確的
   * `before` 與 `after`——填進去之後 undo 的整塊寫回就成了對它們的 no-op。
   */
  add(args: {
    bounds: PatchBounds;
    before: Uint8Array;
    after: Uint8Array;
    readLive: (bounds: PatchBounds) => Uint8Array | null;
  }): void {
    const next = unionPatchBounds(this.bounds, args.bounds);
    if (!sameBounds(next, this.bounds)) {
      const live = args.readLive(next);
      this.before = growBlock(this.before, this.bounds, next, live);
      this.after = growBlock(this.after, this.bounds, next, live);
      // touched 是「before 已經是下筆前的值」的標記，新格子一律 0
      this.touched = growBlock(this.touched, this.bounds, next, null);
      this.bounds = next;
    }
    const [pw, ph, pd] = args.bounds.sizeIjk;
    const [w, h] = this.bounds.sizeIjk;
    for (let k = 0; k < pd; k += 1) {
      const bk = args.bounds.offsetIjk[2] + k - this.bounds.offsetIjk[2];
      for (let j = 0; j < ph; j += 1) {
        const bj = args.bounds.offsetIjk[1] + j - this.bounds.offsetIjk[1];
        for (let i = 0; i < pw; i += 1) {
          const bi = args.bounds.offsetIjk[0] + i - this.bounds.offsetIjk[0];
          const src = (k * ph + j) * pw + i;
          const dst = (bk * h + bj) * w + bi;
          if (this.touched[dst] === 0) {
            this.before[dst] = args.before[src]!;
            this.touched[dst] = 1;
          }
          this.after[dst] = args.after[src]!;
        }
      }
    }
    this.dabs += 1;
  }

  /** 整筆的 undo 區塊。 */
  result(): { bounds: PatchBounds; before: Uint8Array; after: Uint8Array; dabs: number } {
    return {
      bounds: this.bounds,
      before: this.before,
      after: this.after,
      dabs: this.dabs,
    };
  }

  /**
   * 這一筆是否真的改變了什麼。
   *
   * 全部 before === after 的筆畫（例如在已經是 1 的地方再畫一次）不該進 undo
   * stack，也不該送出——否則「復原」會消耗一格卻什麼都沒變。
   */
  isNoop(): boolean {
    for (let i = 0; i < this.before.length; i += 1) {
      if (this.before[i] !== this.after[i]) return false;
    }
    return true;
  }
}
