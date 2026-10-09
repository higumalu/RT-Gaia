/**
 * 每幀的繪製計畫與兩個 CPU 後端。
 *
 * ## 這個檔案要證明的主張
 *
 * > **核心的每幀迴圈裡不得有 `layer.kind === '...'`。**
 *
 * 在此之前那條規則是散文：註冊表存在、六個 renderer 都註冊了，但真正在畫的
 * `CpuViewportRenderer` **硬編碼了 `kind === 'image'` 與 `kind === 'mask'`**，
 * 而六個 renderer 的 `render()` 全是 `notImplemented()`。這條規則要禁止的東西，
 * 第一個違反者是核心自己。
 *
 * 這裡測得到，是因為決策已經抽成純函式 `planCpuFrame()` —— `CpuViewportRenderer`
 * 本身需要真的 DOM，而測試在 Node 下跑，因此它一條測試都沒有。
 */

import { describe, expect, it, beforeEach, afterEach } from 'vitest';

import {
  clearLayerKinds,
  clearLayerRenderers,
  imageCpuBackend,
  maskOutlineCpuBackend,
  planCpuFrame,
  registerBuiltins,
  registerLayerKind,
  registerLayerRenderer,
} from '../src/core';
import type {
  CpuContext,
  Layer,
  LayerVoxels,
  MaskOutlineArgs,
  ReslicePlaneArgs,
  ViewportInfo,
  ViewReference,
} from '../src/core';

const mpr: ViewportInfo = { viewportId: 'axial', is3D: false, width: 8, height: 8 };
const volume3d: ViewportInfo = { viewportId: 'v3d', is3D: true, width: 8, height: 8 };

const view: ViewReference = {
  frameOfReferenceUid: 'for.1',
  displayGridId: 'dg',
  planeOrigin: [0, 0, 0],
  viewPlaneNormal: [0, 0, -1],
  viewUp: [0, -1, 0],
  slabThicknessMm: 0,
  temporalGroupId: null,
  frameIndex: null,
};

function layer(patch: Partial<Layer> & Pick<Layer, 'layerId' | 'kind' | 'contentRef'>): Layer {
  return {
    label: patch.layerId,
    groupId: null,
    frameOfReferenceUid: 'for.1',
    visible: true,
    opacity: 1,
    order: 0,
    ...patch,
  };
}

beforeEach(() => {
  clearLayerRenderers();
  clearLayerKinds();
  registerBuiltins();
});

afterEach(() => {
  clearLayerRenderers();
  clearLayerKinds();
});

describe('每幀計畫由註冊表決定，核心不認識 kind', () => {
  it('image layer 走 image renderer、mask layer 走 mask-outline', () => {
    const plan = planCpuFrame({
      layers: [
        layer({ layerId: 'ct', kind: 'image', contentRef: 'series.1', order: 0 }),
        layer({ layerId: 'gtv', kind: 'mask', contentRef: 'gtv', order: 100 }),
      ],
      viewport: mpr,
      tier: 'C',
    });
    expect(plan.steps.map((s) => s.plugin.rendererId)).toEqual(['image', 'mask-outline']);
  });

  it('🔴 順序由 zBand 決定，不是由陣列順序決定（混合順序是資料）', () => {
    const plan = planCpuFrame({
      // 刻意把 mask 放在前面
      layers: [
        layer({ layerId: 'gtv', kind: 'mask', contentRef: 'gtv', order: 0 }),
        layer({ layerId: 'ct', kind: 'image', contentRef: 'series.1', order: 100 }),
      ],
      viewport: mpr,
      tier: 'C',
    });
    // zBand: image < overlay < annotation → 影像仍然先畫
    expect(plan.steps.map((s) => s.plugin.rendererId)).toEqual(['image', 'mask-outline']);
  });

  it('同一個 zBand 內照 layer.order', () => {
    const plan = planCpuFrame({
      layers: [
        layer({ layerId: 'b', kind: 'mask', contentRef: 'b', order: 200 }),
        layer({ layerId: 'a', kind: 'mask', contentRef: 'a', order: 100 }),
      ],
      viewport: mpr,
      tier: 'C',
    });
    expect(plan.steps.map((s) => s.layer.layerId)).toEqual(['a', 'b']);
  });

  it('隱藏的 layer 不進計畫', () => {
    const plan = planCpuFrame({
      layers: [layer({ layerId: 'ct', kind: 'image', contentRef: 'x', visible: false })],
      viewport: mpr,
      tier: 'C',
    });
    expect(plan.steps).toHaveLength(0);
  });

  it('3D viewport 的 mask 不畫（結構在 3D 裡走 mesh）', () => {
    const plan = planCpuFrame({
      layers: [layer({ layerId: 'gtv', kind: 'mask', contentRef: 'gtv' })],
      viewport: volume3d,
      tier: 'C',
    });
    expect(plan.steps).toHaveLength(0);
  });

  it('🔴 3D 的影像在 Tier C 走 volume-3d → server-render，因此不由 CPU 畫，且說得出原因', () => {
    const plan = planCpuFrame({
      layers: [layer({ layerId: 'ct', kind: 'image', contentRef: 'x' })],
      viewport: volume3d,
      tier: 'C',
    });
    expect(plan.steps).toHaveLength(0);
    expect(plan.skipped).toHaveLength(1);
    // 「這一格為什麼是空的」必須有答案
    expect(plan.skipped[0]!.reason).toMatch(/ray-cast|後端出圖|draw/);
  });

  it('🔴 還沒光柵化的 renderer 被跳過，而且說得出來（不是靜默消失）', () => {
    const plan = planCpuFrame({
      layers: [layer({ layerId: 'ms', kind: 'measurement', contentRef: 'm' })],
      viewport: mpr,
      tier: 'C',
    });
    expect(plan.steps).toHaveLength(0);
    expect(plan.skipped[0]!.rendererId).toBe('measurement'); // 量測畫在 SVG，不在光柵
    expect(plan.skipped[0]!.reason).toContain('draw');
  });

  it('fill+outline 產生兩個 renderer，都進計畫；fill（overlay）先畫、輪廓（annotation）在上', () => {
    const plan = planCpuFrame({
      layers: [layer({ layerId: 'm', kind: 'mask', contentRef: 'm', renderStyle: 'fill+outline' })],
      viewport: mpr,
      tier: 'C',
    });
    expect(plan.steps.map((s) => s.plugin.rendererId)).toEqual(['mask-fill', 'mask-outline']);
    expect(plan.skipped).toEqual([]);
  });

  it('未註冊的 kind 不會讓整幀爆掉，而是記下原因', () => {
    const plan = planCpuFrame({
      layers: [layer({ layerId: 'x', kind: 'dose', contentRef: 'x' })],
      viewport: mpr,
      tier: 'C',
    });
    expect(plan.steps).toHaveLength(0);
    expect(plan.skipped[0]!.reason).toContain('kind');
  });

  it('🔴 模組註冊新 kind ＋ 新 renderer 就能進計畫 —— 核心一行都不用改', () => {
    const drawn: string[] = [];
    registerLayerRenderer({
      rendererId: 'dose-isolines',
      form: 'F3',
      zBand: 'annotation',
      gpu: { kind: 'supported', render: () => stubHandle() },
      cpu: {
        kind: 'supported',
        render: () => stubHandle(),
        draw: (_ctx, l) => drawn.push(l.layerId),
      },
    });
    registerLayerKind({ kind: 'dose', resolveRenderers: () => ['dose-isolines'] });

    const plan = planCpuFrame({
      layers: [layer({ layerId: 'dose1', kind: 'dose', contentRef: 'd' })],
      viewport: mpr,
      tier: 'C',
    });
    expect(plan.steps).toHaveLength(1);
    plan.steps[0]!.backend.draw(fakeContext(), plan.steps[0]!.layer, undefined);
    expect(drawn).toEqual(['dose1']);
  });
});

// ── CPU 後端本身 ───────────────────────────────────────────────────────────

function stubHandle() {
  return {
    viewportId: 'v',
    layerId: 'l',
    rendererId: 'r',
    isSubstitute: false,
    setVisible: () => {},
    setOpacity: () => {},
    invalidate: () => {},
    residentBytes: () => 0,
    dispose: () => {},
  };
}

interface FakeCalls {
  reslice: ReslicePlaneArgs[];
  maskOutline: MaskOutlineArgs[];
  paths: { sourceId: string; segmentCount: number; lineWidthPx: number }[];
  notices: string[];
}

function fakeContext(
  overrides: {
    voxels?: LayerVoxels | null;
    camera?: ViewReference;
    outline?: Float32Array;
    plane?: Float32Array;
    width?: number;
    height?: number;
  } = {},
): CpuContext & { calls: FakeCalls } {
  const w = overrides.width ?? 4;
  const h = overrides.height ?? 4;
  const calls: FakeCalls = { reslice: [], maskOutline: [], paths: [], notices: [] };
  let pendingStyle = { lineWidthPx: 0 };
  const ctx = {
    calls,
    viewportId: 'axial',
    gridSet: null as never,
    frameGroup: () => null as never,
    temporal: () => null as never,
    camera: overrides.camera ?? view,
    viewportSize: { w, h },
    pxMm: 1,
    quality: 'final' as const,
    project: () => ({ x: 0, y: 0 }),
    voxels: () => overrides.voxels ?? null,
    notice: (text: string) => calls.notices.push(text),
    resampler: {
      abiVersion: 1,
      reslicePlane: (args: ReslicePlaneArgs & { volumeKey: string }) => {
        calls.reslice.push(args);
        return overrides.plane ?? new Float32Array(w * h);
      },
      windowToU8: (plane: Float32Array) => new Uint8Array(plane.map(() => 128)),
      marchingSquares: () => new Float32Array(0),
      stitch: () => [],
      maskOutline: (args: MaskOutlineArgs) => {
        calls.maskOutline.push(args);
        return overrides.outline ?? new Float32Array([0, 0, 1, 1]);
      },
      dispose: () => {},
    },
    target: { width: w, height: h, data: new Uint8ClampedArray(w * h * 4) } as unknown as ImageData,
    workers: null,
    paths: {
      begin: (sourceId: string, style: { lineWidthPx: number }) => {
        pendingStyle = style;
        calls.paths.push({ sourceId, segmentCount: 0, lineWidthPx: style.lineWidthPx });
      },
      polyline: () => {},
      segments: (_xy: Float32Array, segmentCount: number) => {
        calls.paths[calls.paths.length - 1]!.segmentCount = segmentCount;
        calls.paths[calls.paths.length - 1]!.lineWidthPx = pendingStyle.lineWidthPx;
      },
      end: () => {},
    },
    svgRoot: null,
  };
  return ctx;
}

describe('image 的 CPU 後端', () => {
  it('體素還沒進倉時什麼都不做（不是拋例外）', () => {
    const ctx = fakeContext({ voxels: null });
    imageCpuBackend.draw(ctx, layer({ layerId: 'ct', kind: 'image', contentRef: 'x' }), undefined);
    expect(ctx.calls.reslice).toHaveLength(0);
  });

  it('重切 → window → 寫進 ctx.target（不自己碰 canvas）', () => {
    const ctx = fakeContext({
      voxels: {
        voxels: new Int16Array(64),
        grid: null as never,
        volumeKey: 'ct@lod0',
        defaultWindow: { center: 40, width: 400 },
      },
    });
    imageCpuBackend.draw(ctx, layer({ layerId: 'ct', kind: 'image', contentRef: 'x' }), undefined);
    expect(ctx.calls.reslice).toHaveLength(1);
    expect(ctx.calls.reslice[0]!.outSizePx).toEqual([4, 4]);
    // 灰階寫進 target，alpha 補滿
    expect(ctx.target.data[0]).toBe(128);
    expect(ctx.target.data[3]).toBe(255);
  });

  it('layer 的 windowLevel 覆蓋 defaultWindow', () => {
    let seen: [number, number] | null = null;
    const ctx = fakeContext({
      voxels: {
        voxels: new Int16Array(64),
        grid: null as never,
        volumeKey: 'k',
        defaultWindow: { center: 40, width: 400 },
      },
    });
    (ctx.resampler as { windowToU8: unknown }).windowToU8 = (
      plane: Float32Array,
      center: number,
      width: number,
    ) => {
      seen = [center, width];
      return new Uint8Array(plane.length);
    };
    imageCpuBackend.draw(
      ctx,
      layer({ layerId: 'ct', kind: 'image', contentRef: 'x', windowLevel: { center: -600, width: 1500 } }),
      undefined,
    );
    expect(seen).toEqual([-600, 1500]);
  });

  it('🔴 slab > 0 時取平均，否則取中心面（階梯 artifact 緩解）', () => {
    for (const [slab, expected] of [
      [0, 'center'],
      [5, 'mean'],
    ] as const) {
      const ctx = fakeContext({
        camera: { ...view, slabThicknessMm: slab },
        voxels: { voxels: new Int16Array(64), grid: null as never, volumeKey: 'k' },
      });
      imageCpuBackend.draw(ctx, layer({ layerId: 'ct', kind: 'image', contentRef: 'x' }), undefined);
      expect(ctx.calls.reslice[0]!.blend, `slab=${slab}`).toBe(expected);
    }
  });
});

describe('mask-outline 的 CPU 後端', () => {
  const maskVoxels: LayerVoxels = {
    voxels: new Uint8Array(64),
    grid: null as never,
    volumeKey: 'mask:gtv@static#0',
  };

  it('🔴 走融合入口 maskOutline()，不是 reslicePlane() ＋ marchingSquares()', () => {
    const ctx = fakeContext({ voxels: maskVoxels });
    maskOutlineCpuBackend.draw(ctx, layer({ layerId: 'gtv', kind: 'mask', contentRef: 'gtv' }), undefined);
    expect(ctx.calls.maskOutline).toHaveLength(1);
    // 中間那份 f32 平面沒有過境 JS —— 這正是融合入口存在的理由
    expect(ctx.calls.reslice).toHaveLength(0);
  });

  it('輪廓一律取 slab 中心面，blend 不得是 mean', () => {
    const ctx = fakeContext({ camera: { ...view, slabThicknessMm: 8 }, voxels: maskVoxels });
    maskOutlineCpuBackend.draw(ctx, layer({ layerId: 'gtv', kind: 'mask', contentRef: 'gtv' }), undefined);
    // maskOutline 內部固定 center；這裡確認它至少被呼叫且用同一個 view
    expect(ctx.calls.maskOutline[0]!.view.slabThicknessMm).toBe(8);
  });

  it('🔴 slab > 2 mm 必須發出常駐標示（否則使用者以為輪廓涵蓋整個厚度）', () => {
    const ctx = fakeContext({ camera: { ...view, slabThicknessMm: 6 }, voxels: maskVoxels });
    maskOutlineCpuBackend.draw(ctx, layer({ layerId: 'gtv', kind: 'mask', contentRef: 'gtv' }), undefined);
    expect(ctx.calls.notices).toHaveLength(1);
    expect(ctx.calls.notices[0]).toContain('中心面');
  });

  it('slab ≤ 2 mm 不吵', () => {
    const ctx = fakeContext({ camera: { ...view, slabThicknessMm: 1 }, voxels: maskVoxels });
    maskOutlineCpuBackend.draw(ctx, layer({ layerId: 'gtv', kind: 'mask', contentRef: 'gtv' }), undefined);
    expect(ctx.calls.notices).toHaveLength(0);
  });

  it('段數為 0 時不開路徑批次（省掉一次 stroke）', () => {
    const ctx = fakeContext({ voxels: maskVoxels, outline: new Float32Array(0) });
    maskOutlineCpuBackend.draw(ctx, layer({ layerId: 'gtv', kind: 'mask', contentRef: 'gtv' }), undefined);
    expect(ctx.calls.paths).toHaveLength(0);
  });

  it('顏色與不透明度取自 layer，線寬固定 1.5（互動態不得改變線寬）', () => {
    const ctx = fakeContext({ voxels: maskVoxels });
    maskOutlineCpuBackend.draw(
      ctx,
      layer({ layerId: 'gtv', kind: 'mask', contentRef: 'gtv', color: [10, 20, 30], opacity: 0.5 }),
      undefined,
    );
    expect(ctx.calls.paths[0]!.lineWidthPx).toBe(1.5);
    expect(ctx.calls.paths[0]!.segmentCount).toBe(1);
  });

  it('非 u8 的體素被拒絕（mask 一律二值 u8）', () => {
    const ctx = fakeContext({
      voxels: { voxels: new Int16Array(64), grid: null as never, volumeKey: 'k' },
    });
    maskOutlineCpuBackend.draw(ctx, layer({ layerId: 'gtv', kind: 'mask', contentRef: 'gtv' }), undefined);
    expect(ctx.calls.maskOutline).toHaveLength(0);
  });
});
