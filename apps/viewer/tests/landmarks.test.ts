/**
 * 地標對與 TG-132 TRE：TRE 用給定的對位算、面板的列／摘要／CSV／命名、SVG 描述、量測表不列。
 */

import { describe, expect, it } from 'vitest';

import { createMeasurement, landmarkTre, measurementHandles, measurementNodes, type Layer, type Measurement, type ViewReference } from '../src/core';
import { measurementRows } from '../src/react/modules/measure/model';
import { landmarkCsv, landmarkRows, nextLandmarkLabel, treSummary } from '../src/react/modules/registration/landmarks';

const view: ViewReference = {
  frameOfReferenceUid: 'for.p',
  displayGridId: 'dg',
  planeOrigin: [0, 0, 0],
  viewPlaneNormal: [0, 0, -1],
  viewUp: [0, -1, 0],
  slabThicknessMm: 0,
  temporalGroupId: null,
  frameIndex: null,
};

const landmark = (id: string, moving: number[], fixed: number[], tre: number, uid = 'for.m'): Layer => {
  const m: Measurement = {
    ...createMeasurement({ kind: 'landmark', frameOfReferenceUid: uid, points: [...moving, ...fixed], viewReference: null, editedOn: view, label: id, measurementId: id }),
    pairFrameOfReferenceUid: 'for.p',
    result: { value: tre, unit: 'mm' },
  };
  return { layerId: `measurement:${id}`, kind: 'measurement', label: id, groupId: 'measurements', frameOfReferenceUid: uid, contentRef: id, visible: true, opacity: 1, order: 0, measurement: m };
};

describe('TRE', () => {
  it('|T(移動點) − 固定點|：用給的對位；點不夠 null', () => {
    const shift = (p: readonly number[]): [number, number, number] => [p[0]! + 3, p[1]! + 4, p[2]!];
    expect(landmarkTre([0, 0, 0, 3, 4, 0], shift)).toBe(0);
    expect(landmarkTre([0, 0, 0, 0, 0, 0], shift)).toBe(5);
    expect(landmarkTre([0, 0, 0, 0, 0, 12], (p) => [p[0], p[1], p[2]])).toBe(12);
    expect(landmarkTre([1, 2, 3], shift)).toBeNull();
  });
});

describe('面板', () => {
  const layers = [landmark('a', [0, 0, 0], [1, 1, 1], 0.5), landmark('b', [5, 5, 5], [6, 6, 6], 2.5), landmark('c', [0, 0, 0], [0, 0, 0], 9, 'for.other')];

  it('只列這組次要序列的地標對；固定／移動點分開', () => {
    const rows = landmarkRows(layers, 'for.m');
    expect(rows.map((r) => r.measurementId)).toEqual(['a', 'b']);
    expect(rows[1]).toMatchObject({ tre: 2.5, moving: [5, 5, 5], fixed: [6, 6, 6] });
  });

  it('摘要：平均、RMS、最大、超過門檻的對數', () => {
    const s = treSummary(landmarkRows(layers, 'for.m'), 2);
    expect(s.n).toBe(2);
    expect(s.mean).toBeCloseTo(1.5);
    expect(s.rms).toBeCloseTo(Math.sqrt((0.25 + 6.25) / 2));
    expect(s.max).toBe(2.5);
    expect(s.over).toBe(1);
    expect(treSummary([], 2)).toEqual({ n: 0, mean: 0, rms: 0, max: 0, over: 0 });
  });

  it('CSV 與命名', () => {
    const csv = landmarkCsv(landmarkRows(layers, 'for.m'), 'for.p', 'for.m').split('\n');
    expect(csv[0]).toBe('label,tre_mm,fixed_x,fixed_y,fixed_z,moving_x,moving_y,moving_z,fixed_frame_of_reference_uid,moving_frame_of_reference_uid');
    expect(csv[2]).toBe('b,2.500,6.00,6.00,6.00,5.00,5.00,5.00,for.p,for.m');
    expect(nextLandmarkLabel([])).toBe('地標 1');
    expect(nextLandmarkLabel(['地標 1', '地標 7', '別的'])).toBe('地標 8');
  });

  it('量測表不列地標對（屬於對位面板）', () => {
    expect(measurementRows(layers)).toEqual([]);
  });
});

describe('SVG', () => {
  it('固定點圈、移動點叉、誤差虛線、TRE 標籤；沒有可拖的把手', () => {
    const m = landmark('a', [0, 0, 0], [1, 1, 1], 1.84).measurement!;
    const input = { measurement: m, pointsPx: [{ x: 10, y: 10 }, { x: 30, y: 10 }], mode: 'full' as const, selected: true, editable: false, valueText: 'TRE 1.8 mm' };
    const nodes = measurementNodes(input);
    expect(nodes.some((n) => n.attrs['class']?.includes('rt-landmark-fixed') && n.attrs['cx'] === '30.0')).toBe(true);
    expect(nodes.some((n) => n.attrs['class']?.includes('rt-landmark-moving'))).toBe(true);
    expect(nodes.some((n) => n.attrs['class']?.includes('rt-landmark-error'))).toBe(true);
    expect(nodes.find((n) => n.tag === 'text')?.text).toContain('TRE 1.8 mm');
    expect(measurementHandles({ ...input, editable: true })).toEqual([]);
  });
});
