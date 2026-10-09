/**
 * 導覽的畫面：把目標元素框起來、旁邊放說明卡；上一步／下一步／跳過。
 * 目標找不到的步驟自動跳過（`availableSteps`）；視窗縮放時重新量位置。
 *
 * 鍵盤與焦點：
 * * **焦點**：打開時聚焦「下一步」、Tab 只在說明卡裡繞、關掉時焦點回到打開前的地方（以前沒有，焦點留在背景）。
 * * **Enter**：交給有焦點的按鈕（以前全域攔 Enter 往下一步，焦點又在「下一步」上 → 按一次跳兩步；最後一步按 Enter 也不會完成）。
 *   方向鍵左右換步、Esc 結束 —— 只在說明卡裡有效，不搶頁面上其他輸入框的鍵。
 * * 窄視窗：說明卡寬度不超過視窗。
 * * `steps`：功能介紹（預設）或任務引導（`TASK_DRAW_STEPS`、`TASK_OPEN_STEPS`）。
 */
import { useEffect, useLayoutEffect, useRef, useState } from 'react';

import { availableSteps, firstTarget, TOUR_STEPS, type TourStep } from './tour';
import { t } from '../../core/i18n';

const exists = (selector: string): boolean => document.querySelector(selector) !== null;

export function TourOverlay(props: { onFinish: () => void; steps?: readonly TourStep[]; title?: string }): React.JSX.Element | null {
  // 功能介紹：目標不在畫面上的步驟跳過（那塊介面可能沒開）。任務引導：每一步都是要做的事，一步都不跳 ——
  // 目標還沒出現（清單還在載入、面板還沒開）就把說明卡放中間，到那一步時再量一次
  const [steps] = useState<TourStep[]>(() => (props.steps === undefined ? availableSteps(TOUR_STEPS, exists) : [...props.steps]));
  const [index, setIndex] = useState(0);
  const [rect, setRect] = useState<DOMRect | null>(null);
  const cardRef = useRef<HTMLDivElement>(null);
  const primaryRef = useRef<HTMLButtonElement>(null);
  const step = steps[index] ?? null;
  const last = index >= steps.length - 1;

  useLayoutEffect(() => {
    if (step === null) return undefined;
    let scrolled: Element | null = null;
    const measure = (): void => {
      const sel = firstTarget(step, exists);
      const el = sel ? document.querySelector<HTMLElement>(sel) : null;
      if (el && el !== scrolled) {
        el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
        scrolled = el;
      }
      const r = el ? el.getBoundingClientRect() : null;
      setRect((prev) => (prev && r && prev.x === r.x && prev.y === r.y && prev.width === r.width && prev.height === r.height ? prev : r));
    };
    measure();
    window.addEventListener('resize', measure);
    // 目標晚一點才出現（清單載入、面板打開）或位置變了 → 每半秒再量一次
    const timer = window.setInterval(measure, 500);
    return () => {
      window.removeEventListener('resize', measure);
      window.clearInterval(timer);
    };
  }, [step]);

  // 打開時記住焦點、關掉時還回去；每一步把焦點放在主要按鈕上
  useEffect(() => {
    const before = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    return () => {
      if (before && document.contains(before)) before.focus();
    };
  }, []);
  useEffect(() => {
    primaryRef.current?.focus();
  }, [index]);

  if (step === null) return null;
  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>): void => {
    if (e.key === 'Escape') {
      e.preventDefault();
      props.onFinish();
    } else if (e.key === 'ArrowRight') {
      e.preventDefault();
      setIndex((i) => Math.min(steps.length - 1, i + 1));
    } else if (e.key === 'ArrowLeft') {
      e.preventDefault();
      setIndex((i) => Math.max(0, i - 1));
    } else if (e.key === 'Tab') {
      // 焦點鎖在說明卡裡
      const items = [...(cardRef.current?.querySelectorAll<HTMLElement>('button:not([disabled])') ?? [])];
      if (items.length === 0) return;
      const at = items.indexOf(document.activeElement as HTMLElement);
      const next = e.shiftKey ? (at <= 0 ? items.length - 1 : at - 1) : at === items.length - 1 ? 0 : at + 1;
      e.preventDefault();
      items[next]!.focus();
    }
  };
  const pad = 6;
  const box = rect
    ? { left: rect.left - pad, top: rect.top - pad, width: rect.width + pad * 2, height: rect.height + pad * 2 }
    : null;
  // 說明卡放在目標下方；下方放不下就放上方；靠右邊界就往左推；窄視窗不超過視窗寬
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const cardW = Math.min(340, vw - 16);
  let cardLeft = box ? Math.min(Math.max(8, box.left), vw - cardW - 8) : vw / 2 - cardW / 2;
  let cardTop = box ? box.top + box.height + 10 : vh / 2 - 80;
  if (box && cardTop + 180 > vh) cardTop = Math.max(8, box.top - 190);
  if (!Number.isFinite(cardLeft)) cardLeft = 8;
  const heading = props.title ?? t('功能導覽');
  return (
    <div className="tour-overlay" role="dialog" aria-modal="true" aria-label={t('{title} {p0}／{length}', { title: heading, p0: index + 1, length: steps.length })} data-step={step.id}>
      {box && <div className="tour-spot" style={{ left: box.left, top: box.top, width: box.width, height: box.height }} />}
      <div className="tour-card" ref={cardRef} style={{ left: cardLeft, top: cardTop, width: cardW }} onKeyDown={onKeyDown}>
        <div className="tour-progress muted small">
          {heading} · {t('{p0}／{length}', { p0: index + 1, length: steps.length })}
        </div>
        <h4>{t(step.title)}</h4>
        <p>{t(step.body)}</p>
        <div className="tour-actions">
          <button type="button" onClick={props.onFinish}>
            {t('跳過')}
          </button>
          <span className="tour-spacer" />
          <button type="button" disabled={index === 0} onClick={() => setIndex((i) => Math.max(0, i - 1))}>
            {t('上一步')}
          </button>
          <button type="button" className="primary" ref={primaryRef} onClick={() => (last ? props.onFinish() : setIndex((i) => i + 1))}>
            {last ? t('完成') : t('下一步')}
          </button>
        </div>
      </div>
    </div>
  );
}
