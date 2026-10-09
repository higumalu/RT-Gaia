/**
 * 機架／治療床示意 —— 機型判斷（環型機／C 臂）、示意用的姿勢（床高合理範圍）、機頭在正面圖的位置。
 */

import { describe, expect, it } from 'vitest';

import { DEFAULT_TABLE_VERTICAL_MM, headPosition, machineKind, machinePose, type ControlPoint } from '../src/react/modules/plan/model';

const cp = (over: Partial<ControlPoint>): ControlPoint => ({
  index: 0,
  gantry_deg: 90,
  collimator_deg: 5,
  couch_deg: 10,
  weight: 0,
  mu: 0,
  dose_rate: null,
  jaws: { x: null, y: null },
  mlc: {},
  ...over,
});

describe('機型', () => {
  it('Halcyon／Ethos（機名 HAL…、ETH… 或型號含名字）是環型機，其餘 C 臂', () => {
    expect(machineKind({ machine_name: 'Halcyon1', model: 'RDS' })).toBe('ring');
    expect(machineKind({ machine_name: 'X', model: 'Ethos' })).toBe('ring');
    expect(machineKind({ machine_name: 'TrueBeam1', model: 'TDS' })).toBe('c-arm');
    expect(machineKind({})).toBe('c-arm');
  });
});

describe('姿勢', () => {
  it('床高：±500 mm 內照用（相對等中心），超過或缺值 → 預設', () => {
    expect(machinePose(cp({ table_vertical_mm: -96.3 })).tableVerticalMm).toBeCloseTo(-96.3);
    expect(machinePose(cp({ table_vertical_mm: 1472 })).tableVerticalMm).toBe(DEFAULT_TABLE_VERTICAL_MM);
    expect(machinePose(cp({})).tableVerticalMm).toBe(DEFAULT_TABLE_VERTICAL_MM);
    const p = machinePose(cp({ gantry_deg: null, couch_deg: null }));
    expect([p.gantry, p.couch, p.collimator]).toEqual([0, 0, 5]);
  });

  it('機頭位置：0° 在正上方、90° 在右（從床尾看）、180° 在下', () => {
    const r = (g: number): [number, number] => {
      const h = headPosition(g, 100);
      return [Math.round(h.x), Math.round(h.y)];
    };
    expect(r(0)).toEqual([0, 100]);
    expect(r(90)).toEqual([100, 0]);
    expect(r(180)).toEqual([0, -100]);
  });
});
