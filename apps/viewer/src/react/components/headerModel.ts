/**
 * 頂列三個固定資訊的**純邏輯**：
 * 病例摘要、編輯對象、保存狀態。零 React —— `header-model.test.ts` 直接測。
 */

import { setLabel as setDisplayName } from './structureGroups';
import type { FrameGroup, Layer } from '../../core';
import type { PresenceUser, StructureMeta, StructureSetInfo } from '../../core/panels/api';
import type { QueueFailure } from '../../core/edit/submitQueue';
import { readOnlyReason } from '../collab/model';
import { joinList, t } from '../../core/i18n';

function metaText(layer: Layer | undefined, key: string): string {
  const v = layer?.seriesMeta?.[key];
  return typeof v === 'string' ? v : typeof v === 'number' ? String(v) : '';
}

export function formatDate(d: string): string {
  return d.length >= 8 ? `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}` : d;
}

export interface CaseSummary {
  readonly patientId: string;
  readonly studyDate: string;
  readonly primaryLabel: string;
  readonly secondaryCount: number;
  readonly text: string;
}

/**
 * 病例摘要：PatientID · study 日期 · 主要影像（模態＋描述）；次要影像數。
 * 🔴 不顯示姓名（後端預設不送；就算送了也只在資料頁）。假體（沒有 seriesMeta）→ null。
 */
export function caseSummaryOf(layers: readonly Layer[], frameGroups: readonly FrameGroup[]): CaseSummary | null {
  const primaryFor = frameGroups.find((f) => f.role === 'primary')?.frameOfReferenceUid;
  const images = layers.filter((l) => l.kind === 'image');
  const primary = images.find((l) => l.frameOfReferenceUid === primaryFor) ?? images[0];
  if (!primary || !primary.seriesMeta) return null;
  const patientId = metaText(primary, 'patient_id');
  if (!patientId) return null;
  const modality = primary.modality || metaText(primary, 'dicom_modality');
  const desc = metaText(primary, 'series_description');
  const studyDate = formatDate(metaText(primary, 'study_date') || metaText(primary, 'series_date'));
  const primaryLabel = [modality, desc].filter(Boolean).join(' ');
  const secondaryCount = new Set(images.map((l) => l.frameOfReferenceUid)).size - 1;
  const parts = [patientId, studyDate, primaryLabel].filter(Boolean);
  return { patientId, studyDate, primaryLabel, secondaryCount: Math.max(0, secondaryCount), text: parts.join(' · ') };
}

export interface EditTarget {
  readonly kind: 'none' | 'editable' | 'readonly';
  readonly structureName: string;
  readonly setLabel: string;
  readonly reason: string | null;
  /** 唯讀且能合併 → 帶來源結構 id，給「合併到我的」按鈕。 */
  readonly mergeable: boolean;
  readonly text: string;
}

/** 「編輯中：我的結構集／Left Parotid」或「唯讀：CT_20260601／BODY」或「沒有選取結構」。 */
export function editTargetOf(
  structures: readonly StructureMeta[],
  sets: readonly StructureSetInfo[],
  activeStructureId: string | null,
  me: string | null | undefined,
): EditTarget {
  const st = activeStructureId ? structures.find((s) => s.structureId === activeStructureId) : undefined;
  if (!st) return { kind: 'none', structureName: '', setLabel: '', reason: null, mergeable: false, text: t('沒有選取結構') };
  const set = sets.find((x) => x.structureSetId === st.structureSetId);
  const setLabel = set ? (set.kind === 'work' && set.owner === me ? t('我的結構集') : setDisplayName(set) || set.structureSetId) : '';
  const name = st.name ?? st.structureId;
  const reason = readOnlyReason(st);
  if (reason !== null) {
    const mergeable = st.editable === false && !!st.structureSetId;
    return { kind: 'readonly', structureName: name, setLabel, reason, mergeable, text: t('唯讀：{p0}{name}', { p0: setLabel ? t('{setLabel}／', { setLabel }) : '', name }) };
  }
  return { kind: 'editable', structureName: name, setLabel, reason: null, mergeable: false, text: t('編輯中：{p0}{name}', { p0: setLabel ? t('{setLabel}／', { setLabel }) : '', name }) };
}

export interface SaveStatusInput {
  readonly loading: boolean;
  readonly editsFlushed: boolean;
  readonly failures: readonly QueueFailure[];
  readonly lastSavedAt: number | null;
  readonly now?: number;
}

export interface SaveStatus {
  readonly kind: 'loading' | 'syncing' | 'saved' | 'failed' | 'idle';
  readonly text: string;
  readonly detail: string;
}

export function formatClock(ms: number): string {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/**
 * 保存狀態：載入中／同步中／已保存 14:02／保存失敗 N 筆。
 * 🔴 失敗優先於一切 —— `editsFlushed` 在重試用盡後仍是 false，只看它會把停止的失敗說成「同步中」。
 */
export function saveStatusOf(input: SaveStatusInput): SaveStatus {
  if (input.failures.length > 0) {
    const names = input.failures.map((f) => f.structureId);
    return {
      kind: 'failed',
      text: t('保存失敗 {length} 筆', { length: input.failures.length }),
      detail: t('這些結構有編輯沒有存到後端（重試已用盡）：{p0}。請重畫一次，或重新載入病例取回後端版本。', { p0: joinList(names) }),
    };
  }
  if (input.loading) return { kind: 'loading', text: t('載入中…'), detail: t('正在載入病例') };
  // 「同步到 API」與「已持久保存」是兩種保證——前者是送出佇列清空，後者是後端 200 之後
  //   （後端在每個會推送的變更點 write-through 寫 DB；失敗會是 5xx，不會靜默）。措辭把這兩層分開說。
  if (!input.editsFlushed) return { kind: 'syncing', text: t('送出中…'), detail: t('編輯還在送到後端（尚未寫入資料庫）；離開前請等它完成') };
  if (input.lastSavedAt !== null) return { kind: 'saved', text: t('已保存 {p0}', { p0: formatClock(input.lastSavedAt) }), detail: t('後端已接受並寫進資料庫（write-through）；重新整理或換機器都在') };
  return { kind: 'idle', text: t('已同步'), detail: t('尚無編輯；載入的內容與後端一致') };
}

export function onlineOthers(presence: readonly PresenceUser[], me: string | null | undefined): number {
  return new Set(presence.filter((p) => p.connections > 0 && p.user !== me).map((p) => p.user)).size;
}
