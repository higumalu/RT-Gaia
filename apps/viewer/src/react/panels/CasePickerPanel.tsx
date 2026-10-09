/**
 * 目前病例 ＋「資料庫…」入口。`toolbar` slot。
 *
 * 假體不再出現在 UI 上（它們是測試資料來源，不是使用者要看的東西）；見過的病例
 * 超過一個時才出現下拉選單，否則只顯示目前病例的標籤。組清單的責任在 `App`，面板只負責畫。
 */

import { caseSummaryOf } from '../components/headerModel';
import { navigate } from '../hooks/useHashRoute';
import type { ViewerPanelProps } from './types';
import { t } from '../../core/i18n';

export function CasePickerPanel({ api }: ViewerPanelProps): React.JSX.Element | null {
  const sources = api.state.availableSources;
  const current = api.state.source;
  // 目前病例用「PatientID · 日期 · 主要影像」，不再是「…末 8 碼」
  const summary = caseSummaryOf(api.state.layers, api.state.frameGroups);
  const label =
    summary?.text ??
    sources.find((s) => s.id === current)?.label ??
    (current.startsWith('library:') ? t('資料庫病例 …{p0}', { p0: current.slice(-8) }) : current.replace('dicom:', 'DICOM ') || t('尚未載入'));
  const optionLabel = (s: { id: string; label: string }): string => (s.id === current && summary ? summary.text : s.label);
  return (
    <div className="phantom-picker">
      <span className="muted">{t('病例')}</span>
      {sources.length > 1 ? (
        <select
          value={current}
          onChange={(e) => {
            // 空字串代表 select 的值不在選項裡 —— 別把它當成一個來源送出去
            if (e.target.value && e.target.value !== current) api.commands.loadCase(e.target.value);
          }}
        >
          {sources.map((s) => (
            <option key={s.id} value={s.id}>
              {optionLabel(s)}
            </option>
          ))}
        </select>
      ) : (
        <strong className="case-label" title={current}>
          {label}
        </strong>
      )}
      {/* 資料選取頁（獨立頁面，hash 路由） */}
      <button type="button" onClick={() => navigate('library')} title={t('搜尋 PatientID／日期／描述，勾選要一起載入的序列')}>
        {t('資料庫…')}
      </button>
      {/* 釋放這個病例的前後端資源；要看再載 */}
      {api.state.caseClosed ? (
        api.state.caseClosed.canReload && (
          <button type="button" onClick={api.commands.reopenCase} title={t('從資料庫重新載入剛關閉的病例')}>
            {t('重新載入')}
          </button>
        )
      ) : (
        api.state.caseId && (
          <button type="button" onClick={api.commands.closeCase} title={t('釋放影像、劑量與結構佔的記憶體（前端與伺服器）；工作集與簽核在資料庫裡不受影響')}>
            {t('關閉病例')}
          </button>
        )
      )}
    </div>
  );
}
