/**
 * 簽核模組的純邏輯。零 React、零 fetch。
 *
 * 狀態機：`ai_generated → under_review → edited → approved | rejected`；`approved` 對所有人唯讀，
 * 審核者 `reopen`（回 under_review）才能再改。
 */

import type { StructureMeta } from '../../../core';
import { msg, t } from '../../../core/i18n';

export type ReviewStatus = 'ai_generated' | 'under_review' | 'edited' | 'approved' | 'rejected';
export type ReviewAction = 'approve' | 'reject' | 'reopen';

export const STATUS_LABEL: Record<string, string> = {
  ai_generated: msg('模型產生'),
  under_review: msg('待審'),
  edited: msg('已編輯'),
  approved: msg('已簽核'),
  rejected: msg('退回'),
  deleted: msg('已刪除'),
};

export const STATUS_ORDER: readonly ReviewStatus[] = ['edited', 'under_review', 'ai_generated', 'rejected', 'approved'];

export function statusLabel(status: string): string {
  return t(STATUS_LABEL[status] ?? status);
}

/** 審核者以上才能簽核／退回／重新開啟（角色由後端中介層最終裁決；這裡只決定 UI 要不要灰掉）。 */
export function canReview(role: string | null | undefined): boolean {
  return role === 'approver' || role === 'admin';
}

/** 一個動作對一個狀態是否有意義（approved 不能再 approve；只有 approved／rejected 能 reopen）。 */
export function actionAllowed(action: ReviewAction, status: string): boolean {
  if (action === 'approve') return status !== 'approved';
  if (action === 'reject') return status !== 'rejected' && status !== 'approved';
  return status === 'approved' || status === 'rejected';
}

/** 選取中對某個動作有效的結構數（按鈕帶數量）。 */
export function actionCount(action: ReviewAction, structures: readonly StructureMeta[], selected: ReadonlySet<string>): number {
  return structures.filter((s) => selected.has(s.structureId) && actionAllowed(action, s.status)).length;
}

export function targetStatus(action: ReviewAction): 'approved' | 'rejected' | 'under_review' {
  return action === 'approve' ? 'approved' : action === 'reject' ? 'rejected' : 'under_review';
}

/** `POST /review` 的 body：只送**動作對它有意義**的結構。 */
export function reviewBody(action: ReviewAction, structures: readonly StructureMeta[], selected: ReadonlySet<string>, note: string): {
  structure_statuses: Record<string, string>;
  note: string;
} | null {
  const statuses: Record<string, string> = {};
  for (const s of structures) {
    if (selected.has(s.structureId) && actionAllowed(action, s.status)) statuses[s.structureId] = targetStatus(action);
  }
  return Object.keys(statuses).length === 0 ? null : { structure_statuses: statuses, note };
}

/** 依狀態分組，每組內依名稱；順序是「該看的先」：已編輯 → 待審 → 模型產生 → 退回 → 已簽核。 */
export function groupByStatus(structures: readonly StructureMeta[]): { status: string; items: StructureMeta[] }[] {
  const groups = new Map<string, StructureMeta[]>();
  for (const s of structures) groups.set(s.status, [...(groups.get(s.status) ?? []), s]);
  const known = STATUS_ORDER.filter((st) => groups.has(st)).map((st) => ({ status: st, items: groups.get(st)! }));
  const others = [...groups.keys()].filter((k) => !STATUS_ORDER.includes(k as ReviewStatus)).map((k) => ({ status: k, items: groups.get(k)! }));
  const byName = (a: StructureMeta, b: StructureMeta): number => (a.name ?? a.structureId).localeCompare(b.name ?? b.structureId);
  return [...known, ...others].map((g) => ({ status: g.status, items: [...g.items].sort(byName) }));
}

export function summarize(structures: readonly StructureMeta[]): string {
  const counts = new Map<string, number>();
  for (const s of structures) counts.set(s.status, (counts.get(s.status) ?? 0) + 1);
  return STATUS_ORDER.filter((st) => counts.has(st))
    .map((st) => `${statusLabel(st)} ${counts.get(st)}`)
    .join(' · ');
}

export interface ReviewEvent {
  readonly event_id: string;
  readonly structure_id: string;
  readonly frame_index: number | null;
  readonly from_status: string;
  readonly to_status: string;
  readonly note: string;
  readonly user: string;
  readonly at: string;
  /** 簽核當下檢視端的 Tier；舊事件沒有。 */
  readonly tier?: string;
  /** 在哪一類裝置上簽的（`phone`／`tablet`／`desktop`）；舊事件沒有。 */
  readonly device?: string;
  /** 事件當下的結構名稱（結構刪掉後還找得到名字）；舊事件沒有。 */
  readonly structure_name?: string;
}

const DEVICE_NOTE: Record<string, string> = { phone: msg('（在手機上）'), tablet: msg('（在平板上）') };

export function formatEvent(e: ReviewEvent, nameOf: (structureId: string) => string): string {
  const when = new Date(e.at);
  const time = Number.isNaN(when.getTime()) ? e.at : when.toLocaleString();
  const note = e.note ? t('「{note}」', { note: e.note }) : '';
  const tier = e.tier ? t('（Tier {tier}）', { tier: e.tier }) : '';
  // 手機、平板簽的標出來；電腦是常態不標
  const device = e.device !== undefined && DEVICE_NOTE[e.device] !== undefined ? t(DEVICE_NOTE[e.device]!) : '';
  // 現在的名稱（改過名就是新名字）→ 事件當下記的名稱（結構已刪除）→ 內部 id（舊事件）
  const current = nameOf(e.structure_id);
  const name = current !== e.structure_id ? current : (e.structure_name ?? current);
  return t('{time} {user} 把 {p2} 從 {p3} 改為 {p4}{note}{tier}', { time, user: e.user, p2: name, p3: statusLabel(e.from_status), p4: statusLabel(e.to_status), note, tier: tier + device });
}

export interface VersionInfo {
  readonly version_id: string;
  readonly kind: string;
  readonly created_by: string;
  readonly created_at: string;
  readonly voxel_count: number;
  readonly note: string;
}

export const VERSION_KIND_LABEL: Record<string, string> = {
  initial: msg('原始'),
  edit: msg('手繪'),
  'post-process': msg('後處理'),
  copy: msg('複製'),
  revert: msg('回復'),
  inject: msg('注入'),
};

/** 簽核面板依結構集篩選；`null` ＝ 全部。 */
export function filterBySet(structures: readonly StructureMeta[], setId: string | null): StructureMeta[] {
  return setId === null ? [...structures] : structures.filter((s) => (s.structureSetId ?? null) === setId);
}

/** 每套的結構數（給下拉選單顯示）。沒有集的算在 `null`。 */
export function countBySet(structures: readonly StructureMeta[]): Map<string | null, number> {
  const out = new Map<string | null, number>();
  for (const s of structures) out.set(s.structureSetId ?? null, (out.get(s.structureSetId ?? null) ?? 0) + 1);
  return out;
}
