/** 匯出模組：工具列「匯出」開關 ＋ 右側面板。後端負責 job 佇列與 blob 下載。 */

import { registerModule, type ModuleManifest } from '../../../core';
import { ExportPanel } from './ExportPanel';
import { ExportToggle } from './ExportToggle';
import { EXPORT_MODE } from './mode';
import { msg } from '../../../core/i18n';

export const EXPORT_MODULE_VERSION = '0.1.0';

const MANIFEST: ModuleManifest = {
  id: 'rt-gaia-export',
  version: EXPORT_MODULE_VERSION,
  panels: [
    { id: 'export.toggle', slot: 'toolbar', order: 52, group: 'task', formFactors: ['tablet', 'desktop'], title: msg('匯出'), component: ExportToggle },
    { id: 'export.panel', slot: 'right-sidebar', order: 160, title: msg('匯出'), component: ExportPanel, visibleWhen: (s) => s.modes.includes(EXPORT_MODE) },
  ],
};

let registered = false;

export function registerExportModule(): void {
  if (registered) return;
  registered = true;
  registerModule(MANIFEST);
}

export function resetExportModuleRegistration(): void {
  registered = false;
}

export { EXPORT_MODE };
export * from './model';
