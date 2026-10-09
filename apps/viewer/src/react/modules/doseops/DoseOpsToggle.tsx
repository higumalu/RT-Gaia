/** 工具列「劑量運算」開關 —— 病例有劑量才出現。 */

import type { ViewerPanelProps } from '../../panels/types';
import { DOSE_OPS_MODE } from './mode';
import { t } from '../../../core/i18n';

export function DoseOpsToggle({ api }: ViewerPanelProps): React.JSX.Element | null {
  const on = api.state.modes.includes(DOSE_OPS_MODE);
  if (!api.state.layers.some((l) => l.kind === 'dose')) return null;
  return (
    <span className="mode-toggle dose-ops-toggle">
      <button type="button" aria-pressed={on} title={t('劑量運算：兩個劑量相加減、一個劑量乘除固定值（結果先暫存，可存成 RTDOSE）')} onClick={() => api.commands.setMode(DOSE_OPS_MODE, !on)}>
        {t('劑量運算')}
      </button>
    </span>
  );
}
