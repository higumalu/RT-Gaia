// 用 apps/viewer 的工具鏈建：`cd apps/viewer && npx vite build --config ../../examples/plugin-hello-ui/vite.config.ts`
import { fileURLToPath, URL } from 'node:url';

import type { UserConfig } from 'vite';

const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));

const config: UserConfig = {
  root: here('.'),
  resolve: { alias: { '@rtgaia/sdk': here('../../apps/viewer/src/sdk/index.ts') } },
  esbuild: { jsx: 'automatic' },
  build: {
    outDir: here('dist'),
    emptyOutDir: true,
    lib: { entry: here('src/index.tsx'), formats: ['es'], fileName: () => 'index.js' },
    // 四個 external 由宿主 import map 提供單例，不得打包進來
    rollupOptions: { external: ['react', 'react-dom', 'react/jsx-runtime', '@rtgaia/sdk'] },
    minify: false,
    sourcemap: true,
  },
};

export default config;
