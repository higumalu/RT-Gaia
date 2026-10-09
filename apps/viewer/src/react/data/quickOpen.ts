/**
 * 手機資料頁的「一鍵開啟」—— 一個 study 該先開哪一張影像。
 *
 * 規則跟桌面手動勾的結果一樣：勾一張影像會自動帶進參照它的 RTSTRUCT／劑量／REG／計畫（`addSeries`），
 * 4D 組勾整組（`toggleGroup`）。這裡只決定「勾哪一個」：
 *
 * 1. 掛著 RT 物件多的優先（開病例通常就是要看結構與劑量）；
 * 2. 模態 CT → MR → PT → 其他；
 * 3. 同分時單張影像先於 4D 組（組比較大、比較慢），再依 SeriesNumber。
 *
 * 解不開的壓縮格式（`decodable === false`）不列入；低信心、預設不合併的組（`auto === false`）當成各自的單張影像。
 */

import type { ImageRow, SeriesChildren, TemporalCandidate } from './catalogApi';
import { groupMembers } from './temporalRows';

export type QuickOpenChoice =
  | { readonly kind: 'image'; readonly image: ImageRow }
  | { readonly kind: 'group'; readonly group: TemporalCandidate; readonly members: readonly ImageRow[] };

const MODALITY_RANK: Record<string, number> = { CT: 0, MR: 1, PT: 2 };
const modalityRank = (m: string): number => MODALITY_RANK[m] ?? 3;
const seriesNo = (r: ImageRow): number => {
  const n = Number.parseInt(r.series_number, 10);
  return Number.isFinite(n) ? n : Number.MAX_SAFE_INTEGER;
};

interface Unit {
  readonly choice: QuickOpenChoice;
  readonly rt: number;
  readonly modality: number;
  readonly isGroup: 0 | 1;
  readonly number: number;
}

export function quickOpenChoice(children: SeriesChildren): QuickOpenChoice | null {
  const images = children.images.filter((r) => r.decodable !== false);
  const groups = new Map((children.temporal ?? []).filter((g) => g.auto).map((g) => [g.key, g]));
  const units: Unit[] = [];
  const doneGroups = new Set<string>();
  for (const img of images) {
    const group = img.temporal?.key !== undefined ? groups.get(img.temporal.key) : undefined;
    if (group === undefined) {
      units.push({ choice: { kind: 'image', image: img }, rt: img.rt_count, modality: modalityRank(img.modality), isGroup: 0, number: seriesNo(img) });
      continue;
    }
    if (doneGroups.has(group.key)) continue;
    doneGroups.add(group.key);
    const members = groupMembers(group, images).filter((m) => m.temporal?.role !== 'excluded');
    if (members.length === 0) continue;
    units.push({
      choice: { kind: 'group', group, members },
      rt: Math.max(...members.map((m) => m.rt_count)),
      modality: modalityRank(members[0]!.modality),
      isGroup: 1,
      number: Math.min(...members.map(seriesNo)),
    });
  }
  units.sort((a, b) => b.rt - a.rt || a.modality - b.modality || a.isGroup - b.isGroup || a.number - b.number);
  return units[0]?.choice ?? null;
}
