/**
 * PET SUV（image layer `params.value_unit`／`value_scale`）與 Gamma Knife shot 的純函式。
 */
import { describe, expect, it } from 'vitest';

import { createGrid } from '../src/core/geometry';
import type { DisplayGrid, FrameGroup } from '../src/core/geometry';
import type { Layer } from '../src/core/layers/types';
import { formatReadingValue, probeImageLayers, toDisplayValue, toStoredValue, valueScaleOf } from '../src/core/scene/probe';
import type { ImageEntry } from '../src/core/scene/volumeStore';
import { drawableIsocenters, shotBeamOf, shotLabel, type PlanBeam, type PlanInfo } from '../src/react/modules/plan/model';

const FOR = '1.2.3';
const grid = createGrid({ size: [4, 4, 4], spacing: [1, 1, 1], origin: [0, 0, 0], direction: [1, 0, 0, 0, 1, 0, 0, 0, 1], frameOfReferenceUid: FOR });

function pet(params?: Record<string, unknown>): Layer {
  return {
    layerId: 'image:pt',
    kind: 'image',
    label: 'PT',
    groupId: 'images',
    frameOfReferenceUid: FOR,
    contentRef: 'pt',
    visible: true,
    opacity: 1,
    order: 0,
    modality: 'PT',
    ...(params ? { params } : {}),
  };
}

describe('valueScaleOf', () => {
  it('後端給的單位與比例優先；沒有 → 模態的單位、比例 1', () => {
    expect(valueScaleOf(pet({ value_unit: 'SUV', value_scale: 0.01 }))).toEqual({ unit: 'SUV', scale: 0.01 });
    expect(valueScaleOf(pet({ value_unit: 'Bq/ml', value_scale: 1 }))).toEqual({ unit: 'Bq/ml', scale: 1 });
    expect(valueScaleOf(pet())).toEqual({ unit: 'a.u.', scale: 1 });
    expect(valueScaleOf({ modality: 'CT' })).toEqual({ unit: 'HU', scale: 1 });
    expect(valueScaleOf(pet({ value_unit: 'SUV', value_scale: -1 })).scale).toBe(1); // 不合理的比例不用
    expect(valueScaleOf(undefined)).toEqual({ unit: 'a.u.', scale: 1 });
  });
  it('存的值 ↔ 顯示的值（四捨五入到單位的小數位數）', () => {
    const vs = { unit: 'SUV', scale: 0.01 };
    expect(toDisplayValue(123, vs)).toBe(1.23);
    expect(toDisplayValue(250, vs)).toBe(2.5);
    expect(toStoredValue(2.5, vs)).toBe(250);
    expect(toDisplayValue(40, { unit: 'HU', scale: 1 })).toBe(40);
  });
});

describe('PET 讀數', () => {
  it('SUV×100 存 → 讀數 2 位小數、標 SUV', () => {
    const voxels = new Int16Array(64).fill(0);
    voxels[1 + 4 * (2 + 4 * 3)] = 457;
    const entry: ImageEntry = { seriesId: 'pt', lod: 0, grid, voxels, defaultWindow: { center: 250, width: 500 } };
    const dg = { displayGridId: 'dg', sourceGrid: grid, grid } as unknown as DisplayGrid;
    const fg: FrameGroup = { frameOfReferenceUid: FOR, seriesId: 'pt', role: 'primary', transformToPrimary: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1], transformKind: 'identity', coverageMaskId: null };
    const [r] = probeImageLayers({ world: [1, 2, 3], layers: [pet({ value_unit: 'SUV', value_scale: 0.01 })], displayGrid: dg, imageFor: () => entry, frameGroupFor: () => fg });
    expect(r!.value).toBe(4.57);
    expect(formatReadingValue(r!)).toBe('4.57 SUV');
    const [raw] = probeImageLayers({ world: [1, 2, 3], layers: [pet({ value_unit: 'Bq/ml', value_scale: 1 })], displayGrid: dg, imageFor: () => entry, frameGroupFor: () => fg });
    expect(formatReadingValue(raw!)).toBe('457 Bq/ml');
  });
});

describe('Gamma Knife shot', () => {
  const beam = (number: number, weight: number | null): PlanBeam =>
    ({ number, name: `A${number}`, is_treatment: true, meterset: 5, meterset_unit: 'MINUTE', shot: { beam_on_min: 5, weight, dose_rate: 2, collimator_mm: null } }) as unknown as PlanBeam;
  const plan = {
    plan_id: 'gk',
    technique: 'gamma_knife',
    beams: [beam(1, 1), beam(2, 0.256)],
    isocenters: [
      { position_mm: [0, 0, 0], position_primary_mm: [0, 0, 0], beam_numbers: [1] },
      { position_mm: [1, 0, 0], position_primary_mm: [1, 0, 0], beam_numbers: [2] },
    ],
  } as unknown as PlanInfo;
  it('標籤帶相對權重；沒有權重只有編號', () => {
    expect(shotBeamOf(plan, plan.isocenters[1]!)?.name).toBe('A2');
    expect(shotLabel(1, shotBeamOf(plan, plan.isocenters[1]!))).toBe('S2 · 26%');
    expect(shotLabel(0, null)).toBe('S1');
    expect(drawableIsocenters([plan]).map((i) => i.label)).toEqual(['S1 · 100%', 'S2 · 26%']);
  });
});

describe('射束劑量分組的文字', () => {
  it('列出計畫與射束；沒有射束號就只說幾個', async () => {
    const { beamGroupText } = await import('../src/react/modules/doseops/model');
    const g = { plan_sop_uid: '1.2.3.4.5.6.7.8.9', plan_label: 'BEAMS3', fraction_group: 1, fractions_planned: 5, expected_beams: [1, 2, 3], doses: [{ series_id: 'a', label: 'B1', beams: [1] }, { series_id: 'c', label: 'B3', beams: [3] }, { series_id: 'b', label: 'B2', beams: [2] }], missing: [], extra: [], duplicates: [], problems: [], eligible: true };
    expect(beamGroupText(g)).toBe('計畫 BEAMS3：3 個射束劑量（射束 1, 2, 3）');
    expect(beamGroupText({ ...g, plan_label: '', doses: [{ series_id: 'x', label: 'X', beams: [] }] })).toBe('計畫 ….6.7.8.9：1 個射束劑量');
  });
});

describe('射束劑量的名稱帶射束號', () => {
  it('BEAM ＋ referenced_beams → 「計畫 beam n」；計畫劑量照舊；沒有計畫標籤 → 空', async () => {
    const { dosePlanName } = await import('../src/core/raster/doseModule');
    expect(dosePlanName({ params: { referenced_plan_label: 'BEAMS3', summation_type: 'BEAM', referenced_beams: [[1, 2]] } })).toBe('BEAMS3 beam 2');
    expect(dosePlanName({ params: { referenced_plan_label: 'BEAMS3', summation_type: 'PLAN' } })).toBe('BEAMS3');
    expect(dosePlanName({ params: { summation_type: 'BEAM', referenced_beams: [[1, 2]] } })).toBe('');
  });
});
