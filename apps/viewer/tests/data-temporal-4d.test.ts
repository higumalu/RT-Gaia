/**
 * 真實 DICOM 的 4D：資料頁的 4D 組（一列、勾整組、合併開關、成員徽章）、
 * 送出的 `temporal_overrides`、時間軸列的幀名稱、只在某幾幀的結構。
 */

import { describe, expect, it } from 'vitest';

import type { ImageRow, SeriesChildren, TemporalCandidate } from '../src/react/data/catalogApi';
import { EMPTY_SELECTION, toSessionRequest } from '../src/react/data/selection';
import { dynamicBadge, groupMembers, groupNote, groupState, groupTitle, isMerged, memberBadge, setMerged, toggleGroup } from '../src/react/data/temporalRows';
import { EMPTY_TREE, flatten, studyKey, temporalKey, toggleExpanded, withSeries, withStudies } from '../src/react/data/tree';
import { frameText, groupTitle as barTitle } from '../src/react/modules/temporal/model';
import { frameNoteOf } from '../src/react/panels/DataPanel';
import { render3dLayers } from '../src/react/modules/render3d/model';
import { presetTf } from '../src/react/modules/render3d/transferFunction';

const group = (over: Partial<TemporalCandidate> = {}): TemporalCandidate => ({
  key: 'tg_abc',
  kind: 'cyclic',
  axis: 'phase',
  unit: null,
  confidence: 'high',
  auto: true,
  source: 'series_description',
  frame_count: 3,
  frame_labels: ['0%', '50%', '90%'],
  frame_times: null,
  frame_series_uids: ['p0', 'p50', 'p90'],
  derived: [{ series_uid: 'avg', op: 'avg' }],
  excluded: [{ series_uid: 'p30', label: '30%', reason: 'slice_count', detail: '39 片（其他 40 片）' }],
  warnings: [],
  ...over,
});

const img = (uid: string, temporal?: ImageRow['temporal'], over: Partial<ImageRow> = {}): ImageRow =>
  ({
    series_instance_uid: uid,
    study_instance_uid: 'st',
    patient_id: 'P',
    modality: 'CT',
    series_date: '20261001',
    series_description: uid,
    is_image: true,
    links: {},
    refs: {},
    instance_count: 40,
    kind: 'image',
    rt_count: 0,
    rtstruct_count: 0,
    plan_count: 0,
    dose_count: 0,
    registration_count: 0,
    registrations_targeting: 0,
    hit: true,
    hit_count: 0,
    frame_of_reference_uid: '1.2.3',
    ...(temporal ? { temporal } : {}),
    ...over,
  }) as unknown as ImageRow;

const rows = (): ImageRow[] => [
  img('avg', { key: 'tg_abc', role: 'derived', op: 'avg' }),
  img('p50', { key: 'tg_abc', role: 'frame', index: 1, label: '50%' }),
  img('ng'),
  img('p30', { key: 'tg_abc', role: 'excluded', label: '30%', reason: 'slice_count' }),
  img('p0', { key: 'tg_abc', role: 'frame', index: 0, label: '0%' }),
  img('p90', { key: 'tg_abc', role: 'frame', index: 2, label: '90%' }),
];

describe('資料頁的 4D 組', () => {
  it('一列：成員依幀順序 → 衍生 → 排除；放在第一個成員的位置；展開才列出成員', () => {
    const children: SeriesChildren = { images: rows(), unlinked: [], temporal: [group()] };
    let tree = withSeries(withStudies(toggleExpanded(EMPTY_TREE, 'p:P'), 'P', [{ study_instance_uid: 'st' } as never]), 'st', children);
    tree = toggleExpanded(tree, studyKey('st'));
    const flat = flatten(tree, [{ patient_id: 'P', study_count: 1 } as never]);
    const kinds = flat.slice(2).map((r) => (r.kind === 'image' ? r.row.series_instance_uid : r.kind));
    expect(kinds).toEqual(['temporal', 'ng']);
    const t = flat[2]!;
    expect(t.kind === 'temporal' && t.row.members.map((m) => m.series_instance_uid)).toEqual(['p0', 'p50', 'p90', 'avg', 'p30']);
    const open = flatten(toggleExpanded(tree, temporalKey('tg_abc')), [{ patient_id: 'P', study_count: 1 } as never]);
    expect(open.filter((r) => r.kind === 'image' && r.depth === 3).length).toBe(5);
    expect(groupMembers(group(), rows()).length).toBe(5);
  });

  it('標題、附註、成員徽章；低信心的說「可能是」', () => {
    expect(groupTitle(group())).toBe('4D · 3 個相位（0%…90%）');
    expect(groupTitle(group({ axis: 'amplitude', frame_labels: ['In 0%', 'Ex 25%'], frame_count: 8 }))).toBe('4D · 振幅分箱 · 8 個（In 0%…Ex 25%）');
    expect(groupTitle(group({ confidence: 'low', auto: false, axis: 'time', frame_labels: null, frame_count: 10 }))).toBe('可能是同一次動態掃描 · 10 個時間點（沒有相位標籤）');
    expect(groupNote(group())).toBe('＋ AVG · 排除 1 個相位');
    expect(memberBadge(rows()[1]!)).toEqual({ text: '50%' });
    expect(memberBadge(rows()[0]!)).toEqual({ text: 'AVG' });
    expect(memberBadge(rows()[3]!, group())).toEqual({ text: '30% 已排除', title: '39 片（其他 40 片）' });
    expect(memberBadge(rows()[2]!)).toBeNull();
    expect(dynamicBadge({ dynamic: { repeats: 12 } })).toBe('動態 ×12');
    expect(dynamicBadge({ dynamic: { repeats: 4, frames: 4, axis: 'b_value', labeled: true, guessed: true } })).toBe('b 值（推定）×4');
    expect(dynamicBadge({ dynamic: { repeats: 4, frames: 4, axis: 'b_value', labeled: false } })).toBe('b 值未知 ×4');
    expect(dynamicBadge({})).toBeNull();
    expect(dynamicBadge({ multiframe: { frames: 400 } })).toBe('多幀 400');
  });

  it('勾整組：成員全部選進來（被排除的不選）、primary 換成第一個相位；再勾一次全部取消', () => {
    const members = groupMembers(group(), rows());
    const all = rows();
    const sel = toggleGroup({ ...EMPTY_SELECTION, images: ['avg'], primary: 'avg' }, group(), members, all);
    expect([...sel.images].sort()).toEqual(['avg', 'p0', 'p50', 'p90']);
    expect(sel.primary).toBe('p0'); // 4D 組當 primary（原本的 primary 是組員 AVG）
    expect(groupState(sel, members.filter((m) => m.temporal?.role !== 'excluded'))).toBe('all');
    const other = toggleGroup({ ...EMPTY_SELECTION, images: ['ng'], primary: 'ng' }, group(), members, all);
    expect(other.primary).toBe('ng'); // 使用者先選了組外的影像 → 不搶
    const off = toggleGroup(sel, group(), members, all);
    expect(off.images).toEqual([]);
    expect(groupState({ ...EMPTY_SELECTION, images: ['p0'] }, members)).toBe('some');
  });

  it('合併開關：預設照信心；改了才送 temporal_overrides；改回預設就拿掉', () => {
    const hi = group();
    const lo = group({ key: 'tg_low', auto: false, confidence: 'low' });
    expect(isMerged(EMPTY_SELECTION, hi)).toBe(true);
    expect(isMerged(EMPTY_SELECTION, lo)).toBe(false);
    let sel = setMerged(setMerged(EMPTY_SELECTION, hi, false), lo, true);
    expect(toSessionRequest(sel)['temporal_overrides']).toEqual({ tg_abc: 'split', tg_low: 'merge' });
    sel = setMerged(setMerged(sel, hi, true), lo, false);
    expect(toSessionRequest(sel)['temporal_overrides']).toBeUndefined();
  });
});

describe('時間軸列與結構', () => {
  it('幀名稱：相位、振幅、參數軸（含單位）；沒有名稱照舊', () => {
    const base = { cursor: 4, frameCount: 10, frameTimes: null } as const;
    expect(frameText({ ...base, kind: 'cyclic', axisLabel: 'phase', frameLabels: ['0%', '10%', '20%', '30%', '40%', '50%', '60%', '70%', '80%', '90%'], unit: null })).toBe('相位 40%（5／10）');
    expect(frameText({ kind: 'cyclic', cursor: 3, frameCount: 8, frameTimes: null, axisLabel: 'amplitude', frameLabels: ['In 0%', 'In 25%', 'In 50%', 'In 75%'], unit: null })).toBe('振幅 In 75%（4／8）');
    expect(frameText({ kind: 'series', cursor: 1, frameCount: 3, frameTimes: null, axisLabel: 'b_value', frameLabels: ['b 0', 'b 500', 'b 1000'], unit: 's/mm²' })).toBe('b 500 s/mm²（2／3）');
    expect(frameText({ kind: 'series', cursor: 1, frameCount: 4, frameTimes: null, axisLabel: 'echo_time', frameLabels: ['TE 2.4 ms', 'TE 4.8 ms'], unit: 'ms' })).toBe('TE 4.8 ms（2／4）');
    expect(frameText({ ...base, kind: 'cyclic' })).toBe('相位 5／10');
    expect(barTitle({ kind: 'cyclic', axisLabel: 'amplitude' })).toBe('呼吸振幅');
    expect(barTitle({ kind: 'cyclic', axisLabel: 'phase' })).toBe('呼吸／心臟相位');
  });

  it('只在某幾幀的結構：「只在 50%」；每一幀都有或靜態的不標', () => {
    const temporal = [{ temporalGroupId: 'tg', frameCount: 10, frameLabels: ['0%', '10%', '20%', '30%', '40%', '50%', '60%', '70%', '80%', '90%'] }];
    expect(frameNoteOf({ temporalGroupId: 'tg', frames: [5] }, temporal)).toBe('只在 50%');
    expect(frameNoteOf({ temporalGroupId: 'tg', frames: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9] }, temporal)).toBeNull();
    expect(frameNoteOf({ temporalGroupId: null }, temporal)).toBeNull();
    expect(frameNoteOf({ temporalGroupId: 'tg', frames: [2] }, [{ temporalGroupId: 'tg', frameCount: 3, frameLabels: null }])).toBe('只在 #3');
  });

  it('3D：只在某幾幀的結構，這一幀沒有它就不送（以前整張 404）', () => {
    const mask = (id: string, frames?: number[]) => ({ layerId: `mask:${id}`, kind: 'mask', label: id, groupId: null, frameOfReferenceUid: 'F', contentRef: id, visible: true, opacity: 1, order: 1, temporalGroupId: 'tg', ...(frames ? { frames } : {}) });
    const layers = [mask('GTV_00', [0]), mask('GTV_50', [5]), mask('ALL')] as never;
    const out = render3dLayers(layers, { frameOfReferenceUid: 'F' } as never, { technique: 'composite', window: { center: 0, width: 1 }, tf: presetTf(undefined), frameOf: () => 5 });
    expect(out.map((l) => l['structure_id'])).toEqual(['GTV_50', 'ALL']);
  });
});
