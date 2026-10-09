/**
 * 可拖寬的側欄（不然右欄內容要靠捲軸才看得到）。
 * 內側邊緣一條把手：拖曳改寬、雙擊回預設；寬度存在瀏覽器。純邏輯在 `sidebar.ts`。
 */

import { useCallback, useEffect, useRef, useState } from 'react';

import { type PanelSlot as PanelSlotName } from '../../core';
import { DockColumn, DockDropZone, useDockPanels } from './Dock';
import { clampSidebarWidth, draggedSidebarWidth, readSidebarWidth, SIDEBAR_DEFAULT_WIDTH, SIDEBAR_MAX_WIDTH, SIDEBAR_MIN_WIDTH, sidebarStorageKey, type SidebarSide } from './sidebar';
import { t } from '../../core/i18n';
import { savePref } from '../prefs/prefs';

export function Sidebar({ side, slot, collapsed = false, onExpand }: { side: SidebarSide; slot: PanelSlotName; collapsed?: boolean; onExpand?: () => void }): React.JSX.Element {
  // 沒有任何面板時不佔位（實測空白右欄仍占 280 px）；面板在哪一側依使用者的 dock 擺法
  const empty = useDockPanels(side).length === 0;
  const [width, setWidth] = useState<number>(() => {
    try {
      return readSidebarWidth(side, window.localStorage.getItem(sidebarStorageKey(side)));
    } catch {
      return SIDEBAR_DEFAULT_WIDTH[side];
    }
  });
  const [dragging, setDragging] = useState(false);
  const drag = useRef<{ startX: number; startWidth: number } | null>(null);

  const persist = useCallback(
    (w: number) => {
      try {
        savePref(sidebarStorageKey(side), String(w));
      } catch {
        // 私密視窗：只活在這次
      }
    },
    [side],
  );

  useEffect(() => {
    if (!dragging) return undefined;
    const onMove = (e: PointerEvent): void => {
      if (drag.current === null) return;
      setWidth(draggedSidebarWidth(side, drag.current.startWidth, e.clientX - drag.current.startX));
    };
    const onUp = (): void => {
      drag.current = null;
      setDragging(false);
      setWidth((w) => {
        persist(w);
        return w;
      });
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
  }, [dragging, side, persist]);

  if (empty) {
    return (
      <div className={`sidebar sidebar-${side} sidebar-empty`} data-side={side} data-empty="true">
        <DockDropZone side={side} />
      </div>
    );
  }
  if (collapsed) {
    // 收合成一條窄帶，按一下展開
    return (
      <div className={`sidebar sidebar-${side} sidebar-collapsed`} data-side={side} data-collapsed="true" data-tour={`${side}-sidebar`}>
        <button type="button" className="sidebar-expand" title={side === 'left' ? t('展開左欄（資料與結構）') : t('展開右欄（任務設定）')} onClick={onExpand}>
          {side === 'left' ? '▸' : '◂'}
        </button>
      </div>
    );
  }
  return (
    <div className={`sidebar sidebar-${side}`} style={{ width }} data-side={side} data-tour={`${side}-sidebar`}>
      <DockColumn side={side} className={slot} />
      <div
        className="sidebar-splitter"
        role="separator"
        aria-orientation="vertical"
        aria-valuenow={width}
        aria-valuemin={SIDEBAR_MIN_WIDTH}
        aria-valuemax={SIDEBAR_MAX_WIDTH[side]}
        aria-label={side === 'left' ? t('左欄寬度') : t('右欄寬度')}
        tabIndex={0}
        title={t('拖曳或用 ←／→ 調整寬度（Shift 加速）；雙擊或 Enter 回預設')}
        data-dragging={dragging ? 'true' : 'false'}
        onKeyDown={(e) => {
          const step = e.shiftKey ? 64 : 16;
          const sign = side === 'left' ? 1 : -1; // 右欄「→」是變窄
          let next: number | null = null;
          if (e.key === 'ArrowRight') next = clampSidebarWidth(side, width + sign * step);
          else if (e.key === 'ArrowLeft') next = clampSidebarWidth(side, width - sign * step);
          else if (e.key === 'Enter' || e.key === 'Home') next = clampSidebarWidth(side, SIDEBAR_DEFAULT_WIDTH[side]);
          if (next === null) return;
          e.preventDefault();
          setWidth(next);
          persist(next);
        }}
        onPointerDown={(e) => {
          drag.current = { startX: e.clientX, startWidth: width };
          setDragging(true);
          e.preventDefault();
        }}
        onDoubleClick={() => {
          const w = clampSidebarWidth(side, SIDEBAR_DEFAULT_WIDTH[side]);
          setWidth(w);
          persist(w);
        }}
      />
    </div>
  );
}
