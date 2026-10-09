/**
 * 觸控裝置上，長按有 `title` 的東西 → 顯示那段說明。
 *
 * 介面上有三百多處 `title` 說明（按鈕在做什麼、為什麼停用），滑鼠停一下就看得到；觸控沒有「停留」，
 * 這些說明在手機與平板上原本完全看不到。長按顯示、放開後那一下**不算點擊**（不然長按「刪除」看說明就刪掉了）。
 * 影像格本身不處理（那裡的長按是十字線，`core/interaction/touchGestures.ts`）。
 */

import { useEffect, useState } from 'react';

const LONG_PRESS_MS = 500;
const SLOP_PX = 10;

interface Bubble {
  readonly text: string;
  readonly x: number;
  readonly y: number;
}

export function TouchTitles(): React.JSX.Element | null {
  const [bubble, setBubble] = useState<Bubble | null>(null);
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    let start: { x: number; y: number } | null = null;
    let shown = false;
    const clear = (): void => {
      if (timer !== null) clearTimeout(timer);
      timer = null;
      start = null;
    };
    const swallowClick = (e: Event): void => {
      e.preventDefault();
      e.stopPropagation();
    };
    const onDown = (e: PointerEvent): void => {
      if (e.pointerType !== 'touch') return;
      shown = false;
      setBubble(null);
      const el = (e.target as Element | null)?.closest?.('[title]') as HTMLElement | null;
      if (!el || el.closest('.viewport-canvas-host')) return;
      const text = el.getAttribute('title') ?? '';
      if (text.trim() === '') return;
      start = { x: e.clientX, y: e.clientY };
      timer = setTimeout(() => {
        const r = el.getBoundingClientRect();
        shown = true;
        setBubble({ text, x: r.left + r.width / 2, y: r.top });
      }, LONG_PRESS_MS);
    };
    const onMove = (e: PointerEvent): void => {
      if (start === null || e.pointerType !== 'touch') return;
      if (Math.hypot(e.clientX - start.x, e.clientY - start.y) > SLOP_PX) clear();
    };
    const onUp = (e: PointerEvent): void => {
      if (e.pointerType !== 'touch') return;
      clear();
      if (shown) {
        // 長按看說明 → 放開的這一下不要變成點擊；說明留 2.5 秒
        window.addEventListener('click', swallowClick, { capture: true, once: true });
        setTimeout(() => window.removeEventListener('click', swallowClick, { capture: true }), 400);
        setTimeout(() => setBubble(null), 2500);
      }
    };
    const onContext = (e: Event): void => {
      if (shown || timer !== null) e.preventDefault();
    };
    document.addEventListener('pointerdown', onDown, true);
    document.addEventListener('pointermove', onMove, true);
    document.addEventListener('pointerup', onUp, true);
    document.addEventListener('pointercancel', onUp, true);
    document.addEventListener('contextmenu', onContext, true);
    return () => {
      clear();
      document.removeEventListener('pointerdown', onDown, true);
      document.removeEventListener('pointermove', onMove, true);
      document.removeEventListener('pointerup', onUp, true);
      document.removeEventListener('pointercancel', onUp, true);
      document.removeEventListener('contextmenu', onContext, true);
    };
  }, []);
  if (bubble === null) return null;
  const width = Math.min(280, window.innerWidth - 16);
  const left = Math.max(8, Math.min(window.innerWidth - width - 8, bubble.x - width / 2));
  const above = bubble.y > 120;
  return (
    <div
      className="touch-title"
      role="tooltip"
      style={{ left, width, ...(above ? { bottom: window.innerHeight - bubble.y + 6 } : { top: bubble.y + 40 }) }}
      onClick={() => setBubble(null)}
    >
      {bubble.text}
    </div>
  );
}
