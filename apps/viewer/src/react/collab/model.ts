/**
 * 多人「各自新增、可合併」的**純邏輯**。零 React、零 fetch —— `collab-model.test.ts` 直接測。
 */

import type { PresenceUser, StructureMeta, StructureSetInfo } from '../../core/panels/api';
import type { ConflictAction, MergeConflict } from './collabApi';
import { joinList, t } from '../../core/i18n';

/** 這一套是不是我的工作集。 */
export function isMine(set: Pick<StructureSetInfo, 'kind' | 'owner'>, me: string | null | undefined): boolean {
  return set.kind === 'work' && !!me && set.owner === me;
}

/** 集標題旁的徽章文字：匯入／我的／<擁有者>。 */
export function setBadge(set: Pick<StructureSetInfo, 'kind' | 'owner'>, me: string | null | undefined): { text: string; tone: 'import' | 'mine' | 'other' } {
  // plugin 結果（暫存集）不是匯入的：以前一律標「匯入」
  if (set.kind === 'transient') return { text: t('未儲存'), tone: 'mine' };
  if (set.kind !== 'work') return { text: t('匯入'), tone: 'import' };
  if (isMine(set, me)) return { text: t('我的'), tone: 'mine' };
  return { text: set.owner ?? t('他人'), tone: 'other' };
}

/** 唯讀原因（給編輯工具的停用說明）。 */
export function readOnlyReason(st: Pick<StructureMeta, 'editable' | 'structureSetKind' | 'structureSetOwner' | 'status'>): string | null {
  if (st.status === 'approved') return t('結構已簽核（approved），唯讀；審核者可在「簽核」面板重新開啟');
  if (st.editable === false) {
    if (st.structureSetKind === 'import') return t('匯入的結構集唯讀；請先「合併到我的結構集」再編輯');
    return t('這是 {p0} 的結構集，唯讀；請先「合併到我的結構集」再編輯', { p0: st.structureSetOwner ?? t('別人') });
  }
  return null;
}

/** 給 `setLockedStructures` 的清單：已簽核或不可改的結構與原因。 */
export function lockedEntries(structures: readonly StructureMeta[]): { structureId: string; reason: string }[] {
  const out: { structureId: string; reason: string }[] = [];
  for (const st of structures) {
    const reason = readOnlyReason(st);
    if (reason !== null) out.push({ structureId: st.structureId, reason });
  }
  return out;
}

/** 同名的目標能不能覆蓋：已簽核的不行（不經重新開啟就改內容；後端 409 APPROVED_LOCKED）。 */
export function replaceAllowed(conflict: Pick<MergeConflict, 'existing_status'>): boolean {
  return conflict.existing_status !== 'approved';
}

/** 合併對話框：預設決定 ＝ 覆蓋為新版本；目標已簽核 → 改名。 */
export function defaultResolutions(conflicts: readonly MergeConflict[]): Record<string, ConflictAction> {
  const out: Record<string, ConflictAction> = {};
  for (const c of conflicts) out[c.structure_id] = replaceAllowed(c) ? 'replace' : 'rename';
  return out;
}

/** 對話框裡可勾的結構：來源集裡、且不在我的集裡的。 */
export function mergeCandidates(structures: readonly StructureMeta[], sourceSetId: string): StructureMeta[] {
  return structures.filter((s) => s.structureSetId === sourceSetId);
}

/** 合併結果的一句話：「新增 3 · 覆蓋 1 · 改名 1 · 跳過 2」。 */
export function summarizeMerge(merged: readonly { action: string }[]): string {
  const count = (a: string): number => merged.filter((m) => m.action === a).length;
  const parts: string[] = [];
  if (count('add')) parts.push(t('新增 {p0}', { p0: count('add') }));
  if (count('replace')) parts.push(t('覆蓋 {p0}', { p0: count('replace') }));
  if (count('rename')) parts.push(t('改名 {p0}', { p0: count('rename') }));
  if (count('skip')) parts.push(t('跳過 {p0}', { p0: count('skip') }));
  if (count('already')) parts.push(t('已在我的集 {p0}', { p0: count('already') }));
  return parts.join(' · ') || t('（沒有變更）');
}

/** 誰在線（有 WS 連線的人，去重、排除自己可選）。 */
export function onlineUsers(presence: readonly PresenceUser[], exclude?: string | null): string[] {
  const seen = new Set<string>();
  for (const p of presence) if (p.connections > 0 && p.user !== exclude) seen.add(p.user);
  return [...seen].sort();
}

/** 別人正在編輯的結構 → 誰（在線、有 `editing`、不是我；同一人多個分頁去重）。 */
export function editorsByStructure(presence: readonly PresenceUser[], me: string | null | undefined): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const p of presence) {
    if (p.connections <= 0 || !p.editing || p.user === me) continue;
    const list = out.get(p.editing) ?? [];
    if (!list.includes(p.user)) list.push(p.user);
    out.set(p.editing, list.sort());
  }
  return out;
}

/**
 * 標頭「● N 人在線」的說明 —— 每人一行：`王醫師：編輯 GTV`／`王醫師：檢視`。
 * 結構名稱用我自己的結構清單解析；我看不到的（別人的暫存結構）只說「編輯中」。
 */
export function onlineDetails(presence: readonly PresenceUser[], me: string | null | undefined, nameOf: (structureId: string) => string | null): string[] {
  const byUser = new Map<string, Set<string>>();
  for (const p of presence) {
    if (p.connections <= 0 || p.user === me) continue;
    const set = byUser.get(p.user) ?? new Set<string>();
    if (p.editing) set.add(p.editing);
    byUser.set(p.user, set);
  }
  return [...byUser.keys()].sort().map((u) => {
    const editing = [...byUser.get(u)!];
    if (editing.length === 0) return t('{user}：檢視', { user: u });
    const names = editing.map((id) => nameOf(id));
    return names.every((n) => n === null) ? t('{user}：編輯中', { user: u }) : t('{user}：編輯 {names}', { user: u, names: joinList(names.filter((n): n is string => n !== null)) });
  });
}

export function isOnline(presence: readonly PresenceUser[], user: string | null | undefined): boolean {
  return !!user && presence.some((p) => p.user === user && p.connections > 0);
}

/** 匯出預設：我的工作集有結構 → 只選我的；否則沿用舊規則（有已簽核只選已簽核，否則全選）。 */
export function defaultExportSelection(structures: readonly StructureMeta[], me: string | null | undefined): Set<string> {
  const mine = structures.filter((s) => s.structureSetKind === 'work' && !!me && s.structureSetOwner === me).map((s) => s.structureId);
  if (mine.length > 0) return new Set(mine);
  const approved = structures.filter((s) => s.status === 'approved').map((s) => s.structureId);
  return new Set(approved.length > 0 ? approved : structures.map((s) => s.structureId));
}
