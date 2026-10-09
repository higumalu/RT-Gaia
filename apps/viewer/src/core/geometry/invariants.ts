/**
 * 不變式 I2–I4 —— **前端拒絕不合法資料的地方**。
 *
 * 這個檔案的每一條都對應測試後端的一個 chaos 模式。
 */

import type { DisplayGrid, MaskGrid } from './displayGrid';
import { require_ } from './errors';
import { indexToWorldMatrix, type Grid } from './grid';
import { t } from '../i18n';

export type GridFamily = 'display' | 'mask';

/** 跨族比對的世界座標容差 —— 與 Python 端同值。 */
export const WORLD_TOL_MM = 1e-4;

/**
 * I3 —— 同族網格 id 比對。
 *
 * **不符即拒絕並報錯，不得嘗試自動對齊。**（chaos: `grid_mismatch`）
 */
export function assertSameFamily(args: {
  payloadGridRef: string;
  sessionGridId: string;
  family: GridFamily;
  payloadLabel?: string;
}): void {
  require_(
    args.payloadGridRef === args.sessionGridId,
    'I3',
    t('{p0} 的 {family} grid id 與本次會話不符——拒絕合成，不得嘗試自動對齊', { p0: args.payloadLabel ?? 'payload', family: args.family }),
    {
      payloadGridRef: args.payloadGridRef,
      sessionGridId: args.sessionGridId,
      family: args.family,
    },
  );
}

/**
 * I3 的跨族分支 —— 🔴 **比對的是 FoR 與世界座標，不是網格 id**。
 *
 * Tier B 降採樣影像時 `displayGridId` 必然與 `maskGridId` 不同；若跨族也比 id，
 * 融合會在降採樣時整批誤判失敗。
 */
export function assertCrossFamilyCompatible(displayGrid: DisplayGrid, maskGrid: MaskGrid): void {
  require_(
    displayGrid.grid.frameOfReferenceUid === maskGrid.grid.frameOfReferenceUid,
    'I3',
    t('影像與 mask 必須落在同一個 Frame of Reference'),
    {
      display: displayGrid.grid.frameOfReferenceUid,
      mask: maskGrid.grid.frameOfReferenceUid,
    },
  );
  const a = indexToWorldMatrix(displayGrid.sourceGrid);
  const b = indexToWorldMatrix(maskGrid.grid);
  require_(
    a.every((v, i) => Math.abs(v - b[i]!) <= WORLD_TOL_MM),
    'I3',
    t('影像的取像網格與 mask 網格必須描述同一塊空間（direction × spacing 相同）'),
  );
  require_(
    displayGrid.sourceGrid.origin.every(
      (v, i) => Math.abs(v - maskGrid.grid.origin[i]!) <= WORLD_TOL_MM,
    ),
    'I3',
    t('影像的取像網格與 mask 網格的 origin 必須相同'),
    {
      displaySourceOrigin: displayGrid.sourceGrid.origin,
      maskOrigin: maskGrid.grid.origin,
    },
  );
}

/** 一個 payload 的體素位元組數必須與其描述子相符（chaos: `wrong_size`／`truncate`）。 */
export function assertPayloadLength(args: {
  sizeIjk: readonly [number, number, number];
  components: number;
  bytesPerElement: number;
  actualBytes: number;
}): void {
  const expected =
    args.sizeIjk[0] * args.sizeIjk[1] * args.sizeIjk[2] * args.components * args.bytesPerElement;
  require_(
    args.actualBytes === expected,
    'I9',
    t('payload 長度與 header 宣告不符（chaos: truncate / wrong_size）——不得渲染半張影像'),
    { declared: expected, actual: args.actualBytes },
  );
}

/**
 * I4 —— 🔴 **兩個網格 id 各自獨立失效，不連動。**
 *
 * `displayGridId` 改變 → 所有影像 payload 失效。
 * `maskGridId` 改變 → 所有 mask 與 mesh 失效。
 */
export type InvalidatedKind = 'image' | 'mask' | 'mesh';

export class InvalidationTracker {
  displayGridId: string;
  maskGridId: string;
  readonly log: InvalidatedKind[] = [];

  constructor(displayGridId: string, maskGridId: string) {
    this.displayGridId = displayGridId;
    this.maskGridId = maskGridId;
  }

  update(next: { displayGridId?: string; maskGridId?: string }): Set<InvalidatedKind> {
    const dropped = new Set<InvalidatedKind>();
    if (next.displayGridId !== undefined && next.displayGridId !== this.displayGridId) {
      this.displayGridId = next.displayGridId;
      dropped.add('image');
    }
    if (next.maskGridId !== undefined && next.maskGridId !== this.maskGridId) {
      this.maskGridId = next.maskGridId;
      dropped.add('mask');
      dropped.add('mesh');
    }
    this.log.push(...dropped);
    return dropped;
  }
}

/** 兩個 `Grid` 是否描述同一塊空間（除錯與等效性測試用）。 */
export function gridsDescribeSameSpace(a: Grid, b: Grid, tol = WORLD_TOL_MM): boolean {
  if (a.frameOfReferenceUid !== b.frameOfReferenceUid) return false;
  if (!a.size.every((v, i) => v === b.size[i])) return false;
  const ma = indexToWorldMatrix(a);
  const mb = indexToWorldMatrix(b);
  return (
    ma.every((v, i) => Math.abs(v - mb[i]!) <= tol) &&
    a.origin.every((v, i) => Math.abs(v - b.origin[i]!) <= tol)
  );
}
