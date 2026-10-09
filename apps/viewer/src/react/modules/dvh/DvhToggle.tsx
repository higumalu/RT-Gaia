/** 工具列上的「DVH」開關（只在場景有劑量 layer 時出現 —— manifest 的 `visibleWhen`）。 */

import { DVH_MODE } from './mode';
import type { ViewerPanelProps } from '../../panels/types';
import { t } from '../../../core/i18n';

export function DvhToggle({ api }: ViewerPanelProps): React.JSX.Element {
  const on = api.state.modes.includes(DVH_MODE);
  return (
    <span className="mode-toggle dvh-toggle">
      <button
        type="button"
        aria-pressed={on}
        title={on ? t('關閉 DVH 面板') : t('開啟 DVH：勾結構、選劑量，畫累積劑量體積直方圖（跨 FoR 也算）')}
        onClick={() => api.commands.setMode(DVH_MODE, !on)}
      >
        DVH
      </button>
    </span>
  );
}
