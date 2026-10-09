/**
 * Viewport 區域 —— **版面在這裡，不在 `App`**。
 *
 * 版面來自 `layouts.ts` 的具名版面。每格的內容是 viewport **或**
 * 一個 `slot:'cell'` 的面板；使用者用每格右上角的內容選單換（覆寫存在瀏覽器）。
 * 這裡只照 `LayoutSpec` 掛東西；換內容 ＝ 換 key，舊 viewport detach、新的 attach。
 *
 * 🔴 **`attachViewport` 刻意不放進 `ViewerApi`。** 面板不該能掛載或卸載 viewport：那會讓
 * `SceneManager` 的 handle 記帳從外部被打亂。要在格子上加東西：畫布層走 `api.overlay`、
 * React chrome 走 `PanelSlot('viewport-overlay')`、整格內容走 `slot:'cell'` 的面板。
 */

import { useRef, useState, type ComponentType, type CSSProperties } from 'react';

import {
  cellLabel,
  dragSplitter,
  listPanels,
  setSplitSizes,
  treeRects,
  type LayoutNode,
  type NodePath,
  type SplitterRect,
  ORIENTATION_LABEL,
  type CellContent,
  type LayoutCell,
  type LayoutSpec,
  type OrthoOrientation,
  type Tier,
  type ViewportInfo,
} from '../../core';
import { useViewerApi } from '../panels/context';
import { PanelSlot } from '../panels/PanelSlot';
import type { ViewerPanelProps } from '../panels/types';
import { ViewportHost, type ViewportHostProps } from './ViewportHost';
import { t } from '../../core/i18n';

export interface ViewportAreaProps {
  layout: LayoutSpec;
  /** 分割樹（有 → 絕對定位畫、可拖分隔線、可分割／關閉；`null` → 照舊 CSS grid）。 */
  tree?: LayoutNode | null;
  kernelReady: boolean;
  kernelError: string | null;
  tier: Tier;
  zoomFactor: (viewportId: string) => number;
  sliceLabel: (viewportId: string) => string;
  sliceNav?: (viewportId: string) => { index: number; count: number } | null;
  onScrubSlice?: (viewportId: string, phase: 'begin' | 'move' | 'end', index?: number) => void;
  onStepSlice?: (viewportId: string, delta: number) => void;
  onZoom: (viewportId: string, factor: number) => void;
  onFit: (viewportId: string) => void;
  onActualSize: (viewportId: string) => void;
  onAttach: (info: ViewportInfo, container: HTMLElement, orientation: OrthoOrientation) => void;
  onDetach: (viewportId: string) => void;
  onKey?: (viewportId: string, key: string) => void;
}

/** 切片捲軸（2026-09-29）：2D 格、核心就緒、張數 > 1 才有。 */
function sliceBarFor(is3D: boolean, id: string, props: ViewportAreaProps): Pick<ViewportHostProps, 'sliceBar'> | null {
  if (is3D || !props.kernelReady || !props.sliceNav || !props.onScrubSlice || !props.onStepSlice) return null;
  const nav = props.sliceNav(id);
  if (nav === null || nav.count <= 1) return null;
  const scrub = props.onScrubSlice;
  const step = props.onStepSlice;
  return {
    sliceBar: {
      index: nav.index,
      count: nav.count,
      valueText: props.sliceLabel(id),
      onScrub: (phase, index) => scrub(id, phase, index),
      onStep: (delta) => step(id, delta),
    },
  };
}

/** Tier C 不提供互動式體積渲染，改由後端出靜態圖。 */
function placeholderFor(is3D: boolean, props: ViewportAreaProps): string | undefined {
  if (is3D) {
    return props.tier === 'C'
      ? t('Tier C 不提供互動式 3D 體積渲染 —— 改由後端出靜態圖')
      : t('3D 體積渲染尚未接上');
  }
  if (!props.kernelReady) return props.kernelError ?? t('正在載入 CPU 重切核心（WASM）…');
  return undefined;
}

/** 內容 → 選單值（`vp:axial`／`vp:3d`／`panel:<id>`）。 */
export function contentKey(content: CellContent): string {
  if (content.kind === 'panel') return `panel:${content.panelId}`;
  return content.is3D ? 'vp:3d' : `vp:${content.orientation}`;
}

export function contentFromKey(key: string): CellContent | null {
  if (key === 'vp:3d') return { kind: 'viewport', orientation: 'axial', is3D: true };
  if (key.startsWith('vp:')) {
    const o = key.slice(3);
    return o === 'axial' || o === 'coronal' || o === 'sagittal' ? { kind: 'viewport', orientation: o } : null;
  }
  if (key.startsWith('panel:')) return { kind: 'panel', panelId: key.slice(6) };
  return null;
}

/**
 * 每格右上角的內容選單（核心 chrome）：三個方位、3D、所有 `slot:'cell'` 的面板；
 * 可分割的版面再多一組「左右分割／上下分割／關閉這一格」（canvas 上不另放按鈕）。
 */
function CellPicker({ cell, splittable, closable }: { cell: LayoutCell; splittable: boolean; closable: boolean }): React.JSX.Element {
  const api = useViewerApi();
  const cellPanels = listPanels('cell');
  return (
    <select
      className="cell-picker"
      title={t('這一格顯示什麼、分割或關閉（跟著帳號；工具列「重設版面」可清掉）')}
      value={contentKey(cell.content)}
      onChange={(e) => {
        const v = e.target.value;
        if (v === 'act:split-row') api.commands.splitCell(cell.cellId, 'row');
        else if (v === 'act:split-column') api.commands.splitCell(cell.cellId, 'column');
        else if (v === 'act:close') api.commands.closeCell(cell.cellId);
        else {
          const next = contentFromKey(v);
          if (next !== null) api.commands.setCellContent(cell.cellId, next);
        }
      }}
    >
      {(['axial', 'coronal', 'sagittal'] as const).map((o) => (
        <option key={o} value={`vp:${o}`}>
          {t(ORIENTATION_LABEL[o])}
        </option>
      ))}
      <option value="vp:3d">3D</option>
      {cellPanels.length > 0 && (
        <optgroup label={t('面板')}>
          {cellPanels.map((p) => (
            <option key={p.id} value={`panel:${p.id}`}>
              {p.title ? t(p.title) : p.id}
            </option>
          ))}
        </optgroup>
      )}
      {splittable && (
        <optgroup label={t('版面')}>
          <option value="act:split-row">{t('左右分割')}</option>
          <option value="act:split-column">{t('上下分割')}</option>
          <option value="act:close" disabled={!closable}>
            {t('關閉這一格')}
          </option>
        </optgroup>
      )}
    </select>
  );
}

const pct = (f: number): string => `${(f * 100).toFixed(4)}%`;
/** 格子之間留 2px（跟 CSS grid 的 gap 一樣）。 */
const HALF_GAP = 1;

function paneStyle(r: { x: number; y: number; w: number; h: number }): CSSProperties {
  return {
    position: 'absolute',
    left: `calc(${pct(r.x)} + ${HALF_GAP}px)`,
    top: `calc(${pct(r.y)} + ${HALF_GAP}px)`,
    width: `calc(${pct(r.w)} - ${2 * HALF_GAP}px)`,
    height: `calc(${pct(r.h)} - ${2 * HALF_GAP}px)`,
  };
}

function splitterStyle(s: SplitterRect): CSSProperties {
  return s.dir === 'row'
    ? { left: `calc(${pct(s.at)} - 3px)`, top: pct(s.parent.y), height: pct(s.parent.h) }
    : { top: `calc(${pct(s.at)} - 3px)`, left: pct(s.parent.x), width: pct(s.parent.w) };
}

interface DragState {
  readonly path: NodePath;
  readonly sizes: readonly number[];
}

/** 分隔線：拖曳調比例（放開才存）、雙擊平分、聚焦後方向鍵微調。 */
function Splitter({ s, mainRef, onPreview, onCommit }: { s: SplitterRect; mainRef: React.RefObject<HTMLElement | null>; onPreview: (d: DragState | null) => void; onCommit: (path: NodePath, sizes: readonly number[]) => void }): React.JSX.Element {
  const start = useRef<{ pos: number; span: number; sizes: readonly number[]; last: readonly number[] } | null>(null);
  const horizontal = s.dir === 'row';
  return (
    <div
      className={`layout-splitter ${horizontal ? 'is-row' : 'is-column'}`}
      style={splitterStyle(s)}
      role="separator"
      aria-orientation={horizontal ? 'vertical' : 'horizontal'}
      aria-valuenow={Math.round((s.sizes[s.index] ?? 0) * 100)}
      tabIndex={0}
      title={t('拖曳調整大小；雙擊平分')}
      data-splitter={`${s.path.join('.')}:${s.index}`}
      onPointerDown={(e) => {
        const rect = mainRef.current?.getBoundingClientRect();
        if (!rect || e.button !== 0) return;
        e.preventDefault();
        e.currentTarget.setPointerCapture(e.pointerId);
        const span = (horizontal ? rect.width * s.parent.w : rect.height * s.parent.h) || 1;
        start.current = { pos: horizontal ? e.clientX : e.clientY, span, sizes: s.sizes, last: s.sizes };
      }}
      onPointerMove={(e) => {
        const st = start.current;
        if (st === null) return;
        const delta = ((horizontal ? e.clientX : e.clientY) - st.pos) / st.span;
        const sizes = dragSplitter(st.sizes, s.index, delta);
        start.current = { ...st, last: sizes };
        onPreview({ path: s.path, sizes });
      }}
      onPointerUp={() => {
        const st = start.current;
        start.current = null;
        onPreview(null);
        if (st !== null && st.last !== st.sizes) onCommit(s.path, st.last);
      }}
      onPointerCancel={() => {
        start.current = null;
        onPreview(null);
      }}
      onDoubleClick={() => onCommit(s.path, s.sizes.map(() => 1 / s.sizes.length))}
      onKeyDown={(e) => {
        const step = e.shiftKey ? 0.1 : 0.02;
        const back = horizontal ? 'ArrowLeft' : 'ArrowUp';
        const fwd = horizontal ? 'ArrowRight' : 'ArrowDown';
        if (e.key !== back && e.key !== fwd) return;
        e.preventDefault();
        onCommit(s.path, dragSplitter(s.sizes, s.index, e.key === fwd ? step : -step));
      }}
    />
  );
}

/** 裝面板的格子：找不到面板（模組沒載）就說出來，不留黑框。 */
function CellPanelHost({ cell, panelId }: { cell: LayoutCell; panelId: string }): React.JSX.Element {
  const api = useViewerApi();
  const panel = listPanels('cell').find((p) => p.id === panelId);
  if (panel === undefined) {
    return (
      <div className="viewport cell-panel">
        <span className="viewport-label">{panelId}</span>
        <p className="viewport-placeholder">{t('沒有這個面板（模組未載入？）—— 用右上角的選單換一個')}</p>
      </div>
    );
  }
  const Component_ = panel.component as ComponentType<ViewerPanelProps>;
  return (
    <div className="viewport cell-panel" data-panel={panelId}>
      <span className="viewport-label">{panel.title ? t(panel.title) : panel.id}</span>
      <div className="cell-panel-body">
        <Component_ api={api} viewportId={cell.cellId} />
      </div>
    </div>
  );
}

export function ViewportArea(props: ViewportAreaProps): React.JSX.Element {
  const api = useViewerApi();
  const mainRef = useRef<HTMLElement | null>(null);
  const [drag, setDrag] = useState<DragState | null>(null);
  const baseTree = props.tree ?? null;
  const tree = baseTree !== null && drag !== null ? setSplitSizes(baseTree, drag.path, drag.sizes) : baseTree;
  const rects = tree === null ? null : treeRects(tree);
  const rectOf = new Map(rects?.cells.map((r) => [r.cellId, r]) ?? []);
  const closable = props.layout.cells.length > 1;
  const splittable = tree !== null;
  // 作用中的格子 ＝ 最後用滑鼠點過或鍵盤聚焦的 2D／3D 格；點側欄的設定不會改變它。
  // 只有一格以上才標（單格時沒有「哪一格」的問題）
  const [activeCell, setActiveCell] = useState<string | null>(null);
  const markActive = props.layout.cells.filter((c) => c.content.kind !== 'panel').length > 1;
  return (
    <main
      ref={mainRef}
      className={tree === null ? 'viewport-grid' : `viewport-grid viewport-tree${drag !== null ? ' is-dragging' : ''}`}
      data-layout={props.layout.id}
      style={tree === null ? { gridTemplateColumns: props.layout.gridTemplateColumns, gridTemplateRows: props.layout.gridTemplateRows } : undefined}
    >
      {props.layout.cells.map((cell) => {
        const key = `${cell.cellId}:${contentKey(cell.content)}`;
        const rect = rectOf.get(cell.cellId);
        const style = rect !== undefined ? paneStyle(rect) : cell.gridArea ? { gridArea: cell.gridArea } : undefined;
        if (cell.content.kind === 'panel') {
          return (
            <div key={key} className="viewport-cell" style={style} data-cell={cell.cellId}>
              <CellPanelHost cell={cell} panelId={cell.content.panelId} />
              <CellPicker cell={cell} splittable={splittable} closable={closable} />
            </div>
          );
        }
        const is3D = cell.content.is3D === true;
        const placeholder = placeholderFor(is3D, props);
        const showZoom = !is3D && props.kernelReady;
        const id = cell.cellId;
        return (
          <div
            key={key}
            className={markActive && activeCell === id ? 'viewport-cell is-active' : 'viewport-cell'}
            style={style}
            data-cell={cell.cellId}
            onPointerDownCapture={() => setActiveCell(id)}
            onFocusCapture={() => setActiveCell(id)}
          >
            <ViewportHost
              viewportId={id}
              is3D={is3D}
              label={cellLabel(cell)}
              orientation={cell.content.orientation}
              sliceLabel={is3D ? '' : props.sliceLabel(id)}
              {...(sliceBarFor(is3D, id, props) ?? {})}
              {...(showZoom
                ? {
                    zoomControls: {
                      zoomFactor: props.zoomFactor(id),
                      onZoomIn: () => props.onZoom(id, 1.25),
                      onZoomOut: () => props.onZoom(id, 1 / 1.25),
                      onFit: () => props.onFit(id),
                      onActualSize: () => props.onActualSize(id),
                    },
                  }
                : {})}
              {...(placeholder === undefined ? {} : { placeholder })}
              onAttach={props.onAttach}
              onDetach={props.onDetach}
              {...(props.onKey ? { onKey: props.onKey } : {})}
            >
              {/* 模組可以在每一格的角落掛自己的 chrome */}
              <PanelSlot name="viewport-overlay" viewportId={id} />
            </ViewportHost>
            <CellPicker cell={cell} splittable={splittable} closable={closable} />
          </div>
        );
      })}
      {rects?.splitters.map((s) => (
        <Splitter key={`${s.path.join('.')}:${s.index}`} s={s} mainRef={mainRef} onPreview={setDrag} onCommit={(path, sizes) => api.commands.resizeLayout(path, sizes)} />
      ))}
    </main>
  );
}
