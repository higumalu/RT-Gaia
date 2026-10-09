/**
 * 第九／十批 —— 3D 出圖模組：相機（軌道／推進／平移／wire）、TF（取值／Shift／點操作／預設集／序列化）、
 * 送後端的圖層、裁切、輸出尺寸、註冊。
 */

import { beforeEach, describe, expect, it } from 'vitest';

import { clearModules, clearPanels, listModules, listPanels, primaryFrameGroupOf, type FrameGroup, type Layer } from '../src/core';
import {
  addColorPoint,
  addOpacityPoint,
  anglesOf,
  cameraToWire,
  clampCrop,
  clampWindow,
  cropCenter,
  cropCorners,
  defaultCamera,
  distanceOf,
  dolly,
  dollyByWheel,
  evalColor,
  evalOpacity,
  fitDistance,
  isFullCrop,
  doseTransferFunction,
  DOSE_3D_OPACITY_CURVE,
  exportFileName,
  exportSize,
  isValidCamera,
  orbit,
  outputSize,
  pan,
  parseTf,
  presetIdForWindow,
  presetIdOf,
  presetTf,
  registerRender3dModule,
  removeOpacityPoint,
  render3dLayers,
  resetRender3dModuleRegistration,
  serializeTf,
  shrinkAxis,
  TF_PRESETS,
  tfToWire,
  type TransferFunction,
  windowOf,
  withOpacityPoint,
} from '../src/react/modules/render3d';
import { registerCoreUi, resetCoreUiRegistration } from '../src/react/panels/builtins';

const near = (a: readonly number[], b: readonly number[], tol = 1e-6) => a.every((v, i) => Math.abs(v - b[i]!) < tol);
const bounds = { min: [-100, -100, -50] as [number, number, number], max: [100, 100, 50] as [number, number, number] };

describe('相機（camera3d）', () => {
  it('預設：從前方看（相機在 −y）、焦點＝中心、距離＝對角線×1.2、上＝S；wire 的法線指向觀察者', () => {
    const cam = defaultCamera(bounds);
    expect(cam.focalPoint).toEqual([0, 0, 0]);
    expect(cam.position[1]).toBeLessThan(0);
    expect(distanceOf(cam)).toBeCloseTo(Math.hypot(200, 200, 100) * 1.2);
    const w = cameraToWire(cam, 'f', 'dg');
    expect(near(w['view_plane_normal'] as number[], [0, -1, 0])).toBe(true);
    expect(near(w['view_up'] as number[], [0, 0, 1])).toBe(true);
    expect(w['plane_origin']).toEqual([0, 0, 0]);
    expect(w['distance_mm']).toBeCloseTo(distanceOf(cam));
    expect(anglesOf(cam)).toEqual({ azimuthDeg: 0, elevationDeg: 0 });
    expect(isValidCamera(cam)).toBe(true);
    expect(isValidCamera({ position: [0, 0] })).toBe(false);
  });

  it('軌道：距離不變、up 與視線保持垂直；水平拖 90° 到病人左側', () => {
    const cam = defaultCamera(bounds);
    const d = distanceOf(cam);
    const turned = orbit(cam, -225, 0); // 0.4°/px → 90°
    expect(distanceOf(turned)).toBeCloseTo(d);
    const w = cameraToWire(turned, 'f', 'dg');
    expect(near(w['view_plane_normal'] as number[], [1, 0, 0], 1e-6)).toBe(true);
    expect(Math.abs((w['view_plane_normal'] as number[]).reduce((s, v, i) => s + v * (w['view_up'] as number[])[i]!, 0))).toBeLessThan(1e-9);
    const tilted = orbit(cam, 0, 100);
    expect(anglesOf(tilted).elevationDeg).toBeCloseTo(40, 0);
    expect(distanceOf(tilted)).toBeCloseTo(d);
  });

  it('推進：滾輪往上靠近；距離夾在 10–20000 mm；平移：焦點與相機一起動、方向不變', () => {
    const cam = defaultCamera(bounds);
    const d = distanceOf(cam);
    expect(distanceOf(dollyByWheel(cam, -100))).toBeLessThan(d);
    expect(distanceOf(dolly(cam, 1e-9))).toBe(10);
    expect(distanceOf(dolly(cam, 1e9))).toBe(20000);
    const moved = pan(cam, 100, 0, 400);
    expect(near([moved.position[0] - cam.position[0], moved.position[1] - cam.position[1], moved.position[2] - cam.position[2]], [moved.focalPoint[0], moved.focalPoint[1], moved.focalPoint[2]])).toBe(true);
    expect(moved.focalPoint[0]).toBeLessThan(0); // 往右拖 → 相機往左
    expect(distanceOf(moved)).toBeCloseTo(d);
    const fit = fitDistance(dolly(cam, 3), bounds);
    expect(distanceOf(fit)).toBeCloseTo(d);
  });
});

describe('Transfer function', () => {
  const tf = presetTf('ct-bone');
  it('預設集 x 單調、取值在端點外取端點、Shift 沿 x 平移', () => {
    for (const p of TF_PRESETS) {
      const xs = p.tf.opacity.map((q) => q.x);
      expect(xs).toEqual([...xs].sort((a, b) => a - b));
      expect(p.tf.color.length).toBeGreaterThanOrEqual(2);
    }
    expect(evalOpacity(tf, -5000)).toBe(tf.opacity[0]!.a);
    expect(evalOpacity(tf, 9000)).toBe(tf.opacity[tf.opacity.length - 1]!.a);
    expect(evalOpacity(tf, 450)).toBeGreaterThan(evalOpacity(tf, 300));
    const shifted = { ...tf, shift: 100 };
    expect(evalOpacity(shifted, 550)).toBeCloseTo(evalOpacity(tf, 450));
    expect(evalColor(tf, 3000)).toEqual([1, 1, 1]);
    expect(presetIdOf(tf)).toBe('ct-bone');
    expect(presetIdOf({ ...tf, opacity: [{ x: 0, a: 0 }, { x: 1, a: 1 }] })).toBe('custom');
  });

  it('點操作：加點排序、移點夾 α、至少留兩點；wire 帶 shift 且四位小數', () => {
    const added = addOpacityPoint(tf, { x: 250, a: 1.7 });
    expect(added.opacity.map((p) => p.x)).toEqual([...added.opacity.map((p) => p.x)].sort((a, b) => a - b));
    expect(added.opacity.find((p) => p.x === 250)!.a).toBe(1);
    const moved = withOpacityPoint(tf, 0, { x: 5000, a: 0.5 });
    expect(moved.opacity[moved.opacity.length - 1]!.x).toBe(5000);
    let two: TransferFunction = { ...tf, opacity: [{ x: 0, a: 0 }, { x: 1, a: 1 }] };
    two = removeOpacityPoint(two, 0);
    expect(two.opacity).toHaveLength(2);
    const withColor = addColorPoint(tf, 650);
    expect(withColor.color.some((p) => p.x === 650)).toBe(true);
    const w = tfToWire({ ...tf, shift: 50 });
    expect(w.scalar_opacity[0]![0]).toBe(tf.opacity[0]!.x + 50);
    expect(w.scalar_color[0]).toHaveLength(4);
    expect(w.shade).toBe(true);
  });

  it('序列化 round-trip；壞值回 null', () => {
    expect(parseTf(serializeTf(tf))).toEqual(tf);
    expect(parseTf('nope')).toBeNull();
    expect(parseTf(JSON.stringify({ opacity: [{ x: 0, a: 0 }], color: [] }))).toBeNull();
    expect(parseTf(JSON.stringify({ opacity: [{ x: 0, a: 0 }, { x: 1, a: 1 }], color: [{ x: 0, r: 0, g: 0, b: 0 }, { x: 1, r: 1, g: 1, b: 1 }] }))!.shade).toBe(true);
  });
});

describe('圖層與尺寸', () => {
  const primary: FrameGroup = primaryFrameGroupOf('for.a', 'ct');
  const L = (kind: string, uid: string, visible: boolean, extra: Partial<Layer> = {}): Layer =>
    ({ layerId: `${kind}:${uid}:${Math.random()}`, kind, label: kind, groupId: null, frameOfReferenceUid: uid, contentRef: `${kind}-${uid}`, visible, opacity: 1, order: 0, ...extra });
  const layers = [L('image', 'for.a', true), L('image', 'for.b', true), L('mask', 'for.a', true, { color: [255, 0, 128] }), L('mask', 'for.a', false), L('dose', 'for.a', true), L('mask', 'for.b', true)];
  const tf = presetTf('ct-bone');

  it('composite：所有 FoR 的可見影像／結構／劑量都送、影像帶 TF；mip：只送 primary、影像帶 window、不送劑量', () => {
    const comp = render3dLayers(layers, primary, { technique: 'composite', window: { center: 40, width: 400 }, tf });
    expect(comp.map((l) => l['renderer'])).toEqual(['volume-3d', 'volume-3d', 'mesh', 'dose-3d', 'mesh']);
    expect(comp[3]!['series_id']).toBe('dose-for.a');
    expect(Array.isArray(comp[0]!['scalar_opacity'])).toBe(true);
    expect(comp[2]!['color']).toEqual([1, 0, 128 / 255]);
    const mip = render3dLayers(layers, primary, { technique: 'mip', window: { center: 40, width: 400 }, tf });
    expect(mip.map((l) => l['renderer'])).toEqual(['volume-3d', 'mesh']);
    expect(mip[0]!['window']).toEqual({ center: 40, width: 400 });
    expect(render3dLayers(layers, null, { technique: 'composite', window: { center: 0, width: 1 }, tf })).toEqual([]);
  });

  it('劑量 TF：與 2D 同一套（0～色階上限對應 LUT、閾值以下透明）、Gy 為軸、不打光', () => {
    const dose = L('dose', 'for.a', true, { params: { max_gy: 50, threshold_gy: 10, colormap: 'jet' } });
    const t = doseTransferFunction(dose);
    expect(t.shade).toBe(false);
    // 閾值 10、上限 50：曲線的位置換成 Gy；閾值處全透明、上限最不透明、單調遞增
    expect(t.scalar_opacity).toEqual(DOSE_3D_OPACITY_CURVE.map(([f, a]) => [10 + 40 * f, a]));
    expect(t.scalar_opacity[0]).toEqual([10, 0]);
    expect(t.scalar_opacity.map(([, a]) => a)).toEqual([...t.scalar_opacity.map(([, a]) => a)].sort((a, b) => a - b));
    expect(t.scalar_color[0]![0]).toBe(10);
    expect(t.scalar_color.at(-1)![0]).toBe(50);
    // jet：高劑量偏紅、低劑量偏藍
    const [, rHi, , bHi] = t.scalar_color.at(-1)!;
    const [, rLo, , bLo] = t.scalar_color[0]!;
    expect(rHi).toBeGreaterThan(bHi);
    expect(bLo).toBeGreaterThan(rLo);
    // 閾值 ≥ 上限（設錯）→ 夾在上限下方，點仍然遞增
    const bad = doseTransferFunction(L('dose', 'for.a', true, { params: { max_gy: 20, threshold_gy: 30 } }));
    const xs = bad.scalar_opacity.map(([x]) => x);
    expect([...xs].sort((a, b) => a - b)).toEqual(xs);
    expect(xs.at(-1)).toBe(20);
  });

  it('匯出 PNG：邊長依圖層數縮到預算內、至少 512；檔名帶本地時間', () => {
    expect(exportSize(1)).toBe(1536);
    expect(exportSize(35)).toBe(Math.floor(Math.sqrt(64_000_000 / 35)));
    expect(exportSize(10_000)).toBe(512);
    expect(exportFileName(new Date(2026, 8, 24, 9, 5))).toBe('rtgaia-3d-20260924-0905.png');
  });

  it('MIP 視窗：預設集／自訂／夾限；輸出尺寸', () => {
    expect(windowOf(undefined)).toEqual({ center: 400, width: 1800 });
    expect(presetIdForWindow({ center: 40, width: 400 })).toBe('ct_soft');
    expect(clampWindow({ center: -5000, width: 0 })).toEqual({ center: -1000, width: 1 });
    expect(outputSize(800, 600, true)).toEqual([224, 224]);
    expect(outputSize(900, 900, false)).toEqual([768, 768]);
    expect(outputSize(10, 10, false)).toEqual([64, 64]);
  });
});

describe('裁切方框（Slicer Crop）', () => {
  it('夾限、縮軸、中心與角、全範圖判定', () => {
    expect(clampCrop({ min: [-500, 0, 0], max: [500, 10, 10] }, bounds)).toEqual({ min: [-100, 0, 0], max: [100, 10, 10] });
    const half = shrinkAxis(bounds, 2, 0.5);
    expect(half).toEqual({ min: [-100, -100, -25], max: [100, 100, 25] });
    expect(cropCenter(half)).toEqual([0, 0, 0]);
    expect(cropCorners(half)).toHaveLength(8);
    expect(isFullCrop(bounds, bounds)).toBe(true);
    expect(isFullCrop(half, bounds)).toBe(false);
  });
});

describe('模組', () => {
  beforeEach(() => {
    clearPanels();
    clearModules();
    resetCoreUiRegistration();
    resetRender3dModuleRegistration();
    registerCoreUi();
    registerRender3dModule();
  });
  it('registerModule 0.3.0；viewport-overlay、toolbar、right-sidebar 三個面板；冪等', () => {
    expect(listModules().find((m) => m.id === 'rt-gaia-render3d')?.version).toBe('0.3.0');
    expect(listPanels('viewport-overlay').map((p) => p.id)).toContain('render3d.view');
    expect(listPanels('toolbar').map((p) => p.id)).toContain('render3d.toggle');
    expect(listPanels('right-sidebar').map((p) => p.id)).toContain('render3d.settings');
    expect(() => registerRender3dModule()).not.toThrow();
  });
});

describe('反向 pick：畫面點 → 影像像素（object-fit: contain）', () => {
  it('等比縮放置中；黑邊回 null', async () => {
    const { imagePixelAt } = await import('../src/react/modules/render3d/model');
    // 400×300 的框放 200×200 的圖：縮放 1.5、左右各 50 px 黑邊
    const rect = { left: 0, top: 0, width: 400, height: 300 };
    expect(imagePixelAt(200, 150, rect, [200, 200])).toEqual([100, 100]);
    expect(imagePixelAt(50, 0, rect, [200, 200])).toEqual([0, 0]);
    expect(imagePixelAt(20, 150, rect, [200, 200])).toBeNull();
    expect(imagePixelAt(349.9, 299.9, rect, [200, 200])).toEqual([199, 199]);
    expect(imagePixelAt(10, 10, { left: 0, top: 0, width: 0, height: 0 }, [200, 200])).toBeNull();
  });
});
