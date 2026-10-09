/**
 * 十字線讀數的驗收。
 *
 * 讀數有五條驗收，這裡逐條對應。**素材一律用既有的 fixture 與假體幾何**，
 * 不自己編數字 —— `landmark` 的 `(37, 61, 13) = 3000` 是後端產生的已知答案
 * （`scripts/emit-geometry-fixture.py`），與座標轉換的跨語言驗收共用同一份。
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { createGrid, indexToWorld, type Grid } from '../src/core/geometry';
import type { DisplayGrid, FrameGroup } from '../src/core/geometry';
import type { Layer } from '../src/core/layers/types';
import { fromWire } from '../src/core/transport/wire';
import {
  formatReadingValue,
  formatWorldMm,
  probeImageLayers,
  unitForModality,
} from '../src/core/scene/probe';
import type { ImageEntry } from '../src/core/scene/volumeStore';

const fixture = JSON.parse(
  readFileSync(join(__dirname, 'fixtures/geometry-vectors.json'), 'utf8'),
) as {
  landmark: {
    ijk: [number, number, number];
    world_lps: [number, number, number];
    voxel_value: number;
    grid: Record<string, unknown>;
  };
  grid_cases: { name: string; grid: Record<string, unknown> }[];
  display_grid_cases: { source_grid: Record<string, unknown> };
};

/** fixture 存的是 **wire 形狀**（snake_case）—— 一律經 `fromWire` 解，不手抄欄位。 */
const wireGrid = (w: Record<string, unknown>): Grid => fromWire.grid(w);

const SERIES = 'series-1';
const FOR_UID = 'for-primary';

function gridCase(prefix: string): Grid {
  const found = fixture.grid_cases.find((c) => c.name.startsWith(prefix));
  if (found === undefined) throw new Error(`fixture 缺 grid case: ${prefix}`);
  return wireGrid(found.grid);
}

/**
 * 把一個 fixture 網格縮成 8³ 但**保留 spacing 與 direction**。
 *
 * 512×512×60 的 Int16 是 31 MB，測試裡不需要 —— 而驗收 2 要抓的是
 * **非等向 spacing 與傾斜 direction**，跟 size 無關。origin 也保留，因此
 * `indexToWorld` 的絕對值仍是真實的。
 */
function shrink(grid: Grid, size: [number, number, number] = [8, 8, 8]): Grid {
  return createGrid({ ...grid, size });
}

/** 鏡像後端 `DisplayGrid.for_tier` 的降採樣規則（`display_grid.py:137-145`）。 */
function downsampled(source: Grid, factor: [number, number, number]): Grid {
  const offsetCenter: [number, number, number] = [
    (factor[0] - 1) / 2,
    (factor[1] - 1) / 2,
    (factor[2] - 1) / 2,
  ];
  return createGrid({
    ...source,
    size: [
      Math.floor(source.size[0] / factor[0]),
      Math.floor(source.size[1] / factor[1]),
      Math.floor(source.size[2] / factor[2]),
    ],
    spacing: [
      source.spacing[0] * factor[0],
      source.spacing[1] * factor[1],
      source.spacing[2] * factor[2],
    ],
    origin: indexToWorld(source, offsetCenter),
  });
}

function displayGrid(
  grid: Grid,
  sourceGrid: Grid = grid,
  downsampleFactor: [number, number, number] = [1, 1, 1],
): DisplayGrid {
  return {
    grid,
    sourceGrid,
    cropOffsetIjk: [0, 0, 0],
    downsampleFactor,
    dtype: 'int16',
    windowBaked: null,
    displayGridId: 'dg_test',
  };
}

function imageLayer(modality = 'CT', overrides: Partial<Layer> = {}): Layer {
  return {
    layerId: `image:${SERIES}`,
    kind: 'image',
    label: `${modality} （主）`,
    groupId: 'images',
    frameOfReferenceUid: FOR_UID,
    contentRef: SERIES,
    visible: true,
    opacity: 1,
    order: 0,
    modality,
    ...overrides,
  };
}

function primaryGroup(frameOfReferenceUid = FOR_UID): FrameGroup {
  return {
    frameOfReferenceUid,
    seriesId: SERIES,
    role: 'primary',
    transformToPrimary: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
    transformKind: 'identity',
    coverageMaskId: null,
  };
}

/** 在 `ijk` 放一個已知值，其餘為 `fill`。 */
function entryWith(
  grid: Grid,
  marks: { ijk: [number, number, number]; value: number }[],
  opts: { lod?: number; seriesId?: string; fill?: number } = {},
): ImageEntry {
  const [nx, ny, nz] = grid.size;
  const voxels = new Int16Array(nx * ny * nz).fill(opts.fill ?? -1000);
  for (const mark of marks) {
    voxels[mark.ijk[0] + nx * (mark.ijk[1] + ny * mark.ijk[2])] = mark.value;
  }
  return {
    seriesId: opts.seriesId ?? SERIES,
    lod: opts.lod ?? 0,
    grid,
    voxels,
    defaultWindow: { center: 40, width: 400 },
  };
}

function probeOnce(args: {
  world: readonly [number, number, number];
  layers: Layer[];
  dg: DisplayGrid;
  entry?: ImageEntry | undefined;
  frameGroup?: FrameGroup;
}) {
  return probeImageLayers({
    world: args.world,
    layers: args.layers,
    displayGrid: args.dg,
    imageFor: () => args.entry,
    frameGroupFor: () => args.frameGroup ?? primaryGroup(),
  });
}

describe('驗收 1 —— landmark 的已知體素', () => {
  const { ijk, world_lps: world, voxel_value: value } = fixture.landmark;
  const grid = wireGrid(fixture.landmark.grid);

  it('讀數的 ijk、值、單位都對得上後端的已知答案', () => {
    const source = grid;
    const readings = probeOnce({
      world,
      layers: [imageLayer('CT')],
      dg: displayGrid(source),
      entry: entryWith(source, [{ ijk, value }]),
    });

    expect(readings).toHaveLength(1);
    const [reading] = readings;
    expect(reading!.acquisitionIjk).toEqual(ijk);
    expect(reading!.value).toBe(value);
    expect(reading!.unit).toBe('HU');
    expect(reading!.approximate).toBe(false);
    expect(reading!.unavailable).toBeNull();
    expect(formatReadingValue(reading!)).toBe(`${value} HU`);
  });

  it('世界座標與 indexToWorld 一致（座標轉換驗收在讀數上的延伸）', () => {
    expect(indexToWorld(grid, ijk)).toEqual(world);
  });
});

describe('驗收 2 —— 非等向與傾斜取像', () => {
  // 🔴 軸對齊的等向網格抓不到漏傳 direction 與 spacing。這兩個 case 才會抓到。
  for (const [name, base] of [
    ['anisotropic（1×1×5 mm）', shrink(gridCase('anisotropic'))],
    ['gantry_tilt（傾斜 15°）', shrink(wireGrid(fixture.display_grid_cases.source_grid))],
  ] as const) {
    it(`${name} 上每個體素中心都讀回自己`, () => {
      const dg = displayGrid(base);
      const entry = entryWith(base, []);
      for (const ijk of [
        [0, 0, 0],
        [3, 5, 2],
        [7, 7, 7],
        [1, 6, 4],
      ] as [number, number, number][]) {
        const world = indexToWorld(base, ijk);
        const readings = probeOnce({ world, layers: [imageLayer()], dg, entry });
        expect(readings[0]!.acquisitionIjk, `ijk=${ijk.join(',')}`).toEqual(ijk);
      }
    });
  }
});

describe('驗收 3 —— Tier A 與 Tier B 必須一致', () => {
  const source = shrink(wireGrid(fixture.display_grid_cases.source_grid), [16, 16, 8]);
  const coarse = downsampled(source, [2, 2, 1]);
  const ijk: [number, number, number] = [8, 6, 4];
  const world = indexToWorld(source, ijk);

  it('索引欄完全相同，且 Tier B 標 ≈', () => {
    const tierA = probeOnce({
      world,
      layers: [imageLayer()],
      dg: displayGrid(source),
      entry: entryWith(source, [{ ijk, value: 700 }]),
    })[0]!;

    const tierB = probeOnce({
      world,
      layers: [imageLayer()],
      dg: displayGrid(coarse, source, [2, 2, 1]),
      entry: entryWith(coarse, [], { fill: 640 }),
    })[0]!;

    // 索引一律以 source_grid 表達 → 兩個 Tier 必須完全相同
    expect(tierB.acquisitionIjk).toEqual(tierA.acquisitionIjk);
    expect(tierA.acquisitionIjk).toEqual(ijk);

    // Tier A 是取像值、Tier B 不是 —— 而且必須說出來
    expect(tierA.approximate).toBe(false);
    expect(tierB.approximate).toBe(true);
    expect(formatReadingValue(tierB).startsWith('≈ ')).toBe(true);
  });

  it('lod 還沒到全解析度時也要標 ≈', () => {
    const reading = probeOnce({
      world,
      layers: [imageLayer()],
      dg: displayGrid(source),
      entry: entryWith(source, [{ ijk, value: 700 }], { lod: 2 }),
    })[0]!;
    expect(reading.approximate).toBe(true);
  });
});

describe('驗收 4 —— slab 與互動狀態不得改變讀數', () => {
  /**
   * 🔴 這是**結構上**的保證，不是紀律：`probeImageLayers` 的簽章裡沒有
   * `camera`、`quality`、`slabThicknessMm`，因此它**沒有能力**看到 slab 或
   * 互動態的降解析度。若有人日後把它們加進參數，這條測試的存在會迫使他
   * 解釋為什麼。
   */
  it('同一個世界座標永遠給同一個讀數', () => {
    const source = shrink(gridCase('anisotropic'));
    const ijk: [number, number, number] = [4, 4, 4];
    const world = indexToWorld(source, ijk);
    const args = {
      world,
      layers: [imageLayer()],
      dg: displayGrid(source),
      entry: entryWith(source, [{ ijk, value: 123 }]),
    };
    expect(probeOnce(args)).toEqual(probeOnce(args));
    expect(probeOnce(args)[0]!.value).toBe(123);
  });
});

describe('驗收 5 —— 體積外不得顯示填充值', () => {
  const source = shrink(gridCase('anisotropic'));

  it('落在體積外時 value 為 null，而不是 −1024', () => {
    // 往 +i 方向走出網格 20 個體素
    const world = indexToWorld(source, [source.size[0] + 20, 4, 4]);
    const reading = probeOnce({
      world,
      layers: [imageLayer()],
      dg: displayGrid(source),
      entry: entryWith(source, []),
    })[0]!;

    expect(reading.value).toBeNull();
    expect(reading.acquisitionIjk).toBeNull();
    expect(reading.unavailable).toBe('outside-volume');
    expect(formatReadingValue(reading)).toBe('—');
    // 🔴 OUTSIDE_HU 是繪圖常數，不是資料
    expect(formatReadingValue(reading)).not.toContain('1024');
  });

  it('體素還沒常駐時說「還沒載入」，不是體積外', () => {
    const reading = probeOnce({
      world: indexToWorld(source, [4, 4, 4]),
      layers: [imageLayer()],
      dg: displayGrid(source),
      entry: undefined,
    })[0]!;
    expect(reading.unavailable).toBe('not-resident');
    expect(formatReadingValue(reading)).toBe('—');
  });
});

describe('次要序列要走 transformToPrimary 的逆變換', () => {
  const source = shrink(gridCase('anisotropic'));
  const ijk: [number, number, number] = [3, 3, 3];

  it('平移過的次要序列取到正確的體素', () => {
    const shift = 12; // mm，沿 +x
    const secondary: FrameGroup = {
      frameOfReferenceUid: 'for-secondary',
      seriesId: 'series-2',
      role: 'secondary',
      // column-major 4×4：最後一欄是平移
      transformToPrimary: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, shift, 0, 0, 1],
      transformKind: 'rigid',
      coverageMaskId: null,
    };
    const seriesWorld = indexToWorld(source, ijk);
    // 這個體素在 primary 世界座標裡的位置 = 序列自身座標 ＋ 平移
    const primaryWorld: [number, number, number] = [
      seriesWorld[0] + shift,
      seriesWorld[1],
      seriesWorld[2],
    ];

    const reading = probeOnce({
      world: primaryWorld,
      layers: [imageLayer('CT', { frameOfReferenceUid: 'for-secondary' })],
      dg: displayGrid(source),
      entry: entryWith(source, [{ ijk, value: 55 }]),
      frameGroup: secondary,
    })[0]!;

    expect(reading.value).toBe(55);

    // 🔴 漏掉逆變換就會取到偏移 12 mm（= 12 個體素）的位置。這裡證明那會錯：
    const withoutInverse = probeOnce({
      world: primaryWorld,
      layers: [imageLayer('CT', { frameOfReferenceUid: 'for-secondary' })],
      dg: displayGrid(source),
      entry: entryWith(source, [{ ijk, value: 55 }]),
      frameGroup: primaryGroup('for-secondary'), // 單位矩陣 = 忘了變換
    })[0]!;
    expect(withoutInverse.value).not.toBe(55);
  });
});

describe('單位必須由模態導出', () => {
  it.each([
    ['CT', 'HU'],
    ['CBCT', 'HU'],
    ['ct', 'HU'],
    ['RTDOSE', 'Gy'],
    ['MR', 'a.u.'],
    ['PT', 'a.u.'],
    ['', 'a.u.'],
  ] as const)('%s → %s', (modality, unit) => {
    expect(unitForModality(modality)).toBe(unit);
  });

  it('🔴 MR 不得標成 HU（在 MR 上標 HU 是臨床看得見的錯誤）', () => {
    expect(unitForModality('MR')).not.toBe('HU');
    expect(unitForModality(undefined)).not.toBe('HU');
  });

  it('缺 modality 的 layer 不會被當成 CT', () => {
    const source = shrink(gridCase('anisotropic'));
    const layer = imageLayer('CT');
    delete (layer as { modality?: string }).modality;
    const reading = probeOnce({
      world: indexToWorld(source, [2, 2, 2]),
      layers: [layer],
      dg: displayGrid(source),
      entry: entryWith(source, []),
    })[0]!;
    expect(reading.unit).toBe('a.u.');
  });

  it('劑量取三位小數，HU 取整數（顯示精度不得暗示超過資料的精度）', () => {
    const base = {
      layerId: 'l',
      seriesId: 's',
      label: 'x',
      acquisitionIjk: [0, 0, 0] as const,
      approximate: false,
      unavailable: null,
    };
    expect(formatReadingValue({ ...base, value: 42.7, unit: 'HU' })).toBe('43 HU');
    expect(formatReadingValue({ ...base, value: 1.23456, unit: 'Gy' })).toBe('1.235 Gy');
  });
});

describe('其他規則', () => {
  it('只讀可見的 image layer —— 隱藏的與 mask 都不算', () => {
    const source = shrink(gridCase('anisotropic'));
    const readings = probeOnce({
      world: indexToWorld(source, [2, 2, 2]),
      layers: [
        imageLayer('CT'),
        imageLayer('MR', { layerId: 'image:hidden', visible: false }),
        { ...imageLayer('CT'), layerId: 'mask:Body', kind: 'mask' },
      ],
      dg: displayGrid(source),
      entry: entryWith(source, []),
    });
    expect(readings.map((r) => r.layerId)).toEqual([`image:${SERIES}`]);
  });

  it('世界座標取 1 位小數', () => {
    expect(formatWorldMm([-31.800000000000004, -3, -16.25])).toBe('-31.8, -3.0, -16.3');
  });
});
