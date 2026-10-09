import { fileURLToPath, URL } from 'node:url';

import react from '@vitejs/plugin-react';
import type { Plugin } from 'vite';
// vitest/config 的 defineConfig 是 vite 的超集，多了 `test` 區段。
import { defineConfig } from 'vitest/config';

/**
 * 英文字典（`src/core/i18n/en.ts`）是另外一包。介面預設英文 → 大多數人開頁就要它，
 * 但主程式要先下載、解析完才會 `import('./en')`，多一趟來回 —— 在打包後的 index.html 加 modulepreload，跟主程式平行下載。
 * 只影響 build（dev server 沒有這包）；選了繁中的人多下載約 70 KB（gzip），不執行。
 */
function preloadEnglishCatalog(): Plugin {
  let base = '/';
  return {
    name: 'rtgaia-preload-en',
    apply: 'build',
    configResolved(config) {
      base = config.base;
    },
    transformIndexHtml: {
      order: 'post',
      handler(_html, ctx) {
        const chunk = Object.values(ctx.bundle ?? {}).find((c) => c.type === 'chunk' && (c.facadeModuleId ?? '').endsWith('/core/i18n/en.ts'));
        if (chunk === undefined) return [];
        return [{ tag: 'link', attrs: { rel: 'modulepreload', crossorigin: '', href: `${base}${chunk.fileName}` }, injectTo: 'head' }];
      },
    },
  };
}

/**
 * 🔴 COOP/COEP 是 **dev server 也要設**。
 *
 * Tier C 的 `SharedArrayBuffer` 需要這兩個標頭；缺少時 CPU 路徑會
 * 退化成單執行緒（約慢 8 倍）。**開發期若不設，整個開發階段的 Tier C 都是
 * 單執行緒**，而效能問題會在部署後才第一次出現。
 */
const crossOriginIsolation = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
};

/**
 * 測試後端的位址。
 *
 * 🔴 **不要寫死。** 預設是 8080，但那個 port 在很多機器上已被佔用
 * （例如開發容器的 gateway）。寫死的話，後端換 port 時前端只會**靜默 proxy
 * 失敗**——看起來像「後端沒回應」，而不是「你設錯位址」。
 */
const apiTarget = process.env.RTGAIA_API ?? 'http://127.0.0.1:8080';

/**
 * `RTGAIA_NO_WATCH=1` 把檔案監看改成**輪詢**，而不是關掉它。
 *
 * Linux 的 `fs.inotify.max_user_instances` 預設 128；機器上跑著幾個編輯器或
 * watcher 就會用完，此時 vite 啟動會直接 `EMFILE` crash。真正的修法是
 * `sudo sysctl fs.inotify.max_user_instances=512`，但那需要 root——這個開關
 * 讓「我只想把服務跑起來看看」不必先要到 root。
 *
 * 🔴 **這裡原本是 `watch: null`，那是個陷阱。** 沒有 watcher 就沒有失效通知，
 * vite 的 transform cache 因此**永遠不更新**。原本的註解寫「沒有 HMR」，
 * 但實際後果重得多：**改了不生效，重新整理也沒用，而且沒有任何跡象**。
 *
 * 這件事實際發生過：dev server 連續三天供應 `f0f8684` 之前的
 * `CpuViewportRenderer`（舊的兩處 `kind === '...'` 硬編碼都還在），而磁碟上
 * 早就是走註冊表的新版。**與 H1（進版控的 `.js` 遮蔽 `.ts`）是同一類缺陷：
 * 靜默地跑著另一份程式碼。**
 *
 * 輪詢走 `fs.stat`，**不佔用 inotify instance**，因此 headroom 不足時仍然有
 * 失效通知；代價是每秒一次 stat 的 CPU。要真的完全關掉監看請用
 * `RTGAIA_WATCH=off`（只在你確定不會改程式碼時用）。
 */
const watchMode = process.env.RTGAIA_WATCH === 'off'
  ? 'off'
  : process.env.RTGAIA_NO_WATCH === '1'
    ? 'poll'
    : 'inotify';

/**
 * 綁定的網卡。預設 `0.0.0.0`，方便從別台機器連進來測試。
 *
 * ⚠️ 測試後端**沒有認證**，且 `_test/load` 接受檔案系統路徑——只放在可信任的
 * 內網。要收回只綁本機：`RTGAIA_HOST=127.0.0.1`。
 *
 * ⚠️ **從別台機器用 `http://<ip>:5173` 連進來時不是 secure context**，因此
 * 即使 COOP/COEP 標頭都在，`crossOriginIsolated` 仍為 false → `SharedArrayBuffer`
 * 不可用（影響 Tier C 的 Worker 分塊，MC2）。要完整測 Tier C 得用 localhost
 * 或 HTTPS。
 */
const host = process.env.RTGAIA_HOST ?? '0.0.0.0';

export default defineConfig({
  plugins: [react(), preloadEnglishCatalog()],
  resolve: {
    alias: {
      '@core': fileURLToPath(new URL('./src/core', import.meta.url)),
      '@react': fileURLToPath(new URL('./src/react', import.meta.url)),
    },
  },
  server: {
    host,
    headers: crossOriginIsolation,
    proxy: {
      '/api': { target: apiTarget, changeOrigin: true, ws: true },
    },
    ...(watchMode === 'off'
      ? { watch: null }
      : watchMode === 'poll'
        ? { watch: { usePolling: true, interval: 1000 } }
        : {}),
  },
  /**
   * React／react-dom 另外一包 —— 很少變，換版時瀏覽器的快取照樣用得上
   * （主程式每次改都換 hash）。少用的頁面與英文字典在程式裡用 `import()` 切出去。
   */
  build: {
    rollupOptions: {
      output: {
        manualChunks(id: string): string | undefined {
          if (/node_modules\/(react|react-dom|scheduler)\//.test(id)) return 'react';
          return undefined;
        },
      },
    },
  },
  preview: {
    host,
    headers: crossOriginIsolation,
    proxy: {
      '/api': { target: apiTarget, changeOrigin: true, ws: true },
    },
  },
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    // e2e 需要 Python 環境，另立 `vitest.e2e.config.ts`（`npm run test:e2e`）
    exclude: ['tests/e2e/**'],
    setupFiles: ['./tests/setup.ts'],
  },
});
