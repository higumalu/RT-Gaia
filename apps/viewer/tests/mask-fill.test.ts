/**
 * 結構 fill 模式的 CPU 路徑：重切 mask → ≥ 0.5 的像素以結構顏色疊進 target（不打包）；
 * slab 聯集語意取 mip；fill 同時最多 4 個結構；BODY 這類（EXTERNAL）只給輪廓。
 */

import { describe, expect, it } from 'vitest';

import { primaryFrameGroupOf, type ViewReference } from '../src/core/geometry';
import {
  canUseRenderStyle,
  fillCount,
  isBodyLikeStructure,
  MAX_FILL_STRUCTURES,
  type Layer,
} from '../src/core/layers/types';
import { MASK_FILL_ALPHA, maskFillCpuBackend, maskPlaneToU8 } from '../src/core/raster/cpuBackends';
import type { CpuContext, ReslicePlaneArgs } from '../src/core/raster/types';

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

const mask = (id: string, partial: Partial<Layer> = {}): Layer => ({
  layerId: `mask:${id}`,
  kind: 'mask',
  label: id,
  groupId: null,
  frameOfReferenceUid: 'for.p',
  contentRef: id,
  visible: true,
  opacity: 1,
  order: 0,
  ...partial,
});

function fakeContext(plane: Float32Array, camera: ViewReference = view, semantics?: string): CpuContext & { reslice: (ReslicePlaneArgs & { volumeKey: string })[] } {
  const reslice: (ReslicePlaneArgs & { volumeKey: string })[] = [];
  return {
    reslice,
    viewportId: 'axial',
    gridSet: null as never,
    frameGroup: () => primaryFrameGroupOf('for.p', 's'),
    temporal: () => null as never,
    camera,
    viewportSize: { w: 2, h: 2 },
    pxMm: 1,
    quality: 'final',
    project: () => ({ x: 0, y: 0 }),
    voxels: () => ({ voxels: new Uint8Array(8), grid: null as never, volumeKey: 'm@1' }),
    notice: () => {},
    ...(semantics ? { viewportParams: { slabOutlineSemantics: semantics } } : {}),
    resampler: {
      abiVersion: 1,
      reslicePlane: (args: ReslicePlaneArgs & { volumeKey: string }) => {
        reslice.push(args);
        return plane;
      },
      windowToU8: () => new Uint8Array(0),
      marchingSquares: () => new Float32Array(0),
      stitch: () => [],
      maskOutline: () => new Float32Array(0),
      dispose: () => {},
    },
    target: { width: 2, height: 2, data: new Uint8ClampedArray(16) } as unknown as ImageData,
    workers: null,
    paths: { begin: () => {}, polyline: () => {}, segments: () => {}, end: () => {} },
    svgRoot: null,
  } as unknown as CpuContext & { reslice: (ReslicePlaneArgs & { volumeKey: string })[] };
}

describe('mask-fill CPU 後端', () => {
  it('≥ 0.5 的像素（與輪廓同一條等值線）以結構顏色、opacity × MASK_FILL_ALPHA 疊上；外面與 NaN 透明', () => {
    const ctx = fakeContext(new Float32Array([1, 0.5, 0.49, Number.NaN]));
    maskFillCpuBackend.draw(ctx, mask('ptv', { color: [255, 0, 0], opacity: 1 }), null);
    const d = ctx.target.data;
    expect([d[0], d[1], d[2]]).toEqual([255, 0, 0]);
    expect(d[3]).toBe(Math.round(MASK_FILL_ALPHA * 255));
    expect(d[7]).toBe(Math.round(MASK_FILL_ALPHA * 255)); // 0.5 算裡面
    expect(d[11]).toBe(0);
    expect(d[15]).toBe(0);
    expect(ctx.reslice[0]!.blend).toBe('center');
    expect(Number.isNaN(ctx.reslice[0]!.outside!)).toBe(true);
  });

  it('layer.opacity 乘上去；疊在已有的影像上是 over', () => {
    const ctx = fakeContext(new Float32Array([1, 1, 1, 1]));
    ctx.target.data.set([0, 0, 255, 255], 0);
    maskFillCpuBackend.draw(ctx, mask('ctv', { color: [0, 255, 0], opacity: 0.5 }), null);
    const a = 0.5 * MASK_FILL_ALPHA;
    expect(ctx.target.data[0]).toBe(0);
    expect(ctx.target.data[1]).toBeCloseTo(255 * a, -1);
    expect(ctx.target.data[2]).toBeCloseTo(255 * (1 - a), -1);
    expect(ctx.target.data[3]).toBe(255);
  });

  it('slab「聯集外緣」語意取 mip（與輪廓一致）；中心面取 center', () => {
    const thick = { ...view, slabThicknessMm: 10 };
    const union = fakeContext(new Float32Array(4), thick, 'union-outer');
    maskFillCpuBackend.draw(union, mask('a'), null);
    expect(union.reslice[0]!.blend).toBe('mip');
    const center = fakeContext(new Float32Array(4), thick);
    maskFillCpuBackend.draw(center, mask('a'), null);
    expect(center.reslice[0]!.blend).toBe('center');
  });

  it('maskPlaneToU8 重用輸出緩衝', () => {
    const out = new Uint8Array(3);
    expect(maskPlaneToU8(new Float32Array([0.7, 0.2, Number.NaN]), out)).toBe(out);
    expect([...out]).toEqual([255, 0, 0]);
  });
});

describe('fill 的限制', () => {
  it('同時最多 4 個結構；本來就有 fill 的換樣式不算新增；改回輪廓永遠可以', () => {
    const layers = [
      mask('a', { renderStyle: 'fill' }),
      mask('b', { renderStyle: 'fill+outline' }),
      mask('c', { renderStyle: 'fill', visible: false }), // 隱藏的也算
      mask('d', { renderStyle: 'fill' }),
      mask('e'),
    ];
    expect(fillCount(layers)).toBe(MAX_FILL_STRUCTURES);
    expect(canUseRenderStyle(layers, 'mask:e', 'fill')).toBe(false);
    expect(canUseRenderStyle(layers, 'mask:a', 'fill+outline')).toBe(true);
    expect(canUseRenderStyle(layers, 'mask:e', 'outline')).toBe(true);
    expect(canUseRenderStyle(layers.slice(0, 3), 'mask:e', 'fill')).toBe(false); // e 不在清單
    expect(canUseRenderStyle([...layers.slice(0, 3), mask('e')], 'mask:e', 'fill')).toBe(true);
  });

  it('BODY 這類：EXTERNAL 為準，沒有型別看名稱', () => {
    expect(isBodyLikeStructure({ name: 'Liver', interpretedType: 'EXTERNAL' })).toBe(true);
    expect(isBodyLikeStructure({ name: 'BODY', interpretedType: 'ORGAN' })).toBe(false);
    expect(isBodyLikeStructure({ name: ' Body ' })).toBe(true);
    expect(isBodyLikeStructure({ name: 'External' })).toBe(true);
    expect(isBodyLikeStructure({ name: 'Bowel' })).toBe(false);
  });
});
