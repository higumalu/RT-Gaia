/**
 * `SceneManager` —— 界線、handle 生命週期、I4 失效、品質狀態。
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath, URL } from 'node:url';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  clearLayerKinds,
  clearLayerRenderers,
  clearSharedResources,
  createGridSet,
  makeStubHandle,
  NullViewportRenderer,
  primaryFrameGroupOf,
  registerBuiltins,
  SETTLE_MS,
  SceneManager,
  type GridSet,
  type Layer,
  type SceneNotice,
  type TransportLike,
  type ViewportInfo,
} from '../src/core';
import type { SceneManagerOptions } from '../src/core/scene/SceneManager';
import { fromWire } from '../src/core/transport/wire';

const fixture = JSON.parse(
  readFileSync(fileURLToPath(new URL('./fixtures/geometry-vectors.json', import.meta.url)), 'utf8'),
) as {
  display_grid_cases: { source_grid: Record<string, unknown>; cases: { display_grid: Record<string, unknown> }[] };
  mask_grid: Record<string, unknown>;
};

const MB = 1_000_000;

const transport: TransportLike = {
  fetchMesh: () => Promise.resolve({ kind: 'mesh', ref: 'x', data: null }),
  fetchRender3d: () => Promise.resolve({ kind: 'png', ref: 'x', data: null }),
};

function gridSet(caseIndex = 0): GridSet {
  const displayGrid = fromWire.displayGrid(
    fixture.display_grid_cases.cases[caseIndex]!.display_grid,
  );
  const maskGrid = fromWire.maskGrid(fixture.mask_grid);
  return createGridSet({
    displayGrid,
    maskGrid,
    frameGroups: [
      primaryFrameGroupOf(displayGrid.grid.frameOfReferenceUid, 'series.primary'),
    ],
    temporalGroups: [],
    assignedTier: 'A',
  });
}

function maskLayer(id: string, renderStyle?: Layer['renderStyle'], visible = true): Layer {
  return {
    layerId: `mask:${id}`,
    kind: 'mask',
    label: id,
    groupId: 'structures',
    frameOfReferenceUid: gridSet().displayGrid.grid.frameOfReferenceUid,
    contentRef: id,
    visible,
    opacity: 1,
    order: 100,
    ...(renderStyle ? { renderStyle } : {}),
  };
}

function imageLayer(): Layer {
  return {
    layerId: 'image:ct',
    kind: 'image',
    label: 'CT',
    groupId: 'images',
    frameOfReferenceUid: gridSet().displayGrid.grid.frameOfReferenceUid,
    contentRef: 'ct',
    visible: true,
    opacity: 1,
    order: 0,
  };
}

const mpr: ViewportInfo = { viewportId: 'axial', is3D: false, width: 512, height: 512 };
const vol3d: ViewportInfo = { viewportId: 'v3d', is3D: true, width: 512, height: 512 };

let notices: SceneNotice[] = [];

function makeManager(options: Partial<SceneManagerOptions> = {}): SceneManager {
  notices = [];
  return new SceneManager({
    gridSet: gridSet(),
    tier: 'A',
    budgetBytes: 3000 * MB,
    transport,
    createHandle: (args) => makeStubHandle({ ...args, ownBytes: 10 * MB }),
    onNotice: (n) => notices.push(n),
    ...options,
  });
}

beforeEach(() => {
  clearLayerRenderers();
  clearLayerKinds();
  clearSharedResources();
  registerBuiltins();
});

afterEach(() => {
  clearLayerRenderers();
  clearLayerKinds();
  clearSharedResources();
});

describe('建構時就檢查 I3 跨族相容性', () => {
  it('影像與 mask 落在同一塊空間時建構成功（即使降採樣）', () => {
    for (let i = 0; i < fixture.display_grid_cases.cases.length; i += 1) {
      expect(() => {
        const m = new SceneManager({
          gridSet: gridSet(i),
          tier: 'A',
          budgetBytes: 3000 * MB,
          transport,
          createHandle: (args) => makeStubHandle(args),
        });
        m.dispose();
      }).not.toThrow();
    }
  });
});

describe('界線：react 只提供容器，core 擁有 renderer', () => {
  it('attachViewport 交還一個由 core 建立的 renderer', () => {
    const m = makeManager();
    const renderer = m.attachViewport(mpr);
    expect(renderer).toBeInstanceOf(NullViewportRenderer);
    expect(m.viewportIds()).toEqual(['axial']);
    m.dispose();
  });

  it('StrictMode double-mount：同一個 id 重複 attach 不留下兩份', () => {
    const m = makeManager();
    const first = m.attachViewport(mpr) as NullViewportRenderer;
    const second = m.attachViewport(mpr);
    expect(first.disposed).toBe(true);
    expect(second).not.toBe(first);
    expect(m.viewportIds()).toEqual(['axial']);
    m.dispose();
  });

  it('dispose 是冪等的', () => {
    const m = makeManager();
    m.attachViewport(mpr);
    m.dispose();
    m.dispose();
    expect(m.isDisposed()).toBe(true);
    expect(m.residentBytes()).toBe(0);
  });

  it('dispose 之後不得再使用', () => {
    const m = makeManager();
    m.dispose();
    expect(() => m.setLayer(imageLayer())).toThrowError(/S3/);
  });
});

describe('一個 layer 對應多個 handle', () => {
  it("renderStyle='fill+outline' 在一個 viewport 產生兩個 handle", () => {
    const m = makeManager();
    m.attachViewport(mpr);
    m.setLayer(maskLayer('gtv', 'fill+outline'));
    const keys = m.residencyBreakdown().map((b) => b.rendererId).sort();
    expect(keys).toEqual(['mask-fill', 'mask-outline']);
    m.dispose();
  });

  it('四格版面裡同一個 layer 有四組 handle', () => {
    const m = makeManager();
    for (const id of ['axial', 'coronal', 'sagittal']) {
      m.attachViewport({ ...mpr, viewportId: id });
    }
    m.setLayer(maskLayer('gtv'));
    expect(m.residencyBreakdown()).toHaveLength(3);
    m.dispose();
  });

  it('切換 renderStyle 只 diff，不整個重建（fill 的 texture 不重新上傳）', () => {
    const created: string[] = [];
    const m = makeManager({
      createHandle: (args) => {
        created.push(args.rendererId);
        return makeStubHandle({ ...args, ownBytes: 10 * MB });
      },
    });
    m.attachViewport(mpr);
    m.setLayer(maskLayer('gtv', 'fill+outline'));
    expect(created.sort()).toEqual(['mask-fill', 'mask-outline']);
    created.length = 0;
    m.setLayer(maskLayer('gtv', 'outline'));
    // 🔴 沒有任何新 handle 被建立 —— outline 被保留，只是 fill 被 dispose
    expect(created).toEqual([]);
    expect(m.residencyBreakdown().map((b) => b.rendererId)).toEqual(['mask-outline']);
    m.dispose();
  });

  it('mask 在 3D viewport 不產生 handle（結構走 mesh）', () => {
    const m = makeManager();
    m.attachViewport(vol3d);
    m.setLayer(maskLayer('gtv', 'fill+outline'));
    expect(m.residencyBreakdown()).toHaveLength(0);
    m.dispose();
  });

  it('detachViewport 清掉該 viewport 的所有 handle', () => {
    const m = makeManager();
    m.attachViewport(mpr);
    m.attachViewport({ ...mpr, viewportId: 'coronal' });
    m.setLayer(maskLayer('gtv'));
    expect(m.residencyBreakdown()).toHaveLength(2);
    m.detachViewport('coronal');
    expect(m.residencyBreakdown()).toHaveLength(1);
    m.dispose();
  });
});

describe('混合順序由 zBand 決定，不是硬編碼', () => {
  it('image 在 mask 之下，且順序來自註冊表', () => {
    const m = makeManager();
    m.attachViewport(mpr);
    // 刻意先加 mask 再加 image，證明順序不是插入順序
    m.setLayer(maskLayer('gtv'));
    m.setLayer(imageLayer());
    expect(m.orderedLayers().map((l) => l.layerId)).toEqual(['image:ct', 'mask:gtv']);
    m.dispose();
  });
});

describe('群組批次開關', () => {
  it('一次關掉 20 個結構', () => {
    const m = makeManager({ budgetBytes: 10_000 * MB });
    m.attachViewport(mpr);
    for (let n = 0; n < 20; n += 1) m.setLayer(maskLayer(`s${n}`));
    m.setGroupVisible('structures', false);
    expect(m.orderedLayers().every((l) => !l.visible)).toBe(true);
    m.dispose();
  });

  it('隱藏後超預算即逐出（LRU）', () => {
    const m = makeManager({ budgetBytes: 25 * MB });
    m.attachViewport(mpr);
    for (const n of [0, 1, 2]) m.setLayer(maskLayer(`s${n}`));
    m.setGroupVisible('structures', false);
    const evicted = notices.filter((n) => n.kind === 'evicted');
    expect(evicted.length).toBeGreaterThan(0);
    expect(m.residentBytes()).toBeLessThanOrEqual(25 * MB);
    m.dispose();
  });
});

describe('I4 兩個網格 id 各自獨立失效', () => {
  it('display grid 改變只讓影像失效，mask 不動', () => {
    const m = makeManager();
    m.attachViewport(mpr);
    m.setLayer(imageLayer());
    m.setLayer(maskLayer('gtv'));
    const next: GridSet = { ...gridSet(1), maskGrid: m.currentGridSet().maskGrid };
    const dropped = m.updateGridSet(next);
    expect([...dropped]).toEqual(['image']);
    expect(notices.some((n) => n.kind === 'invalidated')).toBe(true);
    m.dispose();
  });

  it('相同的 GridSet 不觸發任何失效', () => {
    const m = makeManager();
    m.attachViewport(mpr);
    m.setLayer(imageLayer());
    expect([...m.updateGridSet(m.currentGridSet())]).toEqual([]);
    m.dispose();
  });
});

describe('替代表示必須明示且唯讀', () => {
  it('Tier C 的 volume-3d 走後端出圖，並標記為替代表示', () => {
    const m = makeManager({ tier: 'C', gridSet: { ...gridSet(), assignedTier: 'C' } });
    m.attachViewport(vol3d);
    m.setLayer(imageLayer());
    const substitutes = m.substituteNotices();
    expect(substitutes).toHaveLength(1);
    expect(substitutes[0]!.rendererId).toBe('volume-3d');
    // 🔴 工具啟動前必須檢查 isEditable，不得靜默寫進一個沒在畫面上的 mask
    expect(m.isEditable('image:ct')).toBe(false);
    expect(notices.some((n) => n.kind === 'substitute')).toBe(true);
    m.dispose();
  });
});

describe('品質狀態', () => {
  it('互動中是 interactive，停止 150 ms 後補到 final', async () => {
    vi.useFakeTimers();
    const m = makeManager();
    m.attachViewport(mpr);
    m.setLayer(imageLayer());
    m.beginInteraction();
    expect(m.currentQuality()).toBe('interactive');
    const settled = vi.fn();
    m.endInteraction(settled);
    expect(m.currentQuality()).toBe('interactive');
    vi.advanceTimersByTime(SETTLE_MS + 1);
    expect(m.currentQuality()).toBe('final');
    expect(settled).toHaveBeenCalledOnce();
    m.dispose();
    vi.useRealTimers();
  });

  it('連續互動不會提早 settle（計時器重置）', () => {
    vi.useFakeTimers();
    const m = makeManager();
    m.attachViewport(mpr);
    m.beginInteraction();
    m.endInteraction();
    vi.advanceTimersByTime(SETTLE_MS - 10);
    m.beginInteraction();
    m.endInteraction();
    vi.advanceTimersByTime(SETTLE_MS - 10);
    expect(m.currentQuality()).toBe('interactive');
    vi.advanceTimersByTime(20);
    expect(m.currentQuality()).toBe('final');
    m.dispose();
    vi.useRealTimers();
  });

  it('render 會把當前品質傳給 renderer', () => {
    const m = makeManager();
    const renderer = m.attachViewport(mpr) as NullViewportRenderer;
    m.beginInteraction();
    m.renderAll();
    expect(renderer.renderLog.at(-1)?.quality).toBe('interactive');
    m.dispose();
  });
});

describe('相機同步（以 primary 世界座標為準）', () => {
  it('同步不再套 transformToPrimary（否則等於套兩次）', () => {
    const m = makeManager();
    const axial = m.attachViewport(mpr) as NullViewportRenderer;
    const coronal = m.attachViewport({ ...mpr, viewportId: 'coronal' }) as NullViewportRenderer;
    const camera = {
      frameOfReferenceUid: gridSet().displayGrid.grid.frameOfReferenceUid,
      displayGridId: gridSet().displayGrid.displayGridId,
      planeOrigin: [1, 2, 3] as [number, number, number],
      viewPlaneNormal: [0, 0, 1] as [number, number, number],
      viewUp: [0, -1, 0] as [number, number, number],
      slabThicknessMm: 0,
      temporalGroupId: null,
      frameIndex: null,
    };
    m.setCamera('axial', camera);
    m.syncCameras(camera, ['coronal']);
    expect(axial.currentCamera()?.planeOrigin).toEqual([1, 2, 3]);
    expect(coronal.currentCamera()?.planeOrigin).toEqual([1, 2, 3]);
    m.dispose();
  });
});
