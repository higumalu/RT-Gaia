/**
 * `DisplayGrid` / `MaskGrid` / `GridSet`。
 *
 * 🔴 **兩個網格各自獨立失效（I4）**，且**跨族比對世界座標而不是 id（I3）**。
 *
 * > `MaskGrid` **沒有裁切自由度**，恆等於取像網格。
 */

import { require_ } from './errors';
import type { FrameGroup } from './frameGroup';
import { createGrid, indexToWorld, voxelCount, type Grid } from './grid';
import type { Int3, Vec3 } from './lps';
import type { TemporalGroup } from './temporal';
import { t } from '../i18n';

export type DisplayDType = 'int16' | 'uint8';
export type Tier = 'A' | 'B' | 'C';

export interface DisplayGrid {
  readonly grid: Grid;
  readonly sourceGrid: Grid;
  readonly cropOffsetIjk: Int3;
  readonly downsampleFactor: Int3;
  readonly dtype: DisplayDType;
  /** `dtype='uint8'` 時必填；`int16` 時必須為 null。 */
  readonly windowBaked: readonly [number, number] | null;
  readonly displayGridId: string;
}

export interface MaskGrid {
  readonly grid: Grid;
  readonly maskGridId: string;
}

export interface GridSet {
  readonly displayGrid: DisplayGrid;
  /** primary FoR 的 `MaskGrid`；其餘 FoR 的在 `maskGrids`。 */
  readonly maskGrid: MaskGrid;
  readonly frameGroups: readonly FrameGroup[];
  readonly temporalGroups: readonly TemporalGroup[];
  readonly assignedTier: Tier;
  /**
   * **每個 FrameGroup 一個** `MaskGrid`。缺省（舊 wire、單序列）＝ `[maskGrid]`。
   * 取用一律經 `maskGridOf(gs, frameOfReferenceUid)`。
   */
  readonly maskGrids?: readonly MaskGrid[];
}

export function createDisplayGrid(dg: DisplayGrid): DisplayGrid {
  createGrid(dg.grid);
  createGrid(dg.sourceGrid);
  for (const [name, value] of [
    ['cropOffsetIjk', dg.cropOffsetIjk],
    ['downsampleFactor', dg.downsampleFactor],
  ] as const) {
    require_(value.length === 3, 'I1', t('{name} 必須是三個元素', { name }), { [name]: value });
    require_(
      value.every((v) => Number.isInteger(v)),
      'I1',
      t('{name} 必須是整數 voxel（chaos: fractional_offset）', { name }),
      { [name]: value },
    );
  }
  require_(dg.cropOffsetIjk.every((v) => v >= 0), 'I1', t('cropOffsetIjk 不得為負'), {
    cropOffsetIjk: dg.cropOffsetIjk,
  });
  require_(dg.downsampleFactor.every((v) => v >= 1), 'I1', t('downsampleFactor 每軸必須 >= 1'), {
    downsampleFactor: dg.downsampleFactor,
  });
  require_(
    dg.grid.frameOfReferenceUid === dg.sourceGrid.frameOfReferenceUid,
    'I5',
    t('display grid 與 source grid 必須同一個 Frame of Reference'),
  );
  if (dg.dtype === 'uint8') {
    require_(dg.windowBaked !== null, 'D1', t('dtype=uint8 時 windowBaked 必填'));
  } else {
    require_(
      dg.windowBaked === null,
      'D2',
      t('dtype=int16 不得帶 windowBaked——烘焙過的 window 會讓 WW/WL 無法自由調整'),
      { windowBaked: dg.windowBaked },
    );
  }
  return dg;
}

export function createMaskGrid(mg: MaskGrid): MaskGrid {
  createGrid(mg.grid);
  require_(typeof mg.maskGridId === 'string' && mg.maskGridId.length > 0, 'I2', t('maskGridId 必填'));
  return mg;
}

export function createGridSet(gs: GridSet): GridSet {
  createDisplayGrid(gs.displayGrid);
  createMaskGrid(gs.maskGrid);
  const primaries = gs.frameGroups.filter((f) => f.role === 'primary');
  require_(primaries.length === 1, 'F1', t('必須恰好有一個 primary FrameGroup'), {
    count: primaries.length,
  });
  require_(
    primaries[0]!.frameOfReferenceUid === gs.displayGrid.grid.frameOfReferenceUid,
    'F2',
    t('display grid 必須落在 primary FrameGroup 的 Frame of Reference 上'),
  );
  const ids = gs.temporalGroups.map((t) => t.temporalGroupId);
  require_(new Set(ids).size === ids.length, 'T1', t('temporalGroupId 必須唯一'), { ids });
  if (gs.maskGrids !== undefined) {
    for (const mg of gs.maskGrids) createMaskGrid(mg);
    const known = new Set(gs.maskGrids.map((m) => m.maskGridId));
    require_(known.has(gs.maskGrid.maskGridId), 'I5', t('GridSet.maskGrid（primary）必須也在 maskGrids 裡'), {
      maskGrid: gs.maskGrid.maskGridId,
      maskGrids: [...known],
    });
    for (const fg of gs.frameGroups) {
      if (fg.maskGridId != null) {
        require_(known.has(fg.maskGridId), 'I5', t('FrameGroup.maskGridId 指向不存在的 MaskGrid'), {
          frameGroup: fg.frameOfReferenceUid,
          maskGridId: fg.maskGridId,
        });
        const mg = gs.maskGrids.find((m) => m.maskGridId === fg.maskGridId)!;
        require_(
          mg.grid.frameOfReferenceUid === fg.frameOfReferenceUid,
          'I5',
          t('FrameGroup 的 MaskGrid 必須落在同一個 Frame of Reference'),
          { frameGroup: fg.frameOfReferenceUid, maskGridFor: mg.grid.frameOfReferenceUid },
        );
      }
    }
  }
  return gs;
}

/** 全部的 MaskGrid（缺省時就是 `[maskGrid]`）。 */
export function allMaskGrids(gs: GridSet): readonly MaskGrid[] {
  return gs.maskGrids ?? [gs.maskGrid];
}

/**
 * 某個 FoR 的結構所在的 `MaskGrid`。
 *
 * 🔴 mask 的 I3 比對、`putMask` 的區塊網格、編輯鏈的世界→ijk **都要用這個**，
 * 不能直接拿 `gs.maskGrid`——那只是 primary 的。次要 FoR 的結構光柵化在自己的
 * 取像網格上；拿錯網格的症狀是 409 I3，或輪廓貼到錯的位置。
 */
export function maskGridOf(gs: GridSet, frameOfReferenceUid: string): MaskGrid {
  const fg = gs.frameGroups.find((f) => f.frameOfReferenceUid === frameOfReferenceUid);
  if (fg?.maskGridId == null) {
    require_(
      fg === undefined || fg.role === 'primary' || gs.maskGrids === undefined,
      'I5',
      t('次要 FrameGroup 沒有 maskGridId，卻被要求它的 MaskGrid'),
      { frameOfReferenceUid },
    );
    return gs.maskGrid;
  }
  const found = allMaskGrids(gs).find((m) => m.maskGridId === fg.maskGridId);
  require_(found !== undefined, 'I5', t('FrameGroup.maskGridId 指向不存在的 MaskGrid'), { frameOfReferenceUid });
  return found!;
}

export function isDownsampled(dg: DisplayGrid): boolean {
  return dg.downsampleFactor.some((f) => f !== 1);
}

export function bytesPerVoxel(dg: DisplayGrid): number {
  return dg.dtype === 'uint8' ? 1 : 2;
}

/** 單一序列在此網格下的體素位元組數（不含缺 norm16 時 float32 上傳的翻倍）。 */
export function residentBytes(dg: DisplayGrid): number {
  return voxelCount(dg.grid) * bytesPerVoxel(dg);
}

/**
 * display grid 索引 → 取像網格索引。**僅供除錯與驗證，不用於編輯。**
 *
 * 🔴 編輯一律換算到 `MaskGrid`。這兩個網格在 Tier A 未降採樣時數值
 * 恰好相同，所以寫錯不會有任何錯誤訊息——只有 Tier B 降採樣時才會顯現，
 * 而症狀是輪廓變成階梯**並寫進輸出的 RTSTRUCT**。
 */
export function sourceIndexOf(dg: DisplayGrid, displayIjk: Vec3): [number, number, number] {
  return [0, 1, 2].map(
    (i) => displayIjk[i]! * dg.downsampleFactor[i]! + dg.cropOffsetIjk[i]! + (dg.downsampleFactor[i]! - 1) / 2,
  ) as [number, number, number];
}

export function primaryFrameGroup(gs: GridSet): FrameGroup {
  const primary = gs.frameGroups.find((f) => f.role === 'primary');
  require_(primary !== undefined, 'F1', t('GridSet 沒有 primary FrameGroup'));
  return primary!;
}

export function frameGroupOf(gs: GridSet, frameOfReferenceUid: string): FrameGroup {
  const found = gs.frameGroups.find((f) => f.frameOfReferenceUid === frameOfReferenceUid);
  require_(found !== undefined, 'F10', t('沒有這個 FrameGroup'), { frameOfReferenceUid });
  return found!;
}

export function temporalGroupOf(gs: GridSet, temporalGroupId: string): TemporalGroup {
  const found = gs.temporalGroups.find((t) => t.temporalGroupId === temporalGroupId);
  require_(found !== undefined, 'T8', t('沒有這個 TemporalGroup'), { temporalGroupId });
  return found!;
}

/** display grid 覆蓋的世界空間中心（相機初始化與一致性檢查用）。 */
export function worldCenter(dg: DisplayGrid): [number, number, number] {
  return indexToWorld(dg.grid, [
    (dg.grid.size[0] - 1) / 2,
    (dg.grid.size[1] - 1) / 2,
    (dg.grid.size[2] - 1) / 2,
  ]);
}
