/** 管理頁「射束模型」—— 能譜柱、PDD 內插與折線、準直器說明、校正條件、科學記號。 */

import { describe, expect, it } from 'vitest';

import { calibrationText, collimatorText, pddAt, pddPoints, scientific, spectrumBars } from '../src/react/dosecalc/beamModelModel';

describe('射束模型', () => {
  it('能譜柱：每段從上一段的上界到自己的上界、高度正規化到 1', () => {
    expect(spectrumBars([0.5, 1, 2], [2, 4, 1])).toEqual([
      { lo: 0, hi: 0.5, height: 0.5 },
      { lo: 0.5, hi: 1, height: 1 },
      { lo: 1, hi: 2, height: 0.25 },
    ]);
  });
  it('PDD：線性內插、範圍外 null；折線座標', () => {
    const pdd: [number, number][] = [
      [1, 0.5],
      [3, 1],
      [5, 0.75],
    ];
    expect(pddAt(pdd, 2)).toBeCloseTo(0.75);
    expect(pddAt(pdd, 4)).toBeCloseTo(0.875);
    expect(pddAt(pdd, 9)).toBeNull();
    expect(pddPoints(pdd, 100, 10, 5)).toBe('20.0,5.0 60.0,0.0 100.0,2.5');
  });
  it('準直器說明：材質、厚度、距靶、葉片長或固定開口', () => {
    const mlc = collimatorText({ device: 'MLCX', kind: 'mlc', source_to_upstream_mm: 465, thickness_mm: 67, material: 'G4_W', leaf_length_mm: 320 });
    expect(mlc).toBe('鎢 67 mm、距靶 465 mm、葉片長 320 mm（等中心投影）');
    expect(collimatorText({ device: 'fixed_y', kind: 'fixed', source_to_upstream_mm: 250, thickness_mm: 70, material: 'G4_W', half_field_mm: 140 })).toContain('開口 ± 140 mm');
  });
  it('校正條件與科學記號', () => {
    expect(calibrationText({ field_mm: 100, ssd_mm: 1000, depth: 'dmax', gy_per_mu: 0.01 })).toBe('10 × 10 cm²、SSD 100 cm、水中 dmax：1 MU ＝ 1 cGy');
    expect(scientific(3438306693056.59)).toBe('3.44 × 10^12');
    expect(scientific(0)).toBe('—');
  });
});
