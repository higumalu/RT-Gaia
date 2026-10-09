/**
 * 資料面板的純邏輯：依 FoR 分組、對位徽章、W/L 預設、只看這組。
 */

import { describe, expect, it } from 'vitest';

import { primaryFrameGroupOf, rowsToMat16ColumnMajor, type FrameGroup, type Layer } from '../src/core';
import {
  groupLayersByFrame,
  presetIdFor,
  registrationBadge,
  rowExpanded,
  windowTargetId,
  soloVisibility,
  WINDOW_PRESETS,
} from '../src/react/panels/dataModel';

function layer(partial: Partial<Layer> & { layerId: string; kind: string; frameOfReferenceUid: string }): Layer {
  return { label: partial.layerId, groupId: null, contentRef: partial.layerId, visible: true, opacity: 1, order: 0, ...partial };
}

const primary = primaryFrameGroupOf('for.a', 'ct');
const secondary: FrameGroup = {
  frameOfReferenceUid: 'for.b',
  seriesId: 'cbct',
  role: 'secondary',
  transformToPrimary: rowsToMat16ColumnMajor([
    [1, 0, 0, -15.3],
    [0, 1, 0, -178.6],
    [0, 0, 1, -31.4],
    [0, 0, 0, 1],
  ]),
  transformKind: 'rigid',
  coverageMaskId: null,
  registration: { source: 'REG', sopInstanceUid: '1.2.3', matrixType: 'RIGID', description: 'REG 20260617' },
};

const layers: Layer[] = [
  layer({ layerId: 'mask:b1', kind: 'mask', frameOfReferenceUid: 'for.b' }),
  layer({ layerId: 'image:cbct', kind: 'image', frameOfReferenceUid: 'for.b', modality: 'CBCT', seriesMeta: { series_date: '20260617', series_description: 'ART iCBCT' } }),
  layer({ layerId: 'dose:d1', kind: 'dose', frameOfReferenceUid: 'for.a' }),
  layer({ layerId: 'image:ct', kind: 'image', frameOfReferenceUid: 'for.a', modality: 'CT', seriesMeta: { series_date: '20260612', series_description: 'Pelvis 3.0' } }),
  layer({ layerId: 'mask:a1', kind: 'mask', frameOfReferenceUid: 'for.a' }),
  layer({ layerId: 'mask:a2', kind: 'mask', frameOfReferenceUid: 'for.a' }),
];

describe('groupLayersByFrame', () => {
  it('依 FoR 分組，primary 在前，標題來自 seriesMeta', () => {
    const groups = groupLayersByFrame(layers, [secondary, primary]);
    expect(groups.map((g) => g.frameOfReferenceUid)).toEqual(['for.a', 'for.b']);
    const [a, b] = groups;
    expect(a!.role).toBe('primary');
    expect(a!.images.map((l) => l.layerId)).toEqual(['image:ct']);
    expect(a!.doses.map((l) => l.layerId)).toEqual(['dose:d1']);
    expect(a!.masks).toHaveLength(2);
    expect(a!.title).toBe('CT 2026-06-12');
    expect(a!.subtitle).toBe('Pelvis 3.0');
    expect(b!.title).toBe('CBCT 2026-06-17');
    expect(b!.masks.map((l) => l.layerId)).toEqual(['mask:b1']);
  });

  it('沒有任何 layer 的 FrameGroup 不出現；沒有 FrameGroup 的 FoR 仍成組（role unknown）', () => {
    const groups = groupLayersByFrame([layer({ layerId: 'x', kind: 'image', frameOfReferenceUid: 'for.z' })], [primary]);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.role).toBe('unknown');
  });
});

describe('registrationBadge', () => {
  it('primary／REG／無對位／使用者關掉，四種都說得出來', () => {
    expect(registrationBadge(primary, false).kind).toBe('primary');
    const reg = registrationBadge(secondary, false);
    expect(reg.kind).toBe('registered');
    expect(reg.text).toBe('RIGID · Δ(-15.3, -178.6, -31.4) mm');
    expect(reg.detail).toContain('REG 20260617');
    expect(registrationBadge(secondary, true)).toMatchObject({ kind: 'disabled', text: '對位已停用', canToggle: true });
    expect(
      registrationBadge({ ...secondary, registration: { source: 'none', sopInstanceUid: null, matrixType: null, description: '找不到 REG' } }, false),
    ).toMatchObject({ kind: 'unregistered', text: '無對位' });
    expect(
      registrationBadge({ ...secondary, registration: { source: 'shared_frame', sopInstanceUid: null, matrixType: null, description: null } }, false).kind,
    ).toBe('shared');
  });

  /** 沒有對位時不能同時出現勾著的「套用對位」—— 看起來像「已經對好了」。 */
  it('「套用對位」只在真的有對位可套用（或使用者關掉了）時出現；五種狀態互斥', () => {
    const none = { ...secondary, registration: { source: 'none' as const, sopInstanceUid: null, matrixType: null, description: null } };
    expect(registrationBadge(primary, false).canToggle).toBe(false);
    expect(registrationBadge(none, false).canToggle).toBe(false);
    expect(registrationBadge({ ...secondary, registration: { source: 'shared_frame', sopInstanceUid: null, matrixType: null, description: null } }, false).canToggle).toBe(false);
    expect(registrationBadge(secondary, false).canToggle).toBe(true);
    expect(registrationBadge(secondary, true).canToggle).toBe(true);
    // 手動對位（已提交）標「手動」；微調未提交是自己的一種狀態（即使原本無對位）
    const manual = { ...secondary, registration: { source: 'manual' as const, sopInstanceUid: null, matrixType: 'RIGID', description: null } };
    expect(registrationBadge(manual, false).text).toMatch(/^手動 · RIGID · Δ/);
    const pending = registrationBadge(none, false, true);
    expect(pending).toMatchObject({ kind: 'pending', canToggle: true });
    expect(pending.text).toMatch(/^微調未提交 · Δ/);
    // 停用優先於一切（使用者關掉就是關掉）
    expect(registrationBadge(secondary, true, true).kind).toBe('disabled');
    const texts = new Set([registrationBadge(none, false), registrationBadge(secondary, false), registrationBadge(manual, false), pending, registrationBadge(secondary, true)].map((b) => b.kind + b.text.split(' · ')[0]));
    expect(texts.size).toBe(5);
  });
});

describe('W/L 預設與只看這組', () => {
  it('presetIdFor 反查；找不到就 custom', () => {
    expect(presetIdFor({ center: 40, width: 400 })).toBe('soft');
    expect(presetIdFor({ center: -600, width: 1500 })).toBe('lung');
    expect(presetIdFor({ center: 1, width: 2 })).toBe('custom');
    expect(presetIdFor(undefined)).toBe('custom');
    expect(WINDOW_PRESETS.map((p) => p.id)).toEqual(['soft', 'lung', 'bone', 'brain', 'mediastinum']);
  });

  it('soloVisibility：這組影像開、其他組影像與劑量關；結構不動', () => {
    const groups = groupLayersByFrame(layers, [primary, secondary]);
    const plan = new Map(soloVisibility(groups, 'for.b'));
    expect(plan.get('image:cbct')).toBe(true);
    expect(plan.get('image:ct')).toBe(false);
    expect(plan.get('dose:d1')).toBe(false);
    expect(plan.has('mask:a1')).toBe(false);
  });
});

describe('沒有作用的設定先收起', () => {
  it('windowTargetId 跟 ViewerHost.windowTargetLayer 同規則：指定且可見的作用中影像，否則最底下的可見影像', () => {
    const a = layer({ layerId: 'a', kind: 'image', frameOfReferenceUid: 'for.1', order: 2 });
    const b = layer({ layerId: 'b', kind: 'image', frameOfReferenceUid: 'for.2', order: 1 });
    const hidden = layer({ layerId: 'h', kind: 'image', frameOfReferenceUid: 'for.3', order: 0, visible: false });
    const dose = layer({ layerId: 'd', kind: 'dose', frameOfReferenceUid: 'for.1', order: 0 });
    expect(windowTargetId([a, b, hidden, dose], null)).toBe('b');
    expect(windowTargetId([a, b, hidden, dose], 'a')).toBe('a');
    expect(windowTargetId([a, b, hidden, dose], 'h')).toBe('b'); // 指定的是隱藏的 → 不算
    expect(windowTargetId([hidden, dose], null)).toBeNull();
  });

  it('rowExpanded：自動規則，手動展開／收起優先', () => {
    expect(rowExpanded(true, null)).toBe(true);
    expect(rowExpanded(false, null)).toBe(false);
    expect(rowExpanded(false, true)).toBe(true);
    expect(rowExpanded(true, false)).toBe(false);
  });
});

