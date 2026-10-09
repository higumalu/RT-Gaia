/** 匯出模組的純邏輯。零 React、零 fetch。 */

import type { FrameGroup, Layer, StructureMeta } from '../../../core';
import { groupLayersByFrame } from '../../panels/dataModel';
import { msg, t } from '../../../core/i18n';

export interface JobInfo {
  /** 用了哪個 profile、它改了什麼（每一項都要讓使用者看到）。 */
  readonly profile?: string;
  readonly profile_warnings?: readonly { structure_id: string | null; field: string; from: string; to: string; reason: string }[];
  readonly uid_root?: string;
  readonly job_id: string;
  readonly case_id?: string;
  readonly kind?: string;
  readonly status: 'queued' | 'running' | 'done' | 'failed';
  readonly phase: string;
  readonly percent: number;
  readonly requested_by?: string;
  readonly requested_at?: string;
  readonly finished_at?: string | null;
  readonly error?: string | null;
  readonly download_url?: string | null;
  readonly structure_count?: number;
  readonly contour_count?: number;
  readonly bytes?: number;
  readonly skipped?: readonly { structure_id: string; reason: string; frame_of_reference_uid?: string }[];
  readonly exported_versions?: Readonly<Record<string, string>>;
  /** 匿名（假名）或含真實病人識別。 */
  readonly anonymized?: boolean;
  readonly patient_id?: string;
  readonly anonymize_forced_reason?: string;
  /** 結構集標籤、序列 UID、是否存入資料庫 */
  readonly structure_set_label?: string;
  readonly series_instance_uid?: string;
  readonly saved_to_library?: boolean;
  readonly import?: { counts: Record<string, number> };
}

/** 預設選取：有已簽核的就只選已簽核（臨床用途）；否則全選（草稿）。 */
/** 空結構（體積 0，例如 AI 找不到的器官以 allow_empty 交回）：2026-09-18 預設不匯出、清單上標「空」。 */
export function isEmptyStructure(s: StructureMeta): boolean {
  const v = Array.isArray(s.volumeCc) ? Math.max(0, ...s.volumeCc) : s.volumeCc;
  return v <= 0;
}

export function defaultSelection(structures: readonly StructureMeta[]): Set<string> {
  const approved = structures.filter((s) => s.status === 'approved' && !isEmptyStructure(s)).map((s) => s.structureId);
  // 暫存的 plugin 結果預設不匯出（使用者要自己勾）；空結構也不預設匯出
  const drafts = structures.filter((s) => s.structureSetKind !== 'transient' && !isEmptyStructure(s)).map((s) => s.structureId);
  return new Set(approved.length > 0 ? approved : drafts);
}

export function hasUnapproved(structures: readonly StructureMeta[], selected: ReadonlySet<string>): boolean {
  return structures.some((s) => selected.has(s.structureId) && s.status !== 'approved');
}

export interface ExportOptions {
  readonly anonymize?: boolean;
  /** 使用者改的 DICOM 標籤（白名單 `GET /export/tags`）；空字串的欄位不送。 */
  readonly tags?: Readonly<Record<string, string>>;
  /** 匯出後直接匯入資料庫（成為一套 RS；後端強制帶真實識別）。 */
  readonly saveToLibrary?: boolean;
  /** 匯出 profile（`varian` 預設／`generic`）；不給＝後端預設（`RTGAIA_EXPORT_PROFILE`）。 */
  readonly profile?: string;
}

export function exportBody(selected: ReadonlySet<string>, targetFrameOfReferenceUid: string | null, options: boolean | ExportOptions = true): Record<string, unknown> {
  const opts: ExportOptions = typeof options === 'boolean' ? { anonymize: options } : options;
  const tags = Object.fromEntries(Object.entries(opts.tags ?? {}).filter(([, v]) => v.trim() !== '').map(([k, v]) => [k, v.trim()]));
  return {
    format: 'rtstruct',
    structure_ids: [...selected],
    anonymize: opts.anonymize ?? true,
    ...(targetFrameOfReferenceUid ? { target_frame_of_reference_uid: targetFrameOfReferenceUid } : {}),
    ...(Object.keys(tags).length > 0 ? { tags } : {}),
    ...(opts.saveToLibrary ? { save_to_library: true } : {}),
    ...(opts.profile ? { profile: opts.profile } : {}),
  };
}

/** 可改標籤（後端 `GET /export/tags`）。 */
export interface EditableTag {
  readonly keyword: string;
  readonly vr: string;
  readonly max_length: number;
  readonly phi: boolean;
}

export const TAG_LABEL: Record<string, string> = {
  StructureSetLabel: msg('結構集標籤（Label）'),
  StructureSetName: msg('結構集名稱'),
  StructureSetDescription: msg('結構集描述'),
  SeriesDescription: msg('序列描述'),
  SeriesNumber: msg('序列號'),
  OperatorsName: msg('操作者'),
  ReferringPhysicianName: msg('主治醫師'),
  InstitutionName: msg('機構'),
  StationName: msg('工作站'),
  StudyDescription: msg('Study 描述'),
  AccessionNumber: 'Accession Number',
  PatientName: msg('病人姓名'),
  PatientID: msg('病歷號'),
  PatientBirthDate: msg('出生日期（YYYYMMDD）'),
  PatientSex: msg('性別（M／F／O）'),
};

/** 本機先檢查（與後端 `validate_tags` 同一套）：長度、DA、性別、整數。 */
export function tagProblems(tags: Readonly<Record<string, string>>, whitelist: readonly EditableTag[]): string[] {
  const out: string[] = [];
  for (const [k, raw] of Object.entries(tags)) {
    const v = raw.trim();
    if (!v) continue;
    const spec = whitelist.find((w) => w.keyword === k);
    if (!spec) {
      out.push(t('{k} 不在可改的標籤清單', { k }));
      continue;
    }
    const label = t(TAG_LABEL[k] ?? k);
    // 每個欄位只報一個問題（與後端 validate_tags 一致：格式錯就不再報長度）
    if (spec.vr === 'DA' && !/^\d{8}$/.test(v)) out.push(t('{label} 要 YYYYMMDD', { label }));
    else if (k === 'PatientSex' && !['M', 'F', 'O'].includes(v.toUpperCase())) out.push(t('{label} 只能是 M／F／O', { label }));
    else if (spec.vr === 'IS' && !/^-?\d+$/.test(v)) out.push(t('{label} 要整數', { label }));
    else if (v.length > spec.max_length) out.push(t('{label} 最多 {max_length} 個字元', { label, max_length: spec.max_length }));
  }
  return out;
}

export const PHASE_LABEL: Record<string, string> = {
  queued: msg('排隊中'),
  extract_contours: msg('重抽輪廓'),
  write_dicom: msg('寫 DICOM'),
  done: msg('完成'),
  failed: msg('失敗'),
};

export function phaseLabel(phase: string): string {
  // 表裡是翻譯 key（msg）：要經 t() —— 以前直接回 key，英文介面的匯出進度顯示「完成 100%」
  const key = PHASE_LABEL[phase];
  return key === undefined ? phase : t(key);
}

export function isTerminal(status: JobInfo['status']): boolean {
  return status === 'done' || status === 'failed';
}

export function formatBytes(bytes: number | undefined): string {
  if (!bytes) return '';
  if (bytes >= 1e6) return `${(bytes / 1e6).toFixed(1)} MB`;
  return `${Math.round(bytes / 1e3)} KB`;
}

/** 一行摘要：「3 個結構 · 412 條輪廓 · 1.2 MB · 跳過 2」 */
export function summarizeJob(job: JobInfo): string {
  const parts: string[] = [];
  if (job.structure_count !== undefined) parts.push(t('{structure_count} 個結構', { structure_count: job.structure_count }));
  if (job.contour_count !== undefined) parts.push(t('{contour_count} 條輪廓', { contour_count: job.contour_count }));
  if (job.bytes) parts.push(formatBytes(job.bytes));
  if (job.skipped && job.skipped.length > 0) parts.push(t('跳過 {length}', { length: job.skipped.length }));
  if (job.structure_set_label) parts.push(t('「{structure_set_label}」', { structure_set_label: job.structure_set_label }));
  if (job.anonymized === true) parts.push(t('匿名'));
  else if (job.anonymized === false) parts.push(t('含病人識別{p0}', { p0: job.patient_id ? t('（{patient_id}）', { patient_id: job.patient_id }) : '' }));
  if (job.saved_to_library) parts.push(t('已存入資料庫'));
  if (job.profile) parts.push(job.profile === 'varian' ? 'Varian Eclipse' : t('通用'));
  if (job.error) parts.push(job.error);
  return parts.join(' · ');
}

export const SKIP_REASON: Record<string, string> = { not_in_target_frame: msg('不在目標 FoR（RTSTRUCT 只能屬於一組影像）') };


/** 匯出目的：下載檔案（可匿名）或存入資料庫（一律真實識別）。 */
export type ExportPurpose = 'download' | 'library';

/** 執行前一行摘要：「3 個結構 · 目標 CT · 含 2 個草稿 · 匿名 · 存入資料庫」—— 與送出的 payload 一致。 */
export function exportSummary(input: {
  count: number;
  targetLabel: string | null;
  draftCount: number;
  purpose: ExportPurpose;
  anonymize: boolean;
  tagCount: number;
}): string {
  const parts: string[] = [t('{count} 個結構', { count: input.count })];
  if (input.targetLabel) parts.push(t('目標 {targetLabel}', { targetLabel: input.targetLabel }));
  if (input.draftCount > 0) parts.push(t('含 {draftCount} 個草稿', { draftCount: input.draftCount }));
  if (input.purpose === 'library') parts.push(t('含病人識別'), t('存入資料庫'));
  else parts.push(input.anonymize ? t('匿名') : t('含病人識別'), t('下載檔案'));
  if (input.tagCount > 0) parts.push(t('改 {tagCount} 個標籤', { tagCount: input.tagCount }));
  return parts.join(' · ');
}

/** profile 改動的一句話（例：「ROI 名稱 Parotid_Left_Superficial → Parotid_Left_Sup：超過 16 字元」）。 */
export function describeProfileWarning(w: { field: string; from: string; to: string; reason: string }): string {
  const FIELD: Record<string, string> = {
    ROIName: t('ROI 名稱'),
    RTROIInterpretedType: t('ROI 類型'),
    label: t('結構集標籤'),
    description: t('結構集描述'),
    series_description: t('Series 描述'),
  };
  return t('{p0} {from} → {to}：{reason}', { p0: FIELD[w.field] ?? w.field, from: w.from, to: w.to, reason: w.reason });
}

export interface ExportTarget {
  readonly frameOfReferenceUid: string;
  readonly role: string;
  /** 使用者認得的名字：模態＋日期＋SeriesDescription（跟資料面板的影像組標題同一套），主要影像標「（主要）」。 */
  readonly label: string;
  /** 滑過看的細節：FoR UID。 */
  readonly detail: string;
}

/**
 * 匯出目標以「哪一份影像」呈現 —— 以前是「主要影像 / 次要影像 …FoR 尾碼」，多個 CBCT 時要看 UID 才分得出來。
 * 名字重複（例：同一天兩個同描述的 CBCT）才補 FoR 尾碼區分。
 */
export function exportTargets(layers: readonly Layer[], frameGroups: readonly FrameGroup[]): ExportTarget[] {
  const views = groupLayersByFrame(layers, frameGroups).filter((v) => frameGroups.some((f) => f.frameOfReferenceUid === v.frameOfReferenceUid));
  const base = views.map((v) => {
    const name = [v.title, v.subtitle].filter(Boolean).join(' ');
    return { v, name: v.role === 'primary' ? `${name}${t('（主要）')}` : name };
  });
  return base.map(({ v, name }) => {
    const dup = base.filter((b) => b.name === name).length > 1;
    return {
      frameOfReferenceUid: v.frameOfReferenceUid,
      role: v.role,
      label: dup ? `${name} …${v.frameOfReferenceUid.slice(-6)}` : name,
      detail: `FoR ${v.frameOfReferenceUid}`,
    };
  });
}

