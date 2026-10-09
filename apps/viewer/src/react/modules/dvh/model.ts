/**
 * DVH 面板的**純邏輯**：後端回應的型別、曲線 → 畫布座標、刻度、線型。零 React、零 DOM。
 *
 * DVH 綁定「結構 ＋ 劑量」這一對，渲染在面板，不是 Layer。
 */

import { t } from '../../../core/i18n';

export interface DvhStructure {
  readonly structure_id: string;
  readonly name: string;
  readonly color_rgb: [number, number, number];
  readonly voxel_count: number;
  readonly volume_cc: number;
  readonly outside_fraction: number;
  /**
   * 有一部分落在劑量網格外（> 0.1%）。網格外的劑量未知 ——
   * 曲線是**下限**、整體統計是 `null`、Dmax 只看網格內。舊後端沒有這個欄位 → 視為 `false`。
   */
  readonly partial?: boolean;
  readonly dmin_gy: number | null;
  readonly dmax_gy: number | null;
  readonly dmean_gy: number | null;
  readonly d98_gy?: number | null;
  readonly d95_gy: number | null;
  readonly d50_gy: number | null;
  readonly d2_gy: number | null;
  readonly v_ref_pct: number | null;
  readonly cumulative_pct: readonly number[];
}

export interface DvhResponse {
  readonly series_id: string;
  readonly frame_of_reference_uid: string;
  readonly bins: number;
  readonly dose_max_gy: number;
  readonly reference_gy: number | null;
  readonly edges_gy: readonly number[];
  readonly structures: readonly DvhStructure[];
}

export function dvhPath(seriesId: string, structureIds: readonly string[], opts: { bins?: number; referenceGy?: number | null }): string {
  const q = new URLSearchParams();
  q.set('structure_ids', structureIds.join(','));
  q.set('bins', String(opts.bins ?? 200));
  if (opts.referenceGy !== null && opts.referenceGy !== undefined && opts.referenceGy > 0) {
    q.set('reference_gy', String(opts.referenceGy));
  }
  return `/dose/${encodeURIComponent(seriesId)}/dvh?${q.toString()}`;
}

export interface PlotBox {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

/** 畫布尺寸 → 繪圖區（留軸與刻度的邊）。 */
export function plotBox(canvasWidth: number, canvasHeight: number): PlotBox {
  const left = 36;
  const top = 8;
  const right = 10;
  const bottom = 26;
  return { left, top, width: Math.max(1, canvasWidth - left - right), height: Math.max(1, canvasHeight - top - bottom) };
}

/** `(edges, cumulative)` → 畫布上的折線點；x 軸 0..xMaxGy、y 軸 0..100%。 */
export function curveToCanvas(
  edgesGy: readonly number[],
  cumulativePct: readonly number[],
  box: PlotBox,
  xMaxGy: number,
): [number, number][] {
  const out: [number, number][] = [];
  const xs = xMaxGy > 0 ? xMaxGy : 1;
  const n = Math.min(edgesGy.length, cumulativePct.length);
  for (let i = 0; i < n; i += 1) {
    const x = box.left + (edgesGy[i]! / xs) * box.width;
    const y = box.top + (1 - cumulativePct[i]! / 100) * box.height;
    out.push([x, y]);
  }
  return out;
}

/** 「好看」的刻度步距：1／2／5 × 10ⁿ，讓 0..max 大約 4–8 格。 */
export function niceStep(max: number): number {
  if (!(max > 0)) return 1;
  const raw = max / 6;
  const pow = 10 ** Math.floor(Math.log10(raw));
  const m = raw / pow;
  const f = m <= 1 ? 1 : m <= 2 ? 2 : m <= 5 ? 5 : 10;
  return f * pow;
}

export function ticks(max: number): number[] {
  const step = niceStep(max);
  const out: number[] = [];
  for (let v = 0; v <= max + step * 1e-9; v += step) out.push(Number(v.toFixed(6)));
  return out;
}

/** 多個劑量各一種線型：第一個實線、第二個虛線、第三個點線，之後循環。 */
export const DASH_PATTERNS: readonly (readonly number[])[] = [[], [6, 3], [2, 3], [8, 3, 2, 3]];

export function dashFor(doseIndex: number): readonly number[] {
  return DASH_PATTERNS[doseIndex % DASH_PATTERNS.length]!;
}

export function rgbCss(c: readonly [number, number, number]): string {
  return `rgb(${c[0]}, ${c[1]}, ${c[2]})`;
}

/** `null`／`undefined`（部分覆蓋算不出來）→ `–`。 */
export function fmtGy(v: number | null | undefined): string {
  return v === null || v === undefined || !Number.isFinite(v) ? '–' : v.toFixed(2);
}

// ── 曲線互動（強調、滑鼠提示）────────────────────────────────────────────────

/** 一條畫在畫布上的曲線：哪個劑量 × 哪個結構，與它的畫布座標。 */
export interface DrawnCurve {
  readonly doseId: string;
  readonly structureId: string;
  readonly points: readonly (readonly [number, number])[];
}

function distToSegment(px: number, py: number, a: readonly [number, number], b: readonly [number, number]): number {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const len2 = dx * dx + dy * dy;
  const u = len2 > 0 ? Math.max(0, Math.min(1, ((px - a[0]) * dx + (py - a[1]) * dy) / len2)) : 0;
  return Math.hypot(px - (a[0] + u * dx), py - (a[1] + u * dy));
}

/** 離 `(x, y)` 最近、且在 `maxDistPx` 內的曲線；沒有就 `null`。 */
export function nearestCurve(curves: readonly DrawnCurve[], x: number, y: number, maxDistPx = 6): DrawnCurve | null {
  let best: DrawnCurve | null = null;
  let bestD = maxDistPx;
  for (const c of curves) {
    for (let i = 1; i < c.points.length; i += 1) {
      const d = distToSegment(x, y, c.points[i - 1]!, c.points[i]!);
      if (d <= bestD) {
        bestD = d;
        best = c;
      }
    }
  }
  return best;
}

/** 曲線在 `doseGy` 處的累積體積（%）—— 對 `edges` 線性內插；超出範圍取端點。 */
export function volumeAtDose(edgesGy: readonly number[], cumulativePct: readonly number[], doseGy: number): number {
  const n = Math.min(edgesGy.length, cumulativePct.length);
  if (n === 0) return 0;
  if (doseGy <= edgesGy[0]!) return cumulativePct[0]!;
  for (let i = 1; i < n; i += 1) {
    if (doseGy <= edgesGy[i]!) {
      const e0 = edgesGy[i - 1]!;
      const e1 = edgesGy[i]!;
      const f = e1 > e0 ? (doseGy - e0) / (e1 - e0) : 0;
      return cumulativePct[i - 1]! + f * (cumulativePct[i]! - cumulativePct[i - 1]!);
    }
  }
  return cumulativePct[n - 1]!;
}

/** 點同一條再點一次 ＝ 取消強調。 */
export function toggleFocus(current: string | null, structureId: string): string | null {
  return current === structureId ? null : structureId;
}

/**
 * 畫曲線用的不透明度：有強調時其他結構變淡；部分覆蓋的曲線（下限）本來就淡一點。
 */
export function curveAlpha(structureId: string, focused: string | null, partial: boolean): number {
  const base = partial ? 0.5 : 1;
  return focused === null || focused === structureId ? base : base * 0.18;
}

// ── 匯出（CSV 兩種、PNG）──────────────────────────────────────────────────────

/** 匯出時每個劑量的標示。`anonymized` 時不放計畫名稱（計畫名稱有時含病人資訊）。 */
export interface DvhExportDose {
  readonly doseId: string;
  readonly label: string;
  readonly response: DvhResponse;
}

export interface DvhExportMeta {
  readonly anonymized: boolean;
  readonly patientId: string | null;
  readonly referenceGy: number;
  readonly exportedAt: Date;
}

function csvCell(v: string | number | null | undefined): string {
  if (v === null || v === undefined) return '';
  const s = typeof v === 'number' ? (Number.isFinite(v) ? String(Number(v.toFixed(4))) : '') : v;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function csvLine(cells: readonly (string | number | null | undefined)[]): string {
  return cells.map(csvCell).join(',');
}

/** `YYYY-MM-DD HH:MM`（本地時間）—— CSV 的匯出時間與 PNG 抬頭共用。 */
export function dvhStamp(d: Date): string {
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/**
 * 「只有曲線」CSV：長格式四欄，給別的軟體匯入用 —— 沒有表頭以外的說明列。
 * 數值最多四位小數。
 */
export function dvhCurvesCsv(doses: readonly DvhExportDose[]): string {
  const lines = [csvLine(['structure', 'dose', 'dose_gy', 'volume_pct'])];
  for (const d of doses) {
    for (const s of d.response.structures) {
      const n = Math.min(d.response.edges_gy.length, s.cumulative_pct.length);
      for (let i = 0; i < n; i += 1) lines.push(csvLine([s.name, d.label, d.response.edges_gy[i], s.cumulative_pct[i]]));
    }
  }
  return `${lines.join('\r\n')}\r\n`;
}

/**
 * 「完整」CSV：開頭幾列說明（匯出時間、病歷號〔不匿名時〕、參考劑量），接著指標表，再接曲線。
 * 部分覆蓋的結構：整體統計留空、`partial=yes`、曲線是下限。
 */
export function dvhFullCsv(doses: readonly DvhExportDose[], meta: DvhExportMeta): string {
  const lines: string[] = [];
  lines.push(csvLine(['exported_at', dvhStamp(meta.exportedAt)]));
  if (!meta.anonymized && meta.patientId) lines.push(csvLine(['patient_id', meta.patientId]));
  if (meta.referenceGy > 0) lines.push(csvLine(['reference_gy', meta.referenceGy]));
  lines.push('');
  const ref = meta.referenceGy > 0 ? [`v${meta.referenceGy}gy_pct`] : [];
  lines.push(
    csvLine(['structure', 'dose', 'volume_cc', 'partial', 'outside_pct', 'dmin_gy', 'dmean_gy', 'dmax_gy', 'd98_gy', 'd95_gy', 'd50_gy', 'd2_gy', ...ref]),
  );
  for (const d of doses) {
    for (const s of d.response.structures) {
      lines.push(
        csvLine([
          s.name,
          d.label,
          s.volume_cc,
          s.partial ? 'yes' : 'no',
          s.outside_fraction * 100,
          s.dmin_gy,
          s.dmean_gy,
          s.dmax_gy,
          s.d98_gy ?? null,
          s.d95_gy,
          s.d50_gy,
          s.d2_gy,
          ...(meta.referenceGy > 0 ? [s.v_ref_pct] : []),
        ]),
      );
    }
  }
  lines.push('');
  return `${lines.join('\r\n')}\r\n${dvhCurvesCsv(doses)}`;
}

/** 檔名：`DVH_<病歷號>_<時間>.<副檔名>`；匿名時沒有病歷號。只留檔名安全的字元。 */
export function dvhExportFileName(meta: Pick<DvhExportMeta, 'anonymized' | 'patientId' | 'exportedAt'>, ext: 'csv' | 'png', kind?: 'curves'): string {
  const p = (n: number): string => String(n).padStart(2, '0');
  const d = meta.exportedAt;
  const stamp = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
  const safe = (x: string): string => x.replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^_+|_+$/g, '');
  const pid = !meta.anonymized && meta.patientId ? safe(meta.patientId) : '';
  return ['DVH', pid, kind === 'curves' ? 'curves' : '', stamp].filter((x) => x).join('_') + `.${ext}`;
}

// ── 模組狀態袋：設定面板與格子面板共用的選擇 ─────────────────────────────

export const DVH_MODULE_ID = 'dvh';
export const DVH_CHART_PANEL_ID = 'dvh.chart';
export const MAX_DEFAULT_STRUCTURES = 6;

/** `api.state.modules.dvh` 的形狀（模組自己定義；核心不認識）。 */
export interface DvhModuleState {
  readonly doseIds?: readonly string[];
  readonly structureIds?: readonly string[];
  readonly referenceGy?: number;
}

export interface DvhSelection {
  readonly doseIds: readonly string[];
  readonly structureIds: readonly string[];
  readonly referenceGy: number;
}

interface LayerLike {
  readonly kind: string;
  readonly contentRef: string;
  readonly visible: boolean;
  readonly params?: Record<string, unknown>;
}

/**
 * 劑量 layer 的 `DoseUnits`（後端 `params.units`，已正規化大寫）。沒有就是 `''`。
 *
 * DVH 的欄位、參考值與軸標全是 Gy；`RELATIVE`／缺值的劑量**不能**進 DVH ——
 * 後端會回 422 `DOSE_UNITS_UNSUPPORTED`，這裡先在選擇階段就不預選、面板上標出原因。
 */
export function doseUnitsOf(layer: Pick<LayerLike, 'params'>): string {
  const u = layer.params?.['units'];
  return typeof u === 'string' ? u.trim().toUpperCase() : '';
}

export function isGyDose(layer: Pick<LayerLike, 'params'>): boolean {
  return doseUnitsOf(layer) === 'GY';
}

/** 非 Gy 劑量在 UI 上的說明（勾選框 title、面板提示）。 */
export function nonGyReason(layer: Pick<LayerLike, 'params'>): string {
  const u = doseUnitsOf(layer);
  return u === 'RELATIVE' ? t('DoseUnits=RELATIVE：相對劑量，不能算 Gy 的 DVH') : t('DoseUnits={p0}：單位不明，不能算 Gy 的 DVH', { p0: u || t('(缺)') });
}

/** 差值劑量（劑量運算 A − B 的結果，或資料庫裡有負值的 DoseType=ERROR）—— 不畫 DVH 曲線。 */
export function isSignedDose(layer: Pick<LayerLike, 'params'>): boolean {
  const m = layer.params?.['min_gy'];
  return typeof m === 'number' && m < 0;
}

/** 能進 DVH：單位是 Gy、而且不是差值。 */
export function canDvh(layer: Pick<LayerLike, 'params'>): boolean {
  return isGyDose(layer) && !isSignedDose(layer);
}

/** 不能進 DVH 的原因（勾選框 title）。 */
export function noDvhReason(layer: Pick<LayerLike, 'params'>): string {
  return isGyDose(layer) ? t('差值（有負值）不畫 DVH 曲線；到「劑量運算」面板看差值統計') : nonGyReason(layer);
}

/**
 * 沒設過的欄位用預設：可見的劑量（沒有就第一個）、可見的結構（最多 6 個）、參考 0。
 * 設過的照設的 —— 即使是空陣列（使用者可以全部取消）。
 */
export function dvhSelection(layers: readonly LayerLike[], state: DvhModuleState | undefined): DvhSelection {
  // 沒帶 params 的呼叫者（測試用的精簡 layer）視為 Gy；帶了就只預選 GY 的
  const doses = layers.filter((l) => l.kind === 'dose' && (l.params === undefined || canDvh(l)));
  const masks = layers.filter((l) => l.kind === 'mask');
  const doseIds =
    state?.doseIds ?? (doses.some((d) => d.visible) ? doses.filter((d) => d.visible) : doses.slice(0, 1)).map((d) => d.contentRef);
  const structureIds = state?.structureIds ?? masks.filter((m) => m.visible).slice(0, MAX_DEFAULT_STRUCTURES).map((m) => m.contentRef);
  return { doseIds, structureIds, referenceGy: Math.max(0, state?.referenceGy ?? 0) };
}

export function toggleId(list: readonly string[], id: string): string[] {
  return list.includes(id) ? list.filter((x) => x !== id) : [...list, id];
}
