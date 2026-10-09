/**
 * 把「primary 世界座標的視平面」搬進某個 FrameGroup 自己的 FoR。
 *
 * ## 這是多序列同空間顯示的**唯一**幾何機制
 *
 * 剛性對齊走前端 `userMatrix`；CPU 路徑沒有 actor，但等價的做法更便宜：
 * **不動體素，動平面**。renderer 拿到的 `ctx.camera` 是 primary 世界座標；對一個
 * 次要 FoR 的物件（CBCT、它的劑量、它的結構）重切前，把平面的 origin／normal／
 * viewUp 用 `transformToPrimary` 的**逆變換**搬到該物件自己的 FoR，再對它自己的
 * 網格重切。剛性下這在數學上精確、零重採樣、不改 WASM ABI。
 *
 * 影像、輪廓、劑量三個 renderer 都經這一個函式 —— 因此「變換套用於整個
 * FrameGroup」是結構性保證：**拿掉對位時三者一起跳回，不可能只動影像不動輪廓。**
 *
 * `probe.ts`（讀數）與 `edit/brush.ts`（筆刷）早就各自呼叫 `fromPrimaryWorld`；
 * 它們處理的是**點**，這裡處理的是**平面**（多了兩個方向向量的旋轉）。
 */

import type { FrameGroup } from './frameGroup';
import { applyMat4, inverseMat4, mat16ColumnMajorToRows, normalize3, type Vec3 } from './lps';
import type { ViewReference } from './viewReference';

const IDENTITY_TOL = 1e-12;

/** 單位矩陣就不必算（單序列與 primary 走這條，零成本）。 */
export function isIdentityTransform(fg: FrameGroup | null | undefined): boolean {
  if (fg === null || fg === undefined) return true;
  if (fg.transformKind === 'identity') return true;
  const m = fg.transformToPrimary;
  for (let i = 0; i < 16; i += 1) {
    const expected = i % 5 === 0 ? 1 : 0;
    if (Math.abs(m[i]! - expected) > IDENTITY_TOL) return false;
  }
  return true;
}

/**
 * primary 世界座標的視平面 → `fg` 自己的 FoR 裡的同一個平面。
 *
 * * `planeOrigin` 走完整的逆仿射（含平移）
 * * `viewPlaneNormal`／`viewUp` 只走逆旋轉（方向向量，不平移）
 * * `frameOfReferenceUid` 換成 `fg` 的；其餘欄位（slab、相位、displayGridId）不動
 *
 * `fg` 為 null／undefined／單位矩陣時回傳**同一個物件**（呼叫端可以用 `===` 判斷
 * 有沒有變換）。
 */
export function viewInFrame(view: ViewReference, fg: FrameGroup | null | undefined): ViewReference {
  if (isIdentityTransform(fg)) return view;
  const rows = mat16ColumnMajorToRows(fg!.transformToPrimary);
  const inv = inverseMat4(rows);
  const origin = applyMat4(inv, view.planeOrigin);
  const normal = normalize3(rotateOnly(inv, view.viewPlaneNormal));
  const up = normalize3(rotateOnly(inv, view.viewUp));
  return {
    ...view,
    frameOfReferenceUid: fg!.frameOfReferenceUid,
    planeOrigin: origin,
    viewPlaneNormal: normal,
    viewUp: up,
  };
}

/** 只套 4×4 的旋轉部分（方向向量不平移）。 */
function rotateOnly(rows: number[][], v: Vec3): [number, number, number] {
  return [
    rows[0]![0]! * v[0] + rows[0]![1]! * v[1] + rows[0]![2]! * v[2],
    rows[1]![0]! * v[0] + rows[1]![1]! * v[1] + rows[1]![2]! * v[2],
    rows[2]![0]! * v[0] + rows[2]![1]! * v[1] + rows[2]![2]! * v[2],
  ];
}
