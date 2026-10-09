/**
 * 側欄面板 dock 的擺法：預設位置、移到另一側、調順序（含看不到的面板）、上下移、摺疊、存取。
 */

import { describe, expect, it } from 'vitest';

import {
  dockSideOf,
  EMPTY_DOCK,
  isDockCustomized,
  movePanel,
  panelsOnSide,
  parseDock,
  serializeDock,
  shiftPanel,
  toggleFolded,
  type PanelRegistration,
} from '../src/core';

const panel = (id: string, slot: PanelRegistration['slot'], order: number): PanelRegistration => ({ id, slot, order, component: null });
const ALL = [
  panel('data', 'left-sidebar', 10),
  panel('mpr', 'right-sidebar', 50),
  panel('roi', 'right-sidebar', 90),
  panel('dvh', 'right-sidebar', 120), // 假設目前不顯示
  panel('export', 'right-sidebar', 160),
  panel('toolbar.x', 'toolbar', 1),
];
const VISIBLE = ALL.filter((p) => p.id !== 'dvh');
const ids = (ps: readonly PanelRegistration[]): string[] => ps.map((p) => p.id);

describe('dock 擺法', () => {
  it('沒覆寫：照註冊的 slot 與 order；非側欄面板不算', () => {
    expect(ids(panelsOnSide(ALL, 'left', EMPTY_DOCK))).toEqual(['data']);
    expect(ids(panelsOnSide(ALL, 'right', EMPTY_DOCK))).toEqual(['mpr', 'roi', 'dvh', 'export']);
    expect(isDockCustomized(EMPTY_DOCK)).toBe(false);
  });

  it('移到另一側的指定位置；原本那側相對順序不變', () => {
    const d = movePanel(EMPTY_DOCK, ALL, 'roi', 'left', 'data');
    expect(ids(panelsOnSide(ALL, 'left', d))).toEqual(['roi', 'data']);
    expect(ids(panelsOnSide(ALL, 'right', d))).toEqual(['mpr', 'dvh', 'export']);
    expect(dockSideOf(ALL[2]!, d)).toBe('left');
    const d2 = movePanel(d, ALL, 'export', 'left', null);
    expect(ids(panelsOnSide(ALL, 'left', d2))).toEqual(['roi', 'data', 'export']);
  });

  it('同側調順序：看不到的面板保留相對位置', () => {
    const d = movePanel(EMPTY_DOCK, ALL, 'export', 'right', 'mpr');
    expect(ids(panelsOnSide(ALL, 'right', d))).toEqual(['export', 'mpr', 'roi', 'dvh']);
    expect(ids(panelsOnSide(VISIBLE, 'right', d))).toEqual(['export', 'mpr', 'roi']);
  });

  it('上移／下移只看得到的相鄰面板；到頭不動', () => {
    const down = shiftPanel(EMPTY_DOCK, ALL, VISIBLE, 'roi', 1);
    expect(ids(panelsOnSide(VISIBLE, 'right', down))).toEqual(['mpr', 'export', 'roi']);
    const up = shiftPanel(EMPTY_DOCK, ALL, VISIBLE, 'roi', -1);
    expect(ids(panelsOnSide(VISIBLE, 'right', up))).toEqual(['roi', 'mpr', 'export']);
    expect(shiftPanel(EMPTY_DOCK, ALL, VISIBLE, 'mpr', -1)).toBe(EMPTY_DOCK);
    expect(shiftPanel(EMPTY_DOCK, ALL, VISIBLE, 'export', 1)).toBe(EMPTY_DOCK);
  });

  it('不認識的面板、非側欄面板、放在自己前面：不動', () => {
    expect(movePanel(EMPTY_DOCK, ALL, 'nope', 'left', null)).toBe(EMPTY_DOCK);
    expect(movePanel(EMPTY_DOCK, ALL, 'toolbar.x', 'left', null)).toBe(EMPTY_DOCK);
    expect(movePanel(EMPTY_DOCK, ALL, 'roi', 'right', 'roi')).toBe(EMPTY_DOCK);
  });

  it('摺疊切換', () => {
    const d = toggleFolded(EMPTY_DOCK, 'roi');
    expect(d.folded).toEqual(['roi']);
    expect(isDockCustomized(d)).toBe(true);
    expect(toggleFolded(d, 'roi').folded).toEqual([]);
  });

  it('存取來回一致；壞掉的字串與形狀不對的項目丟掉', () => {
    const d = toggleFolded(movePanel(EMPTY_DOCK, ALL, 'roi', 'left', null), 'data');
    expect(parseDock(serializeDock(d))).toEqual(d);
    expect(parseDock('{bad')).toEqual(EMPTY_DOCK);
    expect(parseDock(null)).toEqual(EMPTY_DOCK);
    expect(parseDock(JSON.stringify({ placement: { a: { side: 'top', order: 1 }, b: { side: 'left', order: 'x' }, c: { side: 'right', order: 5 } }, folded: ['x', 'x', 3] }))).toEqual({
      placement: { c: { side: 'right', order: 5 } },
      folded: ['x'],
    });
  });
});
