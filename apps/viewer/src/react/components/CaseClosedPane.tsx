/**
 * 病例關閉後佇在 viewport 區的空狀態。資源已釋放（前端 wasm 體素／快取／canvas；後端 session、
 * 沒別人看時連病例的體素），要看再「重新載入」—— 後端從資料庫／檔案重建。
 */

import { t } from '../../core/i18n';
export function CaseClosedPane(props: { label: string; canReload: boolean; onReload: () => void; onLibrary: () => void }): React.JSX.Element {
  return (
    <div className="case-closed" role="status">
      <h2>{t('病例已關閉')}</h2>
      <p className="muted">
        {props.label
          ? t('「{label}」的影像、劑量與結構已從這個瀏覽器與伺服器記憶體釋放；工作集與簽核都在資料庫裡，隨時可以再載入。', { label: props.label })
          : t('影像、劑量與結構已從這個瀏覽器與伺服器記憶體釋放；工作集與簽核都在資料庫裡，隨時可以再載入。')}
      </p>
      <div className="case-closed-actions">
        {props.canReload && (
          <button type="button" className="primary" onClick={props.onReload} data-autofocus>
            {t('重新載入')}
          </button>
        )}
        <button type="button" onClick={props.onLibrary}>
          {t('資料庫…')}
        </button>
      </div>
    </div>
  );
}
