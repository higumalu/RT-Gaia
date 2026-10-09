/**
 * `CpuViewportRenderer` —— **Tier C 的主線光柵化**。
 *
 * > **主線走瀏覽器端 CPU**：延遲 8–20 ms、斷線後仍可操作、而且**編輯回饋必須
 * > 在本機即時完成**。做了這些，CPU 路徑其實已經完成大半。
 *
 * ## 這個類別做的事
 *
 * ```
 * volume(Int16Array) ──WASM 三線性取樣──▶ f32 平面 ──window LUT──▶ u8 ──▶ ImageData
 * mask 區塊(Uint8Array) ──WASM 取樣──▶ f32 場 ──marching squares──▶ segments ──▶ canvas 2D 描邊
 * ```
 *
 * **兩者用同一個 `ViewReference`、同一份 WASM 核心**，因此影像與輪廓天生對齊
 * ——不需要任何「把 mask 對到影像網格」的步驟（網格解耦就是為了這個）。
 *
 * ## 界線
 *
 * 🔴 **canvas 節點由這裡建立與更新，`react/` 只提供掛載容器。**
 * outline 每幀承載數萬座標；走 React state 重繪在 60 fps 下不可能。
 *
 * ## 兩態品質
 *
 * `interactive` 以 `INTERACTIVE_SCALE` 降解析度重切（成本平方下降），畫上去時
 * 放大；`final` 全解析度。輪廓的座標同步乘回去，因此**互動中輪廓的幾何位置
 * 仍然正確**，只是略粗糙。
 */

import type { FrameGroup, Grid, GridSet, TemporalGroup, Vec3, ViewReference } from '../geometry';
import { primaryFrameGroupOf } from '../geometry';
import type { Layer } from '../layers/types';
import type { OverlayPaintContext, ViewportOverlayRegistry } from '../overlay/overlayRegistry';
import { CanvasPathSink, type CanvasRenderingContext2DLike } from '../overlay/vectorOverlay';
import { planCpuFrame } from '../raster/framePlan';
import type { ResliceKernel } from '../raster/types';
import type { CpuContext, Quality, Tier, Vec2, ViewportInfo } from '../raster/types';
import { fitPxMm, planePxToWorld, worldToPlanePx } from './cameras';
import type { FrameOverride, VolumeStore } from './volumeStore';
import type { ViewportRenderer } from './ViewportRenderer';
import { t } from '../i18n';

/** 互動中的線性解析度倍率。1/2 → 成本 1/4（「互動中 1/4 解析度」）。 */
export const INTERACTIVE_SCALE = 0.5;

export interface CpuRendererOptions {
  info: ViewportInfo;
  /** `react/` 交出來的掛載容器。**canvas 由這裡建立。** */
  container: HTMLElement;
  kernel: ResliceKernel;
  volumes: VolumeStore;
  /** 影像網格（用來算 fit 與捲動步長）。 */
  imageGrid: Grid;
  /** renderer 的上下文需要整組網格。 */
  gridSet: GridSet;
  /**
   * 這一格走哪一條後端。
   *
   * 🔴 **不是「CPU renderer 當然用 cpu 後端」那麼簡單**：`resolveBackend` 要
   * 用它判斷 fallback（例如 `volume-3d` 在 Tier C 是 server-render）。
   */
  tier: Tier;
  /** 每幀量測值的回報（效能實測要的數字）。 */
  onFrame?: (stats: FrameStats) => void;
  /** 這一格鎖定的相位（host 持有、每次讀最新）；沒給 ＝ 一律跟游標。 */
  frameOverride?: FrameOverride;
  /**
   * 面板註冊的 overlay painter。
   *
   * 由 `useScene` 持有並跨 `ViewerHost` 重建保留——**不要在這裡自己 new 一個**，
   * 否則換病例時面板的 painter 會靜默消失。
   */
  overlays?: ViewportOverlayRegistry;
  /**
   * FrameGroup 的查表。
   *
   * 由 `ViewerHost` 注入：使用者可以把某個 FoR 的對位暫時關掉（「套用 REG／不套用」
   * 切換），此時同一個 FoR 要回單位矩陣的 FrameGroup。renderer 自己讀 `gridSet`
   * 就看不到這個狀態。不給時直接查 `gridSet`。
   */
  frameGroupResolver?: (frameOfReferenceUid: string) => FrameGroup;
  /**
   * 這一格的顯示參數袋：例如 `slabOutlineSemantics`。
   * renderer 經 `ctx.viewportParams` 讀；核心不認識裡面的鍵（與 `Layer.params` 同一個精神）。
   */
  viewportParams?: () => Record<string, unknown>;
}

export interface FrameStats {
  viewportId: string;
  quality: Quality;
  /** 影像重切耗時（ms）。 */
  imageMs: number;
  /** 🔴 **20 結構的輪廓重算耗時** —— 全案最該優先量的單一數字。 */
  outlineMs: number;
  outlineStructures: number;
  outlineSegments: number;
  /**
   * 面板 overlay painter 的總耗時。
   *
   * **與 outline 分開量**：painter 是第三方程式碼，它吃掉的幀預算必須看得見，
   * 否則「加了一個面板之後捲動變慢」會被歸咎到 marching squares 上。
   */
  overlayMs: number;
  overlayPainters: number;
  totalMs: number;
  outSizePx: [number, number];
  /**
   * 這一幀向量緩衝重新配置了幾次。
   *
   * 🔴 **穩定狀態下必須是 0。** 不是 0 就代表每幀都在配置新的 `Float32Array`，
   * 症狀是**週期性掉幀**而不是「慢」——那是最難歸因的一類效能問題，因此要量。
   */
  bufferGrowths: number;
  /** renderer 要求常駐在畫面上的說明（slab 標示）。 */
  notices: string[];
  /**
   * 這一幀**沒有畫**的 `(layer, renderer)` 與原因。
   *
   * 🔴 「這一格為什麼是空的」是最常見的客訴，而靜默的 `continue` 讓它無從查起。
   */
  skipped: string[];
  /** 這一幀還沒畫到的輪廓數（分片中）；0 ＝ 畫完了。 */
  outlinePending: number;
}

/** 一幀花在輪廓上的預算；超過就下一幀續畫。 */
export const OUTLINE_CHUNK_BUDGET_MS = 10;
/** 每片至少畫這麼多個結構再檢查預算。 */
export const OUTLINE_MIN_PER_CHUNK = 4;

interface OutlineProgress {
  ctx: CpuContext;
  steps: ReturnType<typeof planCpuFrame>['steps'];
  next: number;
  quality: Quality;
  started: number;
  imageMs: number;
  outlineMs: number;
  outlineStructures: number;
  skipped: string[];
  outSizePx: [number, number];
  overlayPainted?: boolean;
}

export class CpuViewportRenderer implements ViewportRenderer {
  readonly info: ViewportInfo;
  private readonly container: HTMLElement;
  private readonly kernel: ResliceKernel;
  private readonly volumes: VolumeStore;
  private readonly frameOverride: FrameOverride | undefined;
  private readonly imageGrid: Grid;
  private readonly gridSet: GridSet;
  private readonly tier: Tier;
  private readonly onFrame: ((stats: FrameStats) => void) | undefined;
  private readonly overlays: ViewportOverlayRegistry | undefined;
  private readonly frameGroupResolver: ((uid: string) => FrameGroup) | undefined;
  private readonly viewportParams: (() => Record<string, unknown>) | undefined;
  /** 輪廓與其他向量的出口。**跨幀重用，緩衝只長不縮。** */
  private readonly sink: CanvasPathSink;
  /** 重用的像素目的地；每幀 new 一個 512²×4 = 1 MB 是純浪費。 */
  private target: ImageData | null = null;
  /** 這一幀 renderer 要求顯示的說明。 */
  private notices: string[] = [];

  private readonly imageCanvas: HTMLCanvasElement;
  private readonly overlayCanvas: HTMLCanvasElement;
  /** 面板 painter 專用的第三層：可以不重算影像與輪廓、單獨重畫（hover 同步游標）。 */
  private readonly panelCanvas: HTMLCanvasElement;
  private readonly panelCtx: CanvasRenderingContext2D;
  private readonly imageCtx: CanvasRenderingContext2D;
  private readonly overlayCtx: CanvasRenderingContext2D;
  /** 降解析度重切用的離屏 canvas；`final` 時直接用 imageCanvas。 */
  private readonly scratchCanvas: HTMLCanvasElement;
  private readonly scratchCtx: CanvasRenderingContext2D;

  private layers: readonly Layer[] = [];
  private camera: ViewReference | null = null;
  private pxMm = 1;
  private pxMmPinned = false;
  private disposed = false;
  private resizeObserver: ResizeObserver | null = null;
  lastStats: FrameStats | null = null;
  private pendingOutline: OutlineProgress | null = null;

  constructor(options: CpuRendererOptions) {
    this.info = options.info;
    this.container = options.container;
    this.kernel = options.kernel;
    this.volumes = options.volumes;
    this.frameOverride = options.frameOverride;
    this.imageGrid = options.imageGrid;
    this.gridSet = options.gridSet;
    this.tier = options.tier;
    this.onFrame = options.onFrame;
    this.overlays = options.overlays;
    this.frameGroupResolver = options.frameGroupResolver;
    this.viewportParams = options.viewportParams;

    // 🔴 界線 3：DOM 由 core 建立
    this.imageCanvas = document.createElement('canvas');
    this.imageCanvas.className = 'rt-image-canvas';
    this.overlayCanvas = document.createElement('canvas');
    this.overlayCanvas.className = 'rt-overlay-canvas';
    this.panelCanvas = document.createElement('canvas');
    this.panelCanvas.className = 'rt-overlay-canvas rt-panel-canvas';
    for (const canvas of [this.imageCanvas, this.overlayCanvas, this.panelCanvas]) {
      canvas.style.position = 'absolute';
      canvas.style.inset = '0';
      canvas.style.width = '100%';
      canvas.style.height = '100%';
      this.container.appendChild(canvas);
    }
    this.scratchCanvas = document.createElement('canvas');

    const imageCtx = this.imageCanvas.getContext('2d');
    const overlayCtx = this.overlayCanvas.getContext('2d');
    const panelCtx = this.panelCanvas.getContext('2d');
    const scratchCtx = this.scratchCanvas.getContext('2d');
    if (imageCtx === null || overlayCtx === null || panelCtx === null || scratchCtx === null) {
      throw new Error(t('無法取得 canvas 2D 上下文'));
    }
    this.imageCtx = imageCtx;
    this.overlayCtx = overlayCtx;
    this.panelCtx = panelCtx;
    const overlayCanvasRef = this.overlayCanvas;
    this.scratchCtx = scratchCtx;
    // 放大降解析度的畫面時要平滑，否則互動中會看到馬賽克
    this.imageCtx.imageSmoothingEnabled = true;
    // sink 綁 overlay canvas —— 輪廓與面板 painter 共用同一層
    // 🔴 傳入的 ctx 就是 overlay 的那一個；第一個參數只用來讀 width/height。
    // `CanvasLike` 刻意比 `HTMLCanvasElement` 窄（`strokeStyle: string`），
    // 讓核心能在 Node 下測 —— 因此這裡給一個只暴露尺寸的轉接物件。
    this.sink = new CanvasPathSink(
      {
        get width(): number {
          return overlayCanvasRef.width;
        },
        get height(): number {
          return overlayCanvasRef.height;
        },
        getContext: () => overlayCtx as unknown as CanvasRenderingContext2DLike,
      },
      overlayCtx as unknown as CanvasRenderingContext2DLike,
    );
    this.resize(options.info.width, options.info.height);
    this.observeContainer();
  }

  /**
   * 容器尺寸改變時重配 backing store。
   *
   * 沒有這個的話 canvas 停在 attach 當下量到的尺寸，之後靠 CSS 拉伸——影像模糊、
   * 而且 `canvasToWorld` 的縮放係數永遠不是 1。實測 attach 時量到 335、
   * 穩定後是 344（slice 指示與 scrollbar 進場），落點差 9px。
   */
  private observeContainer(): void {
    if (typeof ResizeObserver === 'undefined') return;
    this.resizeObserver = new ResizeObserver(() => {
      if (this.disposed) return;
      const rect = this.container.getBoundingClientRect();
      const w = Math.max(1, Math.round(rect.width));
      const h = Math.max(1, Math.round(rect.height));
      if (w === this.imageCanvas.width && h === this.imageCanvas.height) return;
      this.resize(w, h);
      this.render('final');
    });
    this.resizeObserver.observe(this.container);
  }

  setLayers(layers: readonly Layer[]): void {
    this.layers = layers;
  }

  setCamera(ref: ViewReference): void {
    this.camera = ref;
    if (!this.pxMmPinned) {
      this.pxMm = fitPxMm(this.imageGrid, ref, {
        w: this.imageCanvas.width,
        h: this.imageCanvas.height,
      });
    }
  }

  currentCamera(): ViewReference | null {
    return this.camera;
  }

  /** mm/px。**Zoom 就是改這個值**。 */
  currentPxMm(): number {
    return this.pxMm;
  }

  setPxMm(pxMm: number): void {
    this.pxMm = Math.max(1e-3, pxMm);
    this.pxMmPinned = true;
  }

  /** 回到 fit（`Fit` 按鈕）。 */
  resetZoom(): void {
    this.pxMmPinned = false;
    if (this.camera) this.setCamera(this.camera);
  }

  resize(w: number, h: number): void {
    const width = Math.max(1, Math.round(w));
    const height = Math.max(1, Math.round(h));
    (this.info as { width: number }).width = width;
    (this.info as { height: number }).height = height;
    for (const canvas of [this.imageCanvas, this.overlayCanvas, this.panelCanvas]) {
      canvas.width = width;
      canvas.height = height;
    }
    if (this.camera && !this.pxMmPinned) this.setCamera(this.camera);
  }

  /**
   * 一幀。
   *
   * 🔴 **這個迴圈裡沒有任何 `layer.kind === '...'`。**
   *
   * 舊版有兩段硬編碼（`kind === 'image'` 與 `kind === 'mask'`），因此註冊表
   * 存在但沒有承重：六個 renderer 的 `render()` 全是 `notImplemented()`，
   * 而真正在畫的是這裡。架構要禁止的那個 `if (kind === ...)`，第一個
   * 違反者是核心自己。
   *
   * 現在的語意只有三行：
   *
   * 1. `resolveRenderers(layer, viewport)` —— 這個 layer 要開哪些 renderer
   * 2. `resolveBackend(rendererId, tier)` —— 這個 Tier 上實際能用哪一個
   * 3. `backend.draw(ctx, layer)` —— 畫
   *
   * 加一種新的顯示方式＝註冊一個 plugin，這個檔案不必動。
   */
  render(quality: Quality): void {
    if (this.disposed || this.camera === null) return;
    this.pendingOutline = null; // 新的一幀開始：上一幀還沒畫完的輪廓作廢
    const started = performance.now();
    const scale = quality === 'interactive' ? INTERACTIVE_SCALE : 1;
    const outW = Math.max(1, Math.round(this.imageCanvas.width * scale));
    const outH = Math.max(1, Math.round(this.imageCanvas.height * scale));
    const pxMm = this.pxMm / scale;

    this.notices = [];
    const target = this.targetFor(outW, outH);
    // 平面像素 → canvas 像素。互動態的降解析度只影響座標，**不影響線寬**
    // （見 `CanvasPathSink.setPlaneToCanvas`）。
    this.sink.setPlaneToCanvas(scale === 1 ? null : { scale: 1 / scale, offsetX: 0, offsetY: 0 });
    this.sink.beginFrame();

    const ctx = this.makeContext(target, pxMm, quality);
    const plan = planCpuFrame({ layers: this.layers, viewport: this.info, tier: this.tier });

    // 影像層先全部畫完並 blit —— 使用者先看到影像，輪廓可以下一幀再補
    const imageSteps = plan.steps.filter((s) => s.plugin.zBand === 'image');
    // 🔴 `overlay` band（劑量 colorwash、ROI 填色）也是畫進 `ctx.target` 的像素，**必須在 blit 之前畫**：
    // 先前把「非 image」全部丟進分片的輪廓階段，那時 target 已經 blit 過、之後不會再 blit ——
    // colorwash／填色畫了但永遠不上畫面，只剩走向量出口的等劑量線。
    // 只有 `annotation`（向量出口，畫在 overlay canvas）能分片續畫。
    const pixelOverlaySteps = plan.steps.filter((s) => s.plugin.zBand === 'overlay');
    const outlineSteps = plan.steps.filter((s) => s.plugin.zBand === 'annotation');
    let imageMs = 0;
    let drewImage = false;
    for (const step of imageSteps) {
      const at = performance.now();
      if (this.drawStep(ctx, step)) drewImage = true;
      imageMs += performance.now() - at;
    }
    if (drewImage) this.blitTarget(target, scale);
    let drewOverlay = false;
    for (const step of pixelOverlaySteps) {
      const at = performance.now();
      if (this.drawStep(ctx, step)) drewOverlay = true;
      imageMs += performance.now() - at;
    }
    if (drewOverlay) {
      this.blitTarget(target, scale);
    } else if (!drewImage) {
      this.imageCtx.clearRect(0, 0, this.imageCanvas.width, this.imageCanvas.height);
    }

    const frame: OutlineProgress = {
      ctx,
      steps: outlineSteps,
      next: 0,
      quality,
      started,
      imageMs,
      outlineMs: 0,
      outlineStructures: 0,
      skipped: plan.skipped.map((x) => `${x.layerId}/${x.rendererId}: ${x.reason}`),
      outSizePx: [outW, outH],
    };
    this.drawOutlineChunk(frame, quality === 'final' ? OUTLINE_CHUNK_BUDGET_MS : Number.POSITIVE_INFINITY);
  }

  /**
   * 輪廓分片。一幀最多花 `budgetMs` 在輪廓上，沒畫完的排到下一個動畫幀續畫
   * （sink 只在 `beginFrame` 清畫布，續畫直接疊上去）。互動態不分片（本來就是低解析度、
   * 且 settle 後會補一張 final）。
   */
  private drawOutlineChunk(frame: OutlineProgress, budgetMs: number): void {
    if (this.disposed) return;
    const chunkStart = performance.now();
    while (frame.next < frame.steps.length) {
      const step = frame.steps[frame.next]!;
      const at = performance.now();
      this.drawStep(frame.ctx, step);
      frame.outlineMs += performance.now() - at;
      frame.outlineStructures += 1;
      frame.next += 1;
      // 至少畫 OUTLINE_MIN_PER_CHUNK 個再看預算，避免慢機器上每幀只畫一個
      if (frame.next % OUTLINE_MIN_PER_CHUNK === 0 && performance.now() - chunkStart > budgetMs) break;
    }
    const done = frame.next >= frame.steps.length;
    this.emitStats(frame, done);
    if (done) {
      this.pendingOutline = null;
      return;
    }
    this.pendingOutline = frame;
    const run = (): void => {
      if (this.pendingOutline !== frame) return; // 被新的一幀取代
      this.drawOutlineChunk(frame, budgetMs);
    };
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(run);
    else setTimeout(run, 0);
  }

  /** 還有輪廓沒畫完就同步畫完（測試、量測；一般流程不需要）。 */
  flushOutlines(): void {
    const frame = this.pendingOutline;
    if (frame === null) return;
    this.pendingOutline = null;
    this.drawOutlineChunk(frame, Number.POSITIVE_INFINITY);
  }

  private drawStep(ctx: CpuContext, step: ReturnType<typeof planCpuFrame>['steps'][number]): boolean {
    const { layer, plugin, backend } = step;
    try {
      backend.draw(ctx, layer, undefined);
      return true;
    } catch (error) {
      this.notices.push(
        t('renderer「{rendererId}」在「{label}」上失敗：', { rendererId: plugin.rendererId, label: layer.label }) +
          (error instanceof Error ? error.message : String(error)),
      );
      return false;
    }
  }

  private emitStats(frame: OutlineProgress, done: boolean): void {
    const drawStats = this.sink.endFrame();
    const overlayStart = performance.now();
    // 面板 overlay（十字線、量測）只在第一片之後畫一次；續畫的片不重畫
    const overlayPainters = frame.overlayPainted ? 0 : this.paintOverlays(frame.quality);
    frame.overlayPainted = true;
    const overlayMs = performance.now() - overlayStart;
    this.paintNotices();
    const stats: FrameStats = {
      viewportId: this.info.viewportId,
      quality: frame.quality,
      imageMs: frame.imageMs,
      outlineMs: frame.outlineMs,
      outlineStructures: frame.outlineStructures,
      outlineSegments: drawStats.segments,
      overlayMs,
      overlayPainters,
      totalMs: performance.now() - frame.started,
      outSizePx: frame.outSizePx,
      bufferGrowths: drawStats.bufferGrowths,
      notices: [...this.notices],
      skipped: frame.skipped,
      outlinePending: done ? 0 : frame.steps.length - frame.next,
    };
    this.lastStats = stats;
    this.onFrame?.(stats);
  }

  private makeContext(target: ImageData, pxMm: number, quality: Quality): CpuContext {
    const camera = this.camera!;
    return {
      viewportId: this.info.viewportId,
      gridSet: this.gridSet,
      frameGroup: (uid) => this.frameGroupOf(uid),
      temporal: (id) => this.temporalOf(id),
      camera,
      viewportParams: this.viewportParams?.() ?? {},
      viewportSize: { w: this.imageCanvas.width, h: this.imageCanvas.height },
      pxMm,
      quality,
      project: (world) => this.worldToCanvas(world),
      voxels: (layer) => this.volumes.forLayer(layer, this.frameOverride),
      notice: (text) => {
        if (!this.notices.includes(text)) this.notices.push(text);
      },
      resampler: this.kernel,
      target,
      // 工作執行緒池未實作；型別上是 `WorkerPool | null`，因此呼叫端必須表態
      workers: null,
      paths: this.sink,
      svgRoot: null,
    };
  }

  /**
   * `FrameGroup` / `TemporalGroup` 的查表。
   *
   * 找不到時回傳 primary（單一 FoR 的案例佔絕大多數）而不是拋例外：
   * renderer 拿不到 frame group 只會畫錯位置，拋例外會讓整格畫面消失。
   */
  private frameGroupOf(uid: string): FrameGroup {
    if (this.frameGroupResolver !== undefined) return this.frameGroupResolver(uid);
    return (
      this.gridSet.frameGroups.find((f) => f.frameOfReferenceUid === uid) ??
      primaryFrameGroupOf(uid, 'unknown')
    );
  }

  private temporalOf(id: string): TemporalGroup {
    const found = this.gridSet.temporalGroups?.find((t) => t.temporalGroupId === id);
    if (found === undefined) {
      throw new Error(t('沒有這個 TemporalGroup: {id}', { id }));
    }
    return found;
  }

  /** 重用的 `ImageData`（每幀 new 一個 512²×4 = 1 MB 是純浪費）。 */
  private targetFor(w: number, h: number): ImageData {
    if (this.target === null || this.target.width !== w || this.target.height !== h) {
      this.target = new ImageData(w, h);
    } else {
      // 沒有 image layer 時 target 不會被寫入，殘影必須自己清掉
      this.target.data.fill(0);
    }
    return this.target;
  }

  /** 把 target 貼到畫面；互動態時放大。 */
  private blitTarget(target: ImageData, scale: number): void {
    if (scale === 1) {
      this.imageCtx.putImageData(target, 0, 0);
      return;
    }
    this.scratchCanvas.width = target.width;
    this.scratchCanvas.height = target.height;
    this.scratchCtx.putImageData(target, 0, 0);
    this.imageCtx.clearRect(0, 0, this.imageCanvas.width, this.imageCanvas.height);
    this.imageCtx.drawImage(
      this.scratchCanvas,
      0,
      0,
      this.imageCanvas.width,
      this.imageCanvas.height,
    );
  }

  /**
   * slab > 2 mm 時**常駐**標示「輪廓＝slab 中心面」。
   *
   * 🔴 少了這個，厚板下的一條線看起來就像是整個厚度的輪廓 —— 那是臨床意義
   * 完全不同的東西（預設取中心面）。
   */
  private paintNotices(): void {
    if (this.notices.length === 0) return;
    const ctx = this.overlayCtx;
    ctx.save();
    ctx.font = '11px system-ui, sans-serif';
    ctx.textBaseline = 'bottom';
    let y = this.overlayCanvas.height - 4;
    for (const text of this.notices.slice(-3)) {
      const width = ctx.measureText(text).width;
      ctx.fillStyle = 'rgba(0,0,0,0.55)';
      ctx.fillRect(this.overlayCanvas.width - width - 10, y - 13, width + 8, 15);
      ctx.fillStyle = 'rgba(255,214,102,0.95)';
      ctx.fillText(text, this.overlayCanvas.width - width - 6, y);
      y -= 17;
    }
    ctx.restore();
  }

  // ── 面板 overlay ──────────────────────────────────────────────────────────

  /**
   * 依序呼叫面板註冊的 painter，回傳實際畫了幾個。
   *
   * 🔴 **每個 painter 各自 `save()`／`restore()`，並各自 try/catch。**
   * 第三方面板拋例外時只停用它自己（`markFailed`），影像與輪廓照常顯示——
   * **一個面板的 bug 不該讓臨床畫面消失**。停用會經 `failures()` 顯示在狀態列，
   * 不是靜默吞掉。
   */
  private paintOverlays(quality: Quality): number {
    // 面板層自己清 —— 它不在 sink 的那一幀裡
    this.panelCtx.clearRect(0, 0, this.panelCanvas.width, this.panelCanvas.height);
    if (this.overlays === undefined || this.camera === null) return 0;
    const painters = this.overlays.paintersFor(this.info.viewportId);
    if (painters.length === 0) return 0;

    const camera = this.camera;
    const width = this.panelCanvas.width;
    const height = this.panelCanvas.height;
    const context: OverlayPaintContext = {
      viewportId: this.info.viewportId,
      ctx: this.panelCtx,
      width,
      height,
      camera,
      quality,
      project: (world) => this.worldToCanvas(world),
      signedDistanceMm: (world) => {
        const n = camera.viewPlaneNormal;
        const o = camera.planeOrigin;
        return (world[0] - o[0]) * n[0] + (world[1] - o[1]) * n[1] + (world[2] - o[2]) * n[2];
      },
    };

    let painted = 0;
    for (const painter of painters) {
      this.panelCtx.save();
      try {
        painter.paint(context);
        painted += 1;
      } catch (error) {
        this.overlays.markFailed(
          painter.id,
          error instanceof Error ? error.message : String(error),
        );
      } finally {
        this.panelCtx.restore();
      }
    }
    return painted;
  }

  /** 只重畫面板 painter 那一層（影像、輪廓不動）。hover 同步游標、開關參考線用 —— 比 `render()` 便宜得多。 */
  repaintOverlays(): void {
    if (this.disposed || this.camera === null) return;
    this.paintOverlays('final');
  }

  // ── 座標轉換（工具與十字線用，座標轉換鏈第一段）───────────────────────────────

  /**
   * 世界座標（LPS mm）→ overlay canvas 的 **backing store 像素**。
   *
   * `canvasToWorld` 的反函式，但**刻意回傳 backing store 座標而不是 CSS 座標**：
   * painter 畫在 canvas 上，用的就是 backing store 的座標系。若回傳 CSS 像素，
   * 在容器被 CSS 拉伸時 painter 畫的東西會與影像錯開，而**影像本身看起來正常**
   * ——那正是最難查的一類偏移。
   */
  worldToCanvas(world: Vec3): Vec2 {
    if (this.camera === null) return { x: 0, y: 0 };
    return worldToPlanePx(this.camera, this.pxMm, { w: this.imageCanvas.width, h: this.imageCanvas.height }, world);
  }


  /** canvas 像素 → 世界座標（LPS mm）。 */
  /**
   * 容器內的 **CSS 像素** → 世界座標。
   *
   * 🔴 canvas 的 CSS 尺寸是 `100%`，backing store 卻是 `info.width/height`。
   * 兩者只有在剛好量測過的那一刻相等；容器一變（面板展開、視窗縮放、
   * scrollbar 出現）就會不同，而畫面被 CSS 拉伸看起來仍然正常。
   * 少了這個換算，筆刷落點會**隨著離中心愈遠而偏愈多**——對描邊產品是硬錯誤。
   */
  canvasToWorld(x: number, y: number): [number, number, number] {
    if (this.camera === null) return [0, 0, 0];
    const rect = this.container.getBoundingClientRect();
    const sx = rect.width > 0 ? this.imageCanvas.width / rect.width : 1;
    const sy = rect.height > 0 ? this.imageCanvas.height / rect.height : 1;
    return planePxToWorld(
      this.camera,
      this.pxMm,
      { w: this.imageCanvas.width, h: this.imageCanvas.height },
      { x: x * sx, y: y * sy },
    );
  }

  /** CSS 像素 → backing store 像素的比例（svg overlay 與 hit-test 要用同一把尺）。 */
  /** 觸控放大鏡要從這幾層取像（影像、輪廓／填色、面板 painter），由下往上。 */
  layerCanvases(): readonly HTMLCanvasElement[] {
    return [this.imageCanvas, this.overlayCanvas, this.panelCanvas];
  }

  cssToBackingScale(): { sx: number; sy: number } {
    const rect = this.container.getBoundingClientRect();
    return {
      sx: rect.width > 0 ? this.imageCanvas.width / rect.width : 1,
      sy: rect.height > 0 ? this.imageCanvas.height / rect.height : 1,
    };
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    for (const canvas of [this.imageCanvas, this.overlayCanvas, this.panelCanvas]) {
      canvas.remove();
    }
    this.layers = [];
    this.camera = null;
  }

  isDisposed(): boolean {
    return this.disposed;
  }
}
