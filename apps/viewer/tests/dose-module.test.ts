/**
 * 劑量模組：第一個「非核心」kind，走與第三方模組相同的註冊路徑。
 *
 * 用 frame-plan.test 同款的假 `CpuContext`：不需要 DOM 與 WASM。
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { primaryFrameGroupOf, rowsToMat16ColumnMajor, type ViewReference } from '../src/core/geometry';
import type { Layer } from '../src/core/layers/types';
import { registerBuiltins } from '../src/core/raster/builtins';
import { registerBuiltinColormaps } from '../src/core/raster/colormaps';
import { imageCpuBackend } from '../src/core/raster/cpuBackends';
import {
  DEFAULT_ISODOSE_PERCENTS,
  doseColorwashCpuBackend,
  doseDisplayOf,
  doseIsolinesCpuBackend,
  isolineField,
  registerDoseModule,
} from '../src/core/raster/doseModule';
import { planCpuFrame } from '../src/core/raster/framePlan';
import { clearLayerKinds, resolveRenderers } from '../src/core/raster/kinds';
import { clearLayerRenderers, getLayerRenderer, listLayerRenderers } from '../src/core/raster/registry';
import type { CpuContext, MaskOutlineArgs, ReslicePlaneArgs, ViewportInfo } from '../src/core/raster/types';
import { registerVoxelStorage, VolumeStore } from '../src/core/scene/volumeStore';

const mpr: ViewportInfo = { viewportId: 'axial', is3D: false, width: 4, height: 4 };
const view: ViewReference = {
  frameOfReferenceUid: 'for.p',
  displayGridId: 'dg',
  planeOrigin: [0, 0, 0],
  viewPlaneNormal: [0, 0, -1],
  viewUp: [0, -1, 0],
  slabThicknessMm: 0,
  temporalGroupId: null,
  frameIndex: null,
};

function layer(partial: Partial<Layer> & { layerId: string; kind: string; contentRef: string }): Layer {
  return {
    label: partial.layerId,
    groupId: null,
    frameOfReferenceUid: 'for.p',
    visible: true,
    opacity: 1,
    order: 0,
    ...partial,
  };
}

interface Calls {
  reslice: (ReslicePlaneArgs & { volumeKey: string })[];
  marching: number[];
  paths: { sourceId: string; segmentCount: number; rgba: number[] }[];
}

function fakeContext(overrides: {
  voxels?: { voxels: Int16Array | Float32Array | Uint8Array; grid: never; volumeKey: string } | null;
  plane?: Float32Array;
  frameGroup?: CpuContext['frameGroup'];
  camera?: ViewReference;
} = {}): CpuContext & { calls: Calls } {
  const calls: Calls = { reslice: [], marching: [], paths: [] };
  let style: { strokeRgba: number[] } = { strokeRgba: [] };
  return {
    calls,
    viewportId: 'axial',
    gridSet: null as never,
    frameGroup: overrides.frameGroup ?? (() => primaryFrameGroupOf('for.p', 's')),
    temporal: () => null as never,
    camera: overrides.camera ?? view,
    viewportSize: { w: 2, h: 2 },
    pxMm: 1,
    quality: 'final',
    project: () => ({ x: 0, y: 0 }),
    voxels: () => overrides.voxels ?? null,
    notice: () => {},
    resampler: {
      abiVersion: 1,
      reslicePlane: (args) => {
        calls.reslice.push(args);
        return overrides.plane ?? new Float32Array([0, 10, 30, Number.NaN]);
      },
      windowToU8: (plane: Float32Array) => new Uint8Array(plane.map(() => 128)),
      marchingSquares: (_f, _w, _h, level) => {
        calls.marching.push(level);
        return level > 25 ? new Float32Array(0) : new Float32Array([0, 0, 1, 1]);
      },
      stitch: () => [],
      maskOutline: (_a: MaskOutlineArgs) => new Float32Array(0),
      dispose: () => {},
    },
    target: { width: 2, height: 2, data: new Uint8ClampedArray(16) } as unknown as ImageData,
    workers: null,
    paths: {
      begin: (sourceId, s) => {
        style = s;
        calls.paths.push({ sourceId, segmentCount: 0, rgba: s.strokeRgba });
      },
      polyline: () => {},
      segments: (_xy, n) => {
        calls.paths[calls.paths.length - 1]!.segmentCount = n;
        calls.paths[calls.paths.length - 1]!.rgba = style.strokeRgba;
      },
      end: () => {},
    },
    svgRoot: null,
  };
}

const doseVoxels = { voxels: new Float32Array(8), grid: null as never, volumeKey: 'dose@lod0' };

beforeEach(() => {
  clearLayerRenderers();
  clearLayerKinds();
  registerBuiltins();
  registerBuiltinColormaps();
  registerDoseModule();
});
afterEach(() => {
  clearLayerRenderers();
  clearLayerKinds();
});

describe('註冊：劑量是模組，不是核心的 kind', () => {
  it('兩個 renderer 進註冊表，型態與 zBand 正確；重複註冊冪等', () => {
    expect(listLayerRenderers().map((p) => p.rendererId)).toEqual(
      expect.arrayContaining(['dose-colorwash', 'dose-isolines']),
    );
    expect(getLayerRenderer('dose-colorwash')).toMatchObject({ form: 'F1', zBand: 'overlay' });
    expect(getLayerRenderer('dose-isolines')).toMatchObject({ form: 'F3', zBand: 'annotation' });
    expect(() => registerDoseModule()).not.toThrow();
    expect(listLayerRenderers()).toHaveLength(8);
  });

  it('kind=dose 依 params 決定開哪些 renderer；3D 不畫', () => {
    const d = layer({ layerId: 'd', kind: 'dose', contentRef: 'd' });
    expect(resolveRenderers(d, mpr)).toEqual(['dose-colorwash', 'dose-isolines']);
    expect(resolveRenderers({ ...d, params: { colorwash: false } }, mpr)).toEqual(['dose-isolines']);
    expect(resolveRenderers({ ...d, params: { isolines: false } }, mpr)).toEqual(['dose-colorwash']);
    expect(resolveRenderers(d, { ...mpr, is3D: true })).toEqual([]);
  });

  it('🔴 每幀計畫的順序：image < dose-colorwash（overlay）< mask-outline／dose-isolines（annotation）', () => {
    const plan = planCpuFrame({
      layers: [
        layer({ layerId: 'm', kind: 'mask', contentRef: 'm', order: 100 }),
        layer({ layerId: 'd', kind: 'dose', contentRef: 'd', order: 50 }),
        layer({ layerId: 'i', kind: 'image', contentRef: 'i', order: 0 }),
      ],
      viewport: mpr,
      tier: 'C',
    });
    expect(plan.steps.map((s) => s.plugin.rendererId)).toEqual([
      'image',
      'dose-colorwash',
      'dose-isolines',
      'mask-outline',
    ]);
    expect(plan.skipped).toEqual([]);
  });

  it('體素倉：dose 登記成 volume 儲存 → forLayer 走 image 那個倉（float32）', () => {
    registerVoxelStorage('dose', 'volume');
    const store = new VolumeStore();
    store.putImage({
      seriesId: 'd1',
      lod: 0,
      grid: null as never,
      voxels: new Float32Array([1.5, 2.5]),
      defaultWindow: { center: 1, width: 2 },
    });
    const got = store.forLayer(layer({ layerId: 'd', kind: 'dose', contentRef: 'd1' }));
    expect(got?.voxels).toBeInstanceOf(Float32Array);
    expect(got?.volumeKey).toBe('d1@lod0');
    expect(store.forLayer(layer({ layerId: 'x', kind: 'unknown-kind', contentRef: 'd1' }))).toBeNull();
  });
});

describe('doseDisplayOf：所有預設值都在一個地方', () => {
  it('處方 → 參考劑量；預設等劑量線是處方的 %，換成 Gy 由高到低；閾值 10%', () => {
    const d = doseDisplayOf(layer({ layerId: 'd', kind: 'dose', contentRef: 'd', params: { max_gy: 52.5, prescription_gy: [50] } }));
    expect(d.referenceGy).toBe(50);
    expect(d.display).toBe('absolute');
    expect(d.levelsGy).toEqual([...DEFAULT_ISODOSE_PERCENTS].map((p) => (50 * p) / 100));
    expect(d.thresholdGy).toBe(5);
    expect(d.scaleMaxGy).toBe(52.5);
    expect(d.colormap).toBe('jet');
  });

  it('沒有處方就以 max 為參考；absolute 模式下自訂 levels 直接是 Gy；percent 模式是 % 參考', () => {
    const noRx = doseDisplayOf(layer({ layerId: 'd', kind: 'dose', contentRef: 'd', params: { max_gy: 2.2 } }));
    expect(noRx.referenceGy).toBe(2.2);
    const abs = doseDisplayOf(
      layer({ layerId: 'd', kind: 'dose', contentRef: 'd', params: { max_gy: 60, prescription_gy: [50], levels: [45, 20] } }),
    );
    expect(abs.levelsGy).toEqual([45, 20]);
    const pct = doseDisplayOf(
      layer({
        layerId: 'd',
        kind: 'dose',
        contentRef: 'd',
        params: { max_gy: 60, prescription_gy: [50], display: 'percent', levels: [100, 50] },
      }),
    );
    expect(pct.levelsGy).toEqual([50, 25]);
    expect(pct.scaleMaxGy).toBeCloseTo(55);
  });

  it('非 Gy 的劑量（dose_scale ≠ gy）預設 percent；使用者明確選 absolute 仍照選', () => {
    const rel = doseDisplayOf(layer({ layerId: 'd', kind: 'dose', contentRef: 'd', params: { max_gy: 100, units: 'RELATIVE', dose_scale: 'relative' } }));
    expect(rel.display).toBe('percent');
    const forced = doseDisplayOf(
      layer({ layerId: 'd', kind: 'dose', contentRef: 'd', params: { max_gy: 100, dose_scale: 'relative', display: 'absolute' } }),
    );
    expect(forced.display).toBe('absolute');
    const gy = doseDisplayOf(layer({ layerId: 'd', kind: 'dose', contentRef: 'd', params: { max_gy: 50, units: 'GY', dose_scale: 'gy' } }));
    expect(gy.display).toBe('absolute');
  });
});

describe('dose-colorwash 的 CPU 後端', () => {
  it('只吃 float32；體素未進倉或 int16 時不重切', () => {
    const none = fakeContext({ voxels: null });
    doseColorwashCpuBackend.draw(none, layer({ layerId: 'd', kind: 'dose', contentRef: 'd' }), undefined);
    expect(none.calls.reslice).toHaveLength(0);
    const wrong = fakeContext({ voxels: { voxels: new Int16Array(8), grid: null as never, volumeKey: 'k' } });
    doseColorwashCpuBackend.draw(wrong, layer({ layerId: 'd', kind: 'dose', contentRef: 'd' }), undefined);
    expect(wrong.calls.reslice).toHaveLength(0);
  });

  it('🔴 低於閾值透明、NaN（volume 外）透明、其餘依色階上色、alpha ＝ opacity；slab 用 mip', () => {
    const ctx = fakeContext({
      voxels: doseVoxels,
      plane: new Float32Array([0, 10, 30, Number.NaN]),
      camera: { ...view, slabThicknessMm: 4 },
    });
    doseColorwashCpuBackend.draw(
      ctx,
      layer({ layerId: 'd', kind: 'dose', contentRef: 'd', opacity: 0.6, params: { max_gy: 40, threshold_gy: 5 } }),
      undefined,
    );
    expect(ctx.calls.reslice[0]!.blend).toBe('mip');
    expect(Number.isNaN(ctx.calls.reslice[0]!.outside)).toBe(true);
    const a = ctx.target.data;
    expect(a[3]).toBe(0); // 0 Gy < 5 Gy 閾值
    expect(a[7]).toBe(153); // 10 Gy：alpha = 0.6
    expect(a[11]).toBe(153); // 30 Gy
    expect(a[15]).toBe(0); // NaN：volume 外
    // 30 Gy（0.75）在 jet 上偏紅、10 Gy（0.25）偏藍
    expect(a[8]).toBeGreaterThan(a[10]!);
    expect(a[6]).toBeGreaterThan(a[4]!);
  });

  it('params.colorwash=false 時不畫（但 kind 仍在，isolines 照畫）', () => {
    const ctx = fakeContext({ voxels: doseVoxels });
    doseColorwashCpuBackend.draw(
      ctx,
      layer({ layerId: 'd', kind: 'dose', contentRef: 'd', params: { max_gy: 40, colorwash: false } }),
      undefined,
    );
    expect(ctx.calls.reslice).toHaveLength(0);
  });
});

describe('dose-isolines 的 CPU 後端', () => {
  it('🔴 volume 外的 NaN 先換成 0 Gy 再進 marching squares（NaN 角點會畫出貫穿整格的直線）', () => {
    expect([...isolineField(new Float32Array([1, Number.NaN, 3]))]).toEqual([1, 0, 3]);
    const clean = new Float32Array([1, 2]);
    expect(isolineField(clean)).toBe(clean);
    const seen: Float32Array[] = [];
    const ctx = fakeContext({ voxels: doseVoxels, plane: new Float32Array([5, Number.NaN, 30, 40]) });
    (ctx.resampler as { marchingSquares: unknown }).marchingSquares = (f: Float32Array) => {
      seen.push(f);
      return new Float32Array(0);
    };
    doseIsolinesCpuBackend.draw(ctx, layer({ layerId: 'd', kind: 'dose', contentRef: 'd', params: { max_gy: 40, levels: [10] } }), undefined);
    expect(seen).toHaveLength(1);
    expect([...seen[0]!]).toEqual([5, 0, 30, 40]);
  });

  it('同一張平面逐 level 跑 marching squares，有段才開路徑批次，顏色取自色階', () => {
    const ctx = fakeContext({ voxels: doseVoxels });
    doseIsolinesCpuBackend.draw(
      ctx,
      layer({ layerId: 'd', kind: 'dose', contentRef: 'd', params: { max_gy: 40, levels: [30, 20, 10] } }),
      undefined,
    );
    expect(ctx.calls.reslice).toHaveLength(1);
    expect(ctx.calls.marching).toEqual([30, 20, 10]);
    // 30 Gy 那條假核心回 0 段 → 不開批次；另外兩條各一段
    expect(ctx.calls.paths.map((p) => p.sourceId)).toEqual(['d#20', 'd#10']);
    expect(ctx.calls.paths[0]!.segmentCount).toBe(1);
    expect(ctx.calls.paths[0]!.rgba).toHaveLength(4);
    // 20 Gy（0.5，jet 的綠黃）比 10 Gy（0.25，藍）紅
    expect(ctx.calls.paths[0]!.rgba[0]).toBeGreaterThan(ctx.calls.paths[1]!.rgba[0]!);
  });
});

describe('影像後端把視平面搬進 layer 的 FoR', () => {
  it('primary 的 layer：重切吃到的就是 ctx.camera；次要 FoR 的 layer：origin 反向平移、FoR 換掉', () => {
    const rows = [
      [1, 0, 0, -15],
      [0, 1, 0, -178],
      [0, 0, 1, -31],
      [0, 0, 0, 1],
    ];
    const secondary = {
      frameOfReferenceUid: 'for.s',
      seriesId: 'cbct',
      role: 'secondary' as const,
      transformToPrimary: rowsToMat16ColumnMajor(rows),
      transformKind: 'rigid' as const,
      coverageMaskId: null,
    };
    const ctx = fakeContext({
      voxels: { voxels: new Int16Array(8), grid: null as never, volumeKey: 'k' },
      frameGroup: (uid) => (uid === 'for.s' ? secondary : primaryFrameGroupOf('for.p', 'ct')),
    });
    imageCpuBackend.draw(ctx, layer({ layerId: 'ct', kind: 'image', contentRef: 'ct' }), undefined);
    imageCpuBackend.draw(
      ctx,
      layer({ layerId: 'cbct', kind: 'image', contentRef: 'cbct', frameOfReferenceUid: 'for.s' }),
      undefined,
    );
    expect(ctx.calls.reslice[0]!.view).toBe(view);
    const moved = ctx.calls.reslice[1]!.view;
    expect(moved.frameOfReferenceUid).toBe('for.s');
    expect(moved.planeOrigin).toEqual([15, 178, 31]);
    expect(Number.isNaN(ctx.calls.reslice[1]!.outside)).toBe(true);
  });
});
