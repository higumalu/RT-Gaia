/**
 * 鍵盤與對話框的原始碼守衛（沒有 jsdom；做法同 `structure-list.test.ts`）：
 * 三個對話框都走共用 `Dialog`（焦點鎖、Esc、aria-modal、回焦點）；品牌選單有方向鍵；側欄把手可聚焦；結構列可用鍵盤選。
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath, URL } from 'node:url';

import { describe, expect, it } from 'vitest';

const read = (p: string): string => readFileSync(fileURLToPath(new URL(p, import.meta.url)), 'utf8');

describe('共用 Dialog', () => {
  const dialog = read('../src/react/components/Dialog.tsx');
  it('有 aria-modal、Escape、Tab 焦點鎖、關閉回焦點', () => {
    expect(dialog).toContain('aria-modal="true"');
    expect(dialog).toContain("e.key === 'Escape'");
    expect(dialog).toContain("e.key !== 'Tab'");
    expect(dialog).toContain('opener.current');
  });
  it('送到節點／移除／合併三個對話框都用它，且取消鍵是初始焦點', () => {
    for (const p of ['../src/react/data/SendDialog.tsx', '../src/react/data/DeleteDialog.tsx', '../src/react/collab/MergeDialog.tsx']) {
      const src = read(p);
      expect(src).toContain('<Dialog ');
      expect(src).toContain('data-autofocus');
      expect(src).not.toContain('role="dialog"'); // 交給 Dialog
    }
  });
});

describe('鍵盤', () => {
  it('品牌選單：ArrowDown 開啟／移動、Escape 回到按鈕', () => {
    const src = read('../src/react/components/AppNav.tsx');
    expect(src).toContain("e.key === 'ArrowDown'"); // 按鈕上 ↓ 開啟
    // 選單內的移動與 Esc 還焦點改用共用的 useMenuKeyboard（triggerRef ＝ 品牌按鈕）
    expect(src).toMatch(/useMenuKeyboard\(\{[\s\S]{0,120}triggerRef: buttonRef/);
    const hook = read('../src/react/components/useMenuKeyboard.ts');
    expect(hook).toContain('triggerRef?.current?.focus()');
    expect(hook).toContain("case 'ArrowDown'");
  });
  it('側欄把手：可聚焦、有 aria-value*、←／→ 調寬', () => {
    const src = read('../src/react/components/Sidebar.tsx');
    expect(src).toContain('tabIndex={0}');
    expect(src).toContain('aria-valuemin');
    expect(src).toContain("e.key === 'ArrowRight'");
  });
  it('結構列：Enter／Space 設為編輯對象', () => {
    const src = read('../src/react/components/StructureList.tsx');
    expect(src).toMatch(/onKeyDown=\{\(e\) => \{[\s\S]{0,200}e\.key === 'Enter'/);
  });
});
