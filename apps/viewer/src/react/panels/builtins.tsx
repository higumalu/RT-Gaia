/**
 * 核心自己的面板 —— **和第三方模組走完全相同的註冊路徑**。
 *
 * 🔴 **這一點是刻意的，而且是這次重構的重點。** 規則是「核心不得認識任何
 * 模組專屬的型別」，但只要核心的 chrome 是硬寫在 `App.tsx` 的 JSX 裡，那道縫
 * 就永遠沒有人走過 —— **第一個發現它壞掉的會是第一個第三方模組**，那時再修
 * 要動已經寫好的 UI。核心自己先走一遍，縫才會是通的。
 *
 * ## order 的分配慣例
 *
 * | 區間 | 給誰 |
 * |---|---|
 * | 0–99 | 核心 |
 * | 100+ | 模組 |
 *
 * 核心之間留 10 的間隔，讓模組可以插在核心的兩個面板之間而不必改核心。
 */

import { registerModule, type ModuleManifest, type PanelRegistration } from '../../core';
import { CasePickerPanel } from './CasePickerPanel';
import { DataPanel } from './DataPanel';
import { DoseLegend } from './DoseLegend';
import { EditControlsPanel } from './EditControlsPanel';
import { NoticesPanel } from './NoticesPanel';
import { ProbePanel } from './ProbePanel';
import { TierPanel } from './TierPanel';
import { ToolPalettePanel } from './ToolPalettePanel';
import { TouchControlsPanel } from './TouchControlsPanel';
import { msg } from '../../core/i18n';

/** → `Provenance.moduleVersion`。追溯鏈的起點。 */
export const CORE_UI_VERSION = '0.1.0';

const CORE_PANELS: readonly PanelRegistration[] = [
  { id: 'core.case-picker', slot: 'toolbar', order: 10, group: 'case', title: msg('案例'), component: CasePickerPanel },
  { id: 'core.tools', slot: 'toolbar', order: 20, group: 'tool', title: msg('工具'), component: ToolPalettePanel },
  // 筆刷參數（原 core.brush）現在在 ROI 編輯模組的面板裡
  { id: 'core.edit', slot: 'toolbar', order: 40, group: 'tool', title: msg('編輯'), component: EditControlsPanel },
  // 觸控裝置才有（調窗、完成／取消、手指畫）
  { id: 'core.touch', slot: 'toolbar', order: 42, group: 'tool', title: msg('觸控'), component: TouchControlsPanel, formFactors: ['phone', 'tablet'] },
  { id: 'core.tier', slot: 'toolbar', order: 90, group: 'diagnostic', title: 'Tier', component: TierPanel },
  // 讀數只有一份，放在**畫面左下角**的狀態列（`bottom` slot 第一列），不在工具列
  { id: 'core.probe', slot: 'bottom', order: 10, title: msg('讀數'), component: ProbePanel },
  // 左側是「資料」面板 —— 依 FrameGroup 分組的影像／劑量／結構
  // （Slicer 的 Data ＋ Volumes）。`StructureListPanel` 保留為元件（單 FoR 的簡版），不再註冊。
  // 🔴 改結構清單的行為時兩邊都要改（結構集分層就曾經漏了這裡一次）。
  { id: 'core.data', slot: 'left-sidebar', order: 10, title: msg('資料'), component: DataPanel },
  { id: 'core.notices', slot: 'bottom', order: 90, title: msg('提示'), component: NoticesPanel },
  // 等劑量線圖例（只在 2D 格、有顯示中的劑量且開著等劑量線時畫）
  { id: 'core.dose-legend', slot: 'viewport-overlay', order: 50, title: msg('等劑量線圖例'), component: DoseLegend, visibleWhen: (s) => s.hasDoseLayer },
];

const CORE_UI_MODULE: ModuleManifest = {
  id: 'rt-gaia-core-ui',
  version: CORE_UI_VERSION,
  panels: CORE_PANELS,
};

let registered = false;

/**
 * 註冊核心面板。**冪等** —— StrictMode 的 double-invoke 與測試都會重複呼叫，
 * 而 `registerPanel` 對重複 id 是拋例外的（PN2）。
 */
export function registerCoreUi(): void {
  if (registered) return;
  registered = true;
  registerModule(CORE_UI_MODULE);
}

/** 測試用：讓 `clearPanels()` 之後可以重新註冊。 */
export function resetCoreUiRegistration(): void {
  registered = false;
}
