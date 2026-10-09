/** 工具列「簽核」開關。 */

import type { ViewerPanelProps } from '../../panels/types';
import { REVIEW_MODE } from './mode';
import { t } from '../../../core/i18n';

export function ReviewToggle({ api }: ViewerPanelProps): React.JSX.Element {
  const on = api.state.modes.includes(REVIEW_MODE);
  return (
    <span className="mode-toggle review-toggle">
      <button type="button" aria-pressed={on} title={t('簽核：批次核可／退回／重新開啟，看版本紀錄與簽核事件')} onClick={() => api.commands.setMode(REVIEW_MODE, !on)}>
        {t('簽核')}
      </button>
    </span>
  );
}
