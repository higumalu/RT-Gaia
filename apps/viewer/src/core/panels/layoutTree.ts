/**
 * 版面的**分割樹** —— 拖曳調格、分割、合併（關閉一格）都是對這棵樹的純函式操作。
 *
 * * 具名版面（`registerLayout` 的 CSS grid）照舊註冊；顯示時用 `treeFromGrid` 換成樹（只要是「一刀切到底」可分解的
 *   格局 —— 目前所有版面都是）。換不了（非切割式格局）回 null → 照舊用 grid 畫、不提供分割／合併。
 * * 樹只記「怎麼切、比例多少、葉子是哪個 cellId」；每格的**內容**仍是 `LayoutOverrides`（cellId → 內容），
 *   新分出來的格子內容也放在那裡。
 * * 使用者改過的樹依版面 id 存起來（`LAYOUT_TREES_STORAGE_KEY`，跟著帳號同步）；「重設版面」清掉。
 */

import type { LayoutSpec } from './layouts';

export type SplitDirection = 'row' | 'column';

export type LayoutNode =
  | { readonly kind: 'cell'; readonly cellId: string }
  | { readonly kind: 'split'; readonly dir: SplitDirection; readonly sizes: readonly number[]; readonly children: readonly LayoutNode[] };

/** 從根到某個 split 的子節點索引路徑。 */
export type NodePath = readonly number[];

export const LAYOUT_TREES_STORAGE_KEY = 'rtgaia.layout.trees.v1';
/** 一格最少佔父層的比例（拖到更小會卡住）。 */
export const MIN_PANE_FRACTION = 0.08;

export type AllLayoutTrees = Readonly<Record<string, LayoutNode>>;

const cell = (cellId: string): LayoutNode => ({ kind: 'cell', cellId });

function normalize(sizes: readonly number[]): number[] {
  const total = sizes.reduce((a, b) => a + b, 0);
  return total > 0 ? sizes.map((s) => s / total) : sizes.map(() => 1 / sizes.length);
}

/** `"1fr 1fr"`／`"3fr 1fr"` → 權重；有別的單位（px、auto、repeat…）→ null。 */
export function parseTrack(template: string): number[] | null {
  const parts = template.trim().split(/\s+/);
  const out: number[] = [];
  for (const p of parts) {
    const m = /^(\d+(?:\.\d+)?)fr$/.exec(p);
    if (!m) return null;
    out.push(Number(m[1]));
  }
  return out.length > 0 ? out : null;
}

interface Rect {
  readonly cellId: string;
  readonly c0: number;
  readonly c1: number;
  readonly r0: number;
  readonly r1: number;
}

/** 每格佔的欄列範圍（0 起、結束不含）。`gridArea` 是 `r0 / c0 / r1 / c1`（CSS 1 起）；沒給就依序自動排。 */
function gridRects(spec: LayoutSpec, ncols: number, nrows: number): Rect[] | null {
  const out: Rect[] = [];
  let auto = 0;
  for (const c of spec.cells) {
    if (c.gridArea) {
      const nums = c.gridArea.split('/').map((x) => Number(x.trim()));
      if (nums.length !== 4 || nums.some((n) => !Number.isInteger(n))) return null;
      const [r0, c0, r1, c1] = nums as [number, number, number, number];
      out.push({ cellId: c.cellId, r0: r0 - 1, c0: c0 - 1, r1: r1 - 1, c1: c1 - 1 });
    } else {
      const r = Math.floor(auto / ncols);
      const col = auto % ncols;
      if (r >= nrows) return null;
      out.push({ cellId: c.cellId, r0: r, c0: col, r1: r + 1, c1: col + 1 });
      auto += 1;
    }
  }
  return out;
}

function build(rects: readonly Rect[], cols: readonly number[], rows: readonly number[], c0: number, c1: number, r0: number, r1: number): LayoutNode | null {
  const inside = rects.filter((r) => r.c0 >= c0 && r.c1 <= c1 && r.r0 >= r0 && r.r1 <= r1);
  if (inside.length === 0) return null;
  if (inside.length === 1) {
    const only = inside[0]!;
    return only.c0 === c0 && only.c1 === c1 && only.r0 === r0 && only.r1 === r1 ? cell(only.cellId) : null;
  }
  const tryCut = (dir: SplitDirection): LayoutNode | null => {
    const lo = dir === 'row' ? c0 : r0;
    const hi = dir === 'row' ? c1 : r1;
    const cuts: number[] = [];
    for (let x = lo + 1; x < hi; x += 1) {
      const crosses = inside.some((r) => (dir === 'row' ? r.c0 < x && x < r.c1 : r.r0 < x && x < r.r1));
      if (!crosses) cuts.push(x);
    }
    if (cuts.length === 0) return null;
    const edges = [lo, ...cuts, hi];
    const weights = dir === 'row' ? cols : rows;
    const children: LayoutNode[] = [];
    const sizes: number[] = [];
    for (let i = 0; i + 1 < edges.length; i += 1) {
      const a = edges[i]!;
      const b = edges[i + 1]!;
      const child = dir === 'row' ? build(inside, cols, rows, a, b, r0, r1) : build(inside, cols, rows, c0, c1, a, b);
      if (child === null) return null;
      children.push(child);
      sizes.push(weights.slice(a, b).reduce((s, w) => s + w, 0));
    }
    return { kind: 'split', dir, sizes: normalize(sizes), children };
  };
  return tryCut('row') ?? tryCut('column');
}

/** 具名版面（CSS grid）→ 分割樹；不是切割式格局 → null。 */
export function treeFromGrid(spec: LayoutSpec): LayoutNode | null {
  const cols = parseTrack(spec.gridTemplateColumns);
  const rows = parseTrack(spec.gridTemplateRows);
  if (cols === null || rows === null) return null;
  const rects = gridRects(spec, cols.length, rows.length);
  if (rects === null) return null;
  return build(rects, cols, rows, 0, cols.length, 0, rows.length);
}

export function treeCellIds(node: LayoutNode): string[] {
  return node.kind === 'cell' ? [node.cellId] : node.children.flatMap(treeCellIds);
}

function at(node: LayoutNode, path: NodePath): LayoutNode | null {
  let cur: LayoutNode = node;
  for (const i of path) {
    if (cur.kind !== 'split' || cur.children[i] === undefined) return null;
    cur = cur.children[i]!;
  }
  return cur;
}

function replaceAt(node: LayoutNode, path: NodePath, next: LayoutNode): LayoutNode {
  if (path.length === 0) return next;
  if (node.kind !== 'split') return node;
  const [head, ...rest] = path as [number, ...number[]];
  return { ...node, children: node.children.map((c, i) => (i === head ? replaceAt(c, rest, next) : c)) };
}

/** 設定某個 split 的比例（拖完分隔線提交用）；每格至少 `MIN_PANE_FRACTION`，總和 1。 */
export function setSplitSizes(node: LayoutNode, path: NodePath, sizes: readonly number[]): LayoutNode {
  const target = at(node, path);
  if (target === null || target.kind !== 'split' || sizes.length !== target.children.length) return node;
  const clamped = sizes.map((s) => Math.max(MIN_PANE_FRACTION, Number.isFinite(s) ? s : 0));
  return replaceAt(node, path, { ...target, sizes: normalize(clamped) });
}

/**
 * 拖第 `index` 條分隔線（在 `sizes[index]` 與 `sizes[index+1]` 之間）`delta`（佔父層的比例，正＝往右／下）。
 * 只動相鄰兩格；卡在最小比例。純函式，給拖曳中的預覽用。
 */
export function dragSplitter(sizes: readonly number[], index: number, delta: number): number[] {
  const out = normalize(sizes);
  const a = out[index];
  const b = out[index + 1];
  if (a === undefined || b === undefined) return out;
  const pair = a + b;
  const nextA = Math.min(pair - MIN_PANE_FRACTION, Math.max(MIN_PANE_FRACTION, a + delta));
  out[index] = nextA;
  out[index + 1] = pair - nextA;
  return out;
}

/** 某個 split 的子格平均分配（雙擊分隔線）。 */
export function equalizeSplit(node: LayoutNode, path: NodePath): LayoutNode {
  const target = at(node, path);
  if (target === null || target.kind !== 'split') return node;
  return replaceAt(node, path, { ...target, sizes: target.children.map(() => 1 / target.children.length) });
}

function pathOfCell(node: LayoutNode, cellId: string, prefix: number[] = []): number[] | null {
  if (node.kind === 'cell') return node.cellId === cellId ? prefix : null;
  for (let i = 0; i < node.children.length; i += 1) {
    const found = pathOfCell(node.children[i]!, cellId, [...prefix, i]);
    if (found !== null) return found;
  }
  return null;
}

/**
 * 把一格分成兩格：`row` ＝ 左右（新格在右）、`column` ＝ 上下（新格在下）。
 * 父層是同方向的 split → 插在它旁邊、平分它原本的比例；否則原地換成一個新的兩格 split。
 */
export function splitCell(node: LayoutNode, cellId: string, dir: SplitDirection, newCellId: string): LayoutNode {
  const path = pathOfCell(node, cellId);
  if (path === null) return node;
  if (path.length > 0) {
    const parentPath = path.slice(0, -1);
    const index = path[path.length - 1]!;
    const parent = at(node, parentPath);
    if (parent !== null && parent.kind === 'split' && parent.dir === dir) {
      const half = (parent.sizes[index] ?? 1 / parent.children.length) / 2;
      const children = [...parent.children.slice(0, index + 1), cell(newCellId), ...parent.children.slice(index + 1)];
      const sizes = [...parent.sizes.slice(0, index), half, half, ...parent.sizes.slice(index + 1)];
      return replaceAt(node, parentPath, { ...parent, children, sizes: normalize(sizes) });
    }
  }
  return replaceAt(node, path, { kind: 'split', dir, sizes: [0.5, 0.5], children: [cell(cellId), cell(newCellId)] });
}

/** 關掉一格（合併進旁邊）：從父層拿掉、比例給前一格；只剩一格的 split 收成那一格。最後一格不能關。 */
export function removeCell(node: LayoutNode, cellId: string): LayoutNode {
  if (treeCellIds(node).length <= 1) return node;
  const path = pathOfCell(node, cellId);
  if (path === null || path.length === 0) return node;
  const parentPath = path.slice(0, -1);
  const index = path[path.length - 1]!;
  const parent = at(node, parentPath);
  if (parent === null || parent.kind !== 'split') return node;
  const children = parent.children.filter((_, i) => i !== index);
  // 比例還給前一格（分割時新格插在原格後面 —— 分了再關回到原樣）；第一格就還給後一格
  const heir = index > 0 ? index - 1 : 1;
  const sizes = parent.sizes.map((s, i) => (i === heir ? s + (parent.sizes[index] ?? 0) : s)).filter((_, i) => i !== index);
  const collapsed: LayoutNode = children.length === 1 ? children[0]! : { ...parent, children, sizes: normalize(sizes) };
  return replaceAt(node, parentPath, collapsed);
}

function validNode(raw: unknown, depth = 0): LayoutNode | null {
  if (depth > 12 || typeof raw !== 'object' || raw === null) return null;
  const r = raw as Record<string, unknown>;
  if (r['kind'] === 'cell') return typeof r['cellId'] === 'string' && r['cellId'].length > 0 ? cell(r['cellId']) : null;
  if (r['kind'] !== 'split' || (r['dir'] !== 'row' && r['dir'] !== 'column')) return null;
  const children = Array.isArray(r['children']) ? r['children'].map((c) => validNode(c, depth + 1)) : [];
  const sizes = Array.isArray(r['sizes']) ? r['sizes'] : [];
  if (children.length < 2 || children.some((c) => c === null) || sizes.length !== children.length) return null;
  if (!sizes.every((s) => typeof s === 'number' && Number.isFinite(s) && s > 0)) return null;
  return { kind: 'split', dir: r['dir'], sizes: normalize(sizes as number[]), children: children as LayoutNode[] };
}

/** 存起來的樹：壞掉的、形狀不對的、cellId 重複的丟掉，不拋。 */
export function parseTrees(text: string | null | undefined): AllLayoutTrees {
  if (!text) return {};
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return {};
  }
  if (typeof raw !== 'object' || raw === null) return {};
  const out: Record<string, LayoutNode> = {};
  for (const [layoutId, tree] of Object.entries(raw as Record<string, unknown>)) {
    const node = validNode(tree);
    if (node === null) continue;
    const ids = treeCellIds(node);
    if (new Set(ids).size !== ids.length) continue;
    out[layoutId] = node;
  }
  return out;
}

export function serializeTrees(all: AllLayoutTrees): string {
  return JSON.stringify(all);
}

/** 新格子的 id（viewport id 也是它）：不跟現有的撞。 */
export function newCellId(existing: readonly string[], random: () => number = Math.random): string {
  for (;;) {
    const id = `cell-${Math.floor(random() * 0xffffff).toString(16).padStart(6, '0')}`;
    if (!existing.includes(id)) return id;
  }
}

/** 一格在整個版面的位置（0–1 的比例）。 */
export interface PaneRect {
  readonly cellId: string;
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

/** 一條分隔線：在 `path` 那個 split 的第 `index` 與 `index+1` 格之間；`at` 是線的位置，`parent` 是那個 split 的範圍。 */
export interface SplitterRect {
  readonly path: NodePath;
  readonly index: number;
  readonly dir: SplitDirection;
  readonly at: number;
  readonly parent: Omit<PaneRect, 'cellId'>;
  readonly sizes: readonly number[];
}

/** 樹 → 每格與每條分隔線的位置（畫面用絕對定位畫：格子的 DOM 不隨分割重掛，viewport 不會 detach）。 */
export function treeRects(node: LayoutNode): { cells: PaneRect[]; splitters: SplitterRect[] } {
  const cells: PaneRect[] = [];
  const splitters: SplitterRect[] = [];
  const walk = (n: LayoutNode, path: number[], x: number, y: number, w: number, h: number): void => {
    if (n.kind === 'cell') {
      cells.push({ cellId: n.cellId, x, y, w, h });
      return;
    }
    const sizes = normalize(n.sizes);
    let offset = 0;
    sizes.forEach((s, i) => {
      const child = n.children[i]!;
      if (n.dir === 'row') walk(child, [...path, i], x + offset * w, y, s * w, h);
      else walk(child, [...path, i], x, y + offset * h, w, s * h);
      offset += s;
      if (i + 1 < sizes.length) {
        splitters.push({ path, index: i, dir: n.dir, at: n.dir === 'row' ? x + offset * w : y + offset * h, parent: { x, y, w, h }, sizes });
      }
    });
  };
  walk(node, [], 0, 0, 1, 1);
  return { cells, splitters };
}

/**
 * 具名版面 ＋ 樹 ＋ 每格覆寫 → 生效的版面：格子依樹的順序；原本版面的格子照 `applyOverrides` 的結果，
 * 分出來的新格子內容取覆寫（沒有 → 軸向）。不在樹裡的原本格子（被關掉了）拿掉。
 */
export function applyTree(effective: LayoutSpec, tree: LayoutNode | null, overrides: Readonly<Record<string, LayoutSpec['cells'][number]['content']>> | undefined): LayoutSpec {
  if (tree === null) return effective;
  const byId = new Map(effective.cells.map((c) => [c.cellId, c]));
  const cells = treeCellIds(tree).map((cellId) => {
    const base = byId.get(cellId);
    if (base !== undefined) {
      const { gridArea: _area, ...rest } = base;
      void _area;
      return rest;
    }
    return { cellId, content: overrides?.[cellId] ?? { kind: 'viewport' as const, orientation: 'axial' as const } };
  });
  return { ...effective, cells };
}
