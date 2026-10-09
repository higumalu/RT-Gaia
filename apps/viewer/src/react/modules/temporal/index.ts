/**
 * 時間軸模組：`bottom` slot 的時間軸列。游標、播放、預抓都在核心與 App；這裡只有 UI。
 */

import { registerModule, type ModuleManifest } from '../../../core';
import { msg } from '../../../core/i18n';
import { PhaseLock } from './PhaseLock';
import { TimeBar } from './TimeBar';

export const TEMPORAL_MODULE_VERSION = '0.1.0';

const MANIFEST: ModuleManifest = {
  id: 'rt-gaia-temporal',
  version: TEMPORAL_MODULE_VERSION,
  panels: [
    {
      id: 'temporal.bar',
      slot: 'bottom',
      order: 5,
      title: msg('時間軸'),
      help: msg('4D-CT／4D-MR 的相位、DCE 的時間點：播放、逐格、播放範圍、時間曲線'),
      component: TimeBar,
      visibleWhen: (s) => s.hasTemporalLayer,
    },
    {
      // 每一格角落的相位選單（跟著時間軸／鎖在某一幀）
      id: 'temporal.phase-lock',
      slot: 'viewport-overlay',
      order: 40,
      title: msg('這一格的相位'),
      component: PhaseLock,
      visibleWhen: (s) => s.hasTemporalLayer,
    },
  ],
};

let registered = false;

export function registerTemporalModule(): void {
  if (registered) return;
  registered = true;
  registerModule(MANIFEST);
}

export function resetTemporalModuleRegistration(): void {
  registered = false;
}
