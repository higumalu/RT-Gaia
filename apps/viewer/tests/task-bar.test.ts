/** 任務列的純邏輯（`taskBar.ts`）：分群、任務互斥、專注影像。 */

import { describe, expect, it } from 'vitest';

import type { PanelRegistration } from '../src/core';
import { groupToolbarPanels, modeChanges, readCollapsed, TASK_MODES, toggleFocus } from '../src/react/components/taskBar';

const p = (id: string, order: number, group?: PanelRegistration['group']): PanelRegistration =>
  ({ id, slot: 'toolbar', order, component: null, ...(group ? { group } : {}) });

describe('分群', () => {
  it('依 case → task → tool → view → layout → readout → diagnostic；群內照 order；沒填的算 tool；空群不出現', () => {
    const groups = groupToolbarPanels([p('tier', 90, 'diagnostic'), p('export', 52, 'task'), p('tools', 20), p('roi', 30, 'task'), p('mpr', 45, 'view'), p('layout', 15, 'layout')]);
    expect(groups.map((g) => g.group)).toEqual(['task', 'tool', 'view', 'layout', 'diagnostic']);
    expect(groups[0]!.panels.map((x) => x.id)).toEqual(['roi', 'export']);
    expect(groups[1]!.panels.map((x) => x.id)).toEqual(['tools']);
  });
});

describe('任務互斥', () => {
  it('開一個任務 → 其他任務關；檢視模式不受影響；關閉不連帶', () => {
    expect(TASK_MODES).toContain('roi');
    expect(modeChanges(['roi', 'mpr'], 'export', true)).toEqual([{ id: 'roi', enabled: false }, { id: 'export', enabled: true }]);
    expect(modeChanges(['roi', 'mpr'], 'dvh', true)).toEqual([{ id: 'dvh', enabled: true }]);
    expect(modeChanges(['roi', 'export'], 'roi', false)).toEqual([{ id: 'roi', enabled: false }]);
    expect(modeChanges([], 'review', true)).toEqual([{ id: 'review', enabled: true }]);
  });
});

describe('側欄收合與專注影像', () => {
  it('讀取壞值 → 都展開；專注＝兩欄收，再按回到原狀', () => {
    expect(readCollapsed(null)).toEqual({ left: false, right: false });
    expect(readCollapsed('garbage')).toEqual({ left: false, right: false });
    expect(readCollapsed('{"left":true}')).toEqual({ left: true, right: false });
    const a = toggleFocus({ left: false, right: true }, null);
    expect(a.state).toEqual({ left: true, right: true });
    expect(a.remembered).toEqual({ left: false, right: true });
    const b = toggleFocus(a.state, a.remembered);
    expect(b.state).toEqual({ left: false, right: true });
    expect(b.remembered).toBeNull();
    expect(toggleFocus({ left: true, right: true }, null).state).toEqual({ left: false, right: false });
  });
});
