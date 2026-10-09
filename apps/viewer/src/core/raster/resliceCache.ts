/**
 * 重切結果快取。
 *
 * 2026-09-23 的 profile：全顯示 27 個結構的 5 秒卡頓裡，60% 是 `rt_reslice_u8`＋marching squares
 * （每個可見結構每格每幀重算一次輪廓）、35% 是 `rt_reslice_i16／f32`＋composite（影像與劑量每幀重切）——
 * 而這些輸入在「多一個 mask 進來」時**一個都沒變**。這裡把 `reslicePlane`／`maskOutline`／`windowToU8`
 * 的結果依完整輸入 key 快取；key 含 `volumeKey`（mask 的含修訂號、影像的含 lod），所以編輯過的 mask
 * 自然失效，不必另外通知。
 *
 * 記憶體：LRU，預設 96 MB（3 格 × 影像＋劑量 f32 平面 ≈ 15 MB，其餘給輪廓）。
 * 🔴 回傳的陣列是**共用**的：呼叫端只讀（`windowToU8`／`coverageFromPlane`／`paths.segments` 都只讀）。
 */

import type { MaskOutlineArgs, ReslicePlaneArgs, ResliceKernel } from './types';

export const DEFAULT_RESLICE_CACHE_BYTES = 96 * 1024 * 1024;

interface Entry {
  readonly value: Float32Array | Uint8Array;
  readonly bytes: number;
  readonly volumeKey: string;
}

function num(v: number): string {
  // 相機浮點在同一個位置會有 1e-12 級的抖動；輪廓／重切對 1e-6 mm 不敏感
  return (Math.round(v * 1e6) / 1e6).toString();
}

function viewKey(view: ReslicePlaneArgs['view']): string {
  return [
    ...view.planeOrigin.map(num),
    ...view.viewPlaneNormal.map(num),
    ...view.viewUp.map(num),
    num(view.slabThicknessMm),
    view.temporalGroupId ?? '',
    view.frameIndex ?? '',
  ].join(',');
}

export function planeCacheKey(args: ReslicePlaneArgs & { volumeKey: string }): string {
  return [
    'p',
    args.volumeKey,
    args.grid.size.join('x'),
    viewKey(args.view),
    args.outSizePx.join('x'),
    num(args.pxMm),
    args.blend ?? 'center',
    args.slabSamples ?? '',
    args.outside ?? '',
    (args as { compositeWindow?: readonly number[] }).compositeWindow?.join('/') ?? '',
  ].join('|');
}

export function outlineCacheKey(args: MaskOutlineArgs): string {
  return [
    'o',
    args.volumeKey,
    args.grid.size.join('x'),
    viewKey(args.view),
    args.outSizePx.join('x'),
    num(args.pxMm),
    args.level ?? '',
    args.maxSegments ?? '',
    args.blend ?? 'center',
    args.slabSamples ?? '',
  ].join('|');
}

export interface ResliceCacheStats {
  hits: number;
  misses: number;
  bytes: number;
  entries: number;
}

/**
 * 包住一個 `ResliceKernel`；介面相同，呼叫端（`cpuBackends`）不必知道有快取。
 * `windowToU8` 以平面陣列身分（WeakMap）＋ window 為 key —— 平面本身在快取裡時才命中，正好。
 */
export class CachingResliceKernel implements ResliceKernel {
  private readonly lru = new Map<string, Entry>();
  private readonly windows = new WeakMap<Float32Array, Map<string, Uint8Array>>();
  private bytes = 0;
  readonly stats: ResliceCacheStats = { hits: 0, misses: 0, bytes: 0, entries: 0 };

  constructor(
    private readonly inner: ResliceKernel,
    private readonly maxBytes: number = DEFAULT_RESLICE_CACHE_BYTES,
  ) {}

  get abiVersion(): number {
    return this.inner.abiVersion;
  }

  marchingSquares(field: Float32Array, w: number, h: number, level: number): Float32Array {
    return this.inner.marchingSquares(field, w, h, level);
  }

  stitch(segments: Float32Array): Float32Array[] {
    return this.inner.stitch(segments);
  }

  dispose(): void {
    this.clear();
    this.inner.dispose();
  }

  reslicePlane(args: ReslicePlaneArgs & { volumeKey: string }): Float32Array {
    const key = planeCacheKey(args);
    const hit = this.get(key);
    if (hit !== null) return hit as Float32Array;
    const plane = this.inner.reslicePlane(args);
    this.put(key, plane, args.volumeKey);
    return plane;
  }

  windowToU8(plane: Float32Array, center: number, width: number): Uint8Array {
    let perPlane = this.windows.get(plane);
    if (perPlane === undefined) {
      perPlane = new Map();
      this.windows.set(plane, perPlane);
    }
    const k = `${num(center)}/${num(width)}`;
    const hit = perPlane.get(k);
    if (hit !== undefined) {
      this.stats.hits += 1;
      return hit;
    }
    this.stats.misses += 1;
    const gray = this.inner.windowToU8(plane, center, width);
    // 同一個平面很少用超過兩三組 window（右鍵 WW/WL 拖曳例外 —— 那是 interactive 平面，平面本身會換）
    if (perPlane.size >= 4) perPlane.clear();
    perPlane.set(k, gray);
    return gray;
  }

  maskOutline(args: MaskOutlineArgs): Float32Array {
    const key = outlineCacheKey(args);
    const hit = this.get(key);
    if (hit !== null) return hit as Float32Array;
    const segments = this.inner.maskOutline(args);
    this.put(key, segments, args.volumeKey);
    return segments;
  }

  /** 把伺服器算好的高品質平面放進同一個 key（下一幀 `drawImage` 直接命中）。 */
  putPlane(key: string, plane: Float32Array, volumeKey: string): void {
    this.put(key, plane, volumeKey);
    this.hq.add(key);
  }

  /** 這個 key 目前是不是高品質（伺服器）的平面。 */
  isHighQuality(key: string): boolean {
    return this.hq.has(key) && this.lru.has(key);
  }

  private readonly hq = new Set<string>();

  /** 體積被逐出（`kernel.dropVolume`）或整個換掉時，把它的平面／輪廓一起丟。 */
  invalidateVolume(volumeKey: string): number {
    let dropped = 0;
    for (const [key, entry] of this.lru) {
      if (entry.volumeKey === volumeKey) {
        this.lru.delete(key);
        this.bytes -= entry.bytes;
        dropped += 1;
      }
    }
    this.sync();
    return dropped;
  }

  clear(): void {
    this.lru.clear();
    this.bytes = 0;
    this.sync();
  }

  private get(key: string): Float32Array | Uint8Array | null {
    const entry = this.lru.get(key);
    if (entry === undefined) {
      this.stats.misses += 1;
      return null;
    }
    // Map 的插入順序就是 LRU 順序：命中就搬到尾巴
    this.lru.delete(key);
    this.lru.set(key, entry);
    this.stats.hits += 1;
    return entry.value;
  }

  private put(key: string, value: Float32Array | Uint8Array, volumeKey: string): void {
    const bytes = value.byteLength;
    if (bytes > this.maxBytes) return; // 單筆就超過預算：不快取
    const existing = this.lru.get(key);
    if (existing !== undefined) {
      this.lru.delete(key);
      this.bytes -= existing.bytes;
    }
    this.lru.set(key, { value, bytes, volumeKey });
    this.bytes += bytes;
    while (this.bytes > this.maxBytes) {
      const oldest = this.lru.keys().next();
      if (oldest.done) break;
      const e = this.lru.get(oldest.value)!;
      this.lru.delete(oldest.value);
      this.bytes -= e.bytes;
    }
    this.sync();
  }

  private sync(): void {
    this.stats.bytes = this.bytes;
    this.stats.entries = this.lru.size;
  }
}
