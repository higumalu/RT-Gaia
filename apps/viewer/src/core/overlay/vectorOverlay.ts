/**
 * 向量 overlay —— **唯讀大量向量走 canvas 2D、可互動者走 SVG**。
 *
 * ## 為什麼不是 SVG
 *
 * > 上一版寫「SVG polyline」，**量級已經不對了**。512² 平面上單一結構的輪廓
 * > 典型數百到數千點，20 結構含多連通分量 → **每幀數萬個座標**。而輪廓是
 * > **唯讀**的：沒有 hit-test、沒有 hover、沒有可拖曳控制點——**SVG 的 DOM
 * > 語意它一項都用不到，卻要每幀重建數萬字元的 `d` 字串讓瀏覽器重新解析。**
 *
 * canvas 2D 的 `stroke()` 一樣是向量、一樣只需要 `project()`、一樣兩條渲染路徑
 * 共用同一份實作，**「免費午餐」論證完全成立，而且沒有 DOM**。
 *
 * ## 實作規則（O1–O4）
 *
 * | # | 規則 |
 * |---|---|
 * | O1 | 預設 canvas 2D（`Path2D`，一結構一條路徑） |
 * | O2 | overlay 由 **`core/` 直接持有與更新**，`react/` 只給掛載容器（界線 3） |
 * | O3 | 座標寫進**重用的 `Float32Array`**；每幀不得配置新緩衝、不得組字串 |
 * | O4 | 以 canvas 2D 實作並實測，SVG 版本量一次作為對照 |
 */

import type { VectorPathSink, VectorStyle, Vec2 } from '../raster/types';
import { t } from '../i18n';

/**
 * 可重用的座標緩衝區（O3）。
 *
 * 🔴 **每幀數萬座標的 GC 壓力會表現成週期性掉幀**——那種症狀最難歸因，
 * 因為它不是「慢」，而是「偶爾卡一下」。因此緩衝區只長不縮。
 */
export class CoordinateBuffer {
  private buffer: Float32Array;
  private length = 0;
  /** 統計：重新配置了幾次。**穩定狀態下應該停止成長。** */
  readonly growthCount = { value: 0 };

  constructor(initialCapacity = 8192) {
    this.buffer = new Float32Array(initialCapacity);
  }

  reset(): void {
    this.length = 0;
  }

  reserve(floats: number): void {
    if (this.length + floats <= this.buffer.length) return;
    let capacity = this.buffer.length;
    while (capacity < this.length + floats) capacity *= 2;
    const next = new Float32Array(capacity);
    next.set(this.buffer.subarray(0, this.length));
    this.buffer = next;
    this.growthCount.value += 1;
  }

  push2(x: number, y: number): void {
    this.reserve(2);
    this.buffer[this.length] = x;
    this.buffer[this.length + 1] = y;
    this.length += 2;
  }

  /** **回傳的是視圖，不是複本**——呼叫端不得保留它跨幀。 */
  view(): Float32Array {
    return this.buffer.subarray(0, this.length);
  }

  get pointCount(): number {
    return this.length / 2;
  }

  get capacity(): number {
    return this.buffer.length;
  }
}

export interface CanvasLike {
  width: number;
  height: number;
  getContext(id: '2d'): CanvasRenderingContext2DLike | null;
}

/** canvas 2D 上下文的最小面（讓核心可在 Node 下測試）。 */
export interface CanvasRenderingContext2DLike {
  clearRect(x: number, y: number, w: number, h: number): void;
  beginPath(): void;
  moveTo(x: number, y: number): void;
  lineTo(x: number, y: number): void;
  closePath(): void;
  stroke(): void;
  setLineDash(segments: number[]): void;
  strokeStyle: string;
  lineWidth: number;
  lineJoin: CanvasLineJoin;
  lineCap: CanvasLineCap;
}

export interface DrawStats {
  sources: number;
  polylines: number;
  segments: number;
  points: number;
  /** 每幀是否配置了新緩衝（O3 的違反偵測）。 */
  bufferGrowths: number;
}

/**
 * canvas 2D 的 `VectorPathSink` 實作。
 *
 * 一個 sink 對應一個 canvas（一個 viewport 的 overlay 層）。
 */
export class CanvasPathSink implements VectorPathSink {
  private readonly ctx: CanvasRenderingContext2DLike;
  private readonly buffer = new CoordinateBuffer();
  private currentStyle: VectorStyle | null = null;
  private stats: DrawStats = { sources: 0, polylines: 0, segments: 0, points: 0, bufferGrowths: 0 };
  private growthAtFrameStart = 0;
  /** 平面像素 → canvas 像素。null = 兩者相同（`final` 品質）。 */
  private transform: PlaneToCanvas | null = null;

  constructor(
    private readonly canvas: CanvasLike,
    ctx?: CanvasRenderingContext2DLike,
  ) {
    const context = ctx ?? canvas.getContext('2d');
    if (context === null) throw new Error(t('無法取得 canvas 2D 上下文'));
    this.ctx = context;
  }

  /**
   * 設定平面像素 → canvas 像素的仿射變換。
   *
   * 🔴 **在座標上套用，不在 canvas context 上 `setTransform()`。**
   * context 的變換會**連線寬一起縮放**：互動態以 1/2 解析度重切時，1.5 px 的
   * 輪廓會變成 3 px，於是使用者看到的是「停下來的瞬間線條突然變細」。
   * 線寬是視覺定錨，忽粗忽細比「略粗糙」難用得多。
   *
   * 座標在 `polyline()` / `segments()` 的迴圈裡就地換算，**不配置任何緩衝**
   * （O3）。
   */
  setPlaneToCanvas(t: PlaneToCanvas | null): void {
    this.transform = t;
  }

  private tx(x: number): number {
    return this.transform === null ? x : x * this.transform.scale + this.transform.offsetX;
  }

  private ty(y: number): number {
    return this.transform === null ? y : y * this.transform.scale + this.transform.offsetY;
  }

  /** 一幀的開始。**清畫布並歸零統計。** */
  beginFrame(): void {
    this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    this.stats = { sources: 0, polylines: 0, segments: 0, points: 0, bufferGrowths: 0 };
    this.growthAtFrameStart = this.buffer.growthCount.value;
  }

  begin(_sourceId: string, style: VectorStyle): void {
    this.currentStyle = style;
    this.stats.sources += 1;
    const [r, g, b, a] = style.strokeRgba;
    this.ctx.strokeStyle = `rgba(${r},${g},${b},${a})`;
    this.ctx.lineWidth = style.lineWidthPx;
    this.ctx.lineJoin = 'round';
    this.ctx.lineCap = 'round';
    this.ctx.setLineDash(style.dash ?? []);
  }

  polyline(xy: Float32Array, pointCount: number, closed: boolean): void {
    if (pointCount < 2) return;
    this.ctx.beginPath();
    this.ctx.moveTo(this.tx(xy[0]!), this.ty(xy[1]!));
    for (let n = 1; n < pointCount; n += 1) {
      this.ctx.lineTo(this.tx(xy[n * 2]!), this.ty(xy[n * 2 + 1]!));
    }
    if (closed) this.ctx.closePath();
    this.ctx.stroke();
    this.stats.polylines += 1;
    this.stats.points += pointCount;
  }

  /**
   * segment soup（未縫合的輪廓）。
   *
   * marching squares 的原生輸出。只 `stroke()` 的話**不需要縫合**——縫合是
   * 需要虛線／線帽連續性時才付的成本（O1）。
   */
  segments(xy: Float32Array, segmentCount: number): void {
    if (segmentCount <= 0) return;
    this.ctx.beginPath();
    for (let s = 0; s < segmentCount; s += 1) {
      const o = s * 4;
      this.ctx.moveTo(this.tx(xy[o]!), this.ty(xy[o + 1]!));
      this.ctx.lineTo(this.tx(xy[o + 2]!), this.ty(xy[o + 3]!));
    }
    this.ctx.stroke();
    this.stats.segments += segmentCount;
    this.stats.points += segmentCount * 2;
  }

  end(): void {
    this.currentStyle = null;
  }

  endFrame(): DrawStats {
    this.stats.bufferGrowths = this.buffer.growthCount.value - this.growthAtFrameStart;
    return { ...this.stats };
  }

  /** 供 outline 重算時借用的座標緩衝（O3：不要自己 new）。 */
  scratch(): CoordinateBuffer {
    this.buffer.reset();
    return this.buffer;
  }

  lastStyle(): VectorStyle | null {
    return this.currentStyle;
  }
}

/**
 * 平面像素座標 → canvas 像素座標的仿射變換。
 *
 * 🔴 **Pan / Zoom 不會讓輪廓失效**：對既有 polyline 做 2D 仿射變換
 * 即可，**這是精確的，不是近似**——輪廓在世界空間沒有動。
 */
export interface PlaneToCanvas {
  scale: number;
  offsetX: number;
  offsetY: number;
}

export function applyPlaneToCanvas(t: PlaneToCanvas, planeXy: Float32Array, out: Float32Array): void {
  for (let n = 0; n < planeXy.length; n += 2) {
    out[n] = planeXy[n]! * t.scale + t.offsetX;
    out[n + 1] = planeXy[n + 1]! * t.scale + t.offsetY;
  }
}

export function projectPlanePoint(t: PlaneToCanvas, x: number, y: number): Vec2 {
  return { x: x * t.scale + t.offsetX, y: y * t.scale + t.offsetY };
}
