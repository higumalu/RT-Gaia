/**
 * 參考線模組：工具列開關（檢視群）＋ overlay painter。走 `registerModule()`。
 */

import { registerModule, type ModuleManifest } from '../../../core';
import { RefLinesToggle } from './RefLinesToggle';
import { msg } from '../../../core/i18n';

export { REFLINES_MODE } from './mode';
export { ORIENTATION_COLOR, planeIntersection, referenceLinesFor, segmentEndpoints } from './model';

export const REFLINES_MODULE_VERSION = '0.1.0';

const MANIFEST: ModuleManifest = {
  id: 'rt-gaia-reflines',
  version: REFLINES_MODULE_VERSION,
  panels: [{ id: 'reflines.toggle', slot: 'toolbar', order: 44, group: 'view', title: msg('參考線'), component: RefLinesToggle }],
};

let registered = false;

export function registerRefLinesModule(): void {
  if (registered) return;
  registered = true;
  registerModule(MANIFEST);
}

export function resetRefLinesModuleRegistration(): void {
  registered = false;
}
