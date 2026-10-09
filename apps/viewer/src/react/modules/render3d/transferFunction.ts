/**
 * Transfer function 的純邏輯（Slicer Volume Rendering 的 Scalar Opacity／Color Mapping）。
 * 折線控制點、Shift、預設集、取值、序列化。x 是體素值（CT 為 HU）。
 */

import { msg } from '../../../core/i18n';

export interface OpacityPoint {
  readonly x: number;
  readonly a: number;
}

export interface ColorPoint {
  readonly x: number;
  readonly r: number;
  readonly g: number;
  readonly b: number;
}

export interface TransferFunction {
  readonly opacity: readonly OpacityPoint[];
  readonly color: readonly ColorPoint[];
  /** 整條 TF 沿 x 平移（Slicer 的 Shift）。 */
  readonly shift: number;
  readonly shade: boolean;
  readonly ambient: number;
  readonly diffuse: number;
  readonly specular: number;
}

export interface TfPreset {
  readonly id: string;
  readonly label: string;
  readonly tf: TransferFunction;
}

const shading = { shade: true, ambient: 0.2, diffuse: 0.7, specular: 0.2 } as const;

/** 照 Slicer 預設集的名字與大致形狀（數值是近似，不是逐字抄）。 */
export const TF_PRESETS: readonly TfPreset[] = [
  {
    id: 'ct-bone',
    label: 'CT-Bone',
    tf: {
      opacity: [{ x: -1000, a: 0 }, { x: 150, a: 0 }, { x: 300, a: 0.15 }, { x: 600, a: 0.6 }, { x: 1500, a: 0.9 }, { x: 3000, a: 0.95 }],
      color: [{ x: -1000, r: 0, g: 0, b: 0 }, { x: 150, r: 0.55, g: 0.25, b: 0.15 }, { x: 400, r: 0.88, g: 0.6, b: 0.29 }, { x: 900, r: 1, g: 0.94, b: 0.85 }, { x: 3000, r: 1, g: 1, b: 1 }],
      shift: 0,
      ...shading,
    },
  },
  {
    id: 'ct-soft-tissue',
    label: 'CT-Soft-Tissue',
    tf: {
      opacity: [{ x: -1000, a: 0 }, { x: -300, a: 0 }, { x: -100, a: 0.05 }, { x: 100, a: 0.3 }, { x: 500, a: 0.7 }, { x: 3000, a: 0.9 }],
      color: [{ x: -1000, r: 0, g: 0, b: 0 }, { x: -200, r: 0.55, g: 0.25, b: 0.15 }, { x: 100, r: 0.9, g: 0.7, b: 0.6 }, { x: 500, r: 1, g: 1, b: 0.9 }, { x: 3000, r: 1, g: 1, b: 1 }],
      shift: 0,
      ...shading,
    },
  },
  {
    id: 'ct-muscle',
    label: 'CT-Muscle',
    tf: {
      opacity: [{ x: -1000, a: 0 }, { x: -155, a: 0 }, { x: -60, a: 0.15 }, { x: 60, a: 0.4 }, { x: 400, a: 0.8 }, { x: 3000, a: 0.9 }],
      color: [{ x: -1000, r: 0, g: 0, b: 0 }, { x: -155, r: 0.55, g: 0.25, b: 0.15 }, { x: 60, r: 0.85, g: 0.45, b: 0.35 }, { x: 400, r: 1, g: 0.9, b: 0.8 }, { x: 3000, r: 1, g: 1, b: 1 }],
      shift: 0,
      ...shading,
    },
  },
  {
    id: 'ct-air',
    label: msg('CT-Air／Lung'),
    tf: {
      opacity: [{ x: -1000, a: 0.2 }, { x: -900, a: 0.3 }, { x: -600, a: 0.15 }, { x: -400, a: 0 }, { x: 3000, a: 0 }],
      color: [{ x: -1000, r: 0.3, g: 0.6, b: 1 }, { x: -700, r: 0.6, g: 0.85, b: 1 }, { x: -400, r: 1, g: 1, b: 1 }, { x: 3000, r: 1, g: 1, b: 1 }],
      shift: 0,
      ...shading,
    },
  },
  {
    id: 'ct-cardiac',
    label: 'CT-Cardiac',
    tf: {
      opacity: [{ x: -1000, a: 0 }, { x: -50, a: 0 }, { x: 100, a: 0.25 }, { x: 250, a: 0.6 }, { x: 600, a: 0.9 }, { x: 3000, a: 0.95 }],
      color: [{ x: -1000, r: 0, g: 0, b: 0 }, { x: -50, r: 0.6, g: 0.1, b: 0.1 }, { x: 150, r: 0.9, g: 0.35, b: 0.25 }, { x: 350, r: 1, g: 0.85, b: 0.7 }, { x: 3000, r: 1, g: 1, b: 1 }],
      shift: 0,
      ...shading,
    },
  },
  {
    id: 'mr-default',
    label: 'MR-Default',
    tf: {
      opacity: [{ x: 0, a: 0 }, { x: 20, a: 0 }, { x: 40, a: 0.15 }, { x: 120, a: 0.3 }, { x: 220, a: 0.4 }, { x: 1024, a: 0.9 }],
      color: [{ x: 0, r: 0, g: 0, b: 0 }, { x: 20, r: 0.17, g: 0, b: 0 }, { x: 40, r: 0.4, g: 0.15, b: 0.1 }, { x: 120, r: 0.8, g: 0.6, b: 0.45 }, { x: 220, r: 0.9, g: 0.85, b: 0.75 }, { x: 1024, r: 1, g: 1, b: 1 }],
      shift: 0,
      ...shading,
    },
  },
];

export const CUSTOM_TF_ID = 'custom';

export function presetTf(id: string | undefined): TransferFunction {
  return (TF_PRESETS.find((p) => p.id === id) ?? TF_PRESETS[0]!).tf;
}

export function presetIdOf(tf: TransferFunction): string {
  const same = (a: TransferFunction, b: TransferFunction) =>
    a.opacity.length === b.opacity.length &&
    a.color.length === b.color.length &&
    a.opacity.every((p, i) => p.x === b.opacity[i]!.x && p.a === b.opacity[i]!.a) &&
    a.color.every((p, i) => p.x === b.color[i]!.x && p.r === b.color[i]!.r && p.g === b.color[i]!.g && p.b === b.color[i]!.b);
  return TF_PRESETS.find((p) => same(p.tf, tf))?.id ?? CUSTOM_TF_ID;
}

const byX = <T extends { x: number }>(pts: readonly T[]): T[] => [...pts].sort((p, q) => p.x - q.x);

/** 折線取值（超出兩端取端點）。 */
export function evalOpacity(tf: TransferFunction, x: number): number {
  return interp(tf.opacity.map((p) => [p.x + tf.shift, p.a] as const), x);
}

export function evalColor(tf: TransferFunction, x: number): [number, number, number] {
  const pts = tf.color;
  return [
    interp(pts.map((p) => [p.x + tf.shift, p.r] as const), x),
    interp(pts.map((p) => [p.x + tf.shift, p.g] as const), x),
    interp(pts.map((p) => [p.x + tf.shift, p.b] as const), x),
  ];
}

function interp(pts: readonly (readonly [number, number])[], x: number): number {
  if (pts.length === 0) return 0;
  const s = [...pts].sort((a, b) => a[0] - b[0]);
  if (x <= s[0]![0]) return s[0]![1];
  if (x >= s[s.length - 1]![0]) return s[s.length - 1]![1];
  for (let i = 1; i < s.length; i += 1) {
    const [x0, y0] = s[i - 1]!;
    const [x1, y1] = s[i]!;
    if (x <= x1) return x1 === x0 ? y1 : y0 + ((y1 - y0) * (x - x0)) / (x1 - x0);
  }
  return s[s.length - 1]![1];
}

/** 送後端的形狀（shift 已套上）。 */
export function tfToWire(tf: TransferFunction): { scalar_opacity: number[][]; scalar_color: number[][]; shade: boolean; ambient: number; diffuse: number; specular: number } {
  return {
    scalar_opacity: byX(tf.opacity).map((p) => [round(p.x + tf.shift), round(p.a)]),
    scalar_color: byX(tf.color).map((p) => [round(p.x + tf.shift), round(p.r), round(p.g), round(p.b)]),
    shade: tf.shade,
    ambient: tf.ambient,
    diffuse: tf.diffuse,
    specular: tf.specular,
  };
}

const round = (v: number): number => Number(v.toFixed(4));

export function withOpacityPoint(tf: TransferFunction, index: number, point: OpacityPoint): TransferFunction {
  const pts = tf.opacity.map((p, i) => (i === index ? { x: point.x, a: Math.max(0, Math.min(1, point.a)) } : p));
  return { ...tf, opacity: byX(pts) };
}

export function addOpacityPoint(tf: TransferFunction, point: OpacityPoint): TransferFunction {
  return { ...tf, opacity: byX([...tf.opacity, { x: point.x, a: Math.max(0, Math.min(1, point.a)) }]) };
}

/** 至少留兩點。 */
export function removeOpacityPoint(tf: TransferFunction, index: number): TransferFunction {
  if (tf.opacity.length <= 2) return tf;
  return { ...tf, opacity: tf.opacity.filter((_, i) => i !== index) };
}

export function withColorPoint(tf: TransferFunction, index: number, point: ColorPoint): TransferFunction {
  return { ...tf, color: byX(tf.color.map((p, i) => (i === index ? point : p))) };
}

export function addColorPoint(tf: TransferFunction, x: number): TransferFunction {
  const [r, g, b] = evalColor({ ...tf, shift: 0 }, x);
  return { ...tf, color: byX([...tf.color, { x, r, g, b }]) };
}

export function removeColorPoint(tf: TransferFunction, index: number): TransferFunction {
  if (tf.color.length <= 2) return tf;
  return { ...tf, color: tf.color.filter((_, i) => i !== index) };
}

export function serializeTf(tf: TransferFunction): string {
  return JSON.stringify(tf);
}

export function parseTf(text: string | null | undefined): TransferFunction | null {
  if (!text) return null;
  try {
    const raw = JSON.parse(text) as Partial<TransferFunction>;
    if (!Array.isArray(raw.opacity) || !Array.isArray(raw.color) || raw.opacity.length < 2 || raw.color.length < 2) return null;
    const okO = raw.opacity.every((p) => typeof p === 'object' && p !== null && Number.isFinite((p as OpacityPoint).x) && Number.isFinite((p as OpacityPoint).a));
    const okC = raw.color.every((p) => typeof p === 'object' && p !== null && ['x', 'r', 'g', 'b'].every((k) => Number.isFinite((p as unknown as Record<string, number>)[k])));
    if (!okO || !okC) return null;
    return {
      opacity: byX(raw.opacity as OpacityPoint[]),
      color: byX(raw.color as ColorPoint[]),
      shift: Number.isFinite(raw.shift) ? (raw.shift as number) : 0,
      shade: raw.shade !== false,
      ambient: Number.isFinite(raw.ambient) ? (raw.ambient as number) : shading.ambient,
      diffuse: Number.isFinite(raw.diffuse) ? (raw.diffuse as number) : shading.diffuse,
      specular: Number.isFinite(raw.specular) ? (raw.specular as number) : shading.specular,
    };
  } catch {
    return null;
  }
}

export function rgbToHex(r: number, g: number, b: number): string {
  const h = (v: number) => Math.round(Math.max(0, Math.min(1, v)) * 255).toString(16).padStart(2, '0');
  return `#${h(r)}${h(g)}${h(b)}`;
}

export function hexToRgb(hex: string): [number, number, number] {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
  if (!m) return [1, 1, 1];
  return [parseInt(m[1]!, 16) / 255, parseInt(m[2]!, 16) / 255, parseInt(m[3]!, 16) / 255];
}
