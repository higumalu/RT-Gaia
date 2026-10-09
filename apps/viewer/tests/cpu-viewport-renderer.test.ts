/**
 * `CpuViewportRenderer.render()` 的疊加與上畫面順序（2026-09-29 劑量只剩等劑量線的回歸測試）。
 *
 * 先前曾把「非 image band」全部丟進分片的輪廓階段 —— 那時 `ctx.target` 已經 blit 過、之後不會再 blit，
 * 所以 `overlay` band（劑量 colorwash、ROI 填色）畫進 target 的像素永遠不上畫面，只剩走向量出口的等劑量線。
 * 這支測試用最小的假 DOM（canvas 只記 `putImageData`）直接跑 renderer，確認最後貼到畫面的像素裡有 overlay。
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  clearLayerKinds,
  clearLayerRenderers,
  registerLayerKind,
  registerLayerRenderer,
} from '../src/core';
import type { CpuContext, Grid, GridSet, Layer, ViewReference } from '../src/core';
import { CpuViewportRenderer } from '../src/core/scene/CpuViewportRenderer';

class FakeImageData {
  readonly data: Uint8ClampedArray;
  constructor(
    readonly width: number,
    readonly height: number,
  ) {
    this.data = new Uint8ClampedArray(width * height * 4);
  }
}

interface FakeCanvas {
  width: number;
  height: number;
  className: string;
  style: Record<string, string>;
  /** `putImageData` 貼上的最後一份像素（複本）。 */
  shown: Uint8ClampedArray | null;
  getContext: () => unknown;
}

function fakeCanvas(): FakeCanvas {
  const canvas: FakeCanvas = { width: 0, height: 0, className: '', style: {}, shown: null, getContext: () => ctx };
  // 其他 2D API 一律吞掉；只有 putImageData 要記下來
  const ctx: unknown = new Proxy(
    {},
    {
      get(_target, prop) {
        if (prop === 'canvas') return canvas;
        if (prop === 'putImageData') return (img: FakeImageData) => (canvas.shown = img.data.slice());
        if (prop === 'measureText') return () => ({ width: 0 });
        return () => undefined;
      },
      set: () => true,
    },
  );
  return canvas;
}

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
const grid: Grid = { size: [4, 4, 1], spacing: [1, 1, 1], origin: [0, 0, 0], direction: [1, 0, 0, 0, 1, 0, 0, 0, 1], frameOfReferenceUid: 'for.1' };

function layer(layerId: string, kind: string, order: number): Layer {
  return {
    layerId,
    kind,
    label: layerId,
    groupId: null,
    frameOfReferenceUid: 'for.1',
    contentRef: layerId,
    visible: true,
    opacity: 1,
    order,
    blendMode: 'normal',
    temporalGroupId: null,
  };
}

/** 把整張 target 塗成一個顏色（不透明）。 */
function paint(rgb: [number, number, number]) {
  return (ctx: CpuContext): void => {
    const d = ctx.target.data;
    for (let i = 0; i < d.length; i += 4) {
      d[i] = rgb[0];
      d[i + 1] = rgb[1];
      d[i + 2] = rgb[2];
      d[i + 3] = 255;
    }
  };
}

function registerTestRenderer(id: string, zBand: 'image' | 'overlay' | 'annotation', draw: (ctx: CpuContext) => void): void {
  const stub = { kind: 'supported' as const, render: () => ({}) as never };
  registerLayerRenderer({ rendererId: id, form: 'F1', zBand, gpu: stub, cpu: { ...stub, draw } });
  registerLayerKind({ kind: id, resolveRenderers: () => [id] });
}

const saved: Record<string, unknown> = {};

beforeEach(() => {
  clearLayerRenderers();
  clearLayerKinds();
  saved['document'] = (globalThis as Record<string, unknown>)['document'];
  saved['ImageData'] = (globalThis as Record<string, unknown>)['ImageData'];
  (globalThis as Record<string, unknown>)['document'] = { createElement: () => fakeCanvas() };
  (globalThis as Record<string, unknown>)['ImageData'] = FakeImageData;
});

afterEach(() => {
  clearLayerRenderers();
  clearLayerKinds();
  (globalThis as Record<string, unknown>)['document'] = saved['document'];
  (globalThis as Record<string, unknown>)['ImageData'] = saved['ImageData'];
});

function makeRenderer(): { renderer: CpuViewportRenderer; image: FakeCanvas } {
  const children: FakeCanvas[] = [];
  const container = { appendChild: (c: FakeCanvas) => children.push(c), getBoundingClientRect: () => ({ width: 4, height: 4 }) };
  const renderer = new CpuViewportRenderer({
    info: { viewportId: 'axial', is3D: false, width: 4, height: 4 },
    container: container as unknown as HTMLElement,
    kernel: {} as never,
    volumes: {} as never,
    imageGrid: grid,
    gridSet: { frameGroups: [], temporalGroups: [] } as unknown as GridSet,
    tier: 'C',
  });
  renderer.setCamera(view);
  return { renderer, image: children[0]! };
}

describe('CpuViewportRenderer：overlay band 的像素要上畫面', () => {
  it('影像之上的 overlay（劑量 colorwash、ROI 填色）出現在最後貼上的像素裡', () => {
    registerTestRenderer('t-image', 'image', paint([10, 10, 10]));
    registerTestRenderer('t-overlay', 'overlay', paint([200, 0, 0]));
    const { renderer, image } = makeRenderer();
    renderer.setLayers([layer('img', 't-image', 0), layer('wash', 't-overlay', 51)]);
    renderer.render('final');
    renderer.flushOutlines();
    expect(image.shown).not.toBeNull();
    expect(Array.from(image.shown!.slice(0, 4))).toEqual([200, 0, 0, 255]);
  });

  it('沒有影像只有 overlay 時也會貼上', () => {
    registerTestRenderer('t-overlay', 'overlay', paint([0, 0, 200]));
    const { renderer, image } = makeRenderer();
    renderer.setLayers([layer('wash', 't-overlay', 51)]);
    renderer.render('final');
    expect(Array.from(image.shown!.slice(0, 4))).toEqual([0, 0, 200, 255]);
  });

  it('只有影像時貼的是影像', () => {
    registerTestRenderer('t-image', 'image', paint([10, 20, 30]));
    const { renderer, image } = makeRenderer();
    renderer.setLayers([layer('img', 't-image', 0)]);
    renderer.render('final');
    expect(Array.from(image.shown!.slice(0, 4))).toEqual([10, 20, 30, 255]);
  });
});
