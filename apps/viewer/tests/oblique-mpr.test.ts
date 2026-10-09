/**
 * 斜面 MPR ＋ slab：平面像素↔世界的純數學、旋轉 handle、hit-test 優先序、
 * 三種 slab 輪廓語意在後端上真的走了不同的路。
 */

import { describe, expect, it } from 'vitest';

import {
  createGrid,
  createViewReference,
  primaryFrameGroupOf,
  type ViewReference,
} from '../src/core/geometry';
import { EventLayer, type InteractionCommand } from '../src/core/interaction/eventLayer';
import type { Layer } from '../src/core/layers/types';
import {
  planSlabOutline,
  SLAB_MULTI_PLANE_MAX_MM,
  SLAB_SEMANTICS_LABEL,
} from '../src/core/overlay/outlineOverlay';
import {
  dialAngleDeg,
  rotateHandles,
  rotationAxisOf,
  SvgOverlayHost,
  type SvgElementLike,
} from '../src/core/overlay/svgOverlayHost';
import { maskOutlineCpuBackend } from '../src/core/raster/cpuBackends';
import type { CpuContext, MaskOutlineArgs } from '../src/core/raster/types';
import {
  formatDeg,
  isObliqueTo,
  obliqueAngles,
  orthoCamera,
  planePxToWorld,
  rotateInPlane,
  worldToPlanePx,
} from '../src/core/scene/cameras';

const grid = createGrid({
  size: [128, 128, 40],
  spacing: [1.2, 1.2, 2.5],
  origin: [-76.2, -76.2, -48.75],
  direction: [1, 0, 0, 0, 1, 0, 0, 0, 1],
  frameOfReferenceUid: 'for.landmark',
});
const axial = orthoCamera({ grid, orientation: 'axial', displayGridId: 'dg' });

describe('平面像素 ↔ 世界（純函式，renderer 與測試共用）', () => {
  it('正交與斜面上都是精確的反函式；平面中心落在 ((w−1)/2, (h−1)/2)', () => {
    const size = { w: 300, h: 200 };
    for (const view of [axial, rotateInPlane(rotateInPlane(axial, 'up', 20), 'right', 12)]) {
      const c = worldToPlanePx(view, 0.7, size, view.planeOrigin);
      expect(c.x).toBeCloseTo(149.5, 9);
      expect(c.y).toBeCloseTo(99.5, 9);
      for (const px of [{ x: 10, y: 20 }, { x: 299, y: 0 }, { x: 150.25, y: 99.75 }]) {
        const world = planePxToWorld(view, 0.7, size, px);
        const back = worldToPlanePx(view, 0.7, size, world);
        expect(back.x).toBeCloseTo(px.x, 9);
        expect(back.y).toBeCloseTo(px.y, 9);
      }
    }
  });

  it('轉了多少：繞 up 20° → 水平 +20°、傾斜 0°；再繞 right 12° → 傾斜 +12°；總夾角單調；回正交是 0', () => {
    const a = obliqueAngles('axial', axial);
    expect(a).toEqual({ aroundUpDeg: 0, aroundRightDeg: 0, totalDeg: 0 });
    const up20 = obliqueAngles('axial', rotateInPlane(axial, 'up', 20));
    expect(up20.aroundUpDeg).toBeCloseTo(20, 1);
    expect(up20.aroundRightDeg).toBeCloseTo(0, 1);
    expect(up20.totalDeg).toBeCloseTo(20, 1);
    const both = obliqueAngles('axial', rotateInPlane(rotateInPlane(axial, 'up', 20), 'right', 12));
    expect(both.aroundRightDeg).toBeCloseTo(12, 1);
    expect(both.totalDeg).toBeGreaterThan(20);
    expect(formatDeg(12.34)).toBe('+12.3°');
    expect(formatDeg(-0.5)).toBe('−0.5°');
    expect(formatDeg(0.02)).toBe('0°');
  });

  it('isObliqueTo：正交視圖 false；轉 0.4° 仍算正交（容差），轉 5° 是斜面', () => {
    expect(isObliqueTo(grid, axial)).toBe(false);
    expect(isObliqueTo(grid, rotateInPlane(axial, 'up', 0.4))).toBe(false);
    expect(isObliqueTo(grid, rotateInPlane(axial, 'up', 5))).toBe(true);
    expect(isObliqueTo(grid, orthoCamera({ grid, orientation: 'sagittal', displayGridId: 'dg' }))).toBe(false);
  });
});

describe('旋轉 handle（svgOverlayHost）', () => {
  it('四個 handle 繞中心、半徑取短邊 38%；左右繞 up、上下繞 right；隱藏時沒有 handle', () => {
    const state = { center: { x: 100, y: 80 }, width: 400, height: 200, visible: true, oblique: false };
    const handles = rotateHandles('axial', state);
    expect(handles).toHaveLength(4);
    const r = 200 * 0.38;
    expect(handles.find((h) => h.id.endsWith(':rot:right'))!.position).toEqual({ x: 100 + r, y: 80 });
    expect(handles.find((h) => h.id.endsWith(':rot:up'))!.position).toEqual({ x: 100, y: 80 - r });
    expect(rotationAxisOf(handles[0]!)).toBe('up');
    expect(rotationAxisOf(handles.find((h) => h.id.endsWith(':rot:down'))!)).toBe('right');
    expect(rotateHandles('axial', { ...state, visible: false })).toEqual([]);
  });

  it('錶盤角度：逆時針為正、跨 ±180° 不跳、太靠近中心視為 0', () => {
    const c = { x: 0, y: 0 };
    expect(dialAngleDeg(c, { x: 100, y: 0 }, { x: 0, y: -100 })).toBeCloseTo(90, 9);
    expect(dialAngleDeg(c, { x: 100, y: 0 }, { x: 0, y: 100 })).toBeCloseTo(-90, 9);
    expect(dialAngleDeg(c, { x: -100, y: 1 }, { x: -100, y: -1 })).toBeCloseTo(-1.146, 2);
    expect(dialAngleDeg(c, { x: 3, y: 0 }, { x: 0, y: 3 })).toBe(0);
  });

  it('SvgOverlayHost：節點由 core 建立、update 後 handle 位置與 hit-test 一致、隱藏時不命中', () => {
    const created: { tag: string; attrs: Record<string, string>; children: unknown[] }[] = [];
    const make = (tag: string): SvgElementLike & { attrs: Record<string, string> } => {
      const node = {
        tag,
        attrs: {} as Record<string, string>,
        children: [] as unknown[],
        style: {} as Record<string, string>,
        setAttribute(name: string, value: string) {
          node.attrs[name] = value;
        },
        appendChild(child: SvgElementLike) {
          node.children.push(child);
          return child;
        },
        remove() {
          node.attrs['removed'] = 'true';
        },
      };
      created.push(node);
      return node;
    };
    const container = { appendChild: (child: never) => child };
    const host = new SvgOverlayHost('axial', container, { createElementNS: (_ns, tag) => make(tag) });
    // 兩個 <g>（量測層、十字線層）先建，十字線的節點掛在第二個 g 底下
    // 圈選預覽的 polyline 排在十字線節點之前
    // 2026-09-18：polyline（圈選）之後多一個 circle（筆刷／橡皮擦範圍預覽）
    expect(created.map((n) => n.tag)).toEqual(['svg', 'g', 'g', 'polyline', 'circle', 'line', 'line', 'circle', 'circle', 'circle', 'circle', 'text']);
    host.update({ center: { x: 50, y: 60 }, width: 200, height: 200, visible: true, oblique: true, label: 'Δ+3.2°  水平 +20.0° · 傾斜 0°' });
    expect(created[0]!.attrs['viewBox']).toBe('0 0 200 200');
    expect(created[0]!.attrs['data-oblique']).toBe('true');
    // 讀數放在十字線右上，文字就是傳進來的 label
    const text = created.find((n) => n.tag === 'text')!;
    expect(text.attrs['data-text']).toBe('Δ+3.2°  水平 +20.0° · 傾斜 0°');
    expect([text.attrs['x'], text.attrs['y']]).toEqual(['58', '52']);
    const right = host.currentHandles().find((h) => h.id.endsWith(':rot:right'))!;
    expect(host.hitTest({ x: right.position.x + 3, y: right.position.y - 2 })?.id).toBe(right.id);
    expect(host.hitTest({ x: 50, y: 60 })).toBeNull(); // 中心不是 handle
    host.update({ center: { x: 50, y: 60 }, width: 200, height: 200, visible: false, oblique: false });
    expect(host.hitTest({ x: right.position.x, y: right.position.y })).toBeNull();
    host.dispose();
    expect(created[0]!.attrs['removed']).toBe('true');
  });
});

describe('🔴 hit-test 優先於綁定表', () => {
  function layer(hit: boolean) {
    const commands: InteractionCommand[] = [];
    const events = new EventLayer({
      viewportId: 'axial',
      onCommand: (c) => commands.push(c),
      hitTest: () => (hit ? { id: 'axial:rot:right', kind: 'crosshair-rotate', ownerId: 'axial', position: { x: 0, y: 0 } } : null),
    });
    return { events, commands };
  }
  const down = (button: number) => ({ clientX: 10, clientY: 10, button, shiftKey: false, ctrlKey: false, altKey: false });

  it('左鍵按在 handle 上 → handle-drag，整段拖曳都帶著 handle，不會變成筆畫', () => {
    const { events, commands } = layer(true);
    events.pointerDown(down(0));
    events.pointerMove({ ...down(0), clientX: 20 });
    events.pointerUp({ ...down(0), clientX: 25 });
    expect(commands.map((c) => c.action)).toEqual(['handle-drag', 'handle-drag', 'handle-drag']);
    expect(commands.every((c) => c.handle?.kind === 'crosshair-rotate')).toBe(true);
  });

  it('沒命中 → 照綁定表（左鍵 = active-tool）；右鍵不問 hit-test（仍是 WW/WL）', () => {
    const miss = layer(false);
    miss.events.pointerDown(down(0));
    expect(miss.commands[0]!.action).toBe('active-tool');
    expect(miss.commands[0]!.handle).toBeUndefined();
    const right = layer(true);
    right.events.pointerDown(down(2));
    expect(right.commands[0]!.action).toBe('window-level');
  });
});

describe('三種 slab 輪廓語意', () => {
  it('planSlabOutline：> 10 mm 的 B／C 降級回 A 並說出原因；角落文字依語意', () => {
    expect(SLAB_MULTI_PLANE_MAX_MM).toBe(10);
    const tooThick = planSlabOutline({ slabThicknessMm: 12, quality: 'final', semantics: 'union-outer' });
    expect(tooThick.semantics).toBe('center');
    expect(tooThick.notice).toContain('降級');
    expect(planSlabOutline({ slabThicknessMm: 5, quality: 'final', semantics: 'union-outer' }).notice).toBe(
      SLAB_SEMANTICS_LABEL['union-outer'],
    );
    expect(planSlabOutline({ slabThicknessMm: 5, quality: 'final', semantics: 'stacked' }).samplePlanes).toBe(6);
    expect(planSlabOutline({ slabThicknessMm: 0, quality: 'final', semantics: 'stacked' }).notice).toBeNull();
  });

  function ctxWith(semantics: string | undefined, slab: number, quality: 'final' | 'interactive') {
    const calls: MaskOutlineArgs[] = [];
    const paths: { id: string; alpha: number }[] = [];
    const notices: string[] = [];
    const view: ViewReference = createViewReference({ ...axial, slabThicknessMm: slab });
    const ctx: CpuContext = {
      viewportId: 'axial',
      gridSet: null as never,
      frameGroup: () => primaryFrameGroupOf('for.landmark', 's'),
      temporal: () => null as never,
      camera: view,
      ...(semantics ? { viewportParams: { slabOutlineSemantics: semantics } } : {}),
      viewportSize: { w: 4, h: 4 },
      pxMm: 1,
      quality,
      project: () => ({ x: 0, y: 0 }),
      voxels: () => ({ voxels: new Uint8Array(64), grid: grid, volumeKey: 'm' }),
      notice: (t) => notices.push(t),
      resampler: {
        abiVersion: 1,
        reslicePlane: () => new Float32Array(16),
        windowToU8: () => new Uint8Array(16),
        marchingSquares: () => new Float32Array(0),
        stitch: () => [],
        maskOutline: (args) => {
          calls.push(args);
          return new Float32Array([0, 0, 1, 1]);
        },
        dispose: () => {},
      },
      target: { width: 4, height: 4, data: new Uint8ClampedArray(64) } as unknown as ImageData,
      workers: null,
      paths: {
        begin: (id, style) => paths.push({ id, alpha: style.strokeRgba[3] }),
        polyline: () => {},
        segments: () => {},
        end: () => {},
      },
      svgRoot: null,
    };
    return { ctx, calls, paths, notices };
  }
  const mask: Layer = {
    layerId: 'mask:gtv', kind: 'mask', label: 'GTV', groupId: null, frameOfReferenceUid: 'for.landmark',
    contentRef: 'gtv', visible: true, opacity: 0.8, order: 0,
  };

  it('A（預設）：一次取樣、center；沒有 viewportParams 也能跑', () => {
    const { ctx, calls, paths } = ctxWith(undefined, 5, 'final');
    maskOutlineCpuBackend.draw(ctx, mask, undefined);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.blend ?? 'center').toBe('center');
    expect(paths).toEqual([{ id: 'mask:gtv', alpha: 0.8 }]);
  });

  it('🔴 B：mip ＋ slabSamples，一次 marching squares（聯集不需要多邊形布林）', () => {
    const { ctx, calls, notices } = ctxWith('union-outer', 5, 'final');
    maskOutlineCpuBackend.draw(ctx, mask, undefined);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.blend).toBe('mip');
    expect(calls[0]!.slabSamples).toBe(6);
    expect(notices).toEqual([SLAB_SEMANTICS_LABEL['union-outer']]);
  });

  it('C：N 個偏移平面各描一條，離中心越遠越淡，都是 slab 0 的中心面取樣', () => {
    const { ctx, calls, paths } = ctxWith('stacked', 4, 'final');
    maskOutlineCpuBackend.draw(ctx, mask, undefined);
    expect(calls).toHaveLength(5);
    const offsets = calls.map((c) => +(c.view.planeOrigin[2] - axial.planeOrigin[2]).toFixed(6));
    expect(offsets).toEqual([2, 1, 0, -1, -2]); // 軸向法線是 −z
    expect(calls.every((c) => c.view.slabThicknessMm === 0 && (c.blend ?? 'center') === 'center')).toBe(true);
    expect(paths.map((p) => +p.alpha.toFixed(3))).toEqual([0.32, 0.56, 0.8, 0.56, 0.32]);
  });

  it('🔴 互動中 B／C 一律退回 A（一次取樣），並在角落說明', () => {
    for (const semantics of ['union-outer', 'stacked']) {
      const { ctx, calls, notices } = ctxWith(semantics, 5, 'interactive');
      maskOutlineCpuBackend.draw(ctx, mask, undefined);
      expect(calls).toHaveLength(1);
      expect(calls[0]!.blend ?? 'center').toBe('center');
      expect(notices[0]).toContain('互動中');
    }
  });
});
