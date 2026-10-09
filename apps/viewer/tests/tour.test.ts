/** 導覽步驟與完成狀態。 */
import { describe, expect, it } from 'vitest';

import { availableSteps, firstTarget, markTourDone, TASK_DRAW_STEPS, TASK_OPEN_STEPS, TOUR_STEPS, TOUR_STORAGE_KEY, tourDone } from '../src/react/help/tour';

describe('tour', () => {
  it('找不到目標的步驟跳過；多個選取器取第一個找得到的', () => {
    const present = new Set(['.bar-group-task', '.sidebar-left', '.app-body']);
    const steps = availableSteps(TOUR_STEPS, (sel) => present.has(sel));
    expect(steps.map((s) => s.id)).toEqual(['task', 'left', 'viewports']);
    expect(firstTarget(steps[1]!, (sel) => present.has(sel))).toBe('.sidebar-left');
    expect(availableSteps(TOUR_STEPS, () => true).length).toBe(TOUR_STEPS.length);
  });
  it('完成狀態存 localStorage；讀不到就當作看過', () => {
    const store = new Map<string, string>();
    const fake = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) };
    expect(tourDone(fake)).toBe(false);
    markTourDone(fake);
    expect(tourDone(fake)).toBe(true);
    expect(store.get(TOUR_STORAGE_KEY)).toBe('done');
    expect(tourDone({ getItem: () => { throw new Error('private'); } })).toBe(true);
    expect(tourDone(null)).toBe(false);
  });
  it('任務引導 —— 畫結構 4 步、開病例 3 步；id 不重複；畫筆那一步 ROI 面板沒開時退回工具列', () => {
    expect(TASK_DRAW_STEPS.map((s) => s.id)).toEqual(['draw-pick', 'draw-roi', 'draw-brush', 'draw-saved']);
    expect(TASK_OPEN_STEPS.map((s) => s.id)).toEqual(['open-pick', 'open-check', 'open-go']);
    const ids = [...TOUR_STEPS, ...TASK_DRAW_STEPS, ...TASK_OPEN_STEPS].map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
    const brush = TASK_DRAW_STEPS[2]!;
    expect(firstTarget(brush, (sel) => sel === '.bar-group-tool')).toBe('.bar-group-tool');
    expect(firstTarget(brush, (sel) => sel === '.roi-panel .slab-presets' || sel === '.bar-group-tool')).toBe('.roi-panel .slab-presets');
  });
});
