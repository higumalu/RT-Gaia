/**
 * 有上限的抓取佇列。
 *
 * 全顯示 27 個結構＝ 27 個 `fetchMask` 同時發出、同時到齊、同時 `putMask`；瀏覽器把它們排在同一批
 * 事件裡處理，主執行緒一次卡 2 秒。限制同時在飛的數量，到齊的節奏就散開，`host.render()` 的
 * 合併才有幀可以插進去；同時有個進度可以給面板顯示。
 */

export const MASK_FETCH_CONCURRENCY = 4;

export interface FetchProgress {
  /** 這一輪已完成（含失敗） */
  readonly done: number;
  /** 這一輪總數；全部完成後回 `null`（面板據此收掉進度） */
  readonly total: number;
}

export class FetchQueue {
  private running = 0;
  private done = 0;
  private total = 0;
  private readonly waiting: (() => void)[] = [];

  constructor(
    private readonly concurrency: number,
    private readonly onProgress: (progress: FetchProgress | null) => void,
  ) {}

  /** 排進佇列；回傳的 promise 在 `task` 完成時 resolve（task 自己要把錯誤吞掉）。 */
  enqueue(task: () => Promise<void>): Promise<void> {
    this.total += 1;
    this.report();
    return new Promise<void>((resolve, reject) => {
      const start = (): void => {
        this.running += 1;
        const settle = (): void => {
          this.running -= 1;
          this.done += 1;
          if (this.done >= this.total) {
            // 一輪結束：歸零，下一次全顯示從 0／N 開始數
            this.done = 0;
            this.total = 0;
          }
          this.report();
          this.waiting.shift()?.();
        };
        task().then(
          () => {
            settle();
            resolve();
          },
          (error: unknown) => {
            settle();
            reject(error instanceof Error ? error : new Error(String(error)));
          },
        );
      };
      if (this.running < this.concurrency) start();
      else this.waiting.push(start);
    });
  }

  get pending(): number {
    return this.total - this.done;
  }

  private report(): void {
    this.onProgress(this.total === 0 ? null : { done: this.done, total: this.total });
  }
}
