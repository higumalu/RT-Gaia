/** 工具列上的「量測」開關：開右側面板（工具本身在工具面板，永遠在）。 */

import { MEASURE_MODE } from './mode';
import type { ViewerPanelProps } from '../../panels/types';
import { t } from '../../../core/i18n';

export function MeasureToggle({ api }: ViewerPanelProps): React.JSX.Element {
  const on = api.state.modes.includes(MEASURE_MODE);
  const n = api.state.layers.filter((l) => l.kind === 'measurement' && l.measurement?.kind !== 'landmark').length;
  return (
    <span className="mode-toggle measure-toggle">
      <button
        type="button"
        aria-pressed={on}
        title={on ? t('關閉量測面板（量測仍畫在畫面上）') : t('開啟量測面板：清單、改名、HU 統計、刪除、CSV')}
        onClick={() => api.commands.setMode(MEASURE_MODE, !on)}
      >
        {t('量測{p0}', { p0: n > 0 ? ` ${n}` : '' })}
      </button>
    </span>
  );
}
