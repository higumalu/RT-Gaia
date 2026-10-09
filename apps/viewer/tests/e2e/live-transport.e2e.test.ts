/**
 * 🔴 **前端 end-to-end：真的 `TransportClient` 打真的測試後端。**
 *
 * 這是整個測試套件裡唯一會**執行到 transport 層**的地方。`TransportClient`
 * 負責前端全部的網路、全部的 I3 比對、以及 snake_case ↔ camelCase 的轉換；
 * 其餘測試用 fixture，因此那五百多行**從來沒有真的跑過**。
 *
 * 這個檔案驗證的是三件其他測試驗不到的事：
 *
 * 1. **wire 契約真的對得上** —— 後端送出的欄位名與前端 `fromWire` 期待的一致
 * 2. **TypedArray 的視圖偏移正確** —— mesh 的 vertices/triangles 共用一段
 *    buffer，偏移算錯不會報錯，只會拿到垃圾
 * 3. **`SceneManager` 吃得下真實的 `GridSet` 與圖層** —— 契約層與場景層之間
 *    沒有中間人
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  arbitrate,
  assertCrossFamilyCompatible,
  blockGridOf,
  budgetFor,
  clearLayerKinds,
  clearLayerRenderers,
  clearSharedResources,
  cornersWorld,
  indexToWorld,
  makeStubHandle,
  PushChannel,
  registerBuiltins,
  SceneManager,
  StrokeAccumulator,
  SubmitQueue,
  TransportClient,
  VolumeStore,
  worldToNearestVoxel,
  type ClientCapability,
  type Layer,
  type StructureEntry,
} from '../../src/core';
import { fromWire } from '../../src/core/transport/wire';

const BASE_URL = process.env.RTGAIA_TESTBE_URL!;
const WS_URL = process.env.RTGAIA_TESTBE_WS!;

/** 探針的結果在 Node 下沒有 WebGL，因此手動給一個 Tier A 的能力回報。 */
const TIER_A: ClientCapability = {
  webgl2: true,
  maxTexture3d: 2048,
  hasNorm16: true,
  rendererString: 'e2e-node',
  looksSoftware: false,
  probeAllocMb: 2800,
  probeFps: 60,
  tier: 'A',
};

interface LoadedScene {
  studyId: string;
  sessionId: string;
  seriesIds: string[];
  rawLayers: Record<string, unknown>[];
}

async function loadPhantom(phantomId: string): Promise<LoadedScene> {
  const response = await fetch(`${BASE_URL}/api/v1/_test/load`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ source: `phantom:${phantomId}` }),
  });
  expect(response.ok, await response.clone().text()).toBe(true);
  const body = (await response.json()) as {
    study_id: string;
    session_id: string;
    scene: Record<string, unknown>;
  };
  const gridSet = body.scene.gridSet as Record<string, unknown>;
  return {
    studyId: body.study_id,
    sessionId: body.session_id,
    seriesIds: (gridSet.frame_groups as { series_id: string }[]).map((f) => f.series_id),
    rawLayers: body.scene.layers as Record<string, unknown>[],
  };
}

async function resetChaos(): Promise<void> {
  await fetch(`${BASE_URL}/api/v1/_test/chaos`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ reset: true }),
  });
}

beforeAll(() => {
  expect(BASE_URL, 'globalSetup 沒有設好 RTGAIA_TESTBE_URL').toBeTruthy();
  clearLayerRenderers();
  clearLayerKinds();
  registerBuiltins();
});

afterAll(async () => {
  await resetChaos();
  clearLayerRenderers();
  clearLayerKinds();
  clearSharedResources();
});

describe('GridSet —— 真的 POST /grids', () => {
  it('回傳兩個網格，且都通過前端的契約驗證', async () => {
    const scene = await loadPhantom('gantry_tilt');
    const transport = new TransportClient({ baseUrl: BASE_URL });
    const { gridSet, tierConflict } = await transport.createGrids({
      studyId: scene.studyId,
      primarySeriesId: scene.seriesIds[0]!,
      seriesIds: scene.seriesIds,
      capability: TIER_A,
    });
    expect(tierConflict).toBe(false);
    expect(gridSet.displayGrid.displayGridId).toMatch(/^dg_/);
    expect(gridSet.maskGrid.maskGridId).toMatch(/^mg_/);
    expect(gridSet.assignedTier).toBe('A');
    // 🔴 I3 的跨族相容性：影像與 mask 落在同一塊空間
    expect(() => assertCrossFamilyCompatible(gridSet.displayGrid, gridSet.maskGrid)).not.toThrow();
  });

  it('傾斜的 direction 完整穿過 wire（漏傳會在 fromWire.grid 被擋下）', async () => {
    const scene = await loadPhantom('gantry_tilt');
    const transport = new TransportClient({ baseUrl: BASE_URL });
    const { gridSet } = await transport.createGrids({
      studyId: scene.studyId,
      primarySeriesId: scene.seriesIds[0]!,
      seriesIds: scene.seriesIds,
      capability: TIER_A,
    });
    const grid = gridSet.maskGrid.grid;
    const step = indexToWorld(grid, [0, 0, 1]).map(
      (v, i) => v - indexToWorld(grid, [0, 0, 0])[i]!,
    );
    expect(Math.abs(step[1]!)).toBeGreaterThan(0.7); // 3 mm × sin(15°) ≈ 0.776
    expect(Math.hypot(step[0]!, step[1]!, step[2]!)).toBeCloseTo(3, 6);
  });

  it('🔴 N1：前端建議 A 但無 WebGL2 → 412，且 body 已帶完整 GridSet', async () => {
    const scene = await loadPhantom('landmark');
    const transport = new TransportClient({ baseUrl: BASE_URL });
    const result = await transport.createGrids({
      studyId: scene.studyId,
      primarySeriesId: scene.seriesIds[0]!,
      seriesIds: scene.seriesIds,
      capability: { ...TIER_A, webgl2: false, tier: 'A' },
    });
    expect(result.tierConflict).toBe(true);
    expect(result.reason).toBe('no_webgl2');
    // **不必再打一次請求**：GridSet 已經在 body 裡且可用
    expect(result.gridSet.assignedTier).toBe('C');
    expect(result.gridSet.maskGrid.maskGridId).toMatch(/^mg_/);
  });

  it('Tier 裁決：後端下調時前端跟著走', async () => {
    const scene = await loadPhantom('huge');
    const transport = new TransportClient({ baseUrl: BASE_URL });
    const { gridSet } = await transport.createGrids({
      studyId: scene.studyId,
      primarySeriesId: scene.seriesIds[0]!,
      seriesIds: scene.seriesIds,
      capability: { ...TIER_A, probeFps: 15, tier: 'B' },
    });
    expect(gridSet.assignedTier).toBe('B');
    // Tier B 單影像 400 MB < 472 MB → 後端必須降採樣
    expect(gridSet.displayGrid.downsampleFactor).not.toEqual([1, 1, 1]);
    const state = arbitrate({
      capability: { ...TIER_A, probeFps: 15, tier: 'B' },
      backendAssigned: gridSet.assignedTier,
    });
    expect(state.assigned).toBe('B');
    expect(budgetFor(state.assigned, 1).totalBytes).toBe(1_000_000_000);
  });
});

describe('影像 —— 真的 GET /image', () => {
  it('解出 Int16Array，長度與 header 宣告一致', async () => {
    const scene = await loadPhantom('landmark');
    const transport = new TransportClient({ baseUrl: BASE_URL });
    await transport.createGrids({
      studyId: scene.studyId,
      primarySeriesId: scene.seriesIds[0]!,
      seriesIds: scene.seriesIds,
      capability: TIER_A,
    });
    const image = await transport.fetchImage({ seriesId: scene.seriesIds[0]! });
    const size = image.header.size_ijk as [number, number, number];
    expect(image.voxels).toBeInstanceOf(Int16Array);
    expect(image.voxels.length).toBe(size[0] * size[1] * size[2]);
  });

  it('🔴 landmark 體素落在正確的索引 —— 前端的座標鏈端到端', async () => {
    const scene = await loadPhantom('landmark');
    const transport = new TransportClient({ baseUrl: BASE_URL });
    await transport.createGrids({
      studyId: scene.studyId,
      primarySeriesId: scene.seriesIds[0]!,
      seriesIds: scene.seriesIds,
      capability: TIER_A,
    });
    const expected = (await (await fetch(`${BASE_URL}/api/v1/_test/expected`)).json()) as {
      markers: Record<string, { ijk: number[]; world_lps: number[]; voxel_value: number }>;
    };
    const marker = expected.markers.landmark_voxel!;

    const image = await transport.fetchImage({ seriesId: scene.seriesIds[0]! });
    const grid = image.gridSet.grid;
    const size = image.header.size_ijk as [number, number, number];

    // 由後端給的 world 座標，前端自己算 ijk
    const ijk = worldToNearestVoxel(grid, marker.world_lps as [number, number, number]);
    expect(ijk).toEqual(marker.ijk);

    // 再用那個 ijk 去索引真的體素資料
    const [i, j, k] = ijk;
    const value = image.voxels[k * size[1] * size[0] + j * size[0] + i]!;
    expect(value).toBe(marker.voxel_value);
  });

  it('lod 降解析度後幾何中心仍一致（漸進式載入不得跳動）', async () => {
    const scene = await loadPhantom('landmark');
    const transport = new TransportClient({ baseUrl: BASE_URL });
    await transport.createGrids({
      studyId: scene.studyId,
      primarySeriesId: scene.seriesIds[0]!,
      seriesIds: scene.seriesIds,
      capability: TIER_A,
    });
    const full = await transport.fetchImage({ seriesId: scene.seriesIds[0]!, lod: 0 });
    const coarse = await transport.fetchImage({ seriesId: scene.seriesIds[0]!, lod: 2 });
    expect(coarse.voxels.length).toBeLessThan(full.voxels.length);

    const centerOf = (g: typeof full.gridSet.grid): number[] =>
      indexToWorld(g, [(g.size[0] - 1) / 2, (g.size[1] - 1) / 2, (g.size[2] - 1) / 2]);
    const a = centerOf(full.gridSet.grid);
    const b = centerOf(coarse.gridSet.grid);
    const drift = Math.hypot(a[0]! - b[0]!, a[1]! - b[1]!, a[2]! - b[2]!);
    expect(drift).toBeLessThan(Math.max(...coarse.gridSet.grid.spacing));
  });

  it('I3：display_grid 與會話不符時後端回 409，前端得到明確錯誤', async () => {
    const scene = await loadPhantom('landmark');
    const transport = new TransportClient({ baseUrl: BASE_URL });
    await transport.createGrids({
      studyId: scene.studyId,
      primarySeriesId: scene.seriesIds[0]!,
      seriesIds: scene.seriesIds,
      capability: TIER_A,
    });
    // 偽造一個過期的會話綁定
    transport.bindSession({
      studyId: scene.studyId,
      displayGridId: 'dg_stale',
      maskGridId: 'mg_stale',
    });
    await expect(transport.fetchImage({ seriesId: scene.seriesIds[0]! })).rejects.toThrow(/409/);
  });
});

describe('結構、mask、mesh', () => {
  async function session(phantomId: string) {
    const scene = await loadPhantom(phantomId);
    const transport = new TransportClient({ baseUrl: BASE_URL });
    const { gridSet } = await transport.createGrids({
      studyId: scene.studyId,
      primarySeriesId: scene.seriesIds[0]!,
      seriesIds: scene.seriesIds,
      capability: TIER_A,
    });
    return { scene, transport, gridSet };
  }

  it('結構清單的每個欄位都被 fromWire 正確映射（snake → camel）', async () => {
    const { transport } = await session('overlap_set');
    const structures: StructureEntry[] = await transport.fetchStructures();
    expect(structures.length).toBe(7);
    const gtv = structures.find((s) => s.structureId === 'gtv')!;
    expect(gtv.name).toBe('GTV');
    expect(gtv.tg263Code).toBe('GTV');
    expect(gtv.colorRgb).toHaveLength(3);
    expect(gtv.bboxIjk.offset).toHaveLength(3);
    expect(gtv.provenance.moduleVersion).toBeTruthy();
    expect(gtv.provenance.source).toBe('model');
    expect(typeof gtv.volumeCc).toBe('number');
    expect(gtv.frameCount).toBe(1);
  });

  it('mask 的體積與 expected.json 一致（前端自己數體素）', async () => {
    const { transport } = await session('known_geometry');
    const expected = (await (await fetch(`${BASE_URL}/api/v1/_test/expected`)).json()) as {
      structures: Record<string, { voxel_count: number; volume_cc_voxelized: number }>;
    };
    for (const structureId of ['sphere_25mm', 'cube_40mm']) {
      const payload = await transport.fetchMask(structureId);
      const set = payload.voxels.reduce<number>((acc, v) => acc + (v === 0 ? 0 : 1), 0);
      expect(set, structureId).toBe(expected.structures[structureId]!.voxel_count);
    }
  });

  it('🔴 mesh 的 TypedArray 偏移正確（算錯只會拿到垃圾，不會報錯）', async () => {
    const { transport } = await session('overlap_set');
    const content = await transport.fetchMesh('gtv', { lod: 1, frameIndex: null });
    const mesh = content.data as {
      vertices: Float32Array;
      triangles: Uint32Array;
      header: Record<string, unknown>;
    };
    expect(mesh.vertices.length).toBe(Number(mesh.header.vertex_count) * 3);
    expect(mesh.triangles.length).toBe(Number(mesh.header.triangle_count) * 3);
    // 索引必須在範圍內 —— 偏移算錯時這一條會立刻掛
    expect(Math.max(...mesh.triangles)).toBeLessThan(mesh.vertices.length / 3);
    // 頂點是世界座標：gtv 是半徑 20 mm、球心在原點的球
    let sum = 0;
    for (let n = 0; n < mesh.vertices.length; n += 3) {
      sum += Math.hypot(mesh.vertices[n]!, mesh.vertices[n + 1]!, mesh.vertices[n + 2]!);
    }
    expect(sum / (mesh.vertices.length / 3)).toBeCloseTo(20, 0);
  });

  it('mask 的 frame 參數在帶時間軸的結構上真的生效', async () => {
    const { transport } = await session('four_d_ct');
    const a = await transport.fetchMask('gtv_4d', { frameIndex: 0 });
    const b = await transport.fetchMask('gtv_4d', { frameIndex: 5 });
    expect(a.contentHash).not.toBe(b.contentHash);
    expect(a.frameIndex).toBe(0);
    expect(b.frameIndex).toBe(5);
    expect(a.offsetIjk).not.toEqual(b.offsetIjk);
  });
});

describe('編輯 —— 真的 POST /edit', () => {
  it('樂觀更新的往返：200 ＋ 新 hash ＋ provenance', async () => {
    const scene = await loadPhantom('gantry_tilt');
    const transport = new TransportClient({ baseUrl: BASE_URL });
    await transport.createGrids({
      studyId: scene.studyId,
      primarySeriesId: scene.seriesIds[0]!,
      seriesIds: scene.seriesIds,
      capability: TIER_A,
    });
    const before = await transport.fetchMask('lesion');
    const result = await transport.submitEdit({
      structureId: 'lesion',
      frameIndex: null,
      baseContentHash: before.contentHash,
      clientSeq: 1,
      offsetIjk: [300, 300, 40],
      sizeIjk: [4, 4, 2],
      data: new Uint8Array(32).fill(1),
      viewReference: {
        frameOfReferenceUid: before.header.frame_of_reference_uid as string,
        displayGridId: 'dg_e2e',
        planeOrigin: [0, 0, 0],
        viewPlaneNormal: [0, 0, 1],
        viewUp: [0, -1, 0],
        slabThicknessMm: 0,
        temporalGroupId: null,
        frameIndex: null,
      },
    });
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    expect(result.contentHash).not.toBe(before.contentHash);

    const after = await transport.fetchMask('lesion');
    expect(after.contentHash).toBe(result.contentHash);
    expect(after.provenance.source).toBe('user-edit');
    expect(after.provenance.viewReference).not.toBeNull();
  });

  it('🔴 兩個 client 各自的 client_seq 互不干擾（＝重新整理頁面）', async () => {
    // 重新整理後前端的 clientSeq 從 1 重新起算，而後端還記著上一輪的號碼。
    // 若伺服器只用 structure 當 key，第一筆編輯就會被判 out_of_order →
    // 清空 undo 並顯示「已被其他來源修改」——但沒有人改過任何東西，
    // 而 409 應該「只在真正的外部修改時發生」。
    const scene = await loadPhantom('gantry_tilt');
    const first = new TransportClient({ baseUrl: BASE_URL });
    await first.createGrids({
      studyId: scene.studyId,
      primarySeriesId: scene.seriesIds[0]!,
      seriesIds: scene.seriesIds,
      capability: TIER_A,
    });
    const base = await first.fetchMask('lesion');
    const view = {
      frameOfReferenceUid: base.header.frame_of_reference_uid as string,
      displayGridId: 'dg_e2e',
      planeOrigin: [0, 0, 0] as [number, number, number],
      viewPlaneNormal: [0, 0, 1] as [number, number, number],
      viewUp: [0, -1, 0] as [number, number, number],
      slabThicknessMm: 0,
      temporalGroupId: null,
      frameIndex: null,
    };
    const one = await first.submitEdit({
      structureId: 'lesion',
      frameIndex: null,
      baseContentHash: base.contentHash,
      clientSeq: 7,
      offsetIjk: [300, 300, 40],
      sizeIjk: [2, 2, 1],
      data: new Uint8Array(4).fill(1),
      viewReference: view,
    });
    expect(one.status).toBe('ok');
    if (one.status !== 'ok') return;

    // 重新整理 = 全新的 TransportClient（新的 clientId），序號回到 1
    const reloaded = new TransportClient({ baseUrl: BASE_URL });
    await reloaded.createGrids({
      studyId: scene.studyId,
      primarySeriesId: scene.seriesIds[0]!,
      seriesIds: scene.seriesIds,
      capability: TIER_A,
    });
    expect(reloaded.currentClientId()).not.toBe(first.currentClientId());
    const two = await reloaded.submitEdit({
      structureId: 'lesion',
      frameIndex: null,
      baseContentHash: one.contentHash,
      clientSeq: 1,
      offsetIjk: [300, 300, 41],
      sizeIjk: [2, 2, 1],
      data: new Uint8Array(4).fill(1),
      viewReference: view,
    });
    expect(two.status).toBe('ok');

    // 而同一個 client 的亂序仍然被拒（保險本身還在）
    const stale = await reloaded.submitEdit({
      structureId: 'lesion',
      frameIndex: null,
      baseContentHash: two.status === 'ok' ? two.contentHash : '',
      clientSeq: 1,
      offsetIjk: [300, 300, 42],
      sizeIjk: [2, 2, 1],
      data: new Uint8Array(4).fill(1),
      viewReference: view,
    });
    expect(stale.status).toBe('conflict');
    if (stale.status === 'conflict') expect(stale.reason).toBe('out_of_order');
  });

  it('🔴 一整筆筆畫（多個筆點）完整送達後端，不只最後一個筆點', async () => {
    // 舊版每個筆點覆寫 `stroke.patch`，於是放開滑鼠時只送出最後一個筆點：
    // 本地畫了一整筆、後端只收到最後一小塊，而且完全不報錯——直到匯出
    // RTSTRUCT 才發現大部分筆畫不見了。
    const scene = await loadPhantom('gantry_tilt');
    const transport = new TransportClient({ baseUrl: BASE_URL });
    const created = await transport.createGrids({
      studyId: scene.studyId,
      primarySeriesId: scene.seriesIds[0]!,
      seriesIds: scene.seriesIds,
      capability: TIER_A,
    });
    const gridSet = created.gridSet;
    const fetched = await transport.fetchMask('lesion');
    const maskGrid = gridSet.maskGrid.grid;

    const volumes = new VolumeStore();
    volumes.putMask({
      structureId: 'lesion',
      frameIndex: null,
      blockGrid: blockGridOf(maskGrid, fetched.offsetIjk, fetched.sizeIjk),
      offsetIjk: fetched.offsetIjk,
      sizeIjk: fetched.sizeIjk,
      voxels: fetched.voxels,
      contentHash: fetched.contentHash,
      revision: 0,
    });

    const view = {
      frameOfReferenceUid: maskGrid.frameOfReferenceUid,
      displayGridId: gridSet.displayGrid.displayGridId,
      planeOrigin: [0, 0, 0] as [number, number, number],
      viewPlaneNormal: [0, 0, 1] as [number, number, number],
      viewUp: [0, -1, 0] as [number, number, number],
      slabThicknessMm: 0,
      temporalGroupId: null,
      frameIndex: null,
    };
    const queue = new SubmitQueue({
      readBlock: (args) => volumes.readMaskBlock(args),
      submit: async (request) => transport.submitEdit({ ...request, ...request.patch }),
      onConflict: (info) => {
        throw new Error(`不該衝突：${info.reason}`);
      },
      onError: (message) => {
        throw new Error(message);
      },
    });
    queue.register({
      structureId: 'lesion',
      frameIndex: null,
      maskGridId: gridSet.maskGrid.maskGridId,
      contentHash: fetched.contentHash,
    });

    // 一筆 12 個筆點，沿 i 排開（刻意讓筆點之間有空隙）
    let acc: StrokeAccumulator | null = null;
    let bounds = { offsetIjk: [0, 0, 0] as const, sizeIjk: [0, 0, 0] as const };
    for (let n = 0; n < 12; n += 1) {
      const dabBounds = {
        offsetIjk: [300 + n * 3, 300, 40] as [number, number, number],
        sizeIjk: [2, 2, 1] as [number, number, number],
      };
      const applied = volumes.applyMaskPatch({
        structureId: 'lesion',
        frameIndex: null,
        offsetIjk: dabBounds.offsetIjk,
        sizeIjk: dabBounds.sizeIjk,
        data: new Uint8Array(4).fill(1),
        maskGrid,
      })!;
      const dab = { bounds: dabBounds, before: applied.before, after: applied.after };
      if (acc === null) {
        acc = new StrokeAccumulator(dab);
      } else {
        acc.add({
          ...dab,
          readLive: (bb) =>
            volumes.readMaskBlock({ structureId: 'lesion', frameIndex: null, ...bb }),
        });
      }
      bounds = acc.result().bounds as typeof bounds;
    }
    queue.enqueue({ structureId: 'lesion', frameIndex: null, bounds, viewReference: view });
    await queue.drain();

    // 後端的體素必須與本地逐格相同 —— 12 個筆點全部到了
    const roundTrip = await transport.fetchMask('lesion');
    const local = volumes.readMaskBlock({
      structureId: 'lesion',
      frameIndex: null,
      offsetIjk: roundTrip.offsetIjk,
      sizeIjk: roundTrip.sizeIjk,
    })!;
    expect(roundTrip.voxels.length).toBe(local.length);
    let mismatches = 0;
    for (let i = 0; i < local.length; i += 1) {
      if (roundTrip.voxels[i] !== local[i]) mismatches += 1;
    }
    expect(mismatches).toBe(0);
  });

  it('chaos: stale_hash → 409 被轉成 conflict（不是丟例外）', async () => {
    const scene = await loadPhantom('gantry_tilt');
    const transport = new TransportClient({ baseUrl: BASE_URL });
    await transport.createGrids({
      studyId: scene.studyId,
      primarySeriesId: scene.seriesIds[0]!,
      seriesIds: scene.seriesIds,
      capability: TIER_A,
    });
    const before = await transport.fetchMask('lesion');
    await fetch(`${BASE_URL}/api/v1/_test/chaos`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ stale_hash: true }),
    });
    try {
      const result = await transport.submitEdit({
        structureId: 'lesion',
        frameIndex: null,
        baseContentHash: before.contentHash,
        clientSeq: 1,
        offsetIjk: [300, 300, 40],
        sizeIjk: [1, 1, 1],
        data: new Uint8Array([1]),
        viewReference: {
          frameOfReferenceUid: before.header.frame_of_reference_uid as string,
          displayGridId: 'dg_e2e',
          planeOrigin: [0, 0, 0],
          viewPlaneNormal: [0, 0, 1],
          viewUp: [0, -1, 0],
          slabThicknessMm: 0,
          temporalGroupId: null,
          frameIndex: null,
        },
      });
      expect(result.status).toBe('conflict');
      if (result.status !== 'conflict') return;
      // 409 必須帶後端當前的 hash，否則前端重取後不知道基準是什麼
      expect(result.contentHash).toBe(before.contentHash);
      expect(result.reason).toContain('stale_hash');
    } finally {
      await resetChaos();
    }
  });
});

describe('後處理、重切、3D', () => {
  let lastMaskGridId = '';
  async function ready(phantomId: string): Promise<TransportClient> {
    const scene = await loadPhantom(phantomId);
    const transport = new TransportClient({ baseUrl: BASE_URL });
    const grids = await transport.createGrids({
      studyId: scene.studyId,
      primarySeriesId: scene.seriesIds[0]!,
      seriesIds: scene.seriesIds,
      capability: TIER_A,
    });
    lastMaskGridId = grids.gridSet.maskGrid.maskGridId;
    return transport;
  }

  it('GET /ops 的 schema 足以動態產生 UI（封閉的 x-ui-widget 詞彙）', async () => {
    const transport = await ready('overlap_set');
    const ops = await transport.listOps();
    const allowed = new Set([
      'number',
      'integer',
      'boolean',
      'enum',
      'structure-picker',
      'slice-range',
      // 閾值分割與區域生長
      'hu-range',
      'seed',
      'bbox',
    ]);
    expect(ops.length).toBeGreaterThan(0);
    for (const op of ops) {
      const schema = op.params_schema as { properties: Record<string, Record<string, unknown>> };
      for (const [name, prop] of Object.entries(schema.properties)) {
        expect(allowed.has(prop['x-ui-widget'] as string), `${String(op.op)}.${name}`).toBe(true);
      }
    }
  });

  it('後處理回傳新 payload，且 parentHash 指向前一版', async () => {
    const transport = await ready('overlap_set');
    const before = await transport.fetchMask('gtv');
    const after = await transport.postprocess({
      structureId: 'gtv',
      op: 'smooth',
      params: { sigma_mm: 2 },
      baseContentHash: before.contentHash,
    });
    expect(after.provenance.source).toBe('post-process');
    expect(after.provenance.parentHash).toBe(before.contentHash);
    expect(after.voxels.length).toBe(after.sizeIjk[0] * after.sizeIjk[1] * after.sizeIjk[2]);
  });

  it('新建 → 區域生長（種子在球心）→ 複製 → 改名 → 刪除，全部真的打後端', async () => {
    const transport = await ready('overlap_set');
    const structures = await transport.fetchStructures();
    const forUid = structures[0]!.frameOfReferenceUid;
    const created = await transport.createStructure({ name: 'PTV_7000', colorRgb: [255, 0, 0], frameOfReferenceUid: forUid, maskGridId: lastMaskGridId });
    expect(created.structureId).toBeTruthy();
    expect(created.tg263Suggestion).not.toBeNull();
    // 種子放 gtv 的 bbox 中心（那裡是球內）；region_grow 由 GET /ops 宣告，schema 帶 seed／hu-range
    const ops = await transport.listOps();
    expect(ops.map((o) => o.op)).toEqual(expect.arrayContaining(['threshold', 'region_grow']));
    const gtv = await transport.fetchMask('gtv');
    const seed = gtv.offsetIjk.map((o, i) => o + Math.floor(gtv.sizeIjk[i]! / 2)) as [number, number, number];
    const grown = await transport.postprocess({
      structureId: created.structureId,
      op: 'region_grow',
      params: { seed_ijk: seed, hu_range: [-2000, 4000], connectivity: 26, per_slice: false, mode: 'union' },
      baseContentHash: created.contentHash,
    });
    expect(grown.voxels.some((v) => v !== 0)).toBe(true);
    const copy = await transport.copyStructure(created.structureId);
    expect(copy.structureId).toMatch(/_copy\d+$/);
    await transport.updateStructure(copy.structureId, { name: 'PTV_7000_copy', colorRgb: [0, 255, 0] });
    const listed = await transport.fetchStructures();
    const renamed = listed.find((s) => s.structureId === copy.structureId);
    expect(renamed?.name).toBe('PTV_7000_copy');
    expect(renamed?.colorRgb).toEqual([0, 255, 0]);
    await transport.deleteStructure(created.structureId);
    await transport.deleteStructure(copy.structureId);
    const after = await transport.fetchStructures();
    expect(after.map((s) => s.structureId)).not.toEqual(expect.arrayContaining([created.structureId, copy.structureId]));
  });

  it('B-spline 重切回傳 Float32 平面（Tier C 的畫質補強路徑）', async () => {
    const transport = await ready('anisotropic');
    const structures = await transport.fetchStructures();
    const forUid = structures[0]!.frameOfReferenceUid;
    const { header, plane } = await transport.fetchHighQualityReslice({
      viewReference: {
        frameOfReferenceUid: forUid,
        displayGridId: 'dg_e2e',
        planeOrigin: [0, 0, 0],
        viewPlaneNormal: [0, 0.3826834323650898, 0.9238795325112867],
        viewUp: [0, 0.9238795325112867, -0.3826834323650898],
        slabThicknessMm: 0,
        temporalGroupId: null,
        frameIndex: null,
      },
      outputSizePx: [128, 128],
      interpolator: 'bspline',
    });
    expect(plane).toBeInstanceOf(Float32Array);
    expect(plane.length).toBe(128 * 128);
    expect(header.interpolator).toBe('bspline');
    expect(Math.max(...plane)).toBeGreaterThan(Math.min(...plane));
  });

  it('render3d 回 PNG（Tier C 的 volume-3d 退路真的走得通）', async () => {
    const transport = await ready('overlap_set');
    const structures = await transport.fetchStructures();
    const scene = await loadPhantom('overlap_set');
    await transport.createGrids({
      studyId: scene.studyId,
      primarySeriesId: scene.seriesIds[0]!,
      seriesIds: scene.seriesIds,
      capability: TIER_A,
    });
    const content = await transport.fetchRender3d({
      camera: {
        frame_of_reference_uid: structures[0]!.frameOfReferenceUid,
        display_grid_id: 'dg_e2e',
        plane_origin: [0, 0, 0],
        view_plane_normal: [0, 0.5, 0.8660254037844386],
        view_up: [0, 0.8660254037844386, -0.5],
        slab_thickness_mm: 0,
        temporal_group_id: null,
        frame_index: null,
        distance_mm: 500,
        fov_deg: 30,
      },
      output_size_px: [96, 96],
      layers: [
        {
          renderer: 'volume-3d',
          series_id: scene.seriesIds[0],
          window: { center: 400, width: 1800 },
          opacity: 1,
        },
      ],
    });
    const { png, header } = content.data as { png: Uint8Array; header: Record<string, unknown> };
    expect([...png.subarray(0, 4)]).toEqual([0x89, 0x50, 0x4e, 0x47]);
    expect(header.width).toBe(96);
    // 前端據 camera_used 標註與偵測過期
    expect(header.camera_used).toBeTruthy();
  });
});

describe('Push 通道 —— 真的 WebSocket', () => {
  it('連上就收到 scene.replace，且 layer 通過 fromWire 驗證', async () => {
    await loadPhantom('two_series');
    const layers: Layer[] = [];
    const scenes: Record<string, unknown>[] = [];
    const channel = new PushChannel(`${WS_URL}/api/v1/session/current/events`, {
      onScene: (scene) => {
        scenes.push(scene);
        for (const raw of scene.layers as Record<string, unknown>[]) {
          layers.push(fromWire.layer(raw));
        }
      },
    });
    channel.connect();
    try {
      await waitUntil(() => scenes.length > 0, 10_000);
    } finally {
      channel.close();
    }
    expect(layers.length).toBe(4);
    expect(layers.filter((l) => l.kind === 'image')).toHaveLength(2);
    expect(layers.filter((l) => l.kind === 'mask')).toHaveLength(2);
    // outline 是預設模式
    expect(layers.filter((l) => l.kind === 'mask').every((l) => l.renderStyle === 'outline')).toBe(
      true,
    );
  });

  it('編輯後收到 mask.updated（只有 metadata）', async () => {
    const scene = await loadPhantom('gantry_tilt');
    const transport = new TransportClient({ baseUrl: BASE_URL });
    await transport.createGrids({
      studyId: scene.studyId,
      primarySeriesId: scene.seriesIds[0]!,
      seriesIds: scene.seriesIds,
      capability: TIER_A,
    });
    const updates: { structureId: string; contentHash: string }[] = [];
    let sceneCount = 0;
    const channel = new PushChannel(`${WS_URL}/api/v1/session/current/events`, {
      onScene: () => {
        sceneCount += 1;
      },
      onMaskUpdated: (info) => updates.push(info),
    });
    channel.connect();
    try {
      await waitUntil(() => sceneCount > 0, 10_000);
      const before = await transport.fetchMask('lesion');
      await transport.submitEdit({
        structureId: 'lesion',
        frameIndex: null,
        baseContentHash: before.contentHash,
        clientSeq: 1,
        offsetIjk: [300, 300, 40],
        sizeIjk: [2, 2, 1],
        data: new Uint8Array(4).fill(1),
        viewReference: {
          frameOfReferenceUid: before.header.frame_of_reference_uid as string,
          displayGridId: 'dg_e2e',
          planeOrigin: [0, 0, 0],
          viewPlaneNormal: [0, 0, 1],
          viewUp: [0, -1, 0],
          slabThicknessMm: 0,
          temporalGroupId: null,
          frameIndex: null,
        },
      });
      await waitUntil(() => updates.length > 0, 10_000);
    } finally {
      channel.close();
    }
    expect(updates[0]!.structureId).toBe('lesion');
    expect(updates[0]!.contentHash).toMatch(/^mh_/);
  });

  it('chaos: disconnect → PushChannel 自動重連', async () => {
    await loadPhantom('landmark');
    await fetch(`${BASE_URL}/api/v1/_test/chaos`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ disconnect: true, disconnect_probability: 1.0 }),
    });
    const attempts: number[] = [];
    let scenes = 0;
    const channel = new PushChannel(
      `${WS_URL}/api/v1/session/current/events`,
      {
        onScene: () => {
          scenes += 1;
        },
        onReconnect: (attempt) => attempts.push(attempt),
      },
      undefined,
      100,
    );
    channel.connect();
    try {
      // 伺服器在每次收到 client 訊息後就關閉 → 前端必須重連
      await waitUntil(() => attempts.length >= 1 && scenes >= 2, 20_000);
    } finally {
      channel.close();
      await resetChaos();
    }
    expect(attempts[0]).toBe(1);
    // 重新同步不需前端額外做事：重連後伺服器又推一次 scene.replace
    expect(scenes).toBeGreaterThanOrEqual(2);
  });
});

describe('契約層 → 場景層：SceneManager 吃真實的 GridSet', () => {
  it('真實 GridSet ＋ 真實圖層 → handle 記帳與 zBand 排序', async () => {
    const scene = await loadPhantom('overlap_set');
    const transport = new TransportClient({ baseUrl: BASE_URL });
    const { gridSet } = await transport.createGrids({
      studyId: scene.studyId,
      primarySeriesId: scene.seriesIds[0]!,
      seriesIds: scene.seriesIds,
      capability: TIER_A,
    });
    const layers = scene.rawLayers.map((raw) => fromWire.layer(raw));

    const manager = new SceneManager({
      gridSet,
      tier: gridSet.assignedTier,
      budgetBytes: budgetFor(gridSet.assignedTier, scene.seriesIds.length).totalBytes,
      transport,
      createHandle: (args) => makeStubHandle({ ...args, ownBytes: 1_000_000 }),
    });
    try {
      manager.attachViewport({ viewportId: 'axial', is3D: false, width: 512, height: 512 });
      manager.attachViewport({ viewportId: 'v3d', is3D: true, width: 512, height: 512 });
      manager.setLayers(layers);

      // image 在 mask 之下（zBand 決定，不是插入順序）
      const ordered = manager.orderedLayers();
      expect(ordered[0]!.kind).toBe('image');
      expect(ordered.at(-1)!.kind).toBe('mask');

      // 8 個 layer × 2 個 viewport，但 mask 在 3D 不產生 handle
      const breakdown = manager.residencyBreakdown();
      const byRenderer = new Map<string, number>();
      for (const entry of breakdown) {
        byRenderer.set(entry.rendererId, (byRenderer.get(entry.rendererId) ?? 0) + 1);
      }
      expect(byRenderer.get('mask-outline')).toBe(7); // 只在 axial
      expect(byRenderer.get('image')).toBe(1); // 2D viewport
      expect(byRenderer.get('volume-3d')).toBe(1); // 3D viewport
      expect(manager.residentBytes()).toBeGreaterThan(0);

      // 群組批次開關 → 可見性驅動常駐
      manager.setGroupVisible('structures', false);
      expect(manager.orderedLayers().filter((l) => l.kind === 'mask').every((l) => !l.visible)).toBe(
        true,
      );
    } finally {
      manager.dispose();
    }
  });

  it('I4：後端換了 display grid 時只有影像失效', async () => {
    const scene = await loadPhantom('huge');
    const transport = new TransportClient({ baseUrl: BASE_URL });
    const tierA = await transport.createGrids({
      studyId: scene.studyId,
      primarySeriesId: scene.seriesIds[0]!,
      seriesIds: scene.seriesIds,
      capability: TIER_A,
    });
    const tierB = await transport.createGrids({
      studyId: scene.studyId,
      primarySeriesId: scene.seriesIds[0]!,
      seriesIds: scene.seriesIds,
      capability: { ...TIER_A, probeFps: 15, tier: 'B' },
    });
    // 🔴 降 Tier 換掉了 display grid，但 mask grid **不動**
    expect(tierB.gridSet.displayGrid.displayGridId).not.toBe(
      tierA.gridSet.displayGrid.displayGridId,
    );
    expect(tierB.gridSet.maskGrid.maskGridId).toBe(tierA.gridSet.maskGrid.maskGridId);

    const manager = new SceneManager({
      gridSet: tierA.gridSet,
      tier: 'A',
      budgetBytes: budgetFor('A', 1).totalBytes,
      transport,
      createHandle: (args) => makeStubHandle({ ...args, ownBytes: 1_000_000 }),
    });
    try {
      const dropped = manager.updateGridSet(tierB.gridSet);
      expect([...dropped]).toEqual(['image']);
    } finally {
      manager.dispose();
    }
  });

  it('幾何自檢：八個角的世界座標與 expected.json 一致', async () => {
    const scene = await loadPhantom('gantry_tilt');
    const transport = new TransportClient({ baseUrl: BASE_URL });
    const { gridSet } = await transport.createGrids({
      studyId: scene.studyId,
      primarySeriesId: scene.seriesIds[0]!,
      seriesIds: scene.seriesIds,
      capability: TIER_A,
    });
    const expected = (await (await fetch(`${BASE_URL}/api/v1/_test/expected`)).json()) as {
      series: Record<string, { corners_world_lps: number[][] }>;
    };
    const entry = Object.values(expected.series)[0]!;
    const corners = cornersWorld(gridSet.maskGrid.grid);
    entry.corners_world_lps.forEach((corner, n) => {
      for (let k = 0; k < 3; k += 1) {
        expect(Math.abs(corners[n]![k]! - corner[k]!)).toBeLessThan(1e-9);
      }
    });
  });
});

async function waitUntil(predicate: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('等待條件逾時');
}
