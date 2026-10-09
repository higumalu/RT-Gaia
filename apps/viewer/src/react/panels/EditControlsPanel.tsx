/**
 * 復原／重做與 undo stack 佔用。`toolbar` slot。
 *
 * undo 是**逐筆子區塊差異**，不是整份快照 —— 因此深度與位元組要看得見，
 * 否則「為什麼記憶體一直長」沒有線索。
 */

import type { ViewerPanelProps } from './types';
import { t } from '../../core/i18n';

export function EditControlsPanel({ api }: ViewerPanelProps): React.JSX.Element {
  const s = api.state;
  return (
    <div className="edit-controls">
      <button type="button" disabled={!s.canUndo} onClick={api.commands.undo} title={t('復原')}>
        {t('復原')}
      </button>
      <button type="button" disabled={!s.canRedo} onClick={api.commands.redo} title={t('重做')}>
        {t('重做')}
      </button>
      <span title={t('undo stack 深度與佔用（逐筆子區塊，不做整份快照）')}>
        {t('{undoDepth} 筆 / {p1}KB', { undoDepth: s.undoDepth, p1: Math.round(s.undoBytes / 1024) })}
      </span>
      {/*
        🔴 「同步中」與「同步失敗」必須分開講。`editsFlushed` 在重試用盡之後
        **仍然是 false**（那些 bbox 確實還沒上去），若只看它就會永遠顯示
        「同步中…」——把一個已經停止的失敗說成進行中的正常狀態。
      */}
      {!s.editsFlushed &&
        (s.submitFailures.length > 0 ? (
          <span data-kind="error" title={t('送出失敗且重試已用盡，這些編輯沒有存到後端')}>
            {t('⚠{length}筆未存到', { length: s.submitFailures.length })}
          </span>
        ) : (
          <span title={t('送出佇列尚未清空')}>{t('同步中…')}</span>
        ))}
    </div>
  );
}
