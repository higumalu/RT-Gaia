/**
 * 目錄樹 API。
 *
 * 只做 fetch 與 wire 型別；樹的狀態在 `tree.ts`、選取在 `selection.ts`。wire 是 snake_case
 * —— 這一頁與資料庫端點直接對話，不經 `core/transport`。
 */

import type { ImportBatch, ImportItem } from './importModel';
import type { LibrarySeries } from './selection';
import { t } from '../../core/i18n';

export interface Filters {
  readonly q: string;
  readonly patientId: string;
  readonly dateFrom: string; // YYYYMMDD 或空
  readonly dateTo: string;
  readonly modalities: readonly string[];
  readonly has: readonly string[]; // rs | dose | reg | plan
}

export const EMPTY_FILTERS: Filters = { q: '', patientId: '', dateFrom: '', dateTo: '', modalities: [], has: [] };

export function hasAnyFilter(f: Filters): boolean {
  return Boolean(f.q.trim() || f.patientId.trim() || f.dateFrom || f.dateTo || f.modalities.length || f.has.length);
}

export function filterQuery(f: Filters, extra: Record<string, string | number> = {}): string {
  const p = new URLSearchParams();
  if (f.q.trim()) p.set('q', f.q.trim());
  if (f.patientId.trim()) p.set('patient_id', f.patientId.trim());
  if (f.dateFrom) p.set('date_from', f.dateFrom);
  if (f.dateTo) p.set('date_to', f.dateTo);
  if (f.modalities.length > 0) p.set('modality', f.modalities.join(','));
  if (f.has.length > 0) p.set('has', f.has.join(','));
  for (const [k, v] of Object.entries(extra)) p.set(k, String(v));
  const s = p.toString();
  return s ? `?${s}` : '';
}

export interface PatientRow {
  readonly kind: 'patient';
  readonly patient_id: string;
  readonly patient_name?: string;
  readonly study_count: number;
  readonly series_count: number;
  readonly image_series_count: number;
  readonly modalities: readonly string[];
  readonly date_from: string | null;
  readonly date_to: string | null;
  readonly hit_count: number;
}

export interface StudyRow {
  readonly kind: 'study';
  readonly study_instance_uid: string;
  readonly patient_id: string;
  readonly study_date: string;
  readonly study_description: string;
  readonly image_series_count: number;
  readonly rt_object_count: number;
  readonly unlinked_count: number;
  readonly modalities: readonly string[];
  readonly hit_count: number;
}

export interface ImageRow extends LibrarySeries {
  readonly kind: 'image';
  readonly rt_count: number;
  readonly rtstruct_count: number;
  readonly plan_count: number;
  readonly dose_count: number;
  readonly registration_count: number;
  readonly registrations_targeting: number;
  readonly hit: boolean;
  readonly hit_count: number;
  /** 這一列在跨序列時間軸（4DCT 每相位一個序列）裡的角色。 */
  readonly temporal?: TemporalRole;
  /** 同一位置重複（MR 動態、多回波、DWI…）—— 開病例時才分幀。 */
  /**
   * 同一位置重複的序列（形狀 B）。`frames`／`axis` 是拆掉相位圖、ADC 之後真正的幀數與軸
   *（`repeats` 是原始的重複數）；`labeled: false` 的 b 值軸 ＝ b 值標籤不見了；`error` ＝ 分不成幀。
   */
  readonly dynamic?: {
    readonly repeats: number;
    readonly frames?: number;
    readonly axis?: string;
    readonly labeled?: boolean;
    /** b 值是從描述推定的（沒有 b 值標籤；開病例時再用訊號核對）。 */
    readonly guessed?: boolean;
    readonly unit?: string | null;
    readonly error?: string;
    readonly split_off?: readonly { readonly kind: string; readonly count: number }[];
  };
  /** Enhanced 多幀（一個檔放整個體積或 4D）。 */
  readonly multiframe?: { readonly frames: number };
}

/** 一列影像在時間軸候選裡的角色。 */
export interface TemporalRole {
  readonly key: string;
  readonly role: 'frame' | 'derived' | 'excluded';
  readonly index?: number;
  readonly label?: string | null;
  readonly op?: string;
  readonly reason?: string;
}

/** 一個跨序列的時間軸候選（後端 `TemporalPlan.wire()`）。`auto` ＝ 高信心、預設合併。 */
export interface TemporalCandidate {
  readonly key: string;
  readonly kind: 'cyclic' | 'series';
  readonly axis: string;
  readonly unit: string | null;
  readonly confidence: 'high' | 'medium' | 'low';
  readonly auto: boolean;
  readonly source: string;
  readonly frame_count: number;
  readonly frame_labels: readonly string[] | null;
  readonly frame_times: readonly number[] | null;
  readonly frame_series_uids: readonly string[];
  readonly derived: readonly { readonly series_uid: string; readonly op: string }[];
  readonly excluded: readonly { readonly series_uid: string; readonly label: string; readonly reason: string; readonly detail: string }[];
  readonly warnings: readonly string[];
}

export type RtKind = 'rtstruct' | 'reg' | 'plan' | 'dose' | 'other';

export interface RegDirection {
  readonly from_series_uid: string;
  readonly to_series_uid: string | null;
  readonly to_label: string;
  readonly deformable: boolean;
  readonly self: boolean;
}

export interface RtRow extends LibrarySeries {
  readonly kind: RtKind;
  readonly hit: boolean;
  /** RTPLAN：它容納的劑量。 */
  readonly doses?: readonly RtRow[];
  /** RTDOSE：計畫不在庫（掛在影像下的孤兒劑量）。 */
  readonly plan_missing?: boolean;
  /** RT-Gaia 劑量運算存的 RTDOSE（掛在網格那組影像底下；運算鏈在 `refs.derivation_description`）。 */
  readonly derived?: boolean;
  /** RTSTRUCT：被哪些計畫參照。 */
  readonly referenced_by_plans?: readonly string[];
  readonly referenced_by_plan_labels?: readonly string[];
  /** REG（只掛 moving 側）：方向。 */
  readonly direction?: RegDirection;
  readonly fixed_frame_of_reference_uid?: string;
  readonly moving_frame_of_reference_uids?: readonly string[];
}

export interface SeriesChildren {
  readonly images: readonly ImageRow[];
  readonly unlinked: readonly RtRow[];
  /** 這個 study 的跨序列時間軸候選（舊後端沒有）。 */
  readonly temporal?: readonly TemporalCandidate[];
}

export interface SearchHit {
  readonly kind: 'image' | RtKind;
  readonly series_instance_uid: string;
  readonly label: string;
  readonly path: {
    readonly patient_id: string;
    readonly study_instance_uid: string;
    readonly image_series_uid: string | null;
    readonly plan_series_uid: string | null;
    readonly unlinked: boolean;
  };
}

export interface SeriesDetail extends LibrarySeries {
  readonly kind: 'image' | RtKind;
  readonly study_date: string;
  readonly study_description: string;
  readonly manufacturer: string;
  readonly sop_class_uid: string;
  readonly directory: string | null;
  readonly attached: {
    readonly rtstruct: readonly string[];
    readonly plan: readonly string[];
    readonly dose: readonly string[];
    readonly reg: readonly string[];
    readonly registrations_targeting: readonly string[];
    readonly doses_of_plan: Readonly<Record<string, readonly string[]>>;
  } | null;
  readonly labels: Readonly<Record<string, string>>;
  readonly referenced_by_plans?: readonly string[];
  readonly direction?: RegDirection;
  /** 劑量運算存的 RTDOSE。 */
  readonly derived?: boolean;
}

export interface AffectedCase {
  readonly case_id: string;
  readonly description: string;
  readonly series_uids: readonly string[];
}

export interface DeleteResult {
  readonly level: string;
  readonly key: string;
  readonly files_moved: number;
  readonly series_uids: readonly string[];
  readonly trash_dir: string;
  readonly affected_cases: readonly AffectedCase[];
  readonly forced: boolean;
}

interface DeleteErrorDetail {
  readonly code?: string;
  readonly message?: string;
  readonly affected_cases?: AffectedCase[];
}

export class CatalogInUseError extends Error {
  constructor(readonly affectedCases: readonly AffectedCase[]) {
    super(t('{length} 個病例的選取引用到這些序列', { length: affectedCases.length }));
  }
}

export interface LibrarySummary {
  configured: boolean;
  root: string | null;
  file_count?: number;
  series_count?: number;
  patient_count?: number;
  show_patient_names?: boolean;
}

async function getJson<T>(url: string): Promise<T> {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`HTTP ${r.status} ${url}: ${(await r.text()).slice(0, 300)}`);
  return (await r.json()) as T;
}

const API = '/api/v1';

/** `GET /cases/worklist` 的一列。 */
export type CaseStatus = 'none' | 'in_progress' | 'review' | 'approved' | 'exported';
export interface WorklistCase {
  readonly case_id: string;
  readonly study_id: string | null;
  readonly source: string;
  readonly description: string;
  readonly selection: Record<string, unknown> | null;
  readonly created_by: string;
  readonly created_at: string | null;
  readonly updated_at: string | null;
  readonly status: CaseStatus;
  readonly counts: { readonly work_total: number; readonly approved: number; readonly under_review: number; readonly edited: number; readonly rejected: number; readonly import_total: number };
  readonly last_export_at: string | null;
  readonly open_users: readonly string[];
  readonly patient_id: string | null;
  readonly study_date: string;
  readonly study_description: string;
}

export const catalogApi = {
  worklist: (): Promise<WorklistCase[]> => getJson(`${API}/cases/worklist`),
  summary: (): Promise<LibrarySummary> => getJson(`${API}/library`),
  rescan: async (): Promise<void> => {
    const r = await fetch(`${API}/library/rescan`, { method: 'POST' });
    if (!r.ok) throw new Error(t('重新掃描失敗（HTTP {status}）', { status: r.status }));
  },
  patients: (f: Filters, page = 1, size = 50): Promise<{ total: number; page: number; size: number; items: PatientRow[] }> =>
    getJson(`${API}/catalog/patients${filterQuery(f, { page, size })}`),
  studies: (patientId: string, f: Filters): Promise<StudyRow[]> =>
    getJson(`${API}/catalog/patients/${encodeURIComponent(patientId)}/studies${filterQuery(f)}`),
  series: (studyUid: string, f: Filters): Promise<SeriesChildren> =>
    getJson(`${API}/catalog/studies/${encodeURIComponent(studyUid)}/series${filterQuery(f)}`),
  rt: (imageUid: string, f: Filters): Promise<RtRow[]> =>
    getJson(`${API}/catalog/series/${encodeURIComponent(imageUid)}/rt${filterQuery(f)}`),
  detail: (uid: string): Promise<SeriesDetail> => getJson(`${API}/catalog/series/${encodeURIComponent(uid)}`),
  search: (f: Filters, limit = 200): Promise<{ total: number; hits: SearchHit[] }> =>
    getJson(`${API}/catalog/search${filterQuery(f, { limit })}`),
  /** 2026-09-15：從資料庫移除（admin）；有病例引用 → 丟 `CatalogInUseError`，帶 force 再呼叫。 */
  delete: async (level: 'patients' | 'studies' | 'series', key: string, force = false): Promise<DeleteResult> => {
    const r = await fetch(`${API}/catalog/${level}/${encodeURIComponent(key)}${force ? '?force=true' : ''}`, { method: 'DELETE' });
    if (r.ok) return (await r.json()) as DeleteResult;
    let detail: DeleteErrorDetail | null = null;
    try {
      detail = ((await r.json()) as { detail?: DeleteErrorDetail }).detail ?? null;
    } catch {
      /* 非 JSON */
    }
    if (r.status === 409 && detail?.code === 'IN_USE') throw new CatalogInUseError(detail.affected_cases ?? []);
    throw new Error(detail?.message ?? `HTTP ${r.status}`);
  },
  downloadUrl: (level: 'patients' | 'studies' | 'series', key: string, compress = false): string =>
    `${API}/catalog/${level}/${encodeURIComponent(key)}/download${compress ? '?compress=true' : ''}`,
};

/** `POST /api/v1/sessions`。回 `warnings`（找不到 REG 之類）。 */
export async function createSession(body: Record<string, unknown>): Promise<{ warnings: string[]; sessionId: string }> {
  const r = await fetch(`${API}/sessions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(t('建立 session 失敗（HTTP {status}）：{p1}', { status: r.status, p1: (await r.text()).slice(0, 300) }));
  const out = (await r.json()) as { session_id: string; warnings?: string[] };
  return { warnings: out.warnings ?? [], sessionId: out.session_id };
}

// ── 匯入 ──────────────────────────────────────────────────────────────────


export const importApi = {
  open: async (detail: Record<string, unknown> = {}): Promise<ImportBatch> => {
    const r = await fetch(`${API}/import/batches`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ source: 'upload', detail }),
    });
    if (!r.ok) throw new Error(t('開匯入批次失敗（HTTP {status}）：{p1}', { status: r.status, p1: (await r.text()).slice(0, 300) }));
    return (await r.json()) as ImportBatch;
  },
  putFile: async (batchId: string, relativePath: string, body: Blob): Promise<{ items: ImportItem[] }> => {
    const r = await fetch(`${API}/import/batches/${encodeURIComponent(batchId)}/files`, {
      method: 'PUT',
      headers: { 'content-type': 'application/octet-stream', 'X-Relative-Path': encodeURIComponent(relativePath) },
      body,
    });
    if (!r.ok) throw new Error(t('HTTP {status}：{p1}', { status: r.status, p1: (await r.text()).slice(0, 200) }));
    return (await r.json()) as { items: ImportItem[] };
  },
  complete: async (batchId: string): Promise<ImportBatch> => {
    const r = await fetch(`${API}/import/batches/${encodeURIComponent(batchId)}/complete`, { method: 'POST' });
    if (!r.ok) throw new Error(t('HTTP {status}：{p1}', { status: r.status, p1: (await r.text()).slice(0, 200) }));
    return (await r.json()) as ImportBatch;
  },
  get: (batchId: string, items = true): Promise<ImportBatch> =>
    getJson(`${API}/import/batches/${encodeURIComponent(batchId)}?items=${items ? 'true' : 'false'}`),
  list: (): Promise<ImportBatch[]> => getJson(`${API}/import/batches`),
  discard: async (batchId: string): Promise<void> => {
    await fetch(`${API}/import/batches/${encodeURIComponent(batchId)}`, { method: 'DELETE' });
  },
  serverPath: async (path: string): Promise<ImportBatch> => {
    const r = await fetch(`${API}/import/server-path`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path }),
    });
    if (!r.ok) throw new Error(t('HTTP {status}：{p1}', { status: r.status, p1: (await r.text()).slice(0, 300) }));
    return (await r.json()) as ImportBatch;
  },
};
