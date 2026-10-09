/**
 * 具名版面。
 *
 * 版面是**資料**：一張 CSS grid 模板 ＋ 幾個格子。每格的**內容**是聯集：
 * * `viewport`：一個 2D／3D 影像格（viewport 的 id 就是 `cellId`）
 * * `panel`：一個以 `slot:'cell'` 註冊的面板（DVH 圖、量測表…）—— 核心不認識任何一個
 *
 * 使用者可以覆寫每格的內容（`applyOverrides`）；覆寫依版面 id 存在瀏覽器（`serializeOverrides`）。
 * 模組用 `registerLayout()` 加自己的版面（含裝著自己面板的格子），核心一行都不用改。
 *
 * `cameraLink`：同一個字串的 viewport 格相機連動。使用者把格子換成別的方位或面板時，
 * 該格自動退出連動群 —— 不同方位共用相機沒有意義。
 */

import { require_ } from '../geometry';
import type { OrthoOrientation } from '../scene/cameras';
import { msg, t } from '../i18n';

export type CellContent =
  | { readonly kind: 'viewport'; readonly orientation: OrthoOrientation; readonly is3D?: boolean; readonly cameraLink?: string }
  | { readonly kind: 'panel'; readonly panelId: string };

export interface LayoutCell {
  /** 格子 id；viewport 格的 viewportId 就是它。 */
  readonly cellId: string;
  readonly label?: string;
  /** CSS `grid-area`（省略 ＝ 依序排）。 */
  readonly gridArea?: string;
  readonly content: CellContent;
}

export interface LayoutSpec {
  readonly id: string;
  readonly label: string;
  readonly gridTemplateColumns: string;
  readonly gridTemplateRows: string;
  readonly cells: readonly LayoutCell[];
}

/** 每格覆寫：cellId → 內容。 */
export type LayoutOverrides = Readonly<Record<string, CellContent>>;
/** 所有版面的覆寫：layoutId → 每格覆寫。 */
export type AllLayoutOverrides = Readonly<Record<string, LayoutOverrides>>;

const layouts = new Map<string, LayoutSpec>();

export const DEFAULT_LAYOUT_ID = '2x2';
export const LAYOUT_OVERRIDES_STORAGE_KEY = 'rtgaia.layout.overrides.v1';
/** 目前選的版面。 */
export const CURRENT_LAYOUT_STORAGE_KEY = 'rtgaia.layout.current.v1';

/** 記住的版面 id（沒有 → 預設；不認識的 id 交給 `getLayout` 退回預設）。 */
export function readCurrentLayoutId(): string {
  try {
    const v = typeof localStorage === 'undefined' ? null : localStorage.getItem(CURRENT_LAYOUT_STORAGE_KEY);
    return v && v.length > 0 ? v : DEFAULT_LAYOUT_ID;
  } catch {
    return DEFAULT_LAYOUT_ID;
  }
}

export function registerLayout(spec: LayoutSpec): void {
  require_(spec.id.length > 0, 'LY1', t('layout id 必填'));
  require_(spec.cells.length > 0, 'LY2', t('layout 至少一格'), { id: spec.id });
  const ids = new Set(spec.cells.map((c) => c.cellId));
  require_(ids.size === spec.cells.length, 'LY3', t('cellId 在同一個版面內不得重複'), { id: spec.id });
  layouts.set(spec.id, spec);
}

export function getLayout(id: string): LayoutSpec {
  const found = layouts.get(id) ?? layouts.get(DEFAULT_LAYOUT_ID);
  require_(found !== undefined, 'LY4', t('沒有這個版面，也沒有預設版面'), { id, known: [...layouts.keys()] });
  return found!;
}

/**
 * 給使用者看的格子名稱（「軸向」…，依介面語言）；分割出來的格子、沒有標籤的格子 → null。
 * 呼叫端在 null 時換一句不提名稱的話 —— 以前退回內部 id，英文介面出現「The BEV is in the "cell-fdd3bf" cell.」。
 */
export function layoutCellName(layoutId: string, cellId: string): string | null {
  const label = getLayout(layoutId).cells.find((c) => c.cellId === cellId)?.label;
  return label ? t(label) : null;
}

export function listLayouts(): LayoutSpec[] {
  return [...layouts.values()];
}

export function hasLayout(id: string): boolean {
  return layouts.has(id);
}

export function clearLayouts(): void {
  layouts.clear();
}

export function isViewportCell(cell: LayoutCell): boolean {
  return cell.content.kind === 'viewport';
}

/** viewport 格的 label（沒給就照方位）。 */
export function cellLabel(cell: LayoutCell): string {
  if (cell.label !== undefined) return t(cell.label);
  if (cell.content.kind === 'panel') return cell.content.panelId;
  if (cell.content.is3D) return '3D';
  return t(ORIENTATION_LABEL[cell.content.orientation]);
}

export const ORIENTATION_LABEL: Record<OrthoOrientation, string> = { axial: msg('軸向'), coronal: msg('冠狀'), sagittal: msg('矢狀') };

/** `cameraLink` → 該群的 cellId（只算 2D viewport 格）。 */
export function cameraLinkGroups(spec: LayoutSpec): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const c of spec.cells) {
    if (c.content.kind !== 'viewport' || c.content.cameraLink === undefined || c.content.is3D) continue;
    (out[c.content.cameraLink] ??= []).push(c.cellId);
  }
  return out;
}

/**
 * 基底版面 ＋ 使用者覆寫 → 生效的版面。
 * 覆寫成別的方位／3D／面板的格子退出相機連動群（`cameraLink` 只在方位沒變時保留）。
 */
export function applyOverrides(base: LayoutSpec, overrides: LayoutOverrides | undefined): LayoutSpec {
  if (overrides === undefined || Object.keys(overrides).length === 0) return base;
  return {
    ...base,
    cells: base.cells.map((cell) => {
      const o = overrides[cell.cellId];
      if (o === undefined) return cell;
      let content: CellContent = o;
      if (o.kind === 'viewport' && cell.content.kind === 'viewport') {
        const sameView = o.orientation === cell.content.orientation && Boolean(o.is3D) === Boolean(cell.content.is3D);
        content = sameView && cell.content.cameraLink !== undefined ? { ...o, cameraLink: cell.content.cameraLink } : o;
        if (o.cameraLink !== undefined && sameView) content = { ...content, cameraLink: o.cameraLink };
      }
      // 面板格與換了方位的格子沒有 label（顯示用 cellLabel 依內容算）
      const { label: _dropped, ...rest } = cell;
      void _dropped;
      return { ...rest, content };
    }),
  };
}

export function isSameContent(a: CellContent, b: CellContent): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === 'panel' && b.kind === 'panel') return a.panelId === b.panelId;
  if (a.kind === 'viewport' && b.kind === 'viewport') return a.orientation === b.orientation && Boolean(a.is3D) === Boolean(b.is3D);
  return false;
}

export function serializeOverrides(all: AllLayoutOverrides): string {
  return JSON.stringify(all);
}

/** 壞掉的字串／舊版本 → 空物件，不拋。只接受形狀正確的內容。 */
export function parseOverrides(text: string | null | undefined): AllLayoutOverrides {
  if (!text) return {};
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return {};
  }
  if (typeof raw !== 'object' || raw === null) return {};
  const out: Record<string, Record<string, CellContent>> = {};
  for (const [layoutId, cells] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof cells !== 'object' || cells === null) continue;
    const perCell: Record<string, CellContent> = {};
    for (const [cellId, content] of Object.entries(cells as Record<string, unknown>)) {
      const c = content as Partial<Record<string, unknown>> | null;
      if (c?.['kind'] === 'panel' && typeof c['panelId'] === 'string') perCell[cellId] = { kind: 'panel', panelId: c['panelId'] };
      else if (c?.['kind'] === 'viewport' && (c['orientation'] === 'axial' || c['orientation'] === 'coronal' || c['orientation'] === 'sagittal')) {
        perCell[cellId] = { kind: 'viewport', orientation: c['orientation'], ...(c['is3D'] === true ? { is3D: true } : {}) };
      }
    }
    if (Object.keys(perCell).length > 0) out[layoutId] = perCell;
  }
  return out;
}

const AXIAL: LayoutCell = { cellId: 'axial', label: msg('軸向'), content: { kind: 'viewport', orientation: 'axial' } };
const CORONAL: LayoutCell = { cellId: 'coronal', label: msg('冠狀'), content: { kind: 'viewport', orientation: 'coronal' } };
const SAGITTAL: LayoutCell = { cellId: 'sagittal', label: msg('矢狀'), content: { kind: 'viewport', orientation: 'sagittal' } };
const VOLUME: LayoutCell = { cellId: 'volume3d', label: '3D', content: { kind: 'viewport', orientation: 'axial', is3D: true } };

/** 三個核心版面。冪等。 */
export function registerBuiltinLayouts(): void {
  if (layouts.has(DEFAULT_LAYOUT_ID)) return;
  registerLayout({
    id: DEFAULT_LAYOUT_ID,
    label: '2×2',
    gridTemplateColumns: '1fr 1fr',
    gridTemplateRows: '1fr 1fr',
    cells: [AXIAL, CORONAL, SAGITTAL, VOLUME],
  });
  registerLayout({ id: '1x1', label: msg('1×1 軸向'), gridTemplateColumns: '1fr', gridTemplateRows: '1fr', cells: [AXIAL] });
  registerLayout({
    id: '1+3',
    label: msg('1＋3'),
    gridTemplateColumns: '3fr 1fr',
    gridTemplateRows: '1fr 1fr 1fr',
    cells: [
      { ...AXIAL, gridArea: '1 / 1 / 4 / 2' },
      { ...CORONAL, gridArea: '1 / 2 / 2 / 3' },
      { ...SAGITTAL, gridArea: '2 / 2 / 3 / 3' },
      { ...VOLUME, gridArea: '3 / 2 / 4 / 3' },
    ],
  });
}
