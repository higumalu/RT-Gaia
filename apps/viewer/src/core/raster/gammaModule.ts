/**
 * γ 模組 —— `kind:'gamma'` ＋ 兩個 renderer（色階、γ ＝ 1 的線）。
 *
 * γ 圖是 F1 純量場，體素走跟劑量同一條路（後端 `quantity=gamma` 的暫存結果、float32），但**不是劑量**：
 * 自己一個 kind，所以只認得劑量的地方（DVH、運算、圖例的 Gy、% 處方）碰不到它。
 *
 * ## 色階
 *
 * 通過與失敗分成色階的兩半：γ ∈ [0, 1] → [0, 0.5]（藍 → 淺綠），γ ∈ (1, γ 上限] → (0.5, 1]（黃 → 紅）。
 * 不管 γ 上限是 2 還是 3，1 永遠在正中間、顏色在那裡斷開 —— 「過還是沒過」一眼看得出來。
 *
 * ## `Layer.params`
 *
 * ```
 * max_gamma     後端的 γ 上限（≥ 上限的點記成上限）
 * gamma         統計（通過率、失敗分類…；面板用）
 * ── 前端可改的顯示參數 ──
 * colorwash     boolean（預設 true）
 * isolines      boolean：γ ＝ 1 的線（預設 true）
 * fail_only     boolean：只塗 γ > 1 的點（預設 false）
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

export const GAMMA_KIND = 'gamma';
export const GAMMA_COLORWASH_RENDERER = 'gamma-colorwash';
export const GAMMA_ISOLINE_RENDERER = 'gamma-isoline';
export const GAMMA_COLORMAP = 'gamma';
const ISOLINE_WIDTH_PX = 1.5;
const FAIL_LINE_RGB: readonly [number, number, number] = [255, 64, 32];

export interface GammaDisplay {
  readonly maxGamma: number;
  readonly colorwash: boolean;
  readonly isolines: boolean;
  readonly failOnly: boolean;
}

export function gammaDisplayOf(layer: Pick<Layer, 'params'>): GammaDisplay {
  const p = layer.params ?? {};
  const m = typeof p['max_gamma'] === 'number' && Number.isFinite(p['max_gamma']) && p['max_gamma'] > 1 ? p['max_gamma'] : 2;
  return { maxGamma: m, colorwash: p['colorwash'] !== false, isolines: p['isolines'] !== false, failOnly: p['fail_only'] === true };
}

/** γ 在色階上的位置（0–1）：通過的在下半、失敗的在上半，1 在正中間。色階條與 colorwash 共用。 */
export function gammaColorFraction(gamma: number, maxGamma: number): number {
  if (!(gamma > 0)) return 0;
  if (gamma <= 1) return 0.5 * gamma;
  return Math.min(1, 0.5 + (0.5 * (gamma - 1)) / Math.max(1e-6, maxGamma - 1));
}

/** 色階：0 深藍 → 0.5⁻ 淺綠 ｜ 0.5⁺ 黃 → 1 紅。 */
export function gammaLut(): Uint8Array {
  const lut = new Uint8Array(768);
  const lerp = (a: readonly number[], b: readonly number[], f: number): number[] => a.map((v, i) => v + (b[i]! - v) * f);
  for (let i = 0; i < 256; i += 1) {
    const rgb = i < 128 ? lerp([20, 50, 150], [150, 220, 150], i / 127) : lerp([255, 220, 40], [210, 20, 20], (i - 128) / 127);
    lut[i * 3] = Math.round(rgb[0]!);
    lut[i * 3 + 1] = Math.round(rgb[1]!);
    lut[i * 3 + 2] = Math.round(rgb[2]!);
  }
  return lut;
}

function drawColorwash(ctx: CpuContext, layer: Layer): void {
  const d = gammaDisplayOf(layer);
  if (!d.colorwash) return;
  const plane = reslicedDose(ctx, layer);
  if (plane === null) return;
  const gray = new Uint8Array(plane.length);
  const coverage = new Uint8Array(plane.length);
  for (let i = 0; i < plane.length; i += 1) {
    const v = plane[i]!;
    // NaN ＝ 沒評估（低劑量門檻以下、被評估劑量沒資料、網格外）→ 透明
    if (Number.isNaN(v) || v < 0 || (d.failOnly && v <= 1)) continue;
    coverage[i] = 1;
    gray[i] = Math.round(gammaColorFraction(v, d.maxGamma) * 255);
  }
  compositeOver({ target: ctx.target, gray, lut: getColormap(GAMMA_COLORMAP), opacity: layer.opacity, coverage, thresholdU8: 0 });
}

function drawIsoline(ctx: CpuContext, layer: Layer): void {
  const d = gammaDisplayOf(layer);
  if (!d.isolines) return;
  const plane = reslicedDose(ctx, layer);
  if (plane === null) return;
  const segments = ctx.resampler.marchingSquares(isolineField(plane), ctx.target.width, ctx.target.height, 1);
  const n = segments.length / 4;
  if (n === 0) return;
  const style: VectorStyle = { strokeRgba: [...FAIL_LINE_RGB, Math.min(1, layer.opacity + 0.3)], lineWidthPx: ISOLINE_WIDTH_PX };
  ctx.paths.begin(`${layer.layerId}#gamma1`, style);
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

/** 註冊 γ 模組。冪等。 */
export function registerGammaModule(): void {
  if (!hasColormap(GAMMA_COLORMAP)) registerColormap(GAMMA_COLORMAP, gammaLut());
  if (hasLayerRenderer(GAMMA_COLORWASH_RENDERER)) return;
  registerLayerRenderer({
    rendererId: GAMMA_COLORWASH_RENDERER,
    form: 'F1',
    zBand: 'overlay',
    supportsTemporal: false,
    gpu: notImplemented(GAMMA_COLORWASH_RENDERER) as never,
    cpu: { kind: 'supported', render: attach(GAMMA_COLORWASH_RENDERER), draw: drawColorwash },
  });
  registerLayerRenderer({
    rendererId: GAMMA_ISOLINE_RENDERER,
    form: 'F3',
    zBand: 'annotation',
    supportsTemporal: false,
    gpu: notImplemented(GAMMA_ISOLINE_RENDERER) as never,
    cpu: { kind: 'supported', render: attach(GAMMA_ISOLINE_RENDERER), draw: drawIsoline },
  });
  registerLayerKind({
    kind: GAMMA_KIND,
    resolveRenderers: (layer, vp) => {
      if (vp.is3D) return [];
      const d = gammaDisplayOf(layer);
      return [...(d.colorwash ? [GAMMA_COLORWASH_RENDERER] : []), ...(d.isolines ? [GAMMA_ISOLINE_RENDERER] : [])];
    },
  });
}
