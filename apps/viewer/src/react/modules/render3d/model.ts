/**
 * 3D 出圖模組的**純邏輯**：模組狀態、裁切方框、MIP 的視窗、送後端的圖層、輸出尺寸。
 * 相機在 `camera3d.ts`、TF 在 `transferFunction.ts`。零 React。
 */

import { doseDisplayOf, type FrameGroup, type Layer } from '../../../core';
import { getColormap } from '../../../core/raster/colormaps';
import type { Camera3d } from './camera3d';
import { tfToWire, type TransferFunction } from './transferFunction';
import { msg } from '../../../core/i18n';

export const RENDER3D_MODULE_ID = 'render3d';
export const RENDER3D_VIEW_PANEL_ID = 'render3d.view';
export const RENDER3D_MODE = 'render3d';

export type Technique = 'composite' | 'mip';
export type MapperChoice = 'auto' | 'gpu' | 'cpu';

export interface CropBox {
  readonly min: [number, number, number];
  readonly max: [number, number, number];
}

export interface Render3dState {
  /** `composite`＝VTK 體積渲染（預設）；`mip`＝舊的 Rust 路徑（沒 VTK 時的備援）。 */
  readonly technique?: Technique;
  /** GPU 優先、CPU 備援；`cpu` 可強制。 */
  readonly mapper?: MapperChoice;
  readonly camera?: Camera3d | null;
  /** Scalar opacity／color mapping（composite）。 */
  readonly tf?: TransferFunction;
  /** MIP 的 WW/WL（與 2D 分開）；沒設用預設集。 */
  readonly window?: { center: number; width: number };
  readonly preset?: string;
  /** 裁切方框（primary 世界 mm；Slicer Volume Rendering 的 Crop）。null／undefined ＝ 全範圖。 */
  readonly crop?: CropBox | null;
  /** 在 2D 切面畫出方框（Slicer 的 Display ROI）。預設開。 */
  readonly showCropBox?: boolean;
  /** 3D 相機的焦點跟著 2D 十字線（相機連動）。預設關。 */
  readonly followCrosshair?: boolean;
}

// ── 裁切 ─────────────────────────────────────────────────────────────────────

export function clampCrop(crop: CropBox, bounds: { readonly min: readonly number[]; readonly max: readonly number[] }): CropBox {
  const min: [number, number, number] = [0, 0, 0];
  const max: [number, number, number] = [0, 0, 0];
  for (let a = 0; a < 3; a += 1) {
    const lo = Math.max(bounds.min[a]!, Math.min(bounds.max[a]!, crop.min[a]!));
    const hi = Math.max(bounds.min[a]!, Math.min(bounds.max[a]!, crop.max[a]!));
    min[a] = Math.min(lo, hi);
    max[a] = Math.max(lo, hi, min[a]! + 1);
  }
  return { min, max };
}

export function cropCenter(crop: CropBox): [number, number, number] {
  return [(crop.min[0] + crop.max[0]) / 2, (crop.min[1] + crop.max[1]) / 2, (crop.min[2] + crop.max[2]) / 2];
}

export function shrinkAxis(crop: CropBox, axis: 0 | 1 | 2, fraction: number): CropBox {
  const c = (crop.min[axis] + crop.max[axis]) / 2;
  const half = ((crop.max[axis] - crop.min[axis]) * Math.max(0.05, Math.min(1, fraction))) / 2;
  const min = [...crop.min] as [number, number, number];
  const max = [...crop.max] as [number, number, number];
  min[axis] = c - half;
  max[axis] = c + half;
  return { min, max };
}

export function cropCorners(crop: CropBox): [number, number, number][] {
  const out: [number, number, number][] = [];
  for (const x of [crop.min[0], crop.max[0]]) for (const y of [crop.min[1], crop.max[1]]) for (const z of [crop.min[2], crop.max[2]]) out.push([x, y, z]);
  return out;
}

export function isFullCrop(crop: CropBox | null | undefined, bounds: CropBox | null): boolean {
  if (!crop || !bounds) return true;
  return crop.min.every((v, i) => v <= bounds.min[i]! + 1e-6) && crop.max.every((v, i) => v >= bounds.max[i]! - 1e-6);
}

// ── MIP 的視窗 ────────────────────────────────────────────────────────────────

export interface Render3dPreset {
  readonly id: string;
  readonly label: string;
  readonly window: { center: number; width: number };
}

export const PRESETS: readonly Render3dPreset[] = [
  { id: 'ct_bone', label: msg('骨'), window: { center: 400, width: 1800 } },
  { id: 'ct_soft', label: msg('軟組織'), window: { center: 40, width: 400 } },
  { id: 'ct_lung', label: msg('肺'), window: { center: -600, width: 1500 } },
];

export const CUSTOM_PRESET_ID = 'custom';

export function presetOf(id: string | undefined): Render3dPreset {
  return PRESETS.find((p) => p.id === id) ?? PRESETS[0]!;
}

export function windowOf(state: Render3dState | undefined): { center: number; width: number } {
  if (state?.window && Number.isFinite(state.window.center) && state.window.width > 0) return state.window;
  return presetOf(state?.preset).window;
}

export function presetIdForWindow(window: { center: number; width: number }): string {
  return PRESETS.find((p) => p.window.center === window.center && p.window.width === window.width)?.id ?? CUSTOM_PRESET_ID;
}

export const WINDOW_CENTER_RANGE = { min: -1000, max: 3000 } as const;
export const WINDOW_WIDTH_RANGE = { min: 1, max: 4000 } as const;

export function clampWindow(w: { center: number; width: number }): { center: number; width: number } {
  return {
    center: Math.round(Math.max(WINDOW_CENTER_RANGE.min, Math.min(WINDOW_CENTER_RANGE.max, w.center))),
    width: Math.round(Math.max(WINDOW_WIDTH_RANGE.min, Math.min(WINDOW_WIDTH_RANGE.max, w.width))),
  };
}

// ── 送後端的圖層 ──────────────────────────────────────────────────────────────

/**
 * composite：所有 FoR 的可見影像／結構都送（後端的 actor 套 `transform_to_primary`）；
 * mip：只送 primary FoR（Rust 路徑以 primary 網格取樣）。
 * 影像 → `volume-3d`（composite 帶 TF；mip 帶 window）；結構 → `mesh`（顏色 0–1、opacity 0.5）。
 * 劑量 → `dose-3d`（只有 composite；MIP 是灰階視窗，不畫劑量），TF 由 `doseTransferFunction` 依 2D 的顯示參數產生。
 */
export function render3dLayers(
  layers: readonly Layer[],
  primary: FrameGroup | null,
  opts: { technique: Technique; window: { center: number; width: number }; tf: TransferFunction; frameOf?: (layer: Layer) => number | null },
): Record<string, unknown>[] {
  if (primary === null) return [];
  const out: Record<string, unknown>[] = [];
  const tfWire = tfToWire(opts.tf);
  for (const l of layers) {
    if (!l.visible) continue;
    // 時間序列帶目前相位（3D 跟 2D 同一個游標）
    const frame = l.temporalGroupId ? (opts.frameOf?.(l) ?? 0) : null;
    const withFrame = (o: Record<string, unknown>): Record<string, unknown> => (frame === null ? o : { ...o, frame_index: frame });
    if (opts.technique === 'mip' && l.frameOfReferenceUid !== primary.frameOfReferenceUid) continue;
    if (l.kind === 'image') {
      out.push(
        withFrame(
          opts.technique === 'mip'
            ? { renderer: 'volume-3d', series_id: l.contentRef, window: { center: opts.window.center, width: opts.window.width }, opacity: l.opacity }
            : { renderer: 'volume-3d', series_id: l.contentRef, opacity: l.opacity, ...tfWire },
        ),
      );
    } else if (l.kind === 'dose' && opts.technique === 'composite') {
      out.push(withFrame({ renderer: 'dose-3d', series_id: l.contentRef, opacity: l.opacity, ...doseTransferFunction(l) }));
    } else if (l.kind === 'mask') {
      // 只在某幾幀的結構（畫在 4DCT 某一相位上），這一幀沒有它就不送
      if (frame !== null && l.frames !== undefined && !l.frames.includes(frame)) continue;
      const c = l.color ?? [255, 0, 0];
      out.push(withFrame({ renderer: 'mesh', structure_id: l.contentRef, color: c.map((v) => v / 255), opacity: 0.5 }));
    }
  }
  return out;
}

/**
 * 劑量 3D 的不透明度曲線：(劑量在閾值～上限間的位置 0–1, 每 mm 不透明度)。VTK 的 opacity 以 1 mm 為單位累積，
 * 低劑量區又大又厚 —— 線性從閾值開始升會把整個照野糊成一塊（實測：真實病例低劑量區變成不透明的藍色板塊），
 * 所以大部分不透明度放在高劑量段。再乘圖層 opacity。
 */
export const DOSE_3D_OPACITY_CURVE: readonly (readonly [number, number])[] = [
  [0, 0],
  [0.5, 0.002],
  [0.8, 0.01],
  [1, 0.05],
];
const DOSE_3D_STEPS = 8;

/**
 * 劑量的 3D TF（Gy）—— 與 2D colorwash 同一套規則：色階 LUT 以 0～`scaleMaxGy` 對應、閾值以下透明。
 * 不透明度照 `DOSE_3D_OPACITY_CURVE`（高劑量區看得到、低劑量不擋視線）。
 */
export function doseTransferFunction(layer: Layer): { scalar_opacity: [number, number][]; scalar_color: [number, number, number, number][]; shade: false } {
  const d = doseDisplayOf(layer);
  const top = Math.max(d.scaleMaxGy, 1e-3);
  const lo = Math.min(Math.max(0, d.thresholdGy), top * 0.999);
  const lut = getColormap(d.colormap);
  const colorAt = (gy: number): [number, number, number] => {
    const i = Math.max(0, Math.min(255, Math.round((gy / top) * 255)));
    return [lut[i * 3]! / 255, lut[i * 3 + 1]! / 255, lut[i * 3 + 2]! / 255];
  };
  const scalar_opacity: [number, number][] = DOSE_3D_OPACITY_CURVE.map(([t, a]) => [lo + (top - lo) * t, a]);
  const scalar_color: [number, number, number, number][] = [];
  for (let k = 0; k <= DOSE_3D_STEPS; k += 1) {
    const gy = lo + ((top - lo) * k) / DOSE_3D_STEPS;
    scalar_color.push([gy, ...colorAt(gy)]);
  }
  return { scalar_opacity, scalar_color, shade: false };
}

/** 拖曳中的低解析度、放手後的上限（px）。 */
export const DRAG_SIZE_PX = 224;
export const FULL_SIZE_MAX_PX = 768;

/** 匯出 PNG：目標邊長與後端的像素預算（`RTGAIA_RENDER_PIXEL_BUDGET` 預設，w×h×圖層數）。 */
export const EXPORT_SIZE_PX = 1536;
export const RENDER_PIXEL_BUDGET = 64_000_000;

/** 匯出的邊長：1536，圖層多時縮到預算內（至少 512；預算被調小時後端仍可能 422，那時退回目前這張）。 */
export function exportSize(layerCount: number): number {
  const fit = Math.floor(Math.sqrt(RENDER_PIXEL_BUDGET / Math.max(1, layerCount)));
  return Math.max(512, Math.min(EXPORT_SIZE_PX, fit));
}

/** `rtgaia-3d-20260924-1530.png`（本地時間）。 */
export function exportFileName(at: Date): string {
  const p = (n: number): string => String(n).padStart(2, '0');
  return `rtgaia-3d-${at.getFullYear()}${p(at.getMonth() + 1)}${p(at.getDate())}-${p(at.getHours())}${p(at.getMinutes())}.png`;
}

/** 輸出尺寸：拖曳中固定小圖；放手後照格子大小（正方形、上限 768）。 */
export function outputSize(cellWidth: number, cellHeight: number, dragging: boolean): [number, number] {
  if (dragging) return [DRAG_SIZE_PX, DRAG_SIZE_PX];
  const s = Math.max(64, Math.min(FULL_SIZE_MAX_PX, Math.floor(Math.min(cellWidth, cellHeight))));
  return [s, s];
}

/**
 * 反向 pick：畫面上的點 → 出圖影像的像素（原點左上）。`<img>` 是 `object-fit: contain`：影像等比縮放置中，
 * 旁邊的黑邊點下去回 null。`rect` 是 `<img>` 的 client rect，`size` 是那張圖的像素大小。
 */
export function imagePixelAt(clientX: number, clientY: number, rect: { left: number; top: number; width: number; height: number }, size: readonly [number, number]): [number, number] | null {
  const [w, h] = size;
  if (w <= 0 || h <= 0 || rect.width <= 0 || rect.height <= 0) return null;
  const scale = Math.min(rect.width / w, rect.height / h);
  const ox = rect.left + (rect.width - w * scale) / 2;
  const oy = rect.top + (rect.height - h * scale) / 2;
  const x = (clientX - ox) / scale;
  const y = (clientY - oy) / scale;
  if (x < 0 || y < 0 || x >= w || y >= h) return null;
  return [Math.floor(x), Math.floor(y)];
}
