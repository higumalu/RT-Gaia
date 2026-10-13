/**
 * 劑量計算的統計不確定度圖 —— 色階、顯示參數、不是劑量（分組另列、DVH 碰不到、沒有 RTDOSE 的說明）、
 * 暫存結果的摘要用 %。
 */

import { describe, expect, it } from 'vitest';

import type { Layer } from '../src/core/layers/types';
import { listLayerKinds } from '../src/core/raster/kinds';
import { UNCERTAINTY_KIND, uncertaintyColorFraction, uncertaintyDisplayOf, uncertaintyLut } from '../src/core/raster/uncertaintyModule';
import { groupLayersByFrame } from '../src/react/panels/dataModel';
import { summaryText } from '../src/react/modules/doseops/model';
import { dvhSelection } from '../src/react/modules/dvh/model';
import { hiddenLayersForCell } from '../src/react/modules/layout/model';
import { registerCoreBuiltins } from '../src/core/bootstrap';

registerCoreBuiltins();

const layer = (kind: string, id: string, params: Record<string, unknown> = {}, forUid = 'F'): Layer =>
  ({ layerId: `${kind}:${id}`, kind, contentRef: id, frameOfReferenceUid: forUid, visible: true, opacity: 0.6, params, label: id }) as unknown as Layer;

describe('不確定度圖', () => {
  it('註冊成自己的 kind', () => {
    expect(listLayerKinds().map((k) => k.kind)).toContain(UNCERTAINTY_KIND);
  });
  it('色階：0 → 上限線性、超過上限塗最深；深藍到紅', () => {
    expect(uncertaintyColorFraction(0, 10)).toBe(0);
    expect(uncertaintyColorFraction(5, 10)).toBeCloseTo(0.5);
    expect(uncertaintyColorFraction(40, 10)).toBe(1);
    expect(uncertaintyColorFraction(Number.NaN, 10)).toBe(0);
    const lut = uncertaintyLut();
    expect(lut.length).toBe(768);
    expect(lut[2]! > lut[0]!).toBe(true); // 起點偏藍
    expect(lut[255 * 3]! > lut[255 * 3 + 2]!).toBe(true); // 終點偏紅
  });
  it('顯示參數：後端給的上限與門檻，沒給用預設', () => {
    expect(uncertaintyDisplayOf(layer('uncertainty', 'u', { max_percent: 20, threshold_percent: 2 }))).toEqual({ maxPercent: 20, thresholdPercent: 2, colorwash: true, isolines: true });
    expect(uncertaintyDisplayOf(layer('uncertainty', 'u', { isolines: false }))).toMatchObject({ maxPercent: 10, thresholdPercent: 3, isolines: false });
  });
  it('不是劑量：分組另列、DVH 預選碰不到、換格時跟著 FoR 藏', () => {
    const layers = [layer('dose', 'd', { units: 'GY', max_gy: 50 }), layer('uncertainty', 'u', { units: 'PERCENT', quantity: 'uncertainty' }), layer('uncertainty', 'o', {}, 'G')];
    const [g] = groupLayersByFrame(layers, [{ frameOfReferenceUid: 'F', role: 'primary' } as never]);
    expect(g!.doses.map((l) => l.contentRef)).toEqual(['d']);
    expect(g!.uncertainties.map((l) => l.contentRef)).toEqual(['u']);
    expect(dvhSelection(layers, undefined).doseIds).toEqual(['d']);
    expect(hiddenLayersForCell(layers, 'F')).toEqual(['uncertainty:o']);
  });
  it('暫存結果的摘要是 %，不是 Gy', () => {
    const text = summaryText({ quantity: 'uncertainty', signed: false, summary: { max_gy: 12.34, min_gy: 0, mean_gy: 2.5, covered_fraction: 0.4 } } as never);
    expect(text).toContain('12.3%');
    expect(text).not.toContain('Gy');
  });
});
