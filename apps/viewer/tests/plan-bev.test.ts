/**
 * BEV／MLC —— 開口（單層、雙層交集、jaw 裁切、關閉的葉片）、面積、葉片本體、BEV 大小、預設射束、控制點讀數。
 */

import { describe, expect, it } from 'vitest';

import { leafRects } from '../src/react/modules/plan/bevDraw';
import {
  apertureAreaCm2,
  apertureRects,
  bevHalfSizeMm,
  clampCp,
  cpReadout,
  defaultBevBeam,
  mlcLayers,
  type BeamControlPoints,
  type BeamDevice,
  type ControlPoint,
  type PlanInfo,
} from '../src/react/modules/plan/model';

const devices: BeamDevice[] = [
  { type: 'X', pairs: 1, boundaries_mm: null },
  { type: 'Y', pairs: 1, boundaries_mm: null },
  { type: 'MLCX1', pairs: 2, boundaries_mm: [-10, 0, 10] },
  { type: 'MLCX2', pairs: 2, boundaries_mm: [-5, 5, 15] },
];

const cp = (over: Partial<ControlPoint> = {}): ControlPoint => ({
  index: 0,
  gantry_deg: 181,
  collimator_deg: 5,
  couch_deg: 0,
  weight: 0,
  mu: 0,
  dose_rate: null,
  jaws: { x: [-100, 100], y: [-100, 100] },
  mlc: {
    MLCX1: { a: [-20, -10], b: [20, -10] }, // 第二對關著
    MLCX2: { a: [-5, -5], b: [30, 30] },
  },
  ...over,
});

describe('開口', () => {
  it('單層：每對開著的葉片一個矩形；關閉的不算', () => {
    const r = apertureRects(cp(), devices, 'MLCX1');
    expect(r).toEqual([{ x1: -20, x2: 20, y1: -10, y2: 0 }]);
    expect(apertureAreaCm2(r)).toBeCloseTo(4); // 40 × 10 mm² ＝ 4 cm²
  });

  it('雙層：兩層都開才有光（交集）', () => {
    const r = apertureRects(cp(), devices);
    // MLCX1 帶 y −10…0、x −20…20；MLCX2 帶 y −5…5、x −5…30 → 交集 y −5…0、x −5…20
    expect(r).toEqual([{ x1: -5, x2: 20, y1: -5, y2: 0 }]);
    expect(apertureAreaCm2(r)).toBeCloseTo(1.25);
  });

  it('jaw 裁切；沒有 MLC 時開口就是 jaw', () => {
    const narrow = cp({ jaws: { x: [-3, 10], y: [-100, 100] } });
    expect(apertureRects(narrow, devices, 'MLCX1')).toEqual([{ x1: -3, x2: 10, y1: -10, y2: 0 }]);
    const jawsOnly = apertureRects(cp({ mlc: {} }), devices.slice(0, 2));
    expect(jawsOnly).toEqual([{ x1: -100, x2: 100, y1: -100, y2: 100 }]);
    expect(apertureAreaCm2(jawsOnly)).toBeCloseTo(400);
  });

  it('葉片本體：A 側從場邊到葉尖、B 側從葉尖到場邊', () => {
    const layer = mlcLayers(devices)[0]!;
    const { a, b } = leafRects(cp(), layer, 140);
    expect(a[0]).toEqual({ x1: -140, x2: -20, y1: -10, y2: 0 });
    expect(b[0]).toEqual({ x1: 20, x2: 140, y1: -10, y2: 0 });
    expect(a.length).toBe(2);
  });
});

describe('讀數與預設', () => {
  const bcp: BeamControlPoints = {
    number: 2,
    name: 'F',
    beam_type: 'DYNAMIC',
    is_treatment: true,
    meterset: 182.6,
    meterset_unit: 'MU',
    sad_mm: 1000,
    gantry_direction: 'CC',
    final_weight: 1,
    devices,
    control_points: [cp({ index: 0, mu: 0, delta_mu: 0, mu_per_deg: null }), cp({ index: 1, gantry_deg: 179, mu: 0.43, delta_mu: 0.43, mu_per_deg: 0.2163 })],
  };

  it('控制點讀數', () => {
    expect(cpReadout(bcp, 1)).toBe('CP 2 / 2 · 機架 179° · 准直器 5° · 床 0° · 0.4 / 182.6 MU · 0.22 MU/°');
    expect(cpReadout(bcp, 99)).toContain('CP 2 / 2');
    expect(clampCp(-3, 2)).toBe(0);
  });

  it('BEV 大小取葉片邊界與 jaw 的最大值，進位到 10 mm', () => {
    expect(bevHalfSizeMm(bcp)).toBe(100);
    expect(bevHalfSizeMm({ ...bcp, control_points: [cp({ jaws: { x: [-143, 143], y: null } })] })).toBe(150);
  });

  it('預設射束：自己選的 → 第一個治療射束', () => {
    const plan = { beams: [{ number: 1, is_treatment: false }, { number: 2, is_treatment: true }, { number: 3, is_treatment: true }] } as unknown as PlanInfo;
    expect(defaultBevBeam(plan, undefined)).toBe(2);
    expect(defaultBevBeam(plan, 3)).toBe(3);
    expect(defaultBevBeam(plan, 9)).toBe(2);
  });
});

describe('BEV 視野（預設窗口不能太小）', () => {
  it('適合開口：所有 CP 開口的最大範圍 × 1.2、進位到 10 mm；整個照野：葉片邊界與 jaw；Ctrl 縮放', async () => {
    const { apertureExtentMm, bevGridStepMm, bevViewHalfMm } = await import('../src/react/modules/plan/model');
    const b: BeamControlPoints = {
      number: 2, name: 'F', beam_type: 'DYNAMIC', is_treatment: true, meterset: 1, meterset_unit: 'MU', sad_mm: 1000,
      gantry_direction: 'CW', final_weight: 1, devices, control_points: [cp()],
    }; // fmt: skip
    expect(apertureExtentMm(b)).toBe(20); // 雙層交集 x −5…20、y −5…0
    expect(bevViewHalfMm(b, 'fit')).toBe(30); // 20 × 1.2 ＝ 24 → 進位 30（下限 30）
    expect(bevViewHalfMm(b, 'field')).toBe(100);
    expect(bevViewHalfMm(b, 'field', 2)).toBe(50);
    expect(bevViewHalfMm(b, 'fit', 99)).toBe(10); // 放大到底：30 ÷ 4 ＝ 7.5，但至少畫 10 mm
    expect([bevGridStepMm(140), bevGridStepMm(80), bevGridStepMm(30)]).toEqual([50, 20, 10]);
  });
});
