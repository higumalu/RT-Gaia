/**
 * 工具列。
 *
 * 工具清單來自**註冊表**，不是硬編碼的陣列——新增工具不必改這個元件
 * （核心不得認識任何模組專屬的型別）。
 */

import type { ToolPlugin } from '../../core/tools/registry';
import { t } from '../../core/i18n';

export interface ToolbarProps {
  tools: readonly ToolPlugin[];
  activeToolId: string | null;
  onSelect: (toolId: string) => void;
  /** 目前選取的結構不可編輯（替代表示）時要停用筆刷類工具。 */
  editingDisabledReason: string | null;
}

const EDIT_TOOL_IDS = new Set(['brush', 'eraser', 'threshold-brush', 'scissors']);

/**
 * 尚未實作的工具 → 停用原因。
 *
 * 🔴 **看起來可以點但什麼都不做，比不顯示更糟。** 使用者的合理結論是
 * 「我不會用」而不是「這還沒做」。註冊表列出整套工具集是刻意的（這個決定
 * 應該看得見），但沒接上的必須明確停用並說明。
 */
const NOT_IMPLEMENTED: Record<string, string> = {
};

export function Toolbar(props: ToolbarProps): React.JSX.Element {
  return (
    <div className="toolbar" role="toolbar">
      {props.tools.map((tool) => {
        const notImplemented = NOT_IMPLEMENTED[tool.id] ?? null;
        const blocked =
          props.editingDisabledReason !== null && EDIT_TOOL_IDS.has(tool.id)
            ? props.editingDisabledReason
            : null;
        const disabled = notImplemented !== null || blocked !== null;
        return (
          <button
            key={tool.id}
            type="button"
            aria-pressed={props.activeToolId === tool.id}
            disabled={disabled}
            data-not-implemented={notImplemented !== null ? 'true' : undefined}
            title={notImplemented ?? blocked ?? (tool.hotkey ? t('{label}（快捷鍵 {p1}）', { label: t(tool.label), p1: tool.hotkey.toUpperCase() }) : t(tool.label))}
            onClick={() => props.onSelect(tool.id)}
          >
            <span aria-hidden>{tool.icon}</span>
            <span>{t(tool.label)}</span>
          </button>
        );
      })}
    </div>
  );
}
