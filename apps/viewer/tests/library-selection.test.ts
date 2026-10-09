/**
 * 資料選取頁的純邏輯：勾影像自動帶入 bundle、primary、估算、送出 body。
 */

import { describe, expect, it } from 'vitest';

import {
  addSeries,
  bucketOf,
  dependencyHint,
  EMPTY_SELECTION,
  estimateBytes,
  flattenSeries,
  formatDicomDate,
  isSelected,
  removeSeries,
  selectionProblems,
  selectionSummary,
  seriesSummary,
  setPrimary,
  toDicomDate,
  toggleSeries,
  toSessionRequest,
  type LibrarySeries,
  type LibraryTree,
} from '../src/react/data/selection';

function series(partial: Partial<LibrarySeries> & { series_instance_uid: string; modality: string }): LibrarySeries {
  return {
    study_instance_uid: 'st',
    patient_id: 'P1',
    series_date: '20260617',
    series_time: '',
    series_description: partial.modality,
    series_number: '1',
    frame_of_reference_uid: 'for.x',
    manufacturer_model_name: '',
    instance_count: 1,
    is_image: partial.modality === 'CT',
    refs: {},
    links: {},
    ...partial,
  };
}

const ct = series({
  series_instance_uid: 'ct',
  modality: 'CT',
  instance_count: 187,
  geometry_hint: { rows: 512, columns: 512, pixel_spacing: [1.27, 1.27], slice_thickness: 3, slice_count: 187 },
  links: { bundle: { structure_sets: ['rs'], doses: ['dose'], registrations: ['reg', 'reg-missing'], plans: ['plan'] } },
});
const cbct = series({ series_instance_uid: 'cbct', modality: 'CT', links: { bundle: { structure_sets: ['rs2'], doses: [], registrations: ['reg'], plans: [] } } });
const rs = series({ series_instance_uid: 'rs', modality: 'RTSTRUCT', refs: { roi_count: 35, structure_set_label: 'CT_PLAN' }, links: { roi_count: 35 } });
const rs2 = series({ series_instance_uid: 'rs2', modality: 'RTSTRUCT' });
const dose = series({ series_instance_uid: 'dose', modality: 'RTDOSE', refs: { dose_units: 'GY', frame_count: 187 }, links: { plan_label: 'ART1' } });
const reg = series({ series_instance_uid: 'reg', modality: 'REG', links: { matrix_types: ['RIGID'] } });
const plan = series({ series_instance_uid: 'plan', modality: 'RTPLAN', refs: { plan_label: 'ART1', prescription_gy: [20] } });
const all = [ct, cbct, rs, rs2, dose, reg, plan];

describe('選取集合', () => {
  it('模態 → 欄位；不認識的模態不進選取', () => {
    expect(bucketOf(ct)).toBe('images');
    expect(bucketOf(rs)).toBe('structureSets');
    expect(bucketOf(dose)).toBe('doses');
    expect(bucketOf(reg)).toBe('registrations');
    expect(bucketOf(plan)).toBe('plans');
    expect(bucketOf(series({ series_instance_uid: 'x', modality: 'SR' }))).toBeNull();
  });

  it('🔴 勾一個影像自動帶入它的 bundle（只帶索引裡存在的），第一個影像成為 primary', () => {
    const sel = addSeries(EMPTY_SELECTION, ct, all);
    expect(sel.images).toEqual(['ct']);
    expect(sel.structureSets).toEqual(['rs']);
    expect(sel.doses).toEqual(['dose']);
    expect(sel.registrations).toEqual(['reg']); // reg-missing 不在索引裡 → 不帶
    expect(sel.plans).toEqual(['plan']);
    expect(sel.primary).toBe('ct');
    // 再勾 CBCT：primary 不變，REG 不重複
    const two = addSeries(sel, cbct, all);
    expect(two.images).toEqual(['ct', 'cbct']);
    expect(two.registrations).toEqual(['reg']);
    expect(two.structureSets).toEqual(['rs', 'rs2']);
    expect(two.primary).toBe('ct');
  });

  it('RT 物件單獨勾只加自己；取消影像不連帶取消 RT 物件，但 primary 會換人', () => {
    let sel = addSeries(EMPTY_SELECTION, rs2, all);
    expect(sel).toEqual({ ...EMPTY_SELECTION, structureSets: ['rs2'] });
    sel = addSeries(addSeries(sel, ct, all), cbct, all);
    sel = removeSeries(sel, ct);
    expect(sel.images).toEqual(['cbct']);
    expect(sel.primary).toBe('cbct');
    expect(sel.structureSets).toEqual(['rs2', 'rs']);
    expect(isSelected(sel, 'ct')).toBe(false);
    expect(toggleSeries(toggleSeries(EMPTY_SELECTION, dose, all), dose, all)).toEqual(EMPTY_SELECTION);
  });

  it('setPrimary 只接受已選的影像', () => {
    const sel = addSeries(addSeries(EMPTY_SELECTION, ct, all), cbct, all);
    expect(setPrimary(sel, 'cbct').primary).toBe('cbct');
    expect(setPrimary(sel, 'rs').primary).toBe('ct');
  });

  it('送出 body 是 snake_case；問題清單擋住空選取', () => {
    const sel = addSeries(EMPTY_SELECTION, ct, all);
    expect(toSessionRequest(sel)).toEqual({
      primary_series_uid: 'ct',
      image_series_uids: ['ct'],
      structure_set_uids: ['rs'],
      dose_uids: ['dose'],
      registration_uids: ['reg'],
      plan_uids: ['plan'],
    });
    expect(selectionProblems(sel)).toEqual([]);
    expect(selectionProblems(EMPTY_SELECTION)).toEqual(['至少要選一個影像序列']);
    expect(selectionProblems({ ...sel, primary: 'nope' })).toEqual(['primary 不在選取的影像裡']);
  });

  it('記憶體估算：影像 int16、劑量 float32（量級）', () => {
    const sel = addSeries(EMPTY_SELECTION, ct, all);
    const bytes = estimateBytes(sel, all);
    expect(bytes).toBe(512 * 512 * 187 * 2 + 217 * 217 * 187 * 4);
  });
});

describe('顯示用的小工具', () => {
  it('日期轉換兩個方向', () => {
    expect(formatDicomDate('20260617')).toBe('2026-06-17');
    expect(formatDicomDate('')).toBe('');
    expect(toDicomDate('2026-06-17')).toBe('20260617');
  });

  it('序列摘要依模態', () => {
    expect(seriesSummary(ct)).toBe('512×512×187 · 3 mm');
    expect(seriesSummary(rs)).toBe('35 ROI · CT_PLAN');
    expect(seriesSummary(dose)).toBe('GY · 計畫 ART1');
    expect(seriesSummary(reg)).toBe('RIGID');
    expect(seriesSummary(plan)).toBe('ART1 · 處方 20 Gy');
  });

  it('flattenSeries 走完整棵樹', () => {
    const tree: LibraryTree = {
      total: 2,
      patients: [{ patient_id: 'P1', studies: [{ study_instance_uid: 's', study_date: '', study_description: '', series: [ct, rs] }] }],
    };
    expect(flattenSeries(tree).map((s) => s.series_instance_uid)).toEqual(['ct', 'rs']);
  });
});


describe('選取摘要與關聯提示', () => {
  const byUid = new Map(all.map((s) => [s.series_instance_uid, s]));
  it('沒選影像 → 引導；有 → 主要影像 · 其他影像 · RT 物件計數', () => {
    expect(selectionSummary(EMPTY_SELECTION, byUid)).toMatch(/還沒選影像/);
    const sel = addSeries(addSeries(EMPTY_SELECTION, ct, all), cbct, all);
    const text = selectionSummary(sel, byUid);
    expect(text).toMatch(/^主要影像 /);
    expect(text).toContain('另 1 組影像');
    expect(text).toContain('2 套結構集');
    expect(text).toContain('1 個劑量');
    expect(text).toContain('1 個對位');
    expect(text).toContain('1 個計畫');
  });
  it('勾影像帶進 bundle → 提示多了什麼；只加自己 → null；取消 → null', () => {
    const after = addSeries(EMPTY_SELECTION, ct, all);
    const hint = dependencyHint(EMPTY_SELECTION, after, ct);
    expect(hint).toContain('1 套結構集');
    expect(hint).toContain('1 個劑量');
    expect(hint).toContain('1 個對位');
    expect(hint).toContain('1 個計畫');
    expect(dependencyHint(EMPTY_SELECTION, addSeries(EMPTY_SELECTION, rs2, all), rs2)).toBeNull();
    expect(dependencyHint(after, removeSeries(after, ct), ct)).toBeNull();
  });
});

describe('解不了的壓縮格式不能選來開病例', () => {
  it('addSeries 擋掉 decodable:false 的影像；舊後端（沒有欄位）照常', async () => {
    const { addSeries, canOpenSeries, EMPTY_SELECTION } = await import('../src/react/data/selection');
    const base = { series_instance_uid: 'x', study_instance_uid: 's', patient_id: 'p', modality: 'CT', series_date: '', series_time: '', series_description: '', series_number: '', frame_of_reference_uid: 'f', manufacturer_model_name: '', instance_count: 3, is_image: true, refs: {}, links: {} };
    expect(canOpenSeries({})).toBe(true);
    expect(canOpenSeries({ decodable: false })).toBe(false);
    expect(addSeries(EMPTY_SELECTION, { ...base, decodable: false, decode_error: 'no' }, []).images).toEqual([]);
    expect(addSeries(EMPTY_SELECTION, base, []).images).toEqual(['x']);
  });
});
