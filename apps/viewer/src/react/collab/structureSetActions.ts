/**
 * 結構集標題「⋯」選單能做什麼。純函式，UI 只照著畫。
 *
 * 規則與後端一致（`routes_structure_sets.py`）：匯入集唯讀（沒有選單）；暫存集走保存／丟棄；
 * 工作集只有擁有者或 admin 能改名／描述／刪除／搬入。「搬入」還要有一個**可編輯、且不在這一套**的作用中結構。
 */
import type { StructureSetInfo } from '../../core/panels/api';
import { joinList, t } from '../../core/i18n';

export type StructureSetAction = 'edit' | 'delete' | 'move-here';

export interface ActiveStructureRef {
  readonly structureId: string;
  readonly structureSetId: string | null;
  readonly editable: boolean;
  readonly frameOfReferenceUid: string;
}

/**
 * 後端沒帶 `editable`／`mine`（舊後端、或還沒 refresh）時在前端補算：規則與後端 `Case.structure_set_wire` 相同。
 */
export function withSetPermissions(
  sets: readonly StructureSetInfo[],
  user: { readonly username: string; readonly role: string } | null,
): StructureSetInfo[] {
  return sets.map((s) => {
    if (s.editable !== undefined && s.mine !== undefined) return s;
    const mine = (s.kind === 'work' || s.kind === 'transient') && user !== null && s.owner === user.username;
    const admin = user?.role === 'admin';
    const editable = (s.kind === 'work' && (mine || admin)) || (s.kind === 'transient' && mine);
    return { ...s, mine: s.mine ?? mine, editable: s.editable ?? editable };
  });
}

export function structureSetActions(set: StructureSetInfo, active: ActiveStructureRef | null): StructureSetAction[] {
  if (set.kind !== 'work' || set.editable !== true) return [];
  const out: StructureSetAction[] = ['edit', 'delete'];
  if (
    active !== null &&
    active.editable &&
    active.structureSetId !== set.structureSetId &&
    active.frameOfReferenceUid === set.frameOfReferenceUid
  ) {
    out.push('move-here');
  }
  return out;
}

/** 刪除前的確認文字：列結構數；已簽核的另外點名（後端會 409，先講清楚）。 */
export function deleteConfirmText(set: StructureSetInfo, rows: { name: string; status: string }[]): string {
  const approved = rows.filter((r) => r.status === 'approved').map((r) => r.name);
  const head = t('刪除結構集「{label}」與它的 {length} 個結構？結構會先放進暫存區，14 天內可以救回。', { label: set.label, length: rows.length });
  if (approved.length === 0) return head;
  return t('{head}\n\n其中 {length} 個已簽核（{p2}{p3}）：要先撤回簽核，或由 admin 強制刪除（已簽核的會進封存區）。', { head, length: approved.length, p2: joinList(approved.slice(0, 5)), p3: approved.length > 5 ? '…' : '' });
}

/** 後端錯誤 → 給人看的一句話。 */
export function describeSetError(message: string): string {
  if (message.includes('SET_HAS_APPROVED')) return t('這一套裡有已簽核的結構：先撤回簽核，或請 admin 強制刪除。');
  if (message.includes('DUPLICATE_LABEL')) return t('你已經有同名的結構集。');
  if (message.includes('NAME_CONFLICT')) return t('目標結構集裡已有同名結構，先改名再搬。');
  if (message.includes('NOT_OWNER')) return t('這不是你的結構集。');
  if (message.includes('IMPORT_READ_ONLY')) return t('匯入的結構集是唯讀的。');
  if (message.includes('FOR_MISMATCH')) return t('結構與目標結構集屬於不同組影像。');
  return message;
}
