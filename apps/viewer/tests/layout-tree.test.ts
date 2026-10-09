/**
 * 版面分割樹：具名版面換算、分割／關閉、拖分隔線、存取、位置計算、生效版面。
 */

import { beforeEach, describe, expect, it } from 'vitest';

import {
  applyOverrides,
  applyTree,
  clearLayouts,
  dragSplitter,
  equalizeSplit,
  getLayout,
  listLayouts,
  MIN_PANE_FRACTION,
  newCellId,
  parseTrack,
  parseTrees,
  registerBuiltinLayouts,
  removeCell,
  serializeTrees,
  setSplitSizes,
  splitCell,
  treeCellIds,
  treeFromGrid,
  treeRects,
  type LayoutNode,
  type LayoutSpec,
} from '../src/core';
import { registerDvhModule, resetDvhModuleRegistration } from '../src/react/modules/dvh';
import { compareLayouts } from '../src/react/modules/layout/model';

beforeEach(() => {
  clearLayouts();
  registerBuiltinLayouts();
});

const close = (a: readonly number[], b: readonly number[]): void => {
  expect(a.length).toBe(b.length);
  a.forEach((x, i) => expect(x).toBeCloseTo(b[i]!, 6));
};

describe('treeFromGrid', () => {
  it('2×2 → 左右兩欄、每欄上下兩格（先切直的）', () => {
    const tree = treeFromGrid(getLayout('2x2'));
    expect(tree).toEqual({
      kind: 'split',
      dir: 'row',
      sizes: [0.5, 0.5],
      children: [
        { kind: 'split', dir: 'column', sizes: [0.5, 0.5], children: [{ kind: 'cell', cellId: 'axial' }, { kind: 'cell', cellId: 'sagittal' }] },
        { kind: 'split', dir: 'column', sizes: [0.5, 0.5], children: [{ kind: 'cell', cellId: 'coronal' }, { kind: 'cell', cellId: 'volume3d' }] },
      ],
    });
  });

  it('1＋3：大格 3/4、右欄三格平分', () => {
    const tree = treeFromGrid(getLayout('1+3'))!;
    expect(tree.kind).toBe('split');
    if (tree.kind !== 'split') return;
    close(tree.sizes, [0.75, 0.25]);
    expect(treeCellIds(tree)).toEqual(['axial', 'coronal', 'sagittal', 'volume3d']);
    const right = tree.children[1]!;
    expect(right.kind === 'split' && right.dir).toBe('column');
  });

  it('所有已註冊的版面（核心、DVH、並排）都換得成樹，格子一個不少', () => {
    resetDvhModuleRegistration();
    registerDvhModule();
    const specs = [...listLayouts(), ...compareLayouts()];
    expect(specs.length).toBeGreaterThanOrEqual(7);
    for (const spec of specs) {
      const tree = treeFromGrid(spec);
      expect(tree, spec.id).not.toBeNull();
      expect(new Set(treeCellIds(tree!))).toEqual(new Set(spec.cells.map((c) => c.cellId)));
    }
  });

  it('非切割式格局（風車）與非 fr 單位 → null（照舊用 grid）', () => {
    const pinwheel: LayoutSpec = {
      id: 'pin',
      label: 'pin',
      gridTemplateColumns: '1fr 1fr 1fr',
      gridTemplateRows: '1fr 1fr 1fr',
      cells: [
        { cellId: 'a', gridArea: '1 / 1 / 2 / 3', content: { kind: 'viewport', orientation: 'axial' } },
        { cellId: 'b', gridArea: '1 / 3 / 3 / 4', content: { kind: 'viewport', orientation: 'axial' } },
        { cellId: 'c', gridArea: '3 / 2 / 4 / 4', content: { kind: 'viewport', orientation: 'axial' } },
        { cellId: 'd', gridArea: '2 / 1 / 4 / 2', content: { kind: 'viewport', orientation: 'axial' } },
        { cellId: 'e', gridArea: '2 / 2 / 3 / 3', content: { kind: 'viewport', orientation: 'axial' } },
      ],
    };
    expect(treeFromGrid(pinwheel)).toBeNull();
    expect(parseTrack('200px 1fr')).toBeNull();
    expect(treeFromGrid({ ...getLayout('2x2'), gridTemplateColumns: 'repeat(2, 1fr)' })).toBeNull();
  });
});

describe('分割與關閉', () => {
  const base = (): LayoutNode => treeFromGrid(getLayout('2x2'))!;

  it('同方向的父層：插在旁邊、平分原格的比例', () => {
    const t1 = splitCell(base(), 'axial', 'column', 'n1');
    expect(treeCellIds(t1)).toEqual(['axial', 'n1', 'sagittal', 'coronal', 'volume3d']);
    const left = t1.kind === 'split' ? t1.children[0]! : null;
    expect(left?.kind === 'split' && left.sizes).toEqual([0.25, 0.25, 0.5]);
  });

  it('不同方向：原地換成兩格 split', () => {
    const t1 = splitCell(base(), 'axial', 'row', 'n1');
    const left = t1.kind === 'split' ? t1.children[0] : null;
    const first = left?.kind === 'split' ? left.children[0] : null;
    expect(first).toEqual({ kind: 'split', dir: 'row', sizes: [0.5, 0.5], children: [{ kind: 'cell', cellId: 'axial' }, { kind: 'cell', cellId: 'n1' }] });
  });

  it('單格版面也能分；關回去收成原樣；最後一格關不掉', () => {
    const one = treeFromGrid(getLayout('1x1'))!;
    expect(one).toEqual({ kind: 'cell', cellId: 'axial' });
    const two = splitCell(one, 'axial', 'row', 'n1');
    expect(treeCellIds(two)).toEqual(['axial', 'n1']);
    expect(removeCell(two, 'n1')).toEqual(one);
    expect(removeCell(one, 'axial')).toBe(one);
  });

  it('關掉一格：比例分給兄弟、只剩一格的 split 收起來', () => {
    const t1 = removeCell(base(), 'sagittal');
    expect(t1.kind === 'split' && t1.children[0]).toEqual({ kind: 'cell', cellId: 'axial' });
    const t2 = removeCell(splitCell(base(), 'axial', 'column', 'n1'), 'n1');
    expect(t2).toEqual(base());
    expect(removeCell(base(), 'nope')).toEqual(base());
  });
});

describe('比例', () => {
  it('拖分隔線只動相鄰兩格、卡在最小比例', () => {
    close(dragSplitter([0.5, 0.5], 0, 0.1), [0.6, 0.4]);
    close(dragSplitter([0.5, 0.5], 0, 5), [1 - MIN_PANE_FRACTION, MIN_PANE_FRACTION]);
    close(dragSplitter([0.25, 0.25, 0.5], 1, -0.5), [0.25, MIN_PANE_FRACTION, 0.75 - MIN_PANE_FRACTION]);
  });

  it('setSplitSizes 正規化並卡最小值；路徑不對不動；雙擊平分', () => {
    const tree = treeFromGrid(getLayout('2x2'))!;
    const t1 = setSplitSizes(tree, [], [3, 1]);
    close(t1.kind === 'split' ? t1.sizes : [], [0.75, 0.25]);
    const t2 = setSplitSizes(tree, [0], [1, 0]);
    const left = t2.kind === 'split' ? t2.children[0]! : tree;
    close(left.kind === 'split' ? left.sizes : [], [1 / (1 + MIN_PANE_FRACTION), MIN_PANE_FRACTION / (1 + MIN_PANE_FRACTION)]);
    expect(setSplitSizes(tree, [0, 0], [0.5, 0.5])).toBe(tree);
    expect(setSplitSizes(tree, [], [1, 1, 1])).toBe(tree);
    expect(equalizeSplit(t1, [])).toEqual(tree);
  });
});

describe('位置計算', () => {
  it('每格與每條分隔線的位置', () => {
    const tree = setSplitSizes(treeFromGrid(getLayout('2x2'))!, [], [0.75, 0.25]);
    const { cells, splitters } = treeRects(tree);
    const axial = cells.find((c) => c.cellId === 'axial')!;
    expect(axial).toMatchObject({ x: 0, y: 0 });
    expect(axial.w).toBeCloseTo(0.75);
    expect(axial.h).toBeCloseTo(0.5);
    const vol = cells.find((c) => c.cellId === 'volume3d')!;
    expect(vol.x).toBeCloseTo(0.75);
    expect(vol.y).toBeCloseTo(0.5);
    expect(splitters).toHaveLength(3);
    const root = splitters.find((s) => s.path.length === 0)!;
    expect(root.dir).toBe('row');
    expect(root.at).toBeCloseTo(0.75);
    const rightCol = splitters.find((s) => s.path[0] === 1)!;
    expect(rightCol.parent.x).toBeCloseTo(0.75);
    expect(rightCol.at).toBeCloseTo(0.5);
  });
});

describe('生效版面', () => {
  it('新格內容取覆寫（沒有 → 軸向）、關掉的原格拿掉、gridArea 不留', () => {
    const spec = getLayout('1+3');
    const overrides = { n1: { kind: 'viewport' as const, orientation: 'sagittal' as const } };
    let tree = splitCell(treeFromGrid(spec)!, 'axial', 'row', 'n1');
    tree = splitCell(tree, 'n1', 'column', 'n2');
    tree = removeCell(tree, 'volume3d');
    const eff = applyTree(applyOverrides(spec, overrides), tree, overrides);
    expect(eff.cells.map((c) => c.cellId)).toEqual(['axial', 'n1', 'n2', 'coronal', 'sagittal']);
    expect(eff.cells.find((c) => c.cellId === 'n1')!.content).toEqual({ kind: 'viewport', orientation: 'sagittal' });
    expect(eff.cells.find((c) => c.cellId === 'n2')!.content).toEqual({ kind: 'viewport', orientation: 'axial' });
    expect(eff.cells.every((c) => c.gridArea === undefined)).toBe(true);
    expect(applyTree(spec, null, undefined)).toBe(spec);
  });
});

describe('存取', () => {
  it('來回一致；壞掉的、形狀不對的、cellId 重複的丟掉', () => {
    const tree = splitCell(treeFromGrid(getLayout('2x2'))!, 'axial', 'row', 'n1');
    expect(parseTrees(serializeTrees({ '2x2': tree }))).toEqual({ '2x2': tree });
    expect(parseTrees('{oops')).toEqual({});
    expect(parseTrees(null)).toEqual({});
    const dup = { kind: 'split', dir: 'row', sizes: [1, 1], children: [{ kind: 'cell', cellId: 'a' }, { kind: 'cell', cellId: 'a' }] };
    const badSizes = { kind: 'split', dir: 'row', sizes: [1], children: [{ kind: 'cell', cellId: 'a' }, { kind: 'cell', cellId: 'b' }] };
    const oneChild = { kind: 'split', dir: 'row', sizes: [1], children: [{ kind: 'cell', cellId: 'a' }] };
    const badDir = { kind: 'split', dir: 'diag', sizes: [1, 1], children: [{ kind: 'cell', cellId: 'a' }, { kind: 'cell', cellId: 'b' }] };
    const good = { kind: 'split', dir: 'column', sizes: [2, 2], children: [{ kind: 'cell', cellId: 'a' }, { kind: 'cell', cellId: 'b' }] };
    expect(Object.keys(parseTrees(JSON.stringify({ dup, badSizes, oneChild, badDir, good })))).toEqual(['good']);
    expect(parseTrees(JSON.stringify({ good })).good).toMatchObject({ sizes: [0.5, 0.5] });
  });

  it('newCellId 不跟現有的撞', () => {
    let n = 0;
    const seq = [0, 0, 0.5];
    const id = newCellId(['cell-000000'], () => seq[n++]!);
    expect(id).toBe('cell-7fffff');
  });
});
