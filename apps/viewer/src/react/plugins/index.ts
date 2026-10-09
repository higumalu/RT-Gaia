/**
 * 宿主的 plugins 模組：任務列「Plugins」選單 ＋ 執行期載入 plugin UI。
 * 與其他核心模組一樣走 `registerModule()`。
 */

import { registerModule, type ModuleManifest } from '../../core';
import { PluginsMenu } from './menu/PluginsMenu';

export { pluginCatalog, pluginMode } from './catalog';
export { installPluginUis } from './loader';

export const PLUGINS_MODULE_VERSION = '0.1.0';

const MANIFEST: ModuleManifest = {
  id: 'rt-gaia-plugins',
  version: PLUGINS_MODULE_VERSION,
  panels: [{ id: 'plugins.menu', slot: 'toolbar', order: 60, group: 'task', formFactors: ['tablet', 'desktop'], title: 'Plugins', component: PluginsMenu }],
};

let registered = false;

export function registerPluginsModule(): void {
  if (registered) return;
  registered = true;
  registerModule(MANIFEST);
}

export function resetPluginsModuleRegistration(): void {
  registered = false;
}
