/**
 * Viewport overlay 註冊表 —— **面板在 viewport 上畫自己的東西**。
 *
 * ## 為什麼不是 React
 *
 * > 界線 3：**overlay 的 DOM／canvas 節點由 `core/` 直接建立與更新；`react/`
 * > 只提供掛載容器。**
 *
 * 面板要在影像上疊東西（DCE 的相位游標線、QA 的標註、配準的地標點）時，
 * 若走 React state → 重新 render，會與輪廓爭同一幀。**因此畫布層的
 * overlay 一律註冊 painter 到這裡，由 `CpuViewportRenderer` 在每幀畫完輪廓後
 * 依序呼叫。**
 *
 * 這與 `PanelSlot('viewport-overlay')` 是**兩件事，都需要**：
 *
 * | | 用途 | 座標系 |
 * |---|---|---|
 * | `PanelSlot('viewport-overlay')` | viewport 角落的 React chrome（徽章、下拉、按鈕） | CSS 版面 |
 * | **本註冊表的 painter** | **與影像對齊的向量內容** | **世界座標，經 `project()`** |
 *
 * ## 給 painter 作者的三條規則
 *
 * | # | 規則 | 理由 |
 * |---|---|---|
 * | **P1** | **不得在 `paint()` 裡配置新緩衝或組字串** | 每幀數萬座標的 GC 壓力會表現成週期性掉幀，而那種症狀最難歸因 |
 * | **P2** | **不得在 `paint()` 裡發起網路請求或改動 layer 狀態** | 與「不得在 render 迴圈發起網路請求」同源。資料未到齊就先不要畫 |
 * | **P3** | **一律用 `project()` 換算，不要自己算相機數學** | 相機、pxMm、backing store 縮放三者都會變；自己算的必然在某個縮放下偏掉 |
 *
 * `paint()` 拋例外不會讓整幀掛掉——呼叫端會捕捉、回報一次、並停用該 painter
 * （見 `CpuViewportRenderer`）。**這是刻意的**：第三方面板的 bug 不該讓影像消失。
 */

import type { Vec3, ViewReference } from '../geometry';
import type { Quality, Vec2 } from '../raster/types';

/** 所有 2D viewport。 */
export const ALL_VIEWPORTS = '*' as const;

export interface OverlayPaintContext {
  readonly viewportId: string;
  /**
   * overlay canvas 的 2D 上下文。
   *
   * 呼叫端已經 `save()` 過，`paint()` 回來之後會 `restore()`——因此**可以放心
   * 改 `strokeStyle` / `lineWidth` / `globalAlpha`，不必自己還原**。
   */
  readonly ctx: CanvasRenderingContext2D;
  /** backing store 尺寸（**不是 CSS 尺寸**）。`project()` 回傳的就是這個座標系。 */
  readonly width: number;
  readonly height: number;
  readonly camera: ViewReference;
  /** 兩態品質。互動中應該少畫一點。 */
  readonly quality: Quality;
  /** 世界 LPS mm → overlay canvas 像素（`project`）。 */
  project(world: Vec3): Vec2;
  /**
   * 世界座標到當前平面的**帶號距離**（mm）。
   *
   * 判斷「這個點在不在當前切面上」用它，**不要拿 slice index 比**。
   */
  signedDistanceMm(world: Vec3): number;
}

export interface OverlayPainter {
  readonly id: string;
  /** 小的先畫（在下層）。預設 0。輪廓本身視為 0，因此預設會畫在輪廓之上。 */
  readonly order?: number;
  /** 只畫在哪個 viewport；`'*'`（預設）= 所有 2D viewport。 */
  readonly viewportId?: string;
  paint(ctx: OverlayPaintContext): void;
  /** 取消註冊時呼叫。釋放自己配置的緩衝。 */
  dispose?(): void;
}

/**
 * 註冊表本身。
 *
 * 🔴 **由 `useScene` 以 `useRef` 持有並傳進 `ViewerHost`，不是由 `ViewerHost`
 * 自己建。** `ViewerHost` 會因為換病例而重建（`gridSet` 改變即重建），若註冊表
 * 掛在它身上，面板註冊的 painter 會在切換病例時**靜默消失**——而面板不會知道
 * 要重新註冊。
 */
export class ViewportOverlayRegistry {
  private readonly painters = new Map<string, OverlayPainter>();
  /** 曾經拋例外而被停用的 painter。**停用是永久的，直到重新註冊。** */
  private readonly failed = new Map<string, string>();
  private onChange: (() => void) | null = null;

  /** 註冊一個 painter，回傳取消註冊的函式（給 React 的 `useEffect` cleanup 用）。 */
  register(painter: OverlayPainter): () => void {
    this.painters.set(painter.id, painter);
    this.failed.delete(painter.id);
    this.onChange?.();
    return () => this.unregister(painter.id);
  }

  unregister(id: string): boolean {
    const painter = this.painters.get(id);
    if (painter === undefined) return false;
    painter.dispose?.();
    this.painters.delete(id);
    this.failed.delete(id);
    this.onChange?.();
    return true;
  }

  /** 某個 viewport 該畫的 painter，已依 `order` 排好。 */
  paintersFor(viewportId: string): OverlayPainter[] {
    return [...this.painters.values()]
      .filter((p) => !this.failed.has(p.id))
      .filter((p) => (p.viewportId ?? ALL_VIEWPORTS) === ALL_VIEWPORTS || p.viewportId === viewportId)
      .sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  }

  /** painter 拋例外時由呼叫端通知：停用它並記下原因。 */
  markFailed(id: string, reason: string): void {
    if (this.failed.has(id)) return;
    this.failed.set(id, reason);
    this.onChange?.();
  }

  /** 被停用的 painter 與原因（狀態列要能顯示，否則 painter 靜默不見）。 */
  failures(): { id: string; reason: string }[] {
    return [...this.failed.entries()].map(([id, reason]) => ({ id, reason }));
  }

  /** 註冊集合改變時通知 UI（例如狀態列要更新失敗清單）。 */
  setChangeListener(listener: (() => void) | null): void {
    this.onChange = listener;
  }

  get size(): number {
    return this.painters.size;
  }

  clear(): void {
    for (const painter of this.painters.values()) painter.dispose?.();
    this.painters.clear();
    this.failed.clear();
    this.onChange?.();
  }
}
