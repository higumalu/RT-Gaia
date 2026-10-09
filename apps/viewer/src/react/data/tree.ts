/**
 * 目錄樹的**純狀態**：展開集合、每層子項快取、載入中、錯誤；
 * 以及把它攤成可渲染的平面列。零 React、零 fetch —— `data-tree.test.ts` 直接測。
 *
 * 層級：
 *
 *     patient › study › image › { rtstruct | plan ▸ dose | dose(孤兒) | reg }
 *                     › unlinked › rt…
 *
 * 節點鍵：`p:<patient_id>`、`s:<study_uid>`、`i:<series_uid>`、`plan:<series_uid>`、`u:<study_uid>`（未關聯群）。
 */

import type { ImageRow, PatientRow, RtRow, SearchHit, SeriesChildren, StudyRow, TemporalCandidate } from './catalogApi';
import { groupMembers } from './temporalRows';
import type { LibrarySeries } from './selection';
import { t } from '../../core/i18n';

export type NodeKey = string;

export const patientKey = (patientId: string): NodeKey => `p:${patientId}`;
export const studyKey = (studyUid: string): NodeKey => `s:${studyUid}`;
export const imageKey = (seriesUid: string): NodeKey => `i:${seriesUid}`;
export const planKey = (seriesUid: string): NodeKey => `plan:${seriesUid}`;
export const unlinkedKey = (studyUid: string): NodeKey => `u:${studyUid}`;
/** 4D 組（跨序列時間軸候選）。 */
export const temporalKey = (groupKey: string): NodeKey => `t:${groupKey}`;

export interface TreeState {
  readonly expanded: ReadonlySet<NodeKey>;
  readonly studies: ReadonlyMap<string, readonly StudyRow[]>; // patient_id →
  readonly series: ReadonlyMap<string, SeriesChildren>; // study_uid →
  readonly rt: ReadonlyMap<string, readonly RtRow[]>; // image series uid →
  readonly loading: ReadonlySet<NodeKey>;
  readonly errors: ReadonlyMap<NodeKey, string>;
}

export const EMPTY_TREE: TreeState = {
  expanded: new Set(),
  studies: new Map(),
  series: new Map(),
  rt: new Map(),
  loading: new Set(),
  errors: new Map(),
};

function withSet<T>(set: ReadonlySet<T>, value: T, on: boolean): ReadonlySet<T> {
  const next = new Set(set);
  if (on) next.add(value);
  else next.delete(value);
  return next;
}

function withMap<K, V>(map: ReadonlyMap<K, V>, key: K, value: V | undefined): ReadonlyMap<K, V> {
  const next = new Map(map);
  if (value === undefined) next.delete(key);
  else next.set(key, value);
  return next;
}

export function isExpanded(t: TreeState, key: NodeKey): boolean {
  return t.expanded.has(key);
}

export function setExpanded(t: TreeState, key: NodeKey, on: boolean): TreeState {
  return { ...t, expanded: withSet(t.expanded, key, on) };
}

export function toggleExpanded(t: TreeState, key: NodeKey): TreeState {
  return setExpanded(t, key, !t.expanded.has(key));
}

export function expandMany(t: TreeState, keys: readonly NodeKey[]): TreeState {
  const next = new Set(t.expanded);
  for (const k of keys) next.add(k);
  return { ...t, expanded: next };
}

export function setLoading(t: TreeState, key: NodeKey, on: boolean): TreeState {
  return { ...t, loading: withSet(t.loading, key, on) };
}

export function setError(t: TreeState, key: NodeKey, message: string | null): TreeState {
  return { ...t, errors: withMap(t.errors, key, message ?? undefined) };
}

export function withStudies(t: TreeState, patientId: string, rows: readonly StudyRow[]): TreeState {
  return { ...t, studies: withMap(t.studies, patientId, rows) };
}

export function withSeries(t: TreeState, studyUid: string, children: SeriesChildren): TreeState {
  return { ...t, series: withMap(t.series, studyUid, children) };
}

export function withRt(t: TreeState, imageUid: string, rows: readonly RtRow[]): TreeState {
  return { ...t, rt: withMap(t.rt, imageUid, rows) };
}

/** 篩選一變，子項快取全部作廢（每層的 `hit` 與可見性都跟篩選走），展開狀態保留。 */
export function clearChildren(t: TreeState): TreeState {
  return { ...t, studies: new Map(), series: new Map(), rt: new Map(), loading: new Set(), errors: new Map() };
}

export type ExpandedTarget = { readonly key: NodeKey; readonly kind: 'patient' | 'study' | 'image'; readonly id: string };

/**
 * 目前展開中、**需要子項資料**的節點（病人 → study → 影像的順序）。
 *
 * 🔴 篩選或重新掃描會 `clearChildren()`；展開狀態保留但子項沒了，若沒有人重抓，畫面就是永遠的「載入中…」
 * （看起來像「重新掃描後載入很久」—— 其實後端 0.1 s 就回了）。呼叫端拿這個清單逐一 `ensure`。
 * `plan:`／`u:` 節點的子項隨影像／study 一起回來，不需要自己抓。
 */
export function expandedTargets(t: TreeState): ExpandedTarget[] {
  const order = { patient: 0, study: 1, image: 2 } as const;
  const out: ExpandedTarget[] = [];
  for (const key of t.expanded) {
    if (key.startsWith('p:')) out.push({ key, kind: 'patient', id: key.slice(2) });
    else if (key.startsWith('s:')) out.push({ key, kind: 'study', id: key.slice(2) });
    else if (key.startsWith('i:')) out.push({ key, kind: 'image', id: key.slice(2) });
  }
  return out.sort((a, b) => order[a.kind] - order[b.kind]);
}

/** 一個搜尋命中要展開哪些節點（由外往內）。 */
export function keysForHit(hit: SearchHit): NodeKey[] {
  const p = hit.path;
  const keys = [patientKey(p.patient_id), studyKey(p.study_instance_uid)];
  if (p.unlinked || p.image_series_uid === null) {
    keys.push(unlinkedKey(p.study_instance_uid));
    return keys;
  }
  if (hit.kind !== 'image') keys.push(imageKey(p.image_series_uid));
  if (p.plan_series_uid) keys.push(planKey(p.plan_series_uid));
  return keys;
}

/** 目前已載入的所有序列（影像 ＋ RT ＋ 計畫底下的劑量 ＋ 未關聯）—— 選取模型的 `all`。 */
export function loadedSeries(t: TreeState): LibrarySeries[] {
  const out: LibrarySeries[] = [];
  for (const children of t.series.values()) {
    out.push(...children.images, ...children.unlinked);
    for (const u of children.unlinked) if (u.doses) out.push(...u.doses);
  }
  for (const rows of t.rt.values()) {
    for (const r of rows) {
      out.push(r);
      if (r.doses) out.push(...r.doses);
    }
  }
  return out;
}

export type FlatRow =
  | { readonly key: NodeKey; readonly depth: number; readonly kind: 'patient'; readonly row: PatientRow }
  | { readonly key: NodeKey; readonly depth: number; readonly kind: 'study'; readonly row: StudyRow }
  | { readonly key: NodeKey; readonly depth: number; readonly kind: 'image'; readonly row: ImageRow }
  | {
      readonly key: NodeKey;
      readonly depth: number;
      readonly kind: 'temporal';
      readonly row: { readonly group: TemporalCandidate; readonly members: readonly ImageRow[] };
    }
  | { readonly key: NodeKey; readonly depth: number; readonly kind: 'unlinked'; readonly row: { studyUid: string; count: number } }
  | { readonly key: NodeKey; readonly depth: number; readonly kind: 'rt'; readonly row: RtRow; readonly nested: boolean }
  | { readonly key: NodeKey; readonly depth: number; readonly kind: 'loading' }
  | { readonly key: NodeKey; readonly depth: number; readonly kind: 'error'; readonly message: string }
  | { readonly key: NodeKey; readonly depth: number; readonly kind: 'empty'; readonly message: string };

/**
 * 攤成平面列。只展開 `expanded` 裡的節點；子項未載入 → `loading` 列（呼叫端負責去抓）。
 * 這是渲染的唯一輸入，因此樹的所有規則（PLAN 容納 DOSE、未關聯群、孤兒劑量）都在這裡定型。
 */
export function flatten(tree: TreeState, patients: readonly PatientRow[]): FlatRow[] {
  const out: FlatRow[] = [];
  const childState = (key: NodeKey, depth: number, loaded: boolean): boolean => {
    const err = tree.errors.get(key);
    if (err) {
      out.push({ key: `${key}#err`, depth, kind: 'error', message: err });
      return false;
    }
    if (!loaded) {
      out.push({ key: `${key}#loading`, depth, kind: 'loading' });
      return false;
    }
    return true;
  };

  for (const p of patients) {
    const pk = patientKey(p.patient_id);
    out.push({ key: pk, depth: 0, kind: 'patient', row: p });
    if (!tree.expanded.has(pk)) continue;
    const studies = tree.studies.get(p.patient_id);
    if (!childState(pk, 1, studies !== undefined)) continue;
    if (studies!.length === 0) out.push({ key: `${pk}#empty`, depth: 1, kind: 'empty', message: t('沒有符合的 study') });
    for (const st of studies!) {
      const sk = studyKey(st.study_instance_uid);
      out.push({ key: sk, depth: 1, kind: 'study', row: st });
      if (!tree.expanded.has(sk)) continue;
      const children = tree.series.get(st.study_instance_uid);
      if (!childState(sk, 2, children !== undefined)) continue;
      if (children!.images.length === 0 && children!.unlinked.length === 0) {
        out.push({ key: `${sk}#empty`, depth: 2, kind: 'empty', message: t('沒有符合的序列') });
      }
      const pushImage = (img: ImageRow, depth: number): void => {
        const ik = imageKey(img.series_instance_uid);
        out.push({ key: ik, depth, kind: 'image', row: img });
        if (!tree.expanded.has(ik) || img.rt_count === 0) return;
        const rt = tree.rt.get(img.series_instance_uid);
        if (!childState(ik, depth + 1, rt !== undefined)) return;
        for (const r of rt!) pushRt(out, tree, r, depth + 1);
      };
      // 4D 組（每相位一個序列）合成一列，放在第一個成員的位置；展開才列出各相位與 AVG／MIP
      const groups = new Map((children!.temporal ?? []).map((g) => [g.key, g]));
      const emitted = new Set<string>();
      for (const img of children!.images) {
        const gk = img.temporal?.key;
        const group = gk !== undefined ? groups.get(gk) : undefined;
        if (group === undefined) {
          pushImage(img, 2);
          continue;
        }
        if (emitted.has(group.key)) continue;
        emitted.add(group.key);
        const members = groupMembers(group, children!.images);
        const tk = temporalKey(group.key);
        out.push({ key: tk, depth: 2, kind: 'temporal', row: { group, members } });
        if (tree.expanded.has(tk)) for (const m of members) pushImage(m, 3);
      }
      if (children!.unlinked.length > 0) {
        const uk = unlinkedKey(st.study_instance_uid);
        out.push({ key: uk, depth: 2, kind: 'unlinked', row: { studyUid: st.study_instance_uid, count: children!.unlinked.length } });
        if (tree.expanded.has(uk)) for (const r of children!.unlinked) pushRt(out, tree, r, 3);
      }
    }
  }
  return out;
}

function pushRt(out: FlatRow[], t: TreeState, r: RtRow, depth: number): void {
  const key = r.kind === 'plan' ? planKey(r.series_instance_uid) : `rt:${r.series_instance_uid}`;
  out.push({ key, depth, kind: 'rt', row: r, nested: false });
  if (r.kind === 'plan' && r.doses && r.doses.length > 0 && t.expanded.has(key)) {
    for (const d of r.doses) out.push({ key: `rt:${d.series_instance_uid}`, depth: depth + 1, kind: 'rt', row: d, nested: true });
  }
}

/** 一列有沒有子項可展開（決定要不要畫箭頭）。 */
export function expandable(row: FlatRow): boolean {
  switch (row.kind) {
    case 'patient':
      return row.row.study_count > 0;
    case 'study':
      return row.row.image_series_count + row.row.unlinked_count > 0;
    case 'image':
      return row.row.rt_count > 0;
    case 'temporal':
      return row.row.members.length > 0;
    case 'unlinked':
      return row.row.count > 0;
    case 'rt':
      return row.row.kind === 'plan' && (row.row.doses?.length ?? 0) > 0;
    default:
      return false;
  }
}
