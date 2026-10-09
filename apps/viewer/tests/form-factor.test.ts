/**
 * 版面判斷、面板依版面過濾、手機的記憶體預算。
 */
import { afterEach, describe, expect, it } from 'vitest';

import { clearPanels, formFactorOf, listPanels, registerPanel, type PanelVisibilityState } from '../src/core';
import { budgetFor, maxFullResVolumes, setDeviceMemoryClass } from '../src/core/tier/budget';

const vis = (formFactor?: PanelVisibilityState['formFactor']): PanelVisibilityState => ({
  tier: 'A',
  selectedLayerIds: [],
  hasTemporalLayer: false,
  hasSecondarySeries: false,
  hasDoseLayer: false,
  layoutId: '2x2',
  modes: [],
  ...(formFactor ? { formFactor } : {}),
});

describe('版面判斷', () => {
  it('手機：窄（< 768）、或觸控的短邊 < 600（橫拿的手機寬 844 也是手機）', () => {
    expect(formFactorOf({ width: 390, height: 844, coarse: true, forceDesktop: false })).toBe('phone');
    expect(formFactorOf({ width: 844, height: 390, coarse: true, forceDesktop: false })).toBe('phone');
    // 觸控、直式的小平板（寬 700）照樣是手機版面
    expect(formFactorOf({ width: 700, height: 900, coarse: true, forceDesktop: false })).toBe('phone');
    // 桌面瀏覽器拉得很窄（< 600）也用手機版面（窄視窗的資料頁）
    expect(formFactorOf({ width: 500, height: 900, coarse: false, forceDesktop: false })).toBe('phone');
  });

  it('平板：觸控、短邊夠大；桌面：滑鼠', () => {
    expect(formFactorOf({ width: 800, height: 1280, coarse: true, forceDesktop: false })).toBe('tablet');
    expect(formFactorOf({ width: 1280, height: 800, coarse: true, forceDesktop: false })).toBe('tablet');
    expect(formFactorOf({ width: 1024, height: 768, coarse: false, forceDesktop: false })).toBe('desktop');
    // 滑鼠的矮視窗（1440×500）不是手機
    expect(formFactorOf({ width: 1440, height: 500, coarse: false, forceDesktop: false })).toBe('desktop');
    // 🔴 桌面放大 200%（1440×900 → 720×450）：照樣桌面，不能少掉功能（測試矩陣抓到）
    expect(formFactorOf({ width: 720, height: 450, coarse: false, forceDesktop: false })).toBe('desktop');
  });

  it('使用桌面版：一律桌面', () => {
    expect(formFactorOf({ width: 390, height: 844, coarse: true, forceDesktop: true })).toBe('desktop');
  });
});

describe('面板依版面過濾（formFactors）', () => {
  afterEach(() => clearPanels());

  it('只給平板與桌面的面板，手機上不列；沒寫的全部都列；沒給版面當桌面', () => {
    registerPanel({ id: 'all', slot: 'toolbar', order: 1, component: () => null });
    registerPanel({ id: 'big', slot: 'toolbar', order: 2, component: () => null, formFactors: ['tablet', 'desktop'] });
    registerPanel({ id: 'touch', slot: 'toolbar', order: 3, component: () => null, formFactors: ['phone', 'tablet'] });
    expect(listPanels('toolbar', vis('phone')).map((p) => p.id)).toEqual(['all', 'touch']);
    expect(listPanels('toolbar', vis('tablet')).map((p) => p.id)).toEqual(['all', 'big', 'touch']);
    expect(listPanels('toolbar', vis()).map((p) => p.id)).toEqual(['all', 'big']);
    // 不給狀態（列全部，給 dock 等用）
    expect(listPanels('toolbar').map((p) => p.id)).toEqual(['all', 'big', 'touch']);
  });
});

describe('手機記憶體預算', () => {
  afterEach(() => setDeviceMemoryClass('default'));

  it('手機：每一項取 Tier 與手機預算較小的；全解析度常駐最多 2 個', () => {
    const desktop = budgetFor('A', 1);
    setDeviceMemoryClass('phone');
    const phone = budgetFor('A', 1);
    expect(phone.totalBytes).toBe(800_000_000);
    expect(phone.imageBytes).toBeLessThan(desktop.imageBytes);
    expect(phone.maskCpuBytes).toBeLessThanOrEqual(300_000_000);
    expect(maxFullResVolumes('A')).toBe(2);
    expect(maxFullResVolumes('B')).toBe(2);
    setDeviceMemoryClass('default');
    expect(maxFullResVolumes('A')).toBe(4);
    expect(budgetFor('A', 1)).toEqual(desktop);
  });
});
