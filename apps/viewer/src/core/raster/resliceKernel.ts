/**
 * CPU 重切核心的 WASM 綁定。
 *
 * **與後端載入的是同一份 Rust 程式碼**（`packages/rtgaia-reslice`）：瀏覽器經
 * `WebAssembly.instantiate` 載入 `.wasm`，後端經 `ctypes` 載入 `.so`。兩個宿主
 * 看到同一組 `extern "C"` 符號，因此前後端重切的等效性是**由建構保證**。
 *
 * ## 為什麼是裸 wasm，不是 wasm-bindgen
 *
 * 核心的 API 只有「數值陣列進、數值陣列出」。裸 C ABI 讓建置只需 `cargo build`
 * （不需 wasm-pack／wasm-bindgen-cli／maturin），兩個宿主的函式簽章完全相同，
 * 且 SOUP 清單少三個相依。
 *
 * ## 🔴 結構佈局必須斷言
 *
 * `rt_struct_sizes()` 回報 Rust 端 `repr(C)` 的兩個結構大小。這裡與本檔的
 * 手寫偏移量比對——**一旦對不上，症狀是「取到別的欄位」：影像會歪掉但不會
 * 報錯**，那是最貴的一類 bug。
 */

import { ContractViolation, require_, type Grid, type ViewReference } from '../geometry';
import { planeRight, planeRowDirection } from '../geometry';
import { t } from '../i18n';

export const KERNEL_ABI_VERSION = 1;

/** `GridDesc` 的 `repr(C)` 佈局（u32[3] 後有 4 bytes 對齊填充）。 */
const GRID_DESC = {
  size: 0, // u32 × 3
  spacing: 16, // f64 × 3
  origin: 40, // f64 × 3
  direction: 64, // f64 × 9
  bytes: 136,
} as const;

/** `PlaneDesc` 的 `repr(C)` 佈局。 */
const PLANE_DESC = {
  origin: 0, // f64 × 3
  right: 24,
  up: 48,
  normal: 72,
  outW: 96, // u32
  outH: 100, // u32
  pxMm: 104, // f64
  slabMm: 112, // f64
  slabSamples: 120, // u32
  blend: 124, // u32
  outside: 128, // f32
  compositeWindow: 136, // f64 × 2
  bytes: 152,
} as const;

export const BLEND_CODE = { center: 0, mip: 1, mean: 2, composite: 3 } as const;
export type BlendMode = keyof typeof BLEND_CODE;

const ERR_NAMES: Record<number, string> = {
  [-1]: 'ERR_NULL',
  [-2]: 'ERR_LENGTH',
  [-3]: 'ERR_CAPACITY',
  [-4]: 'ERR_STITCH',
};

interface KernelExports {
  memory: WebAssembly.Memory;
  rt_version(): number;
  rt_struct_sizes(out: number): number;
  rt_alloc(size: number): number;
  rt_free(ptr: number, size: number): void;
  rt_reslice_i16(vol: number, volLen: number, grid: number, plane: number, out: number, outLen: number): number;
  rt_reslice_u8(vol: number, volLen: number, grid: number, plane: number, out: number, outLen: number): number;
  rt_reslice_f32(vol: number, volLen: number, grid: number, plane: number, out: number, outLen: number): number;
  rt_sample_world_i16(
    vol: number, volLen: number, grid: number,
    wx: number, wy: number, wz: number, outside: number, out: number,
  ): number;
  rt_window_to_u8(src: number, len: number, center: number, width: number, out: number): number;
  rt_gray_to_rgba(src: number, len: number, out: number): number;
  rt_composite_mask_rgba(
    rgba: number, mask: number, len: number,
    r: number, g: number, b: number, alpha: number, threshold: number,
  ): number;
  rt_marching_squares(field: number, w: number, h: number, level: number, out: number, outLen: number): number;
  rt_stitch_polylines(
    segments: number, segCount: number, outXy: number, outXyLen: number,
    outLens: number, outLensLen: number, counts: number,
  ): number;
  rt_mask_outline_u8(
    mask: number, maskLen: number, grid: number, plane: number, level: number,
    scratch: number, scratchLen: number, out: number, outLen: number,
  ): number;
}

/** 一塊 wasm 記憶體的租借。**用完必須 `free()`**（wasm 沒有 GC）。 */
class Scratch {
  constructor(
    private readonly exports: KernelExports,
    readonly ptr: number,
    readonly bytes: number,
  ) {}

  u8(): Uint8Array {
    return new Uint8Array(this.exports.memory.buffer, this.ptr, this.bytes);
  }

  f32(): Float32Array {
    return new Float32Array(this.exports.memory.buffer, this.ptr, this.bytes / 4);
  }

  u32(): Uint32Array {
    return new Uint32Array(this.exports.memory.buffer, this.ptr, this.bytes / 4);
  }

  free(): void {
    this.exports.rt_free(this.ptr, this.bytes);
  }
}

export interface ReslicePlaneOptions {
  volume: Int16Array | Uint8Array | Float32Array;
  grid: Grid;
  view: ViewReference;
  outSizePx: [number, number];
  pxMm: number;
  blend?: BlendMode;
  slabSamples?: number;
  outside?: number;
  compositeWindow?: [number, number];
}

/**
 * WASM 重切核心。
 *
 * **實例化一次、重複使用**：wasm 的 linear memory 會隨著配置成長，每次重新
 * 實例化都要重新上傳整個 volume。
 */
export class WasmResliceKernel {
  readonly abiVersion: number;
  private readonly exports: KernelExports;
  /**
   * 已上傳到 wasm linear memory 的 volume（**多槽 ＋ LRU**）。
   *
   * 🔴 **舊版只有一個槽。** 一幀裡先上傳影像（真實案例 46 MB）再上傳 N 個 mask
   * 區塊，於是下一幀影像又被逐出、又要重新上傳 —— 每幀多做 46 MB 的 memcpy。
   * 症狀不是報錯，是「編輯回饋和捲動都比預期慢」，而且先前的效能實測因此偏悲觀。
   *
   * 對應「volume 只存一份，workers 直接讀，零複製」意圖：
   * 上傳一次之後就重用，直到超出配額才 LRU 逐出。
   */
  private readonly volumes = new Map<
    string,
    { ptr: number; bytes: number; length: number; lastUsed: number }
  >();
  private uploadClock = 0;
  /**
   * wasm 端 volume 的常駐上限。
   *
   * 真實案例：影像 46 MB ＋ 85 個裁切 mask 共 20 MB。512 MB 讓 Tier C 的雙影像
   * （1.6 GB 系統 RAM 配額）也放得下，同時不會讓 wasm memory 無界成長。
   */
  private uploadBudgetBytes = 512 * 1024 * 1024;
  /** `maskOutline()` 的重用暫存平面。見該函式的說明。 */
  private scratchPlane: Scratch | null = null;

  private constructor(exports: KernelExports) {
    this.exports = exports;
    this.abiVersion = exports.rt_version();
  }

  static async instantiate(source: Response | ArrayBuffer | Uint8Array | WebAssembly.Module): Promise<WasmResliceKernel> {
    const instance =
      source instanceof WebAssembly.Module
        ? await WebAssembly.instantiate(source, {})
        : source instanceof Response
          ? (await WebAssembly.instantiateStreaming(source, {})).instance
          : (await WebAssembly.instantiate(source as ArrayBuffer, {})).instance;
    const exports = instance.exports as unknown as KernelExports;
    const kernel = new WasmResliceKernel(exports);
    kernel.assertAbi();
    return kernel;
  }

  /** 🔴 ABI 版本 ＋ 結構佈局的雙重斷言。載入後第一件事。 */
  private assertAbi(): void {
    if (this.abiVersion !== KERNEL_ABI_VERSION) {
      throw new ContractViolation('KRN1', t('重切核心 ABI 版本不符'), {
        got: this.abiVersion,
        expected: KERNEL_ABI_VERSION,
      });
    }
    const scratch = this.alloc(8);
    try {
      this.exports.rt_struct_sizes(scratch.ptr);
      const [gridBytes, planeBytes] = scratch.u32();
      require_(
        gridBytes === GRID_DESC.bytes && planeBytes === PLANE_DESC.bytes,
        'KRN2',
        t('結構佈局與 Rust 的 repr(C) 不符——會取到別的欄位而不報錯'),
        { rust: [gridBytes, planeBytes], typescript: [GRID_DESC.bytes, PLANE_DESC.bytes] },
      );
    } finally {
      scratch.free();
    }
  }

  private alloc(bytes: number): Scratch {
    const ptr = this.exports.rt_alloc(bytes);
    if (ptr === 0) throw new ContractViolation('KRN3', t('wasm 記憶體配置失敗'), { bytes });
    return new Scratch(this.exports, ptr, bytes);
  }

  private writeGridDesc(grid: Grid): Scratch {
    const scratch = this.alloc(GRID_DESC.bytes);
    const view = new DataView(this.exports.memory.buffer, scratch.ptr, GRID_DESC.bytes);
    for (let i = 0; i < 3; i += 1) {
      view.setUint32(GRID_DESC.size + i * 4, grid.size[i]!, true);
      view.setFloat64(GRID_DESC.spacing + i * 8, grid.spacing[i]!, true);
      view.setFloat64(GRID_DESC.origin + i * 8, grid.origin[i]!, true);
    }
    for (let i = 0; i < 9; i += 1) {
      view.setFloat64(GRID_DESC.direction + i * 8, grid.direction[i]!, true);
    }
    return scratch;
  }

  private writePlaneDesc(options: ReslicePlaneOptions): Scratch {
    const scratch = this.alloc(PLANE_DESC.bytes);
    const view = new DataView(this.exports.memory.buffer, scratch.ptr, PLANE_DESC.bytes);
    const right = planeRight(options.view);
    // 🔴 `up` 欄位是**輸出列增加的方向** = -viewUp（與 Python／Rust 同慣例）
    const rows = planeRowDirection(options.view);
    const normal = options.view.viewPlaneNormal;
    for (let i = 0; i < 3; i += 1) {
      view.setFloat64(PLANE_DESC.origin + i * 8, options.view.planeOrigin[i]!, true);
      view.setFloat64(PLANE_DESC.right + i * 8, right[i]!, true);
      view.setFloat64(PLANE_DESC.up + i * 8, rows[i]!, true);
      view.setFloat64(PLANE_DESC.normal + i * 8, normal[i]!, true);
    }
    const [w, h] = options.outSizePx;
    const blend = options.blend ?? 'center';
    const slabMm = options.view.slabThicknessMm;
    const samples =
      options.slabSamples ??
      (blend === 'center' || slabMm <= 0 ? 1 : Math.min(64, Math.max(2, Math.round(slabMm) + 1)));
    view.setUint32(PLANE_DESC.outW, w, true);
    view.setUint32(PLANE_DESC.outH, h, true);
    view.setFloat64(PLANE_DESC.pxMm, options.pxMm, true);
    view.setFloat64(PLANE_DESC.slabMm, slabMm, true);
    view.setUint32(PLANE_DESC.slabSamples, samples, true);
    view.setUint32(PLANE_DESC.blend, BLEND_CODE[blend], true);
    view.setFloat32(PLANE_DESC.outside, options.outside ?? -1024, true);
    const window = options.compositeWindow ?? [40, 400];
    view.setFloat64(PLANE_DESC.compositeWindow, window[0], true);
    view.setFloat64(PLANE_DESC.compositeWindow + 8, window[1], true);
    return scratch;
  }

  /**
   * 上傳 volume（多槽快取；同一個 key 只上傳一次）。
   *
   * 🔴 **key 必須在內容改變時改變。** 本地編輯後若沿用同一個 key，
   * 核心會繼續用舊的體素 —— 畫面看起來「筆刷沒有作用」。編輯路徑因此在 key
   * 裡帶一個修訂號（見 `VolumeStore` 的 `revision`）。
   */
  private uploadVolume(
    key: string,
    volume: Int16Array | Uint8Array | Float32Array,
  ): { ptr: number; length: number } {
    const cached = this.volumes.get(key);
    if (cached !== undefined) {
      this.uploadClock += 1;
      cached.lastUsed = this.uploadClock;
      return cached;
    }
    const bytes = volume.byteLength;
    this.evictUploadsFor(bytes);
    const ptr = this.exports.rt_alloc(bytes);
    if (ptr === 0) throw new ContractViolation('KRN3', t('wasm volume 配置失敗'), { bytes });
    new Uint8Array(this.exports.memory.buffer, ptr, bytes).set(
      new Uint8Array(volume.buffer, volume.byteOffset, bytes),
    );
    this.uploadClock += 1;
    const entry = { ptr, bytes, length: volume.length, lastUsed: this.uploadClock };
    this.volumes.set(key, entry);
    return entry;
  }

  /** 逐出最久未用的上傳，直到騰出 `needBytes`。 */
  private evictUploadsFor(needBytes: number): void {
    let resident = 0;
    for (const entry of this.volumes.values()) resident += entry.bytes;
    if (resident + needBytes <= this.uploadBudgetBytes) return;
    const ordered = [...this.volumes.entries()].sort((a, b) => a[1].lastUsed - b[1].lastUsed);
    for (const [key, entry] of ordered) {
      if (resident + needBytes <= this.uploadBudgetBytes) break;
      this.exports.rt_free(entry.ptr, entry.bytes);
      this.volumes.delete(key);
      resident -= entry.bytes;
    }
  }

  /** 明確丟掉一個上傳（本地編輯後舊修訂號的那一份）。 */
  dropVolume(key: string): boolean {
    const entry = this.volumes.get(key);
    if (entry === undefined) return false;
    this.exports.rt_free(entry.ptr, entry.bytes);
    this.volumes.delete(key);
    return true;
  }

  /** 目前上傳到 wasm 的位元組數與槽數（除錯與狀態列用）。 */
  uploadStats(): { count: number; bytes: number; budgetBytes: number } {
    let bytes = 0;
    for (const entry of this.volumes.values()) bytes += entry.bytes;
    return { count: this.volumes.size, bytes, budgetBytes: this.uploadBudgetBytes };
  }

  /** 任意平面（含斜面）重切，回傳 `(h × w)` 的 f32（**複本**，可安全保留）。 */
  reslicePlane(options: ReslicePlaneOptions & { volumeKey: string }): Float32Array {
    const [w, h] = options.outSizePx;
    const uploaded = this.uploadVolume(options.volumeKey, options.volume);
    const gridDesc = this.writeGridDesc(options.grid);
    const planeDesc = this.writePlaneDesc(options);
    const out = this.alloc(w * h * 4);
    try {
      const args = [
        uploaded.ptr,
        uploaded.length,
        gridDesc.ptr,
        planeDesc.ptr,
        out.ptr,
        w * h,
      ] as const;
      const rc =
        options.volume instanceof Int16Array
          ? this.exports.rt_reslice_i16(...args)
          : options.volume instanceof Uint8Array
            ? this.exports.rt_reslice_u8(...args)
            : this.exports.rt_reslice_f32(...args);
      this.check(rc);
      return new Float32Array(out.f32());
    } finally {
      out.free();
      planeDesc.free();
      gridDesc.free();
    }
  }

  /**
   * mask 區塊 → 輪廓 segment soup，**一次 FFI 呼叫**（`rt_mask_outline_u8`）。
   *
   * ## 為什麼要有這個而不是 `reslicePlane()` ＋ `marchingSquares()`
   *
   * 分兩步走的話，每一幀、每一個結構要付：
   *
   * | | 配置 | 複製 |
   * |---|---|---|
   * | `reslicePlane` 的 `out` | w·h·4 B | wasm → JS（`new Float32Array`） |
   * | `marchingSquares` 的 `src` | w·h·4 B | JS → wasm（`set()`） |
   *
   * 512² 平面就是每結構每幀約 4 MB 的 wasm 配置週轉，而中間那份 f32 平面
   * **從來沒有人看**——它只是餵給 marching squares 的。融合入口讓它留在 wasm
   * 裡：scratch 由這裡持有並重用，只有真正要用的 segment soup 會過境。
   *
   * `rt_mask_outline_u8` 這個入口**早就寫好了，只是兩個宿主都沒呼叫**。
   *
   * 🔴 只吃 `Uint8Array`（mask 一律是二值 u8）。
   */
  maskOutline(args: {
    mask: Uint8Array;
    volumeKey: string;
    grid: Grid;
    view: ViewReference;
    outSizePx: [number, number];
    pxMm: number;
    level?: number;
    maxSegments?: number;
    blend?: 'center' | 'mip';
    slabSamples?: number;
  }): Float32Array {
    const [w, h] = args.outSizePx;
    const maxSegments = args.maxSegments ?? 1 << 17;
    const uploaded = this.uploadVolume(args.volumeKey, args.mask);
    const gridDesc = this.writeGridDesc(args.grid);
    const blend = args.blend ?? 'center';
    const planeDesc = this.writePlaneDesc({
      volume: args.mask,
      grid: args.grid,
      view: args.view,
      outSizePx: args.outSizePx,
      pxMm: args.pxMm,
      // 語意 A（預設）取 slab 中心面；語意 B 用 `mip`：∪ᵢ{fᵢ ≥ 0.5} == {maxᵢ fᵢ ≥ 0.5}，
      // 逐像素 max 就是聯集，不需要多邊形布林（已實測）。
      // 🔴 絕不用 `mean`：半個體素厚的邊緣被平均掉，等值線往內縮 —— 畫面上只是「輪廓小一點」。
      blend,
      ...(args.slabSamples !== undefined ? { slabSamples: args.slabSamples } : {}),
      outside: 0,
    });
    const scratch = this.outlineScratch(w * h);
    const out = this.alloc(maxSegments * 4 * 4);
    try {
      const rc = this.exports.rt_mask_outline_u8(
        uploaded.ptr,
        uploaded.length,
        gridDesc.ptr,
        planeDesc.ptr,
        args.level ?? 0.5,
        scratch.ptr,
        w * h,
        out.ptr,
        maxSegments * 4,
      );
      this.check(rc);
      return new Float32Array(out.f32().subarray(0, rc * 4));
    } finally {
      out.free();
      planeDesc.free();
      gridDesc.free();
    }
  }

  /**
   * 融合輪廓路徑的 f32 暫存平面。**跨幀重用，只長不縮**（座標緩衝重用的精神）。
   *
   * 不重用的話這個函式就只是把兩次配置換成一次，省不到什麼。
   */
  private outlineScratch(floats: number): Scratch {
    const bytes = floats * 4;
    if (this.scratchPlane === null || this.scratchPlane.bytes < bytes) {
      this.scratchPlane?.free();
      this.scratchPlane = this.alloc(bytes);
    }
    return this.scratchPlane;
  }

  /** 單點取樣 —— 驗收用的工具。 */
  sampleWorldI16(args: {
    volume: Int16Array;
    volumeKey: string;
    grid: Grid;
    world: readonly [number, number, number];
    outside?: number;
  }): number {
    const uploaded = this.uploadVolume(args.volumeKey, args.volume);
    const gridDesc = this.writeGridDesc(args.grid);
    const out = this.alloc(4);
    try {
      const rc = this.exports.rt_sample_world_i16(
        uploaded.ptr,
        uploaded.length,
        gridDesc.ptr,
        args.world[0],
        args.world[1],
        args.world[2],
        args.outside ?? -1024,
        out.ptr,
      );
      this.check(rc);
      return out.f32()[0]!;
    } finally {
      out.free();
      gridDesc.free();
    }
  }

  /** WW/WL → 8-bit 灰階。 */
  windowToU8(plane: Float32Array, center: number, width: number): Uint8Array {
    const src = this.alloc(plane.byteLength);
    const dst = this.alloc(plane.length);
    try {
      src.f32().set(plane);
      this.check(this.exports.rt_window_to_u8(src.ptr, plane.length, center, width, dst.ptr));
      return new Uint8Array(dst.u8());
    } finally {
      dst.free();
      src.free();
    }
  }

  /**
   * 在取樣好的平面上求等值線。回傳 segment soup（每 4 個 float 一段）。
   *
   * **預設 mask 渲染路徑的關鍵路徑**：效能實測要量的就是這個函式。
   */
  marchingSquares(field: Float32Array, w: number, h: number, level = 0.5, maxSegments = 1 << 17): Float32Array {
    const src = this.alloc(field.byteLength);
    const out = this.alloc(maxSegments * 4 * 4);
    try {
      src.f32().set(field);
      const rc = this.exports.rt_marching_squares(src.ptr, w, h, level, out.ptr, maxSegments * 4);
      this.check(rc);
      return new Float32Array(out.f32().subarray(0, rc * 4));
    } finally {
      out.free();
      src.free();
    }
  }

  /** 把 segment soup 縫成 polyline 清單。**只 stroke() 的話不需要這一步。** */
  stitch(segments: Float32Array): Float32Array[] {
    const segCount = segments.length / 4;
    if (segCount === 0) return [];
    const src = this.alloc(segments.byteLength);
    const xy = this.alloc(Math.max(64, segCount * 4 * 4));
    const lens = this.alloc(Math.max(64, (segCount + 1) * 4));
    const counts = this.alloc(8);
    try {
      src.f32().set(segments);
      const rc = this.exports.rt_stitch_polylines(
        src.ptr,
        segCount,
        xy.ptr,
        xy.bytes / 4,
        lens.ptr,
        lens.bytes / 4,
        counts.ptr,
      );
      this.check(rc);
      const [pointCount, lineCount] = counts.u32();
      const allXy = xy.f32().subarray(0, pointCount! * 2);
      const allLens = lens.u32().subarray(0, lineCount);
      const out: Float32Array[] = [];
      let cursor = 0;
      for (let i = 0; i < lineCount!; i += 1) {
        const n = allLens[i]!;
        out.push(new Float32Array(allXy.subarray(cursor * 2, (cursor + n) * 2)));
        cursor += n;
      }
      return out;
    } finally {
      counts.free();
      lens.free();
      xy.free();
      src.free();
    }
  }

  private check(rc: number): void {
    if (rc < 0) {
      throw new ContractViolation('KRN4', t('重切核心回傳錯誤 {p0}', { p0: ERR_NAMES[rc] ?? rc }), { rc });
    }
  }


  /** wasm 線性記憶體目前大小（只會長不會縮；診斷面板顯示）。 */
  memoryBytes(): number {
    return this.exports.memory.buffer.byteLength;
  }

  dispose(): void {
    for (const entry of this.volumes.values()) this.exports.rt_free(entry.ptr, entry.bytes);
    this.volumes.clear();
    this.scratchPlane?.free();
    this.scratchPlane = null;
  }
}

/** 預設載入路徑（`scripts/build-kernel.sh` 會把 `.wasm` 複製到 `public/`）。 */
export const DEFAULT_WASM_URL = '/rtgaia_reslice.wasm';

/** 抓 wasm 的逾時（ms）與重試次數。 */
export const WASM_FETCH_TIMEOUT_MS = 15_000;
export const WASM_FETCH_ATTEMPTS = 3;

let compiled: Promise<WebAssembly.Module> | null = null;

async function compileOnce(url: string, fetcher: typeof fetch, timeoutMs: number): Promise<WebAssembly.Module> {
  let last: unknown = null;
  for (let attempt = 1; attempt <= WASM_FETCH_ATTEMPTS; attempt += 1) {
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), timeoutMs);
    try {
      const response = await fetcher(url, { signal: abort.signal });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return await WebAssembly.compile(await response.arrayBuffer());
    } catch (error) {
      last = error;
    } finally {
      clearTimeout(timer);
    }
  }
  throw new Error(t('重切核心（{url}）載入失敗：{reason}', { url, reason: last instanceof Error ? last.message : String(last) }));
}

/**
 * wasm **只抓、只編譯一次**（之後每個 host 只 instantiate 一份新的 memory）；抓檔有逾時與重試。
 *
 * 以前每換一次病例就重新 `fetch` ＋ `instantiateStreaming`，而且沒有逾時 —— 實測偶爾那個請求不回來（換病例後一張
 * canvas 都沒有、停在「載入中…」、也沒有任何錯誤，約 1／4 次）。現在失敗會變成錯誤訊息（`kernelError`），不會無聲卡住。
 */
export async function loadResliceKernel(
  url = DEFAULT_WASM_URL,
  fetcher: typeof fetch = (input, init) => fetch(input, init),
  timeoutMs = WASM_FETCH_TIMEOUT_MS,
): Promise<WasmResliceKernel> {
  compiled ??= compileOnce(url, fetcher, timeoutMs).catch((error: unknown) => {
    compiled = null; // 下次再試
    throw error;
  });
  return WasmResliceKernel.instantiate(await compiled);
}

/** 測試用：忘掉快取的模組。 */
export function resetKernelModuleCache(): void {
  compiled = null;
}
