/**
 * 側欄面板的 dock —— 每個面板上方一條細的 dock 列（抓手、摺疊、標題、選單）。
 *
 * * 拖 dock 列 → 放到任一側欄的任一位置（指標事件自己做，不用 HTML5 drag-and-drop：觸控也能用、headless 驗得到）。
 *   拖曳中空著的側欄會出現一條放置區，面板可以拖進原本沒有面板的那一側。
 * * 選單：移到另一側、上移、下移、全部回預設位置（鍵盤也能用）。
 * * 摺起來的面板**不卸載**（只是 `hidden`）—— 面板內的狀態（輸入到一半的表單、捲動位置）不會丟。
 * * 擺法存在 `rtgaia.dock.v1`（`core/panels/dock.ts`；跟著帳號同步）。
 */

import { createContext, useContext, useEffect, useRef, useState } from 'react';

import {
  EMPTY_DOCK,
  isDockCustomized,
  isSidebarPanel,
  listPanels,
  movePanel,
  panelsOnSide,
  shiftPanel,
  toggleFolded,
  type DockSide,
  type DockState,
  type PanelRegistration,
} from '../../core';
import { t } from '../../core/i18n';
import { useViewerApi } from '../panels/context';
import { PanelHost, panelVisibilityState } from '../panels/PanelSlot';

export interface DockDropTarget {
  readonly side: DockSide;
  readonly beforeId: string | null;
}

interface DockContextValue {
  readonly dock: DockState;
  readonly setDock: (next: DockState) => void;
  readonly dragging: string | null;
  readonly target: DockDropTarget | null;
  readonly startDrag: (panelId: string) => void;
  readonly setTarget: (t: DockDropTarget | null) => void;
  readonly endDrag: (commit: boolean) => void;
}

const DockContext = createContext<DockContextValue | null>(null);

/** App 提供：擺法狀態 ＋ 目前拖曳中的面板與放置目標。 */
export function DockProvider({ dock, setDock, children }: { dock: DockState; setDock: (next: DockState) => void; children: React.ReactNode }): React.JSX.Element {
  const [dragging, setDragging] = useState<string | null>(null);
  const [target, setTarget] = useState<DockDropTarget | null>(null);
  const value: DockContextValue = {
    dock,
    setDock,
    dragging,
    target,
    startDrag: (id) => {
      setDragging(id);
      setTarget(null);
    },
    setTarget,
    endDrag: (commit) => {
      if (commit && dragging !== null && target !== null) setDock(movePanel(dock, allSidebarPanels(), dragging, target.side, target.beforeId));
      setDragging(null);
      setTarget(null);
    },
  };
  return <DockContext.Provider value={value}>{children}</DockContext.Provider>;
}

const FALLBACK: DockContextValue = { dock: EMPTY_DOCK, setDock: () => undefined, dragging: null, target: null, startDrag: () => undefined, setTarget: () => undefined, endDrag: () => undefined };

export function useDock(): DockContextValue {
  return useContext(DockContext) ?? FALLBACK;
}

function allSidebarPanels(): PanelRegistration[] {
  return listPanels().filter(isSidebarPanel);
}

/** 某一側目前看得到的面板（套 `visibleWhen` 與使用者擺法）。 */
export function useDockPanels(side: DockSide): PanelRegistration[] {
  const api = useViewerApi();
  const { dock } = useDock();
  return panelsOnSide(listPanels(undefined, panelVisibilityState(api)), side, dock);
}

/** 指標下的放置目標：面板上半 → 放它前面、下半 → 放它後面；欄的空白處或空欄的放置區 → 那一側最後。 */
function dropTargetAt(x: number, y: number): DockDropTarget | null {
  const el = document.elementFromPoint(x, y);
  if (!(el instanceof Element)) return null;
  const item = el.closest<HTMLElement>('[data-dock-item]');
  if (item !== null) {
    const side = item.dataset['dockSide'] as DockSide;
    const r = item.getBoundingClientRect();
    if (y < r.top + r.height / 2) return { side, beforeId: item.dataset['dockItem'] ?? null };
    let next = item.nextElementSibling;
    while (next !== null && !(next instanceof HTMLElement && next.dataset['dockItem'])) next = next.nextElementSibling;
    return { side, beforeId: next instanceof HTMLElement ? (next.dataset['dockItem'] ?? null) : null };
  }
  const zone = el.closest<HTMLElement>('[data-dock-column], [data-dock-drop]');
  if (zone !== null) return { side: (zone.dataset['dockColumn'] ?? zone.dataset['dockDrop']) as DockSide, beforeId: null };
  return null;
}

const DRAG_THRESHOLD_PX = 4;

function DockItem({ panel, side, column }: { panel: PanelRegistration; side: DockSide; column: readonly PanelRegistration[] }): React.JSX.Element {
  const api = useViewerApi();
  const dock = useDock();
  const folded = dock.dock.folded.includes(panel.id);
  const press = useRef<{ x: number; y: number; active: boolean } | null>(null);
  const title = panel.title ? t(panel.title) : panel.id;
  const other: DockSide = side === 'left' ? 'right' : 'left';
  const index = column.findIndex((p) => p.id === panel.id);
  const isTarget = dock.dragging !== null && dock.target?.side === side && dock.target.beforeId === panel.id;

  // 拖曳：window 上聽（指標離開 dock 列也要跟著走）
  useEffect(() => {
    if (dock.dragging !== panel.id) return undefined;
    const onMove = (e: PointerEvent): void => dock.setTarget(dropTargetAt(e.clientX, e.clientY));
    const onUp = (): void => dock.endDrag(true);
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') dock.endDrag(false);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('keydown', onKey);
    };
  }, [dock, panel.id]);

  return (
    <div
      className={`dock-item${folded ? ' is-folded' : ''}${dock.dragging === panel.id ? ' is-dragging' : ''}${isTarget ? ' drop-before' : ''}`}
      data-dock-item={panel.id}
      data-dock-side={side}
    >
      <div
        className="dock-bar"
        title={t('拖曳可移到另一側或調整順序')}
        onPointerDown={(e) => {
          if (e.button !== 0 || (e.target as Element).closest('button, select')) return;
          press.current = { x: e.clientX, y: e.clientY, active: false };
          // 指標很快就會離開這條 22px 的列：先捕捉，門檻前的移動才收得到（放置目標用 elementFromPoint，不受捕捉影響）
          e.currentTarget.setPointerCapture(e.pointerId);
        }}
        onPointerMove={(e) => {
          const p = press.current;
          if (p === null || p.active) return;
          if (Math.hypot(e.clientX - p.x, e.clientY - p.y) < DRAG_THRESHOLD_PX) return;
          p.active = true;
          dock.startDrag(panel.id);
        }}
        onPointerUp={() => {
          press.current = null;
        }}
      >
        <span className="dock-grip" aria-hidden="true">
          ⠿
        </span>
        <button
          type="button"
          className="dock-fold"
          aria-expanded={!folded}
          aria-label={folded ? t('展開「{p0}」', { p0: title }) : t('摺起「{p0}」', { p0: title })}
          title={folded ? t('展開「{p0}」', { p0: title }) : t('摺起「{p0}」', { p0: title })}
          onClick={() => dock.setDock(toggleFolded(dock.dock, panel.id))}
        >
          {folded ? '▸' : '▾'}
        </button>
        <span className="dock-title">{title}</span>
        <select
          className="dock-menu"
          value=""
          title={t('面板位置')}
          aria-label={t('「{p0}」的位置', { p0: title })}
          onChange={(e) => {
            const v = e.target.value;
            const all = allSidebarPanels();
            if (v === 'other') dock.setDock(movePanel(dock.dock, all, panel.id, other, null));
            else if (v === 'up' || v === 'down') dock.setDock(shiftPanel(dock.dock, all, listPanels(undefined, panelVisibilityState(api)), panel.id, v === 'up' ? -1 : 1));
            else if (v === 'reset') dock.setDock(EMPTY_DOCK);
          }}
        >
          <option value="" disabled>
            ⋯
          </option>
          <option value="other">{side === 'left' ? t('移到右欄') : t('移到左欄')}</option>
          <option value="up" disabled={index <= 0}>
            {t('上移')}
          </option>
          <option value="down" disabled={index < 0 || index >= column.length - 1}>
            {t('下移')}
          </option>
          <option value="reset" disabled={!isDockCustomized(dock.dock)}>
            {t('所有面板回預設位置')}
          </option>
        </select>
      </div>
      <div className="dock-body" hidden={folded}>
        <PanelHost panel={panel} api={api} />
      </div>
    </div>
  );
}

/** 一側的面板欄（取代 `PanelSlot` 的側欄用法；class 沿用 slot 名，樣式與測試選擇器不變）。 */
export function DockColumn({ side, className }: { side: DockSide; className: string }): React.JSX.Element | null {
  const panels = useDockPanels(side);
  const dock = useDock();
  // 新開的任務面板自動捲到看得見的地方（同 PanelSlot）
  const seen = useRef<Set<string>>(new Set());
  const ids = panels.map((p) => p.id).join('|');
  useEffect(() => {
    const now = new Set(panels.map((p) => p.id));
    const added = [...now].filter((id) => !seen.current.has(id));
    seen.current = now;
    if (added.length === 0 || seen.current.size === added.length) return;
    document.querySelector<HTMLElement>(`[data-panel-id="${added[added.length - 1]!}"]`)?.scrollIntoView({ block: 'start', behavior: 'smooth' });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- ids 字串就是面板集合的識別
  }, [ids]);
  if (panels.length === 0) return null;
  const endTarget = dock.dragging !== null && dock.target?.side === side && dock.target.beforeId === null;
  return (
    <div className={`${className} dock-column${endTarget ? ' drop-end' : ''}${dock.dragging !== null ? ' is-drop-zone' : ''}`} data-slot={className} data-dock-column={side}>
      {panels.map((p) => (
        <DockItem key={p.id} panel={p} side={side} column={panels} />
      ))}
      <div className="dock-tail" aria-hidden="true" />
    </div>
  );
}

/** 拖曳中、這一側沒有面板時的放置區（不然面板拖不進空的那一側）。 */
export function DockDropZone({ side }: { side: DockSide }): React.JSX.Element | null {
  const dock = useDock();
  if (dock.dragging === null) return null;
  const active = dock.target?.side === side;
  return (
    <div className={`dock-drop-zone dock-drop-${side}${active ? ' is-active' : ''}`} data-dock-drop={side}>
      {side === 'left' ? t('放到左欄') : t('放到右欄')}
    </div>
  );
}

