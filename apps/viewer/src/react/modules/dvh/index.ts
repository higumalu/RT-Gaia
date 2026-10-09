/**
 * DVH 模組 —— 走 `registerModule()`，`apiNamespace: 'dose'`。
 *
 * 三個面板：工具列「DVH」開關（有劑量才出現）、右側設定面板（模式開著時）、
 * `dvh.chart`（`slot:'cell'`：可以放進任何版面格子的圖 ＋ 統計表）。
 * 也帶一個版面 `dose-review`（左大格軸向、右上冠狀、右下 DVH 圖）—— 模組決定格子內容的示範。
 */

import { hasLayout, registerLayout, registerModule, type ModuleManifest } from '../../../core';
import { DvhChart } from './DvhChart';
import { DvhSettings } from './DvhSettings';
import { DvhToggle } from './DvhToggle';
import { DVH_MODE } from './mode';
import { DVH_CHART_PANEL_ID } from './model';
import { msg } from '../../../core/i18n';

export const DVH_MODULE_VERSION = '0.2.0';
export const DOSE_REVIEW_LAYOUT_ID = 'dose-review';

const MANIFEST: ModuleManifest = {
  id: 'rt-gaia-dvh',
  version: DVH_MODULE_VERSION,
  apiNamespace: 'dose',
  caseScopedState: { dvh: ['doseIds', 'structureIds', 'referenceGy'] },
  panels: [
    { id: 'dvh.toggle', slot: 'toolbar', order: 47, group: 'view', title: 'DVH', component: DvhToggle, visibleWhen: (s) => s.hasDoseLayer },
    {
      id: 'dvh.settings',
      slot: 'right-sidebar',
      order: 120,
      title: 'DVH',
      component: DvhSettings,
      visibleWhen: (s) => s.modes.includes(DVH_MODE),
    },
    { id: DVH_CHART_PANEL_ID, slot: 'cell', order: 120, title: msg('DVH 圖'), component: DvhChart },
  ],
};

let registered = false;

export function registerDvhModule(): void {
  if (!hasLayout(DOSE_REVIEW_LAYOUT_ID)) {
    registerLayout({
      id: DOSE_REVIEW_LAYOUT_ID,
      label: msg('劑量評估（軸向 ＋ 冠狀 ＋ DVH）'),
      gridTemplateColumns: '3fr 2fr',
      gridTemplateRows: '1fr 1fr',
      cells: [
        { cellId: 'axial', label: msg('軸向'), gridArea: '1 / 1 / 3 / 2', content: { kind: 'viewport', orientation: 'axial' } },
        { cellId: 'coronal', label: msg('冠狀'), gridArea: '1 / 2 / 2 / 3', content: { kind: 'viewport', orientation: 'coronal' } },
        { cellId: 'dvh', gridArea: '2 / 2 / 3 / 3', content: { kind: 'panel', panelId: DVH_CHART_PANEL_ID } },
      ],
    });
  }
  if (registered) return;
  registered = true;
  registerModule(MANIFEST);
}

export function resetDvhModuleRegistration(): void {
  registered = false;
}

export { DVH_MODE };
export * from './model';
