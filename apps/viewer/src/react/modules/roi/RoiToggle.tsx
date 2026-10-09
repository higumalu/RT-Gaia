/** 工具列「ROI 編輯」開關（開右側面板）。 */

import { ROI_MODE } from './mode';
import type { ViewerPanelProps } from '../../panels/types';
import { t } from '../../../core/i18n';

export function RoiToggle({ api }: ViewerPanelProps): React.JSX.Element {
  const on = api.state.modes.includes(ROI_MODE);
  return (
    <span className="mode-toggle roi-toggle">
      <button
        type="button"
        aria-pressed={on}
        title={on ? t('關閉 ROI 編輯（筆刷等工具會從工具列收起）') : t('ROI 編輯：新建／改名／複製／刪除、手繪、區域生長、閾值分割、後處理')}
        onClick={() => api.commands.setMode(ROI_MODE, !on)}
      >
        {t('ROI 編輯')}
      </button>
    </span>
  );
}
