/** 射束資料 —— 量測寫回通用 CSV（給「改成 CSV 編輯」）、能不能畫、折線座標、清單的文字。 */

import { describe, expect, it } from 'vitest';

import { beamText, countsText, curvePath, machineText, plottable, toCsv, type Measurement } from '../src/react/dosecalc/beamDataModel';

const pdd: Measurement = {
  measurement_id: 'm1',
  kind: 'depth_dose',
  quantity: 'pdd',
  unit: 'percent',
  conditions: { field_mm: [100, 100], ssd_mm: 1000, normalization: 'dmax' },
  columns: ['depth_mm', 'value', 'uncertainty'],
  points: [
    [15, 100, null],
    [100, 66.4, 0.3],
  ],
  statistic: 'mean',
  n: 3,
  reference: 'Beyer 2013 Table 1',
};

const scalar: Measurement = {
  measurement_id: 'm2',
  kind: 'scalar',
  quantity: 'mlc_transmission',
  unit: 'fraction',
  conditions: { layer: 'distal', depth_mm: 100 },
  columns: ['value'],
  points: [[0.0041]],
  statistic: 'single',
  n: null,
  reference: '',
};

describe('寫回 CSV', () => {
  it('每筆以 # kind: 開頭、條件與欄位都寫出來；空的不確定度留白', () => {
    const csv = toCsv([pdd, scalar]);
    expect(csv).toBe(
      [
        '# kind: depth_dose',
        '# quantity: pdd',
        '# field_mm: 100 x 100',
        '# ssd_mm: 1000',
        '# normalization: dmax',
        '# unit: percent',
        '# statistic: mean',
        '# n: 3',
        '# reference: Beyer 2013 Table 1',
        '# columns: depth_mm, value, uncertainty',
        '15, 100',
        '100, 66.4, 0.3',
        '',
        '# kind: scalar',
        '# quantity: mlc_transmission',
        '# layer: distal',
        '# depth_mm: 100',
        '# unit: fraction',
        '# columns: value',
        '0.0041',
      ].join('\n'),
    );
  });
});

describe('顯示', () => {
  it('曲線類兩點以上才畫；單一量值、長方形輸出因子不畫', () => {
    expect(plottable(pdd)).toBe(true);
    expect(plottable(scalar)).toBe(false);
    expect(plottable({ ...pdd, kind: 'output_factor', columns: ['field_x_mm', 'field_y_mm', 'value'] })).toBe(false);
    expect(plottable({ ...pdd, points: [[100, 66]] })).toBe(false);
  });
  it('折線：x 從最小到最大、y 從 0 到最大值的 1.1 倍', () => {
    const { path, xMin, xMax, yMax, dots } = curvePath(pdd, 228, 128, 14);
    expect([xMin, xMax]).toEqual([15, 100]);
    expect(yMax).toBeCloseTo(110);
    expect(dots[0]![0]).toBe(14);
    expect(dots[0]![1]).toBeCloseTo(128 - 14 - (100 / 110) * 100);
    expect(dots[1]![0]).toBe(214);
    expect(path.split('L')).toHaveLength(2);
  });
  it('清單文字', () => {
    expect(beamText({ energy_mv: 6, fluence_mode: 'FFF' })).toBe('6 MV FFF');
    expect(beamText({ energy_mv: 10, fluence_mode: 'STANDARD' })).toBe('10 MV');
    expect(machineText({ manufacturer: 'Varian', model: 'TrueBeam', name: '' })).toBe('Varian TrueBeam');
    expect(countsText({ depth_dose: 3, scalar: 0, output_factor: 1 }, (k) => k)).toBe('depth_dose 3、output_factor 1');
  });
});
