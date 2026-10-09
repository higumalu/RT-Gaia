/**
 * `ViewportHost` —— 🔴 **只提供一個 div ref 給 `SceneManager`**。
 *
 * > **overlay 的 DOM／canvas 節點由 `core/` 直接建立與更新；`react/`
 * > 只提供掛載容器。**
 *
 * outline 成為 mask 的預設渲染路徑後，向量 overlay 每幀承載 20 個結構、
 * **數萬個座標**。若走「React state → 重新 render → 產生路徑資料」，
 * 60 fps 下不可能。
 */

import { useEffect, useRef, type ReactNode } from 'react';

import type { OrthoOrientation } from '../../core/scene/cameras';
import type { ViewportInfo } from '../../core/raster/types';
import { t } from '../../core/i18n';
import { SliceBar, type SliceBarProps } from './SliceBar';

export interface ViewportHostProps {
  viewportId: string;
  is3D?: boolean;
  label?: string;
  /** 正交方位。3D viewport 不用。 */
  orientation?: OrthoOrientation;
  /** 右上角的切片指示（僅顯示用，不得儲存）。 */
  sliceLabel?: string;
  /** 右緣的切片捲軸（2026-09-29）；沒給就沒有（3D 格、只有一張）。 */
  sliceBar?: SliceBarProps;
  /**
   * 視圖控制：`Fit` / `1:1` / 縮放。
   *
   * 🔴 **沒有這些按鈕時，zoom 實質上不存在** —— 綁定是 Ctrl＋滾輪，
   * 沒有任何提示的話使用者找不到，回報會是「沒有做 zoom 功能」。
   */
  zoomControls?: {
    zoomFactor: number;
    onZoomIn: () => void;
    onZoomOut: () => void;
    onFit: () => void;
    onActualSize: () => void;
  };
  /**
   * 佔位說明。
   *
   * 第一版沒有光柵化（`NullViewportRenderer`），viewport 是黑的。**空白的黑框
   * 看起來像壞掉**，因此明說原因——這比讓人以為「載入失敗」好。
   */
  placeholder?: string;
  onAttach: (
    info: ViewportInfo,
    container: HTMLDivElement,
    orientation: OrthoOrientation,
  ) => void;
  onDetach: (viewportId: string) => void;
  /** 鍵盤（格子有焦點時；點一下格子就有焦點）。 */
  onKey?: (viewportId: string, key: string) => void;
  /**
   * 模組掛在這一格上的 React chrome（`PanelSlot('viewport-overlay')`）。
   *
   * 🔴 **這是 CSS 版面上的東西，不是與影像對齊的內容。** 要畫與影像對齊的
   * 向量（地標點、相位游標線）走 `api.overlay` 的 painter —— 它拿得到
   * `project()`，這裡拿不到。
   */
  children?: ReactNode;
}

/** 換切片的鍵（↑↓、PageUp／PageDown、Home／End）：不讓瀏覽器拿去捲頁面。 */
const SLICE_KEYS = new Set(['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End']);

export function ViewportHost(props: ViewportHostProps): React.JSX.Element {
  const containerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (container === null) return undefined;
    const rect = container.getBoundingClientRect();
    props.onAttach(
      {
        viewportId: props.viewportId,
        is3D: props.is3D ?? false,
        width: Math.max(1, Math.round(rect.width)),
        height: Math.max(1, Math.round(rect.height)),
      },
      container,
      props.orientation ?? 'axial',
    );
    return () => props.onDetach(props.viewportId);
    // 刻意只依賴 viewportId／is3D：回呼每次 render 都是新的參考，
    // 放進依賴會讓 StrictMode 下的 attach/detach 無限循環。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.viewportId, props.is3D]);

  return (
    <div
      className={props.sliceBar ? 'viewport has-slicebar' : 'viewport'}
      data-viewport-id={props.viewportId}
      tabIndex={0}
      onKeyDown={(e) => {
        if (!props.onKey) return;
        if (e.key === 'Delete' || e.key === 'Backspace' || e.key === 'Escape' || e.key === 'Enter' || SLICE_KEYS.has(e.key)) e.preventDefault();
        props.onKey(props.viewportId, e.key);
      }}
    >
      {props.label !== undefined && <div className="viewport-label">{props.label}</div>}
      {props.sliceLabel !== undefined && props.sliceLabel !== '' && (
        <div className="viewport-slice">{props.sliceLabel}</div>
      )}
      {props.zoomControls && (
        <div className="viewport-controls">
          <button type="button" title={t('縮小（Ctrl ＋ 滾輪下）')} onClick={props.zoomControls.onZoomOut}>
            −
          </button>
          <span className="zoom-factor" title={t('目前縮放（相對 Fit）')}>
            {Math.round(props.zoomControls.zoomFactor * 100)}%
          </span>
          <button type="button" title={t('放大（Ctrl ＋ 滾輪上）')} onClick={props.zoomControls.onZoomIn}>
            {t('＋')}
          </button>
          <button type="button" title={t('整個網格回到視野內')} onClick={props.zoomControls.onFit}>
            Fit
          </button>
          <button
            type="button"
            title={t('一個螢幕像素對一個體素')}
            onClick={props.zoomControls.onActualSize}
          >
            1:1
          </button>
        </div>
      )}
      {props.placeholder !== undefined && (
        <div className="viewport-placeholder">{props.placeholder}</div>
      )}
      {/* core 會把 canvas 與 svg overlay 掛在這個容器裡 */}
      <div className="viewport-canvas-host" ref={containerRef} />
      {props.sliceBar && <SliceBar {...props.sliceBar} />}
      {props.children}
    </div>
  );
}
