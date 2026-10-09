/**
 * 目前的版面（手機／平板／桌面）—— 量視窗與 `pointer: coarse`，轉向、改大小、切「使用桌面版」都會重算。
 * 同時把結果寫到 `<html data-form="…">`（CSS 依它排版；`styles.css` 的手機／平板那一段）。
 */

import { useEffect, useState } from 'react';

import { FORCE_DESKTOP_KEY, formFactorOf, naturalFormFactor, type FormFactor } from '../../core/device/formFactor';

const CHANGE_EVENT = 'rtgaia-formfactor';

function coarse(): boolean {
  try {
    return typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia('(pointer: coarse)').matches;
  } catch {
    return false;
  }
}

export function readForceDesktop(): boolean {
  try {
    return typeof localStorage !== 'undefined' && localStorage.getItem(FORCE_DESKTOP_KEY) === '1';
  } catch {
    return false;
  }
}

/** 使用者選單「使用桌面版／使用手機版」。記在這台瀏覽器。 */
export function setForceDesktop(on: boolean): void {
  try {
    if (on) localStorage.setItem(FORCE_DESKTOP_KEY, '1');
    else localStorage.removeItem(FORCE_DESKTOP_KEY);
  } catch {
    /* 私密視窗：只活在這一頁 */
  }
  if (typeof window !== 'undefined') window.dispatchEvent(new Event(CHANGE_EVENT));
}

export function currentFormFactor(): FormFactor {
  if (typeof window === 'undefined') return 'desktop';
  return formFactorOf({ width: window.innerWidth, height: window.innerHeight, coarse: coarse(), forceDesktop: readForceDesktop() });
}

/** 不看「使用桌面版」時本來是什麼（選單要不要顯示切換）。 */
export function currentNaturalFormFactor(): FormFactor {
  if (typeof window === 'undefined') return 'desktop';
  return naturalFormFactor({ width: window.innerWidth, height: window.innerHeight, coarse: coarse() });
}

/**
 * 簽核事件記的裝置類型 —— 實際是什麼裝置（不看「使用桌面版」）；滑鼠就是電腦（拉窄的桌面視窗不算手機）。
 */
export function deviceClass(): FormFactor {
  return coarse() ? currentNaturalFormFactor() : 'desktop';
}

function apply(f: FormFactor): void {
  if (typeof document === 'undefined') return;
  document.documentElement.setAttribute('data-form', f);
  document.documentElement.setAttribute('data-pointer', coarse() ? 'coarse' : 'fine');
}

export function useFormFactor(): FormFactor {
  const [form, setForm] = useState<FormFactor>(() => {
    const f = currentFormFactor();
    apply(f);
    return f;
  });
  useEffect(() => {
    const update = (): void => {
      const f = currentFormFactor();
      apply(f);
      setForm(f);
    };
    window.addEventListener('resize', update);
    window.addEventListener('orientationchange', update);
    window.addEventListener(CHANGE_EVENT, update);
    let mq: MediaQueryList | null = null;
    try {
      mq = window.matchMedia('(pointer: coarse)');
      mq.addEventListener('change', update);
    } catch {
      mq = null;
    }
    return () => {
      window.removeEventListener('resize', update);
      window.removeEventListener('orientationchange', update);
      window.removeEventListener(CHANGE_EVENT, update);
      mq?.removeEventListener('change', update);
    };
  }, []);
  return form;
}
