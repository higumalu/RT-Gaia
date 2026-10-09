/**
 * 劑量運算模組 —— 走 `registerModule()`，`apiNamespace: 'studies'`。
 *
 * 工具列「劑量運算」開關（病例有劑量才出現）、右側面板（模式開著時）。加減是兩個劑量之間、
 * 乘除是乘除固定值；結果先暫存、可存成 RTDOSE（DICOM 值可自訂）。
 */

import { registerModule, type ModuleManifest } from '../../../core';
import { DOSE_OPS_MODE } from './mode';
import { DoseOpsPanel } from './DoseOpsPanel';
import { DosePanel } from './DosePanel';
import { DoseOpsToggle } from './DoseOpsToggle';
import { msg } from '../../../core/i18n';

export const DOSE_OPS_MODULE_VERSION = '0.1.0';

const MANIFEST: ModuleManifest = {
  id: 'rt-gaia-dose-ops',
  version: DOSE_OPS_MODULE_VERSION,
  apiNamespace: 'studies',
  caseScopedState: { 'dose-ops': ['focus'] },
  panels: [
    { id: 'doseops.toggle', slot: 'toolbar', order: 47.5, group: 'view', formFactors: ['tablet', 'desktop'], title: msg('劑量運算'), component: DoseOpsToggle },
    // 劑量是 3D 物件 —— 左側「劑量」面板列出所有劑量 ＋ 累積劑量（已照 vs 計畫）
    { id: 'doseops.list', slot: 'left-sidebar', order: 20, title: msg('劑量'), component: DosePanel, visibleWhen: (s) => s.hasDoseLayer },
    { id: 'doseops.panel', slot: 'right-sidebar', order: 122, title: msg('劑量運算'), component: DoseOpsPanel, visibleWhen: (s) => s.modes.includes(DOSE_OPS_MODE) },
  ],
};

let registered = false;

export function registerDoseOpsModule(): void {
  if (registered) return;
  registered = true;
  registerModule(MANIFEST);
}

export function resetDoseOpsModuleRegistration(): void {
  registered = false;
}

export { DOSE_OPS_MODE };
export * from './model';
