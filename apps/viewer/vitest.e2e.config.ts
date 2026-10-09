import { fileURLToPath, URL } from 'node:url';

import { defineConfig } from 'vitest/config';

/**
 * 前端 e2e：**真的 `TransportClient` 打真的測試後端**。
 *
 * 與預設的 `npm test` 分開，因為它需要 Python 環境（`globalSetup` 會起一個
 * uvicorn）。預設測試套件保持純 Node、離線、確定性。
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
    include: ['tests/e2e/**/*.e2e.test.ts'],
    globalSetup: ['./tests/e2e/globalSetup.ts'],
    setupFiles: ['./tests/e2e/setup.ts'],
    // 起伺服器 ＋ 產生 512³ 假體體素會花時間
    testTimeout: 120_000,
    hookTimeout: 120_000,
    // 共用同一個伺服器的 session 狀態，因此不並行
    fileParallelism: false,
  },
});
