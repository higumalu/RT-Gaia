/**
 * 換病例時模組狀態的去留（`ModuleManifest.caseScopedState`、`withoutCaseState`）。
 *
 * 2026-10-09 錄 demo 時發現：App 的模組狀態袋從來不清 —— 從資料頁開另一個病例，上一個病例的 3D 相機
 * 套到新病例（3D 格整片黑，要按「正面」才出來）；ROI 面板的「上一步」、選中的計畫也是上一個病例的。
 */

import { beforeEach, describe, expect, it } from 'vitest';

import { clearModules, listModules, registerModule, withoutCaseState } from '../src/core';

beforeEach(() => {
  clearModules();
});

describe('withoutCaseState', () => {
  it('只拿掉宣告為跟著病例走的欄位，偏好留著', () => {
    registerModule({ id: 'm3d', version: '1', caseScopedState: { render3d: ['camera', 'crop'] } });
    registerModule({ id: 'mplan', version: '1', caseScopedState: { plan: ['planId'] } });
    const before = {
      render3d: { camera: { distance: 10 }, crop: null, tf: 'bone', technique: 'mip' },
      plan: { planId: 'p1', showIso: false },
      other: { anything: 1 },
    };
    const after = withoutCaseState(before);
    expect(after).toEqual({
      render3d: { tf: 'bone', technique: 'mip' },
      plan: { showIso: false },
      other: { anything: 1 },
    });
    // 原物件不動（React state 不可就地改）
    expect(before.render3d.camera).toEqual({ distance: 10 });
  });

  it('沒有要拿掉的欄位就回同一個物件（不觸發多餘的重畫）', () => {
    registerModule({ id: 'm3d', version: '1', caseScopedState: { render3d: ['camera'] } });
    const states = { render3d: { tf: 'bone' } };
    expect(withoutCaseState(states)).toBe(states);
    expect(withoutCaseState({})).toEqual({});
  });

  it('內建模組都宣告了：3D 相機與裁切、計畫與射束、DVH 選取、劑量運算焦點、ROI 紀錄、量測範本進度', async () => {
    const mods = await Promise.all([
      import('../src/react/modules/render3d'),
      import('../src/react/modules/plan'),
      import('../src/react/modules/dvh'),
      import('../src/react/modules/doseops'),
      import('../src/react/modules/roi'),
      import('../src/react/modules/measure'),
    ]);
    const [render3d, plan, dvh, doseops, roi, measure] = mods;
    render3d.resetRender3dModuleRegistration();
    render3d.registerRender3dModule();
    plan.resetPlanModuleRegistration();
    plan.registerPlanModule();
    dvh.resetDvhModuleRegistration();
    dvh.registerDvhModule();
    doseops.resetDoseOpsModuleRegistration();
    doseops.registerDoseOpsModule();
    roi.resetRoiModuleRegistration();
    roi.registerRoiModule();
    measure.resetMeasureModuleRegistration();
    measure.registerMeasureModule();
    const declared = Object.assign({}, ...listModules().map((m) => m.caseScopedState ?? {})) as Record<string, readonly string[]>;
    expect(declared).toEqual({
      render3d: ['camera', 'crop'],
      plan: ['planId', 'bevBeam', 'cp'],
      dvh: ['doseIds', 'structureIds', 'referenceGy'],
      'dose-ops': ['focus'],
      roi: ['log'],
      measure: ['templateRun', 'templateDone'],
    });
  });
});
