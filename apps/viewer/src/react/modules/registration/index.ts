/**
 * 對位微調模組 —— 走 `registerModule()`。
 *
 * 三樣東西：工具列「對位」開關、右側面板（只在模式開著時）、`registration-drag` 工具
 * （`hidden`，由面板啟動）。核心只多了兩條泛用的縫：FrameGroup 變換覆寫與工具參數袋。
 */

import { registerModule, type ModuleManifest } from '../../../core';
import { REGISTRATION_MODE } from './mode';
import { RegistrationPanel } from './RegistrationPanel';
import { RegistrationToggle } from './RegistrationToggle';
import { REGISTRATION_DRAG_PLUGIN, registerRegistrationTool } from './tool';
import { msg } from '../../../core/i18n';

export const REGISTRATION_MODULE_VERSION = '0.1.0';

const MANIFEST: ModuleManifest = {
  id: 'rt-gaia-registration',
  version: REGISTRATION_MODULE_VERSION,
  tools: [REGISTRATION_DRAG_PLUGIN],
  panels: [
    {
      id: 'registration.toggle',
      slot: 'toolbar',
      order: 46,
      group: 'task',
      title: msg('對位'),
      component: RegistrationToggle,
      formFactors: ['tablet', 'desktop'],
      visibleWhen: (s) => s.hasSecondarySeries,
    },
    {
      id: 'registration.panel',
      slot: 'right-sidebar',
      order: 110,
      title: msg('對位微調'),
      component: RegistrationPanel,
      visibleWhen: (s) => s.modes.includes(REGISTRATION_MODE),
    },
  ],
};

let registered = false;

export function registerRegistrationModule(): void {
  registerRegistrationTool();
  if (registered) return;
  registered = true;
  registerModule(MANIFEST);
}

export function resetRegistrationModuleRegistration(): void {
  registered = false;
}

export { REGISTRATION_MODE };
export { REGISTRATION_DRAG_TOOL } from './mode';
export { draggedTransform, registrationTargetOf } from './tool';
