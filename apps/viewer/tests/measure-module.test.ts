/**
 * 量測模組：註冊／可見性、表格列、CSV、方框深度。
 */

import { beforeEach, describe, expect, it } from 'vitest';

import { clearModules, clearPanels, createMeasurement, listModules, listPanels, type Layer, type PanelVisibilityState, type ViewReference } from '../src/core';
import { deleteVertex, formatStats, insertVertexAfter, MEASURE_MODE, measurementRows, registerMeasureModule, resetMeasureModuleRegistration, setVertex, toCsv, vertexRows, withBoxDepth } from '../src/react/modules/measure';
import { registerCoreUi, resetCoreUiRegistration } from '../src/react/panels/builtins';

const state = (modes: string[]): PanelVisibilityState => ({ tier: 'C', selectedLayerIds: [], hasTemporalLayer: false, hasSecondarySeries: false, hasDoseLayer: false, layoutId: '2x2', modes });
const axial: ViewReference = { frameOfReferenceUid: 'f', displayGridId: 'dg', planeOrigin: [0, 0, 0], viewPlaneNormal: [0, 0, -1], viewUp: [0, -1, 0], slabThicknessMm: 0, temporalGroupId: null, frameIndex: null };

describe('量測模組', () => {
  beforeEach(() => {
    clearPanels();
    clearModules();
    resetCoreUiRegistration();
    resetMeasureModuleRegistration();
    registerCoreUi();
    registerMeasureModule();
  });

  it('registerModule；開關永遠在；面板只在 measure 模式；表格是 cell 面板', () => {
    expect(listModules().find((m) => m.id === 'rt-gaia-measure')?.version).toBe('0.1.0');
    expect(listPanels('toolbar', state([])).map((p) => p.id)).toContain('measure.toggle');
    expect(listPanels('right-sidebar', state([])).map((p) => p.id)).toEqual([]);
    expect(listPanels('right-sidebar', state([MEASURE_MODE])).map((p) => p.id)).toEqual(['measure.panel']);
    expect(listPanels('cell').map((p) => p.id)).toContain('measure.table');
    expect(() => registerMeasureModule()).not.toThrow();
  });
});

describe('表格列與 CSV', () => {
  const dist = createMeasurement({ kind: 'distance', frameOfReferenceUid: 'f', points: [0, 0, 0, 3, 4, 0], viewReference: null, editedOn: axial, label: '距離 1' });
  const box = createMeasurement({ kind: 'roi3d', frameOfReferenceUid: 'f', points: [0, 0, 0, 10, 10, 4], viewReference: null, editedOn: axial, label: '體積, "A"' });
  const pt = createMeasurement({ kind: 'point', frameOfReferenceUid: 'f', points: [1, 2, 3], viewReference: null, editedOn: axial, label: '標記 1' });
  const layers: Layer[] = [
    { layerId: 'img', kind: 'image', label: 'CT', groupId: null, frameOfReferenceUid: 'f', contentRef: 's', visible: true, opacity: 1, order: 0 },
    { layerId: 'measurement:a', kind: 'measurement', label: dist.label, groupId: 'measurements', frameOfReferenceUid: 'f', contentRef: dist.measurementId, visible: true, opacity: 1, order: 1, measurement: { ...dist, result: { value: 5, unit: 'mm' } } },
    {
      layerId: 'measurement:b', kind: 'measurement', label: box.label, groupId: 'measurements', frameOfReferenceUid: 'f', contentRef: box.measurementId, visible: false, opacity: 1, order: 2,
      measurement: { ...box, result: { value: 0.4, unit: 'cc', stats: { mean: 12.345, min: -5, max: 40, stdev: 3.21, voxelCount: 400, approximate: true } } },
    },
    { layerId: 'measurement:c', kind: 'measurement', label: pt.label, groupId: 'measurements', frameOfReferenceUid: 'f', contentRef: pt.measurementId, visible: true, opacity: 1, order: 3, measurement: { ...pt, result: { value: 0, unit: 'mm' } } },
  ];

  it('只取 measurement layer；值格式、單位、可見、方框深度', () => {
    const rows = measurementRows(layers);
    expect(rows.map((r) => r.kind)).toEqual(['distance', 'roi3d', 'point']);
    expect(rows[0]!.valueText).toBe('5.0 mm');
    expect(rows[1]!.valueText).toBe('0.40 cc');
    expect(rows[1]!.visible).toBe(false);
    expect(rows[1]!.depthMm).toBe(4);
    expect(rows[2]!.valueText).toBe('(1.0, 2.0, 3.0) mm');
    expect(rows[0]!.depthMm).toBeNull();
    expect(formatStats(rows[1]!.stats)).toBe('≈ 12.3 ± 3.2（-5–40，n=400）');
    expect(formatStats(null)).toBe('');
    // PET（SUV）2 位小數、標單位
    expect(formatStats({ mean: 2.345, stdev: 0.5, min: 0.12, max: 7.8, voxelCount: 9, approximate: false, unit: 'SUV' })).toBe('2.35 ± 0.50 SUV（0.12–7.80，n=9）');
  });

  it('改深度以中心為準；CSV 有標頭、逗號與引號跳脫、點座標', () => {
    expect(withBoxDepth(box, 10)).toEqual([0, 0, -3, 10, 10, 7]);
    const csv = toCsv(measurementRows(layers));
    const lines = csv.split('\n');
    expect(lines[0]).toBe('kind,label,value,unit,hu_mean,hu_stdev,hu_min,hu_max,voxels,approximate,frame_of_reference_uid,points_lps_mm,stats_unit');
    expect(lines[1]).toBe(`distance,距離 1,5.000,mm,,,,,,,f,0.00 0.00 0.00 3.00 4.00 0.00,`);
    expect(lines[2]).toContain('"體積, ""A"""');
    expect(lines[2]).toContain(',12.35,3.21,-5,40,400,yes,');
    expect(lines[3]!.startsWith('point,標記 1,,,')).toBe(true);
  });
});

describe('面板編輯頂點：純函式', () => {
  const view: ViewReference = { frameOfReferenceUid: 'f', displayGridId: 'g', planeOrigin: [0, 0, 5], viewPlaneNormal: [0, 0, 1], viewUp: [0, -1, 0], slabThicknessMm: 0, temporalGroupId: null, frameIndex: null };
  const square = createMeasurement({ kind: 'area', frameOfReferenceUid: 'f', points: [0, 0, 5, 10, 0, 5, 10, 10, 5, 0, 10, 5], viewReference: view, editedOn: view, label: 'a' });

  it('vertexRows 列出每個頂點', () => {
    expect(vertexRows(square)).toEqual([
      { index: 0, x: 0, y: 0, z: 5 },
      { index: 1, x: 10, y: 0, z: 5 },
      { index: 2, x: 10, y: 10, z: 5 },
      { index: 3, x: 0, y: 10, z: 5 },
    ]);
  });

  it('deleteVertex：四點刪一點；三點不能刪（null）；索引越界 null', () => {
    expect(deleteVertex(square, 1)).toEqual([0, 0, 5, 10, 10, 5, 0, 10, 5]);
    const tri = createMeasurement({ kind: 'area', frameOfReferenceUid: 'f', points: [0, 0, 5, 10, 0, 5, 10, 10, 5], viewReference: view, editedOn: view, label: 't' });
    expect(deleteVertex(tri, 0)).toBeNull();
    expect(deleteVertex(square, 4)).toBeNull();
  });

  it('insertVertexAfter：插在中點；最後一點後面接回第一點', () => {
    expect(insertVertexAfter(square, 0)).toEqual([0, 0, 5, 5, 0, 5, 10, 0, 5, 10, 10, 5, 0, 10, 5]);
    expect(insertVertexAfter(square, 3)).toEqual([0, 0, 5, 10, 0, 5, 10, 10, 5, 0, 10, 5, 0, 5, 5]);
  });

  it('setVertex：改座標並投回自己的平面（z 被拉回 5）', () => {
    expect(setVertex(square, 2, [12, 13, 99])).toEqual([0, 0, 5, 10, 0, 5, 12, 13, 5, 0, 10, 5]);
    expect(setVertex(square, 9, [1, 1, 1])).toEqual(Array.from(square.points));
  });
});
