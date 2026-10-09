/**
 * 互動、滑鼠綁定與 overlay。
 */

import { describe, expect, it, vi } from 'vitest';

import {
  applyPlaneToCanvas,
  buttonOf,
  CanvasPathSink,
  checkOutlineBudget,
  CoordinateBuffer,
  DEFAULT_BINDINGS,
  DEFAULT_SLAB_OUTLINE_SEMANTICS,
  EventLayer,
  hitTest,
  isMeasurementEditable,
  measurementDisplayMode,
  outlineInvalidation,
  outlineResolutionScale,
  planSlabOutline,
  resolveDrag,
  resolveWheel,
  SLAB_NOTICE_THRESHOLD_MM,
  computeMeasurementValue,
  zoomAtCursor,
  type Measurement,
  type SvgHandle,
  type ViewReference,
} from '../src/core';

const NO_MOD = { shiftKey: false, ctrlKey: false, altKey: false };

describe('滑鼠綁定', () => {
  it('右鍵是 WW/WL（放射科慣例，刻意與 3D Slicer 分歧）', () => {
    expect(resolveDrag(DEFAULT_BINDINGS, 'right', { shift: false, ctrl: false, alt: false })).toBe(
      'window-level',
    );
  });

  it('中鍵 Pan、左鍵是目前工具', () => {
    const mods = { shift: false, ctrl: false, alt: false };
    expect(resolveDrag(DEFAULT_BINDINGS, 'middle', mods)).toBe('pan');
    expect(resolveDrag(DEFAULT_BINDINGS, 'left', mods)).toBe('active-tool');
  });

  it('Shift ＋ 左鍵交給工具（十字線導航）；Ctrl ＋ 左鍵是 Pan（給只有左鍵的環境）', () => {
    expect(resolveDrag(DEFAULT_BINDINGS, 'left', { shift: true, ctrl: false, alt: false })).toBe('active-tool');
    expect(resolveDrag(DEFAULT_BINDINGS, 'left', { shift: false, ctrl: true, alt: false })).toBe('pan');
  });

  it('滾輪捲動切面，Ctrl ＋ 滾輪 Zoom', () => {
    expect(resolveWheel(DEFAULT_BINDINGS, { shift: false, ctrl: false, alt: false })).toBe(
      'scroll-slice',
    );
    expect(resolveWheel(DEFAULT_BINDINGS, { shift: false, ctrl: true, alt: false })).toBe('zoom');
  });

  it('DOM button 對應', () => {
    expect(buttonOf(0)).toBe('left');
    expect(buttonOf(1)).toBe('middle');
    expect(buttonOf(2)).toBe('right');
    expect(buttonOf(4)).toBeNull();
  });
});

describe('事件層：品質狀態的唯一觸發點', () => {
  function setup() {
    const commands: string[] = [];
    const begin = vi.fn();
    const end = vi.fn();
    const layer = new EventLayer({
      viewportId: 'axial',
      onCommand: (c) => commands.push(`${c.action}:${c.phase}`),
      onInteractionBegin: begin,
      onInteractionEnd: end,
    });
    return { layer, commands, begin, end };
  }

  it('pointerdown → begin，pointerup → end', () => {
    const { layer, commands, begin, end } = setup();
    layer.pointerDown({ clientX: 10, clientY: 10, button: 2, ...NO_MOD });
    layer.pointerMove({ clientX: 20, clientY: 15, button: 2, ...NO_MOD });
    layer.pointerUp({ clientX: 20, clientY: 15, button: 2, ...NO_MOD });
    expect(commands).toEqual(['window-level:begin', 'window-level:move', 'window-level:end']);
    expect(begin).toHaveBeenCalledOnce();
    expect(end).toHaveBeenCalledOnce();
  });

  it('未按下時的 move 不產生指令', () => {
    const { layer, commands } = setup();
    layer.pointerMove({ clientX: 5, clientY: 5, button: 0, ...NO_MOD });
    expect(commands).toEqual([]);
  });

  it('右鍵拖曳會擋掉瀏覽器選單（否則手感直接壞掉）', () => {
    const { layer } = setup();
    const preventDefault = vi.fn();
    layer.pointerDown({ clientX: 0, clientY: 0, button: 2, preventDefault, ...NO_MOD });
    expect(preventDefault).toHaveBeenCalledOnce();
  });

  it('delta 是相對上一個事件的位移', () => {
    const commands: { dx: number; dy: number }[] = [];
    const layer = new EventLayer({
      viewportId: 'axial',
      onCommand: (c) => commands.push({ dx: c.delta.x, dy: c.delta.y }),
    });
    layer.pointerDown({ clientX: 100, clientY: 100, button: 1, ...NO_MOD });
    layer.pointerMove({ clientX: 110, clientY: 95, button: 1, ...NO_MOD });
    layer.pointerMove({ clientX: 115, clientY: 95, button: 1, ...NO_MOD });
    expect(commands[1]).toEqual({ dx: 10, dy: -5 });
    expect(commands[2]).toEqual({ dx: 5, dy: 0 });
  });

  it('setOrigin 讓座標相對於 viewport，而不是視窗', () => {
    const positions: { x: number; y: number }[] = [];
    const layer = new EventLayer({
      viewportId: 'axial',
      onCommand: (c) => positions.push(c.position),
    });
    layer.setOrigin({ x: 40, y: 20 });
    layer.pointerDown({ clientX: 100, clientY: 100, button: 1, ...NO_MOD });
    expect(positions[0]).toEqual({ x: 60, y: 80 });
  });

  it('滾輪刻度正規化（跨瀏覽器 deltaY 差異大）', () => {
    const ticks: number[] = [];
    const layer = new EventLayer({
      viewportId: 'axial',
      onCommand: (c) => ticks.push(c.wheelTicks),
    });
    layer.wheel({ clientX: 0, clientY: 0, deltaY: 100, ...NO_MOD });
    layer.wheel({ clientX: 0, clientY: 0, deltaY: -3, ...NO_MOD });
    layer.wheel({ clientX: 0, clientY: 0, deltaY: 250, ...NO_MOD });
    expect(ticks).toEqual([1, -1, 3]);
  });
});

/**
 * ⚠️ 這裡測的是 **overlay 的 2D 仿射變換**，
 * **不是 viewport 的 zoom** —— 後者在 `tests/cameras.test.ts`。
 * 兩者同名曾讓「zoom 有測試」變成一個假的安心感。
 */
describe('hover 探測點', () => {
  const pointer = (x: number, y: number, button = -1) => ({
    clientX: x,
    clientY: y,
    button,
    shiftKey: false,
    ctrlKey: false,
    altKey: false,
    preventDefault: () => {},
  });

  it('沒有按鍵時也要回報位置 —— 讀數的常見用法就是「移過去看一下」', () => {
    const onHover = vi.fn();
    const layer = new EventLayer({ viewportId: 'axial', onCommand: () => {}, onHover });
    // 沒有 pointerDown，直接移動
    expect(layer.pointerMove(pointer(40, 30))).toBeNull(); // 不產生任何動作
    expect(onHover).toHaveBeenCalledWith({ x: 40, y: 30 }, expect.objectContaining({ shift: false }));
  });

  it('hover 帶修飾鍵：Shift＋滑動要能被 host 拿去對切面（2026-09-16）', () => {
    const onHover = vi.fn();
    const layer = new EventLayer({ viewportId: 'axial', onCommand: () => {}, onHover });
    layer.pointerMove({ ...pointer(10, 10), shiftKey: true });
    expect(onHover).toHaveBeenLastCalledWith({ x: 10, y: 10 }, expect.objectContaining({ shift: true }));
  });

  it('🔴 座標必須是容器相對，不是頁面座標', () => {
    const onHover = vi.fn();
    const layer = new EventLayer({ viewportId: 'axial', onCommand: () => {}, onHover });
    layer.setOrigin({ x: 330, y: 76 });
    layer.pointerMove(pointer(600, 254));
    // 少了這個換算，讀數的世界座標會整片偏掉，偏移量 = 容器左上角 × mm/px
    // （實測偏 653 mm，見 `ViewerHost.onMove` 的註解）
    expect(onHover).toHaveBeenCalledWith({ x: 270, y: 178 }, expect.anything());
  });

  it('拖曳中仍然回報（探測點跟著指標，不是跟著按鍵）', () => {
    const onHover = vi.fn();
    const layer = new EventLayer({ viewportId: 'axial', onCommand: () => {}, onHover });
    layer.pointerDown(pointer(10, 10, 0));
    layer.pointerMove(pointer(20, 25));
    expect(onHover).toHaveBeenLastCalledWith({ x: 20, y: 25 }, expect.anything());
  });

  it('離開時回報 null —— 由呼叫端決定要凍結還是清空', () => {
    const onHover = vi.fn();
    const layer = new EventLayer({ viewportId: 'axial', onCommand: () => {}, onHover });
    layer.pointerLeave();
    expect(onHover).toHaveBeenCalledWith(null);
  });
});

describe('overlay 仿射：Zoom 以游標位置為中心', () => {
  it('游標下的那一點在縮放前後落在同一個 canvas 像素', () => {
    const before = { scale: 2, offsetX: 100, offsetY: 50 };
    const cursor = { x: 300, y: 200 };
    const after = zoomAtCursor(before, cursor, 1.25);
    const planePointAt = (t: typeof before, canvasX: number): number => (canvasX - t.offsetX) / t.scale;
    // 同一個平面座標
    expect(planePointAt(before, cursor.x)).toBeCloseTo(planePointAt(after, cursor.x), 9);
    expect(after.scale).toBe(2.5);
  });

  it('以畫面中心縮放時游標下的點會跑掉（對照，說明為何要以游標為中心）', () => {
    const before = { scale: 2, offsetX: 100, offsetY: 50 };
    const naive = { scale: 2.5, offsetX: 100, offsetY: 50 };
    const planePointAt = (t: typeof before, canvasX: number): number => (canvasX - t.offsetX) / t.scale;
    expect(planePointAt(before, 300)).not.toBeCloseTo(planePointAt(naive, 300), 3);
  });
});

describe('outline 的失效表', () => {
  it('Pan / Zoom 不失效 —— 對既有 polyline 做仿射變換，精確而非近似', () => {
    const v = outlineInvalidation('pan-zoom');
    expect(v.needsRecompute).toBe(false);
    expect(v.note).toContain('精確');
  });

  it('WW/WL 完全不動', () => {
    expect(outlineInvalidation('window-level').needsRecompute).toBe(false);
  });

  it('🔴 捲動切面完全失效 —— 唯一沒有捷徑的操作，也是最高頻的', () => {
    const v = outlineInvalidation('slice-scroll');
    expect(v.needsRecompute).toBe(true);
    expect(v.partial).toBe(false);
  });

  it('相位切換要重算，但無 texture 上傳（播放便宜的原因）', () => {
    const v = outlineInvalidation('phase-change');
    expect(v.needsRecompute).toBe(true);
    expect(v.note).toContain('texture');
  });

  it('可見結構集合改變與筆刷落筆只需部分重算', () => {
    expect(outlineInvalidation('visible-set-change').partial).toBe(true);
    expect(outlineInvalidation('brush-stroke').partial).toBe(true);
  });

  it('互動中以 1/2 線性解析度（成本 1/4）', () => {
    expect(outlineResolutionScale('interactive')).toBe(0.5);
    expect(outlineResolutionScale('final')).toBe(1);
  });

  it('仿射變換套用在既有座標上（Pan/Zoom 的實作）', () => {
    const plane = Float32Array.from([0, 0, 10, 20]);
    const out = new Float32Array(4);
    applyPlaneToCanvas({ scale: 2, offsetX: 5, offsetY: 7 }, plane, out);
    expect([...out]).toEqual([5, 7, 25, 47]);
  });
});

describe('slab 厚度下的輪廓語意', () => {
  it('暫定預設是 slab 中心面（語意 A）', () => {
    expect(DEFAULT_SLAB_OUTLINE_SEMANTICS).toBe('center');
    const plan = planSlabOutline({ slabThicknessMm: 10, quality: 'final' });
    expect(plan.semantics).toBe('center');
    expect(plan.samplePlanes).toBe(1);
  });

  it('slab > 2 mm 時常駐標示「輪廓＝slab 中心面」', () => {
    expect(SLAB_NOTICE_THRESHOLD_MM).toBe(2);
    expect(planSlabOutline({ slabThicknessMm: 10, quality: 'final' }).notice).toContain('中心面');
    expect(planSlabOutline({ slabThicknessMm: 1, quality: 'final' }).notice).toBeNull();
  });

  it('🔴 B 與 C 絕不進入互動態（×N 成本會讓三個 Tier 全部破表）', () => {
    const plan = planSlabOutline({
      slabThicknessMm: 10,
      quality: 'interactive',
      semantics: 'union-outer',
    });
    expect(plan.semantics).toBe('center');
    expect(plan.samplePlanes).toBe(1);
  });

  it('停止互動後才允許 ×N 的語意', () => {
    const plan = planSlabOutline({
      slabThicknessMm: 10,
      quality: 'final',
      semantics: 'stacked',
      sampleSpacingMm: 1,
    });
    expect(plan.semantics).toBe('stacked');
    expect(plan.samplePlanes).toBe(11);
  });
});

describe('outline 預算對照', () => {
  it('互動中 20 結構 6 ms 在 Tier A 內', () => {
    const verdict = checkOutlineBudget({
      structureCount: 20,
      quality: 'interactive',
      elapsedMs: 6,
      tier: 'A',
    });
    expect(verdict.withinBudget).toBe(true);
    expect(verdict.budgetMs).toBe(8);
  });

  it('正規化到 20 結構後才比較（實測 10 結構 5 ms → 等於 20 結構 10 ms）', () => {
    const verdict = checkOutlineBudget({
      structureCount: 10,
      quality: 'interactive',
      elapsedMs: 5,
      tier: 'A',
    });
    expect(verdict.normalizedMs).toBe(10);
    expect(verdict.withinBudget).toBe(false);
  });

  it('Tier C 的全解析度補算預算是 80 ms', () => {
    expect(
      checkOutlineBudget({ structureCount: 20, quality: 'final', elapsedMs: 79, tier: 'C' })
        .withinBudget,
    ).toBe(true);
  });
});

describe('座標緩衝區重用', () => {
  it('穩定狀態下停止成長（每幀配置會表現成週期性掉幀）', () => {
    const buffer = new CoordinateBuffer(16);
    for (let frame = 0; frame < 50; frame += 1) {
      buffer.reset();
      for (let n = 0; n < 8; n += 1) buffer.push2(n, n * 2);
    }
    expect(buffer.growthCount.value).toBe(0);
    expect(buffer.pointCount).toBe(8);
  });

  it('需要時才成長，且只長不縮', () => {
    const buffer = new CoordinateBuffer(4);
    for (let n = 0; n < 10; n += 1) buffer.push2(n, n);
    expect(buffer.growthCount.value).toBeGreaterThan(0);
    const capacity = buffer.capacity;
    buffer.reset();
    expect(buffer.capacity).toBe(capacity);
  });
});

describe('canvas 2D 的向量出口', () => {
  function fakeCtx() {
    const calls: string[] = [];
    return {
      calls,
      ctx: {
        clearRect: () => calls.push('clear'),
        beginPath: () => calls.push('begin'),
        moveTo: () => calls.push('move'),
        lineTo: () => calls.push('line'),
        closePath: () => calls.push('close'),
        stroke: () => calls.push('stroke'),
        setLineDash: () => {},
        strokeStyle: '',
        lineWidth: 1,
        lineJoin: 'round' as CanvasLineJoin,
        lineCap: 'round' as CanvasLineCap,
      },
    };
  }

  it('segment soup 只發一次 beginPath ＋ 一次 stroke（不是每段一次）', () => {
    const { calls, ctx } = fakeCtx();
    const sink = new CanvasPathSink({ width: 512, height: 512, getContext: () => ctx }, ctx);
    sink.beginFrame();
    sink.begin('gtv', { strokeRgba: [255, 0, 0, 1], lineWidthPx: 1.5 });
    sink.segments(Float32Array.from([0, 0, 1, 1, 2, 2, 3, 3]), 2);
    sink.end();
    const stats = sink.endFrame();
    expect(stats.segments).toBe(2);
    expect(calls.filter((c) => c === 'stroke')).toHaveLength(1);
    expect(calls.filter((c) => c === 'begin')).toHaveLength(1);
  });

  it('closed polyline 會 closePath（輪廓是閉合曲線）', () => {
    const { calls, ctx } = fakeCtx();
    const sink = new CanvasPathSink({ width: 512, height: 512, getContext: () => ctx }, ctx);
    sink.beginFrame();
    sink.begin('gtv', { strokeRgba: [255, 0, 0, 1], lineWidthPx: 1 });
    sink.polyline(Float32Array.from([0, 0, 1, 0, 1, 1]), 3, true);
    sink.end();
    expect(calls).toContain('close');
    expect(sink.endFrame().points).toBe(3);
  });

  it('每幀不配置新緩衝（緩衝區重用的違反偵測）', () => {
    const { ctx } = fakeCtx();
    const sink = new CanvasPathSink({ width: 512, height: 512, getContext: () => ctx }, ctx);
    for (let frame = 0; frame < 10; frame += 1) {
      sink.beginFrame();
      const scratch = sink.scratch();
      for (let n = 0; n < 100; n += 1) scratch.push2(n, n);
      sink.begin('gtv', { strokeRgba: [255, 0, 0, 1], lineWidthPx: 1 });
      sink.polyline(scratch.view(), scratch.pointCount, true);
      sink.end();
      const stats = sink.endFrame();
      if (frame > 3) expect(stats.bufferGrowths).toBe(0);
    }
  });
});

describe('量測', () => {
  const view: ViewReference = {
    frameOfReferenceUid: 'for.1',
    displayGridId: 'dg',
    planeOrigin: [0, 0, 0],
    viewPlaneNormal: [0, 0, 1],
    viewUp: [0, -1, 0],
    slabThicknessMm: 0,
    temporalGroupId: null,
    frameIndex: null,
  };

  function measurement(kind: Measurement['kind'], points: number[], vr: ViewReference | null): Measurement {
    return {
      measurementId: 'm1',
      kind,
      label: 'test',
      frameOfReferenceUid: 'for.1',
      points: Float64Array.from(points),
      viewReference: vr,
      provenance: {
        source: 'user-edit',
        parentHash: null,
        moduleVersion: 'test',
        viewReference: vr,
        createdAt: '',
      },
    };
  }

  it('距離是 3D 歐氏距離，與平面無關', () => {
    const m = measurement('distance', [-50, 60, 0, 50, 60, 0], null);
    expect(computeMeasurementValue(m)).toEqual({ value: 100, unit: 'mm' });
  });

  it('距離在斜面上也完整顯示（與平面無關的型別）', () => {
    const m = measurement('distance', [0, 0, 0, 0, 0, 10], null);
    expect(measurementDisplayMode(view, m)).toBe('full');
    expect(isMeasurementEditable(view, m)).toBe(true);
  });

  it('面積用 shoelace，且結果由 points 重算（不獨立儲存）', () => {
    // 平面上 10×10 的正方形
    const m = measurement('area', [0, 0, 0, 10, 0, 0, 10, 10, 0, 0, 10, 0], view);
    const result = computeMeasurementValue(m);
    expect(result.unit).toBe('mm2');
    expect(result.value).toBeCloseTo(100, 6);
  });

  it('共面才可編輯；平行不同層淡色顯示', () => {
    const m = measurement('area', [0, 0, 0, 10, 0, 0, 10, 10, 0], view);
    expect(measurementDisplayMode(view, m)).toBe('full');
    const otherSlice: ViewReference = { ...view, planeOrigin: [0, 0, 30] };
    expect(measurementDisplayMode(otherSlice, m)).toBe('faded');
    expect(isMeasurementEditable(otherSlice, m)).toBe(false);
  });

  it('相交（斜面）時只顯示交線，且不可編輯', () => {
    const m = measurement('area', [0, 0, 0, 10, 0, 0, 10, 10, 0], view);
    const oblique: ViewReference = {
      ...view,
      viewPlaneNormal: [0, 0.7071067811865476, 0.7071067811865476],
      viewUp: [0, 0.7071067811865476, -0.7071067811865476],
    };
    expect(measurementDisplayMode(oblique, m)).toBe('intersection-only');
    expect(isMeasurementEditable(oblique, m)).toBe(false);
  });

  it('體積 ROI 以 cc 回報', () => {
    const m = measurement('roi3d', [0, 0, 0, 10, 10, 10], null);
    expect(computeMeasurementValue(m)).toEqual({ value: 1, unit: 'cc' });
  });
});

describe('SVG 的 hit-test（mask 輪廓用不到的那一項）', () => {
  const handles: SvgHandle[] = [
    { id: 'p0', position: { x: 10, y: 10 }, kind: 'measurement-point', ownerId: 'm1', pointIndex: 0 },
    { id: 'p1', position: { x: 100, y: 100 }, kind: 'measurement-point', ownerId: 'm1', pointIndex: 1 },
  ];

  it('命中最近的控制點', () => {
    expect(hitTest(handles, { x: 12, y: 11 })?.id).toBe('p0');
    expect(hitTest(handles, { x: 98, y: 103 })?.id).toBe('p1');
  });

  it('超出命中半徑回傳 null', () => {
    expect(hitTest(handles, { x: 50, y: 50 })).toBeNull();
  });
});
