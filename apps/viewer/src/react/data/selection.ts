/**
 * 資料頁的**純邏輯**：選取集合、自動帶入、primary、記憶體估算、
 * `POST /api/v1/sessions` 的 body。零 React、零 fetch —— `library-selection.test.ts` 直接測。
 *
 * wire 形狀來自後端 `library/index.py` 的 `SeriesEntry.to_wire()`；目錄樹列（`catalogApi.ts`）都是它的擴充。
 */

import { joinList, t } from '../../core/i18n';

export interface LibrarySeries {
  readonly series_instance_uid: string;
  readonly study_instance_uid: string;
  readonly patient_id: string;
  readonly patient_name?: string;
  readonly modality: string;
  readonly series_date: string;
  readonly series_time: string;
  readonly series_description: string;
  readonly series_number: string;
  readonly frame_of_reference_uid: string;
  readonly manufacturer_model_name: string;
  readonly instance_count: number;
  readonly is_image: boolean;
  readonly refs: Record<string, unknown>;
  readonly links: Record<string, unknown>;
  /** 壓縮格式（名稱）、能不能解、解不了的原因（影像序列才有；舊後端沒有）。 */
  readonly transfer_syntax?: string;
  readonly decodable?: boolean;
  readonly decode_error?: string | null;
  readonly geometry_hint?: {
    rows: number | null;
    columns: number | null;
    pixel_spacing: number[];
    slice_thickness: number | null;
    slice_count: number;
  };
}

export interface LibraryStudy {
  readonly study_instance_uid: string;
  readonly study_date: string;
  readonly study_description: string;
  readonly series: readonly LibrarySeries[];
}

export interface LibraryPatient {
  readonly patient_id: string;
  readonly patient_name?: string;
  readonly studies: readonly LibraryStudy[];
}

export interface LibraryTree {
  readonly total: number;
  readonly patients: readonly LibraryPatient[];
}

/** 一組選取。全部是 `SeriesInstanceUID`。 */
export interface Selection {
  readonly images: readonly string[];
  readonly structureSets: readonly string[];
  readonly doses: readonly string[];
  readonly registrations: readonly string[];
  readonly plans: readonly string[];
  readonly primary: string | null;
  /** 時間軸候選 key → 合併／分開，蓋過預設（高信心合併、低信心分開）。 */
  readonly temporal?: Readonly<Record<string, 'merge' | 'split'>>;
}

export const EMPTY_SELECTION: Selection = {
  images: [],
  structureSets: [],
  doses: [],
  registrations: [],
  plans: [],
  primary: null,
};

export type SelectionBucket = Exclude<keyof Selection, 'primary' | 'temporal'>;

/** 模態 → 選取集合裡的哪一欄。影像類（CT／MR／PT／…）全部歸 `images`。 */
export function bucketOf(series: Pick<LibrarySeries, 'modality' | 'is_image'>): SelectionBucket | null {
  if (series.is_image) return 'images';
  switch (series.modality) {
    case 'RTSTRUCT':
      return 'structureSets';
    case 'RTDOSE':
      return 'doses';
    case 'REG':
      return 'registrations';
    case 'RTPLAN':
      return 'plans';
    default:
      return null;
  }
}

export function flattenSeries(tree: LibraryTree): LibrarySeries[] {
  return tree.patients.flatMap((p) => p.studies.flatMap((s) => s.series));
}

export function isSelected(sel: Selection, uid: string): boolean {
  return (['images', 'structureSets', 'doses', 'registrations', 'plans'] as const).some((k) => sel[k].includes(uid));
}

function withAdded(list: readonly string[], uid: string): string[] {
  return list.includes(uid) ? [...list] : [...list, uid];
}

function withRemoved(list: readonly string[], uid: string): string[] {
  return list.filter((x) => x !== uid);
}

/**
 * 勾一個序列。**影像序列會自動帶入它的 bundle**（參照它的 RTSTRUCT／RTDOSE／REG／
 * RTPLAN，由後端索引算好）；RT 物件單獨勾就只加它自己。
 *
 * 第一個影像自動成為 primary（之後可改）。
 */
export function addSeries(sel: Selection, series: LibrarySeries, all: readonly LibrarySeries[]): Selection {
  const bucket = bucketOf(series);
  if (bucket === null) return sel;
  // 壓縮格式解不了的影像不能進「要開的病例」（開了也是 422 CS9）；照樣可以下載、轉送、刪除
  if (!canOpenSeries(series)) return sel;
  let next: Selection = { ...sel, [bucket]: withAdded(sel[bucket], series.series_instance_uid) };
  if (bucket === 'images') {
    const bundle = (series.links['bundle'] ?? {}) as Partial<Record<string, string[]>>;
    const known = new Set(all.map((s) => s.series_instance_uid));
    const take = (key: string): string[] => (bundle[key] ?? []).filter((u) => known.has(u));
    next = {
      ...next,
      structureSets: take('structure_sets').reduce(withAdded, next.structureSets),
      doses: take('doses').reduce(withAdded, next.doses),
      registrations: take('registrations').reduce(withAdded, next.registrations),
      plans: take('plans').reduce(withAdded, next.plans),
      primary: next.primary ?? series.series_instance_uid,
    };
  }
  return next;
}

/** 這個序列能不能拿來開病例（影像序列的壓縮格式要解得開；舊後端沒有欄位 ＝ 可以）。 */
export function canOpenSeries(series: Pick<LibrarySeries, 'decodable'>): boolean {
  return series.decodable !== false;
}

/** 取消一個序列。取消影像時**不**連帶取消它的 RT 物件（使用者可能另有打算）；primary 消失就換下一個。 */
export function removeSeries(sel: Selection, series: Pick<LibrarySeries, 'modality' | 'is_image' | 'series_instance_uid'>): Selection {
  const bucket = bucketOf(series);
  if (bucket === null) return sel;
  const uid = series.series_instance_uid;
  const next: Selection = { ...sel, [bucket]: withRemoved(sel[bucket], uid) };
  if (bucket === 'images' && sel.primary === uid) {
    return { ...next, primary: next.images[0] ?? null };
  }
  return next;
}

export function toggleSeries(sel: Selection, series: LibrarySeries, all: readonly LibrarySeries[]): Selection {
  return isSelected(sel, series.series_instance_uid) ? removeSeries(sel, series) : addSeries(sel, series, all);
}

export function setPrimary(sel: Selection, uid: string): Selection {
  if (!sel.images.includes(uid)) return sel;
  return { ...sel, primary: uid };
}

/** 選取集合的大致記憶體（影像 int16、劑量 float32）。只是給使用者一個量級。 */
export function estimateBytes(sel: Selection, all: readonly LibrarySeries[]): number {
  const byUid = new Map(all.map((s) => [s.series_instance_uid, s]));
  let total = 0;
  for (const uid of sel.images) {
    const g = byUid.get(uid)?.geometry_hint;
    if (g && g.rows && g.columns) total += g.rows * g.columns * g.slice_count * 2;
  }
  for (const uid of sel.doses) {
    const s = byUid.get(uid);
    const frames = Number((s?.refs['frame_count'] as number | null) ?? 0);
    // 劑量網格大小不在標頭摘要裡；以 217²×frames 的常見尺寸估
    total += 217 * 217 * Math.max(1, frames) * 4;
  }
  return total;
}

export function formatBytes(bytes: number): string {
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(2)} GB`;
  if (bytes >= 1e6) return `${Math.round(bytes / 1e6)} MB`;
  return `${Math.round(bytes / 1e3)} KB`;
}

/** `POST /api/v1/sessions` 的 body（snake_case，見 `loaders/case.py` 的 `CaseSelection.from_wire`）。 */
export function toSessionRequest(sel: Selection): Record<string, unknown> {
  return {
    primary_series_uid: sel.primary,
    image_series_uids: [...sel.images],
    structure_set_uids: [...sel.structureSets],
    dose_uids: [...sel.doses],
    registration_uids: [...sel.registrations],
    plan_uids: [...sel.plans],
    ...(sel.temporal && Object.keys(sel.temporal).length > 0 ? { temporal_overrides: { ...sel.temporal } } : {}),
  };
}

/** 選取是否能開：至少一個影像、primary 在影像裡。 */
export function selectionProblems(sel: Selection): string[] {
  const out: string[] = [];
  if (sel.images.length === 0) out.push(t('至少要選一個影像序列'));
  if (sel.primary !== null && !sel.images.includes(sel.primary)) out.push(t('primary 不在選取的影像裡'));
  return out;
}

/** DICOM `YYYYMMDD` → `YYYY-MM-DD`；空字串原樣。 */
export function formatDicomDate(d: string | null | undefined): string {
  if (!d || d.length < 8) return d ?? '';
  return `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`;
}

/** `<input type=date>` 的 `YYYY-MM-DD` → 後端要的 `YYYYMMDD`（後端兩種都吃，這裡統一）。 */
export function toDicomDate(d: string): string {
  return d.replace(/-/g, '');
}

/** wire 上的純量 → 文字；物件／陣列／空值 → 空字串（不要印出 `[object Object]`）。 */
function text(v: unknown): string {
  return typeof v === 'string' || typeof v === 'number' ? String(v) : '';
}

/** 一個序列在表格上的一行摘要（不含 PatientName）。 */
export function seriesSummary(s: LibrarySeries): string {
  const parts: string[] = [];
  if (s.is_image) {
    const g = s.geometry_hint;
    if (g && g.rows && g.columns) parts.push(`${g.columns}×${g.rows}×${g.slice_count}`);
    if (g?.slice_thickness) parts.push(`${g.slice_thickness} mm`);
  } else if (s.modality === 'RTSTRUCT') {
    parts.push(`${text(s.links['roi_count']) || text(s.refs['roi_count']) || '?'} ROI`);
    if (text(s.refs['structure_set_label'])) parts.push(text(s.refs['structure_set_label']));
  } else if (s.modality === 'RTDOSE') {
    parts.push(text(s.refs['dose_units']));
    if (text(s.links['plan_label'])) parts.push(t('計畫 {p0}', { p0: text(s.links['plan_label']) }));
  } else if (s.modality === 'REG') {
    const types = Array.isArray(s.links['matrix_types']) ? (s.links['matrix_types'] as unknown[]).map(text) : [];
    parts.push(types.join('/') || 'REG');
    if (s.links['deformable']) parts.push(t('DIR（目前不支援）'));
  } else if (s.modality === 'RTPLAN') {
    if (text(s.refs['plan_label'])) parts.push(text(s.refs['plan_label']));
    const rx = Array.isArray(s.refs['prescription_gy']) ? (s.refs['prescription_gy'] as unknown[]).map(text) : [];
    if (rx.length > 0) parts.push(t('處方 {p0} Gy', { p0: rx.join('/') }));
  }
  return parts.filter(Boolean).join(' · ');
}


/** 「本次載入」的一句話摘要：主要影像 → 其他影像 → 結構集／劑量／REG／計畫。 */
export function selectionSummary(sel: Selection, byUid: ReadonlyMap<string, LibrarySeries>): string {
  if (sel.images.length === 0) return t('還沒選影像：勾一個 CT／CBCT 開始（結構、劑量、對位會跟著它一起進來）。');
  const primary = sel.primary ? byUid.get(sel.primary) : undefined;
  const parts: string[] = [];
  parts.push(primary ? t('主要影像 {p0}', { p0: seriesSummary(primary) }) : t('主要影像未設'));
  if (sel.images.length > 1) parts.push(t('另 {p0} 組影像', { p0: sel.images.length - 1 }));
  if (sel.structureSets.length) parts.push(t('{length} 套結構集', { length: sel.structureSets.length }));
  if (sel.doses.length) parts.push(t('{length} 個劑量', { length: sel.doses.length }));
  if (sel.registrations.length) parts.push(t('{length} 個對位', { length: sel.registrations.length }));
  if (sel.plans.length) parts.push(t('{length} 個計畫', { length: sel.plans.length }));
  return parts.join(' · ');
}

function countAll(sel: Selection): number {
  return sel.images.length + sel.structureSets.length + sel.doses.length + sel.registrations.length + sel.plans.length;
}

/** 勾了一個序列之後，除了它本身還多了什麼（影像會把掛在它下面的 RS／劑量／REG 一起帶進來）。沒有就 null。 */
export function dependencyHint(before: Selection, after: Selection, toggled: Pick<LibrarySeries, 'series_instance_uid'>): string | null {
  const added = countAll(after) - countAll(before);
  if (added <= 1) return null;
  const extra: string[] = [];
  const d = (k: keyof Pick<Selection, 'structureSets' | 'doses' | 'registrations' | 'plans'>, label: (n: number) => string): void => {
    const n = after[k].length - before[k].length;
    if (n > 0) extra.push(label(n));
  };
  d('structureSets', (n) => t('{n} 套結構集', { n }));
  d('doses', (n) => t('{n} 個劑量', { n }));
  d('registrations', (n) => t('{n} 個對位', { n }));
  d('plans', (n) => t('{n} 個計畫', { n }));
  const imagesAdded = after.images.length - before.images.length - (after.images.includes(toggled.series_instance_uid) && !before.images.includes(toggled.series_instance_uid) ? 1 : 0);
  if (imagesAdded > 0) extra.push(t('{imagesAdded} 組影像', { imagesAdded }));
  return extra.length ? t('已一併加入關聯物件：{p0}（在右側「本次載入」可個別移除）', { p0: joinList(extra) }) : null;
}
