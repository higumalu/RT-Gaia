/**
 * 劑量模組 —— `kind:'dose'` ＋ 兩個 renderer。
 *
 * ## 為什麼是一個「模組」而不是核心的第七個 kind
 *
 * 核心只認識註冊表與介面。劑量是 F1 純量場的**一個實例**，它的顯示參數
 * （閾值、等劑量線的 level、絕對 Gy 或 % 處方）全部住在 `Layer.params`，
 * 核心一個欄位都不必加。這個檔案是「第一個非核心 kind」，也是之後 DVF／Jacobian
 * 模組的樣板：一個 `register*()`，裡面是 kind 的 `resolveRenderers` 與 renderer 的
 * 兩條後端。
 *
 * ## 兩個 renderer（兩類 overlay）
 *
 * | rendererId | 型態 | zBand | 做什麼 |
 * |---|---|---|---|
 * | `dose-colorwash` | F1 `scalar-overlay` | `overlay` | 重切 f32 → 正規化 → 色階 → 以 opacity 疊在影像上，低於閾值透明 |
 * | `dose-isolines` | F3 `vector-overlay` | `annotation` | 同一張 f32 平面逐 level 跑 marching squares → 向量出口 |
 *
 * 設計偏好：**能用向量表達的就不要畫進像素** —— 等劑量線是 F3，兩條渲染
 * 路徑共用（只需要 `project()` 與向量出口）。
 *
 * ## `Layer.params`（snake_case，後端原樣送來）
 *
 * ```
 * max_gy            後端算好的最大劑量（正規化用）
 * units             'GY' | 'RELATIVE'
 * prescription_gy   [..]  RTPLAN 的處方（可能空）
 * referenced_plan_label
 * ── 以下是前端可改的顯示參數 ──
 * colorwash         boolean（預設 true）
 * isolines          boolean（預設 true）
 * colormap          色階名（預設 'jet'）
 * display           'absolute' | 'percent'（預設 absolute）
 * reference_gy      percent 模式的 100%（預設處方，沒處方就 max_gy）
 * threshold_gy      colorwash 的低劑量截止（預設 10% 參考劑量）
 * levels            等劑量線的 level：absolute 時是 Gy、percent 時是 %
 * level_colors      使用者改過的線色 `{ [levelKey(Gy)]: '#rrggbb' }`；沒改的照色階
 * ```
 *
 * ## 等劑量線的預設
 *
 * 沒有 `levels` 時依序：使用者存的預設（`setUserIsodoseDefault`，% 參考劑量）→ 有處方用 % 處方清單
 * → 沒處方（絕對值顯示）自動等距：間距取 1-2-5 序列裡最小、線數 ≤ 12 的那個（`autoIsodoseLevelsGy`）。
 * 單次分次劑量（Dmax 2.24 Gy）用整數 Gy 只會有 1、2 兩條，所以不固定 1 Gy。
 */

import type { Layer } from '../layers/types';
import { makeStubHandle } from './builtins';
import { getColormap } from './colormaps';
import { compositeOver, coverageFromPlane, normalizeToU8 } from './composite';
import { OUTSIDE_SENTINEL, viewForLayer } from './cpuBackends';
import { registerLayerKind } from './kinds';
import { hasLayerRenderer, registerLayerRenderer } from './registry';
import type { Backend, CpuContext, LayerHandle, VectorStyle } from './types';

export const DOSE_KIND = 'dose';
export const DOSE_COLORWASH_RENDERER = 'dose-colorwash';
export const DOSE_ISOLINES_RENDERER = 'dose-isolines';

/** 預設等劑量線（% 處方；絕對模式時換算成 Gy）。 */
export const DEFAULT_ISODOSE_PERCENTS: readonly number[] = [110, 105, 100, 95, 90, 80, 70, 50, 30];

/** 沒處方時自動等距的線數上限。 */
export const AUTO_ISODOSE_MAX_LINES = 12;
// 0.001 起：差值的色階範圍調到 ±0.1 Gy 以下時，自動等劑量線也要畫得出來
const NICE_STEPS_GY: readonly number[] = [0.001, 0.002, 0.005, 0.01, 0.02, 0.05, 0.1, 0.2, 0.5, 1, 2, 5, 10, 20, 50, 100];

/** 沒處方時的等劑量線（Gy，由高到低）：1-2-5 序列裡最小、線數 ≤ 12 的間距，從一個間距起到 < Dmax。 */
export function autoIsodoseLevelsGy(maxGy: number): number[] {
  if (!(maxGy > 0)) return [];
  const step = NICE_STEPS_GY.find((s) => Math.ceil(maxGy / s) - 1 <= AUTO_ISODOSE_MAX_LINES) ?? NICE_STEPS_GY[NICE_STEPS_GY.length - 1]!;
  const out: number[] = [];
  for (let k = 1; k * step < maxGy - 1e-9; k += 1) out.push(Number((k * step).toFixed(6)));
  return out.reverse();
}

/** 差值劑量的等劑量線（±Gy，由高到低）：每邊最多 5 條，1-2-5 間距。 */
export const AUTO_DIFF_MAX_LINES_PER_SIDE = 5;
export function autoDiffLevelsGy(maxAbsGy: number): number[] {
  if (!(maxAbsGy > 0)) return [];
  const step = NICE_STEPS_GY.find((s) => Math.ceil(maxAbsGy / s) - 1 <= AUTO_DIFF_MAX_LINES_PER_SIDE) ?? NICE_STEPS_GY[NICE_STEPS_GY.length - 1]!;
  const pos: number[] = [];
  for (let k = 1; k * step < maxAbsGy - 1e-9; k += 1) pos.push(Number((k * step).toFixed(6)));
  return [...pos.reverse(), ...pos.map((g) => -g).reverse()];
}

let userIsodosePercents: readonly number[] | null = null;

/** 使用者存在帳號偏好的等劑量線預設（% 參考劑量）；`null` ＝ 用內建規則。 */
export function setUserIsodoseDefault(percents: readonly number[] | null): void {
  userIsodosePercents = percents && percents.length > 0 ? [...percents] : null;
}

export function getUserIsodoseDefault(): readonly number[] | null {
  return userIsodosePercents;
}

/** 線色覆寫的 key：Gy 取到 0.001（% 模式也換成 Gy 再取）。 */
export function levelKey(levelGy: number): string {
  return levelGy.toFixed(3);
}

/** 等劑量線的預設是怎麼來的（面板提示用）。 */
export type IsodoseLevelSource = 'custom' | 'user-default' | 'prescription' | 'auto';
const DEFAULT_THRESHOLD_FRACTION = 0.1;
const ISOLINE_WIDTH_PX = 1.5;

export interface DoseDisplay {
  readonly maxGy: number;
  /** 最小值（差值才會 < 0）。 */
  readonly minGy: number;
  /** 差值（有負值）—— 發散色階、對稱的色階範圍、±Gy 等劑量線、colorwash 以 |值| 截止。 */
  readonly signed: boolean;
  readonly referenceGy: number;
  readonly display: 'absolute' | 'percent';
  readonly colormap: string;
  readonly colorwash: boolean;
  readonly isolines: boolean;
  readonly thresholdGy: number;
  /** 一律換成 Gy。 */
  readonly levelsGy: readonly number[];
  readonly levelSource: IsodoseLevelSource;
  /** 使用者改過的線色（`levelKey` → RGB）。 */
  readonly levelColors: Readonly<Record<string, readonly [number, number, number]>>;
  /** 色階正規化的上限（Gy）：percent 模式是參考劑量的 1.1 倍，absolute 是 max；使用者設了上界就是上界。 */
  readonly scaleMaxGy: number;
  /**
   * 色階的下界／上界（Gy；差值要能調 color bar 的上下界，細微的差異才看得出來）。
   * 一般劑量預設 0 … scaleMaxGy；差值預設 −max|值| … +max|值|，0 永遠在色階正中間（白）。超出範圍的飽和。
   * `params.range_lo_gy`／`range_hi_gy`；`rangeCustom` ＝ 使用者設過。
   */
  readonly rangeLoGy: number;
  readonly rangeHiGy: number;
  readonly rangeCustom: boolean;
}

function num(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

/**
 * `Layer.params` → 顯示參數，**所有預設值都在這裡**（renderer 與面板共用，
 * 兩邊才不會各有一套預設）。
 */
/**
 * 劑量的計畫名稱（圖例、DVH、資料面板）：`referenced_plan_label`；射束劑量（`summation_type=BEAM`）加射束號 ——
 * 同一個計畫的 N 個射束劑量以前全部同名。沒有計畫標籤 → ''。
 */
export function dosePlanName(layer: Pick<Layer, 'params'>): string {
  const p = layer.params ?? {};
  const plan = typeof p['referenced_plan_label'] === 'string' ? p['referenced_plan_label'] : '';
  if (!plan) return '';
  const beams = Array.isArray(p['referenced_beams']) ? [...new Set((p['referenced_beams'] as unknown[]).map((x) => (Array.isArray(x) ? Number(x[1]) : NaN)).filter((n) => Number.isFinite(n)))].sort((a, b) => a - b) : [];
  const summation = typeof p['summation_type'] === 'string' ? p['summation_type'].toUpperCase() : '';
  return summation === 'BEAM' && beams.length > 0 ? `${plan} beam ${beams.join(',')}` : plan;
}

export function doseDisplayOf(layer: Layer): DoseDisplay {
  const p = layer.params ?? {};
  const maxGy = Math.max(0, num(p['max_gy'], 0));
  const minGy = Math.min(0, num(p['min_gy'], 0));
  const signed = minGy < 0;
  if (signed) return signedDisplayOf(p, maxGy, minGy);
  const prescriptions = Array.isArray(p['prescription_gy']) ? (p['prescription_gy'] as unknown[]) : [];
  const prescription = prescriptions.map((x) => num(x, 0)).find((x) => x > 0);
  const referenceGy = num(p['reference_gy'], prescription ?? maxGy);
  // 非 Gy 的劑量（`dose_scale` 不是 'gy'）預設用 % 參考顯示 —— 它的絕對值沒有單位可標
  const nonGy = typeof p['dose_scale'] === 'string' && p['dose_scale'] !== 'gy';
  const display: DoseDisplay['display'] = p['display'] === 'percent' || p['display'] === 'absolute' ? p['display'] : nonGy ? 'percent' : 'absolute';
  const rawLevels = Array.isArray(p['levels']) ? p['levels'].map((x) => num(x, Number.NaN)) : null;
  let levelSource: IsodoseLevelSource;
  let levelsGy: number[];
  if (rawLevels !== null) {
    levelSource = 'custom';
    const values = rawLevels.filter((x) => Number.isFinite(x));
    levelsGy = display === 'absolute' ? values : values.map((pct) => (referenceGy * pct) / 100);
  } else if (userIsodosePercents !== null) {
    levelSource = 'user-default';
    levelsGy = userIsodosePercents.map((pct) => (referenceGy * pct) / 100);
  } else if (prescription !== undefined || display === 'percent') {
    levelSource = 'prescription';
    levelsGy = DEFAULT_ISODOSE_PERCENTS.map((pct) => (referenceGy * pct) / 100);
  } else {
    levelSource = 'auto';
    levelsGy = autoIsodoseLevelsGy(maxGy);
  }
  const autoHi = display === 'percent' ? referenceGy * 1.1 : Math.max(maxGy, 1e-6);
  const rawLo = num(p['range_lo_gy'], Number.NaN);
  const rawHi = num(p['range_hi_gy'], Number.NaN);
  const rangeHiGy = Number.isFinite(rawHi) && rawHi > 0 ? rawHi : autoHi;
  const rangeLoGy = Number.isFinite(rawLo) && rawLo >= 0 && rawLo < rangeHiGy ? rawLo : 0;
  const scaleMaxGy = rangeHiGy;
  return {
    maxGy,
    minGy,
    rangeLoGy,
    rangeHiGy,
    rangeCustom: Number.isFinite(rawLo) || Number.isFinite(rawHi),
    signed: false,
    referenceGy,
    display,
    colormap: typeof p['colormap'] === 'string' ? (p['colormap']) : 'jet',
    colorwash: p['colorwash'] !== false,
    isolines: p['isolines'] !== false,
    thresholdGy: num(p['threshold_gy'], referenceGy * DEFAULT_THRESHOLD_FRACTION),
    levelsGy: levelsGy.filter((g) => g > 0).sort((a, b) => b - a),
    levelSource,
    levelColors: parseLevelColors(p['level_colors']),
    scaleMaxGy,
  };
}

/** 差值的顯示參數：一律絕對值（% 參考對差值沒有意義）、色階範圍 ±max|值|、預設 ±Gy 等距的線。 */
function signedDisplayOf(p: Record<string, unknown>, maxGy: number, minGy: number): DoseDisplay {
  const dataMaxAbs = Math.max(maxGy, -minGy, 1e-6);
  const rawLo = num(p['range_lo_gy'], Number.NaN);
  const rawHi = num(p['range_hi_gy'], Number.NaN);
  // 0 要在範圍裡（發散色階的白）：下界 < 0 < 上界；沒設 ＝ 對稱的 ±max|值|
  const rangeLoGy = Number.isFinite(rawLo) && rawLo < 0 ? rawLo : -dataMaxAbs;
  const rangeHiGy = Number.isFinite(rawHi) && rawHi > 0 ? rawHi : dataMaxAbs;
  const maxAbs = Math.max(-rangeLoGy, rangeHiGy);
  const rawLevels = Array.isArray(p['levels']) ? p['levels'].map((x) => num(x, Number.NaN)).filter((x) => Number.isFinite(x)) : null;
  // 自動的等劑量線跟著色階範圍走（範圍調小，線也變密），只留範圍內的
  const levelsGy = (rawLevels ?? autoDiffLevelsGy(maxAbs).filter((g) => g >= rangeLoGy - 1e-9 && g <= rangeHiGy + 1e-9)).filter((g) => g !== 0).sort((a, b) => b - a);
  return {
    maxGy,
    minGy,
    rangeLoGy,
    rangeHiGy,
    rangeCustom: Number.isFinite(rawLo) || Number.isFinite(rawHi),
    signed: true,
    referenceGy: maxAbs,
    display: 'absolute',
    colormap: typeof p['colormap'] === 'string' ? p['colormap'] : 'diverging',
    colorwash: p['colorwash'] !== false,
    isolines: p['isolines'] !== false,
    thresholdGy: num(p['threshold_gy'], maxAbs * DEFAULT_THRESHOLD_FRACTION),
    levelsGy,
    levelSource: rawLevels !== null ? 'custom' : 'auto',
    levelColors: parseLevelColors(p['level_colors']),
    scaleMaxGy: maxAbs,
  };
}

function parseLevelColors(v: unknown): Record<string, readonly [number, number, number]> {
  const out: Record<string, readonly [number, number, number]> = {};
  if (v === null || typeof v !== 'object') return out;
  for (const [k, hex] of Object.entries(v as Record<string, unknown>)) {
    const m = typeof hex === 'string' ? /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex) : null;
    if (m) out[k] = [parseInt(m[1]!, 16), parseInt(m[2]!, 16), parseInt(m[3]!, 16)];
  }
  return out;
}

/**
 * 劑量值在色階上的位置（0–1）：一般劑量 ＝ (v − 下界)／(上界 − 下界)；差值 ＝ 0 在 0.5，負的映到 [下界, 0] → [0, 0.5]、
 * 正的映到 [0, 上界] → [0.5, 1]（兩邊可以不對稱，0 仍然是白）。超出範圍的飽和。colorwash、等劑量線、圖例的色階條共用。
 */
export function doseColorFraction(display: Pick<DoseDisplay, 'signed' | 'rangeLoGy' | 'rangeHiGy'>, v: number): number {
  if (display.signed) {
    const f = v >= 0 ? 0.5 + 0.5 * (v / display.rangeHiGy) : 0.5 - 0.5 * (v / display.rangeLoGy);
    return Math.max(0, Math.min(1, f));
  }
  const span = display.rangeHiGy - display.rangeLoGy;
  return span > 0 ? Math.max(0, Math.min(1, (v - display.rangeLoGy) / span)) : 0;
}

/** 一條等劑量線的顏色：使用者改過的優先，否則照色階（renderer 與圖例共用，兩邊才一致）。 */
export function isodoseColor(display: DoseDisplay, levelGy: number): readonly [number, number, number] {
  const custom = display.levelColors[levelKey(levelGy)];
  if (custom) return custom;
  const lut = getColormap(display.colormap);
  const t = Math.round(doseColorFraction(display, levelGy) * 255);
  return [lut[t * 3]!, lut[t * 3 + 1]!, lut[t * 3 + 2]!];
}

/** 兩個 renderer 共用：重切出 layer 自己 FoR 的 f32 劑量平面（Gy，volume 外 NaN）。 */
function reslicedDose(ctx: CpuContext, layer: Layer): Float32Array | null {
  const entry = ctx.voxels(layer);
  if (entry === null) return null;
  if (!(entry.voxels instanceof Float32Array)) return null; // 劑量一律 float32 Gy
  const view = viewForLayer(ctx, layer);
  return ctx.resampler.reslicePlane({
    volume: entry.voxels,
    volumeKey: entry.volumeKey,
    grid: entry.grid,
    view,
    outSizePx: [ctx.target.width, ctx.target.height],
    pxMm: ctx.pxMm,
    // 劑量在 slab 內取最大值（臨床上關心的是「這一段有沒有超過」，不是平均）
    blend: view.slabThicknessMm > 0 ? 'mip' : 'center',
    outside: OUTSIDE_SENTINEL,
  });
}

function drawColorwash(ctx: CpuContext, layer: Layer): void {
  const display = doseDisplayOf(layer);
  if (!display.colorwash) return;
  const plane = reslicedDose(ctx, layer);
  if (plane === null) return;
  if (display.signed) {
    drawSignedColorwash(ctx, layer, display, plane);
    return;
  }
  const span = Math.max(1e-6, display.rangeHiGy - display.rangeLoGy);
  const gray = normalizeToU8(plane, display.rangeLoGy, display.rangeHiGy);
  // 閾值以下透明；下界以上才開始有顏色（下界以下的映到 0 → 也透明）
  const thresholdU8 = Math.round((Math.max(0, display.thresholdGy - display.rangeLoGy) / span) * 255);
  compositeOver({
    target: ctx.target,
    gray,
    lut: getColormap(display.colormap),
    opacity: layer.opacity,
    coverage: coverageFromPlane(plane),
    thresholdU8: Math.max(1, thresholdU8),
  });
}

/** 差值：下界 … 0 … 上界 → 0 … 128 … 255（`doseColorFraction`）；|值| 小於閾值透明（沒差的地方看得到底下的影像）。 */
function drawSignedColorwash(ctx: CpuContext, layer: Layer, display: DoseDisplay, plane: Float32Array): void {
  const gray = new Uint8Array(plane.length);
  const thr = Math.max(0, display.thresholdGy);
  const coverage = new Uint8Array(plane.length);
  for (let i = 0; i < plane.length; i += 1) {
    const v = plane[i]!;
    if (Number.isNaN(v) || Math.abs(v) < thr) continue;
    coverage[i] = 1;
    gray[i] = Math.round(doseColorFraction(display, v) * 255);
  }
  compositeOver({ target: ctx.target, gray, lut: getColormap(display.colormap), opacity: layer.opacity, coverage, thresholdU8: 0 });
}

function drawIsolines(ctx: CpuContext, layer: Layer): void {
  const display = doseDisplayOf(layer);
  if (!display.isolines || display.levelsGy.length === 0) return;
  const plane = reslicedDose(ctx, layer);
  if (plane === null) return;
  const { width, height } = ctx.target;
  // 🔴 volume 外的 NaN 不能進 marching squares：NaN 角點的插補位置是 NaN，canvas 會
  // 略過那個點、把前後兩點直接連起來 —— 症狀是幾條貫穿整格的直線（實測看得到）。
  // 等劑量線把「外面」當成 0 Gy（低於所有 level）。
  const field = isolineField(plane);
  for (const levelGy of display.levelsGy) {
    const segments = ctx.resampler.marchingSquares(field, width, height, levelGy);
    const segmentCount = segments.length / 4;
    if (segmentCount === 0) continue;
    const [r, g, b] = isodoseColor(display, levelGy);
    const style: VectorStyle = {
      strokeRgba: [r, g, b, Math.min(1, layer.opacity + 0.3)],
      // 線寬不隨互動態的解析度縮放而變
      lineWidthPx: ISOLINE_WIDTH_PX,
    };
    ctx.paths.begin(`${layer.layerId}#${levelGy}`, style);
    ctx.paths.segments(segments, segmentCount);
    ctx.paths.end();
  }
}

/** 等劑量線用的場：NaN（volume 外）→ 0 Gy。沒有 NaN 時回同一個陣列（零複製）。 */
export function isolineField(plane: Float32Array): Float32Array {
  let hasNaN = false;
  for (let i = 0; i < plane.length; i += 1) {
    if (Number.isNaN(plane[i]!)) {
      hasNaN = true;
      break;
    }
  }
  if (!hasNaN) return plane;
  const out = new Float32Array(plane.length);
  for (let i = 0; i < plane.length; i += 1) {
    const v = plane[i]!;
    out[i] = Number.isNaN(v) ? 0 : v;
  }
  return out;
}

function attach(rendererId: string) {
  return (ctx: CpuContext, layer: Layer): LayerHandle =>
    makeStubHandle({ viewportId: ctx.viewportId, layerId: layer.layerId, rendererId });
}

type SupportedCpuBackend = Extract<Backend<CpuContext, unknown>, { kind: 'supported' }>;
type DrawingCpuBackend = SupportedCpuBackend & { draw: NonNullable<SupportedCpuBackend['draw']> };

export const doseColorwashCpuBackend: DrawingCpuBackend = {
  kind: 'supported',
  render: attach(DOSE_COLORWASH_RENDERER),
  draw: drawColorwash,
};

export const doseIsolinesCpuBackend: DrawingCpuBackend = {
  kind: 'supported',
  render: attach(DOSE_ISOLINES_RENDERER),
  draw: drawIsolines,
};

/** GPU 路徵尚未實作；記帳正確、不畫像素。 */
function notImplemented(rendererId: string): SupportedCpuBackend {
  return { kind: 'supported', render: attach(rendererId) };
}

/** 註冊劑量模組。冪等。 */
export function registerDoseModule(): void {
  if (hasLayerRenderer(DOSE_COLORWASH_RENDERER)) return;
  registerLayerRenderer({
    rendererId: DOSE_COLORWASH_RENDERER,
    form: 'F1',
    zBand: 'overlay',
    supportsTemporal: true,
    gpu: notImplemented(DOSE_COLORWASH_RENDERER) as never,
    cpu: doseColorwashCpuBackend,
  });
  registerLayerRenderer({
    rendererId: DOSE_ISOLINES_RENDERER,
    form: 'F3',
    zBand: 'annotation',
    supportsTemporal: true,
    // 免費午餐：只用向量出口，之後接 GPU 時同一份可當 gpu 後端
    gpu: notImplemented(DOSE_ISOLINES_RENDERER) as never,
    cpu: doseIsolinesCpuBackend,
  });
  registerLayerKind({
    kind: DOSE_KIND,
    resolveRenderers: (layer, vp) => {
      if (vp.is3D) return []; // 3D 的劑量顯示（等劑量面）留給 mesh 路徑
      const display = doseDisplayOf(layer);
      const out: string[] = [];
      if (display.colorwash) out.push(DOSE_COLORWASH_RENDERER);
      if (display.isolines) out.push(DOSE_ISOLINES_RENDERER);
      return out;
    },
  });
}
