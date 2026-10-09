import { fileURLToPath, URL } from 'node:url';

import { defineConfig } from 'vitest/config';

/**
 * 效能門檻（`tests/perf/*.perf.ts`）。跟預設的 `npm test` 分開 —— 量時間的測試不是確定性的，
 * 也要真的 WASM 核心（`public/rtgaia_reslice.wasm`）。CI 在前端 job 跑（`npm run test:perf`）。
 */
export default defineConfig({
  resolve: {
    alias: {
      '@core': fileURLToPath(new URL('./src/core', import.meta.url)),
      '@react': fileURLToPath(new URL('./src/react', import.meta.url)),
    },
  },
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/perf/**/*.perf.ts'],
    testTimeout: 120_000,
    hookTimeout: 120_000,
    fileParallelism: false,
  },
});
