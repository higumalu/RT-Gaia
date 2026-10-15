/**
 * 射束資料（量測資料集）的純邏輯 —— 零 React、零 fetch。後端 `routes_beam_data.py`、`rtgaia_dosecalc/beam_data.py`。
 */

import { joinList, msg } from '../../core/i18n';

export type MeasurementKind = 'depth_dose' | 'profile' | 'output_factor' | 'scalar' | 'absolute';
export type SourceKind = 'measured' | 'vendor' | 'literature' | 'synthetic';
export type DatasetStatus = 'builtin' | 'draft' | 'locked';

export interface Measurement {
  readonly measurement_id: string;
  readonly kind: MeasurementKind;
  readonly quantity: string;
  readonly unit: string;
  readonly conditions: Readonly<Record<string, string | number | readonly [number, number]>>;
  readonly columns: readonly string[];
  readonly points: readonly (readonly (number | null)[])[];
  readonly statistic: 'single' | 'mean' | 'median';
  readonly n: number | null;
  readonly reference: string;
  readonly label?: string;
}

export interface DatasetSource {
  readonly kind: SourceKind;
  readonly citation: string;
  readonly licence: string;
  readonly url: string;
  readonly note: string;
}

export interface DatasetSummary {
  readonly dataset_id: string;
  readonly name: string;
  readonly status: DatasetStatus;
  readonly builtin?: boolean;
  readonly demo: boolean;
  readonly machine: { readonly manufacturer: string; readonly model: string; readonly name: string };
  readonly beam: { readonly energy_mv: number; readonly fluence_mode: 'STANDARD' | 'FFF' };
  readonly source: DatasetSource;
  readonly note: string;
  readonly created_by?: string | null;
  readonly created_at?: string | null;
  readonly updated_by?: string | null;
  readonly updated_at?: string | null;
  readonly locked_by?: string | null;
  readonly locked_at?: string | null;
  readonly measurement_counts: Readonly<Partial<Record<MeasurementKind, number>>>;
}

export interface DatasetDetail extends Omit<DatasetSummary, 'measurements'> {
  readonly derived_from?: string | null;
  readonly measurements: readonly Measurement[];
}

export const STATUS_LABEL: Record<DatasetStatus, string> = { builtin: msg('內建'), draft: msg('草稿'), locked: msg('已鎖定') };

export const SOURCE_LABEL: Record<SourceKind, string> = {
  measured: msg('實測'),
  vendor: msg('廠商代表資料'),
  literature: msg('公開文獻'),
  synthetic: msg('研究合成'),
};

export const KIND_LABEL: Record<MeasurementKind, string> = {
  depth_dose: msg('深度劑量'),
  profile: msg('側向分佈'),
  output_factor: msg('輸出因子'),
  scalar: msg('單一量值'),
  absolute: msg('絕對校正'),
};

/** 「6 MV FFF」「10 MV」。 */
export function beamText(b: DatasetSummary['beam']): string {
  return `${b.energy_mv} MV${b.fluence_mode === 'FFF' ? ' FFF' : ''}`;
}

/** 「Varian TrueBeam」（名稱另外放）。 */
export function machineText(m: DatasetSummary['machine']): string {
  return [m.manufacturer, m.model, m.name ? `(${m.name})` : ''].filter(Boolean).join(' ');
}

/** 「深度劑量 3、輸出因子 2」。 */
export function countsText(c: DatasetSummary['measurement_counts'], label: (k: MeasurementKind) => string): string {
  return joinList((Object.keys(KIND_LABEL) as MeasurementKind[]).filter((k) => (c[k] ?? 0) > 0).map((k) => `${label(k)} ${c[k]}`));
}

/** 曲線類（深度劑量、側向分佈、正方形的輸出因子）可以畫成 x–值的折線；單一量值、長方形輸出因子不畫。 */
export function plottable(m: Measurement): boolean {
  return (m.kind === 'depth_dose' || m.kind === 'profile' || m.kind === 'output_factor') && m.columns[0] !== 'field_x_mm' && m.points.length >= 2;
}

/** 折線：x 軸 = 第一欄、y 軸 = value；回 SVG path 與座標範圍。 */
export function curvePath(m: Measurement, width: number, height: number, pad = 28): { path: string; xMin: number; xMax: number; yMax: number; dots: Array<[number, number]> } {
  const vi = m.columns.indexOf('value');
  const pts = m.points.map((r) => [r[0] ?? 0, r[vi] ?? 0] as [number, number]);
  const xs = pts.map((p) => p[0]);
  const xMin = Math.min(...xs);
  const xMax = Math.max(...xs, xMin + 1);
  const yMax = Math.max(...pts.map((p) => p[1]), 1e-9) * 1.1;
  const sx = (x: number): number => pad + ((x - xMin) / (xMax - xMin)) * (width - 2 * pad);
  const sy = (y: number): number => height - pad - (y / yMax) * (height - 2 * pad);
  const dots = pts.map(([x, y]) => [sx(x), sy(y)] as [number, number]);
  const path = dots.map(([x, y], i) => `${i === 0 ? 'M' : 'L'}${x.toFixed(1)} ${y.toFixed(1)}`).join(' ');
  return { path, xMin, xMax, yMax, dots };
}

function conditionValue(v: string | number | readonly [number, number]): string {
  return Array.isArray(v) ? `${v[0]} x ${v[1]}` : String(v);
}

/** 量測 → 通用 CSV（後端 `parse_csv` 的格式；匯出、或改完再貼回去）。 */
export function toCsv(ms: readonly Measurement[]): string {
  return ms
    .map((m) => {
      const head = [`# kind: ${m.kind}`];
      if (m.kind === 'depth_dose' || m.kind === 'scalar') head.push(`# quantity: ${m.quantity}`);
      for (const [k, v] of Object.entries(m.conditions)) head.push(`# ${k}: ${conditionValue(v)}`);
      head.push(`# unit: ${m.unit}`);
      if (m.statistic !== 'single') head.push(`# statistic: ${m.statistic}`);
      if (m.n !== null) head.push(`# n: ${m.n}`);
      if (m.reference) head.push(`# reference: ${m.reference}`);
      head.push(`# columns: ${m.columns.join(', ')}`);
      const rows = m.points.map((r) => r.map((v) => (v === null ? '' : String(v))).join(', ').replace(/, $/, ''));
      return [...head, ...rows].join('\n');
    })
    .join('\n\n');
}
