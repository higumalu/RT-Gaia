/** DRR —— 請求路徑（大小、半邊、預設、自訂窗才帶 wc／ww、結構最多 12 個）。 */

import { describe, expect, it } from 'vitest';

import { DRR_SIZE, drrPath, MAX_DRR_STRUCTURES } from '../src/react/modules/plan/model';

describe('DRR 路徑', () => {
  it('預設對比不帶窗；自訂帶 wc／ww；結構逗號分隔、最多 12 個', () => {
    const p = new URL(`http://x${drrPath('s 1', 'p', 2, { cp: 45, halfMm: 150, preset: 'high' })}`);
    expect(p.pathname).toBe('/studies/s%201/plans/p/beams/2/drr');
    expect(Object.fromEntries(p.searchParams)).toEqual({ cp: '45', size: String(DRR_SIZE), half: '150', preset: 'high' });
    const ids = Array.from({ length: 20 }, (_, i) => `st${i}`);
    const q = new URL(`http://x${drrPath('s', 'p', 2, { cp: 0, halfMm: 140, preset: 'custom', wc: 0.3, ww: 0.8, structureIds: ids })}`).searchParams;
    expect(q.get('wc')).toBe('0.3');
    expect(q.get('ww')).toBe('0.8');
    expect(q.get('structure_ids')!.split(',')).toHaveLength(MAX_DRR_STRUCTURES);
  });
});

describe('開口外框', () => {
  it('相鄰兩條帶共用的邊不畫，只剩外框', async () => {
    const { apertureOutline } = await import('../src/react/modules/plan/model');
    // 兩條帶：y 0…10 的 x −10…10、y 10…20 的 x −5…20 → 外框 8 段（共用的 y=10 只剩不重疊的兩小段）
    const segs = apertureOutline([
      { x1: -10, x2: 10, y1: 0, y2: 10 },
      { x1: -5, x2: 20, y1: 10, y2: 20 },
    ]);
    const horizontalAt10 = segs.filter((s) => s[1] === 10 && s[3] === 10).map((s) => [Math.min(s[0], s[2]), Math.max(s[0], s[2])]);
    expect(horizontalAt10.sort((a, b) => a[0]! - b[0]!)).toEqual([
      [-10, -5],
      [10, 20],
    ]);
    // 總長 ＝ 周長：下 20 ＋ 上 25 ＋ 左（10 ＋ 10）＋ 右（10 ＋ 10）＋ y=10 的兩小段（5 ＋ 10）
    const len = segs.reduce((a, s) => a + Math.hypot(s[2] - s[0], s[3] - s[1]), 0);
    expect(len).toBeCloseTo(20 + 25 + 20 + 20 + 15);
  });
});
