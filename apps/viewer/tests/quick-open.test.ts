/**
 * 手機資料頁「一鍵開啟」挑哪一張影像（`react/data/quickOpen.ts`）。
 */
import { describe, expect, it } from 'vitest';

import type { ImageRow, SeriesChildren, TemporalCandidate } from '../src/react/data/catalogApi';
import { quickOpenChoice } from '../src/react/data/quickOpen';

function img(uid: string, over: Partial<ImageRow> = {}): ImageRow {
  return {
    kind: 'image',
    series_instance_uid: uid,
    study_instance_uid: 'st',
    patient_id: 'p',
    modality: 'CT',
    series_date: '',
    series_time: '',
    series_description: uid,
    series_number: '1',
    frame_of_reference_uid: 'for',
    manufacturer_model_name: '',
    instance_count: 10,
    is_image: true,
    refs: {},
    links: {},
    rt_count: 0,
    rtstruct_count: 0,
    plan_count: 0,
    dose_count: 0,
    registration_count: 0,
    registrations_targeting: 0,
    hit: false,
    hit_count: 0,
    ...over,
  };
}

function group(key: string, auto: boolean, uids: string[]): TemporalCandidate {
  return {
    key,
    kind: 'cyclic',
    axis: 'phase',
    unit: '%',
    confidence: auto ? 'high' : 'low',
    auto,
    source: 'test',
    frame_count: uids.length,
    frame_labels: null,
    frame_times: null,
    frame_series_uids: uids,
    derived: [],
    excluded: [],
    warnings: [],
  };
}

const children = (images: ImageRow[], temporal: TemporalCandidate[] = []): SeriesChildren => ({ images, unlinked: [], temporal });

describe('一鍵開啟挑哪一張', () => {
  it('掛著 RT 物件多的優先', () => {
    const c = quickOpenChoice(children([img('a'), img('b', { rt_count: 3 }), img('c', { rt_count: 1 })]));
    expect(c?.kind === 'image' && c.image.series_instance_uid).toBe('b');
  });

  it('RT 一樣多：CT → MR → PT', () => {
    const c = quickOpenChoice(children([img('pt', { modality: 'PT' }), img('mr', { modality: 'MR' }), img('ct', { modality: 'CT', series_number: '9' })]));
    expect(c?.kind === 'image' && c.image.series_instance_uid).toBe('ct');
  });

  it('同分：單張先於 4D 組；組挑整組（排除的成員不帶）', () => {
    const members = ['f0', 'f1'].map((u, i) => img(u, { temporal: { key: 'g', role: 'frame', index: i } }));
    const excluded = img('fx', { temporal: { key: 'g', role: 'excluded', reason: 'grid' } });
    const single = img('avg', { series_number: '50' });
    expect(quickOpenChoice(children([...members, excluded, single], [group('g', true, ['f0', 'f1'])]))?.kind).toBe('image');
    const only = quickOpenChoice(children([...members, excluded], [group('g', true, ['f0', 'f1'])]));
    expect(only?.kind).toBe('group');
    expect(only?.kind === 'group' && only.members.map((m) => m.series_instance_uid)).toEqual(['f0', 'f1']);
  });

  it('組的 RT 多 → 選組', () => {
    const members = ['f0', 'f1'].map((u, i) => img(u, { temporal: { key: 'g', role: 'frame', index: i }, rt_count: i === 0 ? 2 : 0 }));
    const c = quickOpenChoice(children([...members, img('other')], [group('g', true, ['f0', 'f1'])]));
    expect(c?.kind).toBe('group');
  });

  it('低信心的組（預設不合併）當成各自的單張', () => {
    const members = ['f0', 'f1'].map((u, i) => img(u, { temporal: { key: 'g', role: 'frame', index: i }, series_number: String(i + 1) }));
    const c = quickOpenChoice(children(members, [group('g', false, ['f0', 'f1'])]));
    expect(c?.kind === 'image' && c.image.series_instance_uid).toBe('f0');
  });

  it('解不開的壓縮格式不選；沒有能開的 → null', () => {
    const c = quickOpenChoice(children([img('bad', { decodable: false, rt_count: 5 }), img('ok')]));
    expect(c?.kind === 'image' && c.image.series_instance_uid).toBe('ok');
    expect(quickOpenChoice(children([img('bad', { decodable: false })]))).toBeNull();
    expect(quickOpenChoice(children([]))).toBeNull();
  });
});
