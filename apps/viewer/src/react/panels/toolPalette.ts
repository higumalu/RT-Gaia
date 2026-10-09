/**
 * 工具列要列哪些工具：量測、筆刷之類的工具不常駐在主要頁面，啟用模組才顯示。
 *
 * 純函式：`hidden` 的不列；宣告 `requiresMode` 的只在那個模式開著時列。十字線永遠在。
 */

import type { ToolPlugin } from '../../core/tools/registry';

export function visibleTools(tools: readonly ToolPlugin[], modes: readonly string[]): ToolPlugin[] {
  return tools.filter((t) => t.hidden !== true && (t.requiresMode === undefined || modes.includes(t.requiresMode)));
}
