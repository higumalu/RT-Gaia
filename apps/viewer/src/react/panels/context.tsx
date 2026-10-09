/**
 * `ViewerApi` 的 React context —— **`core/` 與面板之間唯一的傳遞管道**。
 *
 * 用 context 而不是逐層傳 props 的理由不是省打字，而是**面板的位置由註冊表
 * 決定**：`App` 不知道 `right-sidebar` 裡會有什麼，自然也無從把 props
 * 傳給它。
 *
 * 🔴 **這個檔案在 `react/`，不在 `core/`。** `core/` 不得 import
 * 任何 React。`ViewerApi` 的型別定義在 `core/panels/api.ts`（純型別），
 * 「怎麼遞下去」才是 React 的事。
 */

import { createContext, useContext, type ReactNode } from 'react';

import type { ViewerApi } from '../../core';
import { t } from '../../core/i18n';

const ViewerApiContext = createContext<ViewerApi | null>(null);

export function ViewerApiProvider(props: {
  value: ViewerApi;
  children: ReactNode;
}): React.JSX.Element {
  return <ViewerApiContext.Provider value={props.value}>{props.children}</ViewerApiContext.Provider>;
}

/**
 * 取得 `ViewerApi`。
 *
 * 在 Provider 之外呼叫會**拋例外而不是回傳 null**：面板拿到一個空 api 之後會
 * 畫出一片「載入中」，看起來像資料還沒到，而實際上是掛載位置寫錯了 —— 那種
 * 錯誤可以找很久。
 */
export function useViewerApi(): ViewerApi {
  const api = useContext(ViewerApiContext);
  if (api === null) {
    throw new Error(t('useViewerApi 必須在 <ViewerApiProvider> 之內使用（面板掛載位置錯了？）'));
  }
  return api;
}
