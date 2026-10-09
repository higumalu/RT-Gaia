/**
 * 資料頁的 4D 組：**純邏輯**，零 React —— `data-temporal-4d.test.ts` 直接測。
 *
 * 4DCT 每個相位一個序列：資料頁把它們合成**一列**「4D CT · 10 個相位 ＋ AVG、MIP」，展開才看到各相位；
 * 勾這一列 ＝ 勾全部成員（各相位 ＋ 衍生影像）。高信心的組預設「合併成時間軸」，低信心（沒有相位標籤）預設不合併，
 * 兩種都能切換（存在 `Selection.temporal`，送給後端的 `temporal_overrides`）。
 */

import type { ImageRow, TemporalCandidate } from './catalogApi';
import { addSeries, canOpenSeries, isSelected, removeSeries, type LibrarySeries, type Selection } from './selection';
import { joinList, msg, t } from '../../core/i18n';

/** 組的成員，依序：各相位（幀的順序）→ 衍生影像 → 被排除的相位。 */
export function groupMembers(group: TemporalCandidate, images: readonly ImageRow[]): ImageRow[] {
  const mine = images.filter((r) => r.temporal?.key === group.key);
  const rank = (r: ImageRow): number => {
    const role = r.temporal?.role;
    if (role === 'frame') return r.temporal?.index ?? 0;
    return role === 'derived' ? 10_000 : 20_000;
  };
  return mine.sort((a, b) => rank(a) - rank(b) || a.series_instance_uid.localeCompare(b.series_instance_uid));
}

/** 這一組現在要不要合併成時間軸：使用者改過就照他的，沒改就照後端的信心。 */
export function isMerged(sel: Selection, group: Pick<TemporalCandidate, 'key' | 'auto'>): boolean {
  const o = sel.temporal?.[group.key];
  return o === undefined ? group.auto : o === 'merge';
}

/** 切換合併；跟預設一樣就把覆寫拿掉（送出的請求保持乾淨）。 */
export function setMerged(sel: Selection, group: Pick<TemporalCandidate, 'key' | 'auto'>, merge: boolean): Selection {
  const next = { ...(sel.temporal ?? {}) };
  if (merge === group.auto) delete next[group.key];
  else next[group.key] = merge ? 'merge' : 'split';
  return { ...sel, temporal: next };
}

export type GroupState = 'all' | 'some' | 'none';

/** 可開的成員（解不了的壓縮格式不能選）有幾個被選了。 */
export function groupState(sel: Selection, members: readonly LibrarySeries[]): GroupState {
  const openable = members.filter(canOpenSeries);
  const n = openable.filter((m) => isSelected(sel, m.series_instance_uid)).length;
  if (n === 0) return 'none';
  return n === openable.length ? 'all' : 'some';
}

/**
 * 勾／取消整組。勾：每個成員照一般影像的規則加（帶入各自的 RS／劑量／REG），primary 換成第一個相位
 * （4D 組本身當 primary）—— 除非使用者已經指定了組外的影像。被排除的相位不勾（開了也會被略過）。
 */
export function toggleGroup(sel: Selection, group: TemporalCandidate, members: readonly ImageRow[], all: readonly LibrarySeries[]): Selection {
  const usable = members.filter((m) => m.temporal?.role !== 'excluded');
  if (groupState(sel, usable) === 'all') return usable.reduce<Selection>((s, m) => removeSeries(s, m), sel);
  const before = sel.primary;
  let next = usable.reduce<Selection>((s, m) => addSeries(s, m, all), sel);
  const first = group.frame_series_uids.find((u) => next.images.includes(u)) ?? null;
  const memberUids = new Set(members.map((m) => m.series_instance_uid));
  if (first !== null && (before === null || memberUids.has(before))) next = { ...next, primary: first };
  return next;
}

const AXIS_TITLE: Record<string, string> = {
  phase: msg('{n} 個相位'),
  amplitude: msg('振幅分箱 · {n} 個'),
  time: msg('{n} 個時間點'),
};

const OP_LABEL: Record<string, string> = { avg: 'AVG', mip: 'MIP', minip: 'MinIP' };

/** 組的一行標題：`4D · 10 個相位（0%…90%）`；低信心的說「可能是」。 */
export function groupTitle(group: TemporalCandidate): string {
  const n = group.frame_count;
  const labels = group.frame_labels;
  const range = labels && labels.length > 1 ? t('（{a}…{b}）', { a: labels[0]!, b: labels[labels.length - 1]! }) : '';
  const body = t(AXIS_TITLE[group.axis] ?? AXIS_TITLE['time']!, { n });
  return group.confidence === 'low' ? t('可能是同一次動態掃描 · {body}（沒有相位標籤）', { body }) : t('4D · {body}{range}', { body, range });
}

/** 組的附註：`＋ AVG、MIP · 排除 2 個相位`。 */
export function groupNote(group: TemporalCandidate): string {
  const parts: string[] = [];
  if (group.derived.length > 0) parts.push(t('＋ {ops}', { ops: joinList(group.derived.map((d) => OP_LABEL[d.op] ?? d.op)) }));
  if (group.excluded.length > 0) parts.push(t('排除 {n} 個相位', { n: group.excluded.length }));
  return parts.join(' · ');
}

/** 成員列上的小徽章：相位名稱、AVG／MIP、已排除（原因）。 */
export function memberBadge(row: Pick<ImageRow, 'temporal'>, group?: TemporalCandidate): { text: string; title?: string } | null {
  const r = row.temporal;
  if (!r) return null;
  if (r.role === 'frame') return { text: r.label ?? `#${(r.index ?? 0) + 1}` };
  if (r.role === 'derived') return { text: OP_LABEL[r.op ?? ''] ?? (r.op ?? '').toUpperCase() };
  const detail = group?.excluded.find((x) => x.label === r.label)?.detail;
  return { text: t('{label} 已排除', { label: r.label ?? '' }), ...(detail ? { title: detail } : {}) };
}

/**
 * 同一位置重複的序列（形狀 B）：`動態 ×12`、`多回波 ×4`、`b 值 ×3`（拆掉相位圖、ADC 之後的幀數）；Enhanced：`多幀 400`。
 */
export function dynamicBadge(row: Partial<Pick<ImageRow, 'dynamic' | 'multiframe'>>): string | null {
  const d = row.dynamic;
  if (d && d.repeats > 1) {
    if (d.error) return t('無法分幀');
    const n = d.frames ?? d.repeats;
    if (d.axis === 'echo_time') return t('多回波 ×{n}', { n });
    if (d.axis === 'b_value') return d.labeled === false ? t('b 值未知 ×{n}', { n }) : d.guessed === true ? t('b 值（推定）×{n}', { n }) : t('b 值 ×{n}', { n });
    if (d.axis === 'phase') return t('4D ×{n}', { n });
    return t('動態 ×{n}', { n });
  }
  return row.multiframe ? t('多幀 {n}', { n: row.multiframe.frames }) : null;
}

const SPLIT_TEXT: Record<string, string> = {
  phase_image: msg('另有 {n} 張相位影像（Image Type P／R／I），開病例時不載入'),
  derived_image: msg('另有 {n} 張衍生影像（ADC 等），開病例時不載入'),
};

/** 徽章的滑鼠提示：分不成幀的原因、拆出去的影像。 */
export function dynamicTitle(row: Partial<Pick<ImageRow, 'dynamic'>>): string {
  const d = row.dynamic;
  const base = t('同一個位置有多張影像（動態、多回波、擴散…）：開病例時分成時間點或參數軸');
  if (!d) return base;
  if (d.error) return d.error;
  const extra = (d.split_off ?? []).filter((x) => SPLIT_TEXT[x.kind]).map((x) => t(SPLIT_TEXT[x.kind]!, { n: x.count }));
  if (d.axis === 'b_value' && d.labeled === false) extra.unshift(t('看起來是擴散影像，但沒有 b 值標籤（可能被去識別化移除）'));
  return [base, ...extra].join('\n');
}
