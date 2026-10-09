/**
 * `image` 與 `mask-outline` 的 **CPU 後端實作**。
 *
 * ## 這個檔案存在的理由
 *
 * 這兩段程式碼原本內聯在 `CpuViewportRenderer` 裡，並且**硬編碼
 * `layer.kind === 'image'` 與 `layer.kind === 'mask'`** —— 也就是說，
 * 註冊表存在、六個 renderer 都註冊了，但真正在畫的那條路徑完全繞過它，
 * 而註冊的六個 `render()` 全是 `notImplemented()`。架構要禁止的那個
 * `if (kind === ...)`，第一個違反者是核心自己。
 *
 * 搬到這裡之後：
 *
 * * 宿主（`CpuViewportRenderer`）的迴圈裡沒有任何 `kind` 判斷 —— 它只做
 *   「`resolveRenderers(layer, vp)` → 取 plugin → 呼叫 `draw`」
 * * 加一個新的 mask 顯示方式＝註冊一個 plugin，不必改宿主
 * * 之後接 GPU 時，`mask-outline` 的實作**可以原封不動**當 gpu 後端用
 *   （免費午餐：它只用 `project()` 與向量出口）
 */

import { viewInFrame, type ViewReference } from '../geometry';
import {
  planSlabOutline,
  SLAB_NOTICE_THRESHOLD_MM,
  type SlabOutlineSemantics,
} from '../overlay/outlineOverlay';
import type { Layer } from '../layers/types';
import { makeStubHandle } from './builtins';
import { getColormap } from './colormaps';
import { compositeOver, coverageFromPlane } from './composite';
import type { Backend, CpuContext, LayerHandle, VectorStyle, ReslicePlaneArgs, LayerVoxels } from './types';

/** CT 之外的空氣值（讀數與閾值筆刷用）。 */
export const OUTSIDE_HU = -1024;

/**
 * 重切時落在 volume 外的哨兵：**NaN，不是 −1024**。
 *
 * 多影像疊合時 FOV 外必須**透明**：CBCT 的 FOV 比計畫 CT 小，塗 −1024 會用一個
 * 黑方框把下面的 CT 蓋掉。合成器以 NaN 算 coverage（`coverageFromPlane`）。
 */
export const OUTSIDE_SENTINEL = Number.NaN;

/**
 * 這個 layer 該用的視平面：primary 世界座標的 `ctx.camera` 搬進 layer 自己的 FoR。
 * 單序列與 primary 零成本（回同一個物件）。
 *
 * 🔴 **每個吃體素的 renderer 都必須經這裡**，影像／輪廓／劑量才會一起動。
 */
export function viewForLayer(ctx: CpuContext, layer: Layer): ViewReference {
  let fg;
  try {
    fg = ctx.frameGroup(layer.frameOfReferenceUid);
  } catch {
    fg = null;
  }
  return viewInFrame(ctx.camera, fg ?? null);
}

/** 沒有 `color` 的 mask 的預設描邊色。 */
const DEFAULT_MASK_RGB: [number, number, number] = [255, 220, 0];

const OUTLINE_LINE_WIDTH_PX = 1.5;

/**
 * `image` 的 CPU 後端：重切 → window → 色階 → 以 `opacity` 疊進 `ImageData`。
 *
 * 🔴 **寫進 `ctx.target`，不自己碰 canvas。** 合成器（宿主）負責把 target
 * 貼上去並處理互動態的降解析度放大 —— renderer 不該知道那件事存在。
 *
 * 視平面先搬進 layer 自己的 FoR（`viewForLayer`）；volume 外為 NaN
 * → 透明；`layer.opacity` 與 `layer.colormap` 真的生效（「image 依 order
 * 由下往上以 opacity 混合」）。
 */
/**
 * `image` 層本地重切的完整參數 —— **只有這一處**。hybrid 重切用同一個函式算出快取 key，
 * 伺服器回來的高品質平面才會被下一幀的 `drawImage` 命中。
 */
export function imageResliceArgs(
  entry: { voxels: Int16Array | Uint8Array | Float32Array; volumeKey: string; grid: LayerVoxels['grid'] },
  view: ViewReference,
  outSizePx: [number, number],
  pxMm: number,
): ReslicePlaneArgs & { volumeKey: string } {
  return {
    volume: entry.voxels,
    volumeKey: entry.volumeKey,
    grid: entry.grid,
    view,
    outSizePx,
    pxMm,
    // slab > 0 時取平均：階梯 artifact 緩解
    blend: view.slabThicknessMm > 0 ? 'mean' : 'center',
    outside: OUTSIDE_SENTINEL,
  };
}

function drawImage(ctx: CpuContext, layer: Layer): void {
  const entry = ctx.voxels(layer);
  if (entry === null) return;

  const target = ctx.target;
  const view = viewForLayer(ctx, layer);
  const plane = ctx.resampler.reslicePlane(imageResliceArgs(entry, view, [target.width, target.height], ctx.pxMm));

  const window = layer.windowLevel ?? entry.defaultWindow ?? { center: 40, width: 400 };
  const gray = ctx.resampler.windowToU8(plane, window.center, window.width);
  const checker = layer.params?.['checkerboard_px'];
  compositeOver({
    target,
    gray,
    lut: getColormap(layer.colormap),
    opacity: layer.opacity,
    coverage: coverageFromPlane(plane),
    // 棋盤格／差值。棋盤格大小以輸出平面像素計，互動態降解析度時同步縮小
    blendMode: layer.blendMode ?? 'normal',
    ...(typeof checker === 'number'
      ? { checkerPx: checker * (ctx.viewportSize.w > 0 ? target.width / ctx.viewportSize.w : 1) }
      : {}),
  });
}

/**
 * `mask-outline` 的後端：mask 區塊 → 等值線 → 向量出口（預設模式）。
 *
 * 🔴 **吃 `CpuContext` 但只用到 `VectorContext` 的部分 ＋ `resampler`。**
 * 走 `ctx.paths`（`CanvasPathSink`）而不是自己拿 canvas 2D context：
 * 座標緩衝重用與統計都在那裡，內聯版本沒有。
 *
 * slab 的語意走 `planSlabOutline`：暫定一律取中心面，並在超過
 * 2 mm 時經 `ctx.notice()` 要求畫面上常駐標示 —— 否則使用者會以為這條線
 * 涵蓋整個厚度。
 */
function drawMaskOutline(ctx: CpuContext, layer: Layer): void {
  const entry = ctx.voxels(layer);
  if (entry === null) return;
  if (!(entry.voxels instanceof Uint8Array)) return; // mask 一律 u8

  // slab 輪廓語意是**這一格**的顯示設定（A 預設、三種可切換），不是 layer 的
  const requested = ctx.viewportParams?.['slabOutlineSemantics'] as SlabOutlineSemantics | undefined;
  const plan = planSlabOutline({
    slabThicknessMm: ctx.camera.slabThicknessMm,
    quality: ctx.quality,
    ...(requested ? { semantics: requested } : {}),
  });
  if (plan.notice !== null) {
    // 角落標示只說語意，不逐結構重複（20 個結構 20 行會把角落塞滿）
    ctx.notice(plan.notice);
  }

  const target = ctx.target;
  const view = viewForLayer(ctx, layer);
  const [r, g, b] = layer.color ?? DEFAULT_MASK_RGB;
  const base = {
    mask: entry.voxels,
    volumeKey: entry.volumeKey,
    grid: entry.grid,
    outSizePx: [target.width, target.height] as [number, number],
    pxMm: ctx.pxMm,
  };
  // 🔴 線寬不隨互動態的解析度縮放而變：粗細是使用者的視覺定錨，
  // 互動中忽粗忽細比「略粗糙」難用得多。
  const stroke = (segments: Float32Array, alpha: number, suffix = ''): void => {
    const segmentCount = segments.length / 4;
    if (segmentCount === 0) return;
    const style: VectorStyle = { strokeRgba: [r, g, b, alpha], lineWidthPx: OUTLINE_LINE_WIDTH_PX };
    ctx.paths.begin(`${layer.layerId}${suffix}`, style);
    ctx.paths.segments(segments, segmentCount);
    ctx.paths.end();
  };

  if (plan.semantics === 'stacked') {
    // 語意 C：slab 內每個取樣面各描一條，離中心面越遠越淡
    const n = plan.samplePlanes;
    const half = view.slabThicknessMm / 2;
    for (let i = 0; i < n; i += 1) {
      const offset = n === 1 ? 0 : -half + (view.slabThicknessMm * i) / (n - 1);
      const planeView = {
        ...view,
        slabThicknessMm: 0,
        planeOrigin: [
          view.planeOrigin[0] + view.viewPlaneNormal[0] * offset,
          view.planeOrigin[1] + view.viewPlaneNormal[1] * offset,
          view.planeOrigin[2] + view.viewPlaneNormal[2] * offset,
        ] as const,
      };
      const fade = half > 0 ? 1 - 0.6 * (Math.abs(offset) / half) : 1;
      stroke(ctx.resampler.maskOutline({ ...base, view: planeView, blend: 'center' }), layer.opacity * fade, `#${i}`);
    }
    return;
  }
  // 語意 A（中心面，1 次取樣）與 B（聯集：mip ＋ N 次取樣、1 次 marching squares）。
  // 融合入口：重切與 marching squares 一次過境，中間的 f32 平面留在 wasm。
  // 視平面同樣先搬進結構所屬 FoR（輪廓跟著它的影像一起動）。
  const segments = ctx.resampler.maskOutline({
    ...base,
    view,
    blend: plan.semantics === 'union-outer' ? 'mip' : 'center',
    ...(plan.semantics === 'union-outer' ? { slabSamples: plan.samplePlanes } : {}),
  });
  stroke(segments, layer.opacity);
}

/** fill 的不透明度（乘在 layer.opacity 上）—— 填色是確認用，不能把影像蓋掉。 */
export const MASK_FILL_ALPHA = 0.35;

const fillLuts = new Map<string, Uint8Array>();

/** 單色 LUT（256 個都是同一色）：合成器吃 LUT，fill 只有一個顏色。 */
function solidLut(rgb: readonly [number, number, number]): Uint8Array {
  const key = rgb.join(',');
  let lut = fillLuts.get(key);
  if (lut === undefined) {
    lut = new Uint8Array(256 * 3);
    for (let i = 0; i < 256; i += 1) lut.set(rgb, i * 3);
    fillLuts.set(key, lut);
  }
  return lut;
}

/** 重切後的 mask 平面 → u8（≥ 0.5 ＝ 在結構內 ＝ 255；volume 外的 NaN 與 < 0.5 ＝ 0）。與輪廓同一個 0.5 等值線。 */
export function maskPlaneToU8(plane: Float32Array, out?: Uint8Array): Uint8Array {
  const u8 = out !== undefined && out.length === plane.length ? out : new Uint8Array(plane.length);
  for (let i = 0; i < plane.length; i += 1) u8[i] = plane[i]! >= 0.5 ? 255 : 0;
  return u8;
}

/**
 * `mask-fill` 的 CPU 後端 —— **合成器直接疊，不打包**（位元打包只是 GPU 路徑省 render pass 的手段）。
 * mask 重切到目前平面（slab 語意跟輪廓同一個計畫：中心面，或「聯集」時取 mip），≥ 0.5 的像素以結構顏色、
 * `layer.opacity × MASK_FILL_ALPHA` 疊進 `ctx.target`（zBand `overlay`：在影像之上、輪廓之下）。
 */
function drawMaskFill(ctx: CpuContext, layer: Layer): void {
  const entry = ctx.voxels(layer);
  if (entry === null || !(entry.voxels instanceof Uint8Array)) return;
  const requested = ctx.viewportParams?.['slabOutlineSemantics'] as SlabOutlineSemantics | undefined;
  const plan = planSlabOutline({ slabThicknessMm: ctx.camera.slabThicknessMm, quality: ctx.quality, ...(requested ? { semantics: requested } : {}) });
  const target = ctx.target;
  const view = viewForLayer(ctx, layer);
  const union = plan.semantics === 'union-outer';
  const plane = ctx.resampler.reslicePlane({
    volume: entry.voxels,
    volumeKey: entry.volumeKey,
    grid: entry.grid,
    view,
    outSizePx: [target.width, target.height],
    pxMm: ctx.pxMm,
    blend: union ? 'mip' : 'center',
    ...(union ? { slabSamples: plan.samplePlanes } : {}),
    outside: OUTSIDE_SENTINEL,
  });
  compositeOver({
    target,
    gray: maskPlaneToU8(plane),
    lut: solidLut(layer.color ?? DEFAULT_MASK_RGB),
    opacity: layer.opacity * MASK_FILL_ALPHA,
    thresholdU8: 1,
  });
}

/** 兩個後端共用的 handle 工廠。資源記帳走既有的攤分規則。 */
function attach(rendererId: string) {
  return (ctx: CpuContext, layer: Layer): LayerHandle =>
    makeStubHandle({
      viewportId: ctx.viewportId,
      layerId: layer.layerId,
      rendererId,
    });
}

/**
 * 型別刻意寫成 `Backend<CpuContext, unknown>` 的 `supported` 分支而不是讓它
 * 被推導 —— **這是編譯期的契約檢查**：簽章一旦與註冊表分岔，這裡就會紅，
 * 而不是等到執行期發現「註冊了但不會畫」。
 */
type SupportedCpuBackend = Extract<Backend<CpuContext, unknown>, { kind: 'supported' }>;

/** 這兩個後端**一定**會畫東西，因此 `draw` 不是選配 —— 型別說出來。 */
type DrawingCpuBackend = SupportedCpuBackend & { draw: NonNullable<SupportedCpuBackend['draw']> };

export const imageCpuBackend: DrawingCpuBackend = {
  kind: 'supported',
  render: attach('image'),
  draw: drawImage,
};

export const maskOutlineCpuBackend: DrawingCpuBackend = {
  kind: 'supported',
  render: attach('mask-outline'),
  draw: drawMaskOutline,
};

export const maskFillCpuBackend: DrawingCpuBackend = {
  kind: 'supported',
  render: attach('mask-fill'),
  draw: drawMaskFill,
};

export { SLAB_NOTICE_THRESHOLD_MM };
