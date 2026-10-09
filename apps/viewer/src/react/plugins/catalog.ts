/**
 * 目前這個頁面知道的 plugin：`GET /plugins` 的結果 ＋ 每個的載入狀態。
 * 模組級 store（不是 React state）：載入器、選單、宣告式面板都讀它；`subscribe` 給 React 用。
 */

import { t } from '../../core/i18n';

export interface PluginInfo {
  readonly plugin_id: string;
  readonly version: string;
  readonly label: string;
  readonly icon: string | null;
  readonly description: string;
  readonly has_ui: boolean;
  readonly required_role: string;
  readonly status: string;
  readonly enabled: boolean;
  readonly allowed: boolean;
  readonly params_schema?: Record<string, unknown> | null;
  /** `manifest.ui.trust`；只有 `'host-equivalent'` 會載 bundle（後端 `has_ui` 也以此為準）。 */
  readonly ui_trust?: string | null;
  /** 登錄時宿主釘住的 bundle sha256；載入前比對，不符就不 import。 */
  readonly ui_digest?: string | null;
}

export type LoadState = { kind: 'pending' } | { kind: 'bundle' } | { kind: 'declarative' } | { kind: 'unavailable'; reason: string } | { kind: 'failed'; reason: string };

export interface CatalogEntry {
  readonly info: PluginInfo;
  readonly load: LoadState;
}

export interface CatalogEvent {
  readonly at: string;
  readonly text: string;
}

class PluginCatalog {
  private entries = new Map<string, CatalogEntry>();
  private stale = false;
  private events: CatalogEvent[] = [];
  private listeners = new Set<() => void>();

  list(): CatalogEntry[] {
    return [...this.entries.values()].sort((a, b) => a.info.label.localeCompare(b.info.label));
  }

  get(id: string): CatalogEntry | undefined {
    return this.entries.get(id);
  }

  isStale(): boolean {
    return this.stale;
  }

  set(info: PluginInfo, load: LoadState): void {
    this.entries.set(info.plugin_id, { info, load });
    this.notify();
  }

  /** `plugins.changed` 來了：頁面上的 bundle 不換，只標記「重新載入後生效」。 */
  markStale(): void {
    if (!this.stale) {
      this.stale = true;
      this.notify();
    }
  }

  /** L0 節點回傳、送出等事件（顯示在 Plugins 選單底部與提示列；最多留 5 則）。 */
  addEvent(text: string): void {
    this.events = [{ at: new Date().toISOString(), text }, ...this.events].slice(0, 5);
    this.notify();
  }

  listEvents(): readonly CatalogEvent[] {
    return this.events;
  }

  clearEvents(): void {
    this.events = [];
    this.notify();
  }

  reset(): void {
    this.entries.clear();
    this.stale = false;
    this.notify();
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private notify(): void {
    for (const l of this.listeners) l();
  }
}

export const pluginCatalog = new PluginCatalog();

/** 選單要列的：啟用、運作中、我有權限的；其餘列出來但不可點（附原因）。 */
export function menuItems(entries: readonly CatalogEntry[]): { entry: CatalogEntry; usable: boolean; reason: string | null }[] {
  return entries.map((entry) => {
    const { info, load } = entry;
    if (!info.enabled) return { entry, usable: false, reason: t('已停用') };
    if (info.status !== 'active') return { entry, usable: false, reason: t('狀態：{status}', { status: info.status }) };
    if (!info.allowed) return { entry, usable: false, reason: t('需要 {required_role}', { required_role: info.required_role }) };
    if (load.kind === 'failed') return { entry, usable: false, reason: load.reason };
    if (load.kind === 'unavailable') return { entry, usable: false, reason: load.reason };
    if (load.kind === 'pending') return { entry, usable: false, reason: t('載入中…') };
    return { entry, usable: true, reason: null };
  });
}

export const pluginMode = (id: string): string => `plugin:${id}`;
