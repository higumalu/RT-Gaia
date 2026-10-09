/**
 * 共用對話框：`role=dialog aria-modal`、Escape 關閉、焦點鎖在對話框內、
 * 開啟時焦點放在「安全」的元素（預設第一個 `[data-autofocus]`，否則第一個可聚焦元素）、關閉後焦點回到開啟它的元素。
 * 三個對話框（送到節點、移除、合併）都用它；`busy` 時 Escape 與點背景都不關（避免中途取消造成狀態不明）。
 */

import { useEffect, useRef, type ReactNode } from 'react';

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export function Dialog(props: { label: string; className?: string; busy?: boolean; onClose: () => void; children: ReactNode }): React.JSX.Element {
  const ref = useRef<HTMLDivElement>(null);
  const opener = useRef<Element | null>(null);
  const { onClose, busy } = props;

  useEffect(() => {
    opener.current = document.activeElement;
    const root = ref.current;
    if (root) {
      const first = root.querySelector<HTMLElement>('[data-autofocus]') ?? root.querySelector<HTMLElement>(FOCUSABLE);
      first?.focus();
    }
    return () => {
      const el = opener.current;
      if (el instanceof HTMLElement && document.contains(el)) el.focus();
    };
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        if (!busy) {
          e.preventDefault();
          onClose();
        }
        return;
      }
      if (e.key !== 'Tab' || !ref.current) return;
      // 焦點鎖：Tab 到最後一個回第一個，Shift+Tab 反過來
      const items = [...ref.current.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((el) => el.offsetParent !== null);
      if (items.length === 0) return;
      const first = items[0]!;
      const last = items[items.length - 1]!;
      const active = document.activeElement;
      if (!e.shiftKey && (active === last || !ref.current.contains(active))) {
        e.preventDefault();
        first.focus();
      } else if (e.shiftKey && (active === first || !ref.current.contains(active))) {
        e.preventDefault();
        last.focus();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, busy]);

  return (
    <div className="dialog-backdrop" onClick={busy ? undefined : onClose}>
      <div ref={ref} className={`dialog ${props.className ?? ''}`.trim()} role="dialog" aria-modal="true" aria-label={props.label} onClick={(e) => e.stopPropagation()}>
        {props.children}
      </div>
    </div>
  );
}
