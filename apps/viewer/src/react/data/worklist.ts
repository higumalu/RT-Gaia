/** 工作清單的純邏輯：狀態文字、篩選、排序、依 study 對照。 */
import type { CaseStatus, WorklistCase } from './catalogApi';
import { joinList, msg, t } from '../../core/i18n';

export const STATUS_LABEL: Record<CaseStatus, string> = {
  none: msg('無'),
  in_progress: msg('進行中'),
  review: msg('待審'),
  approved: msg('已簽核'),
  exported: msg('已匯出'),
};

export const STATUS_ORDER: readonly CaseStatus[] = ['in_progress', 'review', 'approved', 'exported', 'none'];

export type WorklistFilter = 'all' | CaseStatus;

export function filterWorklist(cases: readonly WorklistCase[], filter: WorklistFilter, mine: string | null): WorklistCase[] {
  return cases
    .filter((c) => filter === 'all' || c.status === filter)
    .filter((c) => mine === null || c.created_by === mine || c.open_users.includes(mine) || c.counts.work_total > 0);
}

/** 最近更新在前；同時間待審優先。 */
export function sortWorklist(cases: readonly WorklistCase[]): WorklistCase[] {
  return [...cases].sort((a, b) => {
    const t = (b.updated_at ?? '').localeCompare(a.updated_at ?? '');
    if (t !== 0) return t;
    return STATUS_ORDER.indexOf(a.status) - STATUS_ORDER.indexOf(b.status);
  });
}

/** 每個 study 取「狀態最靠前」的那個病例（同一 study 可能有多種選取） */
export function caseByStudy(cases: readonly WorklistCase[]): Map<string, WorklistCase> {
  const rank = (s: CaseStatus): number => ['none', 'in_progress', 'review', 'approved', 'exported'].indexOf(s);
  const out = new Map<string, WorklistCase>();
  for (const c of cases) {
    if (!c.study_id) continue;
    const prev = out.get(c.study_id);
    if (!prev || rank(c.status) > rank(prev.status)) out.set(c.study_id, c);
  }
  return out;
}

export function countsText(c: WorklistCase): string {
  const k = c.counts;
  if (k.work_total === 0) return k.import_total > 0 ? t('{import_total} 個匯入結構', { import_total: k.import_total }) : t('沒有結構');
  const parts = [t('{work_total} 個工作結構', { work_total: k.work_total })];
  if (k.approved > 0) parts.push(t('{approved} 已簽核', { approved: k.approved }));
  if (k.under_review > 0) parts.push(t('{under_review} 待審', { under_review: k.under_review }));
  if (k.rejected > 0) parts.push(t('{rejected} 退回', { rejected: k.rejected }));
  return joinList(parts);
}
