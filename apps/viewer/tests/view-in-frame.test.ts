/**
 * `viewInFrame`：primary 世界座標的視平面搬進次要 FoR。
 *
 * 這是多序列同空間顯示的唯一幾何機制（CPU 路徑上的等價做法：不動體素、
 * 動平面）。錯了的症狀是「CBCT 疊在錯的位置，但它自己看起來正常」。
 */

import { describe, expect, it } from 'vitest';

import {
  createFrameGroup,
  createViewReference,
  isIdentityTransform,
  primaryFrameGroupOf,
  rowsToMat16ColumnMajor,
  toPrimaryWorld,
  viewInFrame,
  type FrameGroup,
  type ViewReference,
} from '../src/core/geometry';

const view: ViewReference = createViewReference({
  frameOfReferenceUid: 'for.primary',
  displayGridId: 'dg',
  planeOrigin: [10, -20, 30],
  viewPlaneNormal: [0, 0, -1],
  viewUp: [0, -1, 0],
  slabThicknessMm: 3,
  temporalGroupId: null,
  frameIndex: null,
});

/** row-major 4×4：繞 z 旋轉 `deg` ＋ 平移。 */
function rigidRows(deg: number, t: [number, number, number]): number[][] {
  const a = (deg * Math.PI) / 180;
  return [
    [Math.cos(a), -Math.sin(a), 0, t[0]],
    [Math.sin(a), Math.cos(a), 0, t[1]],
    [0, 0, 1, t[2]],
    [0, 0, 0, 1],
  ];
}

function secondary(deg: number, t: [number, number, number]): FrameGroup {
  return createFrameGroup({
    frameOfReferenceUid: 'for.secondary',
    seriesId: 'cbct',
    role: 'secondary',
    transformToPrimary: rowsToMat16ColumnMajor(rigidRows(deg, t)),
    transformKind: 'rigid',
    coverageMaskId: null,
  });
}

describe('viewInFrame', () => {
  it('primary／單位矩陣／null：回**同一個物件**（零成本，呼叫端可用 === 判斷）', () => {
    expect(viewInFrame(view, null)).toBe(view);
    expect(viewInFrame(view, undefined)).toBe(view);
    expect(viewInFrame(view, primaryFrameGroupOf('for.primary', 's1'))).toBe(view);
    expect(isIdentityTransform(secondary(0, [0, 0, 0]))).toBe(true);
  });

  it('純平移：origin 反向平移，方向向量不動，FoR 換成次要的', () => {
    const fg = secondary(0, [-15.3, -178.6, -31.4]);
    const moved = viewInFrame(view, fg);
    expect(moved).not.toBe(view);
    expect(moved.frameOfReferenceUid).toBe('for.secondary');
    expect(moved.planeOrigin.map((v) => +v.toFixed(6))).toEqual([25.3, 158.6, 61.4]);
    expect(moved.viewPlaneNormal).toEqual([0, 0, -1]);
    expect(moved.viewUp).toEqual([0, -1, 0]);
    // 不相關的欄位原樣保留
    expect(moved.slabThicknessMm).toBe(3);
    expect(moved.displayGridId).toBe('dg');
  });

  it('含旋轉：搬過去的 origin 用 toPrimaryWorld 回得來，法線與 viewUp 仍單位且正交', () => {
    const fg = secondary(5, [5, -8, 3]);
    const moved = viewInFrame(view, fg);
    const back = toPrimaryWorld(fg, moved.planeOrigin);
    expect(back.map((v) => +v.toFixed(9))).toEqual([10, -20, 30]);
    const n = moved.viewPlaneNormal;
    const u = moved.viewUp;
    expect(Math.hypot(n[0], n[1], n[2])).toBeCloseTo(1, 12);
    expect(Math.hypot(u[0], u[1], u[2])).toBeCloseTo(1, 12);
    expect(n[0] * u[0] + n[1] * u[1] + n[2] * u[2]).toBeCloseTo(0, 12);
    // 繞 z 旋轉不改軸向法線；viewUp 走**逆**旋轉：R(−5°)·(0,−1,0) = (−sin5°, −cos5°, 0)
    expect(n).toEqual([0, 0, -1]);
    expect(u[1]).toBeCloseTo(-Math.cos((5 * Math.PI) / 180), 12);
    expect(u[0]).toBeCloseTo(-Math.sin((5 * Math.PI) / 180), 12);
  });

  it('🔴 平面上的任一點：primary 座標 → 搬過去的平面上同一個相對位置', () => {
    // 若只搬 origin 不轉方向向量，這條會在有旋轉時 fail
    const fg = secondary(5, [5, -8, 3]);
    const moved = viewInFrame(view, fg);
    const right = (v: ViewReference): [number, number, number] => [
      v.viewUp[1] * v.viewPlaneNormal[2] - v.viewUp[2] * v.viewPlaneNormal[1],
      v.viewUp[2] * v.viewPlaneNormal[0] - v.viewUp[0] * v.viewPlaneNormal[2],
      v.viewUp[0] * v.viewPlaneNormal[1] - v.viewUp[1] * v.viewPlaneNormal[0],
    ];
    const du = 12.5;
    const dv = -7.25;
    const r0 = right(view);
    const pPrimary: [number, number, number] = [
      view.planeOrigin[0] + r0[0] * du + view.viewUp[0] * dv,
      view.planeOrigin[1] + r0[1] * du + view.viewUp[1] * dv,
      view.planeOrigin[2] + r0[2] * du + view.viewUp[2] * dv,
    ];
    const r1 = right(moved);
    const pSecondary: [number, number, number] = [
      moved.planeOrigin[0] + r1[0] * du + moved.viewUp[0] * dv,
      moved.planeOrigin[1] + r1[1] * du + moved.viewUp[1] * dv,
      moved.planeOrigin[2] + r1[2] * du + moved.viewUp[2] * dv,
    ];
    expect(toPrimaryWorld(fg, pSecondary).map((v) => +v.toFixed(9))).toEqual(pPrimary.map((v) => +v.toFixed(9)));
  });
});
