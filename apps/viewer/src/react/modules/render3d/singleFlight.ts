/**
 * 「同時只飛一個、待送只留最新」。
 *
 * 2026-09-23 量到一次 40 步的拖曳送出 12 個 render3d、多個同時在飛：舊的回來被丟掉，但伺服器已經算過
 * （占掉 CPU 併發槽），在 CPU-only 或遠端瀏覽器上就是幾秒的排隊。這裡讓在飛的最多一個；拖曳中新的
 * 相機只覆寫「待送」槽，上一張回來才送最新那張。
 */
export class SingleFlight<T> {
  private inFlight: Promise<void> | null = null;
  private pending: (() => Promise<T>) | null = null;
  private pendingResolvers: { resolve: (v: T) => void; reject: (e: unknown) => void }[] = [];
  private dropped = 0;

  /** 目前有沒有在飛的請求。 */
  get busy(): boolean {
    return this.inFlight !== null;
  }

  /** 被最新請求蓋掉、從未送出的待送數（量測用）。 */
  get droppedCount(): number {
    return this.dropped;
  }

  /**
   * 排一個請求。沒有在飛就立刻送；有就放進待送槽（蓋掉舊的待送，舊待送的 promise 跟著最新那張一起 resolve）。
   * 回傳的 promise 在**這個相機或更新的相機**的結果回來時 resolve。
   */
  run(fn: () => Promise<T>): Promise<T> {
    if (this.inFlight === null) return this.launch(fn);
    if (this.pending !== null) this.dropped += 1;
    this.pending = fn;
    return new Promise<T>((resolve, reject) => this.pendingResolvers.push({ resolve, reject }));
  }

  private launch(fn: () => Promise<T>): Promise<T> {
    const p = fn();
    this.inFlight = p.then(
      () => undefined,
      () => undefined,
    );
    void this.inFlight.then(() => {
      this.inFlight = null;
      const next = this.pending;
      const waiters = this.pendingResolvers;
      this.pending = null;
      this.pendingResolvers = [];
      if (next === null) return;
      this.launch(next).then(
        (v) => waiters.forEach((w) => w.resolve(v)),
        (e: unknown) => waiters.forEach((w) => w.reject(e)),
      );
    });
    return p;
  }
}
