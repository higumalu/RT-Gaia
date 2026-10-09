/**
 * 筆刷／橡皮擦範圍預覽：半徑 mm → 畫布 px 的換算、SVG 圓形游標、預設 footprint 改 disc。
 */
import { DEFAULT_BRUSH } from '../src/core/edit/brush';
import { SvgOverlayHost } from '../src/core/overlay/svgOverlayHost';
import { brushCursorPx, BRUSH_PREVIEW_TOOL_IDS } from '../src/core/tools/brushCursor';

describe('brush cursor', () => {
  it('radius in mm becomes radius in canvas px through the projection (zoom-aware, axis-aware)', () => {
    // 1 mm = 2 px（放大兩倍），平面在 xy
    const proj = {
      canvasToWorld: (x: number, y: number): [number, number, number] => [x / 2, y / 2, 10],
      worldToCanvas: (w: readonly number[]): { x: number; y: number } => ({ x: w[0]! * 2, y: w[1]! * 2 }),
    };
    const c = brushCursorPx(proj, { x: 100, y: 60 }, 3, [0, 1, 0]);
    expect(c).toEqual({ x: 100, y: 60, r: 6 });
    // 非單位長的 in-plane 軸也要正規化
    expect(brushCursorPx(proj, { x: 0, y: 0 }, 5, [0, 4, 0]).r).toBeCloseTo(10);
    expect([...BRUSH_PREVIEW_TOOL_IDS]).toEqual(['brush', 'eraser', 'threshold-brush']);
  });

  it('svg host shows/hides the circle and styles erase differently', () => {
    interface FakeEl {
      tag: string;
      attrs: Record<string, string>;
      style: Record<string, string>;
      children: FakeEl[];
      setAttribute(k: string, v: string): void;
      getAttribute(k: string): string | null;
      appendChild(child: FakeEl): void;
      removeChild(child: FakeEl): void;
      remove(): void;
    }
    const made: FakeEl[] = [];
    const make = (tag: string): FakeEl => {
      const attrs: Record<string, string> = {};
      const el: FakeEl = {
        tag,
        attrs,
        style: {},
        children: [],
        setAttribute: (k, v) => {
          attrs[k] = v;
        },
        getAttribute: (k) => attrs[k] ?? null,
        appendChild: (child) => {
          el.children.push(child);
        },
        removeChild: () => undefined,
        remove: () => undefined,
      };
      made.push(el);
      return el;
    };
    const container = { appendChild: () => undefined };
    const host = new SvgOverlayHost('axial', container, { createElementNS: (_ns: string, tag: string) => make(tag) } as never);
    const circle = made.find((e) => e.attrs['class'] === 'rt-brush-cursor');
    if (circle === undefined) throw new Error('沒有建立 rt-brush-cursor');
    expect(circle.style['display']).toBe('none');
    host.updateBrushCursor({ x: 10.24, y: 20.5, r: 7.26, erase: false });
    expect(circle.style['display']).toBe('');
    expect([circle.attrs['cx'], circle.attrs['cy'], circle.attrs['r']]).toEqual(['10.2', '20.5', '7.3']);
    host.updateBrushCursor({ x: 1, y: 1, r: 0.2, erase: true });
    expect(circle.attrs['class']).toBe('rt-brush-cursor erase');
    expect(circle.attrs['r']).toBe('1.0'); // 太小也至少 1 px 看得見
    host.updateBrushCursor(null);
    expect(circle.style['display']).toBe('none');
  });

  it('default brush footprint is the current plane (disc), 3 mm', () => {
    expect(DEFAULT_BRUSH.shape).toBe('disc');
    expect(DEFAULT_BRUSH.radiusMm).toBe(3);
  });
});
