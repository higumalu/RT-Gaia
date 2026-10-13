/**
 * 不確定度模組 —— `kind:'uncertainty'` ＋ 兩個 renderer（色階、門檻線）。
 *
 * 劑量計算（Monte Carlo）每個體素的相對統計不確定度（1σ，%）。體素跟劑量走同一條路（後端 `quantity=uncertainty`
 * 的暫存結果、float32），但**不是劑量**：自己一個 kind，DVH、運算、圖例的 Gy、% 處方都碰不到它。
 * 低劑量區（< 參考最大值 10%）後端已經是 NaN → 透明。
 *
 * ## 色階
 *
 * 0 → 上限（`max_percent`，預設 10%）：深藍 → 青 → 黃 → 紅；≥ 上限塗最深的紅。門檻線（`threshold_percent`，預設 3%）
 * 是「這裡的雜訊本身就會讓 3% 的 γ 失敗」的分界。
 *
 * ## `Layer.params`
 *
 * ```
 * max_percent        色階上限（%）
 * threshold_percent  門檻線的值（%）
 * ── 前端可改的顯示參數 ──
 * colorwash          boolean（預設 true）
 * isolines           boolean：門檻線（預設 true）
 * ```
 */

import type { Layer } from '../layers/types';
import { makeStubHandle } from './builtins';
import { getColormap, hasColormap, registerColormap } from './colormaps';
import { compositeOver } from './composite';
import { isolineField, reslicedDose } from './doseModule';
import { registerLayerKind } from './kinds';
import { hasLayerRenderer, registerLayerRenderer } from './registry';
import type { Backend, CpuContext, LayerHandle, VectorStyle } from './types';

export const UNCERTAINTY_KIND = 'uncertainty';
export const UNCERTAINTY_COLORWASH_RENDERER = 'uncertainty-colorwash';
export const UNCERTAINTY_ISOLINE_RENDERER = 'uncertainty-isoline';
export const UNCERTAINTY_COLORMAP = 'uncertainty';
const ISOLINE_WIDTH_PX = 1.5;
const LINE_RGB: readonly [number, number, number] = [255, 255, 255];

export interface UncertaintyDisplay {
  readonly maxPercent: number;
  readonly thresholdPercent: number;
  readonly colorwash: boolean;
  readonly isolines: boolean;
}

export function uncertaintyDisplayOf(layer: Pick<Layer, 'params'>): UncertaintyDisplay {
  const p = layer.params ?? {};
  const num = (v: unknown, fallback: number): number => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : fallback);
  return { maxPercent: num(p['max_percent'], 10), thresholdPercent: num(p['threshold_percent'], 3), colorwash: p['colorwash'] !== false, isolines: p['isolines'] !== false };
}

/** 不確定度（%）在色階上的位置（0–1）。色階條與 colorwash 共用。 */
export function uncertaintyColorFraction(percent: number, maxPercent: number): number {
  if (!(percent > 0)) return 0;
  return Math.min(1, percent / Math.max(1e-6, maxPercent));
}

/** 色階：0 深藍 → 1/3 青 → 2/3 黃 → 1 紅。 */
export function uncertaintyLut(): Uint8Array {
  const stops: readonly (readonly number[])[] = [
    [20, 40, 140],
    [40, 190, 200],
    [250, 220, 50],
    [200, 20, 20],
  ];
  const lut = new Uint8Array(768);
  for (let i = 0; i < 256; i += 1) {
    const f = (i / 255) * (stops.length - 1);
    const k = Math.min(stops.length - 2, Math.floor(f));
    const u = f - k;
    for (let c = 0; c < 3; c += 1) lut[i * 3 + c] = Math.round(stops[k]![c]! + (stops[k + 1]![c]! - stops[k]![c]!) * u);
  }
  return lut;
}

function drawColorwash(ctx: CpuContext, layer: Layer): void {
  const d = uncertaintyDisplayOf(layer);
  if (!d.colorwash) return;
  const plane = reslicedDose(ctx, layer);
  if (plane === null) return;
  const gray = new Uint8Array(plane.length);
  const coverage = new Uint8Array(plane.length);
  for (let i = 0; i < plane.length; i += 1) {
    const v = plane[i]!;
    // NaN ＝ 低劑量區、沒有劑量、網格外 → 透明
    if (Number.isNaN(v) || v < 0) continue;
    coverage[i] = 1;
    gray[i] = Math.round(uncertaintyColorFraction(v, d.maxPercent) * 255);
  }
  compositeOver({ target: ctx.target, gray, lut: getColormap(UNCERTAINTY_COLORMAP), opacity: layer.opacity, coverage, thresholdU8: 0 });
}

function drawIsoline(ctx: CpuContext, layer: Layer): void {
  const d = uncertaintyDisplayOf(layer);
  if (!d.isolines) return;
  const plane = reslicedDose(ctx, layer);
  if (plane === null) return;
  const segments = ctx.resampler.marchingSquares(isolineField(plane), ctx.target.width, ctx.target.height, d.thresholdPercent);
  const n = segments.length / 4;
  if (n === 0) return;
  const style: VectorStyle = { strokeRgba: [...LINE_RGB, Math.min(1, layer.opacity + 0.3)], lineWidthPx: ISOLINE_WIDTH_PX };
  ctx.paths.begin(`${layer.layerId}#threshold`, style);
  ctx.paths.segments(segments, n);
  ctx.paths.end();
}

function attach(rendererId: string) {
  return (ctx: CpuContext, layer: Layer): LayerHandle => makeStubHandle({ viewportId: ctx.viewportId, layerId: layer.layerId, rendererId });
}

type SupportedCpuBackend = Extract<Backend<CpuContext, unknown>, { kind: 'supported' }>;

function notImplemented(rendererId: string): SupportedCpuBackend {
  return { kind: 'supported', render: attach(rendererId) };
}

/** 註冊不確定度模組。冪等。 */
export function registerUncertaintyModule(): void {
  if (!hasColormap(UNCERTAINTY_COLORMAP)) registerColormap(UNCERTAINTY_COLORMAP, uncertaintyLut());
  if (hasLayerRenderer(UNCERTAINTY_COLORWASH_RENDERER)) return;
  registerLayerRenderer({
    rendererId: UNCERTAINTY_COLORWASH_RENDERER,
    form: 'F1',
    zBand: 'overlay',
    supportsTemporal: false,
    gpu: notImplemented(UNCERTAINTY_COLORWASH_RENDERER) as never,
    cpu: { kind: 'supported', render: attach(UNCERTAINTY_COLORWASH_RENDERER), draw: drawColorwash },
  });
  registerLayerRenderer({
    rendererId: UNCERTAINTY_ISOLINE_RENDERER,
    form: 'F3',
    zBand: 'annotation',
    supportsTemporal: false,
    gpu: notImplemented(UNCERTAINTY_ISOLINE_RENDERER) as never,
    cpu: { kind: 'supported', render: attach(UNCERTAINTY_ISOLINE_RENDERER), draw: drawIsoline },
  });
  registerLayerKind({
    kind: UNCERTAINTY_KIND,
    resolveRenderers: (layer, vp) => {
      if (vp.is3D) return [];
      const d = uncertaintyDisplayOf(layer);
      return [...(d.colorwash ? [UNCERTAINTY_COLORWASH_RENDERER] : []), ...(d.isolines ? [UNCERTAINTY_ISOLINE_RENDERER] : [])];
    },
  });
}
