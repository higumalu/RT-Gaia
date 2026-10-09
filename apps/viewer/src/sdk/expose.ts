/**
 * 把宿主的 React／SDK 單例放到 `globalThis.__rtgaia__`，給 `public/plugin-shims/*.js` 轉成 ESM。
 * 必須在任何 plugin bundle 被 `import()` 之前執行 —— `main.tsx` 第一件事就是它。
 */

import * as React from 'react';
import * as ReactDOM from 'react-dom';
import * as JsxRuntime from 'react/jsx-runtime';

import * as sdk from './index';

declare global {
  var __rtgaia__: { react: typeof React; reactDom: typeof ReactDOM; jsxRuntime: typeof JsxRuntime; sdk: typeof sdk } | undefined;
}

export function exposeHostSingletons(): void {
  globalThis.__rtgaia__ = { react: React, reactDom: ReactDOM, jsxRuntime: JsxRuntime, sdk };
}
