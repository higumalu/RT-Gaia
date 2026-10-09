/** 任務列右側「說明 ▾」：快捷鍵表、功能導覽、任務引導、使用手冊。 */
import { useLayoutEffect, useRef, useState } from 'react';
import { t } from '../../core/i18n';
import { useMenuKeyboard } from '../components/useMenuKeyboard';

export function HelpMenu(props: { onShortcuts: () => void; onTour: (kind?: 'feature' | 'draw') => void }): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  // 跟品牌選單同一套（開啟聚焦第一項、方向鍵、Esc 還焦點）
  useMenuKeyboard({ open, rootRef: ref, triggerRef, close: () => setOpen(false) });
  // 說明按鈕在左邊（窄視窗、200% 縮放時任務列換行）→ 往右打開，不跑出視窗
  useLayoutEffect(() => {
    const menu = ref.current?.querySelector<HTMLElement>('.help-dropdown');
    if (!open || !menu) return;
    menu.classList.remove('flip-left');
    if (menu.getBoundingClientRect().left < 0) menu.classList.add('flip-left');
  }, [open]);
  return (
    <div className="bar-group bar-group-help" ref={ref}>
      <button ref={triggerRef} type="button" className="help-toggle" aria-haspopup="menu" aria-expanded={open} title={t('快捷鍵、功能導覽、使用手冊（也可以按 ?）')} onClick={() => setOpen((v) => !v)}>
        {t('說明{p0}', { p0: open ? '▴' : '▾' })}
      </button>
      {open && (
        <ul className="help-dropdown" role="menu">
          <li>
            <button type="button" role="menuitem" onClick={() => { setOpen(false); props.onShortcuts(); }}>
              {t('快捷鍵與滑鼠操作')} <kbd>?</kbd>
            </button>
          </li>
          <li>
            <button type="button" role="menuitem" onClick={() => { setOpen(false); props.onTour('feature'); }}>
              {t('功能導覽')}
            </button>
          </li>
          <li>
            <button type="button" role="menuitem" title={t('一步一步帶你畫一個結構，並確認存到後端')} onClick={() => { setOpen(false); props.onTour('draw'); }}>
              {t('任務：畫一個結構')}
            </button>
          </li>
          <li>
            <a role="menuitem" href="#/help" onClick={() => setOpen(false)}>
              {t('使用手冊')}
            </a>
          </li>
        </ul>
      )}
    </div>
  );
}
