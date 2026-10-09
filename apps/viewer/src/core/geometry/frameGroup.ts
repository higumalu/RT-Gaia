/**
 * `FrameGroup` —— 影像與其結構的綁定單位。
 *
 * **變換的作用對象是整個 FrameGroup，不是單一 layer**——影像動，屬於它的 mask
 * 與 mesh 一起動。分開套用是錯的，症狀是拖曳影像時輪廓留在原地。
 */

import { require_ } from './errors';
import {
  applyMat4,
  inverseMat4,
  mat16ColumnMajorToRows,
  mul3,
  transpose3,
  type Mat16,
  type Vec3,
} from './lps';
import { t } from '../i18n';

export type FrameGroupRole = 'primary' | 'secondary';
export type TransformKind = 'identity' | 'rigid' | 'resampled';
/** `shared_frame`：與 primary 同一個 FoR，本來就在同一個空間，無需對位。 */
export type RegistrationSource = 'REG' | 'none' | 'manual' | 'phantom' | 'shared_frame';

/**
 * `transformToPrimary` 是**從哪裡來的**。
 *
 * 讓 UI 能說「這個對位來自 2026-06-17 的 Spatial Registration，RIGID」，以及讓
 * 「找不到 REG、暫以單位矩陣擺放」這件事在畫面上**看得見**（`source: 'none'`），
 * 而不是被默默當成已對位。
 */
export interface RegistrationInfo {
  readonly source: RegistrationSource;
  readonly sopInstanceUid: string | null;
  /** DICOM `FrameOfReferenceTransformationMatrixType`（RIGID / RIGID_SCALE / AFFINE）。 */
  readonly matrixType: string | null;
  readonly description: string | null;
}

export const IDENTITY_16: Mat16 = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
const RIGID_TOL = 1e-6;

export interface FrameGroup {
  readonly frameOfReferenceUid: string;
  readonly seriesId: string;
  readonly role: FrameGroupRole;
  /** 從本 FoR 到 primary FoR 的變換。LPS，**column-major 4×4**。 */
  readonly transformToPrimary: Mat16;
  readonly transformKind: TransformKind;
  /** `transformKind='resampled'` 時標示有效資料範圍。 */
  readonly coverageMaskId: string | null;
  /**
   * 這個 FoR 的結構所在的 `MaskGrid`（**每個 FrameGroup 一個**）。
   * 缺省（舊 wire）時視為 `GridSet.maskGrid`——用 `maskGridOf()` 取，不要直接讀。
   */
  readonly maskGridId?: string | null;
  readonly registration?: RegistrationInfo | null;
}

export function createFrameGroup(fg: FrameGroup): FrameGroup {
  require_(fg.transformToPrimary.length === 16, 'F3', t('transformToPrimary 必須是 16 個 float'), {
    got: fg.transformToPrimary.length,
  });
  const rows = mat16ColumnMajorToRows(fg.transformToPrimary);
  require_(
    [0, 0, 0, 1].every((v, i) => Math.abs(rows[3]![i]! - v) < RIGID_TOL),
    'F4',
    t('transformToPrimary 的最後一列必須是 [0,0,0,1]（是否誤傳 row-major？）'),
    { lastRow: rows[3] },
  );
  const isIdentity = rows.every((r, i) =>
    r.every((v, j) => Math.abs(v - (i === j ? 1 : 0)) < RIGID_TOL),
  );
  if (fg.role === 'primary') {
    require_(isIdentity, 'F5', t('primary 的 transformToPrimary 恆為單位矩陣，且不得被使用者調整'));
    require_(fg.transformKind === 'identity', 'F5', t('primary 的 transformKind 必須是 identity'));
  }
  if (fg.transformKind === 'identity') {
    require_(isIdentity, 'F6', t('transformKind=identity 與非單位矩陣矛盾'));
  }
  if (fg.transformKind === 'rigid') {
    const r = [rows[0]!.slice(0, 3), rows[1]!.slice(0, 3), rows[2]!.slice(0, 3)].flat();
    const rtr = mul3(transpose3(r), r);
    require_(
      rtr.every((v, i) => Math.abs(v - (i % 4 === 0 ? 1 : 0)) < RIGID_TOL),
      'F7',
      t('transformKind=rigid 的旋轉部分必須正交（不得含縮放或剪切）'),
    );
  }
  if (fg.transformKind === 'resampled') {
    require_(isIdentity, 'F8', t('transformKind=resampled 時矩陣應為單位（資料已在 primary 網格上）'));
    require_(
      typeof fg.coverageMaskId === 'string' && fg.coverageMaskId.length > 0,
      'F9',
      t('transformKind=resampled 必須提供 coverageMaskId——否則重採樣後的空白區域看起來像解剖結構'),
    );
  }
  return fg;
}

export function primaryFrameGroupOf(frameOfReferenceUid: string, seriesId: string): FrameGroup {
  return createFrameGroup({
    frameOfReferenceUid,
    seriesId,
    role: 'primary',
    transformToPrimary: IDENTITY_16,
    transformKind: 'identity',
    coverageMaskId: null,
  });
}

/** 本序列自身的世界座標 → primary 世界座標。 */
export function toPrimaryWorld(fg: FrameGroup, world: Vec3): [number, number, number] {
  return applyMat4(mat16ColumnMajorToRows(fg.transformToPrimary), world);
}

/**
 * primary 世界座標 → 本序列自身的世界座標。
 *
 * 🔴 座標轉換鏈的**第二段**。只有在編輯非 primary 序列的結構時才
 * 會非單位矩陣；漏了的症狀是「在融合畫面上對第二組影像的結構下筆，筆刷落在
 * 偏移的位置」。
 */
export function fromPrimaryWorld(fg: FrameGroup, world: Vec3): [number, number, number] {
  return applyMat4(inverseMat4(mat16ColumnMajorToRows(fg.transformToPrimary)), world);
}

/**
 * 跨 FrameGroup 的游標換算（相機同步）。
 *
 * > 所有 actor 都以 `userMatrix` 進到
 * > primary 世界座標，因此**跨 viewport 同步一律以 primary 世界座標為準，
 * > 不需要再換算**。只有把世界座標轉回某序列自身索引時才套逆變換
 * > （就是 `fromPrimaryWorld`）。若「同步時再套一次 transformToPrimary」，
 * > 等於**套兩次變換**。
 */
export function syncCursorAcrossViewports(primaryWorld: Vec3): [number, number, number] {
  return [primaryWorld[0], primaryWorld[1], primaryWorld[2]];
}
