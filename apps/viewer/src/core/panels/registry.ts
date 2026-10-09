/**
 * UI 面板掛載點 ＋ 模組宣告。
 *
 * ## 為什麼第一期就必須有
 *
 * > **DCE 需要時間-強度曲線圖表**，而它屬於「綁定空間物件但
 * > 不在空間中渲染」那一類——**沒有面板掛載點就無處可放**。
 * > 後續的 TG-132 QA 指標、DVH 也走同一個機制。
 *
 * 🔴 **這個檔案刻意不 import React。** `PanelRegistration.component` 的型別是
 * `unknown`：`core/` 不得 import 任何 React（界線 1），而面板的實際元件由
 * `react/` 在渲染時 cast 回去。註冊表只負責「有哪些面板、放在哪個 slot」。
 */

import { require_ } from '../geometry';
import { registerLayerRenderer } from '../raster/registry';
import type { LayerRendererPlugin } from '../raster/types';
import { hasTool, registerTool, type ToolPlugin } from '../tools/registry';
import { hasLayout, registerLayout, type LayoutSpec } from './layouts';
import { t } from '../i18n';
import type { FormFactor } from '../device/formFactor';

export type PanelSlot =
  | 'left-sidebar'
  | 'right-sidebar'
  | 'bottom'
  | 'viewport-overlay'
  | 'toolbar'
  /** 可以放進版面格子的面板：使用者從格子的內容選單挑、或模組的版面直接指定。 */
  | 'cell';

/**
 * 工具列（`slot: 'toolbar'`）的分群：
 * `task`＝任務入口（ROI／量測／簽核／匯出／對位；同時只開一個）、`tool`＝通用工具（十字線、筆刷、復原）、
 * `view`＝檢視模式（MPR／DVH／3D）、`layout`＝版面、`case`＝病例切換、`readout`＝讀數、`diagnostic`＝收進「診斷」。
 * 沒填＝`tool`。核心不認識任何模組名，只認群。
 */
export type PanelGroup = 'task' | 'tool' | 'view' | 'layout' | 'case' | 'readout' | 'diagnostic';

export interface PanelRegistration {
  readonly id: string;
  readonly slot: PanelSlot;
  readonly order: number;
  /** 工具列分群（只對 `toolbar` 有意義）。 */
  readonly group?: PanelGroup;
  /**
   * 面板元件。**型別是 `unknown`，因為 `core/` 不得 import React。**
   * `react/` 端會 cast 成 `ComponentType`。
   */
  readonly component: unknown;
  readonly title?: string;
  /** 一句話說明這個面板做什麼（顯示在面板容器的 tooltip；plugin 也能給）。 */
  readonly help?: string;
  /** 什麼時候顯示（例：只有選了帶時間軸的 layer 才顯示曲線面板）。 */
  visibleWhen?: (state: PanelVisibilityState) => boolean;
  /**
   * 在哪些版面出現；省略 ＝ 全部。手機上沒有的任務（量測、對位、匯出、劑量運算、Plugins）
   * 寫 `['tablet', 'desktop']` —— 手機的「更多」選單會列出它們並說明「請在電腦或平板上操作」。
   */
  readonly formFactors?: readonly FormFactor[];
}

export interface PanelVisibilityState {
  readonly tier: 'A' | 'B' | 'C';
  readonly selectedLayerIds: readonly string[];
  readonly hasTemporalLayer: boolean;
  readonly hasSecondarySeries: boolean;
  /** 場景裡有 `kind:'dose'` 的 layer（DVH 等劑量模組的開關據此出現）。 */
  readonly hasDoseLayer: boolean;
  /** 目前版面 id（並排比較的面板只在自己的版面下出現）。 */
  readonly layoutId: string;
  /**
   * 目前開著的 UI 模式（例：`'mpr'`）。模組在工具列放一個開關、把自己的面板設成
   * `visibleWhen: (s) => s.modes.includes('mpr')` —— 核心不認識任何模式名。
   */
  readonly modes: readonly string[];
  /** 目前的版面；省略 ＝ 桌面（舊呼叫端、測試）。 */
  readonly formFactor?: FormFactor;
}

const panels = new Map<string, PanelRegistration>();
const panelListeners = new Set<() => void>();

/**
 * 面板可能在 App 已經 render 之後才註冊（plugin bundle 執行期載入）。
 * 訂閱者（App）收到通知就重新 render；核心自己的註冊都在第一次 render 前，沒有訂閱者也無妨。
 */
export function subscribePanels(listener: () => void): () => void {
  panelListeners.add(listener);
  return () => panelListeners.delete(listener);
}

function notifyPanels(): void {
  for (const l of panelListeners) l();
}

export function registerPanel(registration: PanelRegistration): void {
  require_(registration.id.length > 0, 'PN1', t('panel id 必填'));
  require_(!panels.has(registration.id), 'PN2', t('panel id 重複註冊'), { id: registration.id });
  panels.set(registration.id, registration);
  notifyPanels();
}

export function hasPanel(id: string): boolean {
  return panels.has(id);
}

export function listPanels(slot?: PanelSlot, state?: PanelVisibilityState): PanelRegistration[] {
  return [...panels.values()]
    .filter((p) => (slot === undefined || p.slot === slot))
    .filter((p) => (state === undefined ? true : (p.visibleWhen?.(state) ?? true)))
    .filter((p) => state === undefined || p.formFactors === undefined || p.formFactors.includes(state.formFactor ?? 'desktop'))
    .sort((a, b) => a.order - b.order);
}

export function clearPanels(): void {
  panels.clear();
  notifyPanels();
}

/**
 * 模組宣告。
 *
 * ✅ `Provenance.moduleVersion` 早就預留了這個欄位；`version` 就是它的
 * 來源，**追溯鏈因此閉合**——這正是 IEC 62304 與 PCCP 要求的「每個衍生物記錄
 * 來源與模組版本」。
 */
export interface ModuleManifest {
  readonly id: string;
  /** → `Provenance.moduleVersion`。 */
  readonly version: string;
  /** `registerModule()` 一併註冊（之前是 `unknown[]` 且要各自呼叫）。 */
  readonly layerRenderers?: readonly LayerRendererPlugin[];
  readonly tools?: readonly ToolPlugin[];
  readonly layouts?: readonly LayoutSpec[];
  readonly panels?: readonly PanelRegistration[];
  /** → `/api/v1/modules/{id}/...` */
  readonly apiNamespace?: string;
  /** 切病例／停用 plugin 時呼叫：清 painter、訂閱、計時器。 */
  readonly onDispose?: () => void;
  /**
   * 模組狀態（`api.state.modules[stateId]`）裡**跟著病例走**的欄位：換病例時清掉，其他欄位（偏好）留著。
   * 例：3D 相機與裁切框、選中的計畫與射束。沒宣告的話，上一個病例的相機會套到下一個病例（3D 格整片黑）。
   */
  readonly caseScopedState?: Readonly<Record<string, readonly string[]>>;
}

const modules = new Map<string, ModuleManifest>();

export function registerModule(manifest: ModuleManifest): void {
  require_(manifest.id.length > 0, 'MD1', t('module id 必填'));
  require_(manifest.version.length > 0, 'MD2', t('module version 必填（→ Provenance.moduleVersion）'));
  require_(!modules.has(manifest.id), 'MD3', t('module id 重複註冊'), { id: manifest.id });
  modules.set(manifest.id, manifest);
  for (const renderer of manifest.layerRenderers ?? []) registerLayerRenderer(renderer);
  for (const tool of manifest.tools ?? []) if (!hasTool(tool.id)) registerTool(tool);
  for (const layout of manifest.layouts ?? []) if (!hasLayout(layout.id)) registerLayout(layout);
  for (const panel of manifest.panels ?? []) registerPanel(panel);
}

/** 切病例時呼叫每個模組的 `onDispose`（有登記的才有）；例外只記到 console，不影響其他模組。 */
export function disposeModules(): void {
  for (const m of modules.values()) {
    try {
      m.onDispose?.();
    } catch (e) {
      console.warn(t('[modules] {id}.onDispose 拋例外', { id: m.id }), e);
    }
  }
}

/** 換病例：把各模組宣告的 `caseScopedState` 欄位從模組狀態拿掉（偏好留著）；沒有要拿的就回原物件。 */
export function withoutCaseState(
  states: Readonly<Record<string, Readonly<Record<string, unknown>>>>,
): Record<string, Record<string, unknown>> {
  let out: Record<string, Record<string, unknown>> | null = null;
  for (const m of modules.values()) {
    for (const [stateId, keys] of Object.entries(m.caseScopedState ?? {})) {
      const st = (out ?? states)[stateId];
      if (st === undefined || !keys.some((k) => k in st)) continue;
      out ??= { ...states } as Record<string, Record<string, unknown>>;
      const next = { ...st };
      for (const k of keys) delete next[k];
      out[stateId] = next;
    }
  }
  return out ?? states;
}

export function listModules(): ModuleManifest[] {
  return [...modules.values()];
}

export function moduleVersionOf(moduleId: string): string | null {
  return modules.get(moduleId)?.version ?? null;
}

export function clearModules(): void {
  modules.clear();
}

/** 核心自己也是一個模組——`Provenance.moduleVersion` 的預設來源。 */
export const CORE_MODULE_ID = 'rt-gaia-core';
