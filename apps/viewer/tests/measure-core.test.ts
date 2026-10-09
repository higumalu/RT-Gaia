/**
 * 量測核心：值、方框、平面交線、點在多邊形內、FoR 搬移、HU 統計、命名、wire round-trip。
 */

import { describe, expect, it } from 'vitest';

import {
  areaStats,
  boxCorners,
  boxPlaneSection,
  boxStats,
  createMeasurement,
  isComplete,
  measurementValue,
  nextMeasurementLabel,
  pointInPlanePolygon,
  pointStats,
  polygonPlaneIntersection,
  translationMat16,
  viewToPrimary,
  withPoints,
  type FrameGroup,
  type Measurement,
  type ViewReference,
} from '../src/core';
import type { ImageEntry } from '../src/core/scene/volumeStore';
import { fromWire, toWire } from '../src/core/transport/wire';

const axial: ViewReference = {
  frameOfReferenceUid: 'for.a',
  displayGridId: 'dg',
  planeOrigin: [0, 0, 0],
  viewPlaneNormal: [0, 0, -1],
  viewUp: [0, -1, 0],
  slabThicknessMm: 0,
  temporalGroupId: null,
  frameIndex: null,
};

function m(kind: Measurement['kind'], points: number[], view: ViewReference | null = null): Measurement {
  return createMeasurement({ kind, frameOfReferenceUid: 'for.a', points, viewReference: view, editedOn: axial, label: 'x' });
}

describe('值', () => {
  it('距離是 3D 歐氏距離；面積是平面上的 shoelace；體積是軸對齊方框；點為 0', () => {
    expect(measurementValue(m('distance', [0, 0, 0, 3, 4, 12]))).toEqual({ value: 13, unit: 'mm' });
    // 10×20 的矩形，斜著放在 z=5 的軸向平面上
    expect(measurementValue(m('area', [0, 0, 5, 10, 0, 5, 10, 20, 5, 0, 20, 5], axial)).value).toBeCloseTo(200);
    // 凹多邊形（L 形）
    expect(measurementValue(m('area', [0, 0, 0, 4, 0, 0, 4, 2, 0, 2, 2, 0, 2, 4, 0, 0, 4, 0], axial)).value).toBeCloseTo(12);
    expect(measurementValue(m('roi3d', [0, 0, 0, 10, 20, 50]))).toEqual({ value: 10, unit: 'cc' });
    expect(measurementValue(m('point', [1, 2, 3])).value).toBe(0);
    expect(measurementValue(m('area', [0, 0, 0, 1, 0, 0], axial)).value).toBe(0);
  });

  it('完整性：面積要 3 點、距離／方框 2 點、標記 1 點', () => {
    expect(isComplete(m('area', [0, 0, 0, 1, 0, 0], axial))).toBe(false);
    expect(isComplete(m('area', [0, 0, 0, 1, 0, 0, 0, 1, 0], axial))).toBe(true);
    expect(isComplete(m('distance', [0, 0, 0]))).toBe(false);
    expect(isComplete(m('point', [0, 0, 0]))).toBe(true);
  });
});

describe('平面關係的幾何', () => {
  it('多邊形與斜平面的交線：正方形被 x=5 的平面切出一段 y∈[0,10]', () => {
    const square = [
      [0, 0, 0],
      [10, 0, 0],
      [10, 10, 0],
      [0, 10, 0],
    ] as const;
    const sagittal: ViewReference = { ...axial, planeOrigin: [5, 0, 0], viewPlaneNormal: [1, 0, 0], viewUp: [0, 0, 1] };
    const segs = polygonPlaneIntersection([...square], sagittal);
    expect(segs).toHaveLength(1);
    const ys = segs[0]!.map((p) => p[1]).sort((a, b) => a - b);
    expect(ys).toEqual([0, 10]);
    // 不相交
    expect(polygonPlaneIntersection([...square], { ...sagittal, planeOrigin: [50, 0, 0] })).toEqual([]);
    // L 形被切兩段
    const lShape = [
      [0, 0, 0],
      [4, 0, 0],
      [4, 2, 0],
      [2, 2, 0],
      [2, 4, 0],
      [0, 4, 0],
    ] as const;
    const yPlane: ViewReference = { ...axial, planeOrigin: [0, 1, 0], viewPlaneNormal: [0, 1, 0], viewUp: [0, 0, 1] };
    expect(polygonPlaneIntersection([...lShape], yPlane)).toHaveLength(1);
    const yPlane3: ViewReference = { ...yPlane, planeOrigin: [0, 3, 0] };
    expect(polygonPlaneIntersection([...lShape], yPlane3)).toHaveLength(1);
    const xPlane: ViewReference = { ...axial, planeOrigin: [1, 0, 0], viewPlaneNormal: [1, 0, 0], viewUp: [0, 0, 1] };
    expect(polygonPlaneIntersection([...lShape], xPlane)).toHaveLength(1);
  });

  it('方框與平面的截面：軸向切過去是矩形；沒切到是空', () => {
    const corners = boxCorners([0, 0, 0, 10, 20, 30]);
    const section = boxPlaneSection(corners, { ...axial, planeOrigin: [0, 0, 15] });
    expect(section).toHaveLength(4);
    expect(section.every((p) => Math.abs(p[2] - 15) < 1e-9)).toBe(true);
    expect(boxPlaneSection(corners, { ...axial, planeOrigin: [0, 0, 99] })).toEqual([]);
  });

  it('點在平面多邊形內（even-odd）', () => {
    const square = [
      [0, 0, 0],
      [10, 0, 0],
      [10, 10, 0],
      [0, 10, 0],
    ] as const;
    expect(pointInPlanePolygon([5, 5, 0], [...square], axial)).toBe(true);
    expect(pointInPlanePolygon([15, 5, 0], [...square], axial)).toBe(false);
  });

  it('viewToPrimary：平面跟著 FrameGroup 平移；單位矩陣原樣回', () => {
    const fg: FrameGroup = {
      frameOfReferenceUid: 'for.b',
      seriesId: 's',
      role: 'secondary',
      transformToPrimary: translationMat16([10, 0, 0]),
      transformKind: 'rigid',
      coverageMaskId: null,
    };
    const moved = viewToPrimary(axial, fg);
    expect(moved.planeOrigin).toEqual([10, 0, 0]);
    expect(moved.viewPlaneNormal).toEqual([0, 0, -1]);
    expect(viewToPrimary(axial, null)).toBe(axial);
  });
});

describe('HU 統計', () => {
  // 20×20×20、1 mm、原點 0：體素值 = i（沿 x 的梯度）
  const size = [20, 20, 20] as const;
  const voxels = new Int16Array(20 * 20 * 20);
  for (let k = 0; k < 20; k += 1) for (let j = 0; j < 20; j += 1) for (let i = 0; i < 20; i += 1) voxels[i + 20 * (j + 20 * k)] = i * 10;
  const entry = (lod = 0): ImageEntry => ({
    seriesId: 's',
    lod,
    grid: { size, spacing: [1, 1, 1], origin: [0, 0, 0], direction: [1, 0, 0, 0, 1, 0, 0, 0, 1], frameOfReferenceUid: 'for.a' },
    voxels,
    defaultWindow: { center: 0, width: 100 },
  });

  it('面積：z=5 平面上 x∈[2,6]、y∈[2,6] 的方塊 → mean ≈ 40、min 20、max 60', () => {
    const area = m('area', [2, 2, 5, 6, 2, 5, 6, 6, 5, 2, 6, 5], { ...axial, planeOrigin: [0, 0, 5] });
    const s = areaStats(area, entry())!;
    // 取樣點在半步位置（2.5、3.5…）→ 最近體素 3..6；邊界體素算不算進去是取樣密度的事，不是錯
    expect(s.min).toBeGreaterThanOrEqual(20);
    expect(s.min).toBeLessThanOrEqual(30);
    expect(s.max).toBeGreaterThanOrEqual(50);
    expect(Math.abs(s.mean - 40)).toBeLessThan(6);
    expect(s.voxelCount).toBeGreaterThanOrEqual(16);
    expect(s.approximate).toBe(false);
    expect(areaStats(area, entry(1))!.approximate).toBe(true);
  });

  it('方框：x∈[2,6] 的方框 → 值 20..60；完全在外 → null；標記點取那一個體素', () => {
    const s = boxStats(m('roi3d', [2, 2, 2, 6, 6, 6]), entry())!;
    expect([s.min, s.max]).toEqual([20, 60]);
    expect(s.voxelCount).toBe(125);
    expect(s.stdev).toBeGreaterThan(0);
    expect(boxStats(m('roi3d', [100, 100, 100, 110, 110, 110]), entry())).toBeNull();
    expect(pointStats(m('point', [7, 3, 3]), entry())).toMatchObject({ mean: 70, voxelCount: 1 });
  });
});

describe('建立與 wire', () => {
  it('自動命名取該種類最大編號 ＋ 1；Provenance 是 user-edit 且帶平面', () => {
    const existing = [m('distance', [0, 0, 0, 1, 1, 1]), { ...m('distance', [0, 0, 0, 1, 1, 1]), label: '距離 7' }, m('area', [0, 0, 0, 1, 0, 0, 0, 1, 0], axial)];
    existing[0]!.label = '距離 2';
    existing[2]!.label = '面積 1';
    expect(nextMeasurementLabel('distance', existing)).toBe('距離 8');
    expect(nextMeasurementLabel('area', existing)).toBe('面積 2');
    expect(nextMeasurementLabel('point', existing)).toBe('標記 1');
    const created = m('distance', [0, 0, 0, 1, 1, 1]);
    expect(created.provenance.source).toBe('user-edit');
    expect(created.provenance.viewReference).toBe(axial);
    expect(created.measurementId.startsWith('ms_')).toBe(true);
    expect(withPoints(created, [0, 0, 0, 2, 2, 2]).points).toEqual(Float64Array.from([0, 0, 0, 2, 2, 2]));
  });

  it('toWire → fromWire 回同一個量測（points 陣列 ↔ Float64Array、平面 snake_case）', () => {
    const area = m('area', [0, 0, 5, 10, 0, 5, 10, 20, 5], { ...axial, planeOrigin: [0, 0, 5] });
    area.label = '面積 1';
    const wire = toWire.measurement(area);
    expect(Array.isArray(wire['points'])).toBe(true);
    expect((wire['viewReference'] as Record<string, unknown>)['plane_origin']).toEqual([0, 0, 5]);
    const back = fromWire.measurement(wire);
    expect(back.points).toEqual(area.points);
    expect(back.viewReference).toEqual(area.viewReference);
    expect(back.provenance.moduleVersion).toBe(area.provenance.moduleVersion);
    expect(back.label).toBe('面積 1');
    // Layer 上的 measurement 也走同一條
    const layer = fromWire.layer({ layerId: 'measurement:1', kind: 'measurement', frameOfReferenceUid: 'for.a', contentRef: '1', visible: true, measurement: wire });
    expect(layer.measurement?.points).toEqual(area.points);
    expect(() => fromWire.measurement({ ...wire, points: [1, 2] })).toThrow(/MS1/);
  });
});
