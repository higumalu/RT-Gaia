/**
 * 面板元件的 props —— **第三方模組唯一需要 import 的型別**。
 *
 * 面板寫起來長這樣：
 *
 * ```tsx
 * function MyPanel({ api }: ViewerPanelProps) {
 *   return <button onClick={() => api.commands.undo()}>復原</button>;
 * }
 * registerPanel({ id: 'my-panel', slot: 'right-sidebar', order: 10, component: MyPanel });
 * ```
 *
 * 🔴 **`api` 之外什麼都拿不到，這是刻意的。** 面板一旦能碰 `ViewerHost` 或
 * canvas，它在 Tier A 的 GPU 路徑上就會壞掉，而且是靜默壞掉（與工具註冊對
 * `ToolContext` 的同一條規則）。要在影像上畫東西走 `api.overlay`。
 */

import type { ViewerApi } from '../../core';

export interface ViewerPanelProps {
  readonly api: ViewerApi;
  /**
   * 只有 `slot: 'viewport-overlay'` 的面板會拿到 —— 這一格是哪個 viewport。
   * 其餘 slot 為 `undefined`。
   */
  readonly viewportId?: string;
}
