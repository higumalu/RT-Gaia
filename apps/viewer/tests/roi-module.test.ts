/**
 * ROI 編輯模組：註冊／可見性、schema → 表單欄位、預設參數、必填檢查、顏色輪替、TG-263 文字。
 */

import { beforeEach, describe, expect, it } from 'vitest';

import { clearModules, clearPanels, listModules, listPanels, type OpDescriptor, type PanelVisibilityState } from '../src/core';
import { defaultParams, fieldsOf, hexRgb, missingRequired, nextColor, registerRoiModule, resetRoiModuleRegistration, rgbHex, ROI_MODE, STRUCTURE_COLORS, tg263Adoptable, tg263Text } from '../src/react/modules/roi';
import { registerCoreUi, resetCoreUiRegistration } from '../src/react/panels/builtins';

const state = (modes: string[]): PanelVisibilityState => ({ tier: 'C', selectedLayerIds: [], hasTemporalLayer: false, hasSecondarySeries: false, hasDoseLayer: false, layoutId: '2x2', modes });

describe('ROI 模組', () => {
  beforeEach(() => {
    clearPanels();
    clearModules();
    resetCoreUiRegistration();
    resetRoiModuleRegistration();
    registerCoreUi();
    registerRoiModule();
  });
  it('registerModule；開關在工具列（取代 core.brush 的位置）；面板只在 roi 模式；清單是 cell 面板', () => {
    expect(listModules().find((m) => m.id === 'rt-gaia-roi')?.version).toBe('0.1.0');
    const toolbar = listPanels('toolbar', state([])).map((p) => p.id);
    expect(toolbar).toContain('roi.toggle');
    expect(toolbar).not.toContain('core.brush');
    expect(listPanels('right-sidebar', state([])).map((p) => p.id)).toEqual([]);
    expect(listPanels('right-sidebar', state([ROI_MODE])).map((p) => p.id)).toEqual(['roi.panel']);
    expect(listPanels('cell').map((p) => p.id)).toContain('roi.table');
  });
});

describe('schema → 表單', () => {
  const op: OpDescriptor = {
    op: 'demo',
    label: 'demo',
    description: '',
    paramsSchema: {
      type: 'object',
      required: ['seed_ijk', 'hu_range'],
      properties: {
        per_slice: { type: 'boolean', default: false, title: '逐層', 'x-ui-widget': 'boolean' },
        sigma_mm: { type: 'number', default: 1.5, title: 'σ', 'x-ui-widget': 'number' },
        mode: { type: 'string', enum: ['union', 'subtract'], default: 'union', title: '方式', 'x-ui-widget': 'enum' },
        seed_ijk: { type: 'array', title: '種子', 'x-ui-widget': 'seed' },
        hu_range: { type: 'array', title: 'HU', 'x-ui-widget': 'hu-range' },
        keep_largest_n: { type: 'integer', title: 'n' },
        other: { type: 'string', enum: ['a'] },
      },
    },
  };
  it('欄位：widget 由 x-ui-widget 決定、沒有就推斷；單位由名字推；必填標記', () => {
    const f = fieldsOf(op);
    expect(f.map((x) => x.widget)).toEqual(['boolean', 'number', 'enum', 'seed', 'hu-range', 'integer', 'enum']);
    expect(f[1]!.unit).toBe('mm');
    expect(f.filter((x) => x.required).map((x) => x.name)).toEqual(['seed_ijk', 'hu_range']);
  });
  it('預設參數：schema default、boolean false、hu-range 軟組織、enum 第一個；必填檢查', () => {
    const d = defaultParams(op);
    expect(d).toEqual({ per_slice: false, sigma_mm: 1.5, mode: 'union', hu_range: [-200, 300], other: 'a' });
    expect(missingRequired(op, d)).toEqual(['種子']);
    expect(missingRequired(op, { ...d, seed_ijk: [1, 2, 3] })).toEqual([]);
  });
  it('顏色輪替與十六進位；TG-263 文字', () => {
    expect(nextColor([])).toEqual(STRUCTURE_COLORS[0]);
    expect(nextColor([STRUCTURE_COLORS[0]!])).toEqual(STRUCTURE_COLORS[1]);
    expect(rgbHex([255, 0, 128])).toBe('#ff0080');
    expect(hexRgb('#ff0080')).toEqual([255, 0, 128]);
    expect(hexRgb('bad')).toEqual([255, 0, 0]);
    expect(tg263Text({ matched: 'ptv', suggestion: 'PTV_<dose>' })).toContain('TG-263 建議：PTV_<dose>');
    expect(tg263Text(null)).toBe('');
    expect(tg263Text({})).toBe('');
    // 「採用」只給單一個具體名稱；不從翻譯後的句子裡抓（英文介面沒有「建議：」）
    expect(tg263Adoptable({ matched: 'cord', suggestion: 'SpinalCord' })).toBe('SpinalCord');
    expect(tg263Adoptable({ matched: 'ptv', suggestion: 'PTV_<dose>' })).toBeNull();
    expect(tg263Adoptable({ matched: 'lung', suggestion: 'Lung_L / Lung_R / Lungs' })).toBeNull();
    expect(tg263Adoptable({ matched: null, suggestion: null })).toBeNull();
    expect(tg263Adoptable(null)).toBeNull();
  });
});
