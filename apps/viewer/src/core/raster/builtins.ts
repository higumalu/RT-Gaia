/**
 * 核心內建註冊的六個 renderer 與四個 kind。
 *
 * ## 實作狀態（誠實記錄）
 *
 * | renderer | gpu | cpu |
 * |---|---|---|
 * | `image` | 未實作 | ✅ **真的在畫**（`cpuBackends.ts`） |
 * | `mask-outline` | 未實作（可直接沿用 cpu 那一份） | ✅ **真的在畫** |
 * | `mask-fill` | 未實作（位元打包 shader；隨 GPU 路徑） | ✅ **真的在畫**（合成器直接疊、不打包） |
 * | `mesh` | 未實作 | 未實作 |
 * | `measurement` | 未實作 | 未實作 |
 * | `volume-3d` | 未實作 | **宣告 unsupported ＋ server-render** |
 *
 * 「未實作」＝ `render()` 交還一個記帳正確但不畫像素的 handle，而且**沒有
 * `draw`** —— 因此 `planCpuFrame()` 會把它跳過並說出原因，不是靜默消失。
 *
 * 🔴 **在此之前六個 renderer 全部未實作，而畫面卻是好的** —— 因為
 * `CpuViewportRenderer` 硬編碼了 `kind === 'image'` 與 `kind === 'mask'`，
 * 完全繞過註冊表。架構要禁止的那個 `if (kind === ...)`，第一個違反者是
 * 核心自己。現在那兩段搬進了 `cpuBackends.ts`，宿主的每幀迴圈裡沒有 kind。
 *
 * `residentBytes()` 的攤分規則、以及 `volume-3d` 在 Tier C 宣告
 * `unsupported ＋ server-render` 這件事，都已經是最終形狀。
 */

import type { Layer } from '../layers/types';
import { effectiveRenderStyle } from '../layers/types';
import { imageCpuBackend, maskFillCpuBackend, maskOutlineCpuBackend } from './cpuBackends';
import { registerLayerKind } from './kinds';
import { registerLayerRenderer } from './registry';
import { msg } from '../i18n';
import type { Bounds, LayerHandle, RenderContextCommon } from './types';

/** 一個 renderer 的資源帳（共用時攤分）。 */
export interface SharedResource {
  readonly key: string;
  readonly bytes: number;
  refCount: number;
}

const sharedResources = new Map<string, SharedResource>();

/**
 * 取得或建立共用資源。
 *
 * 兩種共用同時存在：**跨 viewport**（四格版面共用同一份 volume／pack texture）
 * 與**跨結構**（`mask-fill` 的一張打包 texture 最多 8 個結構共用）。
 */
export function retainSharedResource(key: string, bytes: number): SharedResource {
  const existing = sharedResources.get(key);
  if (existing) {
    existing.refCount += 1;
    return existing;
  }
  const created: SharedResource = { key, bytes, refCount: 1 };
  sharedResources.set(key, created);
  return created;
}

/** 釋放最後一個 ref 才真正 free。 */
export function releaseSharedResource(key: string): boolean {
  const existing = sharedResources.get(key);
  if (!existing) return false;
  existing.refCount -= 1;
  if (existing.refCount <= 0) {
    sharedResources.delete(key);
    return true;
  }
  return false;
}

export function sharedResourceCount(): number {
  return sharedResources.size;
}

export function clearSharedResources(): void {
  sharedResources.clear();
}

export interface StubHandleOptions {
  viewportId: string;
  layerId: string;
  rendererId: string;
  isSubstitute?: boolean;
  /** 這個 handle 佔用的資源。共用資源以 key 表示，`residentBytes()` 自動攤分。 */
  resource?: { key: string; bytes: number };
  /** 獨佔資源（不與任何人共用）的位元組數。 */
  ownBytes?: number;
}

/**
 * 建立一個「記帳正確但不畫像素」的 handle。
 *
 * **`residentBytes()` 的攤分是真的**——這是資源記帳要求的行為，
 * 也是 LRU 能有解析度的前提。
 */
export function makeStubHandle(opts: StubHandleOptions): LayerHandle {
  let visible = true;
  let opacity = 1;
  let disposed = false;
  let dirty: Bounds | null = null;
  const resource = opts.resource ? retainSharedResource(opts.resource.key, opts.resource.bytes) : null;

  return {
    viewportId: opts.viewportId,
    layerId: opts.layerId,
    rendererId: opts.rendererId,
    isSubstitute: opts.isSubstitute ?? false,
    setVisible(v) {
      visible = v;
    },
    setOpacity(o) {
      opacity = o;
    },
    invalidate(worldBounds) {
      dirty = worldBounds;
    },
    residentBytes() {
      if (disposed) return 0;
      const own = opts.ownBytes ?? 0;
      if (!resource) return own;
      // 🔴 攤分，不是整份大小
      return own + Math.round(resource.bytes / Math.max(1, resource.refCount));
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      visible = false;
      opacity = 0;
      dirty = null;
      if (opts.resource) releaseSharedResource(opts.resource.key);
    },
    // 供測試檢視（不在介面上，因此不會被渲染路徑誤用）
    ...({ _debug: () => ({ visible, opacity, dirty, disposed }) } as Record<string, unknown>),
  };
}

/**
 * 第一版的 `render()`：**記帳正確、不畫像素**。
 *
 * 型別簽章已經是最終形狀（吃 `GpuContext` / `CpuContext` / `VectorContext`
 * 都相容於 `RenderContextCommon`），因此之後換成真正的光柵化時
 * **不需要改註冊表**。
 */
function notImplemented<C extends RenderContextCommon>(
  rendererId: string,
): (ctx: C, layer: Layer, data: unknown) => LayerHandle {
  return (ctx, layer) =>
    makeStubHandle({
      viewportId: ctx.viewportId,
      layerId: layer.layerId,
      rendererId,
    });
}

/** 註冊核心內建的 renderer 與 kind。**冪等**（重複呼叫會被註冊表拒絕，故先檢查）。 */
export function registerBuiltins(): void {
  // ── 六個 renderer ────────────────────────────────────────────────────────

  registerLayerRenderer({
    rendererId: 'image',
    form: 'F1',
    zBand: 'image',
    supportsTemporal: true,
    // GPU：3D texture ＋ shader（未實作）
    gpu: { kind: 'supported', render: notImplemented('image') },
    // 🔴 **CPU 是真的在畫的那一份**（主線）。實作見 `cpuBackends.ts`
    cpu: imageCpuBackend,
  });

  // 🔴 outline 與 fill 是**兩個 renderer**，因此是兩個 zBand、兩份資源
  registerLayerRenderer({
    rendererId: 'mask-outline',
    form: 'F3',
    zBand: 'annotation',
    supportsTemporal: true,
    // 免費午餐：`drawMaskOutline` 只用 `project()` 與向量出口，
    // 因此之後接 GPU 時**同一份實作可以原封不動當 gpu 後端**。
    // 現在還掛 notImplemented 是因為 GPU 路徑的上下文（vtk renderer、
    // 共用 texture）還沒有實體，不是因為這份實作不適用。
    gpu: { kind: 'supported', render: notImplemented('mask-outline') },
    cpu: maskOutlineCpuBackend,
  });

  registerLayerRenderer({
    rendererId: 'mask-fill',
    form: 'F1',
    zBand: 'overlay',
    supportsTemporal: true,
    // GPU：位元打包 shader（未實作）
    gpu: { kind: 'supported', render: notImplemented('mask-fill') },
    // CPU：合成器直接疊，**不打包**
    cpu: maskFillCpuBackend,
  });

  registerLayerRenderer({
    rendererId: 'mesh',
    form: 'F2',
    zBand: 'overlay',
    gpu: { kind: 'supported', render: notImplemented('mesh') },
    // Tier C：軟體三角形光柵化（未實作）
    cpu: { kind: 'supported', render: notImplemented('mesh') },
  });

  registerLayerRenderer({
    rendererId: 'measurement',
    form: 'F3',
    zBand: 'annotation',
    // 量測層是唯一不需要為兩條渲染路徑各寫一份的東西
    gpu: { kind: 'supported', render: notImplemented('measurement') },
    cpu: { kind: 'supported', render: notImplemented('measurement') },
  });

  registerLayerRenderer({
    rendererId: 'volume-3d',
    form: 'F1',
    zBand: 'image',
    gpu: { kind: 'supported', render: notImplemented('volume-3d') },
    cpu: {
      kind: 'unsupported',
      reason: msg('這台電腦沒有可用的 GPU 路徑，互動式 3D 會太慢（CPU ray-cast 逾 1 s/幀）—— 3D 格改由伺服器出靜態圖'),
      fallback: { to: 'server-render', endpoint: 'render3d' },
    },
  });

  // ── 四個 kind ────────────────────────────────────────────────────────────

  registerLayerKind({
    kind: 'image',
    resolveRenderers: (_l, vp) => (vp.is3D ? ['volume-3d'] : ['image']),
  });

  registerLayerKind({
    kind: 'mesh',
    // mesh 僅存在於 3D viewport —— **現在是資料，不是散文**
    resolveRenderers: (_l, vp) => (vp.is3D ? ['mesh'] : []),
  });

  registerLayerKind({
    kind: 'measurement',
    resolveRenderers: () => ['measurement'],
  });

  registerLayerKind({
    kind: 'mask',
    resolveRenderers: (layer, vp) => {
      if (vp.is3D) return []; // 3D 裡結構走 mesh layer
      const style = effectiveRenderStyle(layer);
      if (style === 'fill') return ['mask-fill'];
      if (style === 'outline') return ['mask-outline']; // 預設
      return ['mask-fill', 'mask-outline'];
    },
  });
}
