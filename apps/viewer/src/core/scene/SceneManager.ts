/**
 * `SceneManager` —— **唯一擁有 renderer、viewport 與 handle 的物件**。
 *
 * ## 三條不可違反的界線
 *
 * 1. `core/` 不得 import 任何 React。
 * 2. `react/` 不得 import 任何 `@kitware/vtk.js` 或 `@cornerstonejs/core`。
 * 3. 🔴 **overlay 的 DOM／canvas 節點由 `core/` 直接建立與更新；`react/` 只提供
 *    掛載容器。**
 *
 * > **React 負責「這塊畫面在哪」，core 負責「這塊畫面上有什麼」。**
 *
 * ## 生命週期
 *
 * 以 `useRef` 單例持有；`useEffect` cleanup 必須呼叫 `dispose()`。
 * **開發階段一律開著 StrictMode**，不得為了迴避 double-mount 而關閉——
 * 因此 `dispose()` 必須是冪等的，且 `attachViewport` 對同一個 id 重複呼叫要能
 * 正確重建。
 */

import {
  assertCrossFamilyCompatible,
  InvalidationTracker,
  require_,
  type GridSet,
  type ViewReference,
} from '../geometry';
import type { Layer } from '../layers/types';
import { diffRenderers, resolveRenderers } from '../raster/kinds';
import { backendFor, getLayerRenderer, resolveBackend, zBandRank } from '../raster/registry';
import type {
  FallbackContext,
  LayerHandle,
  Quality,
  Tier,
  TransportLike,
  ViewportInfo,
} from '../raster/types';
import { handleKey, ResidencyManager, type EvictionResult, type HandleKey } from './residency';
import { NullViewportRenderer, type ViewportRenderer } from './ViewportRenderer';
import { joinList, t } from '../i18n';

/** 互動停止後補到 final 品質的延遲（滑鼠放開 ＋ 150 ms）。 */
export const SETTLE_MS = 150;

export interface AttachedLayerState {
  readonly layer: Layer;
  /** 這個 layer 在各 viewport 上實際開了哪些 rendererId。 */
  readonly rendererIds: Map<string, string[]>;
  /** 走了 fallback 的 renderer 及其提示（**必須在 UI 明示**）。 */
  readonly substitutes: Map<string, string>;
}

export interface SceneManagerOptions {
  gridSet: GridSet;
  tier: Tier;
  budgetBytes: number;
  transport: TransportLike;
  /** 注入用：預設建立 `NullViewportRenderer`（第一版沒有真正的光柵化）。 */
  createRenderer?: (info: ViewportInfo) => ViewportRenderer;
  /** 注入用：預設為 `makeStubHandle`。真實後端由註冊表的 `render()` 交還。 */
  createHandle?: (args: {
    viewportId: string;
    layerId: string;
    rendererId: string;
    isSubstitute: boolean;
  }) => LayerHandle;
  keepHiddenCount?: number;
  onNotice?: (notice: SceneNotice) => void;
}

export interface SceneNotice {
  /** `tool`：工具沒有作用的原因（例：鎖住的格子上，作用中的結構不在那一幀）。 */
  kind: 'substitute' | 'hidden' | 'evicted' | 'over-budget' | 'invalidated' | 'tool';
  message: string;
  detail?: Record<string, unknown>;
}

export class SceneManager {
  private gridSet: GridSet;
  private tier: Tier;
  private readonly transport: TransportLike;
  private readonly residency: ResidencyManager;
  private readonly invalidation: InvalidationTracker;
  private readonly viewports = new Map<string, ViewportRenderer>();
  private readonly layers = new Map<string, AttachedLayerState>();
  private readonly createRenderer: (info: ViewportInfo) => ViewportRenderer;
  private readonly createHandleFn: NonNullable<SceneManagerOptions['createHandle']>;
  private readonly onNotice: (notice: SceneNotice) => void;
  private settleTimer: ReturnType<typeof setTimeout> | null = null;
  private quality: Quality = 'final';
  private disposed = false;

  constructor(options: SceneManagerOptions) {
    // 🔴 建構時就檢查 I3 的跨族相容性：影像與 mask 必須落在同一塊空間。
    assertCrossFamilyCompatible(options.gridSet.displayGrid, options.gridSet.maskGrid);
    this.gridSet = options.gridSet;
    this.tier = options.tier;
    this.transport = options.transport;
    this.residency = new ResidencyManager({
      budgetBytes: options.budgetBytes,
      ...(options.keepHiddenCount !== undefined ? { keepHiddenCount: options.keepHiddenCount } : {}),
    });
    this.invalidation = new InvalidationTracker(
      options.gridSet.displayGrid.displayGridId,
      options.gridSet.maskGrid.maskGridId,
    );
    this.createRenderer = options.createRenderer ?? ((info) => new NullViewportRenderer(info));
    this.createHandleFn =
      options.createHandle ??
      ((args) => {
        // 延遲 import 避免測試在未註冊 builtins 時就拉進整個 raster 樹
         
        throw new Error(
          t('未提供 createHandle，且 renderer {rendererId} 的後端尚未實作光柵化。', { rendererId: args.rendererId }) +
            t('第一版請注入 makeStubHandle（見 core/raster/builtins.ts）'),
        );
      });
    this.onNotice = options.onNotice ?? (() => {});
  }

  // ── viewport ─────────────────────────────────────────────────────────────

  /** `react/` 只交出一個容器與尺寸；**渲染器由這裡建立與擁有**。 */
  attachViewport(info: ViewportInfo): ViewportRenderer {
    this.assertAlive();
    const existing = this.viewports.get(info.viewportId);
    if (existing) {
      // StrictMode double-mount：先清乾淨再重建，不得留下兩份
      this.detachViewport(info.viewportId);
    }
    const renderer = this.createRenderer(info);
    this.viewports.set(info.viewportId, renderer);
    for (const state of this.layers.values()) this.attachLayerToViewport(state.layer, info);
    renderer.setLayers(this.orderedLayers());
    return renderer;
  }

  detachViewport(viewportId: string): void {
    const renderer = this.viewports.get(viewportId);
    if (!renderer) return;
    for (const key of this.residency.keys()) {
      if (key.startsWith(`${viewportId}|`)) this.residency.remove(key);
    }
    renderer.dispose();
    this.viewports.delete(viewportId);
    for (const state of this.layers.values()) state.rendererIds.delete(viewportId);
  }

  viewportInfo(viewportId: string): ViewportInfo | null {
    return this.viewports.get(viewportId)?.info ?? null;
  }

  viewportIds(): string[] {
    return [...this.viewports.keys()];
  }

  // ── layer ────────────────────────────────────────────────────────────────

  /**
   * 加入或取代一個 layer。
   *
   * 核心的迴圈只有一行語意：
   * `for (const id of resolveRenderers(layer, vp)) attach(id, layer)`。
   * **核心因此不認識 `'mask'`，也不認識 `renderStyle` 的三個值。**
   */
  setLayer(layer: Layer): void {
    this.assertAlive();
    const existing = this.layers.get(layer.layerId);
    const state: AttachedLayerState = existing ?? {
      layer,
      rendererIds: new Map(),
      substitutes: new Map(),
    };
    (state as { layer: Layer }).layer = layer;
    this.layers.set(layer.layerId, state);
    for (const renderer of this.viewports.values()) {
      this.attachLayerToViewport(layer, renderer.info);
    }
    this.pushLayersToViewports();
  }

  setLayers(layers: readonly Layer[]): void {
    this.assertAlive();
    const incoming = new Set(layers.map((l) => l.layerId));
    for (const layerId of [...this.layers.keys()]) {
      if (!incoming.has(layerId)) this.removeLayer(layerId);
    }
    for (const layer of layers) this.setLayer(layer);
  }

  removeLayer(layerId: string): void {
    const state = this.layers.get(layerId);
    if (!state) return;
    for (const [viewportId, rendererIds] of state.rendererIds) {
      for (const rendererId of rendererIds) {
        this.residency.remove(handleKey(viewportId, layerId, rendererId));
      }
    }
    this.layers.delete(layerId);
    this.pushLayersToViewports();
  }

  /**
   * `visible` 的唯一入口 —— **它直接驅動常駐**。
   */
  setVisible(layerId: string, visible: boolean): EvictionResult {
    const state = this.layers.get(layerId);
    require_(state !== undefined, 'S1', t('未知的 layerId'), { layerId });
    state!.layer.visible = visible;
    for (const [viewportId, rendererIds] of state!.rendererIds) {
      for (const rendererId of rendererIds) {
        this.residency.setVisible(handleKey(viewportId, layerId, rendererId), visible);
      }
    }
    return this.enforceBudget();
  }

  /** 圖層群組批次開關 —— 182 個結構逐一點是不可用的。 */
  setGroupVisible(groupId: string, visible: boolean): EvictionResult {
    for (const state of this.layers.values()) {
      if (state.layer.groupId !== groupId) continue;
      state.layer.visible = visible;
      for (const [viewportId, rendererIds] of state.rendererIds) {
        for (const rendererId of rendererIds) {
          this.residency.setVisible(handleKey(viewportId, state.layer.layerId, rendererId), visible);
        }
      }
    }
    return this.enforceBudget();
  }

  setOpacity(layerId: string, opacity: number): void {
    const state = this.layers.get(layerId);
    require_(state !== undefined, 'S1', t('未知的 layerId'), { layerId });
    state!.layer.opacity = opacity;
    for (const [viewportId, rendererIds] of state!.rendererIds) {
      for (const rendererId of rendererIds) {
        this.residency.get(handleKey(viewportId, layerId, rendererId))?.handle.setOpacity(opacity);
      }
    }
  }

  layer(layerId: string): Layer | null {
    return this.layers.get(layerId)?.layer ?? null;
  }

  /**
   * 依 `zBand` ＋ `order` 排序後的 layer 清單。
   *
   * **混合順序從程式碼變成資料**：這裡不出現任何
   * 「mask 恆在 image 之上」的硬編碼，順序完全由 renderer 宣告的 `zBand` 決定。
   */
  orderedLayers(): Layer[] {
    return [...this.layers.values()]
      .map((state) => ({ layer: state.layer, band: this.bandOf(state) }))
      .sort((a, b) => (a.band - b.band) || (a.layer.order - b.layer.order))
      .map((x) => x.layer);
  }

  private bandOf(state: AttachedLayerState): number {
    let worst = 0;
    for (const rendererIds of state.rendererIds.values()) {
      for (const rendererId of rendererIds) {
        worst = Math.max(worst, zBandRank(getLayerRenderer(rendererId).zBand));
      }
    }
    return worst;
  }

  /** 走了 fallback 的 layer 與提示（結構清單上要標記替代表示）。 */
  substituteNotices(): { layerId: string; rendererId: string; notice: string }[] {
    const out: { layerId: string; rendererId: string; notice: string }[] = [];
    for (const [layerId, state] of this.layers) {
      for (const [rendererId, notice] of state.substitutes) {
        out.push({ layerId, rendererId, notice });
      }
    }
    return out;
  }

  /**
   * 替代表示為**唯讀**。
   *
   * 🔴 工具啟動前必須檢查，**不得靜默寫進一個沒有在畫面上的 mask**。
   */
  isEditable(layerId: string): boolean {
    const state = this.layers.get(layerId);
    if (!state) return false;
    return state.substitutes.size === 0;
  }

  // ── 品質狀態 ──────────────────────────────────────────────────────────────

  /**
   * 互動開始 → `interactive`。停止 `SETTLE_MS` 後自動補到 `final`。
   *
   * **outline 也吃這兩態**：互動中以 1/2 線性解析度跑 marching
   * squares（成本 1/4），停止後全解析度重算。與高品質重切**同一個時機
   * 點、同一次 flush**。
   */
  beginInteraction(): void {
    this.quality = 'interactive';
    if (this.settleTimer !== null) clearTimeout(this.settleTimer);
    this.settleTimer = null;
  }

  endInteraction(onSettled?: () => void): void {
    if (this.settleTimer !== null) clearTimeout(this.settleTimer);
    this.settleTimer = setTimeout(() => {
      this.settleTimer = null;
      this.quality = 'final';
      this.renderAll();
      onSettled?.();
    }, SETTLE_MS);
  }

  currentQuality(): Quality {
    return this.quality;
  }

  setCamera(viewportId: string, camera: ViewReference): void {
    const renderer = this.viewports.get(viewportId);
    require_(renderer !== undefined, 'S2', t('未知的 viewportId'), { viewportId });
    renderer!.setCamera(camera);
  }

  /**
   * 跨 viewport 的相機同步。
   *
   * > 所有 actor 以 `userMatrix` 進到 primary
   * > 世界座標，因此**同步一律以 primary 世界座標為準，不需要再套
   * > `transformToPrimary`**。再套一次等於套兩次變換。
   */
  syncCameras(source: ViewReference, targets: readonly string[]): void {
    for (const viewportId of targets) {
      const renderer = this.viewports.get(viewportId);
      if (!renderer) continue;
      renderer.setCamera(source);
    }
  }

  renderAll(): void {
    for (const renderer of this.viewports.values()) renderer.render(this.quality);
  }

  // ── 網格失效（I4）────────────────────────────────────────────────────────

  /**
   * I4 —— **兩個網格 id 各自獨立失效，不連動。**
   *
   * `displayGridId` 改變 → 所有影像 payload 失效。
   * `maskGridId` 改變 → 所有 mask 與 mesh 失效。
   */
  updateGridSet(next: GridSet): Set<string> {
    assertCrossFamilyCompatible(next.displayGrid, next.maskGrid);
    const dropped = this.invalidation.update({
      displayGridId: next.displayGrid.displayGridId,
      maskGridId: next.maskGrid.maskGridId,
    });
    this.gridSet = next;
    this.tier = next.assignedTier;
    if (dropped.size > 0) {
      for (const [layerId, state] of this.layers) {
        const affected =
          (dropped.has('image') && state.layer.kind === 'image') ||
          (dropped.has('mask') && state.layer.kind === 'mask') ||
          (dropped.has('mesh') && state.layer.kind === 'mesh');
        if (!affected) continue;
        for (const [viewportId, rendererIds] of state.rendererIds) {
          for (const rendererId of rendererIds) {
            this.residency.remove(handleKey(viewportId, layerId, rendererId));
          }
        }
        state.rendererIds.clear();
        state.substitutes.clear();
      }
      this.onNotice({
        kind: 'invalidated',
        message: t('網格 id 改變，已失效：{p0}', { p0: joinList([...dropped]) }),
        detail: { dropped: [...dropped] },
      });
      // 重新 attach（資料由呼叫端重新取回後 setLayer 即可）
      for (const state of this.layers.values()) {
        for (const renderer of this.viewports.values()) {
          this.attachLayerToViewport(state.layer, renderer.info);
        }
      }
    }
    return dropped;
  }

  currentGridSet(): GridSet {
    return this.gridSet;
  }

  currentTier(): Tier {
    return this.tier;
  }

  // ── 記憶體 ───────────────────────────────────────────────────────────────

  residentBytes(): number {
    return this.residency.residentBytes();
  }

  residencyBreakdown(): ReturnType<ResidencyManager['breakdown']> {
    return this.residency.breakdown();
  }

  setBudget(bytes: number): EvictionResult {
    this.residency.budgetBytes = bytes;
    return this.enforceBudget();
  }

  private enforceBudget(): EvictionResult {
    const result = this.residency.evictToBudget();
    if (result.evicted.length > 0) {
      this.onNotice({
        kind: 'evicted',
        message: t('逐出 {length} 個 handle，釋放 {p1} MB', { length: result.evicted.length, p1: Math.round(result.freedBytes / 1e6) }),
        detail: { evicted: result.evicted },
      });
    }
    if (result.stillOverBudget) {
      this.onNotice({
        kind: 'over-budget',
        message: t('已逐出所有可逐出的 handle，仍超過記憶體預算——必須降低 lod 或減少可見結構'),
        detail: { residentBytes: result.residentBytes, budgetBytes: this.residency.budgetBytes },
      });
    }
    return result;
  }

  // ── 內部 ─────────────────────────────────────────────────────────────────

  /**
   * 把一個 layer attach 到一個 viewport。
   *
   * **`renderStyle` 改變 ＝ handle 集合改變**：對前後兩次
   * `resolveRenderers` 的結果做 diff，dispose 消失的、建立新增的、其餘不動。
   * 🔴 **不得整個 layer 重建**——切一下 renderStyle 不應該讓 fill 的 texture
   * 重新上傳。
   */
  private attachLayerToViewport(layer: Layer, info: ViewportInfo): void {
    const state = this.layers.get(layer.layerId);
    if (!state) return;
    const before = state.rendererIds.get(info.viewportId) ?? [];
    const after = resolveRenderers(layer, info);
    const diff = diffRenderers(before, after);

    for (const rendererId of diff.removed) {
      this.residency.remove(handleKey(info.viewportId, layer.layerId, rendererId));
      state.substitutes.delete(rendererId);
    }

    const attached: string[] = [...diff.kept];
    for (const rendererId of diff.added) {
      const resolved = resolveBackend(rendererId, this.tier);
      if (resolved.hidden) {
        // **明確告知使用者不可用**，不是靜默省略
        this.onNotice({
          kind: 'hidden',
          message: resolved.notice ?? t('{rendererId} 在 Tier {tier} 不可用', { rendererId, tier: this.tier }),
          detail: { layerId: layer.layerId, rendererId, tier: this.tier },
        });
        continue;
      }
      if (resolved.isSubstitute && resolved.notice) {
        state.substitutes.set(rendererId, resolved.notice);
        this.onNotice({
          kind: 'substitute',
          message: resolved.notice,
          detail: { layerId: layer.layerId, rendererId, effective: resolved.effectiveRendererId },
        });
      }
      const handle = this.createHandleFn({
        viewportId: info.viewportId,
        layerId: layer.layerId,
        rendererId: resolved.effectiveRendererId,
        isSubstitute: resolved.isSubstitute,
      });
      this.residency.add(handle, layer.visible);
      handle.setVisible(layer.visible);
      handle.setOpacity(layer.opacity);
      attached.push(resolved.effectiveRendererId);
    }
    state.rendererIds.set(info.viewportId, attached);
    this.enforceBudget();
  }

  private pushLayersToViewports(): void {
    const ordered = this.orderedLayers();
    for (const renderer of this.viewports.values()) renderer.setLayers(ordered);
  }

  private assertAlive(): void {
    require_(!this.disposed, 'S3', t('SceneManager 已 dispose，不得再使用'));
  }

  /** 後端使用的 fallback 上下文（`resolveContent` 一律經 transport）。 */
  fallbackContext(): FallbackContext {
    return { transport: this.transport, tier: this.tier };
  }

  /** 🔴 冪等。StrictMode 的 double-mount 會呼叫兩次。 */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.settleTimer !== null) clearTimeout(this.settleTimer);
    this.settleTimer = null;
    this.residency.disposeAll();
    for (const renderer of this.viewports.values()) renderer.dispose();
    this.viewports.clear();
    this.layers.clear();
  }

  isDisposed(): boolean {
    return this.disposed;
  }
}

/** 便利函式：目前 Tier 走 GPU 還是 CPU 後端。 */
export { backendFor };
export type { HandleKey };
