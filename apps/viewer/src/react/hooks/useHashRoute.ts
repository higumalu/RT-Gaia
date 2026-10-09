/**
 * 最小的 hash 路由（資料選取是**頁面**，不是 modal）。
 *
 * 頁：`#/library`（資料庫）、`#/viewer`（檢視器）、`#/login`、`#/admin/<tab>`（使用者／稽核／DICOM 節點／服務設定）。
 * 不加路由套件 —— 而且 viewer 那一頁**不得因為切頁而卸載 `ViewerHost`**（體素要重抓 200 MB）；
 * 因此路由切的是 `App` 內部渲染哪個區塊，不是切換整個元件樹。
 *
 * 五個頁面統一由 `AppNav` 導覽（資料庫／檢視器／使用者／DICOM 節點／服務設定 放在一起）。
 */

import { useEffect, useState } from 'react';

export type Route = 'viewer' | 'library' | 'login' | 'admin' | 'help' | 'trash' | 'archive' | 'exports';
export type AdminTab = 'users' | 'audit' | 'nodes' | 'service' | 'plugins';
export const ADMIN_TABS: readonly AdminTab[] = ['users', 'nodes', 'service', 'plugins', 'audit'];

export function routeFromHash(hash: string): Route {
  const path = hash.replace(/^#/, '').replace(/^\//, '');
  if (path.startsWith('library')) return 'library';
  if (path.startsWith('login')) return 'login';
  if (path.startsWith('admin')) return 'admin';
  if (path.startsWith('help')) return 'help';
  if (path.startsWith('trash')) return 'trash';
  if (path.startsWith('archive')) return 'archive';
  if (path.startsWith('exports')) return 'exports';
  return 'viewer';
}

/** `#/admin/nodes` → `nodes`；沒有或不認識 → `users`。 */
export function adminTabFromHash(hash: string): AdminTab {
  const path = hash.replace(/^#/, '').replace(/^\//, '').split('?')[0] ?? '';
  const sub = path.split('/')[1] ?? '';
  return (ADMIN_TABS as readonly string[]).includes(sub) ? (sub as AdminTab) : 'users';
}

export function hashFor(route: Route, tab?: AdminTab): string {
  if (route === 'admin') return `#/admin/${tab ?? 'users'}`;
  if (route === 'trash' || route === 'archive' || route === 'exports') return `#/${route}`;
  return route === 'library' ? '#/library' : route === 'login' ? '#/login' : route === 'help' ? '#/help' : '#/viewer';
}

export function navigate(route: Route, tab?: AdminTab): void {
  const next = hashFor(route, tab);
  if (location.hash !== next) location.hash = next;
}

export function useHashRoute(): Route {
  const [route, setRoute] = useState<Route>(() =>
    typeof location === 'undefined' ? 'viewer' : routeFromHash(location.hash),
  );
  useEffect(() => {
    const onChange = (): void => setRoute(routeFromHash(location.hash));
    window.addEventListener('hashchange', onChange);
    return () => window.removeEventListener('hashchange', onChange);
  }, []);
  return route;
}

/** 目前的 hash（給 `AppNav` 標亮、給管理頁決定分頁）。 */
export function useHash(): string {
  const [hash, setHash] = useState<string>(() => (typeof location === 'undefined' ? '' : location.hash));
  useEffect(() => {
    const onChange = (): void => setHash(location.hash);
    window.addEventListener('hashchange', onChange);
    return () => window.removeEventListener('hashchange', onChange);
  }, []);
  return hash;
}
