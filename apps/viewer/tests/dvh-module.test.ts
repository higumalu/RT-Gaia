/**
 * DVH 模組：註冊／可見性、查詢路徑、曲線 → 畫布座標、刻度。
 */

import { beforeEach, describe, expect, it } from 'vitest';

import { clearModules, clearPanels, listModules, listPanels, type PanelVisibilityState } from '../src/core';
import {
  curveToCanvas,
  dashFor,
  DVH_MODE,
  dvhPath,
  niceStep,
  plotBox,
  registerDvhModule,
  resetDvhModuleRegistration,
  ticks,
} from '../src/react/modules/dvh';
import { registerCoreUi, resetCoreUiRegistration } from '../src/react/panels/builtins';
import {
  curveAlpha,
  dvhCurvesCsv,
  dvhExportFileName,
  dvhFullCsv,
  fmtGy,
  nearestCurve,
  toggleFocus,
  volumeAtDose,
  type DvhResponse,
  type DvhStructure,
} from '../src/react/modules/dvh/model';

const state = (modes: string[], hasDoseLayer = true): PanelVisibilityState => ({
  tier: 'C',
  selectedLayerIds: [],
  hasTemporalLayer: false,
  hasSecondarySeries: true,
  hasDoseLayer,
  layoutId: '2x2',
  modes,
});

describe('DVH 模組', () => {
  beforeEach(() => {
    clearPanels();
    clearModules();
    resetCoreUiRegistration();
    resetDvhModuleRegistration();
    registerCoreUi();
    registerDvhModule();
  });

  it('registerModule（apiNamespace dose）；開關只在有劑量 layer 時；面板只在 dvh 模式時', () => {
    const m = listModules().find((x) => x.id === 'rt-gaia-dvh');
    expect(m?.version).toBe('0.2.0');
    expect(m?.apiNamespace).toBe('dose');
    expect(listPanels('toolbar', state([])).map((p) => p.id)).toContain('dvh.toggle');
    expect(listPanels('toolbar', state([], false)).map((p) => p.id)).not.toContain('dvh.toggle');
    expect(listPanels('right-sidebar', state([])).map((p) => p.id)).toEqual([]);
    expect(listPanels('right-sidebar', state([DVH_MODE])).map((p) => p.id)).toEqual(['dvh.settings']);
    // 圖是可放格子的面板：不在側欄、在 cell
    expect(listPanels('cell').map((p) => p.id)).toEqual(['dvh.chart']);
    expect(listPanels('right-sidebar', state([DVH_MODE])).map((p) => p.id)).not.toContain('dvh.chart');
    expect(() => registerDvhModule()).not.toThrow();
  });
});

describe('DVH 純邏輯', () => {
  it('查詢路徑：結構逗號分隔、bins、reference_gy 只在 > 0 時帶', () => {
    expect(dvhPath('s1', ['a', 'b'], { bins: 100, referenceGy: 50 })).toBe('/dose/s1/dvh?structure_ids=a%2Cb&bins=100&reference_gy=50');
    expect(dvhPath('s 1', ['a'], { referenceGy: 0 })).toBe('/dose/s%201/dvh?structure_ids=a&bins=200');
    expect(dvhPath('s1', ['a'], { referenceGy: null })).not.toContain('reference_gy');
  });

  it('曲線 → 畫布：x 依 Gy 線性、y 100% 在頂、0% 在底', () => {
    const box = plotBox(236, 220);
    expect(box.left).toBe(36);
    const pts = curveToCanvas([0, 25, 50], [100, 50, 0], box, 50);
    expect(pts[0]).toEqual([box.left, box.top]);
    expect(pts[1]![0]).toBeCloseTo(box.left + box.width / 2);
    expect(pts[1]![1]).toBeCloseTo(box.top + box.height / 2);
    expect(pts[2]).toEqual([box.left + box.width, box.top + box.height]);
    // xMax 0 不除以零
    expect(curveToCanvas([0], [100], box, 0)).toEqual([[box.left, box.top]]);
  });

  it('刻度：1／2／5 × 10ⁿ，4–8 格；線型循環', () => {
    expect(niceStep(50)).toBe(10);
    expect(niceStep(7)).toBe(2);
    expect(niceStep(0.9)).toBe(0.2);
    expect(ticks(50)).toEqual([0, 10, 20, 30, 40, 50]);
    expect(ticks(0)).toEqual([0]);
    expect(dashFor(0)).toEqual([]);
    expect(dashFor(1)).toEqual([6, 3]);
    expect(dashFor(4)).toEqual([]);
  });
});

describe('模組狀態袋 → DVH 選擇', () => {
  const L = (kind: string, contentRef: string, visible: boolean) => ({ kind, contentRef, visible });
  const layers = [L('dose', 'd1', false), L('dose', 'd2', true), L('mask', 'm1', true), L('mask', 'm2', false), L('mask', 'm3', true)];

  it('沒設過：可見的劑量、可見的結構（最多 6）、參考 0', async () => {
    const { dvhSelection } = await import('../src/react/modules/dvh');
    expect(dvhSelection(layers, undefined)).toEqual({ doseIds: ['d2'], structureIds: ['m1', 'm3'], referenceGy: 0 });
    expect(dvhSelection([L('dose', 'd1', false), L('dose', 'd2', false)], undefined).doseIds).toEqual(['d1']);
  });

  it('帶 params 的劑量只預選 GY；RELATIVE／缺單位不預選、有說明文字', async () => {
    const { dvhSelection, isGyDose, doseUnitsOf, nonGyReason } = await import('../src/react/modules/dvh');
    const gy = { ...L('dose', 'gy', true), params: { units: 'GY' } };
    const rel = { ...L('dose', 'rel', true), params: { units: 'RELATIVE' } };
    const none = { ...L('dose', 'none', true), params: {} };
    expect(dvhSelection([rel, gy, none, L('mask', 'm', true)], undefined).doseIds).toEqual(['gy']);
    // 全是非 Gy → 沒有預選（不會退回「第一個」）
    expect(dvhSelection([rel, none], undefined).doseIds).toEqual([]);
    expect(isGyDose(gy)).toBe(true);
    expect(isGyDose(rel)).toBe(false);
    expect(doseUnitsOf({ params: { units: ' gy ' } })).toBe('GY');
    expect(nonGyReason(rel)).toContain('RELATIVE');
    expect(nonGyReason(none)).toContain('(缺)');
  });

  it('設過的照設的 —— 空陣列也算設過；參考不為負', async () => {
    const { dvhSelection, toggleId } = await import('../src/react/modules/dvh');
    expect(dvhSelection(layers, { structureIds: [], referenceGy: -3 })).toEqual({ doseIds: ['d2'], structureIds: [], referenceGy: 0 });
    expect(dvhSelection(layers, { doseIds: ['d1', 'd2'], referenceGy: 45 }).doseIds).toEqual(['d1', 'd2']);
    expect(toggleId(['a'], 'b')).toEqual(['a', 'b']);
    expect(toggleId(['a', 'b'], 'a')).toEqual(['b']);
  });

  it('模組帶版面：dose-review 的右下格是 DVH 圖', async () => {
    const { getLayout } = await import('../src/core');
    const l = getLayout('dose-review');
    expect(l.cells[2]!.content).toEqual({ kind: 'panel', panelId: 'dvh.chart' });
  });
});

// ── 部分覆蓋、曲線互動、匯出 ───────────────────────────────────────────────

const struct = (over: Partial<DvhStructure>): DvhStructure => ({
  structure_id: 'ptv',
  name: 'PTV',
  color_rgb: [255, 0, 0],
  voxel_count: 10,
  volume_cc: 12.3456,
  outside_fraction: 0,
  partial: false,
  dmin_gy: 1,
  dmax_gy: 3,
  dmean_gy: 2,
  d98_gy: 1.1,
  d95_gy: 1.2,
  d50_gy: 2,
  d2_gy: 2.9,
  v_ref_pct: 50,
  cumulative_pct: [100, 60, 0],
  ...over,
});

const resp = (structures: DvhStructure[]): DvhResponse => ({
  series_id: 'd1',
  frame_of_reference_uid: 'for',
  bins: 2,
  dose_max_gy: 3,
  reference_gy: 2,
  edges_gy: [0, 1.5, 3],
  structures,
});

describe('DVH 補強', () => {
  it('部分覆蓋的統計是 null → 顯示「–」', () => {
    expect(fmtGy(null)).toBe('–');
    expect(fmtGy(undefined)).toBe('–');
    expect(fmtGy(1.234)).toBe('1.23');
  });

  it('強調：再點一次取消；其他曲線變淡、部分覆蓋本來就淡', () => {
    expect(toggleFocus(null, 'a')).toBe('a');
    expect(toggleFocus('a', 'a')).toBeNull();
    expect(toggleFocus('a', 'b')).toBe('b');
    expect(curveAlpha('a', null, false)).toBe(1);
    expect(curveAlpha('a', null, true)).toBe(0.5);
    expect(curveAlpha('b', 'a', false)).toBeLessThan(0.3);
    expect(curveAlpha('a', 'a', false)).toBe(1);
  });

  it('最近的曲線：在容差內才算，取最近的', () => {
    const curves = [
      { doseId: 'd', structureId: 'a', points: [[0, 0], [100, 0]] as [number, number][] },
      { doseId: 'd', structureId: 'b', points: [[0, 10], [100, 10]] as [number, number][] },
    ];
    expect(nearestCurve(curves, 50, 2)?.structureId).toBe('a');
    expect(nearestCurve(curves, 50, 8)?.structureId).toBe('b');
    expect(nearestCurve(curves, 50, 40)).toBeNull();
  });

  it('游標劑量處的體積：線性內插、超出取端點', () => {
    expect(volumeAtDose([0, 1, 2], [100, 50, 0], 0.5)).toBeCloseTo(75);
    expect(volumeAtDose([0, 1, 2], [100, 50, 0], 5)).toBe(0);
    expect(volumeAtDose([0, 1, 2], [100, 50, 0], -1)).toBe(100);
  });

  it('只有曲線的 CSV：四欄長格式、四位小數、名稱含逗號會加引號', () => {
    const csv = dvhCurvesCsv([{ doseId: 'd1', label: '06-12', response: resp([struct({ name: 'PTV, boost', cumulative_pct: [100, 33.333333, 0] })]) }]);
    const lines = csv.trim().split('\r\n');
    expect(lines[0]).toBe('structure,dose,dose_gy,volume_pct');
    expect(lines[1]).toBe('"PTV, boost",06-12,0,100');
    expect(lines[2]).toBe('"PTV, boost",06-12,1.5,33.3333');
    expect(lines).toHaveLength(4);
  });

  it('完整 CSV：匿名時沒有病歷號；部分覆蓋的統計留空並標 partial', () => {
    const doses = [{ doseId: 'd1', label: '06-12', response: resp([struct({}), struct({ structure_id: 'body', name: 'BODY', partial: true, outside_fraction: 0.2, dmin_gy: null, dmean_gy: null, d98_gy: null, d95_gy: null, d50_gy: null, d2_gy: null, v_ref_pct: null })]) }];
    const at = new Date(2026, 9, 2, 9, 5);
    const anon = dvhFullCsv(doses, { anonymized: true, patientId: 'P123', referenceGy: 2, exportedAt: at });
    expect(anon).not.toContain('P123');
    expect(anon).toContain('exported_at,2026-10-02 09:05');
    expect(anon).toContain('structure,dose,volume_cc,partial,outside_pct,dmin_gy,dmean_gy,dmax_gy,d98_gy,d95_gy,d50_gy,d2_gy,v2gy_pct');
    expect(anon).toContain('PTV,06-12,12.3456,no,0,1,2,3,1.1,1.2,2,2.9,50');
    expect(anon).toContain('BODY,06-12,12.3456,yes,20,,,3,,,,,');
    expect(anon).toContain('structure,dose,dose_gy,volume_pct');
    const named = dvhFullCsv(doses, { anonymized: false, patientId: 'P123', referenceGy: 0, exportedAt: at });
    expect(named).toContain('patient_id,P123');
    expect(named).not.toContain('v0gy_pct');
  });

  it('檔名：匿名不帶病歷號；不安全字元換掉', () => {
    const at = new Date(2026, 9, 2, 9, 5);
    expect(dvhExportFileName({ anonymized: true, patientId: 'P1', exportedAt: at }, 'csv')).toBe('DVH_20261002-0905.csv');
    expect(dvhExportFileName({ anonymized: false, patientId: 'A/B 12', exportedAt: at }, 'csv', 'curves')).toBe('DVH_A_B_12_curves_20261002-0905.csv');
    expect(dvhExportFileName({ anonymized: false, patientId: null, exportedAt: at }, 'png')).toBe('DVH_20261002-0905.png');
  });
});
