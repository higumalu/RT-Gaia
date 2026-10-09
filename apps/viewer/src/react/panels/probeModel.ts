/**
 * 讀數列的純邏輯（左下角、沒指到或超出範圍要顯示 N/A）。
 */

import type { ProbeReadout, ProbeReading, ProbeStructureHit, StructureMeta, StructureSetInfo } from '../../core';
import { formatReadingValue, formatWorldMm } from '../../core';
import { joinList, t } from '../../core/i18n';

export const NA = 'N/A';

export interface ProbeLine {
  /** 世界座標那一欄；沒有讀數或指標離開視圖時是 `N/A` ＋ 原因。 */
  readonly world: string;
  readonly worldTitle: string;
  readonly readings: readonly { key: string; label: string; ijk: string | null; value: string; title: string | undefined; na: boolean }[];
}

export function probeLine(probe: ProbeReadout | null): ProbeLine {
  if (probe === null) return { world: NA, worldTitle: t('指標不在任何影像格內'), readings: [] };
  if (probe.source === 'frozen') return { world: NA, worldTitle: t('指標已離開影像格（十字線導航前先顯示 N/A）'), readings: [] };
  return {
    world: `${formatWorldMm(probe.world)} mm`,
    worldTitle: t('LPS 世界座標（mm）'),
    readings: probe.readings.map((r) => readingCell(r)),
  };
}

function readingCell(r: ProbeReading): ProbeLine['readings'][number] {
  const na = r.value === null;
  return {
    key: r.layerId,
    label: r.label,
    ijk: r.acquisitionIjk === null ? null : `(${r.acquisitionIjk.join(', ')})`,
    value: na ? NA : formatReadingValue(r),
    title:
      r.unavailable === 'not-resident'
        ? t('這個序列的體素還沒載入')
        : r.unavailable === 'outside-volume'
          ? t('這一點在體積之外（不顯示填充值）')
          : r.approximate
            ? t('值來自降採樣網格，不是取像值')
            : undefined,
    na,
  };
}

// ── 這一點在哪些 ROI 裡 ──────────────────────────────────────────────────────────────────────

/** 最多列幾個（前 5 個），其餘「＋N」。 */
export const PROBE_ROI_LIMIT = 5;

export interface ProbeRoiChip {
  readonly key: string;
  readonly name: string;
  /** CSS 顏色（`rgb(r, g, b)`）。 */
  readonly color: string;
  readonly title: string;
}

export interface ProbeRois {
  readonly shown: readonly ProbeRoiChip[];
  /** 超過上限的數量與名單（滑過看）。 */
  readonly more: number;
  readonly moreTitle: string;
  /** 顯示中但還沒載入、判斷不了的。 */
  readonly notResident: number;
  readonly notResidentTitle: string;
}

const EMPTY_ROIS: ProbeRois = { shown: [], more: 0, moreTitle: '', notResident: 0, notResidentTitle: '' };

function volumeOf(meta: StructureMeta | undefined): number {
  const v = meta?.volumeCc;
  const n = Array.isArray(v) ? v[0] : v;
  return typeof n === 'number' && Number.isFinite(n) ? n : Number.POSITIVE_INFINITY;
}

/** 集的短名：自己的工作集「我的」、別人的工作集＝擁有者、plugin 暫存「未儲存」、匯入集＝集標籤（截 16）。 */
function setShortName(meta: StructureMeta | undefined, set: StructureSetInfo | undefined, me: string | null): string {
  const kind = meta?.structureSetKind ?? set?.kind ?? null;
  if (kind === 'transient') return t('未儲存', { ctx: '結構集短名' });
  if (kind === 'work') {
    const owner = meta?.structureSetOwner ?? set?.owner ?? null;
    return owner !== null && owner === me ? t('我的', { ctx: '結構集短名' }) : (owner ?? t('工作集', { ctx: '結構集短名' }));
  }
  const label = set?.label ?? '';
  return label.length > 16 ? `${label.slice(0, 15)}…` : label || t('匯入', { ctx: '結構集短名' });
}

/**
 * 讀數點所在的 ROI → 狀態列要畫的色塊。體積由小到大（最具體的在前、BODY 這類排最後；體積未知排最後）；
 * 只列前 5 個；同名 ROI 出現在不同集時名稱後加集的短名（只有一個同名就不加）。讀數是 N/A（指標離開）時清空。
 */
export function probeRois(
  probe: ProbeReadout | null,
  structures: readonly StructureMeta[],
  sets: readonly StructureSetInfo[],
  me: string | null,
  limit = PROBE_ROI_LIMIT,
): ProbeRois {
  if (probe === null || probe.source !== 'pointer' || probe.structures === undefined) return EMPTY_ROIS;
  const metaOf = new Map(structures.map((m) => [m.structureId, m]));
  const setOf = new Map(sets.map((x) => [x.structureSetId, x]));
  const hits = [...probe.structures.inside].sort((a, b) => volumeOf(metaOf.get(a.structureId)) - volumeOf(metaOf.get(b.structureId)));
  const nameCount = new Map<string, number>();
  for (const h of hits) nameCount.set(h.label.toLowerCase(), (nameCount.get(h.label.toLowerCase()) ?? 0) + 1);
  const chip = (h: ProbeStructureHit): ProbeRoiChip => {
    const meta = metaOf.get(h.structureId);
    const set = meta?.structureSetId ? setOf.get(meta.structureSetId) : undefined;
    const short = setShortName(meta, set, me);
    const name = (nameCount.get(h.label.toLowerCase()) ?? 0) > 1 ? `${h.label} · ${short}` : h.label;
    const vol = volumeOf(meta);
    const rgb = h.colorRgb ?? [200, 200, 200];
    return {
      key: h.layerId,
      name,
      color: `rgb(${rgb[0]}, ${rgb[1]}, ${rgb[2]})`,
      title: [h.label, set ? t('結構集：{p0}', { p0: set.label || short }) : null, Number.isFinite(vol) ? `${vol.toFixed(1)} cc` : null].filter(Boolean).join(' · '),
    };
  };
  const all = hits.map(chip);
  const rest = all.slice(limit);
  const nr = probe.structures.notResident;
  return {
    shown: all.slice(0, limit),
    more: rest.length,
    moreTitle: joinList(rest.map((c) => c.name)),
    notResident: nr.length,
    notResidentTitle: nr.length > 0 ? t('還沒載入、判斷不了：{p0}', { p0: joinList(nr.map((h) => h.label)) }) : '',
  };
}

