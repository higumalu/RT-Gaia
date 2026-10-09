/**
 * 3D 射束 ＋ 2D 弧刻度 —— 3D 圖層的擴充點、計畫模組送出的 `beams` 圖層、弧刻度的幾何（哪張切面畫、方向、長度）。
 */

import { describe, expect, it } from 'vitest';

import { arcTicks, beams3dLayer, type BeamControlPoints, type ControlPoint } from '../src/react/modules/plan/model';
import { contributed3dLayers, register3dLayers } from '../src/react/modules/render3d/contrib';

const cp = (i: number, g: number, mpd: number | null): ControlPoint => ({
  index: i,
  gantry_deg: g,
  collimator_deg: 0,
  couch_deg: 0,
  weight: 0,
  mu: 0,
  dose_rate: null,
  jaws: { x: null, y: null },
  mlc: {},
  mu_per_deg: mpd,
});

const bcp: BeamControlPoints = {
  number: 2,
  name: 'F',
  beam_type: 'DYNAMIC',
  is_treatment: true,
  meterset: 100,
  meterset_unit: 'MU',
  sad_mm: 1000,
  gantry_direction: 'CW',
  final_weight: 1,
  devices: [],
  control_points: [cp(0, 0, null), cp(1, 90, 0.5), cp(2, 180, 1)],
  track: {
    iso_primary_mm: [0, 0, 0],
    source_primary_mm: [
      [0, -1000, 0],
      [1000, 0, 0],
      [0, 1000, 0],
    ],
    rotation_axis_primary: [0, 0, 1],
    sad_mm: 1000,
    position: 'HFS',
    supported_position: true,
  },
};

// 軸向格：x → 右、y → 下（LPS 的 +y 是後方，畫面往下），1 mm ＝ 0.1 px
const project = (w: readonly [number, number, number]): { x: number; y: number } => ({ x: 100 + w[0] * 0.1, y: 100 + w[1] * 0.1 });

describe('弧刻度', () => {
  it('軸向（法線 ∥ 旋轉軸）：每個 CP 一個方向，長度 ∝ MU/°（以最大值正規化）', () => {
    const r = arcTicks(bcp, [0, 0, 1], project)!;
    expect(r.center).toEqual({ x: 100, y: 100 });
    expect(r.dirs.map((d) => [Math.round(d.dx), Math.round(d.dy)])).toEqual([
      [0, -1],
      [1, 0],
      [0, 1],
    ]);
    expect(r.dirs.map((d) => d.weight)).toEqual([0, 0.5, 1]);
  });

  it('冠狀／矢狀（法線不平行旋轉軸）不畫；沒有幾何不畫', () => {
    expect(arcTicks(bcp, [0, 1, 0], project)).toBeNull();
    expect(arcTicks({ ...bcp, track: null }, [0, 0, 1], project)).toBeNull();
  });
});

describe('3D 圖層', () => {
  it('計畫模組的 beams 圖層：有計畫才送；帶目前射束與 CP；關掉就不送', () => {
    expect(beams3dLayer(undefined)).toEqual([]);
    expect(beams3dLayer({ planId: 'p' })).toEqual([{ renderer: 'beams', plan_id: 'p' }]);
    expect(beams3dLayer({ planId: 'p', bevBeam: 3, cp: 7 })).toEqual([{ renderer: 'beams', plan_id: 'p', beam_number: 3, cp: 7 }]);
    expect(beams3dLayer({ planId: 'p', showBeams3d: false })).toEqual([]);
  });

  it('擴充點：註冊的貢獻附加在後面；出錯的不影響其他', () => {
    const off1 = register3dLayers('t.a', () => [{ renderer: 'x' }]);
    const off2 = register3dLayers('t.b', () => {
      throw new Error('boom');
    });
    const state = { modules: {} } as unknown as Parameters<typeof contributed3dLayers>[0];
    expect(contributed3dLayers(state).filter((l) => l['renderer'] === 'x')).toHaveLength(1);
    off1();
    off2();
    expect(contributed3dLayers(state).filter((l) => l['renderer'] === 'x')).toHaveLength(0);
  });
});
