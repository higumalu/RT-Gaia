/**
 * 格子內容與使用者覆寫：套用、相機連動退出、序列化／解析、選單值。
 */

import { beforeEach, describe, expect, it } from 'vitest';

import {
  applyOverrides,
  cameraLinkGroups,
  cellLabel,
  clearLayouts,
  getLayout,
  isSameContent,
  parseOverrides,
  registerBuiltinLayouts,
  registerLayout,
  serializeOverrides,
  type LayoutSpec,
} from '../src/core';
import { contentFromKey, contentKey } from '../src/react/components/ViewportArea';

beforeEach(() => {
  clearLayouts();
  registerBuiltinLayouts();
});

const compare: LayoutSpec = {
  id: 'cmp',
  label: 'cmp',
  gridTemplateColumns: '1fr 1fr',
  gridTemplateRows: '1fr',
  cells: [
    { cellId: 'L', label: '左', content: { kind: 'viewport', orientation: 'axial', cameraLink: 'g' } },
    { cellId: 'R', label: '右', content: { kind: 'viewport', orientation: 'axial', cameraLink: 'g' } },
  ],
};

describe('applyOverrides', () => {
  it('沒有覆寫回同一個物件；有覆寫只換那一格', () => {
    const base = getLayout('2x2');
    expect(applyOverrides(base, undefined)).toBe(base);
    expect(applyOverrides(base, {})).toBe(base);
    const out = applyOverrides(base, { sagittal: { kind: 'panel', panelId: 'dvh.chart' } });
    expect(out.cells[2]!.content).toEqual({ kind: 'panel', panelId: 'dvh.chart' });
    expect(out.cells[2]!.cellId).toBe('sagittal');
    expect(out.cells[0]).toBe(base.cells[0]);
    expect(cellLabel(out.cells[2]!)).toBe('dvh.chart');
    expect(cellLabel(out.cells[3]!)).toBe('3D');
  });

  it('🔴 換了方位或換成面板的格子退出相機連動群；同方位保留', () => {
    expect(cameraLinkGroups(compare)).toEqual({ g: ['L', 'R'] });
    const swapped = applyOverrides(compare, { R: { kind: 'viewport', orientation: 'coronal' } });
    expect(cameraLinkGroups(swapped)).toEqual({ g: ['L'] });
    const paneled = applyOverrides(compare, { R: { kind: 'panel', panelId: 'x' } });
    expect(cameraLinkGroups(paneled)).toEqual({ g: ['L'] });
    const same = applyOverrides(compare, { R: { kind: 'viewport', orientation: 'axial' } });
    expect(cameraLinkGroups(same)).toEqual({ g: ['L', 'R'] });
    // 3D 不進連動
    const threeD = applyOverrides(compare, { R: { kind: 'viewport', orientation: 'axial', is3D: true } });
    expect(cameraLinkGroups(threeD)).toEqual({ g: ['L'] });
  });

  it('registerLayout 接受面板格；cellId 重複仍 LY3', () => {
    registerLayout({
      id: 'with-panel',
      label: 'p',
      gridTemplateColumns: '1fr',
      gridTemplateRows: '1fr 1fr',
      cells: [
        { cellId: 'a', content: { kind: 'viewport', orientation: 'axial' } },
        { cellId: 'b', content: { kind: 'panel', panelId: 'dvh.chart' } },
      ],
    });
    expect(getLayout('with-panel').cells[1]!.content.kind).toBe('panel');
    expect(() =>
      registerLayout({ ...compare, id: 'dup', cells: [compare.cells[0]!, { ...compare.cells[1]!, cellId: 'L' }] }),
    ).toThrow(/LY3/);
  });
});

describe('覆寫的序列化', () => {
  it('round-trip；壞字串、非物件、未知形狀都被丟掉而不拋', () => {
    const all = { '2x2': { sagittal: { kind: 'panel' as const, panelId: 'dvh.chart' }, volume3d: { kind: 'viewport' as const, orientation: 'coronal' as const } } };
    expect(parseOverrides(serializeOverrides(all))).toEqual(all);
    expect(parseOverrides(null)).toEqual({});
    expect(parseOverrides('not json')).toEqual({});
    expect(parseOverrides('[1,2]')).toEqual({});
    expect(parseOverrides(JSON.stringify({ '2x2': { a: { kind: 'panel' }, b: { kind: 'viewport', orientation: 'nope' }, c: 5 } }))).toEqual({});
    expect(parseOverrides(JSON.stringify({ '2x2': { a: { kind: 'viewport', orientation: 'axial', is3D: true, junk: 1 } } }))).toEqual({
      '2x2': { a: { kind: 'viewport', orientation: 'axial', is3D: true } },
    });
  });
});

describe('選單值', () => {
  it('內容 ↔ 選單值互逆；3D 是獨立選項；未知值回 null', () => {
    for (const c of [
      { kind: 'viewport' as const, orientation: 'axial' as const },
      { kind: 'viewport' as const, orientation: 'sagittal' as const },
      { kind: 'viewport' as const, orientation: 'axial' as const, is3D: true },
      { kind: 'panel' as const, panelId: 'dvh.chart' },
    ]) {
      const back = contentFromKey(contentKey(c));
      expect(back).not.toBeNull();
      expect(isSameContent(back!, c)).toBe(true);
    }
    expect(contentKey({ kind: 'viewport', orientation: 'axial', is3D: true })).toBe('vp:3d');
    expect(contentFromKey('vp:weird')).toBeNull();
    expect(contentFromKey('nonsense')).toBeNull();
    expect(isSameContent({ kind: 'panel', panelId: 'a' }, { kind: 'viewport', orientation: 'axial' })).toBe(false);
  });
});
