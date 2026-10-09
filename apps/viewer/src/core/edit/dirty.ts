/**
 * 「離開前要不要問」的**單一**判斷。
 *
 * 過去 `loadCase`／`reloadCase` 檢查 `editsFlushed`，`beforeunload` 卻只在有未保存的 plugin 結果時啟用；
 * 一般筆刷編輯還在送出或重試失敗時，重新整理／關頁不會被提醒，記憶體佇列就丟了；路由切換與登出也各自為政。
 * 現在四個出口（關頁、切路由、切／重載病例、登出）都問這一個函式。純函式，可測。
 */

import { joinClauses, t } from '../i18n';

export interface DirtyState {
  /** 送出佇列尚未清空（飛行中或等待重試）的結構數。 */
  readonly unsubmitted: number;
  /** 重試用盡、沒存到後端的結構數（`submitFailures`）。 */
  readonly failed: number;
  /** 未保存的 plugin 結果（暫存結構集）數。 */
  readonly unsavedTransient: number;
}

/** `null` ＝ 可以直接離開；否則是要給使用者看的理由（一句話，含數量）。失敗優先於其他。 */
export function dirtyReason(s: DirtyState): string | null {
  const parts: string[] = [];
  if (s.failed > 0) parts.push(t('{failed} 筆編輯送出失敗、沒有存到後端', { failed: s.failed }));
  if (s.unsubmitted > 0) parts.push(t('{unsubmitted} 筆編輯還在送出', { unsubmitted: s.unsubmitted }));
  if (s.unsavedTransient > 0) parts.push(t('{unsavedTransient} 組未保存的 plugin 結果', { unsavedTransient: s.unsavedTransient }));
  if (parts.length === 0) return null;
  return joinClauses(parts);
}

export function isDirty(s: DirtyState): boolean {
  return dirtyReason(s) !== null;
}

/** 給 `confirm()` 用的整句（各出口共用，措辭一致）。 */
export function leaveQuestion(reason: string, action: string): string {
  return t('有 {reason}。{action}會丟掉這些內容。仍要{action2}？', { reason, action, action2: action });
}
