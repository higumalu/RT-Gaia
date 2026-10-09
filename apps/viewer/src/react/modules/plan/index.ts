/**
 * 計畫模組 —— 走 `registerModule()`，`apiNamespace: 'studies'`。
 *
 * 工具列「計畫」開關（病例有 RTPLAN 才出現；同時畫影像上的 ISO）、右側計畫面板（模式開著時）、
 * BEV／MLC ＋ 控制點時間軸（`plan.bev`，`slot:'cell'`）。
 * 只看不改、不算劑量、不做碰撞檢查。
 */

import { registerModule, type ModuleManifest } from '../../../core';
import { register3dLayers, register3dOverlay } from '../render3d/contrib';
import { BevView } from './BevView';
import { MiniBev3d } from './MiniBev3d';
import { PLAN_MODE } from './mode';
import { BEV_PANEL_ID, beams3dLayer, PLAN_MODULE_ID } from './model';
import { PlanPanel } from './PlanPanel';
import { PlanToggle } from './PlanToggle';
import { msg } from '../../../core/i18n';

export const PLAN_MODULE_VERSION = '0.2.0';

const MANIFEST: ModuleManifest = {
  id: 'rt-gaia-plan',
  version: PLAN_MODULE_VERSION,
  apiNamespace: 'studies',
  caseScopedState: { [PLAN_MODULE_ID]: ['planId', 'bevBeam', 'cp'] },
  panels: [
    { id: 'plan.toggle', slot: 'toolbar', order: 48, group: 'view', title: msg('計畫'), component: PlanToggle },
    { id: 'plan.panel', slot: 'right-sidebar', order: 125, title: msg('計畫'), component: PlanPanel, visibleWhen: (s) => s.modes.includes(PLAN_MODE) },
    // BEV／MLC 開口 ＋ 控制點時間軸 —— 可以放進任何版面格子（像 DVH 圖）；沒放時內嵌在計畫面板
    { id: BEV_PANEL_ID, slot: 'cell', order: 125, title: msg('BEV／MLC'), component: BevView },
  ],
};

let registered = false;

export function registerPlanModule(): void {
  if (registered) return;
  registered = true;
  registerModule(MANIFEST);
  // 3D 裡畫射束（後端把 `renderer: 'beams'` 換成線與面）＋ 3D 格右下角的小 BEV
  register3dLayers('plan.beams', (s) => beams3dLayer(s.modules[PLAN_MODULE_ID]));
  register3dOverlay('plan.bev-mini', MiniBev3d);
}

export function resetPlanModuleRegistration(): void {
  registered = false;
}

export { PLAN_MODE };
export * from './model';
