/**
 * SVG overlay 的 DOM 宿主 —— **十字線 ＋ 旋轉 handle**。
 *
 * `svgOverlay.ts` 只有純函式（`hitTest`、顯示模式判定），沒有建立 DOM 的部分。
 * 界線 3 要求「overlay 的 DOM 節點由 `core/` 直接建立與更新，`react/` 只提供掛載
 * 容器」—— 這個類別就是那個建立點。**`react/` 端的 `ViewportHost` 不知道它存在。**
 *
 * ## 畫什麼
 *
 * 以 `planeOrigin` 的投影為中心：兩條參考線（水平、垂直）＋ 四個旋轉 handle
 * （左右兩個繞 `viewUp` 轉，上下兩個繞 `right` 轉）。拖 handle 像轉錶盤：指標
 * 繞中心轉了多少角度，平面就繞該 handle 的軸轉多少（`rotateInPlane`）。
 *
 * ## 座標
 *
 * SVG 的 `viewBox` 設成 canvas 的 backing store 尺寸、CSS 100%，因此
 * `worldToCanvas()` 算出的座標可以直接用，不必自己換算 CSS 比例。
 * `pointer-events: none`：滑鼠事件仍由容器收（`EventLayer`），hit-test 走純函式。
 *
 * `document` 可注入（測試在 Node 下沒有 DOM）。
 */

import type { Vec2 } from '../raster/types';
import type { SvgNode } from './measurementSvg';
import { hitTest, type SvgHandle } from './svgOverlay';

const SVG_NS = 'http://www.w3.org/2000/svg';

export interface SvgElementLike {
  setAttribute(name: string, value: string): void;
  appendChild(child: SvgElementLike): SvgElementLike;
  remove(): void;
  style: Record<string, string>;
}

export interface SvgDocumentLike {
  createElementNS(ns: string, tag: string): SvgElementLike;
}

export interface SvgOverlayState {
  /** 十字線中心（backing store 像素）。 */
  center: Vec2;
  /** backing store 尺寸。 */
  width: number;
  height: number;
  /** 顯示旋轉 handle 與參考線。false 時整層隱藏（hit-test 也回 null）。 */
  visible: boolean;
  /** 目前是斜面（畫面上以不同顏色提示）。 */
  oblique: boolean;
  /** 十字線旁的讀數：轉了多少（例：`水平 +12.3° · 傾斜 −5.0°`；拖曳中前面加 `Δ+3.2°`）。 */
  label?: string;
}

/** handle 離中心的距離：短邊的 38%，但至少 40 px。 */
export function handleRadiusPx(width: number, height: number): number {
  return Math.max(40, Math.min(width, height) * 0.38);
}

/** 四個旋轉 handle 的位置與軸。**純函式**，測試直接用。 */
export function rotateHandles(viewportId: string, state: SvgOverlayState): SvgHandle[] {
  if (!state.visible) return [];
  const r = handleRadiusPx(state.width, state.height);
  const { x, y } = state.center;
  return [
    { id: `${viewportId}:rot:right`, kind: 'crosshair-rotate', ownerId: viewportId, position: { x: x + r, y } },
    { id: `${viewportId}:rot:left`, kind: 'crosshair-rotate', ownerId: viewportId, position: { x: x - r, y } },
    { id: `${viewportId}:rot:up`, kind: 'crosshair-rotate', ownerId: viewportId, position: { x, y: y - r } },
    { id: `${viewportId}:rot:down`, kind: 'crosshair-rotate', ownerId: viewportId, position: { x, y: y + r } },
  ];
}

/** handle id → 旋轉軸：左右兩個繞 `viewUp`（法線在水平面上掃），上下兩個繞 `right`。 */
export function rotationAxisOf(handle: SvgHandle): 'up' | 'right' {
  return handle.id.endsWith(':rot:left') || handle.id.endsWith(':rot:right') ? 'up' : 'right';
}

/**
 * 錶盤式旋轉量：指標從 `from` 轉到 `to`（都相對 `center`）掃過的角度（度，逆時針為正）。
 * 靠近中心時角度會亂跳，因此半徑 < 8 px 視為 0。
 */
export function dialAngleDeg(center: Vec2, from: Vec2, to: Vec2): number {
  const r0 = Math.hypot(from.x - center.x, from.y - center.y);
  const r1 = Math.hypot(to.x - center.x, to.y - center.y);
  if (r0 < 8 || r1 < 8) return 0;
  // 螢幕 y 往下增加 → 用 -dy 才是數學上的逆時針
  const a0 = Math.atan2(-(from.y - center.y), from.x - center.x);
  const a1 = Math.atan2(-(to.y - center.y), to.x - center.x);
  let d = ((a1 - a0) * 180) / Math.PI;
  while (d > 180) d -= 360;
  while (d < -180) d += 360;
  return d;
}

export class SvgOverlayHost {
  private readonly svg: SvgElementLike;
  private readonly doc: SvgDocumentLike;
  /** 十字線 ＋ 旋轉 handle（跟 `'mpr'` 模式開關）。 */
  private readonly crosshair: SvgElementLike;
  /** 量測（永遠顯示，不跟 mpr 模式）。 */
  private readonly measures: SvgElementLike;
  private measureChildren: SvgElementLike[] = [];
  private measureHandles: SvgHandle[] = [];
  /** 圈選進行中的多邊形。 */
  private readonly lasso: SvgElementLike;
  /** 筆刷／橡皮擦的範圍預覽（下筆前要看得到半徑）。 */
  private readonly brushCursor: SvgElementLike;
  private readonly lineH: SvgElementLike;
  private readonly lineV: SvgElementLike;
  private readonly knobs: SvgElementLike[] = [];
  private readonly label: SvgElementLike;
  private state: SvgOverlayState;
  private handles: SvgHandle[] = [];

  constructor(
    private readonly viewportId: string,
    // 真 DOM 的 `appendChild` 型別是泛型 Node；這裡只需要「能把我們建的節點掛上去」
    container: { appendChild(child: never): unknown },
    doc: SvgDocumentLike = document,
  ) {
    this.state = { center: { x: 0, y: 0 }, width: 1, height: 1, visible: false, oblique: false };
    this.svg = doc.createElementNS(SVG_NS, 'svg');
    this.svg.setAttribute('class', 'rt-svg-overlay');
    this.svg.setAttribute('preserveAspectRatio', 'none');
    this.svg.style['position'] = 'absolute';
    this.svg.style['inset'] = '0';
    this.svg.style['width'] = '100%';
    this.svg.style['height'] = '100%';
    // 事件仍由容器收；這一層只畫
    this.svg.style['pointerEvents'] = 'none';
    this.doc = doc;
    this.measures = doc.createElementNS(SVG_NS, 'g');
    this.measures.setAttribute('class', 'rt-measurements');
    this.svg.appendChild(this.measures);
    this.crosshair = doc.createElementNS(SVG_NS, 'g');
    this.crosshair.setAttribute('class', 'rt-crosshair');
    this.svg.appendChild(this.crosshair);
    this.lasso = doc.createElementNS(SVG_NS, 'polyline');
    this.lasso.setAttribute('class', 'rt-lasso');
    this.lasso.style['display'] = 'none';
    this.svg.appendChild(this.lasso);
    this.brushCursor = doc.createElementNS(SVG_NS, 'circle');
    this.brushCursor.setAttribute('class', 'rt-brush-cursor');
    this.brushCursor.style['display'] = 'none';
    this.svg.appendChild(this.brushCursor);
    this.lineH = doc.createElementNS(SVG_NS, 'line');
    this.lineV = doc.createElementNS(SVG_NS, 'line');
    for (const line of [this.lineH, this.lineV]) {
      line.setAttribute('class', 'rt-crosshair-line');
      this.crosshair.appendChild(line);
    }
    for (let i = 0; i < 4; i += 1) {
      const knob = doc.createElementNS(SVG_NS, 'circle');
      knob.setAttribute('class', 'rt-rotate-handle');
      knob.setAttribute('r', '6');
      this.crosshair.appendChild(knob);
      this.knobs.push(knob);
    }
    this.label = doc.createElementNS(SVG_NS, 'text');
    this.label.setAttribute('class', 'rt-crosshair-label');
    this.crosshair.appendChild(this.label);
    container.appendChild(this.svg as never);
    this.update(this.state);
  }

  /** 每幀（或相機改變）後呼叫。 */
  update(state: SvgOverlayState): void {
    this.state = state;
    this.svg.setAttribute('viewBox', `0 0 ${state.width} ${state.height}`);
    // 只藏十字線那一組；量測永遠在
    this.crosshair.style['display'] = state.visible ? '' : 'none';
    this.svg.setAttribute('data-oblique', state.oblique ? 'true' : 'false');
    this.handles = rotateHandles(this.viewportId, state);
    if (!state.visible) return;
    const { x, y } = state.center;
    this.lineH.setAttribute('x1', '0');
    this.lineH.setAttribute('x2', String(state.width));
    this.lineH.setAttribute('y1', String(y));
    this.lineH.setAttribute('y2', String(y));
    this.lineV.setAttribute('y1', '0');
    this.lineV.setAttribute('y2', String(state.height));
    this.lineV.setAttribute('x1', String(x));
    this.lineV.setAttribute('x2', String(x));
    this.handles.forEach((h, i) => {
      const knob = this.knobs[i]!;
      knob.setAttribute('cx', String(h.position.x));
      knob.setAttribute('cy', String(h.position.y));
      knob.setAttribute('data-handle-id', h.id);
    });
    // 讀數放在十字線右上（中心右邊 8 px、上方 8 px）
    this.label.setAttribute('x', String(x + 8));
    this.label.setAttribute('y', String(y - 8));
    this.label.setAttribute('data-text', state.label ?? '');
    (this.label as SvgElementLike & { textContent?: string }).textContent = state.label ?? '';
  }

  currentHandles(): readonly SvgHandle[] {
    return this.handles;
  }

  /**
   * 筆刷／橡皮擦游標：以 backing px 畫一個圓（中心、半徑）；`null` 隱藏。
   * `erase` 換樣式（紅色虛線）。這不是工具的狀態，是 host 依 activeToolId 與 hover 位置算的。
   */
  updateBrushCursor(circle: { x: number; y: number; r: number; erase: boolean } | null): void {
    if (circle === null) {
      this.brushCursor.style['display'] = 'none';
      return;
    }
    this.brushCursor.style['display'] = '';
    this.brushCursor.setAttribute('cx', circle.x.toFixed(1));
    this.brushCursor.setAttribute('cy', circle.y.toFixed(1));
    this.brushCursor.setAttribute('r', Math.max(1, circle.r).toFixed(1));
    this.brushCursor.setAttribute('class', circle.erase ? 'rt-brush-cursor erase' : 'rt-brush-cursor');
  }

  /** 圈選預覽：`null` 隱藏。 */
  updateLasso(pointsPx: readonly Vec2[] | null): void {
    if (pointsPx === null || pointsPx.length === 0) {
      this.lasso.style['display'] = 'none';
      return;
    }
    this.lasso.style['display'] = '';
    this.lasso.setAttribute('points', pointsPx.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' '));
  }

  /** 量測層：整組重建（每格幾十個節點，不值得 diff）。 */
  updateMeasurements(nodes: readonly SvgNode[], handles: readonly SvgHandle[]): void {
    for (const child of this.measureChildren) child.remove();
    this.measureChildren = [];
    for (const node of nodes) {
      const el = this.doc.createElementNS(SVG_NS, node.tag);
      for (const [k, v] of Object.entries(node.attrs)) el.setAttribute(k, v);
      if (node.text !== undefined) (el as SvgElementLike & { textContent?: string }).textContent = node.text;
      this.measures.appendChild(el);
      this.measureChildren.push(el);
    }
    this.measureHandles = [...handles];
  }

  /**
   * backing store 像素座標的 hit-test（呼叫端負責 CSS → backing store 的換算）。
   * 量測的控制點優先於旋轉 handle；十字線藏著時只剩量測。
   */
  hitTest(at: Vec2): SvgHandle | null {
    const measure = hitTest(this.measureHandles, at);
    if (measure !== null) return measure;
    if (!this.state.visible) return null;
    return hitTest(this.handles, at);
  }

  center(): Vec2 {
    return this.state.center;
  }

  dispose(): void {
    this.svg.remove();
  }
}
