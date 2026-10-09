/**
 * 斜面 MPR 是一個**模組**：工具列開關 ＋ 只在模式開著時出現的右側面板。
 */

import { beforeEach, describe, expect, it } from 'vitest';

import { clearModules, clearPanels, listModules, listPanels, type PanelVisibilityState } from '../src/core';
import { MPR_MODE, registerMprModule, resetMprModuleRegistration } from '../src/react/modules/mpr';
import { registerCoreUi, resetCoreUiRegistration } from '../src/react/panels/builtins';

const state = (modes: string[]): PanelVisibilityState => ({
  tier: 'C',
  selectedLayerIds: [],
  hasTemporalLayer: false,
  hasSecondarySeries: false,
  hasDoseLayer: false,
  layoutId: '2x2',
  modes,
});

beforeEach(() => {
  clearPanels();
  clearModules();
  resetCoreUiRegistration();
  resetMprModuleRegistration();
  registerCoreUi();
  registerMprModule();
});

describe('斜面 MPR 模組', () => {
  it('以 registerModule 註冊（有版本 → Provenance.moduleVersion），面板在模組區間 100+ 或工具列', () => {
    const mpr = listModules().find((m) => m.id === 'rt-gaia-mpr');
    expect(mpr?.version).toBe('0.1.0');
    expect(listPanels('right-sidebar').map((p) => p.id)).toEqual(['mpr.panel']);
    expect(listPanels('right-sidebar')[0]!.order).toBeGreaterThanOrEqual(100);
    // 工具列開關插在核心面板之間（編輯 40 與 Tier 90 之間），核心一行都不用改
    const toolbar = listPanels('toolbar').map((p) => p.id);
    expect(toolbar.indexOf('mpr.toggle')).toBeGreaterThan(toolbar.indexOf('core.edit'));
    expect(toolbar.indexOf('mpr.toggle')).toBeLessThan(toolbar.indexOf('core.tier'));
  });

  it('🔴 面板只在 mpr 模式開著時出現；開關永遠在', () => {
    expect(listPanels('right-sidebar', state([])).map((p) => p.id)).toEqual([]);
    expect(listPanels('right-sidebar', state([MPR_MODE])).map((p) => p.id)).toEqual(['mpr.panel']);
    expect(listPanels('toolbar', state([])).map((p) => p.id)).toContain('mpr.toggle');
  });

  it('重複註冊冪等', () => {
    const n = listPanels().length;
    expect(() => registerMprModule()).not.toThrow();
    expect(listPanels()).toHaveLength(n);
  });
});
