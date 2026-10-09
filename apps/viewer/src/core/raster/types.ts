/**
 * 渲染註冊表的三個核心型別。
 *
 * 🔴 它們是 GPU 與 CPU 兩份實作之間
 * 唯一的契約，因此必須與註冊表同時定案——事後改要動本專案最貴的兩份
 * 程式碼。
 */

import type { FrameGroup, GridSet, TemporalGroup, Tier, Vec3, ViewReference } from '../geometry';
import type { Layer } from '../layers/types';

/** 型態分類。**單一值，不是集合。** */
export type Form = 'F1' | 'F2' | 'F3' | 'F4' | 'F5' | 'F6';

/** 取代硬編碼的混合順序。**單一值。** */
export type ZBand = 'image' | 'overlay' | 'annotation';

/** 品質狀態。**播放與靜止、互動與停止，都是這兩態。** */
export type Quality = 'interactive' | 'final';

/** `Tier` 只在 `geometry/displayGrid.ts` 定義一次，這裡只轉出。 */
export type { Tier };

export interface Vec2 {
  x: number;
  y: number;
}

export interface Bounds {
  /** 世界空間包圍盒（LPS mm）。 */
  min: Vec3;
  max: Vec3;
}

export interface ViewportInfo {
  readonly viewportId: string;
  readonly is3D: boolean;
  readonly width: number;
  readonly height: number;
}

/**
 * 渲染後端交還的控制權柄。生命週期由 `SceneManager` 擁有。
 *
 * 🔴 **鍵是 `(viewportId, layerId, rendererId)` 三者合起來**；一個 layer 可有
 * 多個 handle。
 */
export interface LayerHandle {
  readonly viewportId: string;
  readonly layerId: string;
  readonly rendererId: string;
  /** true = 這是 `FallbackSpec` 換上的替代表示，不是原始表示。 */
  readonly isSubstitute: boolean;
  setVisible(v: boolean): void;
  setOpacity(o: number): void;
  /** 標記需要重繪的世界空間包圍盒；null = 全部。 */
  invalidate(worldBounds: Bounds | null): void;
  /**
   * 目前佔用的記憶體，供 LRU 逐出決策。
   *
   * 🔴 **共用資源一律回報攤分後的量** `resource.bytes / resource.refCount`：
   * 跨 viewport 的 volume texture、跨結構的 pack texture。
   * 回報整份大小會讓記憶體高估 4×／8×，LRU 因此過度逐出。
   */
  residentBytes(): number;
  /** 釋放資源；`SceneManager` 在逐出或移除圖層時呼叫。 */
  dispose(): void;
}

export interface RenderContextCommon {
  /**
   * 🔴 **型別缺口，此處補上。**
   *
   * `LayerHandle` 的鍵是 `(viewportId, layerId, rendererId)`，但原本的
   * `RenderContextCommon` 沒有 `viewportId` —— renderer 的 `render()` 因此
   * 拿不到自己要放進 handle 的第一個欄位。四格版面下每個 layer 有四組 handle，
   * 缺這個欄位就無法建立它們。
   */
  readonly viewportId: string;
  readonly gridSet: GridSet;
  frameGroup(uid: string): FrameGroup;
  temporal(id: string): TemporalGroup;
  readonly camera: ViewReference;
  /**
   * 這一格的顯示參數袋：`slabOutlineSemantics` 等。**選填**——沒有就是預設。
   * 與 `Layer.params` 同一個精神：核心不認識鍵，renderer 自己讀。
   */
  readonly viewportParams?: Record<string, unknown>;
  readonly viewportSize: { w: number; h: number };
  /**
   * 這一幀輸出平面的 mm / 像素。
   *
   * 🔴 **已含互動態的降解析度**（`interactive` 以 1/2 線性解析度重切）。
   * renderer 因此不需要知道兩態品質這件事存在 —— 它只要照 `pxMm` 與
   * `target` 的尺寸重切，出來的幾何就是對的。
   */
  readonly pxMm: number;
  readonly quality: Quality;
  /** 世界座標 → canvas 像素。**F3/F4/F5 唯一需要的東西。** */
  project(world: Vec3): Vec2;
  /**
   * 這個 layer 目前的體素內容；`null` = 還沒進倉（尚未載入或已被 LRU 逐出）。
   *
   * 🔴 **由上下文提供，而不是由宿主先解析好再當 `data` 傳進來。**
   * 後者要求宿主知道「image renderer 要影像體素、mask-outline 要 mask 區塊」
   * —— 那正是要從核心移除的知識。這樣寫，宿主的迴圈裡沒有任何一個
   * `kind === '...'`。
   */
  voxels(layer: Layer): LayerVoxels | null;
  /**
   * 這一幀要常駐在畫面上的說明（slab 角落標示是第一個使用者）。
   *
   * renderer 說得出「我畫的是 slab 中心面」，宿主說不出來 —— 因此這個出口
   * 屬於上下文，不是宿主自己拼字串。
   */
  notice(text: string): void;
}

/**
 * 一個 layer 的體素內容 —— renderer 與體素倉之間的**結構型**契約。
 *
 * 刻意不 import `core/scene/volumeStore`：那會讓 `core/raster` 依賴 `core/scene`，
 * 而 `SceneManager` 本來就依賴 `core/raster`（迴圈）。這裡只描述形狀。
 */
export interface LayerVoxels {
  readonly voxels: Int16Array | Uint8Array | Float32Array;
  readonly grid: GridSet['maskGrid']['grid'];
  /**
   * 重切核心的快取鍵。
   *
   * 🔴 **本地編輯後必須改變**，否則核心會拿舊的上傳體素重切 —— 症狀是
   * 「畫上去了但輪廓沒動」。
   */
  readonly volumeKey: string;
  /** 影像才有；mask 為 undefined。 */
  readonly defaultWindow?: { center: number; width: number };
}

/**
 * GPU 後端的上下文。
 *
 * `renderer` 的型別刻意是 `unknown`：`core/raster` 不該在型別層綁死
 * `@cornerstonejs/core` 的版本，而 GPU 後端的實作本來就會自己 cast。
 * （SOUP 耦合：Cornerstone 內嵌了自己的 vtk.js patch 版本。）
 */
export interface GpuContext extends VectorContext {
  readonly renderer: unknown;
  /** 取得共用的 3D texture，避免每個 actor 各自上傳。 */
  sharedTexture(payloadHash: string): SharedTexture;
  addActor(actor: unknown): void;
}

export interface SharedTexture {
  readonly payloadHash: string;
  readonly bytes: number;
  readonly refCount: number;
  retain(): void;
  release(): void;
}

/** WASM 重切核心的介面。實作見 `resliceKernel.ts`。 */
export interface ResliceKernel {
  readonly abiVersion: number;
  reslicePlane(args: ReslicePlaneArgs & { volumeKey: string }): Float32Array;
  windowToU8(plane: Float32Array, center: number, width: number): Uint8Array;
  marchingSquares(field: Float32Array, w: number, h: number, level: number): Float32Array;
  stitch(segments: Float32Array): Float32Array[];
  /**
   * mask 區塊 → 輪廓 segment soup，**一次 FFI 呼叫**。
   *
   * 分成 `reslicePlane()` ＋ `marchingSquares()` 的話，中間那份 f32 平面要
   * wasm→JS→wasm 來回一趟，而**沒有任何人看它**。512² 上就是每結構每幀約
   * 4 MB 的配置週轉。
   */
  maskOutline(args: MaskOutlineArgs): Float32Array;
  dispose(): void;
}

export interface MaskOutlineArgs {
  mask: Uint8Array;
  volumeKey: string;
  grid: GridSet['maskGrid']['grid'];
  view: ViewReference;
  outSizePx: [number, number];
  pxMm: number;
  level?: number;
  maxSegments?: number;
  /**
   * slab 內的取樣方式。
   * `center`（預設）＝ 語意 A；`mip` ＋ `slabSamples` ＝ 語意 B（逐像素 max 就是聯集）。
   */
  blend?: 'center' | 'mip';
  slabSamples?: number;
}

export interface ReslicePlaneArgs {
  volume: Int16Array | Uint8Array | Float32Array;
  grid: GridSet['maskGrid']['grid'];
  view: ViewReference;
  outSizePx: [number, number];
  pxMm: number;
  blend?: 'center' | 'mip' | 'mean' | 'composite';
  slabSamples?: number;
  outside?: number;
}

export interface WorkerPool {
  readonly size: number;
  run<T>(task: string, payload: unknown): Promise<T>;
}

/**
 * CPU 後端的上下文。
 *
 * 🔴 **`extends VectorContext`，而不是 `RenderContextCommon`。**
 *
 * 「免費午餐」說的是 F3/F4/F5 只需要 `project()` 與一個向量出口，
 * 因此**同一個函式**可以同時當 GPU 與 CPU 後端。原本 `GpuContext` 與
 * `CpuContext` 都只 extends `RenderContextCommon`，於是那個論證在型別上不成立：
 * 寫給 `VectorContext` 的 `mask-outline` 實作**無法**指派給
 * `Backend<CpuContext, T>`，只能各寫一份 —— 而各寫一份正是這整個註冊表要避免的。
 *
 * 現在兩個上下文都提供向量出口，差別只在像素設施（`target`／`renderer`）。
 */
export interface CpuContext extends VectorContext {
  readonly resampler: ResliceKernel;
  /** 目的地像素緩衝；合成器依 `zBand` 順序疊加。 */
  readonly target: ImageData;
  /**
   * 分塊平行化的工作執行緒池。
   *
   * 🔴 **`null` 是正常值，不是錯誤**：執行緒池尚未實作，而且即使實作了，
   * 非 secure context（用 IP 連進來）也拿不到 `SharedArrayBuffer`。
   * 型別逼呼叫端表態，而不是給一個「看起來能用、其實是單執行緒」的假池。
   */
  readonly workers: WorkerPool | null;
}

/**
 * F3/F4/F5 共用的上下文（**不綁死 SVG**）。
 *
 * | 內容 | 每幀量級 | 需要 hit-test | 出口 |
 * |---|---|---|---|
 * | mask 輪廓（20 結構） | 數萬座標 | ❌ | `paths`（canvas 2D） |
 * | 等劑量線、DVF 流線 | 數千至數萬 | ❌ | `paths` |
 * | 量測控制點、crosshair handle | 每 viewport 數十節點 | ✅ | `svgRoot` |
 */
export interface VectorContext extends RenderContextCommon {
  readonly paths: VectorPathSink;
  readonly svgRoot: SVGGElement | null;
}

/**
 * canvas 2D 的向量出口。
 *
 * 🔴 **座標寫進重用的 `Float32Array`；每幀不得配置新緩衝、不得組字串**。
 * 每幀數萬座標的 GC 壓力會表現成週期性掉幀。
 */
export interface VectorPathSink {
  /** 開始一條來源（一個結構／一組等值線）的路徑批次。 */
  begin(sourceId: string, style: VectorStyle): void;
  /** 推入一段 polyline。`xy` 是**平面像素座標**，長度為 `2 * pointCount`。 */
  polyline(xy: Float32Array, pointCount: number, closed: boolean): void;
  /** 推入 segment soup（未縫合的輪廓，每 4 個 float 一段）。 */
  segments(xy: Float32Array, segmentCount: number): void;
  end(): void;
}

export interface VectorStyle {
  strokeRgba: [number, number, number, number];
  lineWidthPx: number;
  dash?: number[];
}

/**
 * 一個 renderer 的後端宣告。**兩者皆必填，但可宣告為不支援並指定退路。**
 *
 * ## `render`（掛載）與 `draw`（每幀）是兩件事
 *
 * 🔴 **原本只有 `render`，而它同時被描述成「交還 handle」與「畫出來」。**
 * 那兩件事的頻率差三個數量級：`render` 由 `SceneManager` 在 attach layer 時
 * **解析一次**（不是每幀），`draw` 是每一幀。混在一起的後果是
 * 沒有任何一個註冊過的 renderer 能真的畫東西 —— `CpuViewportRenderer` 因此
 * 繞過註冊表，直接硬編碼 `kind === 'image'` 與 `kind === 'mask'`，
 * 而六個 renderer 的 `render` 全是 `notImplemented()`。
 *
 * | | 誰呼叫 | 頻率 | 回傳 |
 * |---|---|---|---|
 * | `render` | `SceneManager.attachLayer` | 每個 `(viewport, layer, renderer)` 一次 | `LayerHandle`（資源記帳） |
 * | `draw` | viewport renderer 的每一幀 | 每幀 | 無 |
 *
 * `draw` 是選配：GPU 路徑上場景圖自己會畫，沒有「每幀主動塗」這件事。
 *
 * **現在補這個分野是刻意的**（時機論證）：一接上 GPU 路徑，
 * 改這個型別就要同時改本專案最貴的兩份程式碼。
 */
export type Backend<C, T> =
  | {
      kind: 'supported';
      render: (ctx: C, layer: Layer, data: T) => LayerHandle;
      draw?: (ctx: C, layer: Layer, data: T) => void;
    }
  | { kind: 'unsupported'; reason: string; fallback: FallbackSpec };

export interface FallbackContext {
  /** 🔴 抓資料一律經 transport 層，**渲染層不得自己 fetch**。 */
  readonly transport: TransportLike;
  readonly tier: Tier;
}

/** `core/raster` 只需要 transport 的這一面，因此不 import 具體實作。 */
export interface TransportLike {
  fetchMesh(structureId: string, opts: { lod: number; frameIndex: number | null }): Promise<ContentRef>;
  fetchRender3d(payload: unknown): Promise<ContentRef>;
  /** hybrid 重切：互動停止後向後端要 bspline 高品質重切。沒有就只用本地重切。 */
  fetchHighQualityReslice?(args: {
    viewReference: ViewReference;
    outputSizePx: [number, number];
    interpolator?: 'nearest' | 'linear' | 'bspline';
    seriesId?: string;
    pxMm?: number;
    outsideNaN?: boolean;
  }): Promise<{ header: Record<string, unknown>; plane: Float32Array }>;
}

export interface ContentRef {
  readonly kind: string;
  readonly ref: string;
  readonly data: unknown;
}

/**
 * 🔴 兩個 variant 原本都懸空：這裡帶了執行者、資料來源與端點。
 */
export type FallbackSpec =
  | {
      to: 'other-layer-kind';
      rendererId: string;
      /** 由 `SceneManager` 在建立 handle **之前**呼叫。 */
      resolveContent: (layer: Layer, ctx: FallbackContext) => Promise<ContentRef>;
      /** 必須讓使用者知道看到的不是原始表示。 */
      notice: string;
    }
  | { to: 'server-render'; endpoint: 'render3d' }
  | { to: 'hidden'; notice: string };

export interface LayerRendererPlugin<TData = unknown> {
  /** 🔴 **不是 `Layer.kind`**。例：`'mask-outline'` / `'mask-fill'`。 */
  readonly rendererId: string;
  readonly form: Form;
  readonly zBand: ZBand;
  readonly supportsTemporal?: boolean;
  readonly gpu: Backend<GpuContext, TData>;
  readonly cpu: Backend<CpuContext, TData>;
}

/**
 * `Layer.kind` → 要實例化哪些 renderer。
 *
 * **核心因此不認識 `'mask'`，也不認識 `renderStyle` 的三個值**。
 */
export interface LayerKindSpec {
  readonly kind: string;
  /** 純函式，不得有副作用；回傳空陣列 = 這個 layer 在這種 viewport 不顯示。 */
  resolveRenderers(layer: Layer, vp: ViewportInfo): string[];
}
