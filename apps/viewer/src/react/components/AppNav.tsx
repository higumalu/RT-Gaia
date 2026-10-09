/**
 * 全站導覽：資料庫／檢視器／使用者／DICOM 節點／服務設定／稽核 收在左上角的品牌選單裡
 * （`BrandMenu`），三個頁面（檢視器、資料庫、管理）的標題列都用它，取代各頁自己的「← 回檢視器」與右上角「管理」按鈕。
 * 管理項目只有 admin 看得到；`RTGAIA_AUTH=off`（stub 身分，role admin）也顯示。
 */

import { useRef, useState } from 'react';

import { getLang, LANG_LABEL, LANGS, msg, setLang, t } from '../../core/i18n';
import type { Principal } from '../auth/authApi';
import { Brand } from './Brand';
import { useMenuKeyboard } from './useMenuKeyboard';
import { currentNaturalFormFactor, readForceDesktop, setForceDesktop } from '../device/useFormFactor';
import { adminTabFromHash, hashFor, navigate, routeFromHash, useHash, type AdminTab, type Route } from '../hooks/useHashRoute';

interface NavItem {
  readonly key: string;
  readonly label: string;
  readonly route: Route;
  readonly tab?: AdminTab;
  readonly adminOnly?: boolean;
  readonly title: string;
}

export const NAV_ITEMS: readonly NavItem[] = [
  { key: 'library', label: msg('資料庫'), route: 'library', title: msg('病人／study／序列目錄、匯入、送到節點') },
  { key: 'viewer', label: msg('檢視器'), route: 'viewer', title: msg('影像、結構、量測、3D') },
  { key: 'exports', label: msg('匯出紀錄'), route: 'exports', title: msg('每次下載 RTSTRUCT、存入資料庫、送到節點的紀錄：誰、何時、哪些版本、送去哪；可重新下載或重送') },
  { key: 'trash', label: msg('暫存區'), route: 'trash', title: msg('刪除的結構與 DICOM：14 天內可救回，之後自動清除') },
  { key: 'users', label: msg('使用者'), route: 'admin', tab: 'users', adminOnly: true, title: msg('帳號、角色、停用、重設密碼') },
  { key: 'nodes', label: msg('DICOM 節點'), route: 'admin', tab: 'nodes', adminOnly: true, title: msg('PACS／TPS 節點：AE Title、IP、port、角色、ECHO') },
  { key: 'service', label: msg('服務設定'), route: 'admin', tab: 'service', adminOnly: true, title: msg('我方 AE Title、接收端、逾時、唯讀的行程設定') },
  { key: 'plugins', label: 'Plugins', route: 'admin', tab: 'plugins', adminOnly: true, title: msg('行程外 plugin 服務：登錄、健康、啟用／停用') },
  { key: 'audit', label: msg('稽核'), route: 'admin', tab: 'audit', adminOnly: true, title: msg('誰、何時、做了什麼') },
  { key: 'archive', label: msg('封存區'), route: 'archive', adminOnly: true, title: msg('已簽核後被刪除的結構：不自動清除，只有管理者可存取') },
];

export function visibleNavItems(user: Principal | null): NavItem[] {
  const isAdmin = user?.role === 'admin';
  return NAV_ITEMS.filter((it) => !it.adminOnly || isAdmin);
}

export function activeNavKey(hash: string): string {
  const route = routeFromHash(hash);
  if (route === 'admin') return adminTabFromHash(hash);
  return route === 'login' ? '' : route;
}

/**
 * 左上角「圖示 ＋ RT-Gaia · <頁名>」是一顆按鈕：點開展開頁面清單。Esc／點外面關閉；目前頁標亮。
 */
export function BrandMenu(props: { user: Principal | null; section?: string }): React.JSX.Element {
  const hash = useHash();
  const active = activeNavKey(hash);
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  // 共用的選單鍵盤（語言項目 menuitemradio 也在方向鍵的循環裡）；開啟時聚焦目前頁
  useMenuKeyboard({
    open,
    rootRef,
    triggerRef: buttonRef,
    close: () => setOpen(false),
    initial: (els) => els.find((el) => el.getAttribute('aria-current') === 'page'),
  });
  const items = visibleNavItems(props.user);
  return (
    <div className="brand-menu" ref={rootRef}>
      <button
        ref={buttonRef}
        type="button"
        className="brand-button"
        aria-haspopup="menu"
        aria-expanded={open}
        title={t('切換頁面')}
        onClick={() => setOpen((v) => !v)}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown' && !open) {
            e.preventDefault();
            setOpen(true);
          }
        }}
      >
        <Brand {...(props.section ? { section: props.section } : {})} />
        <span className="caret">{open ? '▴' : '▾'}</span>
      </button>
      {open && (
        <ul className="brand-dropdown" role="menu">
          {items.map((it, n) => (
            <li key={it.key} role="none">
              {n > 0 && items[n - 1]!.adminOnly !== it.adminOnly && <hr />}
              <a
                role="menuitem"
                href={hashFor(it.route, it.tab)}
                aria-current={active === it.key ? 'page' : undefined}
                title={t(it.title)}
                onClick={(e) => {
                  e.preventDefault();
                  setOpen(false);
                  navigate(it.route, it.tab);
                }}
              >
                <span className="label">{t(it.label)}</span>
                <span className="hint">{t(it.title)}</span>
              </a>
            </li>
          ))}
          {/* 語言切換（每個頁面都有品牌選單，驗證關閉時也在） */}
          <li role="none" className="lang-switch">
            <hr />
            <span className="hint">{t('語言')}</span>
            {LANGS.map((lang) => (
              <button
                key={lang}
                type="button"
                role="menuitemradio"
                aria-checked={getLang() === lang}
                onClick={() => {
                  void setLang(lang);
                  setOpen(false);
                }}
              >
                {LANG_LABEL[lang]}
              </button>
            ))}
          </li>
          {/* 手機／平板上可以切回桌面版（記在這台瀏覽器）；桌面電腦不顯示 */}
          {currentNaturalFormFactor() !== 'desktop' && (
            <li role="none" className="lang-switch">
              <hr />
              <span className="hint">{t('版面')}</span>
              <button
                type="button"
                role="menuitemradio"
                aria-checked={!readForceDesktop()}
                onClick={() => {
                  setForceDesktop(false);
                  setOpen(false);
                }}
              >
                {currentNaturalFormFactor() === 'phone' ? t('手機版') : t('平板版')}
              </button>
              <button
                type="button"
                role="menuitemradio"
                aria-checked={readForceDesktop()}
                title={t('跟電腦一樣的版面（記在這台瀏覽器）')}
                onClick={() => {
                  setForceDesktop(true);
                  setOpen(false);
                }}
              >
                {t('桌面版')}
              </button>
            </li>
          )}
        </ul>
      )}
    </div>
  );
}
