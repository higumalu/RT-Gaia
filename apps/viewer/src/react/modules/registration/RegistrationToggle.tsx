/**
 * 工具列上的「對位」開關。開著時右側出現對位面板；關掉時若拖曳工具還在用，切回 navigate。
 * 只在有次要序列時才有意義 —— 沒有就不畫（`visibleWhen` 在 manifest 裡）。
 */

import { REGISTRATION_DRAG_TOOL, REGISTRATION_MODE } from './mode';
import type { ViewerPanelProps } from '../../panels/types';
import { t } from '../../../core/i18n';

export function RegistrationToggle({ api }: ViewerPanelProps): React.JSX.Element {
  const on = api.state.modes.includes(REGISTRATION_MODE);
  return (
    <span className="mode-toggle reg-toggle">
      <button
        type="button"
        aria-pressed={on}
        title={on ? t('關閉對位微調（未提交的調整保留在畫面上）') : t('開啟對位微調：平移／旋轉次要序列、提交回後端')}
        onClick={() => {
          if (on && api.state.activeToolId === REGISTRATION_DRAG_TOOL) api.commands.setActiveTool('navigate');
          api.commands.setMode(REGISTRATION_MODE, !on);
        }}
      >
        {t('對位')}
      </button>
    </span>
  );
}
