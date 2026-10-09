/**
 * 工具註冊表與內建工具集。
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { toolRequiresMode } from '../src/core/tools/registry';

import {
  BRUSH_MAX_STEPS,
  BUILTIN_TOOL_COUNT,
  clearTools,
  createGrid,
  primaryFrameGroupOf,
  FIRST_PHASE_TOOL_IDS,
  getTool,
  listTools,
  registerBuiltinTools,
  registerTool,
  type ToolContext,
  type ViewportInfo,
} from '../src/core';

const mpr: ViewportInfo = { viewportId: 'axial', is3D: false, width: 512, height: 512 };
const vol3d: ViewportInfo = { viewportId: 'v3d', is3D: true, width: 512, height: 512 };

function fakeContext(overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    viewport: mpr,
    camera: {
      frameOfReferenceUid: 'for.1',
      displayGridId: 'dg',
      planeOrigin: [0, 0, 0],
      viewPlaneNormal: [0, 0, 1],
      viewUp: [0, -1, 0],
      slabThicknessMm: 0,
      temporalGroupId: null,
      frameIndex: null,
    },
    canvasToWorld: () => [0, 0, 0],
    worldToCanvas: () => ({ x: 0, y: 0 }),
    maskGrid: { grid: null as never, maskGridId: 'mg' },
    maskGridFor: () => ({ grid: null as never, maskGridId: 'mg' }),
    frameGroup: () => null as never,
    setFrameGroupTransform: () => {},
    activeImageLayer: () =>
      ({ layerId: 'img', kind: 'image', label: 'CT', groupId: null, frameOfReferenceUid: 'for.1', contentRef: 's', visible: true, opacity: 1, order: 0 }),
    measurements: () => [],
    addMeasurement: () => {},
    updateMeasurement: () => {},
    removeMeasurement: () => {},
    commitMeasurement: () => {},
    selectMeasurement: () => {},
    cssToBackingScale: () => ({ sx: 1, sy: 1 }),
    setCrosshair: () => {},
    setLassoPreview: () => {},
    highlightVertex: () => {},
    undo: null as never,
    applyPatch: () => true,
    endStroke: () => {},
    params: {},
    sampleImageHu: () => Number.NEGATIVE_INFINITY,
    layers: () => [],
    layer: () => null,
    setVisible: () => {},
    isEditable: () => true,
    activeStructureId: () => 'gtv',
    ...overrides,
  };
}

beforeEach(() => {
  clearTools();
  registerBuiltinTools();
});

afterEach(() => clearTools());

describe('內建工具集', () => {
  it('註冊的工具與宣告的 id 完全一致', () => {
    expect(listTools().map((t) => t.id).sort()).toEqual([...FIRST_PHASE_TOOL_IDS].sort());
    expect(BUILTIN_TOOL_COUNT).toBe(FIRST_PHASE_TOOL_IDS.length);
  });

  it('多邊形輪廓工具刻意不內建', () => {
    for (const id of ['spline', 'livewire', 'sculptor']) {
      expect(() => getTool(id)).toThrowError(/TL3/);
    }
  });

  it('appliesTo 真的在過濾：3D viewport 沒有筆刷與面積量測', () => {
    const in3d = listTools(vol3d).map((t) => t.id);
    expect(in3d).not.toContain('brush');
    expect(in3d).not.toContain('scissors');
    expect(in3d).not.toContain('measure-area');
    // 3D 歐氏距離與平面無關，因此 3D 也可用
    expect(in3d).toContain('measure-distance');
    expect(in3d).toContain('measure-roi3d');
  });

  it('requiresMode：筆刷類綁 roi、量測類綁 measure、十字線不綁（2026-09-16：工具列只在模式開著時列）', () => {
    for (const id of ['brush', 'eraser', 'threshold-brush', 'scissors']) expect(getTool(id).requiresMode).toBe('roi');
    for (const id of ['measure-distance', 'measure-area', 'measure-roi3d', 'measure-point']) expect(getTool(id).requiresMode).toBe('measure');
    expect(getTool('navigate').requiresMode).toBeUndefined();
    expect(toolRequiresMode('brush', 'roi')).toBe(true);
    expect(toolRequiresMode('brush', 'measure')).toBe(false);
    expect(toolRequiresMode('navigate', 'roi')).toBe(false);
    expect(toolRequiresMode(null, 'roi')).toBe(false);
    expect(toolRequiresMode('not-registered', 'roi')).toBe(false);
  });

  it('MPR viewport 有完整工具集', () => {
    expect(listTools(mpr)).toHaveLength(BUILTIN_TOOL_COUNT);
  });

  it('id 不得重複註冊', () => {
    expect(() =>
      registerTool({
        id: 'brush',
        label: 'x',
        icon: 'x',
        cursor: 'none',
        activate: () => ({ deactivate: () => {} }),
      }),
    ).toThrowError(/TL2/);
  });
});

describe('🔴 替代表示為唯讀：工具啟動前必須拒絕', () => {
  it('編輯工具在不可編輯的結構上拒絕啟動', () => {
    const ctx = fakeContext({ isEditable: () => false });
    expect(() => getTool('brush').activate(ctx)).toThrowError(/TL5/);
    expect(() => getTool('eraser').activate(ctx)).toThrowError(/TL5/);
    expect(() => getTool('scissors').activate(ctx)).toThrowError(/TL5/);
  });

  it('編輯工具沒有選定結構時拒絕啟動（不得靜默寫進不存在的 mask）', () => {
    const ctx = fakeContext({ activeStructureId: () => null });
    expect(() => getTool('brush').activate(ctx)).toThrowError(/TL4/);
  });

  it('唯讀工具（量測、導航）不受影響', () => {
    const ctx = fakeContext({ isEditable: () => false, activeStructureId: () => null });
    expect(() => getTool('navigate').activate(ctx)).not.toThrow();
    expect(() => getTool('measure-distance').activate(ctx)).not.toThrow();
  });

  it('可編輯時正常啟動，且 deactivate 可呼叫', () => {
    const instance = getTool('brush').activate(fakeContext());
    expect(() => instance.deactivate()).not.toThrow();
  });
});

describe('ToolContext 不得暴露 vtk 物件', () => {
  it('介面上沒有任何 vtk／cornerstone 命名的欄位', () => {
    const keys = Object.keys(fakeContext());
    for (const key of keys) {
      expect(/vtk|cornerstone|actor|mapper|renderer/i.test(key), key).toBe(false);
    }
    // 必須暴露的四項
    expect(keys).toContain('maskGrid'); // 座標轉換鏈（且型別是 MaskGrid）
    expect(keys).toContain('undo');
    expect(keys).toContain('layers'); // 圖層讀寫
    expect(keys).toContain('camera'); // 目前 ViewReference（含相位）
  });
});

/**
 * 🔴 **接縫是否承重**。
 *
 * 在此之前：九個工具的 `activate()` 交還一個什麼都不做的 instance，**而且沒有
 * 人呼叫它** —— 能用的三個編輯工具寫死在 `ViewerHost.handleToolCommand()` 的一個
 * switch 裡。型別是最終形狀、註冊表存在，但加一個新工具要改 `ViewerHost`，
 * 不是註冊一個 plugin。
 *
 * 這一組測的就是「筆刷真的走這條路」。它們**只用 `ToolContext`**，不碰
 * `ViewerHost`（那個類別需要真的 DOM，測試在 Node 下跑不到）。
 */
describe('🔴 筆刷走 activate() → onPointerDown/Move/Up', () => {
  const maskGrid = {
    grid: createGrid({
      size: [16, 16, 16],
      spacing: [1, 1, 1],
      origin: [0, 0, 0],
      direction: [1, 0, 0, 0, 1, 0, 0, 0, 1],
      frameOfReferenceUid: 'for.1',
    }),
    maskGridId: 'mg',
  };

  function editingContext(overrides: Partial<ToolContext> = {}): {
    ctx: ToolContext;
    patches: { structureId: string; erased: boolean; voxels: number }[];
    strokes: string[];
  } {
    const patches: { structureId: string; erased: boolean; voxels: number }[] = [];
    const strokes: string[] = [];
    const ctx = fakeContext({
      maskGrid,
      maskGridFor: () => maskGrid,
      frameGroup: () => primaryFrameGroupOf('for.1', 'series.1'),
      layers: () => [
        {
          layerId: 'mask:gtv',
          kind: 'mask',
          label: 'GTV',
          groupId: null,
          frameOfReferenceUid: 'for.1',
          contentRef: 'gtv',
          visible: true,
          opacity: 1,
          order: 0,
        },
      ],
      canvasToWorld: () => [8, 8, 8],
      params: { brush: { radiusMm: 3, shape: 'sphere' } },
      applyPatch: (args) => {
        patches.push({
          structureId: args.structureId,
          erased: args.patch.data.every((v) => v === 0),
          voxels: args.patch.data.length,
        });
        return true;
      },
      endStroke: (label) => strokes.push(label),
      ...overrides,
    });
    return { ctx, patches, strokes };
  }

  it('結構只在某幾幀、這一格的相位不是其中之一 → 不寫、每一筆提示一次', () => {
    const notes: string[] = [];
    const gtv = { layerId: 'mask:gtv', kind: 'mask', label: 'GTV_50', groupId: null, frameOfReferenceUid: 'for.1', contentRef: 'gtv', visible: true, opacity: 1, order: 0, temporalGroupId: 'tg', frames: [5] } as const;
    const { ctx, patches } = editingContext({ layers: () => [gtv], frameOf: () => 2, notify: (m) => notes.push(m) });
    const brush = getTool('brush').activate(ctx);
    brush.onPointerDown!(10, 10);
    brush.onPointerMove!(11, 10);
    brush.onPointerUp!(11, 10);
    expect(patches).toHaveLength(0);
    expect(notes).toHaveLength(1);
    expect(notes[0]).toContain('GTV_50');
    brush.onPointerDown!(10, 10); // 下一筆再提示一次
    expect(notes).toHaveLength(2);
    // 在它有的那一幀 → 照常寫
    const ok = editingContext({ layers: () => [gtv], frameOf: () => 5, notify: (m) => notes.push(m) });
    const b2 = getTool('brush').activate(ok.ctx);
    b2.onPointerDown!(10, 10);
    expect(ok.patches).toHaveLength(1);
    expect(notes).toHaveLength(2);
  });

  it('拖曳三個點 → 三筆 patch，放開 → 剛好一次 endStroke', () => {
    const { ctx, patches, strokes } = editingContext();
    const brush = getTool('brush').activate(ctx);
    brush.onPointerDown!(10, 10);
    brush.onPointerMove!(11, 10);
    brush.onPointerMove!(12, 10);
    brush.onPointerUp!(12, 10);

    expect(patches).toHaveLength(3);
    // 🔴 一次拖曳 = 一筆 undo，也只送一次
    expect(strokes).toEqual(['brush']);
  });

  it('兩個指標事件隔很遠 → 中間依半徑補點（一筆是連續的，不是一串點）；一段最多 64 點', () => {
    // 1 px ＝ 1 mm；半徑 3 mm → 間距 1.5 mm；從 x=2 拖到 x=14（12 mm）→ 落下 1 點 ＋ 補 8 點
    const { ctx, patches } = editingContext({ canvasToWorld: (x: number, y: number) => [x, y, 8] });
    const brush = getTool('brush').activate(ctx);
    brush.onPointerDown!(2, 8);
    brush.onPointerMove!(14, 8);
    brush.onPointerUp!(14, 8);
    expect(patches).toHaveLength(1 + 8);
    // 很長一段（1000 mm）→ 封頂
    const far = editingContext({ canvasToWorld: (x: number, y: number) => [x, y, 8] });
    const b2 = getTool('brush').activate(far.ctx);
    b2.onPointerDown!(0, 8);
    b2.onPointerMove!(1000, 8);
    expect(far.patches.length).toBeLessThanOrEqual(1 + BRUSH_MAX_STEPS);
    // 新的一筆不從上一筆的終點連過來
    const again = editingContext({ canvasToWorld: (x: number, y: number) => [x, y, 8] });
    const b3 = getTool('brush').activate(again.ctx);
    b3.onPointerDown!(2, 8);
    b3.onPointerUp!(2, 8);
    b3.onPointerDown!(14, 8);
    b3.onPointerUp!(14, 8);
    expect(again.patches).toHaveLength(2);
  });

  it('沒按下就移動不會畫（游標經過畫面不該留下筆跡）', () => {
    const { ctx, patches } = editingContext();
    const brush = getTool('brush').activate(ctx);
    brush.onPointerMove!(10, 10);
    expect(patches).toHaveLength(0);
  });

  it('🔴 畫到一半 deactivate（切換工具）必須收筆，否則那一筆永遠不會送出', () => {
    const { ctx, strokes } = editingContext();
    const brush = getTool('brush').activate(ctx);
    brush.onPointerDown!(10, 10);
    brush.deactivate();
    expect(strokes).toEqual(['brush']);
  });

  it('沒有在畫的時候 deactivate 不會憑空收出一筆', () => {
    const { ctx, strokes } = editingContext();
    getTool('brush').activate(ctx).deactivate();
    expect(strokes).toEqual([]);
  });

  it('橡皮擦寫 0、筆刷寫 1 —— 同一份實作靠 mode 分岔', () => {
    const paint = editingContext();
    const pb = getTool('brush').activate(paint.ctx);
    pb.onPointerDown!(10, 10);
    pb.onPointerUp!(10, 10);

    const erase = editingContext();
    const eb = getTool('eraser').activate(erase.ctx);
    eb.onPointerDown!(10, 10);
    eb.onPointerUp!(10, 10);

    expect(paint.patches[0]!.erased).toBe(false);
    expect(erase.patches[0]!.erased).toBe(true);
    expect(erase.strokes).toEqual(['eraser']);
  });

  it('🔴 閾值筆刷真的會去問 sampleImageHu（否則它只是一支普通筆刷）', () => {
    const sampled: number[] = [];
    const { ctx } = editingContext({
      sampleImageHu: (ijk) => {
        sampled.push(ijk[0]);
        return 0; // 落在預設軟組織區間內
      },
    });
    const tool = getTool('threshold-brush').activate(ctx);
    tool.onPointerDown!(10, 10);
    expect(sampled.length).toBeGreaterThan(0);
  });

  it('普通筆刷不受 HU 影響（不會誤用閾值）', () => {
    let asked = 0;
    const { ctx, patches } = editingContext({
      sampleImageHu: () => {
        asked += 1;
        return -10_000; // 遠在任何區間之外
      },
    });
    const tool = getTool('brush').activate(ctx);
    tool.onPointerDown!(10, 10);
    expect(asked).toBe(0);
    expect(patches).toHaveLength(1);
  });

  it('params 裡的筆刷半徑真的有作用（半徑越大，寫進去的體素越多）', () => {
    const small = editingContext({ params: { brush: { radiusMm: 1, shape: 'sphere' } } });
    const large = editingContext({ params: { brush: { radiusMm: 5, shape: 'sphere' } } });
    getTool('brush').activate(small.ctx).onPointerDown!(10, 10);
    getTool('brush').activate(large.ctx).onPointerDown!(10, 10);
    expect(large.patches[0]!.voxels).toBeGreaterThan(small.patches[0]!.voxels);
  });

  it('params 沒給 brush 時退回預設值，不是崩潰', () => {
    const { ctx, patches } = editingContext({ params: {} });
    getTool('brush').activate(ctx).onPointerDown!(10, 10);
    expect(patches).toHaveLength(1);
  });
});

describe('內建工具註冊的冪等（修過的回歸）', () => {
  it('模組先註冊了自己的工具之後，registerBuiltinTools 仍補齊內建九個、不重複、不拋', () => {
    clearTools();
    registerTool({ id: 'module-first', label: 'm', icon: 'm', cursor: 'default', hidden: true, activate: () => ({ deactivate() {} }) });
    expect(() => registerBuiltinTools()).not.toThrow();
    expect(listTools().map((t) => t.id)).toEqual(expect.arrayContaining([...FIRST_PHASE_TOOL_IDS]));
    expect(listTools()).toHaveLength(FIRST_PHASE_TOOL_IDS.length + 1);
    expect(() => registerBuiltinTools()).not.toThrow();
    expect(listTools()).toHaveLength(FIRST_PHASE_TOOL_IDS.length + 1);
  });
});
