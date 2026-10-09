/**
 * 時間軸面板的**純邏輯**：標題、相位文字、時間曲線的 SVG 路徑。零 React。
 */

import type { Layer, TemporalState } from '../../../core';
import { msg, t } from '../../../core/i18n';

const KIND_LABEL: Record<TemporalState['kind'], string> = { cyclic: msg('呼吸／心臟相位'), series: msg('時間序列'), stream: msg('即時串流') };

const AXIS_LABEL: Record<string, string> = {
  amplitude: msg('呼吸振幅'),
  echo_time: msg('回波時間（TE）'),
  b_value: msg('擴散 b 值'),
};

/** 群組標題：參數軸（b 值、TE…）與振幅分箱用軸名；相位、時間依種類；其他（舊資料的自訂軸名）原樣。 */
export function groupTitle(g: Pick<TemporalState, 'kind' | 'axisLabel'> & Partial<Pick<TemporalState, 'frameLabels'>>): string {
  const axis = g.axisLabel.trim();
  // b 值標籤被去識別化刪掉的 DWI —— 還是 b 值軸，只是不知道值
  if (axis === 'b_value' && g.frameLabels === null) return t('擴散（b 值未知）');
  if (AXIS_LABEL[axis]) return t(AXIS_LABEL[axis]);
  return axis !== '' && axis !== 'time' && axis !== 'phase' ? axis : t(KIND_LABEL[g.kind]);
}

/**
 * `相位 3／10`（1 起算）；有時間戳加 `t = 12.5 s`。
 * 有每一幀的名字就顯示它 —— `相位 40%（5／10）`、`振幅 In 75%（4／8）`、`b 500 s/mm²（2／3）`。
 */
export function frameText(
  g: Pick<TemporalState, 'kind' | 'cursor' | 'frameCount' | 'frameTimes'> & Partial<Pick<TemporalState, 'frameLabels' | 'axisLabel' | 'unit'>>,
): string {
  const n = g.cursor + 1;
  const total = g.frameCount ?? '∞';
  const label = g.frameLabels?.[g.cursor];
  let head: string;
  if (label !== undefined && g.axisLabel === 'amplitude') head = t('振幅 {label}（{n}／{total}）', { label, n, total });
  else if (label !== undefined && g.kind === 'cyclic') head = t('相位 {label}（{n}／{total}）', { label, n, total });
  else if (label !== undefined) {
    const unit = g.unit && !label.includes(g.unit) ? ` ${g.unit}` : '';
    head = `${label}${unit}${t('（{n}／{total}）', { n, total })}`;
  } else if (g.axisLabel === 'b_value' || g.axisLabel === 'echo_time') head = t('第 {n}／{total} 組', { n, total });
  else head = g.kind === 'cyclic' ? t('相位 {n}／{total}', { n, total }) : t('第 {n}／{total} 個時間點', { n, total });
  const time = g.frameTimes?.[g.cursor];
  return time === undefined ? head : `${head} · t = ${time.toFixed(time < 10 ? 2 : 1)} s`;
}

/**
 * 時間軸列的標題：同時有兩條以上時加上影像名稱（例：CCTH 的 DCE 和 DWI 兩列都叫「時間序列」分不出來）。
 * 影像名稱取這個群組第一個影像圖層的 label。
 */
export function groupCaption(
  g: Pick<TemporalState, 'kind' | 'axisLabel' | 'temporalGroupId'> & Partial<Pick<TemporalState, 'frameLabels'>>,
  layers: readonly { readonly kind: string; readonly label: string; readonly temporalGroupId?: string | null }[],
  groupCount: number,
): string {
  const title = groupTitle(g);
  if (groupCount < 2) return title;
  const image = layers.find((l) => l.kind === 'image' && l.temporalGroupId === g.temporalGroupId);
  return image ? `${title} · ${image.label}` : title;
}

/**
 * 時間序列的每一幀都留全解析度（像影片一樣播放）最多用掉影像預算（`TierBudget.imageBytes`）的這個比例；
 * 超過就照舊：只有目前這一幀是全解析度，播放用低解析度。
 * 例：4D-Lung 512×512×132 int16 ＝ 69 MB／幀 × 10 ＝ 690 MB —— Tier A（1200 MB）、C（1000 MB）放得下，B（400 MB）放不下。
 */
export const FULL_RES_TEMPORAL_FRACTION = 0.8;

/** 全部 `frameCount` 幀的全解析度（每幀 `frameBytes`）加上已經佔用的 `usedBytes` 放不放得進預算。 */
export function keepAllFramesFullRes(frameBytes: number, frameCount: number, imageBudgetBytes: number, usedBytes = 0): boolean {
  if (!(frameBytes > 0) || !(frameCount > 0)) return false;
  return usedBytes + frameBytes * frameCount <= imageBudgetBytes * FULL_RES_TEMPORAL_FRACTION;
}

/** 時間軸列的「高清 n／N」：全部幀都是全解析度時不顯示。 */
export function fullResText(g: Pick<TemporalState, 'frameCount' | 'fullResFrames'>): string | null {
  const total = g.frameCount;
  if (total === null || total < 2) return null;
  const n = g.fullResFrames.length;
  return n >= total ? null : t('高清 {n}／{total}', { n, total });
}

export const FPS_CHOICES: readonly number[] = [1, 2, 4, 8, 12, 20];

/**
 * 時間曲線（time-intensity curve）的折線：寬 `w`、高 `h`（像素），缺值斷開。
 * 回 SVG path `d` 與每個有值的點（畫圓點、標目前相位）。全部缺值 → 空路徑。
 */
export function curvePath(values: readonly (number | null)[], w: number, h: number, pad = 3): { d: string; points: { i: number; x: number; y: number; v: number }[]; min: number; max: number } {
  const known = values.filter((v): v is number => v !== null && Number.isFinite(v));
  if (known.length === 0) return { d: '', points: [], min: 0, max: 0 };
  const min = Math.min(...known);
  const max = Math.max(...known);
  const span = max - min || 1;
  const xOf = (i: number): number => (values.length <= 1 ? w / 2 : pad + ((w - 2 * pad) * i) / (values.length - 1));
  const yOf = (v: number): number => h - pad - ((h - 2 * pad) * (v - min)) / span;
  const points: { i: number; x: number; y: number; v: number }[] = [];
  let d = '';
  let pen = false;
  values.forEach((v, i) => {
    if (v === null || !Number.isFinite(v)) {
      pen = false;
      return;
    }
    const x = xOf(i);
    const y = yOf(v);
    points.push({ i, x, y, v });
    d += `${pen ? 'L' : 'M'}${x.toFixed(1)} ${y.toFixed(1)}`;
    pen = true;
  });
  return { d, points, min, max };
}

// ── 4D ↔ 多個 3D ──────────────────────────────────────────────────────────

/**
 * 時間軸組成／拆開前後比對用：群組 id（＋ 幀數）排序後串起來。重新取樣補進相位時 id 不變、幀數變了 →
 * 也要整條重載（host 的時間群組是開病例時建的）。
 */
export function temporalSignature(groups: readonly { temporal_group_id: string; frame_count?: number | null }[]): string {
  return groups
    .map((g) => `${g.temporal_group_id}${g.frame_count === undefined || g.frame_count === null ? '' : `:${g.frame_count}`}`)
    .sort()
    .join('|');
}

/**
 * 每個體積序列現在需要哪幾幀的全解析度：攤開的那一張要它自己的幀；跟游標的要游標那一幀（播放中不算 ——
 * 播放用低解析度，`includePlaying`）＋ 每一格鎖定的相位（鎖定的格子不跟著播，要全解析度）；靜態序列是 `null`。
 * 只看可見的影像／劑量。全解析度補抓、以及「只留需要的幀」都照這張表。
 */
export function neededFullResFrames(
  layers: readonly Pick<Layer, 'kind' | 'visible' | 'contentRef' | 'temporalGroupId' | 'frameIndex'>[],
  temporal: readonly Pick<TemporalState, 'temporalGroupId' | 'cursor' | 'playing'>[],
  locks: Readonly<Record<string, Readonly<Record<string, number>>>>,
): Map<string, Set<number | null>> {
  const out = new Map<string, Set<number | null>>();
  const add = (id: string, f: number | null): void => {
    const set = out.get(id) ?? new Set<number | null>();
    set.add(f);
    out.set(id, set);
  };
  for (const l of layers) {
    if ((l.kind !== 'image' && l.kind !== 'dose') || !l.visible) continue;
    if (typeof l.frameIndex === 'number') {
      add(l.contentRef, l.frameIndex);
      continue;
    }
    if (!l.temporalGroupId) {
      add(l.contentRef, null);
      continue;
    }
    const g = temporal.find((x) => x.temporalGroupId === l.temporalGroupId);
    if (g !== undefined && !g.playing) add(l.contentRef, g.cursor);
    for (const vp of Object.values(locks)) {
      const f = vp[l.temporalGroupId];
      if (f !== undefined) add(l.contentRef, f);
    }
    if (!out.has(l.contentRef)) out.set(l.contentRef, new Set());
  }
  return out;
}

/** 這條時間軸現在是不是攤開的（左欄每一幀一張影像）。 */
export function isExpanded(layers: readonly Pick<Layer, 'temporalGroupId' | 'frameIndex' | 'kind'>[], groupId: string): boolean {
  return layers.some((l) => l.kind === 'image' && l.temporalGroupId === groupId && typeof l.frameIndex === 'number');
}

/** 「並排比較」預設：左格目前這一幀、右格差半圈（4DCT 的吸氣末 ↔ 吐氣末）。 */
export function compareFrames(cursor: number, frameCount: number): [number, number] {
  const n = Math.max(1, frameCount);
  return [cursor % n, (cursor + Math.floor(n / 2)) % n];
}

/** 後端錯誤（`HTTP 409 …: {"detail":{"message":…}}`）→ 給人看的那一句。 */
export function backendMessage(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  const at = text.indexOf('{');
  if (at >= 0) {
    try {
      const body = JSON.parse(text.slice(at)) as { detail?: { message?: string } | string; message?: string };
      if (typeof body.detail === 'object' && body.detail?.message) return body.detail.message;
      if (typeof body.detail === 'string') return body.detail;
      if (body.message) return body.message;
    } catch {
      /* 不是 JSON → 原文 */
    }
  }
  return text;
}

/** 組成 4D 的對話框：一張影像的預設名稱 —— 描述裡讀得出相位（「40%」「Gated, 40.0%」）就用它，否則序列號。 */
export function defaultFrameLabel(meta: Readonly<Record<string, unknown>> | undefined, n: number): string {
  const desc = typeof meta?.['series_description'] === 'string' ? (meta['series_description']) : '';
  const m = desc.match(/(\d{1,3}(?:\.\d+)?)\s*%/);
  if (m) return `${Number(m[1])}%`;
  const num = meta?.['series_number'];
  return typeof num === 'string' || typeof num === 'number' ? `#${String(num)}` : `#${n + 1}`;
}

/** 組成 4D 的對話框：預設順序 —— 讀得出相位的照百分比、否則照序列號、再否則照序列時間。 */
export function defaultFrameOrder<T extends { seriesMeta?: Readonly<Record<string, unknown>> }>(images: readonly T[]): T[] {
  const pct = (m: Readonly<Record<string, unknown>> | undefined): number => {
    const d = typeof m?.['series_description'] === 'string' ? (m['series_description']) : '';
    const x = d.match(/(\d{1,3}(?:\.\d+)?)\s*%/);
    return x ? Number(x[1]) : Number.NaN;
  };
  const num = (m: Readonly<Record<string, unknown>> | undefined): number => Number(m?.['series_number'] ?? Number.NaN);
  const time = (m: Readonly<Record<string, unknown>> | undefined): string => (typeof m?.['series_time'] === 'string' ? m['series_time'] : '');
  return [...images].sort((a, b) => {
    const pa = pct(a.seriesMeta);
    const pb = pct(b.seriesMeta);
    if (!Number.isNaN(pa) && !Number.isNaN(pb) && pa !== pb) return pa - pb;
    const na = num(a.seriesMeta);
    const nb = num(b.seriesMeta);
    if (!Number.isNaN(na) && !Number.isNaN(nb) && na !== nb) return na - nb;
    return time(a.seriesMeta).localeCompare(time(b.seriesMeta));
  });
}

/** 組成 4D 預設不勾的：衍生影像（AVG、MIP、MinIP）—— 它們不是某一個相位。 */
export function looksDerived(meta: Readonly<Record<string, unknown>> | undefined): boolean {
  const d = typeof meta?.['series_description'] === 'string' ? (meta['series_description']) : '';
  return /\b(average|avg|ave|mip|minip|t-?mip|t-?minip|mean)\b/i.test(d);
}

/** 每一格鎖定的相位存在這個瀏覽器，依病例分（最多記 20 個病例，舊的丟掉）。 */
export const PHASE_LOCKS_KEY = 'rtgaia.phaseLocks.v1';
type LockStore = Pick<Storage, 'getItem' | 'setItem'>;
type Locks = Record<string, Record<string, number>>;

function readAll(store: LockStore | null): Record<string, Locks> {
  try {
    const raw = store?.getItem(PHASE_LOCKS_KEY);
    const v = raw ? (JSON.parse(raw) as unknown) : {};
    return v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, Locks>) : {};
  } catch {
    return {};
  }
}

export function readPhaseLocks(store: LockStore | null, caseId: string): Locks {
  const v = readAll(store)[caseId];
  if (v === undefined || typeof v !== 'object') return {};
  const out: Locks = {};
  for (const [vp, locks] of Object.entries(v)) {
    if (locks === null || typeof locks !== 'object') continue;
    const clean = Object.fromEntries(Object.entries(locks).filter(([, f]) => Number.isInteger(f) && f >= 0));
    if (Object.keys(clean).length > 0) out[vp] = clean;
  }
  return out;
}

export function writePhaseLocks(store: LockStore | null, caseId: string, locks: Readonly<Record<string, Readonly<Record<string, number>>>>): void {
  const all = readAll(store);
  delete all[caseId];
  if (Object.keys(locks).length > 0) all[caseId] = JSON.parse(JSON.stringify(locks)) as Locks;
  const keys = Object.keys(all);
  for (const k of keys.slice(0, Math.max(0, keys.length - 20))) delete all[k];
  try {
    store?.setItem(PHASE_LOCKS_KEY, JSON.stringify(all));
  } catch {
    /* 私密視窗、配額滿：不記就是了 */
  }
}

/**
 * 組成 4D 送出的幀名：全部是預設的序列號（`#23`）就不送 —— 依「時間」組成時時間軸列顯示
 * 「第 n／N 個時間點 · t = …」比「#23」有用；有任何一個是人改過的（或讀得出相位）就照送（空白的那幀沒有名稱）。
 */
export function frameLabelsToSend(labels: readonly string[], axis: 'phase' | 'time'): string[] | null {
  const clean = labels.map((l) => l.trim());
  if (clean.every((l) => l === '' || /^#\d+$/.test(l))) return axis === 'time' || clean.every((l) => l === '') ? null : clean;
  return clean;
}

// ── 4D 的結構 ──────────────────────────────────────────────────────────────

/** 一個只屬某幾幀的結構（這條時間軸上的 mask 圖層）。 */
export interface PhaseStructure {
  readonly structureId: string;
  readonly name: string;
  readonly frames: readonly number[];
}

/** 這條時間軸上只屬某幾幀的結構（mask 圖層帶 `frames`），依第一幀排。 */
export function phaseStructures(layers: readonly Layer[], groupId: string): PhaseStructure[] {
  return layers
    .filter((l) => l.kind === 'mask' && l.temporalGroupId === groupId && Array.isArray(l.frames) && l.frames.length > 0)
    .map((l) => ({ structureId: l.contentRef, name: l.label, frames: [...(l.frames ?? [])].sort((a, b) => a - b) }))
    .sort((a, b) => (a.frames[0] ?? 0) - (b.frames[0] ?? 0) || a.name.localeCompare(b.name));
}

/**
 * 結構名去掉相位尾巴：`GTV_c00`、`GTV_50`、`GTV 50%`、`CTV-T3`、`GTV_ph2` → `GTV`；尾巴正好是那一幀的名字（`50%`）也去掉。
 * 去掉之後沒東西了（名字就是數字）→ 原名。
 */
export function phaseStem(name: string, frameLabel?: string | null): string {
  const n = name.trim();
  if (frameLabel) {
    const label = frameLabel.trim();
    if (label && n.length > label.length && n.toLowerCase().endsWith(label.toLowerCase())) {
      const rest = n.slice(0, n.length - label.length).replace(/[\s_\-.]+$/, '');
      if (rest) return rest;
    }
  }
  const rest = n.replace(/[\s_\-.]*(?:c|ph|phase|p|t|tp)?\d{1,3}(?:\.\d+)?\s*%?$/i, '').replace(/[\s_\-.]+$/, '');
  return rest || n;
}

/**
 * 自動找「同一個結構在不同相位」：名字去掉相位尾巴後相同（不分大小寫）、兩個以上、幀不重疊 → 一組（建議名 ＝ 去掉尾巴的名字）。
 * 已經涵蓋全部幀的（合成好的）不算。
 */
export function phaseStructureGroups(
  items: readonly PhaseStructure[],
  frameLabels: readonly string[] | null,
  frameCount: number,
): { stem: string; members: PhaseStructure[] }[] {
  const byKey = new Map<string, { stem: string; members: PhaseStructure[] }>();
  for (const it of items) {
    if (it.frames.length >= frameCount) continue;
    const stem = phaseStem(it.name, it.frames.length === 1 ? frameLabels?.[it.frames[0]!] : null);
    const key = stem.toLowerCase();
    const g = byKey.get(key) ?? { stem, members: [] };
    g.members.push(it);
    byKey.set(key, g);
  }
  return [...byKey.values()].filter((g) => {
    if (g.members.length < 2) return false;
    const seen = new Set<number>();
    for (const m of g.members) for (const f of m.frames) {
      if (seen.has(f)) return false;
      seen.add(f);
    }
    return true;
  });
}

/** 合成後涵蓋哪些幀；有重疊 → null（後端也會擋，這裡先讓按鈕不能按）。 */
export function mergedFrames(items: readonly PhaseStructure[]): number[] | null {
  const seen = new Set<number>();
  for (const it of items) for (const f of it.frames) {
    if (seen.has(f)) return null;
    seen.add(f);
  }
  return [...seen].sort((a, b) => a - b);
}

/** 幀的名字：時間軸有就用（`50%`），沒有 → `#n`。 */
export function frameName(labels: readonly string[] | null, k: number): string {
  return labels?.[k] || `#${k + 1}`;
}

// ── 網格不同的相位重新取樣 ─────────────────────────────────────────────────

/** 時間軸那一張影像（沒攤開的）帶的分組結果裡：被排除的相位、已重新取樣補進來的相位、是不是開著重新取樣。 */
export interface ResampleInfo {
  readonly excluded: readonly { label: string; detail: string }[];
  readonly resampled: readonly { label: string; detail: string }[];
  readonly resample: boolean;
}

export function resampleInfo(layers: readonly Layer[], groupId: string): ResampleInfo | null {
  const layer = layers.find((l) => l.kind === 'image' && l.temporalGroupId === groupId && l.frameIndex === undefined);
  const plan = layer?.seriesMeta?.['temporal'];
  if (plan === null || typeof plan !== 'object') return null;
  const p = plan as Record<string, unknown>;
  const list = (v: unknown): { label: string; detail: string }[] =>
    Array.isArray(v)
      ? v
          .filter((x): x is Record<string, unknown> => x !== null && typeof x === 'object')
          .map((x) => ({ label: typeof x['label'] === 'string' ? x['label'] : '?', detail: typeof x['detail'] === 'string' ? x['detail'] : '' }))
      : [];
  return { excluded: list(p['excluded']), resampled: list(p['resampled']), resample: p['resample'] === true };
}
