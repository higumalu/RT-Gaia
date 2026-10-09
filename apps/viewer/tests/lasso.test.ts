/**
 * 圈選：多邊形光柵化（正交切面 even-odd、只取這一層、加／減）、scissors 工具（收口／取消／預覽）。
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  clearTools,
  getTool,
  pointInPolygon2,
  primaryFrameGroupOf,
  rasterizeLasso,
  registerBuiltinTools,
  type Grid,
  type MaskGrid,
  type ToolContext,
  type ViewReference,
  type VoxelPatch,
} from '../src/core';

const grid: Grid = { size: [20, 20, 10], spacing: [1, 1, 2], origin: [0, 0, 0], direction: [1, 0, 0, 0, 1, 0, 0, 0, 1], frameOfReferenceUid: 'f' };
const maskGrid: MaskGrid = { grid, maskGridId: 'mg' };
const fg = primaryFrameGroupOf('f', 's');
const axial: ViewReference = { frameOfReferenceUid: 'f', displayGridId: 'dg', planeOrigin: [0, 0, 6], viewPlaneNormal: [0, 0, -1], viewUp: [0, -1, 0], slabThicknessMm: 0, temporalGroupId: null, frameIndex: null };

function count(p: VoxelPatch | null): { ones: number; covered: number; ks: Set<number> } {
  if (!p) return { ones: 0, covered: 0, ks: new Set() };
  const ks = new Set<number>();
  let ones = 0;
  let covered = 0;
  for (let k = 0; k < p.sizeIjk[2]; k += 1) for (let j = 0; j < p.sizeIjk[1]; j += 1) for (let i = 0; i < p.sizeIjk[0]; i += 1) {
    const at = k * p.sizeIjk[1] * p.sizeIjk[0] + j * p.sizeIjk[0] + i;
    if (p.coverage[at]) { covered += 1; ks.add(k + p.offsetIjk[2]); }
    if (p.data[at]) ones += 1;
  }
  return { ones, covered, ks };
}

describe('rasterizeLasso', () => {
  it('軸向切面上的 10×10 方形 → 只有 z=6 那一層（k=3）、約 100 個體素、加＝1', () => {
    const square = [[2, 2, 6], [12, 2, 6], [12, 12, 6], [2, 12, 6]] as const;
    const patch = rasterizeLasso({ maskGrid, frameGroup: fg, polygonPrimaryWorld: [...square], planeNormalPrimary: axial.viewPlaneNormal, viewUpPrimary: axial.viewUp, mode: 'add' });
    const c = count(patch);
    expect(c.ks).toEqual(new Set([3]));
    expect(c.covered).toBeGreaterThanOrEqual(81);
    expect(c.covered).toBeLessThanOrEqual(121);
    expect(c.ones).toBe(c.covered);
  });

  it('減：data 全 0 但 coverage 有；兩點回 null；多邊形在網格外回 null', () => {
    const tri = [[2, 2, 6], [8, 2, 6], [8, 8, 6]] as const;
    const sub = rasterizeLasso({ maskGrid, frameGroup: fg, polygonPrimaryWorld: [...tri], planeNormalPrimary: axial.viewPlaneNormal, viewUpPrimary: axial.viewUp, mode: 'subtract' });
    const c = count(sub);
    expect(c.covered).toBeGreaterThan(0);
    expect(c.ones).toBe(0);
    expect(rasterizeLasso({ maskGrid, frameGroup: fg, polygonPrimaryWorld: [[0, 0, 0], [1, 1, 0]], planeNormalPrimary: axial.viewPlaneNormal, viewUpPrimary: axial.viewUp, mode: 'add' })).toBeNull();
    expect(rasterizeLasso({ maskGrid, frameGroup: fg, polygonPrimaryWorld: [[100, 100, 6], [110, 100, 6], [110, 110, 6]], planeNormalPrimary: axial.viewPlaneNormal, viewUpPrimary: axial.viewUp, mode: 'add' })).toBeNull();
  });

  it('冠狀切面（法線 y）：只取 y=5 那一層（j=5）', () => {
    const coronal: ViewReference = { ...axial, planeOrigin: [0, 5, 0], viewPlaneNormal: [0, -1, 0], viewUp: [0, 0, 1] };
    const rect = [[2, 5, 2], [12, 5, 2], [12, 5, 8], [2, 5, 8]] as const;
    const patch = rasterizeLasso({ maskGrid, frameGroup: fg, polygonPrimaryWorld: [...rect], planeNormalPrimary: coronal.viewPlaneNormal, viewUpPrimary: coronal.viewUp, mode: 'add' })!;
    expect(patch.offsetIjk[1]).toBeLessThanOrEqual(5);
    const js = new Set<number>();
    for (let k = 0; k < patch.sizeIjk[2]; k += 1) for (let j = 0; j < patch.sizeIjk[1]; j += 1) for (let i = 0; i < patch.sizeIjk[0]; i += 1) {
      if (patch.coverage[k * patch.sizeIjk[1] * patch.sizeIjk[0] + j * patch.sizeIjk[0] + i]) js.add(j + patch.offsetIjk[1]);
    }
    expect(js).toEqual(new Set([5]));
    expect(pointInPolygon2(5, 5, [[0, 0], [10, 0], [10, 10], [0, 10]])).toBe(true);
    expect(pointInPolygon2(15, 5, [[0, 0], [10, 0], [10, 10], [0, 10]])).toBe(false);
  });
});

describe('scissors 工具', () => {
  beforeEach(() => { clearTools(); registerBuiltinTools(); });
  afterEach(() => clearTools());

  function ctxFor(mode: 'add' | 'subtract') {
    const patches: VoxelPatch[] = [];
    const strokes: string[] = [];
    const previews: (readonly number[][] | null)[] = [];
    const ctx = {
      viewport: { viewportId: 'v', is3D: false, width: 100, height: 100 },
      camera: axial,
      canvasToWorld: (x: number, y: number) => [x, y, 6] as [number, number, number],
      worldToCanvas: (w: readonly number[]) => ({ x: w[0]!, y: w[1]! }),
      cssToBackingScale: () => ({ sx: 1, sy: 1 }),
      maskGridFor: () => maskGrid,
      frameGroup: () => fg,
      params: { lasso: { mode } },
      layers: () => [{ layerId: 'mask:s1', kind: 'mask', contentRef: 's1', frameOfReferenceUid: 'f', visible: true, label: 's1', groupId: null, opacity: 1, order: 0 }],
      activeStructureId: () => 's1',
      isEditable: () => true,
      applyPatch: (a: { patch: VoxelPatch }) => { patches.push(a.patch); return true; },
      endStroke: (label: string) => strokes.push(label),
      setLassoPreview: (p: readonly number[][] | null) => previews.push(p ? p.map((q) => [...q]) : null),
    } as unknown as ToolContext;
    return { ctx, patches, strokes, previews };
  }

  it('逐點點擊、點回起點收口 → 一筆 patch ＋ 一次 endStroke；預覽隨點更新後清空', () => {
    const { ctx, patches, strokes, previews } = ctxFor('add');
    const t = getTool('scissors').activate(ctx);
    for (const [x, y] of [[2, 2], [12, 2], [12, 12], [2, 12], [3, 2]] as const) { t.onPointerDown?.(x, y); t.onPointerUp?.(x, y); }
    expect(patches).toHaveLength(1);
    expect(strokes).toEqual(['scissors']);
    expect(previews.at(-1)).toBeNull();
    expect(previews.filter((p) => p !== null).map((p) => p.length)).toEqual([1, 2, 3, 4]);
  });

  it('Enter 收口（≥3 點）；不到三點 Enter 不畫；Esc 取消；沒選結構拒絕啟動', () => {
    const { ctx, patches } = ctxFor('subtract');
    const t = getTool('scissors').activate(ctx);
    t.onPointerDown?.(2, 2); t.onPointerUp?.(2, 2);
    t.onPointerDown?.(9, 2); t.onPointerUp?.(9, 2);
    expect(t.onKeyDown?.('Enter')).toBe(true);
    expect(patches).toHaveLength(0);
    for (const [x, y] of [[2, 2], [9, 2], [9, 9]] as const) { t.onPointerDown?.(x, y); t.onPointerUp?.(x, y); }
    t.onKeyDown?.('Enter');
    expect(patches).toHaveLength(1);
    expect(patches[0]!.data.every((v) => v === 0)).toBe(true); // subtract
    t.onPointerDown?.(2, 2); t.onPointerUp?.(2, 2);
    t.onKeyDown?.('Escape');
    t.onKeyDown?.('Enter');
    expect(patches).toHaveLength(1);
    expect(() => getTool('scissors').activate({ ...ctxFor('add').ctx, activeStructureId: () => null })).toThrow(/TL4/);
  });
});
