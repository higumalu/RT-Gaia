/** 參考線（其他格切面在本格的交線）的純幾何。 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import type { ViewReference } from '../src/core';
import { CURSOR_COLOR, isParallel, ORIENTATION_COLOR, parallelCursorFor, planeIntersection, projectOntoPlane, referenceLinesFor, segmentEndpoints } from '../src/react/modules/reflines/model';

const view = (origin: [number, number, number], normal: [number, number, number], up: [number, number, number], fo = 'for.1'): ViewReference => ({
  frameOfReferenceUid: fo,
  displayGridId: 'dg',
  planeOrigin: origin,
  viewPlaneNormal: normal,
  viewUp: up,
  slabThicknessMm: 0,
  temporalGroupId: null,
  frameIndex: null,
});
// 十字線在 (10, 20, 30)：軸向面 z=30、冠狀面 y=20、矢狀面 x=10
const axial = view([0, 0, 30], [0, 0, 1], [0, -1, 0]);
const coronal = view([0, 20, 0], [0, 1, 0], [0, 0, 1]);
const sagittal = view([10, 0, 0], [1, 0, 0], [0, 0, 1]);

describe('平面交線', () => {
  it('軸向 × 冠狀 → 沿 x 的線、在 y=20 z=30；平行 → null', () => {
    const line = planeIntersection(axial, coronal)!;
    expect(line).not.toBeNull();
    expect(Math.abs(line.dir[0])).toBeCloseTo(1, 6);
    expect(line.point[1]).toBeCloseTo(20, 6);
    expect(line.point[2]).toBeCloseTo(30, 6);
    expect(planeIntersection(axial, view([0, 0, 50], [0, 0, 1], [0, -1, 0]))).toBeNull();
    expect(planeIntersection(axial, view([0, 0, 30], [0, 0, -1], [0, 1, 0]))).toBeNull();
  });
  it('三個面兩兩交線都通過十字線 (10,20,30)', () => {
    const pairs: [ViewReference, ViewReference][] = [[axial, coronal], [axial, sagittal], [coronal, sagittal]];
    for (const [a, b] of pairs) {
      const line = planeIntersection(a, b)!;
      // 十字線到交線的距離 = |(c − p) − ((c − p)·d) d|
      const c = [10, 20, 30] as const;
      const v = [c[0] - line.point[0], c[1] - line.point[1], c[2] - line.point[2]];
      const t = v[0]! * line.dir[0] + v[1]! * line.dir[1] + v[2]! * line.dir[2];
      const perp = [v[0]! - t * line.dir[0], v[1]! - t * line.dir[1], v[2]! - t * line.dir[2]];
      expect(Math.hypot(perp[0]!, perp[1]!, perp[2]!)).toBeLessThan(1e-6);
    }
  });
  it('線段端點對稱；斜面也算得出來', () => {
    const line = planeIntersection(axial, coronal)!;
    const [a, b] = segmentEndpoints(line, 100);
    expect(Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2])).toBeCloseTo(200, 6);
    const oblique = view([0, 0, 30], [0, Math.SQRT1_2, Math.SQRT1_2], [0, -Math.SQRT1_2, Math.SQRT1_2]);
    expect(planeIntersection(axial, oblique)).not.toBeNull();
  });
});

describe('每格要畫哪些線', () => {
  const all = [
    { viewportId: 'ax', orientation: 'axial' as const, camera: axial },
    { viewportId: 'co', orientation: 'coronal' as const, camera: coronal },
    { viewportId: 'sa', orientation: 'sagittal' as const, camera: sagittal },
    { viewportId: 'ax2', orientation: 'axial' as const, camera: view([0, 0, 40], [0, 0, 1], [0, -1, 0]) },
    { viewportId: 'other-for', orientation: 'axial' as const, camera: view([0, 0, 30], [0, 1, 0], [0, 0, 1], 'for.2') },
  ];
  it('軸向格：畫冠狀（綠）與矢狀（黃）；同方位的另一格與別的 FoR 不畫', () => {
    const lines = referenceLinesFor(all[0]!, all, 500);
    expect(lines.map((l) => l.viewportId)).toEqual(['co', 'sa']);
    expect(lines[0]!.color).toBe(ORIENTATION_COLOR.coronal);
    expect(lines[1]!.color).toBe(ORIENTATION_COLOR.sagittal);
  });
});

// ── 來源守衛：effect 不得依賴 `api.commands` 的物件身分（症狀：開啟後閃幾下就消失） ──
describe('RefLinesToggle 來源守衛', () => {
  const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../src/react/modules/reflines/RefLinesToggle.tsx'), 'utf8');

  it('effect 依賴只有 on 與 overlay（commands 走 ref，避免身分變動造成反覆註冊）', () => {
    expect(src).toMatch(/\}, \[on, overlay\]\);/);
    expect(src).not.toMatch(/\[on, overlay, commands\]/);
    expect(src).toMatch(/commandsRef\.current\.viewportCameras\(\)/);
  });

  it('註冊後與取消註冊後都重畫一幀（只重畫面板層，不重算影像）', () => {
    const registerIdx = src.indexOf('overlay.register(');
    const cleanupIdx = src.indexOf('unregister();');
    const renders = [...src.matchAll(/commandsRef\.current\.repaintOverlays\(\)/g)].map((m) => m.index ?? -1);
    expect(renders.some((i) => i > registerIdx && i < cleanupIdx)).toBe(true);
    expect(renders.some((i) => i > cleanupIdx)).toBe(true);
  });
});

describe('平行格的同步游標（並排比較）', () => {
  const view = (id: string, orientation: 'axial' | 'coronal', origin: [number, number, number], forUid = 'for.a') => ({
    viewportId: id,
    orientation,
    camera: {
      frameOfReferenceUid: forUid,
      displayGridId: 'g',
      planeOrigin: origin,
      viewPlaneNormal: orientation === 'axial' ? ([0, 0, -1] as [number, number, number]) : ([0, -1, 0] as [number, number, number]),
      viewUp: orientation === 'axial' ? ([0, -1, 0] as [number, number, number]) : ([0, 0, 1] as [number, number, number]),
      slabThicknessMm: 0,
      temporalGroupId: null,
      frameIndex: null,
    } satisfies ViewReference,
  });
  const left = view('compare-left', 'axial', [0, 0, 30]);
  const right = view('compare-right', 'axial', [0, 0, 30]);
  const coronal = view('coronal', 'coronal', [0, 20, 0]);

  it('isParallel／projectOntoPlane', () => {
    expect(isParallel(left.camera, right.camera)).toBe(true);
    expect(isParallel(left.camera, coronal.camera)).toBe(false);
    expect(projectOntoPlane(left.camera, [5, 6, 99])).toEqual([5, 6, 30]);
  });

  it('指標在平行的另一格 → 本格畫橫＋直兩條線，交點＝指標投到本格切面的位置', () => {
    const cross = parallelCursorFor(right, [left, right], { viewportId: 'compare-left', world: [10, 20, 30] }, 100);
    expect(cross).toHaveLength(2);
    // 橫線沿 right（軸向：+x），直線沿 up（-y）；都過 (10,20,30)
    expect(cross[0]![0]).toEqual([-90, 20, 30]);
    expect(cross[0]![1]).toEqual([110, 20, 30]);
    expect(cross[1]![0][0]).toBeCloseTo(10);
    expect(Math.abs(cross[1]![0][1] - 20)).toBeCloseTo(100);
    expect(cross[1]![1][2]).toBeCloseTo(30);
  });

  it('指標在本格、在不平行的格（那邊已有交線）、別的 FoR、或沒有讀數 → 不畫', () => {
    expect(parallelCursorFor(right, [left, right], { viewportId: 'compare-right', world: [1, 2, 30] }, 100)).toEqual([]);
    expect(parallelCursorFor(left, [left, coronal], { viewportId: 'coronal', world: [1, 2, 3] }, 100)).toEqual([]);
    const other = view('other', 'axial', [0, 0, 30], 'for.b');
    expect(parallelCursorFor(left, [left, other], { viewportId: 'other', world: [1, 2, 3] }, 100)).toEqual([]);
    expect(parallelCursorFor(left, [left, right], null, 100)).toEqual([]);
    expect(parallelCursorFor(left, [left, right], { viewportId: 'ghost', world: [1, 2, 3] }, 100)).toEqual([]);
  });

  it('游標顏色與三個方位色都不同', () => {
    expect(Object.values(ORIENTATION_COLOR)).not.toContain(CURSOR_COLOR);
  });

  it('RefLinesToggle：painter 讀 probeRef 畫同步游標；probe 一變就只重畫面板層', () => {
    const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../src/react/modules/reflines/RefLinesToggle.tsx'), 'utf8');
    expect(src).toMatch(/parallelCursorFor\(self, all, cursor, HALF_LENGTH_MM\)/);
    expect(src).toMatch(/\}, \[on, probe\]\);/);
    expect(src).not.toMatch(/commandsRef\.current\.render\(\)/);
  });

  it('CpuViewportRenderer：面板 painter 畫在自己的第三層 canvas，repaintOverlays 不重算影像', () => {
    const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../src/core/scene/CpuViewportRenderer.ts'), 'utf8');
    expect(src).toMatch(/rt-panel-canvas/);
    expect(src).toMatch(/ctx: this\.panelCtx,/);
    expect(src).toMatch(/repaintOverlays\(\): void \{[\s\S]*?this\.paintOverlays\('final'\);/);
    expect(src).toMatch(/this\.panelCtx\.clearRect\(0, 0, this\.panelCanvas\.width, this\.panelCanvas\.height\);/);
  });
});
