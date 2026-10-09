/** 工具列「匯出」開關。 */

import type { ViewerPanelProps } from '../../panels/types';
import { EXPORT_MODE } from './mode';
import { t } from '../../../core/i18n';

export function ExportToggle({ api }: ViewerPanelProps): React.JSX.Element {
  const on = api.state.modes.includes(EXPORT_MODE);
  return (
    <span className="mode-toggle export-toggle">
      <button type="button" aria-pressed={on} title={t('匯出 RTSTRUCT（從 labelmap 在取像平面重抽輪廓；走 job，可下載）')} onClick={() => api.commands.setMode(EXPORT_MODE, !on)}>
        {t('匯出')}
      </button>
    </span>
  );
}
