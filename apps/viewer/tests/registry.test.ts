/**
 * 擴充點註冊表。
 *
 * 這個檔案要證明的核心主張是：**核心不認識 `'mask'`，也不認識 `renderStyle`
 * 的三個值**。
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  clearLayerKinds,
  clearLayerRenderers,
  diffRenderers,
  getLayerRenderer,
  listLayerRenderers,
  registerBuiltins,
  registerLayerKind,
  registerLayerRenderer,
  resolveBackend,
  resolveRenderers,
  Z_BAND_ORDER,
  zBandRank,
} from '../src/core';
import type { Layer, ViewportInfo } from '../src/core';

const mpr: ViewportInfo = { viewportId: 'axial', is3D: false, width: 512, height: 512 };
const volume3d: ViewportInfo = { viewportId: 'v3d', is3D: true, width: 512, height: 512 };

function maskLayer(renderStyle?: Layer['renderStyle']): Layer {
  return {
    layerId: 'mask:gtv',
    kind: 'mask',
    label: 'GTV',
    groupId: 'structures',
    frameOfReferenceUid: 'for.1',
    contentRef: 'gtv',
    visible: true,
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
    frameOfReferenceUid: 'for.1',
    contentRef: 'ct',
    visible: true,
    opacity: 1,
    order: 0,
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

describe('內建註冊的六個 renderer', () => {
  it('六個都在，且 rendererId 不等於 Layer.kind', () => {
    const ids = listLayerRenderers().map((p) => p.rendererId).sort();
    expect(ids).toEqual(['image', 'mask-fill', 'mask-outline', 'measurement', 'mesh', 'volume-3d']);
  });

  it('mask 拆成兩個 renderer，且 form 與 zBand 不同', () => {
    const outline = getLayerRenderer('mask-outline');
    const fill = getLayerRenderer('mask-fill');
    expect(outline.form).toBe('F3');
    expect(fill.form).toBe('F1');
    expect(outline.zBand).toBe('annotation');
    expect(fill.zBand).toBe('overlay');
  });

  it('zBand 取代硬編碼的混合順序（混合順序變成資料）', () => {
    expect(Z_BAND_ORDER).toEqual(['image', 'overlay', 'annotation']);
    expect(zBandRank(getLayerRenderer('image').zBand)).toBeLessThan(
      zBandRank(getLayerRenderer('mask-fill').zBand),
    );
    expect(zBandRank(getLayerRenderer('mask-fill').zBand)).toBeLessThan(
      zBandRank(getLayerRenderer('mask-outline').zBand),
    );
  });

  it('gpu 與 cpu 皆必填；宣告 unsupported 時必須同時給 reason 與 fallback', () => {
    expect(() =>
      registerLayerRenderer({
        rendererId: 'broken',
        form: 'F1',
        zBand: 'overlay',
        gpu: { kind: 'supported', render: () => ({}) as never },
        // @ts-expect-error 故意漏 fallback
        cpu: { kind: 'unsupported', reason: '沒有實作' },
      }),
    ).toThrowError(/R5/);
  });

  it('rendererId 不得重複註冊', () => {
    expect(() =>
      registerLayerRenderer({
        rendererId: 'image',
        form: 'F1',
        zBand: 'image',
        gpu: { kind: 'supported', render: () => ({}) as never },
        cpu: { kind: 'supported', render: () => ({}) as never },
      }),
    ).toThrowError(/R2/);
  });
});

describe('Layer.kind → 多個 renderer', () => {
  it('outline 是預設', () => {
    expect(resolveRenderers(maskLayer(), mpr)).toEqual(['mask-outline']);
  });

  it("renderStyle='fill+outline' 產生兩個 renderer（因此兩個 handle）", () => {
    expect(resolveRenderers(maskLayer('fill+outline'), mpr).sort()).toEqual([
      'mask-fill',
      'mask-outline',
    ]);
  });

  it("renderStyle='fill' 只有 fill", () => {
    expect(resolveRenderers(maskLayer('fill'), mpr)).toEqual(['mask-fill']);
  });

  it('3D viewport 裡 mask 不顯示（結構走 mesh）', () => {
    expect(resolveRenderers(maskLayer('fill+outline'), volume3d)).toEqual([]);
  });

  it('image 在 3D viewport 走 volume-3d', () => {
    expect(resolveRenderers(imageLayer(), mpr)).toEqual(['image']);
    expect(resolveRenderers(imageLayer(), volume3d)).toEqual(['volume-3d']);
  });

  it('mesh 僅存在於 3D viewport —— **現在是資料，不是散文**', () => {
    const mesh: Layer = { ...maskLayer(), layerId: 'mesh:gtv', kind: 'mesh' };
    expect(resolveRenderers(mesh, mpr)).toEqual([]);
    expect(resolveRenderers(mesh, volume3d)).toEqual(['mesh']);
  });

  it('未註冊的 kind 明確報錯，不是靜默略過', () => {
    const custom: Layer = { ...maskLayer(), kind: 'module-heatmap' };
    expect(() => resolveRenderers(custom, mpr)).toThrowError(/K3/);
  });

  it('模組可註冊新 kind，核心不必改', () => {
    registerLayerKind({ kind: 'module-heatmap', resolveRenderers: () => ['mask-fill'] });
    const custom: Layer = { ...maskLayer(), kind: 'module-heatmap' };
    expect(resolveRenderers(custom, mpr)).toEqual(['mask-fill']);
  });
});

describe('renderStyle 改變 = handle 集合改變（不得整個 layer 重建）', () => {
  it('outline → fill+outline 只新增 fill，outline 保留', () => {
    const before = resolveRenderers(maskLayer('outline'), mpr);
    const after = resolveRenderers(maskLayer('fill+outline'), mpr);
    const diff = diffRenderers(before, after);
    expect(diff.added).toEqual(['mask-fill']);
    expect(diff.kept).toEqual(['mask-outline']);
    expect(diff.removed).toEqual([]);
  });

  it('fill+outline → outline 只移除 fill', () => {
    const diff = diffRenderers(
      resolveRenderers(maskLayer('fill+outline'), mpr),
      resolveRenderers(maskLayer('outline'), mpr),
    );
    expect(diff.removed).toEqual(['mask-fill']);
    expect(diff.kept).toEqual(['mask-outline']);
  });
});

describe('fallback 的解析', () => {
  it('volume-3d 在 Tier A/B 走 GPU', () => {
    for (const tier of ['A', 'B'] as const) {
      const resolved = resolveBackend('volume-3d', tier);
      expect(resolved.backend).toBe('gpu');
      expect(resolved.isSubstitute).toBe(false);
      expect(resolved.serverRenderEndpoint).toBeNull();
    }
  });

  it('volume-3d 在 Tier C 宣告 unsupported ＋ 後端出圖', () => {
    const resolved = resolveBackend('volume-3d', 'C');
    expect(resolved.backend).toBe('cpu');
    expect(resolved.isSubstitute).toBe(true);
    expect(resolved.serverRenderEndpoint).toBe('render3d');
    // **必須讓使用者知道看到的不是原始表示**
    expect(resolved.notice).toBeTruthy();
    expect(resolved.hidden).toBe(false);
  });

  it("to:'hidden' 是明確告知不可用，不是靜默省略", () => {
    registerLayerRenderer({
      rendererId: 'module-f1-overlay',
      form: 'F1',
      zBand: 'overlay',
      gpu: { kind: 'supported', render: () => ({}) as never },
      cpu: {
        kind: 'unsupported',
        reason: '模組自訂的 F1 overlay 後端不認識',
        fallback: { to: 'hidden', notice: '此圖層在無顯卡環境不可用' },
      },
    });
    const resolved = resolveBackend('module-f1-overlay', 'C');
    expect(resolved.hidden).toBe(true);
    expect(resolved.notice).toContain('不可用');
  });

  it('fallback 指向的 renderer 在該 Tier 也不可用時，註冊表拒絕（退路必須真的走得通）', () => {
    registerLayerRenderer({
      rendererId: 'dead-end',
      form: 'F1',
      zBand: 'overlay',
      gpu: { kind: 'supported', render: () => ({}) as never },
      cpu: {
        kind: 'unsupported',
        reason: '不支援',
        fallback: { to: 'hidden', notice: '不可用' },
      },
    });
    registerLayerRenderer({
      rendererId: 'points-to-dead-end',
      form: 'F1',
      zBand: 'overlay',
      gpu: { kind: 'supported', render: () => ({}) as never },
      cpu: {
        kind: 'unsupported',
        reason: '不支援',
        fallback: {
          to: 'other-layer-kind',
          rendererId: 'dead-end',
          resolveContent: () => Promise.resolve({ kind: 'x', ref: 'x', data: null }),
          notice: '替代表示',
        },
      },
    });
    expect(() => resolveBackend('points-to-dead-end', 'C')).toThrowError(/R7/);
  });
});
