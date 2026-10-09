/**
 * 切片捲軸（2026-09-29）：`sliceRange`／`cameraAtSlice`（core/scene/cameras.ts）與捲軸的純換算（sliceBarModel.ts）。
 */

import { describe, expect, it } from 'vitest';

import { cameraAtSlice, displaySliceIndex, gridCenterWorld, orthoCamera, rotateInPlane, sliceRange, stepAlongNormal } from '../src/core';
import type { Grid } from '../src/core';
import { fractionOf, indexAtY, THUMB_PX, wheelSteps } from '../src/react/components/sliceBarModel';

const grid: Grid = { size: [40, 50, 187], spacing: [1, 1, 3], origin: [-20, -25, -100], direction: [1, 0, 0, 0, 1, 0, 0, 0, 1], frameOfReferenceUid: 'f' };
const cam = (orientation: 'axial' | 'coronal' | 'sagittal') => orthoCamera({ grid, orientation, displayGridId: 'dg', planeOrigin: gridCenterWorld(grid) });

describe('sliceRange／cameraAtSlice', () => {
  it('正交時張數就是那一軸的張數', () => {
    expect(sliceRange(grid, cam('axial')).count).toBe(187);
    expect(sliceRange(grid, cam('coronal')).count).toBe(50);
    expect(sliceRange(grid, cam('sagittal')).count).toBe(40);
  });

  it('跟滾輪同方向：沿 +法線一步 ＝ 捲軸 index 加一', () => {
    for (const o of ['axial', 'coronal', 'sagittal'] as const) {
      const v = cam(o);
      expect(sliceRange(grid, stepAlongNormal(grid, v, 1)).index - sliceRange(grid, v).index, o).toBe(1);
    }
  });

  it('軸向：捲軸頂端（index 0）是頭側（z 最大）、底端是腳側', () => {
    const top = cameraAtSlice(grid, cam('axial'), 0);
    const bottom = cameraAtSlice(grid, cam('axial'), 186);
    expect(top.planeOrigin[2]).toBeCloseTo(-100 + 186 * 3, 6);
    expect(bottom.planeOrigin[2]).toBeCloseTo(-100, 6);
    // 顯示用的切片序號（1-based 的 label 用它）：頭側是最後一張
    expect(displaySliceIndex(grid, top)).toBe(186);
  });

  it('跳到第 i 張後 sliceRange 回報的就是 i；平面內位置（十字線另外兩軸）不動', () => {
    const v = cam('axial');
    for (const i of [0, 1, 93, 185, 186]) {
      const moved = cameraAtSlice(grid, v, i);
      expect(sliceRange(grid, moved).index).toBe(i);
      expect(moved.planeOrigin[0]).toBeCloseTo(v.planeOrigin[0], 9);
      expect(moved.planeOrigin[1]).toBeCloseTo(v.planeOrigin[1], 9);
    }
  });

  it('超出範圍夾在兩端', () => {
    const v = cam('coronal');
    expect(sliceRange(grid, cameraAtSlice(grid, v, -5)).index).toBe(0);
    expect(sliceRange(grid, cameraAtSlice(grid, v, 999)).index).toBe(49);
  });

  it('斜面也有範圍，而且一樣跳得到', () => {
    const oblique = rotateInPlane(cam('axial'), 'right', 25);
    const r = sliceRange(grid, oblique);
    expect(r.count).toBeGreaterThan(1);
    const moved = cameraAtSlice(grid, oblique, 10);
    expect(sliceRange(grid, moved).index).toBe(10);
    // 法線不變（只沿法線移）
    expect(moved.viewPlaneNormal).toEqual(oblique.viewPlaneNormal);
  });
});

describe('捲軸換算', () => {
  it('位置 ↔ 張數互為反函數（拇指中心對準游標）', () => {
    const track = 400;
    const count = 187;
    for (const i of [0, 1, 50, 186]) {
      const y = THUMB_PX / 2 + fractionOf(i, count) * (track - THUMB_PX);
      expect(indexAtY(y, track, count)).toBe(i);
    }
  });

  it('點到軌道外夾在兩端；只有一張時永遠是 0', () => {
    expect(indexAtY(-50, 300, 100)).toBe(0);
    expect(indexAtY(999, 300, 100)).toBe(99);
    expect(indexAtY(120, 300, 1)).toBe(0);
    expect(fractionOf(0, 1)).toBe(0);
  });

  it('滾輪一格一張，大的 delta 多張（與 viewport 上的滾輪同規則）', () => {
    expect(wheelSteps(100)).toBe(1);
    expect(wheelSteps(-3)).toBe(-1);
    expect(wheelSteps(300)).toBe(3);
    expect(wheelSteps(0)).toBe(0);
  });
});
