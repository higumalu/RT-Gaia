/**
 * 3D 靜態出圖模組 —— 把 `server-render` 退路接到 3D 格上。
 * 一個 `viewport-overlay` 面板：該格是 3D 時整格畫後端出的 PNG，拖曳轉相機。
 */

import { registerModule, type ModuleManifest } from '../../../core';
import { RENDER3D_MODE, RENDER3D_VIEW_PANEL_ID } from './model';
import { Render3dSettings } from './Render3dSettings';
import { Render3dToggle } from './Render3dToggle';
import { Render3dView } from './Render3dView';
import { msg } from '../../../core/i18n';

export const RENDER3D_MODULE_VERSION = '0.3.0';

const MANIFEST: ModuleManifest = {
  id: 'rt-gaia-render3d',
  version: RENDER3D_MODULE_VERSION,
  apiNamespace: 'render3d',
  caseScopedState: { render3d: ['camera', 'crop'] },
  panels: [
    { id: RENDER3D_VIEW_PANEL_ID, slot: 'viewport-overlay', order: 10, title: msg('3D 靜態出圖'), component: Render3dView },
    { id: 'render3d.toggle', slot: 'toolbar', order: 49, group: 'view', formFactors: ['tablet', 'desktop'], title: '3D', component: Render3dToggle },
    {
      id: 'render3d.settings',
      slot: 'right-sidebar',
      order: 150,
      title: msg('3D 出圖'),
      component: Render3dSettings,
      visibleWhen: (s) => s.modes.includes(RENDER3D_MODE),
    },
  ],
};

let registered = false;

export function registerRender3dModule(): void {
  if (registered) return;
  registered = true;
  registerModule(MANIFEST);
}

export function resetRender3dModuleRegistration(): void {
  registered = false;
}

export * from './model';
export * from './camera3d';
export * from './transferFunction';
