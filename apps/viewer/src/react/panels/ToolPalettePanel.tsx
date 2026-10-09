/**
 * 工具列。`toolbar` slot。
 *
 * 工具清單來自工具註冊表（`listTools()`），**不是硬編碼的陣列** ——
 * 模組註冊新工具不必改這個檔案。
 */

import { listTools } from '../../core';
import { Toolbar } from '../components/Toolbar';
import { visibleTools } from './toolPalette';
import type { ViewerPanelProps } from './types';

export function ToolPalettePanel({ api }: ViewerPanelProps): React.JSX.Element {
  return (
    <Toolbar
      tools={visibleTools(listTools(), api.state.modes)}
      activeToolId={api.state.activeToolId}
      onSelect={(toolId) => api.commands.setActiveTool(toolId)}
      editingDisabledReason={api.state.editingBlockedReason}
    />
  );
}
