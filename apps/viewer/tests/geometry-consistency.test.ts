/**
 * 🔴 座標轉換的驗收：**Python 端與瀏覽器端對同一個 world 座標算出的 ijk 必須一致。**
 *
 * 測試向量由 `scripts/emit-geometry-fixture.py`（Python 端）產生，這裡逐條斷言。
 * **兩邊各寫一次測試、各自通過，證明的是「各自自洽」，不是「彼此一致」。**
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath, URL } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  createDisplayGrid,
  createFrameGroup,
  createGrid,
  createMaskGrid,
  createViewReference,
  cornersWorld,
  fromPrimaryWorld,
  indexToWorld,
  indexToWorldMatrix,
  planeRight,
  planeRowDirection,
  roundTripError,
  signedDistance,
  sourceIndexOf,
  toPrimaryWorld,
  voxelVolumeMm3,
  worldToIndex,
  worldToNearestVoxel,
  type Vec3,
} from '../src/core/geometry';
import { fromWire } from '../src/core/transport/wire';

const fixture = JSON.parse(
  readFileSync(fileURLToPath(new URL('./fixtures/geometry-vectors.json', import.meta.url)), 'utf8'),
) as GeometryFixture;

interface GeometryFixture {
  grid_cases: {
    name: string;
    grid: Record<string, unknown>;
    index_to_world: { ijk: number[]; world_lps: number[] }[];
    world_to_index: { world_lps: number[]; ijk: number[] }[];
    corners_world_lps: number[][];
    voxel_volume_mm3: number;
    index_to_world_matrix_row_major: number[];
  }[];
  display_grid_cases: {
    source_grid: Record<string, unknown>;
    cases: {
      downsample_factor: number[];
      display_grid: Record<string, unknown>;
      expected_origin_lps: number[];
      source_index_of_display_000: number[];
      resident_bytes: number;
    }[];
  };
  mask_grid: Record<string, unknown>;
  frame_group: {
    frame_group: Record<string, unknown>;
    to_primary: { self_world: number[]; primary_world: number[] }[];
    from_primary: { primary_world: number[]; self_world: number[] }[];
  };
  view_reference: {
    view_reference: Record<string, unknown>;
    right: number[];
    row_direction: number[];
    signed_distance: { world_lps: number[]; distance_mm: number }[];
  };
  landmark: { ijk: number[]; world_lps: number[]; voxel_value: number; grid: Record<string, unknown> };
  known_geometry: {
    structures: Record<string, { volume_cc: number; volume_cc_voxelized?: number }>;
    marker_distance_mm: number;
  };
}

/** 幾何一致性的容差。
 *
 * 1e-9 mm ＝ 1 皮米。兩邊都是 IEEE-754 double 且算法相同，實際誤差在 1e-13
 * 量級；訂在 1e-9 是為了「有意義的鬆」——大過它就代表算法真的分岔了，
 * 而不是捨入。 */
const TOL = 1e-9;

const vec3 = (a: number[]): Vec3 => [a[0]!, a[1]!, a[2]!];

describe('Grid — index↔world 與 Python 端逐條一致', () => {
  for (const c of fixture.grid_cases) {
    describe(c.name, () => {
      const grid = fromWire.grid(c.grid);

      it('grid 通過契約驗證', () => {
        expect(() => createGrid(grid)).not.toThrow();
      });

      it('direction 完整帶過來（9 個 float）', () => {
        expect(grid.direction).toHaveLength(9);
      });

      it('index → world 與 Python 一致', () => {
        for (const { ijk, world_lps } of c.index_to_world) {
          const got = indexToWorld(grid, vec3(ijk));
          for (let k = 0; k < 3; k += 1) {
            expect(Math.abs(got[k]! - world_lps[k]!)).toBeLessThan(TOL);
          }
        }
      });

      it('world → index 與 Python 一致', () => {
        for (const { world_lps, ijk } of c.world_to_index) {
          const got = worldToIndex(grid, vec3(world_lps));
          for (let k = 0; k < 3; k += 1) {
            expect(Math.abs(got[k]! - ijk[k]!)).toBeLessThan(TOL);
          }
        }
      });

      it('index→world 矩陣與 Python 一致', () => {
        const got = indexToWorldMatrix(grid);
        c.index_to_world_matrix_row_major.forEach((v, i) => {
          expect(Math.abs(got[i]! - v)).toBeLessThan(TOL);
        });
      });

      it('八個角的世界座標與 Python 一致', () => {
        const got = cornersWorld(grid);
        c.corners_world_lps.forEach((corner, n) => {
          for (let k = 0; k < 3; k += 1) {
            expect(Math.abs(got[n]![k]! - corner[k]!)).toBeLessThan(TOL);
          }
        });
      });

      it('往返自檢', () => {
        expect(roundTripError(grid)).toBeLessThan(TOL);
      });

      it('體素體積一致', () => {
        expect(Math.abs(voxelVolumeMm3(grid) - c.voxel_volume_mm3)).toBeLessThan(TOL);
      });
    });
  }
});

describe('DisplayGrid — 降採樣的 origin 必須是盒中心', () => {
  const source = fromWire.grid(fixture.display_grid_cases.source_grid);

  for (const c of fixture.display_grid_cases.cases) {
    it(`降採樣 ${c.downsample_factor.join('×')} 的 origin 與 Python 一致`, () => {
      const dg = fromWire.displayGrid(c.display_grid);
      expect(() => createDisplayGrid(dg)).not.toThrow();
      for (let k = 0; k < 3; k += 1) {
        expect(Math.abs(dg.grid.origin[k]! - c.expected_origin_lps[k]!)).toBeLessThan(TOL);
      }
    });

    it(`降採樣 ${c.downsample_factor.join('×')} 的 sourceIndexOf 與 Python 一致`, () => {
      const dg = fromWire.displayGrid(c.display_grid);
      const got = sourceIndexOf(dg, [0, 0, 0]);
      for (let k = 0; k < 3; k += 1) {
        expect(Math.abs(got[k]! - c.source_index_of_display_000[k]!)).toBeLessThan(TOL);
      }
    });

    it(`降採樣 ${c.downsample_factor.join('×')} 後世界座標仍自洽`, () => {
      const dg = fromWire.displayGrid(c.display_grid);
      // display 索引 p → 取像索引 → 世界座標，必須與直接算 display 的世界座標相同
      const p: Vec3 = [3, 2, 1];
      const viaDisplay = indexToWorld(dg.grid, p);
      const viaSource = indexToWorld(source, sourceIndexOf(dg, p));
      for (let k = 0; k < 3; k += 1) {
        expect(Math.abs(viaDisplay[k]! - viaSource[k]!)).toBeLessThan(1e-6);
      }
    });
  }
});

describe('MaskGrid — 恆為取像網格', () => {
  it('mask grid 的幾何等於取像網格（沒有裁切自由度）', () => {
    const mg = fromWire.maskGrid(fixture.mask_grid);
    const source = fromWire.grid(fixture.display_grid_cases.source_grid);
    expect(() => createMaskGrid(mg)).not.toThrow();
    expect(mg.grid.size).toEqual(source.size);
    expect(mg.grid.spacing).toEqual(source.spacing);
    expect(mg.grid.origin).toEqual(source.origin);
    expect(mg.maskGridId.startsWith('mg_')).toBe(true);
  });
});

describe('FrameGroup — column-major 與逆變換', () => {
  const fg = fromWire.frameGroup(fixture.frame_group.frame_group);

  it('通過契約驗證', () => {
    expect(() => createFrameGroup(fg)).not.toThrow();
  });

  it('toPrimaryWorld 與 Python 一致', () => {
    for (const { self_world, primary_world } of fixture.frame_group.to_primary) {
      const got = toPrimaryWorld(fg, vec3(self_world));
      for (let k = 0; k < 3; k += 1) {
        expect(Math.abs(got[k]! - primary_world[k]!)).toBeLessThan(TOL);
      }
    }
  });

  it('fromPrimaryWorld 與 Python 一致', () => {
    for (const { primary_world, self_world } of fixture.frame_group.from_primary) {
      const got = fromPrimaryWorld(fg, vec3(primary_world));
      for (let k = 0; k < 3; k += 1) {
        expect(Math.abs(got[k]! - self_world[k]!)).toBeLessThan(TOL);
      }
    }
  });
});

describe('ViewReference — 平面基底', () => {
  const view = fromWire.viewReference(fixture.view_reference.view_reference);

  it('通過契約驗證', () => {
    expect(() => createViewReference(view)).not.toThrow();
  });

  it('right = up × normal，與 Python 一致', () => {
    const got = planeRight(view);
    fixture.view_reference.right.forEach((v, k) => {
      expect(Math.abs(got[k]! - v)).toBeLessThan(TOL);
    });
  });

  it('列方向 = -viewUp，與 Python／Rust 同慣例', () => {
    const got = planeRowDirection(view);
    fixture.view_reference.row_direction.forEach((v, k) => {
      expect(Math.abs(got[k]! - v)).toBeLessThan(TOL);
    });
  });

  it('帶號距離與 Python 一致', () => {
    for (const { world_lps, distance_mm } of fixture.view_reference.signed_distance) {
      expect(Math.abs(signedDistance(view, vec3(world_lps)) - distance_mm)).toBeLessThan(TOL);
    }
  });
});

describe('landmark — 座標鏈的端到端驗收', () => {
  it('標記體素的 ijk ↔ LPS 完全吻合', () => {
    const grid = fromWire.grid(fixture.landmark.grid);
    const world = indexToWorld(grid, vec3(fixture.landmark.ijk));
    fixture.landmark.world_lps.forEach((v, k) => {
      expect(Math.abs(world[k]! - v)).toBeLessThan(TOL);
    });
    expect(worldToNearestVoxel(grid, vec3(fixture.landmark.world_lps))).toEqual(
      fixture.landmark.ijk,
    );
  });
});

describe('known_geometry — 量測真值', () => {
  it('球 65.45 cc、立方 64.00 cc、標記點相距 100.00 mm', () => {
    expect(fixture.known_geometry.structures.sphere_25mm!.volume_cc).toBe(65.45);
    expect(fixture.known_geometry.structures.cube_40mm!.volume_cc).toBe(64.0);
    expect(fixture.known_geometry.marker_distance_mm).toBe(100.0);
  });
});
