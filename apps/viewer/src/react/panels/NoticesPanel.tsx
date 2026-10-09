/**
 * 提示列（fallback 通知、替代表示說明）。`bottom` slot。
 *
 * 去重：同一則 fallback 提示每個 viewport 各報一次（overlay handle 的鍵含
 * viewportId），四格版面就會看到四遍同一句話。
 */

import { useState } from 'react';

import type { ViewerPanelProps } from './types';
import { t } from '../../core/i18n';

/** 同時最多顯示幾則。舊的自然滾掉，不做關閉按鈕。 */
const MAX_NOTICES = 3;

export function NoticesPanel({ api }: ViewerPanelProps): React.JSX.Element | null {
  const notices = [...new Map(api.state.notices.map((n) => [n.message, n])).values()].slice(
    -MAX_NOTICES,
  );
  const failures = api.overlay.failures();
  const unsaved = api.state.submitFailures;
  if (notices.length === 0 && failures.length === 0 && unsaved.length === 0) return null;
  return (
    <div className="notices">
      {notices.map((notice) => (
        <span key={notice.message} data-kind={notice.kind}>
          {notice.message}
        </span>
      ))}
      {/* overlay painter 被停用必須看得見，否則面板畫的東西是靜默消失的 */}
      {failures.map((f) => (
        <span key={f.id} data-kind="error">
          {t('overlay「{id}」已停用：{reason}', { id: f.id, reason: f.reason })}
        </span>
      ))}
      {/*
        🔴 送出失敗必須看得見，而且**不會自己滾掉**（不受 MAX_NOTICES 限制）。
        這一則說的是「畫面上有一塊輪廓後端沒有」——它比任何 fallback 提示都重要，
        而且在使用者重畫成功之前一直成立。
      */}
      {unsaved.map((f) => (
        <UnsavedRow key={`unsaved:${f.structureId}@${f.frameIndex ?? 'static'}`} api={api} failure={f} />
      ))}
    </div>
  );
}

/**
 * 沒存到後端的那一筆 —— 以前只叫使用者「重畫一次，或重新載入」。現在：
 * 結構名稱（與哪一幀）、重試幾次了，以及三個動作：再送一次、跳到那一塊（十字線移到沒存到的範圍）、放棄並取回後端版本（要再按一次確認）。
 * `role="alert"`：這一則一直留著直到處理掉，讀屏軟體要唸。
 */
function UnsavedRow({ api, failure }: ViewerPanelProps & { failure: { structureId: string; frameIndex: number | null; retries: number } }): React.JSX.Element {
  const [confirming, setConfirming] = useState(false);
  const meta = api.state.structures.find((s) => s.structureId === failure.structureId);
  const name = meta?.name ?? failure.structureId;
  const layer = api.state.layers.find((l) => l.kind === 'mask' && l.contentRef === failure.structureId);
  const group = layer?.temporalGroupId ? api.state.temporal.find((g) => g.temporalGroupId === layer.temporalGroupId) : undefined;
  const frame = failure.frameIndex === null ? null : (group?.frameLabels?.[failure.frameIndex] ?? `#${failure.frameIndex + 1}`);
  return (
    <span className="unsaved-row" data-kind="error" role="alert" data-structure={failure.structureId}>
      <span aria-hidden="true">🔴</span>
      {frame === null ? t('「{name}」有編輯', { name }) : t('「{name}」（{frame}）有編輯', { name, frame })}
      <strong>{t('沒有存到後端')}</strong>
      {t('（已重試 {retries} 次）', { retries: failure.retries })}
      <span className="unsaved-actions">
        <button type="button" className="mini" onClick={() => api.commands.retryUnsaved(failure.structureId, failure.frameIndex)}>
          {t('再送一次')}
        </button>
        <button type="button" className="mini" title={t('十字線移到沒存到的那一塊')} onClick={() => api.commands.jumpToUnsaved(failure.structureId, failure.frameIndex)}>
          {t('跳到那一塊')}
        </button>
        {confirming ? (
          <>
            <button type="button" className="mini danger" onClick={() => api.commands.discardUnsaved(failure.structureId, failure.frameIndex)}>
              {t('確定放棄')}
            </button>
            <button type="button" className="mini" onClick={() => setConfirming(false)}>
              {t('取消')}
            </button>
          </>
        ) : (
          <button type="button" className="mini" title={t('丟掉本地沒存到的編輯，改回後端的版本（這個結構的復原紀錄會清空）')} onClick={() => setConfirming(true)}>
            {t('放棄，取回後端版本')}
          </button>
        )}
      </span>
    </span>
  );
}
