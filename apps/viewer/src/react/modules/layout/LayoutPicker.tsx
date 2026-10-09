/** 工具列的版面選單 —— 清單來自 `listLayouts()`，模組註冊的版面自動出現。 */

import { listLayouts } from "../../../core";
import type { ViewerPanelProps } from "../../panels/types";
import { t } from '../../../core/i18n';

export function LayoutPicker({ api }: ViewerPanelProps): React.JSX.Element {
  return (
    <label
      className="layout-picker"
      title={t('版面：2×2、1×1、1＋3、並排比較')}
    >
      {t('版面')}
      <select
        value={api.state.layoutId}
        onChange={(e) => api.commands.setLayout(e.target.value)}
      >
        {listLayouts().map((l) => (
          <option key={l.id} value={l.id}>
            {t(l.label)}
          </option>
        ))}
      </select>
      {api.state.layoutHasOverrides && (
        <button type="button" className="layout-reset" title={t('清掉這個版面的分割、大小與每格的自訂內容')} onClick={() => api.commands.resetLayoutOverrides()}>
          {t('重設版面')}
        </button>
      )}
    </label>
  );
}
