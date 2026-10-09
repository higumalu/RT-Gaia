/**
 * 工具列上的「MPR」開關。開著時：每格出現十字線與旋轉 handle、右側出現 MPR 面板。
 * 關掉時畫面回到單純的三個正交 MPR（slab 設定保留）。
 */

import { MPR_MODE } from './mode';
import type { ViewerPanelProps } from '../../panels/types';
import { t } from '../../../core/i18n';

export function MprToggle({ api }: ViewerPanelProps): React.JSX.Element {
  const on = api.state.modes.includes(MPR_MODE);
  return (
    <span className="mpr-toggle">
      <button
        type="button"
        aria-pressed={on}
        title={on ? t('關閉斜面 MPR（藏起十字線、handle 與面板；slab 設定保留）') : t('開啟斜面 MPR：十字線旋轉 handle ＋ 操作面板')}
        onClick={() => api.commands.setMode(MPR_MODE, !on)}
      >
        MPR
      </button>
    </span>
  );
}
