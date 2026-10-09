/**
 * 影像格右下角的等劑量線圖例（`viewport-overlay`）—— 每條線的顏色與數值；點色塊改那條線的顏色
 * （存在劑量 layer 的 `params.level_colors`，renderer 與圖例都經 `isodoseColor`，兩邊一致）。
 *
 * 只在 2D 格、有顯示中的劑量且開著等劑量線時出現；可以收起（所有格子共用一個開關，記在這台瀏覽器）。
 */

import { useSyncExternalStore } from 'react';

import { doseColorFraction, doseDisplayOf, dosePlanName, getColormap, isodoseColor, levelKey, type DoseDisplay, type Layer } from '../../core';
import { t } from '../../core/i18n';
import { fmtLevelGy } from './doseLevels';
import type { ViewerPanelProps } from './types';

const OPEN_KEY = 'rtgaia.dose.legend.open.v1';

/**
 * 沒記過 → 桌面預設展開；手機與平板預設收起（影像格窄，展開的圖例蓋住格子中央 —— 平板直式實測點中間點到的是圖例）。
 */
function readOpen(): boolean {
  const smallScreen = typeof document !== 'undefined' && (document.documentElement.dataset['form'] ?? 'desktop') !== 'desktop';
  try {
    const v = localStorage.getItem(OPEN_KEY);
    return v === null ? !smallScreen : v !== '0';
  } catch {
    return !smallScreen;
  }
}

// 所有格子共用一個開關：一格收起，每格都收起
let openState: boolean | null = null;
const listeners = new Set<() => void>();
function subscribeOpen(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
function getOpen(): boolean {
  if (openState === null) openState = readOpen();
  return openState;
}
function setLegendOpen(v: boolean): void {
  openState = v;
  try {
    localStorage.setItem(OPEN_KEY, v ? '1' : '0');
  } catch {
    /* 私密視窗 */
  }
  for (const fn of listeners) fn();
}

export function hexOf(rgb: readonly [number, number, number]): string {
  return `#${rgb.map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('')}`;
}

/** 圖例上的一條：顏色、文字（% 模式顯示 %，否則 Gy）、覆寫用的 key。 */
export function legendEntries(d: DoseDisplay): { key: string; text: string; hex: string; custom: boolean }[] {
  return d.levelsGy.map((g) => {
    const key = levelKey(g);
    const text = d.display === 'percent' && d.referenceGy > 0 ? `${+((g / d.referenceGy) * 100).toFixed(1)}%` : `${fmtLevelGy(g)} Gy`;
    return { key, text, hex: hexOf(isodoseColor(d, g)), custom: d.levelColors[key] !== undefined };
  });
}

/** 色階條（CSS 漸層）：從下界到上界，差值的 0 在對應的位置；標籤 ＝ 下界、（0）、上界。 */
export function colorBar(d: DoseDisplay): { gradient: string; labels: { pos: number; text: string }[] } {
  const lut = getColormap(d.colormap);
  const stops: string[] = [];
  const N = 16;
  for (let i = 0; i <= N; i += 1) {
    const f = i / N;
    const v = d.rangeLoGy + (d.rangeHiGy - d.rangeLoGy) * f;
    const k = Math.round(doseColorFraction(d, v) * 255) * 3;
    stops.push(`rgb(${lut[k]},${lut[k + 1]},${lut[k + 2]}) ${(f * 100).toFixed(1)}%`);
  }
  const labels = [
    { pos: 0, text: fmtLevelGy(d.rangeLoGy) },
    ...(d.signed ? [{ pos: -d.rangeLoGy / (d.rangeHiGy - d.rangeLoGy), text: '0' }] : []),
    { pos: 1, text: `${fmtLevelGy(d.rangeHiGy)} Gy` },
  ];
  return { gradient: `linear-gradient(to right, ${stops.join(', ')})`, labels };
}

function legendTitle(layer: Layer, index: number, count: number): string {
  // 劑量運算的結果用它自己的名字（「已照 2 次（…）」「差異：…」），日期都是今天、分不出來
  const derived = layer.params?.['derived'];
  if (derived !== null && typeof derived === 'object') {
    const text = (derived as Record<string, unknown>)['text'];
    if (typeof text === 'string' && text) return text.length > 28 ? `${text.slice(0, 27)}…` : text;
  }
  const plan = dosePlanName(layer);
  const date = layer.seriesMeta?.['series_date'];
  const d = typeof date === 'string' && date.length >= 8 ? `${date.slice(4, 6)}-${date.slice(6, 8)}` : '';
  if (count === 1) return t('等劑量線');
  return [plan || `#${index + 1}`, d].filter((x) => x).join(' ');
}

export function DoseLegend({ api, viewportId }: ViewerPanelProps): React.JSX.Element | null {
  const open = useSyncExternalStore(subscribeOpen, getOpen, getOpen);
  const cell = api.state.layout.cells.find((c) => c.cellId === viewportId);
  if (!cell || cell.content.kind !== 'viewport' || cell.content.is3D === true) return null;
  const shown = api.state.layers
    .filter((l) => l.kind === 'dose' && l.visible)
    .map((l) => ({ layer: l, d: doseDisplayOf(l) }))
    .filter((x) => (x.d.isolines && x.d.levelsGy.length > 0) || x.d.colorwash);
  if (shown.length === 0) return null;
  return (
    <div className="dose-legend" data-open={open ? 'true' : 'false'}>
      <button type="button" className="dose-legend-toggle" aria-expanded={open} onClick={() => setLegendOpen(!open)} title={open ? t('收起等劑量線圖例') : t('顯示等劑量線圖例')}>
        {open ? '▾' : '▸'} {t('等劑量線')}
      </button>
      {open &&
        shown.map(({ layer, d }, i) => {
          const colors = (layer.params?.['level_colors'] as Record<string, string> | undefined) ?? {};
          const entries = legendEntries(d);
          const anyCustom = entries.some((e) => e.custom);
          return (
            <div key={layer.layerId} className="dose-legend-group">
              {shown.length > 1 && <div className="dose-legend-title muted">{legendTitle(layer, i, shown.length)}</div>}
              {d.colorwash && <ColorBar d={d} />}
              {(d.isolines ? entries : []).map((e) => (
                <label key={e.key} className="dose-legend-row" title={t('點色塊改這條線的顏色')}>
                  <span className="dose-legend-swatch" style={{ background: e.hex }} />
                  <input
                    type="color"
                    aria-label={t('{p0} 的顏色', { p0: e.text })}
                    value={e.hex}
                    onChange={(ev) => api.commands.setLayerParams(layer.layerId, { level_colors: { ...colors, [e.key]: ev.target.value } })}
                  />
                  <span>{e.text}</span>
                </label>
              ))}
              {anyCustom && (
                <button type="button" className="dose-legend-reset" onClick={() => api.commands.setLayerParams(layer.layerId, { level_colors: {} })} title={t('線色回到色階')}>
                  {t('重設顏色')}
                </button>
              )}
            </div>
          );
        })}
    </div>
  );
}

function ColorBar({ d }: { d: DoseDisplay }): React.JSX.Element {
  const bar = colorBar(d);
  return (
    <div className="dose-colorbar" title={t('colorwash 的色階：{lo} … {hi} Gy', { lo: fmtLevelGy(d.rangeLoGy), hi: fmtLevelGy(d.rangeHiGy) })}>
      <div className="dose-colorbar-bar" style={{ background: bar.gradient }} />
      <div className="dose-colorbar-labels">
        {bar.labels.map((l) => (
          <span key={l.pos} style={{ left: `${(l.pos * 100).toFixed(1)}%` }} data-pos={l.pos}>
            {l.text}
          </span>
        ))}
      </div>
    </div>
  );
}
