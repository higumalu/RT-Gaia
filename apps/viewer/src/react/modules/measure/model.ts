/**
 * 量測面板的**純邏輯**：layer → 表格列、CSV、方框深度換算。零 React。
 */

import { boxBounds, decimalsForUnit, formatMeasurementValue, KIND_LABEL, requiredPoints, type Layer, type Measurement } from '../../../core';
import { t } from '../../../core/i18n';

export interface MeasurementRow {
  readonly layerId: string;
  readonly measurementId: string;
  readonly kind: Measurement['kind'];
  readonly kindLabel: string;
  readonly label: string;
  readonly frameOfReferenceUid: string;
  readonly visible: boolean;
  /** 已格式化：`12.3 mm`／`45.6 mm²`／`3.20 cc`／`(x, y, z) mm`。 */
  readonly valueText: string;
  readonly value: number;
  readonly unit: string;
  readonly stats: { mean: number; min: number; max: number; stdev: number; voxelCount: number; approximate: boolean; unit?: string } | null;
  /** roi3d：深度（沿 z 的邊長；面板可改）。 */
  readonly depthMm: number | null;
  readonly measurement: Measurement;
}

export function measurementRows(layers: readonly Layer[]): MeasurementRow[] {
  const out: MeasurementRow[] = [];
  for (const layer of layers) {
    if (layer.kind !== 'measurement' || layer.measurement === undefined) continue;
    // 地標對屬於對位面板（TG-132 TRE），不列在量測表
    if (layer.measurement.kind === 'landmark') continue;
    const m = layer.measurement;
    const r = m.result;
    const unit = r?.unit === 'mm2' ? 'mm²' : r?.unit === 'deg' ? '°' : (r?.unit ?? '');
    const stats = r?.stats
      ? { mean: r.stats.mean, min: r.stats.min, max: r.stats.max, stdev: r.stats.stdev, voxelCount: r.stats.voxelCount, approximate: r.stats.approximate === true, ...(r.stats.unit ? { unit: r.stats.unit } : {}) }
      : null;
    // 畫面上的標籤與表格同一個格式（角度帶「°」）
    const valueText = formatMeasurementValue(m, r);
    let depthMm: number | null = null;
    if (m.kind === 'roi3d' && m.points.length >= 6) {
      const { min, max } = boxBounds(m.points);
      depthMm = max[2] - min[2];
    }
    out.push({
      layerId: layer.layerId,
      measurementId: m.measurementId,
      kind: m.kind,
      kindLabel: t(KIND_LABEL[m.kind]),
      label: m.label,
      frameOfReferenceUid: m.frameOfReferenceUid,
      visible: layer.visible,
      valueText,
      value: r?.value ?? 0,
      unit,
      stats,
      depthMm,
      measurement: m,
    });
  }
  return out;
}

/** 方框改深度：以中心為準沿 z 重設 min／max。 */
export function withBoxDepth(m: Measurement, depthMm: number): number[] {
  const { min, max } = boxBounds(m.points);
  const cz = (min[2] + max[2]) / 2;
  const half = Math.max(0.5, depthMm) / 2;
  return [min[0], min[1], cz - half, max[0], max[1], cz + half];
}

export function formatStats(s: MeasurementRow['stats']): string {
  if (s === null) return '';
  // HU（或舊資料沒標單位）照舊；其他單位（SUV 2 位小數）在後面標單位
  if (s.unit === undefined || s.unit === 'HU') {
    return t('{p0}{p1} ± {p2}（{p3}–{p4}，n={voxelCount}）', { p0: s.approximate ? '≈ ' : '', p1: s.mean.toFixed(1), p2: s.stdev.toFixed(1), p3: s.min.toFixed(0), p4: s.max.toFixed(0), voxelCount: s.voxelCount });
  }
  const d = decimalsForUnit(s.unit);
  return t('{p0}{p1} ± {p2} {unit}（{p3}–{p4}，n={voxelCount}）', {
    p0: s.approximate ? '≈ ' : '',
    p1: s.mean.toFixed(Math.max(1, d)),
    p2: s.stdev.toFixed(Math.max(1, d)),
    unit: s.unit,
    p3: s.min.toFixed(d),
    p4: s.max.toFixed(d),
    voxelCount: s.voxelCount,
  });
}

function csvCell(v: string | number): string {
  const s = String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** CSV（UTF-8，逗號）：種類、名稱、值、單位、影像值統計（欄名沿用 hu_*）、FoR、點、統計的單位（接在最後不動舊欄位）。 */
export function toCsv(rows: readonly MeasurementRow[]): string {
  const header = ['kind', 'label', 'value', 'unit', 'hu_mean', 'hu_stdev', 'hu_min', 'hu_max', 'voxels', 'approximate', 'frame_of_reference_uid', 'points_lps_mm', 'stats_unit'];
  const lines = [header.join(',')];
  for (const r of rows) {
    lines.push(
      [
        r.kind,
        r.label,
        r.kind === 'point' ? '' : r.value.toFixed(3),
        r.kind === 'point' ? '' : (r.measurement.result?.unit ?? ''),
        r.stats?.mean.toFixed(2) ?? '',
        r.stats?.stdev.toFixed(2) ?? '',
        r.stats?.min ?? '',
        r.stats?.max ?? '',
        r.stats?.voxelCount ?? '',
        r.stats ? (r.stats.approximate ? 'yes' : 'no') : '',
        r.frameOfReferenceUid,
        Array.from(r.measurement.points)
          .map((v) => v.toFixed(2))
          .join(' '),
        r.stats ? (r.stats.unit ?? 'HU') : '',
      ]
        .map(csvCell)
        .join(','),
    );
  }
  return lines.join('\n');
}

// ── 面板「編輯頂點」：純函式，回新的 points ──────────────────────────────────

export interface VertexRow {
  readonly index: number;
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

/** 面積／曲線量測的頂點清單（該 FoR 自己的 LPS mm）。 */
export function vertexRows(m: Measurement): VertexRow[] {
  const out: VertexRow[] = [];
  for (let i = 0; i + 2 < m.points.length; i += 3) out.push({ index: i / 3, x: m.points[i]!, y: m.points[i + 1]!, z: m.points[i + 2]! });
  return out;
}

/** 刪掉第 `index` 個頂點；刪了會少於該種類需要的點數（面積 3、曲線 2）就不能刪（回 null）。 */
export function deleteVertex(m: Measurement, index: number): number[] | null {
  const n = m.points.length / 3;
  if (n <= requiredPoints(m.kind) || index < 0 || index >= n) return null;
  const out = Array.from(m.points);
  out.splice(index * 3, 3);
  return out;
}

/** 在第 `index` 個頂點後面插一個：位置＝它與下一個頂點（面積的最後一個接回第一個）的中點；曲線的最後一點後面不能插。 */
export function canInsertAfter(m: Measurement, index: number): boolean {
  const n = m.points.length / 3;
  return index >= 0 && index < n && !(m.kind === 'curve' && index === n - 1);
}

export function insertVertexAfter(m: Measurement, index: number): number[] {
  const n = m.points.length / 3;
  if (!canInsertAfter(m, index)) return Array.from(m.points);
  const j = (index + 1) % n;
  const mid = [0, 1, 2].map((k) => (m.points[index * 3 + k]! + m.points[j * 3 + k]!) / 2);
  const out = Array.from(m.points);
  out.splice(index * 3 + 3, 0, ...mid);
  return out;
}

/** 改第 `index` 個頂點的座標；面積量測會先投回它自己的平面（只能在平面內移動）。 */
export function setVertex(m: Measurement, index: number, xyz: readonly [number, number, number]): number[] {
  const n = m.points.length / 3;
  if (index < 0 || index >= n) return Array.from(m.points);
  let p: [number, number, number] = [xyz[0], xyz[1], xyz[2]];
  const plane = m.viewReference;
  if (m.kind === 'area' && plane !== null) {
    const nrm = plane.viewPlaneNormal;
    const d = (p[0] - plane.planeOrigin[0]) * nrm[0] + (p[1] - plane.planeOrigin[1]) * nrm[1] + (p[2] - plane.planeOrigin[2]) * nrm[2];
    p = [p[0] - nrm[0] * d, p[1] - nrm[1] * d, p[2] - nrm[2] * d];
  }
  const out = Array.from(m.points);
  out.splice(index * 3, 3, ...p);
  return out;
}
