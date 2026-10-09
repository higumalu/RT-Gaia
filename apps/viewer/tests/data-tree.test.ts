/**
 * 目錄樹的純狀態：攤平規則（PLAN 容納 DOSE、未關聯群、載入中列）、命中路徑、已載入序列。
 */

import { describe, expect, it } from 'vitest';

import type { ImageRow, PatientRow, RtRow, SearchHit, StudyRow } from '../src/react/data/catalogApi';
import {
  EMPTY_TREE,
  clearChildren,
  expandMany,
  expandable,
  flatten,
  imageKey,
  keysForHit,
  loadedSeries,
  patientKey,
  planKey,
  setError,
  setExpanded,
  studyKey,
  toggleExpanded,
  unlinkedKey,
  withRt,
  withSeries,
  withStudies,
} from '../src/react/data/tree';

const patient: PatientRow = {
  kind: 'patient',
  patient_id: 'P1',
  study_count: 1,
  series_count: 6,
  image_series_count: 2,
  modalities: ['CT', 'RTSTRUCT', 'RTPLAN', 'RTDOSE', 'REG'],
  date_from: '20260601',
  date_to: '20260605',
  hit_count: 6,
};
const study: StudyRow = {
  kind: 'study',
  study_instance_uid: 'st1',
  patient_id: 'P1',
  study_date: '20260601',
  study_description: 'pelvis',
  image_series_count: 2,
  rt_object_count: 4,
  unlinked_count: 1,
  modalities: [],
  hit_count: 6,
};
type AnyRow = RtRow & ImageRow;

function series(uid: string, modality: string, extra: Record<string, unknown> = {}): AnyRow {
  return {
    series_instance_uid: uid,
    study_instance_uid: 'st1',
    patient_id: 'P1',
    modality,
    series_date: '20260601',
    series_time: '',
    series_description: modality,
    series_number: '1',
    frame_of_reference_uid: 'for',
    manufacturer_model_name: '',
    instance_count: 1,
    is_image: modality === 'CT',
    refs: {},
    links: {},
    kind: 'other',
    hit: true,
    rt_count: 0,
    rtstruct_count: 0,
    plan_count: 0,
    dose_count: 0,
    registration_count: 0,
    registrations_targeting: 0,
    hit_count: 1,
    ...extra,
  } as unknown as AnyRow;
}
const ct = series('ct', 'CT', { kind: 'image', rt_count: 3, plan_count: 1, dose_count: 1 });
const cbct = series('cbct', 'CT', { kind: 'image', rt_count: 0 });
const rs = series('rs', 'RTSTRUCT', { kind: 'rtstruct' });
const dose = series('dose', 'RTDOSE', { kind: 'dose', plan_missing: false });
const plan = series('plan', 'RTPLAN', { kind: 'plan', doses: [dose] });
const reg = series('reg', 'REG', { kind: 'reg' });
const orphan = series('orphan', 'RTDOSE', { kind: 'dose', plan_missing: true });

describe('攤平', () => {
  it('只畫病人；展開後子項未載入 → loading 列', () => {
    const rows = flatten(EMPTY_TREE, [patient]);
    expect(rows.map((r) => r.kind)).toEqual(['patient']);
    const opened = setExpanded(EMPTY_TREE, patientKey('P1'), true);
    expect(flatten(opened, [patient]).map((r) => r.kind)).toEqual(['patient', 'loading']);
  });

  it('PLAN 容納 DOSE；孤兒劑量掛影像；未關聯群獨立一列', () => {
    let t = expandMany(EMPTY_TREE, [patientKey('P1'), studyKey('st1'), imageKey('ct')]);
    t = withStudies(t, 'P1', [study]);
    t = withSeries(t, 'st1', { images: [ct, cbct], unlinked: [orphan] });
    t = withRt(t, 'ct', [rs, plan, reg]);
    const rows = flatten(t, [patient]);
    expect(rows.map((r) => `${r.depth}:${r.kind}${r.kind === 'rt' ? ':' + r.row.kind : ''}`)).toEqual([
      '0:patient',
      '1:study',
      '2:image',
      '3:rt:rtstruct',
      '3:rt:plan',
      '3:rt:reg',
      '2:image',
      '2:unlinked',
    ]);
    // 計畫要展開才看到劑量，且劑量多一層
    const t2 = expandMany(t, [planKey('plan'), unlinkedKey('st1')]);
    const rows2 = flatten(t2, [patient]);
    const kinds = rows2.map((r) => `${r.depth}:${r.kind === 'rt' ? r.row.kind : r.kind}`);
    expect(kinds).toContain('4:dose');
    expect(kinds.indexOf('4:dose')).toBe(kinds.indexOf('3:plan') + 1);
    // 未關聯群展開 → 孤兒劑量在 depth 3
    expect(kinds.slice(-2)).toEqual(['2:unlinked', '3:dose']);
    // 沒有 RT 的影像不可展開；計畫有劑量可展開
    const imgRows = rows2.filter((r) => r.kind === 'image');
    expect(imgRows.map(expandable)).toEqual([true, false]);
    expect(rows2.filter((r) => r.kind === 'rt' && r.row.kind === 'plan').map(expandable)).toEqual([true]);
  });

  it('錯誤列取代 loading；篩選變了清子項但保留展開', () => {
    let t = setExpanded(EMPTY_TREE, patientKey('P1'), true);
    t = setError(t, patientKey('P1'), '500');
    expect(flatten(t, [patient]).at(-1)).toMatchObject({ kind: 'error', message: '500' });
    t = withStudies(t, 'P1', [study]);
    const cleared = clearChildren(t);
    expect(cleared.studies.size).toBe(0);
    expect(cleared.errors.size).toBe(0);
    expect(cleared.expanded.has(patientKey('P1'))).toBe(true);
    expect(toggleExpanded(cleared, patientKey('P1')).expanded.has(patientKey('P1'))).toBe(false);
  });
});

describe('命中 → 展開路徑', () => {
  const base = { patient_id: 'P1', study_instance_uid: 'st1' };
  it('影像命中展到 study；RT 命中展到影像；計畫底下的劑量再展計畫；未關聯展未關聯群', () => {
    const img: SearchHit = { kind: 'image', series_instance_uid: 'ct', label: '', path: { ...base, image_series_uid: 'ct', plan_series_uid: null, unlinked: false } };
    expect(keysForHit(img)).toEqual([patientKey('P1'), studyKey('st1')]);
    const rsHit: SearchHit = { ...img, kind: 'rtstruct', series_instance_uid: 'rs' };
    expect(keysForHit(rsHit)).toEqual([patientKey('P1'), studyKey('st1'), imageKey('ct')]);
    const doseHit: SearchHit = { ...img, kind: 'dose', series_instance_uid: 'dose', path: { ...img.path, plan_series_uid: 'plan' } };
    expect(keysForHit(doseHit).at(-1)).toBe(planKey('plan'));
    const orphanHit: SearchHit = { ...img, kind: 'dose', series_instance_uid: 'o', path: { ...base, image_series_uid: null, plan_series_uid: null, unlinked: true } };
    expect(keysForHit(orphanHit).at(-1)).toBe(unlinkedKey('st1'));
  });
});

describe('已載入序列', () => {
  it('影像、RT、計畫底下的劑量、未關聯都算 —— 選取模型的 all', () => {
    let t = withSeries(EMPTY_TREE, 'st1', { images: [ct, cbct], unlinked: [orphan] });
    t = withRt(t, 'ct', [rs, plan, reg]);
    expect(loadedSeries(t).map((s) => s.series_instance_uid).sort()).toEqual(['cbct', 'ct', 'dose', 'orphan', 'plan', 'reg', 'rs']);
  });
});

describe('展開中的節點（篩選／重掃後要重抓）', () => {
  it('列出 p:/s:/i: 三種、由外往內排序；plan:/u: 不需要自己抓', async () => {
    const { expandedTargets } = await import('../src/react/data/tree');
    const t = expandMany(EMPTY_TREE, [imageKey('ct'), planKey('plan'), studyKey('st1'), unlinkedKey('st1'), patientKey('P1')]);
    expect(expandedTargets(t)).toEqual([
      { key: patientKey('P1'), kind: 'patient', id: 'P1' },
      { key: studyKey('st1'), kind: 'study', id: 'st1' },
      { key: imageKey('ct'), kind: 'image', id: 'ct' },
    ]);
    expect(expandedTargets(EMPTY_TREE)).toEqual([]);
  });
});
