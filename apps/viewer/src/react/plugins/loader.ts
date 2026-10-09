/**
 * 執行期載入 plugin UI：
 * `GET /plugins` → 有 bundle 的 `import()` 經宿主代理的 `/api/v1/plugins/{id}/ui/index.js`，驗 id／version／sdkVersion 後
 * `register(sdk)`；沒有 bundle 的註冊宣告式面板。一個 plugin 壞了只記到 catalog，不影響其他。
 *
 * 🔴 `import()` 的 URL 必須同源（經宿主代理）：頁面開著 COEP，跨來源 script 沒有 CORP 會被擋。
 */

import { createElement, type ComponentType } from 'react';

import { hasPanel, registerModule } from '../../core';
import * as sdk from '../../sdk';
import type { ViewerPanelProps } from '../panels/types';
import { pluginCatalog, pluginMode, type PluginInfo } from './catalog';
import { DeclarativePanel } from './DeclarativePanel';
import { satisfies } from './semver';
import { t } from '../../core/i18n';
import { sha256HexSync } from './sha256';

interface UiEntry {
  id: string;
  version: string;
  sdkVersion: string;
  register(sdkArg: typeof sdk): void;
}

export function validateEntry(entry: unknown, info: PluginInfo, sdkVersion: string): string | null {
  const e = entry as Partial<UiEntry> | null | undefined;
  if (!e || typeof e !== 'object') return t('bundle 沒有 default export');
  if (e.id !== info.plugin_id) return `bundle id ${String(e.id)} ≠ manifest ${info.plugin_id}`;
  if (e.version !== info.version) return `bundle version ${String(e.version)} ≠ manifest ${info.version}`;
  if (typeof e.sdkVersion !== 'string' || !satisfies(e.sdkVersion, sdkVersion)) return t('sdkVersion {p0} 與宿主 SDK {sdkVersion} 不相容', { p0: String(e.sdkVersion), sdkVersion });
  if (typeof e.register !== 'function') return t('bundle 沒有 register()');
  return null;
}

/**
 * 載入前的信任檢查（純函式，可測）。
 * 回 null ＝ 可以 import；否則是不載的理由（走宣告式面板或標 failed）。
 * 這不是沙箱 —— 受信任 UI 仍以宿主權限執行；這裡保證「執行的是核准過的那份」。
 */
export function uiLoadDecision(info: Pick<PluginInfo, 'has_ui' | 'ui_trust' | 'ui_digest'>): string | null {
  if (!info.has_ui) return t('沒有 UI bundle');
  if (info.ui_trust !== 'host-equivalent') return t('manifest.ui 沒宣告 trust: host-equivalent，不載 bundle');
  if (!info.ui_digest) return t('宿主沒有這個 bundle 的 digest（重新登錄 plugin）');
  return null;
}

export async function sha256Hex(text: string, subtle: SubtleCrypto | undefined = globalThis.crypto?.subtle): Promise<string> {
  const bytes = new TextEncoder().encode(text);
  // 🔴 以區網 IP 走 http 開（非安全環境）時 `crypto.subtle` 是 undefined → 用純 JS 的那一份；驗證照做，不略過
  if (subtle === undefined) return sha256HexSync(bytes);
  const buf = await subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** 先 `fetch` 拿到 bundle 文字、算 sha256 與宿主釘住的比 —— 不符就**不** `import()`（top-level code 不會執行）。 */
export async function verifyBundleDigest(url: string, expectedHex: string, fetchImpl: typeof fetch = fetch): Promise<string | null> {
  const r = await fetchImpl(url);
  if (!r.ok) return `bundle HTTP ${r.status}`;
  const actual = await sha256Hex(await r.text());
  return actual === expectedHex.toLowerCase() ? null : t('bundle digest 不符（宿主 {p0}…，取得 {p1}…），未載入', { p0: expectedHex.slice(0, 12), p1: actual.slice(0, 12) });
}

const installed = new Set<string>();
let inflight: Promise<void> | null = null;

export function registerDeclarative(info: PluginInfo): void {
  const panelId = `${info.plugin_id}.declarative`;
  if (hasPanel(panelId)) return;
  const component: ComponentType<ViewerPanelProps> = (props) => createElement(DeclarativePanel, { ...props, plugin: info });
  registerModule({
    id: `plugin-declarative:${info.plugin_id}`,
    version: info.version,
    panels: [
      {
        id: panelId,
        slot: 'right-sidebar',
        order: 500,
        title: info.label,
        component,
        visibleWhen: (s) => s.modes.includes(pluginMode(info.plugin_id)),
      },
    ],
  });
}

/**
 * 冪等：同時被叫兩次（StrictMode、登入與路由兩個 effect）只跑一份；跑完再叫會重抓清單但不重註冊已裝的。
 */
export function installPluginUis(fetchList: () => Promise<PluginInfo[]> = defaultFetch): Promise<void> {
  if (inflight) return inflight;
  inflight = installOnce(fetchList).finally(() => {
    inflight = null;
  });
  return inflight;
}

async function installOnce(fetchList: () => Promise<PluginInfo[]>): Promise<void> {
  let rows: PluginInfo[];
  try {
    rows = await fetchList();
  } catch (e) {
    // 沒有 /plugins（舊後端）或未登入：選單只會顯示「無 plugin」
    pluginCatalog.reset();
    void e;
    return;
  }
  for (const info of rows) {
    if (installed.has(info.plugin_id)) {
      pluginCatalog.set(info, pluginCatalog.get(info.plugin_id)?.load ?? { kind: 'pending' });
      continue;
    }
    if (!info.enabled || info.status !== 'active' || !info.allowed) {
      pluginCatalog.set(info, { kind: 'unavailable', reason: !info.enabled ? t('已停用') : info.status !== 'active' ? t('狀態 {status}', { status: info.status }) : t('需要 {required_role}', { required_role: info.required_role }) });
      continue;
    }
    pluginCatalog.set(info, { kind: 'pending' });
    const noBundle = uiLoadDecision(info);
    if (noBundle !== null) {
      // 沒有 bundle、沒宣告 trust、或宿主沒有 digest → 一律宣告式面板（不載就是不載）
      try {
        registerDeclarative(info);
        installed.add(info.plugin_id);
        pluginCatalog.set(info, { kind: 'declarative' });
      } catch (e) {
        pluginCatalog.set(info, { kind: 'failed', reason: e instanceof Error ? e.message : String(e) });
      }
      continue;
    }
    installed.add(info.plugin_id); // 先記，import() 期間再進來的呼叫不會重做
    try {
      const url = `/api/v1/plugins/${encodeURIComponent(info.plugin_id)}/ui/index.js?v=${encodeURIComponent(info.version)}`;
      // 驗 digest **在** import 之前 —— 先前 validateEntry 在 import 之後，top-level code 已經跑過了
      const digestProblem = await verifyBundleDigest(url, info.ui_digest ?? '');
      if (digestProblem) {
        installed.delete(info.plugin_id);
        pluginCatalog.set(info, { kind: 'failed', reason: digestProblem });
        continue;
      }
      const mod = (await import(/* @vite-ignore */ url)) as { default?: unknown };
      const problem = validateEntry(mod.default, info, sdk.SDK_VERSION);
      if (problem) {
        installed.delete(info.plugin_id);
        pluginCatalog.set(info, { kind: 'failed', reason: problem });
        continue;
      }
      try {
        (mod.default as UiEntry).register(sdk);
      } catch (e) {
        // MD3／PN2：同一個 bundle 已經註冊過（例如 HMR 重載）→ 視為成功
        if (!/MD3|PN2/.test(e instanceof Error ? e.message : String(e))) throw e;
      }
      pluginCatalog.set(info, { kind: 'bundle' });
    } catch (e) {
      installed.delete(info.plugin_id);
      pluginCatalog.set(info, { kind: 'failed', reason: t('載入失敗：{p0}', { p0: e instanceof Error ? e.message : String(e) }) });
    }
  }
}

async function defaultFetch(): Promise<PluginInfo[]> {
  const r = await fetch('/api/v1/plugins');
  if (!r.ok) throw new Error(`GET /plugins → HTTP ${r.status}`);
  return (await r.json()) as PluginInfo[];
}
