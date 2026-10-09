/**
 * 每個結構一條送出佇列。
 *
 * ## 原設計有一個**必然發生**的缺陷
 *
 * > 前端不等回應就繼續畫，於是第二筆的 `base_content_hash` **必然是過期的**
 * > → 409 → 整份重取 → 清空 undo stack。**單人連續下筆就會觸發**，
 * > 而規格通篇把 409 描述成「被其他來源修改」——那是錯的，最常觸發它的是
 * > 使用者自己畫得快。
 *
 * ## 修正
 *
 * | 規則 | 說明 |
 * |---|---|
 * | **每個 `(structureId, frameIndex)` 同時最多一個 in-flight 請求** | 這是自我衝突不再發生的根本原因 |
 * | 佇列中待送的多筆 op **在送出前合併** | 子區塊取聯集，`after` 取最新值 |
 * | `baseContentHash` 取自**最後一次收到 200 的 hash** | 不是本地推測值 |
 * | `clientSeq` 單調遞增 | 網路重排的保險 |
 * | **409 因此只在真正的外部修改時發生** | 規格其餘處對 409 的描述現在才成立 |
 */

import { unionPatchBounds, type PatchBounds } from './brush';
import type { ViewReference } from '../geometry';
import { t } from '../i18n';

export type QueueKey = string;

export function queueKey(structureId: string, frameIndex: number | null): QueueKey {
  return `${structureId}@${frameIndex ?? 'static'}`;
}

/**
 * 送出的區塊：**整塊取代**（後端 `dense[block] = data`）。
 *
 * 刻意**不是** `VoxelPatch`：`VoxelPatch` 帶 `coverage`（筆刷是球、區塊是外接
 * 方塊），那是本地寫入才需要的概念。線路上的區塊已經是從本地 mask 讀出的完整
 * 內容，沒有「沒覆蓋到」的格子。
 */
export interface SubmitBlock {
  offsetIjk: readonly [number, number, number];
  sizeIjk: readonly [number, number, number];
  data: Uint8Array;
}

export interface SubmitRequest {
  structureId: string;
  frameIndex: number | null;
  maskGridId: string;
  baseContentHash: string;
  clientSeq: number;
  patch: SubmitBlock;
  viewReference: ViewReference;
}

export type SubmitResult =
  | { status: 'ok'; contentHash: string }
  | { status: 'conflict'; contentHash: string; reason: string }
  | { status: 'error'; message: string };

export type SubmitFn = (request: SubmitRequest) => Promise<SubmitResult>;

export interface ConflictInfo {
  structureId: string;
  frameIndex: number | null;
  /** 後端當前的 hash，前端據此重取。 */
  contentHash: string;
  reason: string;
  /** 被丟棄的待送 op 數（它們基於已分歧的狀態）。 */
  discarded: number;
}

/** 讀出本地 mask 在某個 bbox 的當前內容（`VolumeStore.readMaskBlock`）。 */
export type ReadBlockFn = (args: {
  structureId: string;
  frameIndex: number | null;
  offsetIjk: readonly [number, number, number];
  sizeIjk: readonly [number, number, number];
}) => Uint8Array | null;

export interface SubmitQueueOptions {
  submit: SubmitFn;
  /**
   * 送出前從本地 mask 讀出 patch 的資料。
   *
   * 🔴 佇列**只累積 bbox，不累積資料**。理由見 `unionPatchBounds` 的註解：
   * patch 語意是整塊取代，若把多筆的資料寫進聯集區塊、空隙留 0，就會在結構
   * 中間擦掉一條長方形而且完全不報錯。
   */
  readBlock: ReadBlockFn;
  /** 真衝突流程：重取整份 mask ＋ 清空該結構 undo ＋ UI 明示。 */
  onConflict: (info: ConflictInfo) => void;
  /**
   * 送出失敗且**重試用盡**時呼叫。
   *
   * 🔴 這不是「記一筆 log」——它是使用者唯一會知道「剛才那一筆沒有存到」的
   * 管道。少了它（先前 `ViewerHost` 建佇列時就沒有給），失敗的編輯完全無聲。
   */
  onError?: (message: string, request: SubmitRequest) => void;
  /**
   * 別人改過這個結構、本地要重抓。推送來的 `mask.updated` 在佇列忙的時候不能馬上重抓
   * （見 `remoteUpdate`），等這條佇列送完、確定那個 hash 不是自己的結果，才在這裡通知。
   */
  onRemoteChange?: (info: { structureId: string; frameIndex: number | null; contentHash: string }) => void;
  /** 重試上限。預設 `DEFAULT_MAX_RETRIES`。 */
  maxRetries?: number;
  /** 第 n 次重試前等多久（ms）。測試注入 0 用。 */
  retryDelayMs?: (attempt: number) => number;
}

/** 送出重試的預設上限（不含第一次嘗試）。 */
export const DEFAULT_MAX_RETRIES = 3;

/** 指數退避：250 / 500 / 1000 ms。 */
export function backoffMs(attempt: number): number {
  return 250 * 2 ** Math.max(0, attempt - 1);
}

/** 有編輯**沒有存到後端**的結構（UI 要據此明示，不得靜默）。 */
export interface QueueFailure {
  structureId: string;
  frameIndex: number | null;
  /** 還沒送出去的 bbox —— 使用者可以據此知道畫面上哪一塊是本地獨有的。 */
  pending: PatchBounds | null;
  retries: number;
}

interface QueueState {
  structureId: string;
  frameIndex: number | null;
  maskGridId: string;
  /** 最後一次收到 200 的 hash。**不是本地推測值。** */
  baseContentHash: string;
  /** 待送的 bbox（資料在 `pump()` 時才從本地 mask 讀出）。 */
  pending: PatchBounds | null;
  pendingView: ViewReference | null;
  inFlight: boolean;
  clientSeq: number;
  /** 統計：合併掉幾筆（驗證「連續筆畫因此常常一次送完」）。 */
  mergedCount: number;
  /** 這一批連續失敗幾次。成功或衝突時歸零。 */
  retries: number;
  /**
   * 重試已用盡，`pending` 是**沒存到後端的編輯**。
   *
   * 與 `isIdle()` 刻意分開：`isIdle()` 仍回報 false（資料真的還沒上去），
   * 而 `drain()` 靠這個旗標知道再等也沒用。
   */
  failed: boolean;
  /** 佇列忙的時候推來的別人（或還沒回應的自己）的 hash：送完後跟最後一次 200 比，不一樣才重抓。 */
  remoteHash: string | null;
}

export class SubmitQueue {
  private readonly queues = new Map<QueueKey, QueueState>();
  private readonly options: SubmitQueueOptions;
  private readonly maxRetries: number;

  constructor(options: SubmitQueueOptions) {
    this.options = options;
    this.maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
  }

  /** 註冊一個結構的初始 hash（由 `GET /mask` 取回時呼叫）。 */
  register(args: {
    structureId: string;
    frameIndex: number | null;
    maskGridId: string;
    contentHash: string;
  }): void {
    const key = queueKey(args.structureId, args.frameIndex);
    const existing = this.queues.get(key);
    if (existing) {
      existing.baseContentHash = args.contentHash;
      existing.maskGridId = args.maskGridId;
      return;
    }
    this.queues.set(key, {
      structureId: args.structureId,
      frameIndex: args.frameIndex,
      maskGridId: args.maskGridId,
      baseContentHash: args.contentHash,
      pending: null,
      pendingView: null,
      inFlight: false,
      clientSeq: 0,
      mergedCount: 0,
      retries: 0,
      failed: false,
      remoteHash: null,
    });
  }

  /** 這條佇列還有沒送完的編輯（飛行中或待送，含重試用盡的）。 */
  busy(structureId: string, frameIndex: number | null = null): boolean {
    const state = this.queues.get(queueKey(structureId, frameIndex));
    return state !== undefined && (state.inFlight || state.pending !== null);
  }

  /**
   * 推送來的 `mask.updated`：回傳要不要**現在**重抓。
   *
   * 🔴 佇列送出時才從本地 mask 讀資料（只累積 bbox）。以前收到推送就重抓、整份取代本地 ——
   * 自己上一筆的回音一到，還在等著送的下一筆就被後端舊版蓋掉，送出去的是沒有那一筆的內容，**無聲遺失**；
   * 重抓回來的舊 hash 也會把 base 退回去，下一筆變成假的 409。
   *
   * | 狀況 | 現在重抓？ |
   * |---|---|
   * | 本地沒有這個 mask | 是（照舊） |
   * | 佇列忙（飛行中、待送） | 否：記下 hash，送完再比（別人真的改過，自己下一筆會得到真的 409，照衝突流程重抓） |
   * | 閒著、hash ＝ 最後一次 200 | 否：自己那筆的回音 |
   * | 閒著、hash 不同 | 是：別人改的 |
   */
  remoteUpdate(structureId: string, frameIndex: number | null, contentHash: string): boolean {
    const state = this.queues.get(queueKey(structureId, frameIndex));
    if (state === undefined) return true;
    if (state.inFlight || state.pending !== null) {
      state.remoteHash = contentHash;
      return false;
    }
    return contentHash !== state.baseContentHash;
  }

  /** 佇列剛送完：忙的時候推來的 hash 不是最後一次 200 的結果 → 別人改過，通知重抓。 */
  private settle(state: QueueState): void {
    const remote = state.remoteHash;
    state.remoteHash = null;
    if (remote !== null && remote !== state.baseContentHash) {
      this.options.onRemoteChange?.({ structureId: state.structureId, frameIndex: state.frameIndex, contentHash: remote });
    }
  }

  /**
   * 排入一筆編輯。**本地已經套用過了**，這裡只管背景同步。
   *
   * 若已有 in-flight 請求，就與待送的合併（不發第二個請求）。
   */
  enqueue(args: {
    structureId: string;
    frameIndex: number | null;
    /** 只要 bbox；資料送出前才從本地 mask 讀。 */
    bounds: PatchBounds;
    viewReference: ViewReference;
  }): void {
    const key = queueKey(args.structureId, args.frameIndex);
    const state = this.queues.get(key);
    if (!state) {
      this.options.onError?.(
        t('結構 {structureId} 尚未 register，無法送出編輯（先取回 mask 取得 baseContentHash）', { structureId: args.structureId }),
        {
          structureId: args.structureId,
          frameIndex: args.frameIndex,
          maskGridId: '',
          baseContentHash: '',
          clientSeq: 0,
          patch: { ...args.bounds, data: new Uint8Array(0) },
          viewReference: args.viewReference,
        },
      );
      return;
    }
    if (state.pending === null) {
      state.pending = args.bounds;
    } else {
      state.pending = unionPatchBounds(state.pending, args.bounds);
      state.mergedCount += 1;
    }
    // `viewReference` 取最新那一筆：追溯要回答「最後一筆編輯在哪個平面」
    state.pendingView = args.viewReference;
    // 使用者又畫了一筆 = 再試一次的時機（網路可能已經回來了）
    if (state.failed) {
      state.failed = false;
      state.retries = 0;
    }
    void this.pump(state);
  }

  /**
   * 送出一批。**失敗時待送內容必須留在佇列裡。**
   *
   * 🔴 舊版在 `await` **之前**就把 `pending` 清成 null，於是任何送出失敗都讓
   * 那一筆編輯**永久且無聲地消失**：本地畫上去了、後端沒收到、沒有重試、
   * 沒有提示，而且 `baseContentHash` 沒推進所以後端也不會回 409。使用者要到
   * 匯出 RTSTRUCT 才會發現一段輪廓不見了。
   *
   * 現在的流程是「借出去、失敗就還回來」：
   *
   * | 結果 | `pending` | `baseContentHash` | 後續 |
   * |---|---|---|---|
   * | 200 | 維持（可能有飛行中新排入的） | 推進到後端值 | 立刻 `pump()` 下一批 |
   * | 409 | 丟棄（基於已分歧的狀態） | 推進到後端值 | 走 `onConflict` 重取流程 |
   * | 其他錯誤 | **還回去，與新排入的取聯集** | **不動** | 指數退避重試，超過上限才 `onError` |
   */
  private async pump(state: QueueState): Promise<void> {
    if (state.inFlight) return;
    const bounds = state.pending;
    const view = state.pendingView;
    if (bounds === null || view === null) return;
    // 資料在這一刻才讀：本地已套用的內容就是想要的結果狀態
    const data = this.options.readBlock({
      structureId: state.structureId,
      frameIndex: state.frameIndex,
      offsetIjk: bounds.offsetIjk,
      sizeIjk: bounds.sizeIjk,
    });
    if (data === null) {
      // 本地 mask 都不在了，重試也讀不到 —— 這一筆確實只能放棄，但要說出來
      state.pending = null;
      state.pendingView = null;
      state.failed = true;
      this.options.onError?.(
        t('結構 {structureId} 的本地 mask 已不在倉裡，無法組出 patch', { structureId: state.structureId }),
        {
          structureId: state.structureId,
          frameIndex: state.frameIndex,
          maskGridId: state.maskGridId,
          baseContentHash: state.baseContentHash,
          clientSeq: state.clientSeq,
          patch: { ...bounds, data: new Uint8Array(0) },
          viewReference: view,
        },
      );
      return;
    }
    const patch: SubmitBlock = { ...bounds, data };
    // 🔴 借出去：飛行期間 `pending` 清空，讓新的筆畫可以獨立累積；
    // 失敗時再把 `bounds` 與那些新的取聯集還回來。
    state.pending = null;
    state.pendingView = null;
    state.inFlight = true;
    state.clientSeq += 1;

    const request: SubmitRequest = {
      structureId: state.structureId,
      frameIndex: state.frameIndex,
      maskGridId: state.maskGridId,
      baseContentHash: state.baseContentHash,
      clientSeq: state.clientSeq,
      patch,
      viewReference: view,
    };

    let result: SubmitResult;
    try {
      result = await this.options.submit(request);
    } catch (error) {
      result = { status: 'error', message: error instanceof Error ? error.message : String(error) };
    }
    state.inFlight = false;

    if (result.status === 'ok') {
      state.baseContentHash = result.contentHash;
      state.retries = 0;
      state.failed = false;
      if (state.pending === null) this.settle(state);
      else void this.pump(state); // 佇列非空則送下一批
      return;
    }
    if (result.status === 'conflict') {
      // 真衝突：飛行中那一筆被後端拒絕，佇列中待送的也基於已分歧的狀態
      const discarded = 1 + (state.pending === null ? 0 : 1);
      state.pending = null;
      state.pendingView = null;
      state.baseContentHash = result.contentHash;
      state.retries = 0;
      state.failed = false;
      state.remoteHash = null; // 衝突流程本來就會重抓
      this.options.onConflict({
        structureId: state.structureId,
        frameIndex: state.frameIndex,
        contentHash: result.contentHash,
        reason: result.reason,
        discarded,
      });
      return;
    }

    // ── 錯誤：把 bbox 還回佇列 ────────────────────────────────────────────
    //
    // 飛行期間可能又排入了新的筆畫，因此是**取聯集**而不是覆寫：兩者都還沒
    // 送到後端，少了任何一邊都是靜默資料遺失。`pendingView` 取最新那一筆
    // （追溯要回答「最後一筆編輯在哪個平面」），沒有新的才退回原本這一筆。
    state.pending = state.pending === null ? bounds : unionPatchBounds(state.pending, bounds);
    state.pendingView = state.pendingView ?? view;
    state.retries += 1;

    if (state.retries > this.maxRetries) {
      // 🔴 **不清 `pending`**：資料還在，`isIdle()` 因此仍是 false，
      // 「關閉病例前要等佇列清空」那條檢查會攔住使用者，而不是讓他帶著
      // 沒存到的編輯離開。`failed` 只是讓 `drain()` 知道不必再等。
      state.failed = true;
      this.options.onError?.(
        t('結構 {structureId} 的編輯送出失敗 {retries} 次，這一筆沒有存到：{message}', { structureId: state.structureId, retries: state.retries, message: result.message }),
        request,
      );
      return;
    }

    // 指數退避後重試。
    // 🔴 舊版錯誤路徑**根本不呼叫 `pump()`**，因此即使 `pending` 沒被清掉，
    // 飛行期間排入的 bbox 也會卡到下一筆筆畫才被送出。
    await this.sleep(this.options.retryDelayMs?.(state.retries) ?? backoffMs(state.retries));
    void this.pump(state);
  }

  private sleep(ms: number): Promise<void> {
    return new Promise<void>((resolve) => {
      setTimeout(resolve, Math.max(0, ms));
    });
  }

  /** 目前是否有 in-flight 或待送（關閉病例前要等它清空）。 */
  isIdle(): boolean {
    for (const state of this.queues.values()) {
      if (state.inFlight || state.pending !== null) return false;
    }
    return true;
  }

  contentHash(structureId: string, frameIndex: number | null = null): string | null {
    return this.queues.get(queueKey(structureId, frameIndex))?.baseContentHash ?? null;
  }

  stats(structureId: string, frameIndex: number | null = null): {
    clientSeq: number;
    mergedCount: number;
    inFlight: boolean;
    hasPending: boolean;
  } | null {
    const state = this.queues.get(queueKey(structureId, frameIndex));
    if (!state) return null;
    return {
      clientSeq: state.clientSeq,
      mergedCount: state.mergedCount,
      inFlight: state.inFlight,
      hasPending: state.pending !== null,
    };
  }

  /**
   * 有編輯沒送到後端的結構（「UI 明示」需要這份清單）。
   *
   * 🔴 `isIdle()` 只回答是非題，UI 得說出**哪一個結構**沒存到。
   */
  failures(): QueueFailure[] {
    const out: QueueFailure[] = [];
    for (const state of this.queues.values()) {
      if (!state.failed) continue;
      out.push({
        structureId: state.structureId,
        frameIndex: state.frameIndex,
        pending: state.pending,
        retries: state.retries,
      });
    }
    return out;
  }

  /**
   * 重試用盡的那一筆**再送一次**（網路恢復、後端重啟之後）。資料還在本地 mask、
   * bbox 還在佇列，重試次數歸零照原本的流程送；這一條佇列沒有失敗 → false。
   */
  retry(structureId: string, frameIndex: number | null = null): boolean {
    const state = this.queues.get(queueKey(structureId, frameIndex));
    if (state === undefined || !state.failed || state.inFlight) return false;
    state.failed = false;
    state.retries = 0;
    void this.pump(state);
    return true;
  }

  /**
   * 放棄沒存到的那一筆 —— 清掉佇列裡的 bbox（呼叫端接著取回後端版本、清空這個結構的 undo）。
   * 只對重試用盡的佇列有效（還在送的不能丟，否則可能丟掉已經上去的那一半）；沒有失敗 → false。
   */
  discard(structureId: string, frameIndex: number | null = null): boolean {
    const state = this.queues.get(queueKey(structureId, frameIndex));
    if (state === undefined || !state.failed || state.inFlight) return false;
    state.pending = null;
    state.pendingView = null;
    state.failed = false;
    state.retries = 0;
    state.remoteHash = null; // 呼叫端接著重抓後端版本
    return true;
  }

  /**
   * 等到所有佇列清空（測試與「切換病例前」用）。
   *
   * 🔴 **重試用盡的佇列算「等完了」，但不算「清空了」。** 它的 `pending` 仍在
   * （那是沒存到的編輯），`isIdle()` 仍是 false；`drain()` 只是不再空等。
   * 呼叫端要在 `drain()` 之後檢查 `failures()`，否則就會把「送不出去」
   * 當成「送完了」——那正是這個 bug 原本的形狀。
   */
  async drain(): Promise<void> {
    // 每一輪讓已 resolve 的 promise 有機會推進佇列
    for (let guard = 0; guard < 10_000; guard += 1) {
      if (this.settled()) return;
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 0);
      });
    }
    throw new Error(t('送出佇列未在合理次數內清空'));
  }

  /** 每條佇列都已無事可做（清空了，或重試用盡）。 */
  private settled(): boolean {
    for (const state of this.queues.values()) {
      if (state.inFlight) return false;
      if (state.pending !== null && !state.failed) return false;
    }
    return true;
  }

  clear(): void {
    this.queues.clear();
  }
}
