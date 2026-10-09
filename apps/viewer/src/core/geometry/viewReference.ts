/**
 * `ViewReference` —— 平面的完整描述。
 *
 * 🔴 **任何編輯紀錄、書籤、量測都必須存 `ViewReference`，不得存 slice index。**
 * 斜面沒有 slice index；這一條同時是斜面功能的需求與法規追溯的前置。
 */

import { require_ } from './errors';
import { cross3, dot3, norm3, type Vec3 } from './lps';
import { t } from '../i18n';

export interface ViewReference {
  readonly frameOfReferenceUid: string;
  readonly displayGridId: string;
  /** LPS mm，**平面中心**。 */
  readonly planeOrigin: Vec3;
  readonly viewPlaneNormal: Vec3;
  readonly viewUp: Vec3;
  readonly slabThicknessMm: number;
  /** 靜態物件為 null。**兩者必須同時有或同時無。** */
  readonly temporalGroupId: string | null;
  readonly frameIndex: number | null;
}

export function createViewReference(v: ViewReference): ViewReference {
  require_(v.frameOfReferenceUid.length > 0, 'V1', t('frameOfReferenceUid 必填'));
  require_(Math.abs(norm3(v.viewPlaneNormal) - 1) <= 1e-4, 'V2', t('viewPlaneNormal 必須是單位向量'), {
    norm: norm3(v.viewPlaneNormal),
  });
  require_(Math.abs(norm3(v.viewUp) - 1) <= 1e-4, 'V2', t('viewUp 必須是單位向量'), {
    norm: norm3(v.viewUp),
  });
  require_(
    Math.abs(dot3(v.viewPlaneNormal, v.viewUp)) <= 1e-4,
    'V3',
    t('viewUp 必須與 viewPlaneNormal 正交'),
    { dot: dot3(v.viewPlaneNormal, v.viewUp) },
  );
  require_(v.slabThicknessMm >= 0, 'V4', t('slabThicknessMm 不得為負'));
  require_(
    (v.temporalGroupId === null) === (v.frameIndex === null),
    'V5',
    t('temporalGroupId 與 frameIndex 必須同時有或同時無'),
    { temporalGroupId: v.temporalGroupId, frameIndex: v.frameIndex },
  );
  return v;
}

/** 平面上的橫軸。右手系：`right = up × normal`。 */
export function planeRight(v: ViewReference): [number, number, number] {
  return cross3(v.viewUp, v.viewPlaneNormal);
}

/**
 * **輸出列增加的方向** = `-viewUp`。
 *
 * 🔴 `viewUp` 是螢幕上的「上」，而影像第 0 列在畫面**頂端**。寫錯的症狀是
 * 上下顛倒，而在對稱假體上完全看不出來——因此這個轉換集中在這一個函式，
 * 且 Python（`kernel.plane_desc`）與 Rust（`PlaneDesc.up`）都採同一慣例。
 */
export function planeRowDirection(v: ViewReference): [number, number, number] {
  return [-v.viewUp[0], -v.viewUp[1], -v.viewUp[2]];
}

export function signedDistance(v: ViewReference, world: Vec3): number {
  return dot3(
    [world[0] - v.planeOrigin[0], world[1] - v.planeOrigin[1], world[2] - v.planeOrigin[2]],
    v.viewPlaneNormal,
  );
}

/** **編輯只允許在共面時進行。** */
export function isCoplanarWith(
  a: ViewReference,
  b: ViewReference,
  { angleTolDeg = 1, offsetTolMm = 0.5 } = {},
): boolean {
  const cos = Math.abs(dot3(a.viewPlaneNormal, b.viewPlaneNormal));
  if (cos < Math.cos((angleTolDeg * Math.PI) / 180)) return false;
  return Math.abs(signedDistance(a, b.planeOrigin)) <= offsetTolMm;
}

/**
 * 顯示規則：目前視圖與量測平面的關係。
 *
 * `coplanar` 完整顯示並可編輯；`parallel` 淡色不可編輯；`intersecting` **只顯示
 * 交線**（這是 MR-Linac cine 用得到的那一條，因此**不是選配**）；
 * `disjoint` 不顯示。
 */
export type PlaneRelation = 'coplanar' | 'parallel' | 'intersecting' | 'disjoint';

export function planeRelation(
  view: ViewReference,
  target: ViewReference,
  { angleTolDeg = 1, offsetTolMm = 0.5, extentMm = 500 } = {},
): PlaneRelation {
  const cos = Math.abs(dot3(view.viewPlaneNormal, target.viewPlaneNormal));
  const parallel = cos >= Math.cos((angleTolDeg * Math.PI) / 180);
  const offset = Math.abs(signedDistance(view, target.planeOrigin));
  if (parallel) return offset <= offsetTolMm ? 'coplanar' : 'parallel';
  return offset <= extentMm ? 'intersecting' : 'disjoint';
}

/**
 * 放射科慣例的軸向平面：**從病人腳側往頭看**。
 *
 * 因此 `viewPlaneNormal = -z`（法線指向觀察者，觀察者在下方 ＝ I 方向）、
 * `viewUp = -y`（畫面上 ＝ A）。由此得到的 `planeRight = +x` ＝ 病人左落在
 * 畫面右，也就是**病人右在畫面左**。
 *
 * 🔴 先前寫的是 `+z`（從頭頂往下看），左右整格鏡像；理由與證據見
 * `core/scene/cameras.ts` 的 `ORIENTATIONS`。這裡與那裡**必須一致**，
 * 因為兩者都會被拿來建 axial 相機。
 */
export function axialViewReference(args: {
  frameOfReferenceUid: string;
  displayGridId: string;
  planeOrigin: Vec3;
  slabThicknessMm?: number;
  temporalGroupId?: string | null;
  frameIndex?: number | null;
}): ViewReference {
  return createViewReference({
    frameOfReferenceUid: args.frameOfReferenceUid,
    displayGridId: args.displayGridId,
    planeOrigin: args.planeOrigin,
    viewPlaneNormal: [0, 0, -1],
    viewUp: [0, -1, 0],
    slabThicknessMm: args.slabThicknessMm ?? 0,
    temporalGroupId: args.temporalGroupId ?? null,
    frameIndex: args.frameIndex ?? null,
  });
}
