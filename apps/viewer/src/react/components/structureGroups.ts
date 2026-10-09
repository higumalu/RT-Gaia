/**
 * 結構清單的分層 —— **純邏輯**，`structure-groups.test.ts` 直接測。
 *
 * 多套 RTSTRUCT 進同一個病例時，ROI 不再混成一列，而是以來源結構集分組：
 * 「CT_20260601 · CT 20260601（2）」「ART_20260605 · CBCT 20260605（3）」。沒有來源的（假體、未指定集的新建）
 * 放在「其他」。只有一套（或零套）時不顯示分組標題，維持原本的平面清單。
 */

import type { StructureSetInfo } from '../../core/panels/api';
import { msg, t } from '../../core/i18n';

export interface StructureGroup<Row> {
  readonly key: string;
  /** null ＝「其他」（沒有來源結構集）。 */
  readonly set: StructureSetInfo | null;
  readonly title: string;
  readonly rows: readonly Row[];
  readonly visibleCount: number;
}

export const OTHER_GROUP_KEY = '__other__';

/**
 * 結構集的顯示名稱。後端建工作集時寫入的預設名稱（`<帳號> 的結構集`，存在 DB）依介面語言顯示；使用者改過的名稱照原樣。
 */
export function setLabel(set: Pick<StructureSetInfo, 'kind' | 'label' | 'owner'>): string {
  const owner = set.owner ?? '';
  if (set.kind === 'work' && owner && (!set.label || set.label === DEFAULT_WORK_SET_LABEL.replace('{owner}', owner))) {
    return t(DEFAULT_WORK_SET_LABEL, { owner });
  }
  return set.label;
}

/** 後端建工作集時寫入的名稱（`state.py`）；原文同時是翻譯 key。 */
const DEFAULT_WORK_SET_LABEL = msg('{owner} 的結構集');

/** 「CT_20260601 · CT 20260601」；label 與影像標籤相同就不重複。 */
export function setTitle(set: StructureSetInfo): string {
  if (set.kind === 'transient') return t('plugin 結果（未儲存）');
  const parts = [setLabel(set) || set.seriesInstanceUid || set.structureSetId];
  if (set.imageLabel && set.imageLabel !== set.label) parts.push(set.imageLabel);
  return parts.join(' · ');
}

/**
 * 要不要分層：有任何結構集就分層；沒有集（假體）才平鋪。
 *
 * 只剩一套時集名稱與「編輯／刪除／只看」也必須在。原本「只有一套且全屬於它就不分層」是
 * 結構集還不能編輯時的省空間規則；現在標題列是集的名稱與操作入口，只剩一套也必須在。
 * `rowSetIds` 保留在簽名裡：沒有集但列帶著集 id 的情況仍靠 `groupRows` 放進「其他」。
 */
export function shouldGroup(sets: readonly StructureSetInfo[], rowSetIds: readonly (string | null | undefined)[]): boolean {
  if (sets.length >= 1) return true;
  return rowSetIds.some((id) => !!id);
}

/**
 * 依結構集分組；順序照 `sets`（primary 的那套在前，後端已排好），「其他」最後。
 * 找不到對應集（後端有 id、前端沒收到集清單）的列也進「其他」。
 */
export function groupRows<Row>(
  rows: readonly Row[],
  sets: readonly StructureSetInfo[],
  setIdOf: (row: Row) => string | null | undefined,
  visibleOf: (row: Row) => boolean,
): StructureGroup<Row>[] {
  const bySet = new Map<string, Row[]>();
  const other: Row[] = [];
  const known = new Set(sets.map((s) => s.structureSetId));
  for (const row of rows) {
    const id = setIdOf(row);
    if (id && known.has(id)) {
      const list = bySet.get(id) ?? [];
      list.push(row);
      bySet.set(id, list);
    } else other.push(row);
  }
  const out: StructureGroup<Row>[] = sets.map((set) => {
    const list = bySet.get(set.structureSetId) ?? [];
    return { key: set.structureSetId, set, title: setTitle(set), rows: list, visibleCount: list.filter(visibleOf).length };
  });
  if (other.length > 0) out.push({ key: OTHER_GROUP_KEY, set: null, title: t('其他（沒有來源結構集）'), rows: other, visibleCount: other.filter(visibleOf).length });
  return out.filter((g) => g.rows.length > 0 || g.set !== null);
}

/** 新建結構的預設結構集：目前編輯對象所在的那套 → 該 FoR 的第一套 → 第一套 → null。 */
export function defaultSetFor(
  sets: readonly StructureSetInfo[],
  activeSetId: string | null | undefined,
  frameOfReferenceUid: string | null | undefined,
): string | null {
  if (sets.length === 0) return null;
  if (activeSetId && sets.some((s) => s.structureSetId === activeSetId)) return activeSetId;
  const sameFor = frameOfReferenceUid ? sets.find((s) => s.frameOfReferenceUid === frameOfReferenceUid) : undefined;
  return (sameFor ?? sets[0]!).structureSetId;
}


/** 結構清單的篩選：文字比對名稱（不分大小寫）＋ 只看 我的／待審／可見。 */
export type StructureFilterKind = 'all' | 'mine' | 'review' | 'visible';

export interface StructureFilter {
  readonly text: string;
  readonly kind: StructureFilterKind;
}

export const EMPTY_STRUCTURE_FILTER: StructureFilter = { text: '', kind: 'all' };

export function filterRows<Row>(
  rows: readonly Row[],
  filter: StructureFilter,
  pick: (row: Row) => { name: string; visible: boolean; status: string; editable: boolean | undefined },
): Row[] {
  const needle = filter.text.trim().toLowerCase();
  return rows.filter((row) => {
    const r = pick(row);
    if (needle && !r.name.toLowerCase().includes(needle)) return false;
    if (filter.kind === 'mine') return r.editable !== false;
    if (filter.kind === 'review') return r.status === 'under_review' || r.status === 'edited' || r.status === 'ai_generated';
    if (filter.kind === 'visible') return r.visible;
    return true;
  });
}

/** `scene.usesStructureSets`；舊後端沒送 → 有集就當 true（跟改之前的推斷一樣）。 */
export function usesStructureSetsOf(scene: Record<string, unknown>): boolean {
  if (typeof scene['usesStructureSets'] === 'boolean') return scene['usesStructureSets'];
  return Array.isArray(scene['structureSets']) && scene['structureSets'].length > 0;
}
