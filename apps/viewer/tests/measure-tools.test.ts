/**
 * 四個量測工具（fake ToolContext）：點在該 FoR 自己的座標、距離拖曳、多邊形收口與取消、
 * 方框深度、沒有影像拒絕啟動；SVG 描述；undo 聯集。
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  boxFromCorners,
  clearTools,
  createMeasurement,
  DRAFT_HINT,
  formatMeasurementValue,
  getTool,
  inPlaneExtent,
  isEditOp,
  measurementHandles,
  measurementNodes,
  measurementValue,
  primaryFrameGroupOf,
  registerBuiltinTools,
  hitTest,
  dragBoxCorner,
  dragBoxEdge,
  translatePoints,
  translationMat16,
  UndoStack,
  type FrameGroup,
  type Layer,
  type Measurement,
  type MeasurementOp,
  type ToolContext,
  type ViewReference,
} from '../src/core';

const axial: ViewReference = {
  frameOfReferenceUid: 'for.a',
  displayGridId: 'dg',
  planeOrigin: [0, 0, 0],
  viewPlaneNormal: [0, 0, -1],
  viewUp: [0, -1, 0],
  slabThicknessMm: 0,
  temporalGroupId: null,
  frameIndex: null,
};

const image = (uid: string): Layer =>
  ({ layerId: `img:${uid}`, kind: 'image', label: 'CT', groupId: null, frameOfReferenceUid: uid, contentRef: 's', visible: true, opacity: 1, order: 0 });

/** canvas px → primary 世界：1 px = 1 mm，x→x、y→y、z=0。 */
function fakeContext(opts: { fg?: FrameGroup; image?: Layer | null } = {}) {
  const store = new Map<string, Measurement>();
  const log: string[] = [];
  const lasso: { current: readonly number[][] | null; highlight: number | null } = { current: null, highlight: null };
  const ctx = {
    viewport: { viewportId: 'v', is3D: false, width: 100, height: 100 },
    camera: axial,
    canvasToWorld: (x: number, y: number) => [x, y, 0] as [number, number, number],
    worldToCanvas: (w: readonly number[]) => ({ x: w[0]!, y: w[1]! }),
    frameGroup: (uid: string) => opts.fg ?? primaryFrameGroupOf(uid, 's'),
    params: {},
    layers: () => (opts.image === null ? [] : [opts.image ?? image('for.a')]),
    activeImageLayer: () => (opts.image === null ? null : (opts.image ?? image('for.a'))),
    measurements: () => [...store.values()],
    addMeasurement: (m: Measurement, o?: { commit?: boolean }) => {
      store.set(m.measurementId, m);
      log.push(`add:${o?.commit === false ? 'draft' : 'commit'}`);
    },
    updateMeasurement: (id: string, patch: { points?: Float64Array | readonly number[]; label?: string }, o?: { commit?: boolean }) => {
      const m = store.get(id)!;
      store.set(id, { ...m, ...(patch.points ? { points: Float64Array.from(patch.points) } : {}), ...(patch.label ? { label: patch.label } : {}) });
      log.push(`update:${o?.commit === false ? 'draft' : 'commit'}`);
    },
    removeMeasurement: (id: string) => {
      store.delete(id);
      log.push('remove');
    },
    commitMeasurement: (id: string) => log.push(`commit:${store.get(id)?.kind}`),
    selectMeasurement: () => {},
    cssToBackingScale: () => ({ sx: 1, sy: 1 }),
    setLassoPreview: (poly: readonly number[][] | null) => {
      lasso.current = poly;
      log.push(poly === null ? 'lasso:off' : `lasso:${poly.length}`);
    },
    highlightVertex: (_id: string, index: number | null) => {
      lasso.highlight = index;
    },
  } as unknown as ToolContext;
  return { ctx, store, log, lasso };
}

beforeEach(() => {
  clearTools();
  registerBuiltinTools();
});
afterEach(() => clearTools());

describe('量測工具', () => {
  it('沒有可見影像 → 拒絕啟動（TL6）', () => {
    const { ctx } = fakeContext({ image: null });
    expect(() => getTool('measure-distance').activate(ctx)).toThrow(/TL6/);
  });

  it('距離：按下拖到放開 → 一筆 commit；點一下（沒拖）不留東西；點存在該 FoR 自己的座標', () => {
    const fg: FrameGroup = { ...primaryFrameGroupOf('for.b', 's'), role: 'secondary', transformToPrimary: translationMat16([100, 0, 0]), transformKind: 'rigid' };
    const { ctx, store, log } = fakeContext({ fg, image: image('for.b') });
    const t = getTool('measure-distance').activate(ctx);
    t.onPointerDown?.(110, 0);
    t.onPointerMove?.(113, 4);
    t.onPointerUp?.(113, 4);
    const m = [...store.values()][0]!;
    expect(m.kind).toBe('distance');
    // primary (110,0,0) → own (10,0,0)
    expect([...m.points]).toEqual([10, 0, 0, 13, 4, 0]);
    expect(measurementValue(m).value).toBe(5);
    expect(m.label).toBe('距離 1');
    expect(log.at(-1)).toBe('commit:distance');
    t.onPointerDown?.(50, 50);
    t.onPointerUp?.(50, 50);
    expect(store.size).toBe(1);
    expect(log.at(-1)).toBe('remove');
  });

  it('標記點：一下就一個；第二個自動編號 2', () => {
    const { ctx, store } = fakeContext();
    const t = getTool('measure-point').activate(ctx);
    t.onPointerDown?.(3, 4);
    t.onPointerUp?.(3, 4);
    t.onPointerDown?.(5, 6);
    t.onPointerUp?.(5, 6);
    expect([...store.values()].map((m) => m.label)).toEqual(['標記 1', '標記 2']);
  });

  it('面積：逐點點擊、點回第一點收口；不到三點按 Enter 不留東西；Esc 取消', () => {
    const { ctx, store, log } = fakeContext();
    const t = getTool('measure-area').activate(ctx);
    for (const [x, y] of [[0, 0], [10, 0], [10, 10], [0, 10]] as [number, number][]) {
      t.onPointerDown?.(x, y);
      t.onPointerUp?.(x, y);
    }
    // 點回第一點（8 px 內）
    t.onPointerDown?.(2, 1);
    t.onPointerUp?.(2, 1);
    const m = [...store.values()][0]!;
    expect(m.kind).toBe('area');
    expect(m.points.length).toBe(12);
    expect(m.viewReference).not.toBeNull();
    expect(measurementValue(m).value).toBeCloseTo(100);
    expect(log.at(-1)).toBe('commit:area');
    // 拖著走不是頂點
    t.onPointerDown?.(50, 50);
    t.onPointerUp?.(80, 80);
    expect(store.size).toBe(1);
    // 兩點就 Enter → 丟掉
    t.onPointerDown?.(50, 50);
    t.onPointerUp?.(50, 50);
    t.onPointerDown?.(60, 50);
    t.onPointerUp?.(60, 50);
    t.onKeyDown?.('Enter');
    expect(store.size).toBe(1);
    // Esc
    t.onPointerDown?.(50, 50);
    t.onPointerUp?.(50, 50);
    expect(store.size).toBe(2);
    t.onKeyDown?.('Escape');
    expect(store.size).toBe(1);
  });

  it('面積：再點一次最後的頂點（雙擊）也收口；只有兩點時點最後頂點不收口', () => {
    const { ctx, store, log } = fakeContext();
    const t = getTool('measure-area').activate(ctx);
    const tap = (x: number, y: number): void => {
      t.onPointerDown?.(x, y);
      t.onPointerUp?.(x, y);
    };
    tap(0, 0);
    tap(20, 0);
    tap(20, 0); // 兩點：點最後頂點不算收口（不到三點不是多邊形）
    expect(log.filter((l) => l.startsWith('commit:'))).toHaveLength(0);
    expect(store.size).toBe(1);
    tap(20, 20);
    tap(20, 20); // 第三點之後再點一次 → 雙擊收口
    expect(log.at(-1)).toBe('commit:area');
    const m = [...store.values()][0]!;
    expect(m.points.length).toBe(9);
    expect(measurementValue(m).value).toBeCloseTo(200);
  });

  it('面積：hover 出橡皮筋（最後頂點→游標，兩點以上再→起點）；離開清掉；✓／✕ 動作；收口與取消都清掉橡皮筋', () => {
    const { ctx, store, log, lasso } = fakeContext();
    const t = getTool('measure-area').activate(ctx);
    const tap = (x: number, y: number): void => {
      t.onPointerDown?.(x, y);
      t.onPointerUp?.(x, y);
    };
    t.onHover?.({ x: 5, y: 5 });
    expect(lasso.current).toBeNull(); // 還沒有頂點：沒東西可拉
    tap(0, 0);
    t.onHover?.({ x: 10, y: 0 });
    expect(lasso.current).toEqual([[0, 0, 0], [10, 0, 0]]);
    tap(10, 0);
    t.onHover?.({ x: 10, y: 10 });
    expect(lasso.current).toEqual([[10, 0, 0], [10, 10, 0], [0, 0, 0]]); // 最後 → 游標 → 起點
    t.onHover?.(null);
    expect(lasso.current).toBeNull();
    tap(10, 10);
    // 三點起、游標靠近起點 8 px 內 → 吸附：橡皮筋直接接到起點、起點被強調
    t.onHover?.({ x: 3, y: 2 });
    expect(lasso.current).toEqual([[10, 10, 0], [0, 0, 0]]);
    expect(lasso.highlight).toBe(0);
    t.onHover?.({ x: 0, y: 10 });
    expect(lasso.highlight).toBeNull();
    t.onAction?.('finish');
    expect(log.at(-2)).toBe('lasso:off');
    expect(log.at(-1)).toBe('commit:area');
    expect(store.size).toBe(1);
    // ✕：兩點就取消 → 什麼都不留、橡皮筋清掉
    tap(50, 50);
    tap(60, 50);
    t.onHover?.({ x: 70, y: 70 });
    t.onAction?.('cancel');
    expect(store.size).toBe(1);
    expect(lasso.current).toBeNull();
  });

  it('草稿 SVG：一點就有控制點（第一點的回饋）、頂點把手可拖、標籤是操作提示、吸附時起點放大；沒有任何按鈕', () => {
    const view = axial;
    const one = createMeasurement({ kind: 'area', frameOfReferenceUid: 'for.a', points: [0, 0, 0], viewReference: view, editedOn: view, label: '面積 1' });
    const onePx = [{ x: 100, y: 100 }];
    const base = { mode: 'full' as const, selected: true, editable: true, valueText: '', allowBody: false, draft: true };
    const nodes1 = measurementNodes({ ...base, measurement: one, pointsPx: onePx });
    expect(nodes1.filter((n) => n.attrs['class']?.includes('rt-measure-knob'))).toHaveLength(1);
    expect(nodes1.some((n) => n.attrs['data-action'] !== undefined || n.attrs['class']?.includes('rt-measure-btn'))).toBe(false);
    expect(nodes1.find((n) => n.tag === 'text')?.text).toContain(DRAFT_HINT);
    expect(nodes1.find((n) => n.tag === 'text')?.text).toContain('（草稿）');
    expect(measurementHandles({ ...base, measurement: one, pointsPx: onePx }).map((h) => h.kind)).toEqual(['measurement-point']);

    const tri = createMeasurement({ kind: 'area', frameOfReferenceUid: 'for.a', points: [0, 0, 0, 10, 0, 0, 10, 10, 0], viewReference: view, editedOn: view, label: '面積 1' });
    const triPx = [{ x: 100, y: 100 }, { x: 200, y: 100 }, { x: 200, y: 200 }];
    const h3 = measurementHandles({ ...base, measurement: tri, pointsPx: triPx });
    expect(h3.map((h) => h.kind)).toEqual(['measurement-point', 'measurement-point', 'measurement-point']);
    expect(h3.some((h) => h.kind === 'measurement-body')).toBe(false); // 草稿不整體平移
    // 吸附到起點：第 0 個控制點放大成環
    const snapped = measurementNodes({ ...base, measurement: tri, pointsPx: triPx, highlightIndex: 0 }).filter((n) => n.attrs['class']?.includes('rt-measure-knob'));
    expect(snapped[0]!.attrs['class']).toContain('highlight');
    expect(snapped[0]!.attrs['r']).toBe('8');
    expect(snapped[1]!.attrs['r']).toBe('5');
    // 非草稿、沒選中 → 沒有控制點；面板編輯模式 → 不管選中都有控制點與把手（黃色 editing）
    const plain = measurementNodes({ ...base, draft: false, selected: false, measurement: tri, pointsPx: triPx });
    expect(plain.some((n) => n.attrs['class']?.includes('rt-measure-knob'))).toBe(false);
    const editing = { ...base, draft: false, selected: false, editingVertices: true, measurement: tri, pointsPx: triPx };
    expect(measurementNodes(editing).filter((n) => n.attrs['class']?.includes('rt-measure-knob editing'))).toHaveLength(3);
    expect(measurementHandles(editing).filter((h) => h.kind === 'measurement-point')).toHaveLength(3);
    expect(measurementNodes(editing).find((n) => n.tag === 'text')?.text).not.toContain('草稿');
  });

  it('方框：拖矩形，深度＝短邊；太小視為點擊', () => {
    const { ctx, store } = fakeContext();
    const t = getTool('measure-roi3d').activate(ctx);
    t.onPointerDown?.(0, 0);
    t.onPointerMove?.(10, 4);
    t.onPointerUp?.(10, 4);
    const m = [...store.values()][0]!;
    expect(m.kind).toBe('roi3d');
    const p = [...m.points];
    expect(p.slice(0, 2)).toEqual([0, 0]);
    expect(p.slice(3, 5)).toEqual([10, 4]);
    expect(p[5]! - p[2]!).toBeCloseTo(4); // 深度 = 短邊 4
    expect(measurementValue(m).value).toBeCloseTo(0.16);
    t.onPointerDown?.(0, 0);
    t.onPointerUp?.(0.1, 0.1);
    expect(store.size).toBe(1);
    expect(inPlaneExtent([0, 0, 0], [3, 4, 0], axial)).toEqual({ w: 3, h: 4 });
    expect(boxFromCorners([0, 0, 0], [10, 4, 0], axial, 4)).toEqual([0, 0, -2, 10, 4, 2]);
  });
});

describe('SVG 描述', () => {
  const dist = createMeasurement({ kind: 'distance', frameOfReferenceUid: 'for.a', points: [0, 0, 0, 3, 4, 0], viewReference: null, editedOn: axial, label: '距離 1' });
  const px = [{ x: 10, y: 10 }, { x: 40, y: 50 }];

  it('距離：一條線、兩個控制點、標籤帶值；不可編輯時沒有控制點', () => {
    const nodes = measurementNodes({ measurement: dist, pointsPx: px, mode: 'full', selected: true, editable: true, valueText: '5.0 mm' });
    expect(nodes.map((n) => n.tag)).toEqual(['line', 'circle', 'circle', 'rect', 'text']);
    expect(nodes[4]!.text).toContain('距離 1');
    expect(nodes[4]!.text).toContain('5.0 mm');
    // 底色寬度跟著字數估
    expect(Number(nodes[3]!.attrs['width'])).toBeGreaterThan(60);
    expect(nodes[0]!.attrs['class']).toContain('selected');
    const handles = measurementHandles({ measurement: dist, pointsPx: px, mode: 'full', selected: true, editable: true, valueText: '' });
    expect(handles.filter((h) => h.kind === 'measurement-point').map((h) => h.pointIndex)).toEqual([0, 1]);
    // 沒選中：只有身體（線段）把手，點一下才選中
    const unselected = measurementHandles({ measurement: dist, pointsPx: px, mode: 'full', selected: false, editable: true, valueText: '' });
    expect(unselected.map((h) => h.kind)).toEqual(['measurement-body']);
    expect(unselected[0]!.segment).toEqual([px[0], px[1]]);
    expect(measurementNodes({ measurement: dist, pointsPx: px, mode: 'full', selected: false, editable: false, valueText: '' }).map((n) => n.tag)).toEqual(['line', 'rect', 'text']);
    // 未選中：不畫控制點
    expect(measurementNodes({ measurement: dist, pointsPx: px, mode: 'full', selected: false, editable: true, valueText: '' }).map((n) => n.tag)).toEqual(['line', 'rect', 'text']);
  });

  it('面積：共面畫多邊形；斜面只畫交線且沒有控制點；hidden 什麼都不畫', () => {
    const area = createMeasurement({ kind: 'area', frameOfReferenceUid: 'for.a', points: [0, 0, 0, 10, 0, 0, 10, 10, 0], viewReference: axial, editedOn: axial, label: '面積 1' });
    const tri = [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }];
    expect(measurementNodes({ measurement: area, pointsPx: tri, mode: 'full', selected: false, editable: true, valueText: '50.0 mm²' })[0]!.tag).toBe('polygon');
    const cut = measurementNodes({
      measurement: area,
      pointsPx: tri,
      mode: 'intersection-only',
      selected: false,
      editable: false,
      valueText: '',
      intersectionPx: [[{ x: 1, y: 1 }, { x: 9, y: 9 }]],
    });
    expect(cut.map((n) => n.tag)).toEqual(['line', 'rect', 'text']);
    expect(cut[0]!.attrs['class']).toContain('rt-measure-section');
    // 斜面：沒有頂點把手，但交線可以點選（身體）
    const cutHandles = measurementHandles({ measurement: area, pointsPx: tri, mode: 'intersection-only', selected: true, editable: false, valueText: '', intersectionPx: [[{ x: 1, y: 1 }, { x: 9, y: 9 }]] });
    expect(cutHandles.map((h) => h.kind)).toEqual(['measurement-body']);
    expect(measurementNodes({ measurement: area, pointsPx: tri, mode: 'hidden', selected: false, editable: true, valueText: '' })).toEqual([]);
    // 未收口（兩點）畫 polyline
    expect(measurementNodes({ measurement: area, pointsPx: tri.slice(0, 2), mode: 'full', selected: false, editable: true, valueText: '' })[0]!.tag).toBe('polyline');
  });

  it('方框：畫截面、沒有控制點；標記點：十字 ＋ 圈；值的格式', () => {
    const box = createMeasurement({ kind: 'roi3d', frameOfReferenceUid: 'for.a', points: [0, 0, 0, 10, 10, 10], viewReference: null, editedOn: axial, label: '體積 1' });
    const sec = [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }];
    expect(measurementNodes({ measurement: box, pointsPx: sec, mode: 'full', selected: false, editable: false, valueText: '1.00 cc', sectionPx: sec }).map((n) => n.tag)).toEqual(['polygon', 'rect', 'text']);
    // 方框：選中且正交切面 → 四個角把手 ＋ 四條邊；未選中只有邊
    const corners = measurementHandles({ measurement: box, pointsPx: sec, mode: 'full', selected: true, editable: false, valueText: '', sectionPx: sec, boxCornersDraggable: true });
    expect(corners.filter((h) => h.kind === 'measurement-box-corner')).toHaveLength(4);
    expect(corners.filter((h) => h.kind === 'measurement-body')).toHaveLength(4);
    expect(measurementHandles({ measurement: box, pointsPx: sec, mode: 'full', selected: false, editable: false, valueText: '', sectionPx: sec, allowBody: false })).toEqual([]);
    const pt = createMeasurement({ kind: 'point', frameOfReferenceUid: 'for.a', points: [1.23, 4.56, 7.89], viewReference: null, editedOn: axial, label: '標記 1' });
    expect(measurementNodes({ measurement: pt, pointsPx: [{ x: 5, y: 5 }], mode: 'full', selected: true, editable: true, valueText: '' }).map((n) => n.tag)).toEqual(['path', 'circle', 'circle', 'rect', 'text']);
    expect(formatMeasurementValue(pt, undefined)).toBe('(1.2, 4.6, 7.9) mm');
    expect(formatMeasurementValue(dist, { value: 5, unit: 'mm' })).toBe('5.0 mm');
    expect(formatMeasurementValue(box, { value: 1, unit: 'cc' })).toBe('1.00 cc');
    expect(formatMeasurementValue(box, { value: 12.34, unit: 'mm2' })).toBe('12.3 mm²');
  });
});

describe('undo 聯集（與筆刷共用一個 stack）', () => {
  it('量測 op 進同一個 stack；undo 回 before、redo 回 after；invalidateStructure 不動量測', () => {
    const applied: string[] = [];
    const stack = new UndoStack((op, dir) => applied.push(`${isEditOp(op) ? 'edit' : 'measure'}:${dir}:${isEditOp(op) ? '' : op.after === null ? 'gone' : 'there'}`));
    const m = createMeasurement({ kind: 'point', frameOfReferenceUid: 'f', points: [0, 0, 0], viewReference: null, editedOn: axial, label: 'p' });
    const create: MeasurementOp = { kind: 'measurement', measurementId: m.measurementId, before: null, after: m, viewReference: axial };
    stack.push(create);
    stack.push({ kind: 'measurement', measurementId: m.measurementId, before: m, after: null, viewReference: axial });
    expect(stack.undoDepth).toBe(2);
    expect(stack.bytes()).toBe(m.points.byteLength * 2);
    expect(stack.invalidateStructure('gtv')).toBe(0);
    expect(stack.undoDepth).toBe(2);
    stack.undo();
    stack.undo();
    stack.redo();
    expect(applied).toEqual(['measure:undo:gone', 'measure:undo:there', 'measure:redo:there']);
    expect(stack.auditTrail()[0]!.structureId).toBe(`measurement:${m.measurementId}`);
    expect(() => stack.push({ kind: 'measurement', measurementId: 'x', before: null, after: null, viewReference: axial })).toThrow(/U3/);
  });
});

describe('選取後編輯（2026-09-09）', () => {
  it('hitTest：點把手優先於線段；線段命中看點到線段距離', () => {
    const seg = { id: 's', kind: 'measurement-body' as const, ownerId: 'm', position: { x: 0, y: 0 }, segment: [{ x: 0, y: 0 }, { x: 100, y: 0 }] as const };
    const pt = { id: 'p', kind: 'measurement-point' as const, ownerId: 'm', position: { x: 50, y: 0 }, pointIndex: 0 };
    expect(hitTest([seg, pt], { x: 50, y: 3 })?.id).toBe('p');
    expect(hitTest([seg], { x: 30, y: 5 })?.id).toBe('s');
    expect(hitTest([seg], { x: 30, y: 20 })).toBeNull();
    expect(hitTest([seg], { x: 130, y: 0 })).toBeNull();
  });

  it('方框拉角：平面內兩軸各改離角較近的那端；法線軸不動；min<max', () => {
    const pts = [0, 0, 0, 10, 20, 30];
    // 軸向（法線 z）：拖 (10,20) 那個角到 (14,25)
    expect(dragBoxCorner(pts, [10, 20, 15], [14, 25, 15], 2)).toEqual([0, 0, 0, 14, 25, 30]);
    // 拖 min 角越過 max → 交換
    expect(dragBoxCorner(pts, [0, 0, 15], [12, 3, 15], 2)).toEqual([10, 3, 0, 12, 20, 30]);
  });

  it('方框拉邊：只改沿這條邊不變的那一軸；法線軸與另一軸不動；太小撐到 0.5', () => {
    const pts = [0, 0, 0, 10, 20, 30];
    // 軸向（法線 z）：x=10 的那條邊（y 從 0 到 20）拖到 x=16 → 只改 max x
    expect(dragBoxEdge(pts, [[10, 0, 15], [10, 20, 15]], [16, 7, 15], 2)).toEqual([0, 0, 0, 16, 20, 30]);
    // y=0 的邊往上拖到 y=4 → 只改 min y
    expect(dragBoxEdge(pts, [[0, 0, 15], [10, 0, 15]], [3, 4, 15], 2)).toEqual([0, 4, 0, 10, 20, 30]);
    // 冠狀（法線 y）：z=30 的邊拖到 z=0.2（離 min 太近）→ 撐到 0.5；拖到 -8（越過 min）→ 交換
    expect(dragBoxEdge(pts, [[0, 5, 30], [10, 5, 30]], [5, 5, 0.2], 1)).toEqual([0, 0, 0, 10, 20, 0.5]);
    expect(dragBoxEdge(pts, [[0, 5, 30], [10, 5, 30]], [5, 5, -8], 1)).toEqual([0, 0, -8, 10, 20, 0]);
    // 不是軸對齊的邊（斜面）→ 原樣
    expect(dragBoxEdge(pts, [[0, 0, 15], [10, 20, 15]], [5, 5, 15], 2)).toEqual([0, 0, 0, 10, 20, 30]);
  });

  it('整體平移：面積的位移投到自己的平面；距離直接加', () => {
    const area = createMeasurement({ kind: 'area', frameOfReferenceUid: 'f', points: [0, 0, 5, 10, 0, 5, 10, 10, 5], viewReference: { ...axial, planeOrigin: [0, 0, 5] }, editedOn: axial, label: 'a' });
    const moved = translatePoints(area, [1, 2, 99]);
    expect(moved).toEqual([1, 2, 5, 11, 2, 5, 11, 12, 5]);
    const dist = createMeasurement({ kind: 'distance', frameOfReferenceUid: 'f', points: [0, 0, 0, 1, 1, 1], viewReference: null, editedOn: axial, label: 'd' });
    expect(translatePoints(dist, [1, 1, 1])).toEqual([1, 1, 1, 2, 2, 2]);
  });

  it('十字線導航：Shift＋左鍵按下與拖曳同步游標下的世界座標；裸左鍵不動作', () => {
    const calls: number[][] = [];
    const ctx = { canvasToWorld: (x: number, y: number) => [x, y, 0], setCrosshair: (w: readonly number[]) => calls.push([...w]) } as unknown as ToolContext;
    const t = getTool('navigate').activate(ctx);
    const shift = { shift: true, ctrl: false, alt: false };
    t.onPointerDown?.(3, 4, shift);
    t.onPointerMove?.(5, 6, shift);
    t.onPointerUp?.(5, 6, shift);
    t.onPointerMove?.(9, 9, shift);
    t.onPointerDown?.(1, 1, { shift: false, ctrl: false, alt: false });
    t.onPointerDown?.(2, 2);
    expect(calls).toEqual([[3, 4, 0], [5, 6, 0]]);
  });
});
