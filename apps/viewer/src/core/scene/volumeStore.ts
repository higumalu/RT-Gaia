/**
 * 已解碼體素的常駐倉。
 *
 * CPU 路徑沒有 texture，「常駐」就是**這裡的 TypedArray**。因此
 * mask 配額在每個 Tier 指的正是這個倉的大小。
 *
 * 🔴 **mask 存的是裁切後的區塊 ＋ 它自己的子網格**，不是全網格。
 * 85 個 ROI 在真實案例上裁切後是 20 MB；不裁切要 2 GB。
 */

import { indexToWorld, type Grid } from '../geometry';
import type { Int3 } from '../geometry';
import type { Layer } from '../layers/types';
import type { LayerVoxels } from '../raster/types';

export interface ImageEntry {
  readonly seriesId: string;
  readonly lod: number;
  /** 帶時間軸的序列是第幾個相位／時間點；靜態序列 null（或沒給）。 */
  readonly frameIndex?: number | null;
  readonly grid: Grid;
  /** 影像 int16（HU）；劑量 float32（Gy）。兩者都是 F1 純量場的實例。 */
  readonly voxels: Int16Array | Float32Array;
  readonly defaultWindow: { center: number; width: number };
}

/**
 * `Layer.kind` → 體素住在哪個倉。
 *
 * 🔴 這張表是**可註冊的**：劑量模組把 `'dose'` 登記成 `'volume'`，倉庫因此不必
 * 認識「劑量」這個字 —— 只認識「這種 kind 的體素長得像 volume 還是像 mask 區塊」。
 */
export type VoxelStorage = 'volume' | 'mask';

const storageByKind = new Map<string, VoxelStorage>([
  ['image', 'volume'],
  ['mask', 'mask'],
]);

export function registerVoxelStorage(kind: string, storage: VoxelStorage): void {
  storageByKind.set(kind, storage);
}

export function voxelStorageOf(kind: string): VoxelStorage | null {
  return storageByKind.get(kind) ?? null;
}

export interface MaskEntry {
  readonly structureId: string;
  readonly frameIndex: number | null;
  /**
   * bbox 區塊自己的網格：origin 在 bbox 起點、size 為 bbox 大小。
   *
   * 這讓重切核心可以**直接吃這個區塊**，不必先貼回全網格 —— 那是 20 MB 與
   * 2 GB 的差別。
   */
  readonly blockGrid: Grid;
  readonly offsetIjk: Int3;
  readonly sizeIjk: Int3;
  readonly voxels: Uint8Array;
  /** 後端給的 hash。**本地編輯不會改它**（要等 `POST /edit` 回來）。 */
  readonly contentHash: string;
  /**
   * 本地修訂號，每次編輯 +1。
   *
   * 🔴 重切核心以 key 快取已上傳的 volume。本地編輯後若 key 不變，核心會繼續
   * 用舊體素 —— 畫面上「筆刷沒有作用」。因此 key 必須帶這個號碼。
   */
  readonly revision: number;
}

/** 核心上傳快取的 key —— **必須含修訂號**（見 `MaskEntry.revision`）。 */
export function maskVolumeKey(entry: MaskEntry): string {
  return `mask:${entry.structureId}@${entry.frameIndex ?? 'static'}#${entry.revision}`;
}

/** 由 mask grid ＋ bbox 導出區塊自己的網格。 */
export function blockGridOf(maskGrid: Grid, offsetIjk: Int3, sizeIjk: Int3): Grid {
  return {
    size: sizeIjk,
    spacing: maskGrid.spacing,
    origin: indexToWorld(maskGrid, offsetIjk),
    direction: maskGrid.direction,
    frameOfReferenceUid: maskGrid.frameOfReferenceUid,
  };
}

/** 這一格鎖定的相位（時間群組 → 幀）；`undefined` ＝ 這個群組沒鎖，跟游標。 */
export type FrameOverride = (temporalGroupId: string) => number | undefined;

/** 影像體素的 key（也是重切核心的快取 key）：靜態序列 `s@lod0`；時間序列 `s@lod0#f3`。 */
export function imageVolumeKey(seriesId: string, lod: number, frameIndex: number | null = null): string {
  return frameIndex === null ? `${seriesId}@lod${lod}` : `${seriesId}@lod${lod}#f${frameIndex}`;
}

export class VolumeStore {
  private readonly images = new Map<string, ImageEntry>();
  private readonly masks = new Map<string, MaskEntry>();
  /**
   * 時間序列目前的相位（host 在游標改變時更新）。`image(seriesId)` 預設就取這個相位 ——
   * 讀數、統計、3D、重切都不必各自知道游標在哪。
   */
  private readonly seriesFrame = new Map<string, number>();
  private frameOfGroup: (temporalGroupId: string) => number = () => 0;

  private static imageKey(seriesId: string, lod: number, frameIndex: number | null = null): string {
    return imageVolumeKey(seriesId, lod, frameIndex);
  }

  /** 時間群組 → 目前相位（host 提供）。mask 與 `forLayer` 用它決定取哪一個相位。 */
  setFrameResolver(resolver: (temporalGroupId: string) => number): void {
    this.frameOfGroup = resolver;
  }

  /** 某個時間序列目前的相位（`null` ＝ 清掉 ＝ 靜態）。 */
  setSeriesFrame(seriesId: string, frameIndex: number | null): void {
    if (frameIndex === null) this.seriesFrame.delete(seriesId);
    else this.seriesFrame.set(seriesId, frameIndex);
  }

  /**
   * 這個 layer 現在該用哪一個相位：靜態 null；攤開的那一張固定看自己的幀；
   * 帶時間軸的取 `override`（這一格鎖定的相位）→ 沒有就所屬群組的游標。
   */
  frameOf(layer: Pick<Layer, 'temporalGroupId' | 'frameIndex'>, override?: FrameOverride): number | null {
    if (typeof layer.frameIndex === 'number') return layer.frameIndex;
    if (!layer.temporalGroupId) return null;
    return override?.(layer.temporalGroupId) ?? this.frameOfGroup(layer.temporalGroupId);
  }

  currentSeriesFrame(seriesId: string): number | null {
    return this.seriesFrame.get(seriesId) ?? null;
  }

  private static maskKey(structureId: string, frameIndex: number | null): string {
    return `${structureId}@${frameIndex ?? 'static'}`;
  }

  putImage(entry: ImageEntry): void {
    this.images.set(VolumeStore.imageKey(entry.seriesId, entry.lod, entry.frameIndex ?? null), entry);
  }

  /**
   * 某序列的體素：`lod` 沒有就退到較粗的（漸進式 lod）。時間序列預設取目前相位；
   * 那個相位還沒到 → 退到最近的已到相位（播放時畫面不空白；面板另外標「載入中」）。
   */
  image(seriesId: string, lod = 0, frameIndex: number | null = this.currentSeriesFrame(seriesId)): ImageEntry | undefined {
    const at = (f: number | null): ImageEntry | undefined =>
      this.images.get(VolumeStore.imageKey(seriesId, lod, f)) ??
      this.images.get(VolumeStore.imageKey(seriesId, 1, f)) ??
      this.images.get(VolumeStore.imageKey(seriesId, 2, f));
    const exact = at(frameIndex);
    if (exact !== undefined || frameIndex === null) return exact;
    const frames = this.residentFrames(seriesId).sort((a, b) => Math.abs(a - frameIndex) - Math.abs(b - frameIndex));
    for (const f of frames) {
      const near = at(f);
      if (near !== undefined) return near;
    }
    return at(null);
  }

  hasImage(seriesId: string): boolean {
    return this.image(seriesId) !== undefined;
  }

  /** 某個時間序列已經有體素（任何 lod，或指定 lod）的相位。 */
  residentFrames(seriesId: string, lod?: number): number[] {
    const out = new Set<number>();
    for (const e of this.images.values()) {
      if (e.seriesId === seriesId && e.frameIndex !== null && e.frameIndex !== undefined && (lod === undefined || e.lod === lod)) out.add(e.frameIndex);
    }
    return [...out].sort((a, b) => a - b);
  }

  putMask(entry: MaskEntry): void {
    this.masks.set(VolumeStore.maskKey(entry.structureId, entry.frameIndex), entry);
  }

  /**
   * 把一筆筆刷寫進 mask，**必要時把裁切區塊長大**。
   *
   * 這是編輯路徑最容易寫錯的一段：mask 一律裁切到 bbox，而筆畫可能
   * 落在 bbox 之外。做錯的兩種方式都不會報錯：
   *
   * 1. **不長大** → 超出 bbox 的部分被靜默丟掉（「筆刷在邊緣畫不上去」）
   * 2. **長大時複製錯位** → 既有內容整體位移（「畫一筆，整個結構跳掉」）
   *
   * 回傳 `before`／`after`（僅**筆畫覆蓋的那個子區塊**），供 `UndoStack` 使用
   * —— 不得對整個 volume 做快照。
   */
  applyMaskPatch(args: {
    structureId: string;
    frameIndex: number | null;
    /** mask grid 索引空間的原點。 */
    offsetIjk: Int3;
    sizeIjk: Int3;
    /** `(k, j, i)` uint8；1 = 寫入、0 = 清除。 */
    data: Uint8Array;
    /**
     * 這一筆實際作用到哪些格子（1 = 有）。不給則整塊寫入。
     *
     * 🔴 筆刷是球、區塊是外接方塊，球外的格子在 `data` 裡是 0。整塊寫入會擦掉
     * 方塊角落既有的內容（橡皮擦更是擦掉整個方塊而不是球）。詳見
     * `VoxelPatch.coverage`。undo／redo 寫回的是完整區塊，**不**帶 coverage。
     */
    coverage?: Uint8Array;
    /** mask grid 本身（長大後要重算 blockGrid）。 */
    maskGrid: Grid;
  }): { entry: MaskEntry; before: Uint8Array; after: Uint8Array; previousKey: string } | null {
    const key = VolumeStore.maskKey(args.structureId, args.frameIndex);
    const existing = this.masks.get(key);
    if (existing === undefined) return null;
    const previousKey = maskVolumeKey(existing);

    // 目標區塊 = 既有 bbox ∪ 筆畫 bbox
    const lo: Int3 = [0, 1, 2].map((i) =>
      Math.min(existing.offsetIjk[i]!, args.offsetIjk[i]!),
    ) as unknown as Int3;
    const hi: Int3 = [0, 1, 2].map((i) =>
      Math.max(
        existing.offsetIjk[i]! + existing.sizeIjk[i]!,
        args.offsetIjk[i]! + args.sizeIjk[i]!,
      ),
    ) as unknown as Int3;
    const size: Int3 = [hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]];

    const grew =
      lo[0] !== existing.offsetIjk[0] ||
      lo[1] !== existing.offsetIjk[1] ||
      lo[2] !== existing.offsetIjk[2] ||
      size[0] !== existing.sizeIjk[0] ||
      size[1] !== existing.sizeIjk[1] ||
      size[2] !== existing.sizeIjk[2];

    let voxels: Uint8Array;
    if (grew) {
      voxels = new Uint8Array(size[0] * size[1] * size[2]);
      // 把既有內容搬進新區塊。**索引平移必須用新舊 offset 的差**
      const d: Int3 = [
        existing.offsetIjk[0] - lo[0],
        existing.offsetIjk[1] - lo[1],
        existing.offsetIjk[2] - lo[2],
      ];
      for (let k = 0; k < existing.sizeIjk[2]; k += 1) {
        for (let j = 0; j < existing.sizeIjk[1]; j += 1) {
          const srcRow = (k * existing.sizeIjk[1] + j) * existing.sizeIjk[0];
          const dstRow = ((k + d[2]) * size[1] + (j + d[1])) * size[0] + d[0];
          voxels.set(existing.voxels.subarray(srcRow, srcRow + existing.sizeIjk[0]), dstRow);
        }
      }
    } else {
      voxels = new Uint8Array(existing.voxels);
    }

    // 記錄 before／after —— 只記**筆畫覆蓋的子區塊**
    const patchVoxels = args.sizeIjk[0] * args.sizeIjk[1] * args.sizeIjk[2];
    const before = new Uint8Array(patchVoxels);
    const after = new Uint8Array(patchVoxels);
    for (let k = 0; k < args.sizeIjk[2]; k += 1) {
      for (let j = 0; j < args.sizeIjk[1]; j += 1) {
        for (let i = 0; i < args.sizeIjk[0]; i += 1) {
          const patchIndex = (k * args.sizeIjk[1] + j) * args.sizeIjk[0] + i;
          const bi = args.offsetIjk[0] + i - lo[0];
          const bj = args.offsetIjk[1] + j - lo[1];
          const bk = args.offsetIjk[2] + k - lo[2];
          const blockIndex = (bk * size[1] + bj) * size[0] + bi;
          before[patchIndex] = voxels[blockIndex]!;
          if (args.coverage === undefined || args.coverage[patchIndex] !== 0) {
            voxels[blockIndex] = args.data[patchIndex]!;
          }
          // after 一律取**寫入之後的區塊值**：沒被覆蓋的格子因此 before === after
          after[patchIndex] = voxels[blockIndex]!;
        }
      }
    }

    const entry: MaskEntry = {
      structureId: existing.structureId,
      frameIndex: existing.frameIndex,
      blockGrid: blockGridOf(args.maskGrid, lo, size),
      offsetIjk: lo,
      sizeIjk: size,
      voxels,
      contentHash: existing.contentHash,
      revision: existing.revision + 1,
    };
    this.masks.set(key, entry);
    return { entry, before, after, previousKey };
  }

  /** 直接寫回一個子區塊（undo/redo 用；不改 bbox）。 */
  writeMaskBlock(args: {
    structureId: string;
    frameIndex: number | null;
    offsetIjk: Int3;
    sizeIjk: Int3;
    data: Uint8Array;
    maskGrid: Grid;
  }): MaskEntry | null {
    const result = this.applyMaskPatch(args);
    return result?.entry ?? null;
  }

  /**
   * 讀出 mask grid 索引空間中某個 bbox 的當前內容（區塊外視為 0）。
   *
   * 送出佇列用這個組出 patch：**本地編輯是立即套用的，所以本地內容就是想要的
   * 結果狀態**。這樣就不需要合併多筆 patch 的資料，也不會有「聯集 bbox 裡沒被
   * 任何一筆覆蓋到的體素被寫成 0」那個會在結構中間擦掉一條的問題。
   */
  readMaskBlock(args: {
    structureId: string;
    frameIndex: number | null;
    offsetIjk: readonly [number, number, number];
    sizeIjk: readonly [number, number, number];
  }): Uint8Array | null {
    const entry = this.masks.get(VolumeStore.maskKey(args.structureId, args.frameIndex));
    if (entry === undefined) return null;
    const [sw, sh, sd] = args.sizeIjk;
    const out = new Uint8Array(sw * sh * sd);
    for (let k = 0; k < sd; k += 1) {
      const bk = args.offsetIjk[2] + k - entry.offsetIjk[2];
      if (bk < 0 || bk >= entry.sizeIjk[2]) continue;
      for (let j = 0; j < sh; j += 1) {
        const bj = args.offsetIjk[1] + j - entry.offsetIjk[1];
        if (bj < 0 || bj >= entry.sizeIjk[1]) continue;
        for (let i = 0; i < sw; i += 1) {
          const bi = args.offsetIjk[0] + i - entry.offsetIjk[0];
          if (bi < 0 || bi >= entry.sizeIjk[0]) continue;
          out[(k * sh + j) * sw + i] =
            entry.voxels[(bk * entry.sizeIjk[1] + bj) * entry.sizeIjk[0] + bi]!;
        }
      }
    }
    return out;
  }

  mask(structureId: string, frameIndex: number | null = null): MaskEntry | undefined {
    return this.masks.get(VolumeStore.maskKey(structureId, frameIndex));
  }

  /**
   * 一個 layer 的體素 —— **`Layer.kind` → 倉庫位置的唯一對照點**。
   *
   * 🔴 這個對照本身是不可避免的（影像與 mask 真的存在不同的地方，而且 key
   * 的形狀不同），但它屬於**倉庫**，不屬於渲染迴圈。放在這裡之後：
   *
   * * `CpuViewportRenderer` 的每幀迴圈裡沒有任何 `kind === '...'`
   * * 新增一種 kind 要改的是倉庫與註冊表，不是渲染器
   *
   * 回傳的是 `LayerVoxels`（結構型契約），因此 `core/raster` 不必認識
   * `ImageEntry` / `MaskEntry`。
   */
  forLayer(layer: Layer, override?: FrameOverride): LayerVoxels | null {
    const storage = voxelStorageOf(layer.kind);
    if (storage === 'volume') {
      // 攤開的那一張、或這一格鎖定了相位 → 明確指定幀；其餘照舊（時間序列取倉庫記的目前相位）
      const pinned = typeof layer.frameIndex === 'number' || (override !== undefined && layer.temporalGroupId);
      const entry = pinned ? this.image(layer.contentRef, 0, this.frameOf(layer, override)) : this.image(layer.contentRef);
      if (entry === undefined) return null;
      return {
        voxels: entry.voxels,
        grid: entry.grid,
        volumeKey: imageVolumeKey(entry.seriesId, entry.lod, entry.frameIndex ?? null),
        defaultWindow: entry.defaultWindow,
      };
    }
    if (storage === 'mask') {
      const entry = this.mask(layer.contentRef, this.frameOf(layer, override));
      if (entry === undefined) return null;
      return {
        voxels: entry.voxels,
        // mask 的**區塊**直接餵給核心（不貼回全網格）
        grid: entry.blockGrid,
        volumeKey: maskVolumeKey(entry),
      };
    }
    return null;
  }

  /** 某個序列已常駐的 lod（由細到粗；時間序列看目前相位）。 */
  residentLods(seriesId: string, frameIndex: number | null = this.currentSeriesFrame(seriesId)): number[] {
    const out: number[] = [];
    for (const lod of [0, 1, 2]) {
      if (this.images.has(VolumeStore.imageKey(seriesId, lod, frameIndex))) out.push(lod);
    }
    return out;
  }

  hasImageLod(seriesId: string, lod: number, frameIndex: number | null = this.currentSeriesFrame(seriesId)): boolean {
    return this.images.has(VolumeStore.imageKey(seriesId, lod, frameIndex));
  }

  /**
   * 全解析度（lod 0）常駐上限。
   *
   * 隱藏的序列先逐出、可見的序列只在超過上限時才逐出（最早放進來的先走）；
   * 被逐出的序列**仍保留較粗的 lod**，因此重新顯示時立刻有畫面、背景再補 lod 0。
   * 回傳被逐出的 `volumeKey`（呼叫端要同時 `kernel.dropVolume()`）。
   *
   * 🔴 `VolumeStore` 先前完全不逐出，唯一生效的預算是 WASM 那 512 MB。
   */
  enforceFullResBudget(visibleSeriesIds: ReadonlySet<string>, maxFullRes: number, protectedSeriesIds: ReadonlySet<string> = new Set()): string[] {
    // 以**序列**計數 —— 時間序列的每一幀 lod 0 合算一個（4DCT 10 個相位的全解析度要能一起留著播放，
    // 以前每一幀各算一個，Tier A 的上限 4 一到就把其他相位逐出、播放時一直模糊）。時間序列的總量由呼叫端照位元組預算決定
    const fullRes = [...this.images.values()].filter((e) => e.lod === 0);
    const order: string[] = [];
    for (const e of fullRes) if (!order.includes(e.seriesId)) order.push(e.seriesId);
    if (order.length <= maxFullRes) return [];
    const dropped: string[] = [];
    let remaining = order.length;
    const drop = (seriesId: string): void => {
      for (const entry of fullRes) {
        if (entry.seriesId !== seriesId) continue;
        const key = VolumeStore.imageKey(entry.seriesId, 0, entry.frameIndex ?? null);
        if (!this.images.delete(key)) continue;
        dropped.push(key);
      }
      remaining -= 1;
    };
    // 1) 隱藏的先走（插入順序 = 最早載入的先走）
    for (const id of order) {
      if (remaining <= maxFullRes) break;
      if (!visibleSeriesIds.has(id)) drop(id);
    }
    // 2) 還超過就連可見的也逐出（保留最近放進來的）；看得見的時間序列（4D）最後才走 ——
    //    以前 4D 最早載入、第一個被逐出，打開 AVG／MIP／MinIP 之後 4D 只剩低解析度，要關掉別的影像才補得回來
    for (const id of order) {
      if (remaining <= maxFullRes) break;
      if (visibleSeriesIds.has(id) && !protectedSeriesIds.has(id) && this.hasImageLodAnyFrame(id, 0)) drop(id);
    }
    for (const id of order) {
      if (remaining <= maxFullRes) break;
      if (visibleSeriesIds.has(id) && protectedSeriesIds.has(id) && this.hasImageLodAnyFrame(id, 0)) drop(id);
    }
    return dropped;
  }

  /**
   * 放這個序列的 lod 0 進來，會不會逐出別的**可見**序列（`enforceFullResBudget` 先逐出隱藏的，所以只數可見的）。
   * 已經有任何一幀 lod 0 的序列再放別幀不增加計數。
   */
  canHoldFullRes(seriesId: string, visibleSeriesIds: ReadonlySet<string>, maxFullRes: number, protectedSeriesIds: ReadonlySet<string> = new Set()): boolean {
    if (this.hasImageLodAnyFrame(seriesId, 0)) return true;
    // 時間序列只跟其他時間序列搶位子（放進來會逐出的是靜態影像，不會互相逐出、一直重抓）
    const mine = protectedSeriesIds.has(seriesId);
    let holders = 0;
    for (const id of visibleSeriesIds) {
      if (id !== seriesId && this.hasImageLodAnyFrame(id, 0) && (!mine || protectedSeriesIds.has(id))) holders += 1;
    }
    return holders < maxFullRes;
  }

  /** 這個序列有沒有任何一幀（靜態序列就是它自己）的這個 lod 在倉裡。 */
  hasImageLodAnyFrame(seriesId: string, lod: number): boolean {
    for (const e of this.images.values()) if (e.seriesId === seriesId && e.lod === lod) return true;
    return false;
  }

  dropMask(structureId: string, frameIndex: number | null = null): number {
    const key = VolumeStore.maskKey(structureId, frameIndex);
    const bytes = this.masks.get(key)?.voxels.byteLength ?? 0;
    this.masks.delete(key);
    return bytes;
  }

  /** 丟某個 lod 的影像體素（使用者「卸載未顯示」）。回傳釋放的 bytes；沒有就 0。 */
  dropImage(seriesId: string, lod: number, frameIndex: number | null = this.currentSeriesFrame(seriesId)): number {
    const key = VolumeStore.imageKey(seriesId, lod, frameIndex);
    const bytes = this.images.get(key)?.voxels.byteLength ?? 0;
    this.images.delete(key);
    return bytes;
  }

  /** 目前常駐的位元組數 —— 直接對應記憶體配額。 */
  residentBytes(): { image: number; mask: number; total: number } {
    let image = 0;
    let mask = 0;
    for (const entry of this.images.values()) image += entry.voxels.byteLength;
    for (const entry of this.masks.values()) mask += entry.voxels.byteLength;
    return { image, mask, total: image + mask };
  }

  clear(): void {
    this.images.clear();
    this.masks.clear();
  }
}
