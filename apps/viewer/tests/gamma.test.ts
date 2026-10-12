/**
 * γ 比較 —— 色階（1 在正中間、通過與失敗分兩半）、顯示參數、表單、TG-218 判定只對那一組條件、失敗點的說明、
 * γ 圖不是劑量（DVH 與劑量清單碰不到它）、依空間分組另列。
 */

import { describe, expect, it } from 'vitest';

import type { Layer } from '../src/core/layers/types';
import { gammaColorFraction, gammaDisplayOf, gammaLut } from '../src/core/raster/gammaModule';
import { groupLayersByFrame } from '../src/react/panels/dataModel';
import { DEFAULT_GAMMA_CRITERIA, gammaCandidates, gammaExplanation, gammaRequest, gammaVerdict, isTg218Criteria, type GammaStats } from '../src/react/modules/doseops/gammaModel';
import type { DoseOpSource } from '../src/react/modules/doseops/model';
import { dvhSelection } from '../src/react/modules/dvh/model';
import { neededFullResFrames } from '../src/react/modules/temporal/model';
import { registerCoreBuiltins } from '../src/core/bootstrap';

registerCoreBuiltins();

const layer = (kind: string, id: string, params: Record<string, unknown> = {}, forUid = 'F'): Layer =>
  ({ layerId: `${kind}:${id}`, kind, contentRef: id, frameOfReferenceUid: forUid, visible: true, opacity: 0.6, params, label: id }) as unknown as Layer;

const src = (over: Partial<DoseOpSource>): DoseOpSource => ({
  series_id: 'a',
  label: 'plan',
  frame_of_reference_uid: 'F',
  max_gy: 50,
  min_gy: 0,
  units: 'GY',
  dose_type: 'PHYSICAL',
  summation_type: 'PLAN',
  registration: { kind: 'primary', matrix_type: null },
  fractions_planned: null,
  plan_label: null,
  derived: false,
  eligible: true,
  problems: [],
  notes: [],
  gamma_problems: [],
  ...over,
});

const stats = (over: Partial<GammaStats>): GammaStats => ({
  criteria: DEFAULT_GAMMA_CRITERIA,
  criteria_label: '3%/2 mm G, 10%',
  norm_gy: 50,
  reference_max_gy: 50,
  threshold_gy: 5,
  candidates: 1000,
  evaluated: 1000,
  no_data: 0,
  pass_rate: 0.97,
  mean_gamma: 0.4,
  p95_gamma: 0.9,
  max_gamma: 1.6,
  capped: 0,
  histogram: { edges: [0, 1, 2], counts: [970, 30] },
  failures: { count: 30, high_gradient: 5, flat: 25, flat_hot: 24, flat_cold: 1 },
  seconds: 1.2,
  reference_series_id: 'a',
  evaluated_series_id: 'b',
  reference_label: 'TPS',
  evaluated_label: 'MC',
  notes: [],
  ...over,
});

describe('γ 色階', () => {
  it('1 永遠在正中間；上限 2 或 3 都一樣', () => {
    expect(gammaColorFraction(0, 2)).toBe(0);
    expect(gammaColorFraction(1, 2)).toBeCloseTo(0.5);
    expect(gammaColorFraction(1, 3)).toBeCloseTo(0.5);
    expect(gammaColorFraction(2, 2)).toBe(1);
    expect(gammaColorFraction(2, 3)).toBeCloseTo(0.75);
    expect(gammaColorFraction(9, 2)).toBe(1);
    expect(gammaColorFraction(Number.NaN, 2)).toBe(0);
  });
  it('通過的一半偏藍綠、失敗的一半偏黃紅（在 1 斷開）', () => {
    const lut = gammaLut();
    const rgb = (i: number): number[] => [lut[i * 3]!, lut[i * 3 + 1]!, lut[i * 3 + 2]!];
    const [r0, , b0] = rgb(0);
    expect(b0).toBeGreaterThan(r0!);
    const [rFail, gFail] = rgb(255);
    expect(rFail).toBeGreaterThan(gFail!);
    const below = rgb(127);
    const above = rgb(128);
    expect(above[0]! - below[0]!).toBeGreaterThan(50);
  });
  it('顯示參數的預設', () => {
    expect(gammaDisplayOf(layer('gamma', 'g', { max_gamma: 3 }))).toEqual({ maxGamma: 3, colorwash: true, isolines: true, failOnly: false });
    expect(gammaDisplayOf(layer('gamma', 'g', { fail_only: true, isolines: false })).failOnly).toBe(true);
    expect(gammaDisplayOf(layer('gamma', 'g', { max_gamma: 'x' })).maxGamma).toBe(2);
  });
});

describe('γ 表單', () => {
  it('被評估的候選：同一個空間、能比、不是參考自己', () => {
    const ref = src({ series_id: 'a' });
    const list = [ref, src({ series_id: 'b' }), src({ series_id: 'c', frame_of_reference_uid: 'G' }), src({ series_id: 'd', gamma_problems: ['差值'] })];
    expect(gammaCandidates(ref, list).map((s) => s.series_id)).toEqual(['b']);
    expect(gammaCandidates(undefined, list)).toEqual([]);
  });
  it('數字欄位的範圍跟後端一樣', () => {
    const ok = { doseText: '3', dtaText: '2', thresholdText: '10', normalization: 'global' as const, resolution: 5 as const, maxGamma: 2 };
    expect(gammaRequest(ok)).toEqual([{ dose_pct: 3, dta_mm: 2, threshold_pct: 10, normalization: 'global', resolution: 5, max_gamma: 2 }, null]);
    expect(gammaRequest({ ...ok, doseText: '0' })[1]).not.toBeNull();
    expect(gammaRequest({ ...ok, dtaText: 'x' })[1]).not.toBeNull();
    expect(gammaRequest({ ...ok, thresholdText: '' })[1]).not.toBeNull();
    expect(gammaRequest({ ...ok, thresholdText: '100' })[1]).not.toBeNull();
  });
});

describe('γ 判定與說明', () => {
  it('TG-218 的判定只對 3%/2 mm、全域、10% 門檻', () => {
    expect(isTg218Criteria(DEFAULT_GAMMA_CRITERIA)).toBe(true);
    expect(gammaVerdict(stats({ pass_rate: 0.96 }))).toBe('pass');
    expect(gammaVerdict(stats({ pass_rate: 0.92 }))).toBe('review');
    expect(gammaVerdict(stats({ pass_rate: 0.85 }))).toBe('action');
    expect(gammaVerdict(stats({ criteria: { ...DEFAULT_GAMMA_CRITERIA, normalization: 'local' } }))).toBeNull();
    expect(gammaVerdict(stats({ criteria: { ...DEFAULT_GAMMA_CRITERIA, dta_mm: 3 } }))).toBeNull();
    expect(gammaVerdict(stats({ pass_rate: null }))).toBeNull();
  });
  it('平坦區幾乎都偏高 → 說是系統性的', () => {
    const lines = gammaExplanation(stats({}));
    expect(lines.some((l) => l.includes('高梯度區 17%') && l.includes('平坦區 83%'))).toBe(true);
    expect(lines.some((l) => l.includes('偏高（96%）') && l.includes('系統性'))).toBe(true);
  });
  it('有偏高也有偏低、沒有失敗、上限、後端附註', () => {
    const mixed = gammaExplanation(stats({ failures: { count: 10, high_gradient: 0, flat: 10, flat_hot: 5, flat_cold: 5 }, capped: 2, notes: ['附註'] }));
    expect(mixed.some((l) => l.includes('有偏高也有偏低'))).toBe(true);
    expect(mixed.some((l) => l.includes('2 點 γ ≥ 2'))).toBe(true);
    expect(mixed.at(-1)).toBe('附註');
    expect(gammaExplanation(stats({ failures: { count: 0, high_gradient: 0, flat: 0, flat_hot: 0, flat_cold: 0 } })).some((l) => l.includes('沒有失敗'))).toBe(true);
  });
});

describe('γ 圖不是劑量', () => {
  it('依空間分組時另列，不混在劑量裡', () => {
    const layers = [layer('dose', 'd'), layer('gamma', 'g')];
    const [g] = groupLayersByFrame(layers, [{ frameOfReferenceUid: 'F', role: 'primary' } as never]);
    expect(g!.doses.map((l) => l.contentRef)).toEqual(['d']);
    expect(g!.gammas.map((l) => l.contentRef)).toEqual(['g']);
  });
  it('DVH 預選的劑量碰不到 γ 圖', () => {
    const sel = dvhSelection([layer('gamma', 'g', { units: 'NONE', quantity: 'gamma' }), layer('dose', 'd', { units: 'GY', max_gy: 50 })], undefined);
    expect(sel.doseIds).toEqual(['d']);
  });
});

describe('γ 圖的體素', () => {
  it('看得見的 γ 圖要抓全解析度（跟劑量一樣是 volume；以前只認影像與劑量，γ 圖從來沒抓、畫面空白）', () => {
    const need = neededFullResFrames([layer('gamma', 'g'), layer('dose', 'd'), layer('mask', 'm')], [], {});
    expect([...need.keys()].sort()).toEqual(['d', 'g']);
  });
});
