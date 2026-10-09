/**
 * 等劑量線預設（自動等距、我的預設、% 處方）、線色覆寫、面板文字、圖例、偏好讀寫。
 */

import { afterEach, describe, expect, it } from 'vitest';

import type { Layer } from '../src/core/layers/types';
import { registerBuiltinColormaps } from '../src/core/raster/colormaps';
import {
  AUTO_ISODOSE_MAX_LINES,
  autoIsodoseLevelsGy,
  DEFAULT_ISODOSE_PERCENTS,
  doseDisplayOf,
  getUserIsodoseDefault,
  isodoseColor,
  levelKey,
  setUserIsodoseDefault,
} from '../src/core/raster/doseModule';
import { hexOf, legendEntries } from '../src/react/panels/DoseLegend';
import { isodoseLevelsText, percentsOf } from '../src/react/panels/doseLevels';
import { ISODOSE_PREF_KEY, applyIsodoseDefault, parseIsodoseDefault, saveIsodoseDefault } from '../src/react/prefs/isodoseDefault';

registerBuiltinColormaps();

const dose = (params: Record<string, unknown>): Layer =>
  ({ layerId: 'd', kind: 'dose', contentRef: 'd', visible: true, opacity: 0.5, params }) as unknown as Layer;

afterEach(() => setUserIsodoseDefault(null));

describe('自動等距（沒處方）', () => {
  it('單次分次劑量 2.24 Gy → 0.2 Gy 間距 11 條（整數 Gy 只會有 2 條）', () => {
    const lv = autoIsodoseLevelsGy(2.24);
    expect(lv).toHaveLength(11);
    expect(lv[0]).toBeCloseTo(2.2);
    expect(lv.at(-1)).toBeCloseTo(0.2);
  });
  it('療程 22.17 Gy → 2 Gy 間距；80 Gy → 10 Gy；線數不超過上限、都 < Dmax', () => {
    expect(autoIsodoseLevelsGy(22.17)).toEqual([22, 20, 18, 16, 14, 12, 10, 8, 6, 4, 2]);
    expect(autoIsodoseLevelsGy(80)).toEqual([70, 60, 50, 40, 30, 20, 10]);
    for (const m of [0.3, 1, 7.7, 30, 49.9, 75, 150]) {
      const lv = autoIsodoseLevelsGy(m);
      expect(lv.length).toBeGreaterThan(0);
      expect(lv.length).toBeLessThanOrEqual(AUTO_ISODOSE_MAX_LINES);
      expect(Math.max(...lv)).toBeLessThan(m);
    }
    expect(autoIsodoseLevelsGy(0)).toEqual([]);
  });
});

describe('doseDisplayOf 的預設來源', () => {
  it('沒處方 → auto；有處方 → % 處方；自己設過 → custom', () => {
    expect(doseDisplayOf(dose({ max_gy: 2.24 })).levelSource).toBe('auto');
    expect(doseDisplayOf(dose({ max_gy: 2.24 })).levelsGy).toHaveLength(11);
    const rx = doseDisplayOf(dose({ max_gy: 22.17, prescription_gy: [20] }));
    expect(rx.levelSource).toBe('prescription');
    expect(rx.levelsGy).toEqual([...DEFAULT_ISODOSE_PERCENTS].map((p) => (20 * p) / 100));
    expect(doseDisplayOf(dose({ max_gy: 22.17, levels: [10, 5] })).levelSource).toBe('custom');
    // 沒處方但用 % 顯示（例：相對劑量）→ 仍用 % 清單（以 Dmax 為 100%）
    expect(doseDisplayOf(dose({ max_gy: 100, display: 'percent' })).levelSource).toBe('prescription');
  });
  it('我的預設（%）優先於內建，自己設過的仍優先於我的預設', () => {
    setUserIsodoseDefault([100, 50]);
    const a = doseDisplayOf(dose({ max_gy: 22.17, prescription_gy: [20] }));
    expect(a.levelSource).toBe('user-default');
    expect(a.levelsGy).toEqual([20, 10]);
    const noRx = doseDisplayOf(dose({ max_gy: 2.24 }));
    expect(noRx.levelsGy[0]).toBeCloseTo(2.24); // 沒處方 → 以 Dmax 為參考
    expect(doseDisplayOf(dose({ max_gy: 22.17, levels: [7] })).levelsGy).toEqual([7]);
  });
});

describe('等劑量線線色', () => {
  it('覆寫的顏色優先；沒覆寫照色階；壞掉的顏色忽略', () => {
    const base = doseDisplayOf(dose({ max_gy: 22.17, prescription_gy: [20] }));
    const plain = isodoseColor(base, 20);
    const d = doseDisplayOf(dose({ max_gy: 22.17, prescription_gy: [20], level_colors: { [levelKey(20)]: '#00ff7f', [levelKey(10)]: 'red' } }));
    expect(isodoseColor(d, 20)).toEqual([0, 255, 127]);
    expect(isodoseColor(d, 10)).toEqual(isodoseColor(base, 10));
    expect(plain).not.toEqual([0, 255, 127]);
  });
  it('圖例：Gy 模式顯示 Gy、% 模式顯示 %；標出改過的', () => {
    const d = doseDisplayOf(dose({ max_gy: 22.17, prescription_gy: [20], levels: [20, 10], level_colors: { [levelKey(20)]: '#112233' } }));
    const e = legendEntries(d);
    expect(e.map((x) => x.text)).toEqual(['20 Gy', '10 Gy']);
    expect(e[0]).toMatchObject({ hex: '#112233', custom: true });
    expect(e[1]!.custom).toBe(false);
    const p = legendEntries(doseDisplayOf(dose({ max_gy: 22.17, prescription_gy: [20], display: 'percent', levels: [100, 95] })));
    expect(p.map((x) => x.text)).toEqual(['100%', '95%']);
    expect(hexOf([255, 0, 7.6])).toBe('#ff0008');
  });
});

describe('面板文字與偏好', () => {
  it('percentsOf 取到 0.1；level 欄位：自訂照原樣、% 取整數、小於 1 Gy 取到 0.01', () => {
    expect(percentsOf({ levelsGy: [19, 10], referenceGy: 20 })).toEqual([95, 50]);
    expect(percentsOf({ levelsGy: [1], referenceGy: 0 })).toEqual([]);
    expect(isodoseLevelsText({ levelsGy: [1], referenceGy: 1, display: 'absolute' }, { levels: [3, 1.5] })).toBe('3,1.5');
    expect(isodoseLevelsText({ levelsGy: [19, 10], referenceGy: 20, display: 'percent' }, {})).toBe('95,50');
    expect(isodoseLevelsText({ levelsGy: [2.2, 0.4], referenceGy: 2.24, display: 'absolute' }, {})).toBe('2.2,0.4');
  });
  it('存：去重、由高到低、取到 0.1、同時設進核心；清：刪偏好、核心回 null；讀：壞資料當沒有', () => {
    const mem = new Map<string, string>();
    const st = { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => void mem.set(k, v), removeItem: (k: string) => void mem.delete(k) };
    saveIsodoseDefault([50, 100, 95.04, 50], st);
    expect(JSON.parse(mem.get(ISODOSE_PREF_KEY)!)).toEqual({ percents: [100, 95, 50] });
    expect(getUserIsodoseDefault()).toEqual([100, 95, 50]);
    setUserIsodoseDefault(null);
    expect(applyIsodoseDefault(st)).toEqual([100, 95, 50]);
    expect(getUserIsodoseDefault()).toEqual([100, 95, 50]);
    saveIsodoseDefault(null, st);
    expect(mem.has(ISODOSE_PREF_KEY)).toBe(false);
    expect(getUserIsodoseDefault()).toBeNull();
    expect(parseIsodoseDefault('{oops')).toBeNull();
    expect(parseIsodoseDefault(JSON.stringify({ percents: ['a', -1] }))).toBeNull();
  });
});
