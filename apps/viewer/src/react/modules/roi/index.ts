/**
 * ROI 編輯模組 —— 對照 Slicer Segment Editor。
 * 工具列「ROI 編輯」開關、右側面板（模式開著時）、`roi.table`（`slot:'cell'`）。
 * 工具本身（筆刷／橡皮擦／閾值筆刷／圈選）在核心；這裡是它們的參數與結構層級操作。
 */

import { registerModule, type ModuleManifest } from '../../../core';
import { ROI_MODE, ROI_TABLE_PANEL_ID } from './mode';
import { RoiPanel } from './RoiPanel';
import { RoiTable } from './RoiTable';
import { RoiToggle } from './RoiToggle';
import { msg } from '../../../core/i18n';

export const ROI_MODULE_VERSION = '0.1.0';

const MANIFEST: ModuleManifest = {
  id: 'rt-gaia-roi',
  version: ROI_MODULE_VERSION,
  caseScopedState: { roi: ['log'] },
  panels: [
    { id: 'roi.toggle', slot: 'toolbar', order: 30, group: 'task', title: msg('ROI 編輯'), component: RoiToggle },
    { id: 'roi.panel', slot: 'right-sidebar', order: 90, title: msg('ROI 編輯'), component: RoiPanel, visibleWhen: (s) => s.modes.includes(ROI_MODE) },
    { id: ROI_TABLE_PANEL_ID, slot: 'cell', order: 90, title: msg('ROI 清單'), component: RoiTable },
  ],
};

let registered = false;

export function registerRoiModule(): void {
  if (registered) return;
  registered = true;
  registerModule(MANIFEST);
}

export function resetRoiModuleRegistration(): void {
  registered = false;
}

export { ROI_MODE };
export * from './model';
