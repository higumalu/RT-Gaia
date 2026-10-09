/**
 * 計畫模組：射束欄位的文字、ISO 標記的文字與判斷、可畫的 ISO、快取。
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  beamKindText,
  clearPlanCache,
  drawableIsocenters,
  energyText,
  fetchPlans,
  gantryText,
  isoLabel,
  isoOnPlane,
  machineText,
  metersetText,
  totalMeterset,
  type PlanBeam,
  type PlanInfo,
} from '../src/react/modules/plan/model';

const beam = (over: Partial<PlanBeam>): PlanBeam => ({
  number: 2,
  name: 'ARC1',
  description: '',
  beam_type: 'DYNAMIC',
  radiation_type: 'PHOTON',
  delivery_type: 'TREATMENT',
  is_treatment: true,
  machine_name: 'Halcyon1',
  manufacturer: 'Varian Medical Systems',
  model: 'RDS',
  energy: 6,
  energy_unit: 'MV',
  control_points: 180,
  gantry_start_deg: 179,
  gantry_end_deg: 180.1,
  gantry_direction: 'CC',
  is_arc: true,
  collimator_deg: 5,
  couch_deg: 0,
  isocenter_mm: [1, 2, 3],
  meterset: 182.636949,
  meterset_unit: 'MU',
  sad_mm: 1000,
  devices: [],
  ...over,
});

const plan = (over: Partial<PlanInfo>): PlanInfo => ({
  plan_id: 'p1',
  label: 'PLAN1',
  name: '',
  frame_of_reference_uid: 'for',
  patient_positions: ['HFS'],
  fractions_planned: 10,
  prescription_gy: [20],
  machines: [{ name: 'Halcyon1', manufacturer: 'Varian Medical Systems', model: 'RDS' }],
  beams: [beam({}), beam({ number: 3, meterset: 100 }), beam({ number: 1, is_treatment: false, delivery_type: 'SETUP', meterset: null, is_arc: false })],
  isocenters: [{ position_mm: [1, 2, 3], position_primary_mm: [4, 5, 6], beam_numbers: [1, 2, 3] }],
  mappable: true,
  ...over,
});

afterEach(() => clearPlanCache());

describe('射束欄位', () => {
  it('機架：弧 ＝ 起 → 止 方向；固定 ＝ 角度', () => {
    expect(gantryText(beam({}))).toBe('179 → 180.1 CC');
    expect(gantryText(beam({ is_arc: false, gantry_start_deg: 0 }))).toBe('0');
    expect(gantryText(beam({ is_arc: false, gantry_start_deg: null }))).toBe('–');
  });
  it('種類、能量、MU、治療機', () => {
    expect(beamKindText(beam({}))).toBe('弧');
    expect(beamKindText(beam({ is_arc: false }))).toBe('固定');
    expect(beamKindText(beam({ is_treatment: false, delivery_type: 'SETUP' }))).toBe('設定');
    expect(beamKindText(beam({ is_treatment: false, delivery_type: 'VERIFICATION' }))).toBe('VERIFICATION');
    expect(energyText(beam({}))).toBe('6 MV');
    expect(energyText(beam({ energy: null }))).toBe('–');
    expect(metersetText(beam({}))).toBe('182.6');
    expect(metersetText(beam({ meterset: null }))).toBe('–');
    expect(machineText({ name: 'Halcyon1', manufacturer: 'Varian Medical Systems', model: 'RDS' })).toBe('Halcyon1 · Varian Medical Systems RDS');
    expect(machineText({ name: 'X', manufacturer: '', model: '' })).toBe('X');
  });
  it('總 MU 只算治療射束', () => {
    expect(totalMeterset(plan({}))).toBeCloseTo(282.636949);
    expect(totalMeterset(plan({ beams: [beam({ is_treatment: false, meterset: null })] }))).toBeNull();
  });
});

describe('ISO 標記', () => {
  it('在切面上（≤ 1.5 mm）只寫 ISO；不在就標帶正負號的距離；多個 ISO 編號', () => {
    expect(isoLabel(0.4, 0, 1)).toBe('ISO');
    expect(isoOnPlane(1.5)).toBe(true);
    expect(isoOnPlane(1.6)).toBe(false);
    // 軸向格（法線 −z）：ISO 在切面下方 100 mm → d ＝ +100 → I
    expect(isoLabel(100, 0, 2, [0, 0, -1])).toBe('ISO1 100.0 mm I');
    expect(isoLabel(-3, 1, 2, [0, 0, -1])).toBe('ISO2 3.0 mm S');
    // 冠狀（法線 +y）：d ＞ 0 → 往 P；矢狀（法線 −x）：d ＞ 0 → 往 R
    expect(isoLabel(12.34, 0, 1, [0, 1, 0])).toBe('ISO 12.3 mm P');
    expect(isoLabel(5, 0, 1, [-1, 0, 0])).toBe('ISO 5.0 mm R');
    // 斜面：取法線最大的軸
    expect(isoLabel(5, 0, 1, [0.2, 0, -0.98])).toBe('ISO 5.0 mm I');
  });
  it('只畫有 primary 座標的 ISO（病例裡沒有計畫 FoR 的影像就略過）', () => {
    const a = plan({});
    const b = plan({ plan_id: 'p2', isocenters: [{ position_mm: [0, 0, 0], position_primary_mm: null, beam_numbers: [1] }], mappable: false });
    expect(drawableIsocenters([a, b])).toEqual([{ planId: 'p1', world: [4, 5, 6] }]);
  });
});

describe('抓取快取', () => {
  it('同一個 key 只抓一次；失敗不留在快取', async () => {
    const getJson = vi.fn().mockResolvedValue({ study_id: 's', plans: [] });
    await fetchPlans('s', getJson, 's#c1');
    await fetchPlans('s', getJson, 's#c1');
    expect(getJson).toHaveBeenCalledTimes(1);
    expect(getJson).toHaveBeenCalledWith('/studies/s/plans');
    await fetchPlans('s', getJson, 's#c2'); // 病例重新組裝 → 重抓
    expect(getJson).toHaveBeenCalledTimes(2);
    const failing = vi.fn().mockRejectedValueOnce(new Error('boom')).mockResolvedValue({ study_id: 't', plans: [] });
    await expect(fetchPlans('t', failing)).rejects.toThrow('boom');
    await fetchPlans('t', failing);
    expect(failing).toHaveBeenCalledTimes(2);
  });
});
