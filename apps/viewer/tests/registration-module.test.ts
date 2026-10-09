/**
 * 對位微調：剛性矩陣工具函式、模組註冊／可見性、拖曳工具的平移換算。
 */

import { beforeEach, describe, expect, it } from 'vitest';

import {
  applyMat16,
  clearModules,
  clearPanels,
  clearTools,
  IDENTITY_MAT16,
  isSameMat16,
  listModules,
  listPanels,
  listTools,
  mat16Inverse,
  mat16Multiply,
  primaryFrameGroupOf,
  rigidDelta,
  rotateTransformAboutPivot,
  rotationMat16,
  translateTransform,
  translationMat16,
  type FrameGroup,
  type Mat16,
  type PanelVisibilityState,
  type ToolContext,
} from '../src/core';
import {
  draggedTransform,
  REGISTRATION_DRAG_TOOL,
  REGISTRATION_MODE,
  registerRegistrationModule,
  registrationTargetOf,
  resetRegistrationModuleRegistration,
} from '../src/react/modules/registration';
import { registerCoreUi, resetCoreUiRegistration } from '../src/react/panels/builtins';

const near = (a: readonly number[], b: readonly number[], tol = 1e-9) =>
  a.length === b.length && a.every((v, i) => Math.abs(v - b[i]!) < tol);

describe('剛性矩陣（column-major 進出）', () => {
  it('平移：點跟著走；乘法順序是 T·M（primary 空間裡的前乘）', () => {
    const m = translationMat16([1, 2, 3]);
    expect(applyMat16(m, [0, 0, 0])).toEqual([1, 2, 3]);
    const m2 = translateTransform(m, [10, 0, 0]);
    expect(applyMat16(m2, [0, 0, 0])).toEqual([11, 2, 3]);
  });

  it('旋轉：右手定則，繞 z 轉 90° 把 +x 轉到 +y（與後端 rigid_matrix 一致）', () => {
    const p = applyMat16(rotationMat16('z', 90), [1, 0, 0]);
    expect(near(p, [0, 1, 0])).toBe(true);
    expect(near(applyMat16(rotationMat16('x', 90), [0, 1, 0]), [0, 0, 1])).toBe(true);
    expect(near(applyMat16(rotationMat16('y', 90), [0, 0, 1]), [1, 0, 0])).toBe(true);
  });

  it('繞樞紐旋轉：樞紐不動', () => {
    const base = translationMat16([5, 0, 0]);
    const pivot = applyMat16(base, [10, 20, 30]); // 該點在 primary 的位置
    const m = rotateTransformAboutPivot(base, 'y', 37, pivot);
    expect(near(applyMat16(m, [10, 20, 30]), pivot, 1e-9)).toBe(true);
    // 其他點有動
    expect(near(applyMat16(m, [0, 0, 0]), applyMat16(base, [0, 0, 0]))).toBe(false);
  });

  it('反矩陣與乘法互為逆', () => {
    const m = mat16Multiply(rotationMat16('x', 20), translationMat16([1, -2, 3]));
    expect(near(mat16Multiply(m, mat16Inverse(m)), IDENTITY_MAT16, 1e-12)).toBe(true);
    expect(isSameMat16(m, m)).toBe(true);
    expect(isSameMat16(m, IDENTITY_MAT16)).toBe(false);
  });

  it('rigidDelta：相對參考的平移＝樞紐位移、Euler 角還原、總夾角', () => {
    const ref = translationMat16([5, 5, 5]);
    const pivotOwn = [10, 0, 0] as const;
    const moved = translateTransform(rotateTransformAboutPivot(ref, 'z', 10, applyMat16(ref, pivotOwn)), [2, 0, 0]);
    const d = rigidDelta(moved, ref, pivotOwn);
    expect(near(d.translationMm, [2, 0, 0], 1e-9)).toBe(true);
    expect(near(d.rotationDeg, [0, 0, 10], 1e-9)).toBe(true);
    expect(d.totalRotationDeg).toBeCloseTo(10, 9);
    const same = rigidDelta(ref, ref, pivotOwn);
    expect(same.translationMm).toEqual([0, 0, 0]);
    expect(same.rotationDeg).toEqual([0, 0, 0]);
  });
});

const state = (modes: string[], hasSecondarySeries = true): PanelVisibilityState => ({
  tier: 'C',
  selectedLayerIds: [],
  hasTemporalLayer: false,
  hasSecondarySeries,
  hasDoseLayer: false,
  layoutId: '2x2',
  modes,
});

describe('對位模組', () => {
  beforeEach(() => {
    clearPanels();
    clearModules();
    clearTools();
    resetCoreUiRegistration();
    resetRegistrationModuleRegistration();
    registerCoreUi();
    registerRegistrationModule();
  });

  it('以 registerModule 註冊；面板只在 registration 模式開著時出現；開關只在有次要序列時出現', () => {
    expect(listModules().find((m) => m.id === 'rt-gaia-registration')?.version).toBe('0.1.0');
    expect(listPanels('right-sidebar', state([])).map((p) => p.id)).toEqual([]);
    expect(listPanels('right-sidebar', state([REGISTRATION_MODE])).map((p) => p.id)).toEqual(['registration.panel']);
    expect(listPanels('toolbar', state([])).map((p) => p.id)).toContain('registration.toggle');
    expect(listPanels('toolbar', state([], false)).map((p) => p.id)).not.toContain('registration.toggle');
  });

  it('拖曳工具：註冊了、hidden（不上工具面板）、只在 2D 格；重複註冊冪等', () => {
    const tool = listTools().find((t) => t.id === REGISTRATION_DRAG_TOOL);
    expect(tool?.hidden).toBe(true);
    expect(tool?.appliesTo?.({ viewportId: 'v', is3D: true, width: 1, height: 1 })).toBe(false);
    expect(() => registerRegistrationModule()).not.toThrow();
    expect(listTools().filter((t) => t.id === REGISTRATION_DRAG_TOOL)).toHaveLength(1);
  });

  it('拖曳：起點到目前點的 primary 位移前乘到底矩陣；工具把它寫進 setFrameGroupTransform', () => {
    const base = translationMat16([1, 1, 1]);
    const m = draggedTransform(base, [0, 0, 0], [3, -4, 0]);
    expect(applyMat16(m, [0, 0, 0])).toEqual([4, -3, 1]);

    const secondary: FrameGroup = {
      frameOfReferenceUid: 'for.b',
      seriesId: 'cbct',
      role: 'secondary',
      transformToPrimary: base,
      transformKind: 'rigid',
      coverageMaskId: null,
    };
    const writes: [string, Mat16 | null][] = [];
    let pointer: [number, number, number] = [0, 0, 0];
    const ctx = {
      viewport: { viewportId: 'v', is3D: false, width: 10, height: 10 },
      canvasToWorld: () => pointer,
      frameGroup: (uid: string) => (uid === 'for.b' ? secondary : primaryFrameGroupOf(uid, 'ct')),
      setFrameGroupTransform: (uid: string, m16: Mat16 | null) => writes.push([uid, m16]),
      params: { registration: { frameOfReferenceUid: 'for.b' } },
    } as unknown as ToolContext;
    expect(registrationTargetOf(ctx.params)).toBe('for.b');
    const instance = listTools().find((t) => t.id === REGISTRATION_DRAG_TOOL)!.activate(ctx);
    instance.onPointerDown?.(0, 0);
    pointer = [2, 0, 0];
    instance.onPointerMove?.(1, 0);
    expect(writes).toHaveLength(1);
    expect(applyMat16(writes[0]![1]!, [0, 0, 0])).toEqual([3, 1, 1]);
    instance.onPointerUp?.(1, 0);
    // 沒有按下就移動 → 不寫
    instance.onPointerMove?.(5, 5);
    expect(writes).toHaveLength(1);
  });

  it('activate() 拒絕：沒選目標、或目標是 primary', () => {
    const plugin = listTools().find((t) => t.id === REGISTRATION_DRAG_TOOL)!;
    const base = { frameGroup: (uid: string) => primaryFrameGroupOf(uid, 'ct') };
    expect(() => plugin.activate({ ...base, params: {} } as unknown as ToolContext)).toThrow(/RG1|選一組/);
    expect(() =>
      plugin.activate({ ...base, params: { registration: { frameOfReferenceUid: 'for.a' } } } as unknown as ToolContext),
    ).toThrow(/RG2|primary/);
  });
});
