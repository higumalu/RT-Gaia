/**
 * 斜面 MPR 模組 —— **第一個走 `registerModule()` 的模組**。
 *
 * 兩個面板：工具列的「MPR」開關、右側的操作面板（只在模式開著時出現，
 * `visibleWhen: (s) => s.modes.includes('mpr')`）。渲染側的東西（旋轉 handle、slab 語意）
 * 早就在核心裡以資料驅動；模組只負責 UI 與模式開關。
 *
 * order 100+：模組區間（`panels/builtins.tsx` 的慣例）。
 */

import { registerModule, type ModuleManifest } from '../../../core';
import { MPR_MODE } from './mode';
import { MprPanel } from './MprPanel';
import { MprToggle } from './MprToggle';
import { msg } from '../../../core/i18n';

export const MPR_MODULE_VERSION = '0.1.0';

const MANIFEST: ModuleManifest = {
  id: 'rt-gaia-mpr',
  version: MPR_MODULE_VERSION,
  panels: [
    { id: 'mpr.toggle', slot: 'toolbar', order: 45, group: 'view', formFactors: ['tablet', 'desktop'], title: 'MPR', component: MprToggle },
    {
      id: 'mpr.panel',
      slot: 'right-sidebar',
      order: 100,
      title: msg('斜面 MPR'),
      component: MprPanel,
      visibleWhen: (s) => s.modes.includes(MPR_MODE),
    },
  ],
};

let registered = false;

/** 冪等（StrictMode double-invoke 與測試會重複呼叫）。 */
export function registerMprModule(): void {
  if (registered) return;
  registered = true;
  registerModule(MANIFEST);
}

export function resetMprModuleRegistration(): void {
  registered = false;
}

export { MPR_MODE };
