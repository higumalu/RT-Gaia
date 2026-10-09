/**
 * 進入點。
 *
 * 🔴 **開發階段一律開著 StrictMode**——不得為了迴避 double-mount
 * 而關閉。`SceneManager.dispose()` 因此必須是冪等的，且 `attachViewport` 對同
 * 一個 id 重複呼叫要能正確重建。
 */

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { registerCoreBuiltins } from './core';
import { exposeHostSingletons } from './sdk/expose';
import { App } from './react/components/App';
import './styles.css';
import { ensureLang, getLang, installLanguageHeader, msg } from './core/i18n';

// 🔴 在第一次 render 之前。註冊表不是 reactive 的（見 core/bootstrap.ts）。
registerCoreBuiltins();
// plugin bundle 的 shim 從 globalThis.__rtgaia__ 拿 React／SDK 單例
exposeHostSingletons();
// API 請求帶介面語言（後端依它翻訊息）
installLanguageHeader();

const container = document.getElementById('root');
if (container === null) throw new Error(msg('#root 不存在'));

// 英文字典是另外一包 —— 開頁就是英文時先載好再畫（不會先閃一下中文）
void ensureLang(getLang()).finally(() => {
  createRoot(container).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
  // index.html 的開機檢查：主程式起來了，20 秒後不要顯示「沒有載入完成」
  (window as unknown as { __rtgaiaBooted?: boolean }).__rtgaiaBooted = true;
});
