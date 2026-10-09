/**
 * wire 上的新欄位：`mask_grids`、`FrameGroup.mask_grid_id`、
 * `FrameGroup.registration`、`Layer.seriesMeta`。
 *
 * 兩件事要同時成立：**新欄位進得來**，且**舊 wire（沒有它們）照樣能讀**——
 * 單序列的 session 與既有 fixture 一行都不必改。
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath, URL } from 'node:url';

import { describe, expect, it } from 'vitest';

import { ContractViolation } from '../src/core/geometry/errors';
import { allMaskGrids, maskGridOf } from '../src/core/geometry/displayGrid';
import { fromWire } from '../src/core/transport/wire';

const fixture = JSON.parse(
  readFileSync(fileURLToPath(new URL('./fixtures/geometry-vectors.json', import.meta.url)), 'utf8'),
) as {
  mask_grid: Record<string, unknown>;
  display_grid_cases: { cases: { display_grid: Record<string, unknown> }[] };
  frame_group: { frame_group: Record<string, unknown> };
};

const primaryFor = (fixture.mask_grid.grid as { frame_of_reference_uid: string }).frame_of_reference_uid;

function secondaryMaskGridWire(): Record<string, unknown> {
  const grid = { ...(fixture.mask_grid.grid as Record<string, unknown>), frame_of_reference_uid: 'for.secondary', size: [8, 8, 4] };
  return { grid, mask_grid_id: 'mg_secondary' };
}

function primaryFrameGroupWire(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    frame_of_reference_uid: primaryFor,
    series_id: 's1',
    role: 'primary',
    transform_to_primary: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
    transform_kind: 'identity',
    coverage_mask_id: null,
    ...extra,
  };
}

function secondaryFrameGroupWire(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    frame_of_reference_uid: 'for.secondary',
    series_id: 's2',
    role: 'secondary',
    // column-major：平移在最後四個
    transform_to_primary: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, -15.3, -178.6, -31.4, 1],
    transform_kind: 'rigid',
    coverage_mask_id: null,
    ...extra,
  };
}

function gridSetWire(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    display_grid: fixture.display_grid_cases.cases[0]!.display_grid,
    mask_grid: fixture.mask_grid,
    frame_groups: [primaryFrameGroupWire()],
    temporal_groups: [],
    assigned_tier: 'C',
    ...extra,
  };
}

describe('多 FrameGroup 的 wire', () => {
  it('舊 wire（沒有 mask_grids／mask_grid_id／registration）照樣能讀，且退回 primary 的 MaskGrid', () => {
    const gs = fromWire.gridSet(gridSetWire());
    expect(gs.maskGrids).toBeUndefined();
    expect(allMaskGrids(gs)).toEqual([gs.maskGrid]);
    expect(maskGridOf(gs, primaryFor)).toBe(gs.maskGrid);
    const fg = fromWire.frameGroup(fixture.frame_group.frame_group);
    expect(fg.maskGridId ?? null).toBeNull();
    expect(fg.registration ?? null).toBeNull();
  });

  it('每個 FrameGroup 一個 MaskGrid：以 FoR 取到自己的那一個，並帶著對位來源', () => {
    const gs = fromWire.gridSet(
      gridSetWire({
        mask_grids: [fixture.mask_grid, secondaryMaskGridWire()],
        frame_groups: [
          primaryFrameGroupWire({ mask_grid_id: fixture.mask_grid.mask_grid_id }),
          secondaryFrameGroupWire({
            mask_grid_id: 'mg_secondary',
            registration: { source: 'REG', sop_instance_uid: '1.2.3', matrix_type: 'RIGID', description: 'REG 20260617' },
          }),
        ],
      }),
    );
    expect(allMaskGrids(gs)).toHaveLength(2);
    expect(maskGridOf(gs, primaryFor).maskGridId).toBe(gs.maskGrid.maskGridId);
    expect(maskGridOf(gs, 'for.secondary').maskGridId).toBe('mg_secondary');
    expect(maskGridOf(gs, 'for.secondary').grid.size).toEqual([8, 8, 4]);
    const secondary = gs.frameGroups.find((f) => f.role === 'secondary')!;
    expect(secondary.registration).toEqual({
      source: 'REG',
      sopInstanceUid: '1.2.3',
      matrixType: 'RIGID',
      description: 'REG 20260617',
    });
    // 「找不到 REG」必須看得見，不是 null
    const unregistered = fromWire.frameGroup(
      secondaryFrameGroupWire({
        transform_to_primary: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
        transform_kind: 'identity',
        registration: { source: 'none', description: '找不到 REG' },
      }),
    );
    expect(unregistered.registration?.source).toBe('none');
  });

  it('mask_grid_id 指向不存在的 MaskGrid、或 FoR 不符 → I5 拒絕', () => {
    expect(() =>
      fromWire.gridSet(
        gridSetWire({
          mask_grids: [fixture.mask_grid],
          frame_groups: [primaryFrameGroupWire(), secondaryFrameGroupWire({ mask_grid_id: 'mg_missing' })],
        }),
      ),
    ).toThrow(ContractViolation);
    expect(() =>
      fromWire.gridSet(
        gridSetWire({
          mask_grids: [fixture.mask_grid, secondaryMaskGridWire()],
          // primary 卻指到 secondary 的 MaskGrid
          frame_groups: [primaryFrameGroupWire({ mask_grid_id: 'mg_secondary' })],
        }),
      ),
    ).toThrow(/I5/);
  });

  it('Layer.seriesMeta 原樣進來（snake_case），沒有時不出現', () => {
    const base = {
      layerId: 'image:s1',
      kind: 'image',
      frameOfReferenceUid: primaryFor,
      contentRef: 's1',
      visible: true,
      opacity: 1,
      order: 0,
    };
    expect(fromWire.layer(base).seriesMeta).toBeUndefined();
    const withMeta = fromWire.layer({
      ...base,
      seriesMeta: { series_date: '20260617', series_description: 'ART iCBCT', manufacturer_model_name: 'Halcyon' },
    });
    expect(withMeta.seriesMeta).toEqual({
      series_date: '20260617',
      series_description: 'ART iCBCT',
      manufacturer_model_name: 'Halcyon',
    });
    const dose = fromWire.layer({ ...base, layerId: 'dose:d1', kind: 'dose', contentRef: 'd1', params: { max_gy: 22.17, units: 'GY' } });
    expect(dose.kind).toBe('dose');
    expect(dose.params).toEqual({ max_gy: 22.17, units: 'GY' });
  });
});
