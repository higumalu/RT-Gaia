/**
 * 量測模組 —— UI 是模組，工具與畫在核心。
 * 三個面板：工具列「量測」開關、右側面板（模式開著時）、`measure.table`（`slot:'cell'`）。
 */

import { registerModule, type ModuleManifest } from '../../../core';
import { MeasurePanel } from './MeasurePanel';
import { MeasureTable } from './MeasureTable';
import { MeasureToggle } from './MeasureToggle';
import { MEASURE_MODE, MEASURE_TABLE_PANEL_ID } from './mode';
import { msg } from '../../../core/i18n';

export const MEASURE_MODULE_VERSION = '0.1.0';

const MANIFEST: ModuleManifest = {
  id: 'rt-gaia-measure',
  version: MEASURE_MODULE_VERSION,
  caseScopedState: { measure: ['templateRun', 'templateDone'] },
  panels: [
    { id: 'measure.toggle', slot: 'toolbar', order: 48, group: 'task', formFactors: ['tablet', 'desktop'], title: msg('量測'), component: MeasureToggle },
    {
      id: 'measure.panel',
      slot: 'right-sidebar',
      order: 140,
      title: msg('量測'),
      component: MeasurePanel,
      visibleWhen: (s) => s.modes.includes(MEASURE_MODE),
    },
    { id: MEASURE_TABLE_PANEL_ID, slot: 'cell', order: 140, title: msg('量測表'), component: MeasureTable },
  ],
};

let registered = false;

export function registerMeasureModule(): void {
  if (registered) return;
  registered = true;
  registerModule(MANIFEST);
}

export function resetMeasureModuleRegistration(): void {
  registered = false;
}

export { MEASURE_MODE };
export * from './model';
