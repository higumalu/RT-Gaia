/**
 * 把一張已正規化（0–255）的平面經色階疊到 `ImageData` 上。
 *
 * ## 多影像疊合的全部規則都在這一個函式
 *
 * * **normal 混合**：`dst = src·a + dst·(1−a)`、`dstA = a + dstA·(1−a)`。
 *   target 每幀先清成透明（alpha 0），因此第一層以 opacity 1 畫上去就是它自己；
 *   第二層以 0.5 畫上去就是 50% 融合 —— 不需要「第一層特殊處理」。
 * * **coverage**：`coverage[i] === 0` 的像素 alpha 視為 0（重切落在 volume 外）。
 *   這就是「CBCT 較小 FOV」的處理：FOV 外**透明**而不是塗黑，否則第二組
 *   影像的方框會把計畫 CT 整片蓋掉。
 * * **threshold**：`gray < thresholdU8` 的像素不畫（劑量 colorwash 的低劑量截止）。
 *
 * `blendMode`：
 * * `checkerboard`：只畫棋盤格的其中一半格子（`checkerPx` 大小），另一半露出下面的影像
 * * `difference`：`|src − dst|`，對位偏差會在邊緣亮起來；alpha 照 opacity ＋ coverage
 * 兩者都不需要共同網格 —— 逐像素做，與 normal 走同一條路。
 */

import type { ColormapLut } from './colormaps';

export type CompositeBlendMode = 'normal' | 'additive' | 'checkerboard' | 'difference';

export const DEFAULT_CHECKER_PX = 32;

export interface CompositeArgs {
  target: ImageData;
  /** 0–255，長度 = target 的像素數。 */
  gray: Uint8Array;
  lut: ColormapLut;
  /** 0–1。 */
  opacity: number;
  /** 非 0 = 有資料。省略 = 全部有資料。 */
  coverage?: Uint8Array | null;
  /** 低於此值不畫（0 = 全畫）。 */
  thresholdU8?: number;
  blendMode?: CompositeBlendMode;
  /** `checkerboard` 的格子大小（輸出平面像素）。 */
  checkerPx?: number;
}

export function compositeOver(args: CompositeArgs): void {
  const rgba = args.target.data;
  const { gray, lut, coverage } = args;
  const threshold = args.thresholdU8 ?? 0;
  const a = Math.max(0, Math.min(1, args.opacity));
  if (a === 0) return;
  const mode = args.blendMode ?? 'normal';
  const width = args.target.width;
  const checker = Math.max(1, Math.round(args.checkerPx ?? DEFAULT_CHECKER_PX));
  const n = gray.length;
  for (let i = 0; i < n; i += 1) {
    if (coverage !== undefined && coverage !== null && coverage[i] === 0) continue;
    const g = gray[i]!;
    if (g < threshold) continue;
    if (mode === 'checkerboard') {
      const x = i % width;
      const y = (i - x) / width;
      // 奇數格才畫；偶數格露出底下的影像
      if (((Math.floor(x / checker) + Math.floor(y / checker)) & 1) === 0) continue;
    }
    const o = i * 4;
    const li = g * 3;
    const dstA = rgba[o + 3]! / 255;
    const outA = a + dstA * (1 - a);
    if (outA <= 0) continue;
    // 非預乘的 over：以 outA 正規化，讓半透明疊在透明底上時顏色不被拉暗
    const wSrc = a / outA;
    const wDst = 1 - wSrc;
    if (mode === 'difference') {
      // 與底下已有的顏色取絕對差；沒有底（dstA 0）時就是自己
      const sr = lut[li]!;
      const sg = lut[li + 1]!;
      const sb = lut[li + 2]!;
      const dr = dstA > 0 ? Math.abs(sr - rgba[o]!) : sr;
      const dg = dstA > 0 ? Math.abs(sg - rgba[o + 1]!) : sg;
      const db = dstA > 0 ? Math.abs(sb - rgba[o + 2]!) : sb;
      rgba[o] = dr * wSrc + rgba[o]! * wDst;
      rgba[o + 1] = dg * wSrc + rgba[o + 1]! * wDst;
      rgba[o + 2] = db * wSrc + rgba[o + 2]! * wDst;
      rgba[o + 3] = outA * 255;
      continue;
    }
    if (mode === 'additive') {
      rgba[o] = Math.min(255, rgba[o]! + lut[li]! * a);
      rgba[o + 1] = Math.min(255, rgba[o + 1]! + lut[li + 1]! * a);
      rgba[o + 2] = Math.min(255, rgba[o + 2]! + lut[li + 2]! * a);
      rgba[o + 3] = outA * 255;
      continue;
    }
    rgba[o] = lut[li]! * wSrc + rgba[o]! * wDst;
    rgba[o + 1] = lut[li + 1]! * wSrc + rgba[o + 1]! * wDst;
    rgba[o + 2] = lut[li + 2]! * wSrc + rgba[o + 2]! * wDst;
    rgba[o + 3] = outA * 255;
  }
}

/**
 * 重切平面的 coverage：`NaN` 是「落在 volume 外」的哨兵（`outside: NaN`）。
 *
 * 回傳 1/0 的 u8；全部有資料時回 `null`（省下合成時的一次分支）。
 */
export function coverageFromPlane(plane: Float32Array): Uint8Array | null {
  let anyOutside = false;
  for (let i = 0; i < plane.length; i += 1) {
    if (Number.isNaN(plane[i]!)) {
      anyOutside = true;
      break;
    }
  }
  if (!anyOutside) return null;
  const out = new Uint8Array(plane.length);
  for (let i = 0; i < plane.length; i += 1) out[i] = Number.isNaN(plane[i]!) ? 0 : 1;
  return out;
}

/** 線性正規化到 0–255（劑量：`lo..hi` Gy → 0..255）。NaN → 0。 */
export function normalizeToU8(plane: Float32Array, lo: number, hi: number): Uint8Array {
  const out = new Uint8Array(plane.length);
  const span = hi - lo;
  if (!(span > 0)) return out;
  for (let i = 0; i < plane.length; i += 1) {
    const v = plane[i]!;
    if (Number.isNaN(v)) continue;
    const t = ((v - lo) / span) * 255;
    out[i] = t <= 0 ? 0 : t >= 255 ? 255 : Math.round(t);
  }
  return out;
}
