/**
 * 離開保護 —— 從 `App.tsx` 搬出來（App 逐步拆出 session
 * lifecycle、版面／偏好、離開保護）。
 *
 * 未提交的編輯、提交失敗、我還沒存的 plugin 暫存結果 → 同一個判斷（`dirtyReason`），四個出口共用：
 * 關頁（beforeunload）、切路由（hashchange，離開 `#/viewer` 時問、不要就回去）、切／重載／關閉病例、登出。
 * 回傳 `dirty`（要擋的原因，給提示列）與 `confirmLeave(動作)`：沒有要擋的 → true；有 → 問使用者。
 */

import { useCallback, useEffect, useRef } from 'react';

import { dirtyReason, leaveQuestion, type Layer, type StructureSetInfo } from '../../core';
import { t } from '../../core/i18n';
import type { Principal } from '../auth/authApi';
import type { Route } from '../hooks/useHashRoute';

export function useLeaveGuard(args: {
  snapshot: { editsFlushed: boolean; submitFailures: readonly unknown[] };
  session: { structureSets: readonly StructureSetInfo[]; layers: readonly Layer[] };
  user: Principal | null;
  route: Route;
}): { dirty: string | null; confirmLeave: (action: string) => boolean } {
  const { snapshot, session, user, route } = args;
  const myTransient = session.structureSets.filter((s) => s.kind === 'transient' && (user === null || s.owner === user.username));
  const hasTransient = myTransient.length > 0 && session.layers.some((l) => l.kind === 'mask' && myTransient.some((s) => l.groupId === `rs:${s.structureSetId}`));
  const dirty = dirtyReason({
    // 佇列沒有「飛行中結構數」的計數；`editsFlushed=false` 且沒有失敗 ＝ 至少一筆在送
    unsubmitted: snapshot.editsFlushed || snapshot.submitFailures.length > 0 ? 0 : 1,
    failed: snapshot.submitFailures.length,
    unsavedTransient: hasTransient ? myTransient.length : 0,
  });
  const dirtyRef = useRef<string | null>(null);
  dirtyRef.current = dirty;
  const confirmLeave = useCallback((action: string): boolean => {
    const reason = dirtyRef.current;
    return reason === null || window.confirm(leaveQuestion(reason, action));
  }, []);
  useEffect(() => {
    if (dirty === null) return;
    const onBeforeUnload = (e: BeforeUnloadEvent): void => {
      e.preventDefault();
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [dirty]);
  const lastViewerHash = useRef<string>('#/viewer');
  useEffect(() => {
    if (route === 'viewer') lastViewerHash.current = location.hash || '#/viewer';
  }, [route]);
  useEffect(() => {
    const onHash = (): void => {
      if (dirtyRef.current === null || location.hash.startsWith('#/viewer')) return;
      if (!window.confirm(leaveQuestion(dirtyRef.current, t('離開檢視器')))) location.hash = lastViewerHash.current;
    };
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);
  return { dirty, confirmLeave };
}
