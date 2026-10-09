/**
 * 觸控裝置的工具列按鈕（`toolbar` slot，只在手機與平板出現）。
 *
 * * 「調窗」：一指拖曳改成調窗寬窗位（觸控沒有右鍵）。
 * * 「完成」「取消」：圈選、面積、曲線這類逐點的工具 —— 桌面靠 Enter／Esc／雙擊，觸控按這兩顆
 *   （canvas 上不放自製按鈕，所以放工具列）。
 * * 「手指畫」：用過觸控筆之後手指預設不畫（避免手掌誤觸），要用手指畫再打開。
 */

import type { ViewerPanelProps } from './types';
import { t } from '../../core/i18n';

/** 逐點、要「收口」的工具。 */
const FINISHABLE = new Set(['scissors', 'measure-area', 'measure-curve', 'measure-angle', 'measure-cobb']);

export function TouchControlsPanel({ api }: ViewerPanelProps): React.JSX.Element {
  const s = api.state;
  const finishable = (s.activeToolId !== null && FINISHABLE.has(s.activeToolId)) || s.vertexEdit !== null;
  return (
    <div className="touch-controls" role="group" aria-label={t('觸控')}>
      <button
        type="button"
        aria-pressed={s.touch.windowLevel}
        title={t('開著：一指拖曳 ＝ 調窗寬窗位（左右調窗寬、上下調窗位）；關掉：一指拖曳換切片或用工具')}
        onClick={() => api.commands.setTouchWindowLevel(!s.touch.windowLevel)}
      >
        {t('調窗')}
      </button>
      {finishable && (
        <>
          <button type="button" className="primary" title={t('結束目前的圈選／量測（＝ Enter 或雙擊）')} onClick={() => api.commands.toolAction('finish')}>
            {t('完成')}
          </button>
          <button type="button" title={t('放棄目前的圈選／量測（＝ Esc）')} onClick={() => api.commands.toolAction('cancel')}>
            {t('取消')}
          </button>
        </>
      )}
      {s.touch.penSeen && (
        <button
          type="button"
          aria-pressed={s.touch.fingerDraws}
          title={t('用過觸控筆後手指預設不畫（筆畫、手指移動畫面，手掌碰到也不會畫）；開著：手指也能畫')}
          onClick={() => api.commands.setFingerDraws(!s.touch.fingerDraws)}
        >
          {t('手指畫')}
        </button>
      )}
    </div>
  );
}
