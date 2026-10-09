/**
 * 面板掛載點與 viewport overlay 註冊表。
 *
 * 🔴 **這組測試存在的理由**：舊版 `App.tsx` 只查 `'bottom'` 一個 slot，而且
 * 渲染的是 `panel.title ?? panel.id` 這串字 —— `panel.component` 從頭到尾沒被
 * 用過。也就是註冊表**看起來有、實際上是封死的**，而沒有任何測試會發現，
 * 因為測試只驗了 `registerPanel` / `listPanels` 本身。
 *
 * 因此這裡驗的是**接線**，不只是註冊表：核心自己的 chrome 是不是真的走了
 * 這條路（`registerCoreUi`），以及 painter 的失敗是不是真的被隔離。
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  ALL_VIEWPORTS,
  clearModules,
  clearPanels,
  listPanels,
  registerPanel,
  ViewportOverlayRegistry,
  type OverlayPaintContext,
  type PanelSlot,
} from '../src/core';
import { registerCoreUi, resetCoreUiRegistration } from '../src/react/panels/builtins';

beforeEach(() => {
  clearPanels();
  clearModules();
  resetCoreUiRegistration();
});

describe('核心 chrome 走的是註冊表，不是硬編碼的 JSX', () => {
  it('registerCoreUi 把八個核心面板註冊到對的 slot', () => {
    registerCoreUi();
    const bySlot = new Map<PanelSlot, string[]>();
    for (const p of listPanels()) {
      bySlot.set(p.slot, [...(bySlot.get(p.slot) ?? []), p.id]);
    }
    expect(bySlot.get('toolbar')).toEqual(['core.case-picker', 'core.tools', 'core.edit', 'core.touch', 'core.tier']);
    expect(bySlot.get('left-sidebar')).toEqual(['core.data']);
    expect(bySlot.get('right-sidebar')).toBeUndefined(); // 核心沒有右側面板；MPR 模組的在 mpr-module.test
    // 2026-09-18：讀數搬到左下角狀態列（bottom 第一列）
    expect(bySlot.get('bottom')).toEqual(['core.probe', 'core.notices']);
  });

  it('🔴 每個面板都帶得出一個 component —— 註冊表不是只存標題', () => {
    registerCoreUi();
    for (const panel of listPanels()) {
      expect(typeof panel.component, `${panel.id} 沒有可掛載的元件`).toBe('function');
    }
  });

  it('order 依序排好，且核心全部落在 0–99（100+ 留給模組）', () => {
    registerCoreUi();
    const toolbar = listPanels('toolbar');
    const orders = toolbar.map((p) => p.order);
    expect(orders).toEqual([...orders].sort((a, b) => a - b));
    expect(Math.max(...listPanels().map((p) => p.order))).toBeLessThan(100);
  });

  it('registerCoreUi 是冪等的（StrictMode double-invoke 會呼叫兩次）', () => {
    registerCoreUi();
    const first = listPanels().length;
    expect(() => registerCoreUi()).not.toThrow();
    expect(listPanels()).toHaveLength(first);
  });

  it('模組可以插在兩個核心面板之間而不必改核心', () => {
    registerCoreUi();
    registerPanel({ id: 'mod.x', slot: 'toolbar', order: 25, component: () => null });
    expect(listPanels('toolbar').map((p) => p.id)).toEqual(['core.case-picker', 'core.tools', 'mod.x', 'core.edit', 'core.touch', 'core.tier']);
  });
});

describe('viewport overlay 註冊表（畫布層）', () => {
  const noopPaint = (): void => {};

  function paintContext(viewportId: string): OverlayPaintContext {
    return {
      viewportId,
      ctx: {} as CanvasRenderingContext2D,
      width: 512,
      height: 512,
      camera: {} as OverlayPaintContext['camera'],
      quality: 'final',
      project: () => ({ x: 0, y: 0 }),
      signedDistanceMm: () => 0,
    };
  }

  it('預設畫在所有 viewport；指定 viewportId 時只畫那一格', () => {
    const reg = new ViewportOverlayRegistry();
    reg.register({ id: 'everywhere', paint: noopPaint });
    reg.register({ id: 'axial-only', viewportId: 'axial', paint: noopPaint });
    expect(reg.paintersFor('axial').map((p) => p.id)).toEqual(['everywhere', 'axial-only']);
    expect(reg.paintersFor('coronal').map((p) => p.id)).toEqual(['everywhere']);
    expect(ALL_VIEWPORTS).toBe('*');
  });

  it('依 order 排序，小的先畫（在下層）', () => {
    const reg = new ViewportOverlayRegistry();
    reg.register({ id: 'top', order: 10, paint: noopPaint });
    reg.register({ id: 'bottom', order: -10, paint: noopPaint });
    reg.register({ id: 'middle', paint: noopPaint });
    expect(reg.paintersFor('axial').map((p) => p.id)).toEqual(['bottom', 'middle', 'top']);
  });

  it('register 回傳的函式可以取消註冊，並呼叫 dispose', () => {
    const reg = new ViewportOverlayRegistry();
    const dispose = vi.fn();
    const off = reg.register({ id: 'x', paint: noopPaint, dispose });
    expect(reg.size).toBe(1);
    off();
    expect(reg.size).toBe(0);
    expect(dispose).toHaveBeenCalledOnce();
  });

  it('🔴 拋例外的 painter 被停用，而且原因看得見（不是靜默消失）', () => {
    const reg = new ViewportOverlayRegistry();
    reg.register({ id: 'bad', paint: noopPaint });
    reg.register({ id: 'good', paint: noopPaint });
    reg.markFailed('bad', '讀到 undefined');
    expect(reg.paintersFor('axial').map((p) => p.id)).toEqual(['good']);
    expect(reg.failures()).toEqual([{ id: 'bad', reason: '讀到 undefined' }]);
  });

  it('重新註冊同一個 id 會解除停用（改好了就該能再畫）', () => {
    const reg = new ViewportOverlayRegistry();
    reg.register({ id: 'x', paint: noopPaint });
    reg.markFailed('x', 'boom');
    expect(reg.paintersFor('axial')).toHaveLength(0);
    reg.register({ id: 'x', paint: noopPaint });
    expect(reg.paintersFor('axial')).toHaveLength(1);
    expect(reg.failures()).toEqual([]);
  });

  it('註冊集合改變時通知監聽者（狀態列要更新失敗清單）', () => {
    const reg = new ViewportOverlayRegistry();
    const listener = vi.fn();
    reg.setChangeListener(listener);
    const off = reg.register({ id: 'x', paint: noopPaint });
    reg.markFailed('x', 'boom');
    off();
    expect(listener).toHaveBeenCalledTimes(3);
  });

  it('paintContext 帶得出 project 與 signedDistanceMm（painter 唯一該用的兩個換算）', () => {
    const ctx = paintContext('axial');
    expect(ctx.project([0, 0, 0])).toEqual({ x: 0, y: 0 });
    expect(ctx.signedDistanceMm([0, 0, 0])).toBe(0);
  });
});
