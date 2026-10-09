/**
 * 色階表（colormap）註冊表 —— `Layer.colormap` 的落點。
 *
 * 每個色階是 256 筆 RGB 的 LUT（`Uint8Array(768)`），輸入是 0–255 的正規化值。
 * 影像用 `gray` 與幾個融合用的單色（Slicer 慣例：CT 灰、CBCT 綠或洋紅），
 * 劑量用 `jet`／`hot`／`viridis`。模組可以 `registerColormap()` 加自己的。
 *
 * 🔴 這裡只有查表，沒有任何「這是影像還是劑量」的判斷 —— 誰用哪個色階是
 * layer 的參數，不是核心的知識。
 */

import { t } from '../i18n';

export type ColormapLut = Uint8Array; // 256 × RGB

const colormaps = new Map<string, ColormapLut>();

export function registerColormap(name: string, lut: ColormapLut): void {
  if (lut.length !== 768) throw new Error(t('colormap「{name}」必須是 256×3 的 LUT', { name }));
  colormaps.set(name, lut);
}

export function hasColormap(name: string): boolean {
  return colormaps.has(name);
}

export function listColormaps(): string[] {
  return [...colormaps.keys()];
}

/**
 * 找不到就退回 `gray`，**並不拋例外**——色階名打錯不該讓整格畫面消失。
 * 內建色階尚未註冊時（測試直接用後端）順手註冊，因此永遠有 `gray`。
 */
export function getColormap(name: string | null | undefined): ColormapLut {
  if (!colormaps.has('gray')) registerBuiltinColormaps();
  return (name ? colormaps.get(name) : undefined) ?? colormaps.get('gray')!;
}

// ── 內建 ─────────────────────────────────────────────────────────────────────

function fromFn(f: (t: number) => [number, number, number]): ColormapLut {
  const lut = new Uint8Array(768);
  for (let i = 0; i < 256; i += 1) {
    const [r, g, b] = f(i / 255);
    lut[i * 3] = clamp255(r * 255);
    lut[i * 3 + 1] = clamp255(g * 255);
    lut[i * 3 + 2] = clamp255(b * 255);
  }
  return lut;
}

function clamp255(v: number): number {
  return v <= 0 ? 0 : v >= 255 ? 255 : Math.round(v);
}

/** 由若干控制點線性插補（t ∈ [0,1]）。 */
function piecewise(stops: [number, [number, number, number]][]): (t: number) => [number, number, number] {
  return (t) => {
    if (t <= stops[0]![0]) return stops[0]![1];
    for (let i = 1; i < stops.length; i += 1) {
      const [t1, c1] = stops[i]!;
      if (t <= t1) {
        const [t0, c0] = stops[i - 1]!;
        const u = t1 === t0 ? 0 : (t - t0) / (t1 - t0);
        return [c0[0] + (c1[0] - c0[0]) * u, c0[1] + (c1[1] - c0[1]) * u, c0[2] + (c1[2] - c0[2]) * u];
      }
    }
    return stops[stops.length - 1]![1];
  };
}

/** 核心內建的色階。冪等。 */
export function registerBuiltinColormaps(): void {
  if (colormaps.has('gray')) return;
  registerColormap('gray', fromFn((t) => [t, t, t]));
  // 融合用單色（CT–CBCT 對位檢查常用綠／洋紅互補）
  registerColormap('green', fromFn((t) => [0, t, 0]));
  registerColormap('magenta', fromFn((t) => [t, 0, t]));
  registerColormap('red', fromFn((t) => [t, 0, 0]));
  registerColormap('cyan', fromFn((t) => [0, t, t]));
  registerColormap('warm', fromFn((t) => [t, t * 0.62, t * 0.25]));
  registerColormap('cool', fromFn((t) => [t * 0.3, t * 0.6, t]));
  // 劑量用
  registerColormap(
    'jet',
    fromFn(
      piecewise([
        [0.0, [0, 0, 0.5]],
        [0.125, [0, 0, 1]],
        [0.375, [0, 1, 1]],
        [0.625, [1, 1, 0]],
        [0.875, [1, 0, 0]],
        [1.0, [0.5, 0, 0]],
      ]),
    ),
  );
  registerColormap(
    'hot',
    fromFn(
      piecewise([
        [0.0, [0, 0, 0]],
        [0.33, [1, 0, 0]],
        [0.66, [1, 1, 0]],
        [1.0, [1, 1, 1]],
      ]),
    ),
  );
  // 差值劑量（A − B）的發散色階 —— 藍＝負、白＝0、紅＝正（0 在正中間 128）
  registerColormap(
    'diverging',
    fromFn(
      piecewise([
        [0.0, [0.02, 0.19, 0.38]],
        [0.25, [0.26, 0.58, 0.76]],
        [0.5, [0.97, 0.97, 0.97]],
        [0.75, [0.84, 0.38, 0.3]],
        [1.0, [0.4, 0.0, 0.12]],
      ]),
    ),
  );
  registerColormap(
    'viridis',
    fromFn(
      piecewise([
        [0.0, [0.267, 0.005, 0.329]],
        [0.25, [0.229, 0.322, 0.545]],
        [0.5, [0.127, 0.566, 0.551]],
        [0.75, [0.369, 0.789, 0.383]],
        [1.0, [0.993, 0.906, 0.144]],
      ]),
    ),
  );
}

/** 供測試重置。 */
export function clearColormaps(): void {
  colormaps.clear();
}
