/**
 * 下拉選單的鍵盤與關閉行為，**所有 `role="menu"` 共用一份**。
 *
 * 以前各寫各的：品牌選單只找 `[role="menuitem"]`，語言項目是 `menuitemradio` → 方向鍵與 End 跳過它們；
 * 說明選單只有 Esc、沒有方向鍵與開啟時的焦點；Plugins 選單又是另一套。現在一致：
 * 開啟 → 焦點到第一項（或 `initial` 指定的那項）；↑／↓ 循環、Home／End；Esc 關閉並把焦點還給觸發鈕；點外面關閉。
 * 項目包含 `menuitem`、`menuitemradio`、`menuitemcheckbox`，跳過 disabled 與 `aria-disabled="true"`。
 */

import { useEffect, type RefObject } from 'react';

export const MENU_ITEM_SELECTOR = '[role="menuitem"], [role="menuitemradio"], [role="menuitemcheckbox"]';

/** 純換算：按了 `key`、目前在第 `current` 項（-1 ＝ 不在選單裡）、共 `count` 項 → 下一項；不是選單鍵回 null。 */
export function nextMenuIndex(key: string, current: number, count: number): number | null {
  if (count <= 0) return null;
  switch (key) {
    case 'ArrowDown':
      return current < 0 ? 0 : (current + 1) % count;
    case 'ArrowUp':
      return current < 0 ? count - 1 : (current - 1 + count) % count;
    case 'Home':
      return 0;
    case 'End':
      return count - 1;
    default:
      return null;
  }
}

export function menuItemsIn(root: HTMLElement | null, selector: string = MENU_ITEM_SELECTOR): HTMLElement[] {
  if (root === null) return [];
  return [...root.querySelectorAll<HTMLElement>(selector)].filter(
    (el) => !(el as HTMLButtonElement).disabled && el.getAttribute('aria-disabled') !== 'true',
  );
}

export function useMenuKeyboard(args: {
  open: boolean;
  /** 包住觸發鈕與選單的容器（點外面 ＝ 點在它外面）。 */
  rootRef: RefObject<HTMLElement | null>;
  triggerRef?: RefObject<HTMLElement | null>;
  close: () => void;
  /** 開啟時先聚焦哪一項（例：目前頁）；沒給或找不到 → 第一項。 */
  initial?: (items: HTMLElement[]) => HTMLElement | undefined;
  selector?: string;
}): void {
  const { open, rootRef, triggerRef, close, initial, selector } = args;
  useEffect(() => {
    if (!open) return undefined;
    const items = menuItemsIn(rootRef.current, selector);
    (initial?.(items) ?? items[0])?.focus();
    const onDown = (e: PointerEvent): void => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) close();
    };
    const onKey = (e: KeyboardEvent): void => {
      // 焦點不在這個選單（例：開著卻去別處打字）就不攔
      if (!rootRef.current?.contains(document.activeElement)) return;
      if (e.key === 'Escape') {
        e.preventDefault();
        close();
        triggerRef?.current?.focus();
        return;
      }
      const list = menuItemsIn(rootRef.current, selector);
      const next = nextMenuIndex(e.key, list.indexOf(document.activeElement as HTMLElement), list.length);
      if (next === null) return;
      e.preventDefault();
      list[next]?.focus();
    };
    window.addEventListener('pointerdown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('pointerdown', onDown);
      window.removeEventListener('keydown', onKey);
    };
    // 只在開關時重掛；close／initial 每次 render 都是新參考
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
}
