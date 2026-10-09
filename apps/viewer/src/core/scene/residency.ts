/**
 * GPU/CPU 常駐與 LRU 逐出。
 *
 * > 🔴 **`visible` 直接驅動 GPU 常駐：隱藏的 layer 其 texture 可被逐出。**
 * > 這是記憶體預算能成立的**唯一機制**——182 個結構 ＋ 2 組影像不可能
 * > 同時常駐。
 *
 * ## 記帳與逐出一律**按 handle**，不按 layer
 *
 * mask 的 outline handle 常駐約 0 bytes、fill handle 是數百 MB 的打包 texture。
 * 按 layer 記帳會把兩者算成同一筆，逐出機制就失去解析度。
 *
 * ## 最近 N 個隱藏的 layer 保留在 CPU 端
 *
 * 開關顯示是高頻操作；重新開關時不該重新下載。
 */

import type { LayerHandle } from '../raster/types';

/** handle 的鍵：`(viewportId, layerId, rendererId)`。 */
export type HandleKey = string;

const KEY_SEPARATOR = '|';

export function handleKey(viewportId: string, layerId: string, rendererId: string): HandleKey {
  return [viewportId, layerId, rendererId].join(KEY_SEPARATOR);
}

export function parseHandleKey(key: HandleKey): {
  viewportId: string;
  layerId: string;
  rendererId: string;
} {
  const [viewportId = '', layerId = '', rendererId = ''] = key.split(KEY_SEPARATOR);
  return { viewportId, layerId, rendererId };
}

export interface ResidencyEntry {
  readonly key: HandleKey;
  readonly handle: LayerHandle;
  /** 最後一次被使用（渲染或顯示切換）的邏輯時鐘。 */
  lastUsed: number;
  /** 目前是否可見。**不可見者才是逐出候選。** */
  visible: boolean;
}

export interface EvictionResult {
  evicted: HandleKey[];
  freedBytes: number;
  residentBytes: number;
  /** true = 已經逐出所有可逐出者，仍超過預算。**呼叫端必須降級或報錯。** */
  stillOverBudget: boolean;
}

export interface ResidencyOptions {
  /** 上限（byte）。取自 `tier/budget.ts`。 */
  budgetBytes: number;
  /** 最近幾個「隱藏但保留」的 handle 不逐出。 */
  keepHiddenCount?: number;
}

export class ResidencyManager {
  private readonly entries = new Map<HandleKey, ResidencyEntry>();
  private clock = 0;
  budgetBytes: number;
  keepHiddenCount: number;

  constructor(options: ResidencyOptions) {
    this.budgetBytes = options.budgetBytes;
    this.keepHiddenCount = options.keepHiddenCount ?? 8;
  }

  get size(): number {
    return this.entries.size;
  }

  add(handle: LayerHandle, visible: boolean): ResidencyEntry {
    const key = handleKey(handle.viewportId, handle.layerId, handle.rendererId);
    this.clock += 1;
    const entry: ResidencyEntry = { key, handle, lastUsed: this.clock, visible };
    this.entries.set(key, entry);
    return entry;
  }

  get(key: HandleKey): ResidencyEntry | undefined {
    return this.entries.get(key);
  }

  has(key: HandleKey): boolean {
    return this.entries.has(key);
  }

  keys(): HandleKey[] {
    return [...this.entries.keys()];
  }

  touch(key: HandleKey): void {
    const entry = this.entries.get(key);
    if (entry) {
      this.clock += 1;
      entry.lastUsed = this.clock;
    }
  }

  /** `visible` 改變即更新常駐狀態。隱藏不會立刻釋放，只是變成逐出候選。 */
  setVisible(key: HandleKey, visible: boolean): void {
    const entry = this.entries.get(key);
    if (!entry) return;
    entry.visible = visible;
    entry.handle.setVisible(visible);
    this.clock += 1;
    entry.lastUsed = this.clock;
  }

  remove(key: HandleKey): number {
    const entry = this.entries.get(key);
    if (!entry) return 0;
    const bytes = entry.handle.residentBytes();
    entry.handle.dispose();
    this.entries.delete(key);
    return bytes;
  }

  /** 目前總常駐位元組（**攤分後**，見 `LayerHandle.residentBytes`）。 */
  residentBytes(): number {
    let total = 0;
    for (const entry of this.entries.values()) total += entry.handle.residentBytes();
    return total;
  }

  /** 依 handle 列出常駐明細（狀態列與除錯用）。 */
  breakdown(): { key: HandleKey; rendererId: string; bytes: number; visible: boolean }[] {
    return [...this.entries.values()]
      .map((e) => ({
        key: e.key,
        rendererId: e.handle.rendererId,
        bytes: e.handle.residentBytes(),
        visible: e.visible,
      }))
      .sort((a, b) => b.bytes - a.bytes);
  }

  /**
   * 逐出到預算內。
   *
   * 順序：**不可見且不在保留窗內的，最舊的先逐出**。可見者永不逐出——
   * 逐出可見的 layer 會讓畫面少一層，那不是記憶體管理而是靜默的功能損失。
   */
  evictToBudget(): EvictionResult {
    const before = this.residentBytes();
    if (before <= this.budgetBytes) {
      return { evicted: [], freedBytes: 0, residentBytes: before, stillOverBudget: false };
    }
    const hidden = [...this.entries.values()]
      .filter((e) => !e.visible)
      .sort((a, b) => a.lastUsed - b.lastUsed);
    const keepFrom = Math.max(0, hidden.length - this.keepHiddenCount);
    const evicted: HandleKey[] = [];
    let freed = 0;

    // 第一輪：保留窗之外的隱藏 handle
    for (const entry of hidden.slice(0, keepFrom)) {
      if (this.residentBytes() <= this.budgetBytes) break;
      freed += this.remove(entry.key);
      evicted.push(entry.key);
    }
    // 第二輪：仍超標時連保留窗一起放掉（**仍不動可見的**）
    if (this.residentBytes() > this.budgetBytes) {
      for (const entry of hidden.slice(keepFrom)) {
        if (this.residentBytes() <= this.budgetBytes) break;
        freed += this.remove(entry.key);
        evicted.push(entry.key);
      }
    }
    const resident = this.residentBytes();
    return {
      evicted,
      freedBytes: freed,
      residentBytes: resident,
      stillOverBudget: resident > this.budgetBytes,
    };
  }

  disposeAll(): void {
    for (const entry of this.entries.values()) entry.handle.dispose();
    this.entries.clear();
  }
}
