/**
 * 十字線讀數：物理座標 ＋ 體素值。
 *
 * ## 這裡不是量測
 *
 * 量測的「標記點」是**被建立、被儲存、會被輸出**的物件；讀數是**畫面狀態**，
 * 不進資料模型、不進 provenance、不會被輸出。因此它住在 `scene/` 而不是
 * `layers/`，而且是純函式 —— 沒有任何狀態需要保存。
 *
 * ## 六條規則落在哪
 *
 * | 規則 | 落在 |
 * |---|---|
 * | **R1** 取最近鄰體素，不取顯示平面的內插值 | `worldToNearestVoxel(entry.grid, …)` ＋ 直接索引 `entry.voxels`。**完全不經過重切核心** |
 * | **R1b** 索引欄一律以 `source_grid` 表達 | `sourceGridFor()` |
 * | **R1c** 取樣網格比取像網格粗時標 `≈` | `approximate` |
 * | **R2** slab > 0 不得顯示混合值 | 本模組**不知道 slab 存在** —— 它只吃一個 3D 點。這是型別層面的保證，不是紀律 |
 * | **R4** 體積外顯示 `—`，不得顯示填充值 | `unavailable: 'outside-volume'`，`value` 為 `null`。**這裡刻意不回傳 `OUTSIDE_HU`** |
 * | **R5** 次要序列經 `transformToPrimary` 逆變換 | `fromPrimaryWorld()` |
 * | **R6** 帶時間軸的序列取當前相位 | 由呼叫端的 `imageFor` 決定（它拿的是當前相位的常駐體積） |
 */

import {
  containsIndex,
  fromPrimaryWorld,
  worldToNearestVoxel,
  type DisplayGrid,
  type FrameGroup,
  type Grid,
  type Vec3,
} from '../geometry';
import type { Layer } from '../layers/types';
import type { ImageEntry, MaskEntry } from './volumeStore';

/**
 * 體素值的單位。
 *
 * 🔴 **不得一律標成 `'HU'`。** 第一個接上的模態一定是 CT，因此把 `'HU'` 寫成
 * 常數不會有任何測試變紅 —— 而在 MR 上標 HU 是臨床看得見的錯誤。
 *
 * PET 由後端依 DICOM `Units` 換算 —— 標籤齊就是 `SUV`，不齊是 `Bq/ml`（或 `counts` 等原單位），
 * 放在 image layer 的 `params.value_unit`。
 */
export type VoxelUnit = 'HU' | 'Gy' | 'a.u.' | 'SUV' | 'Bq/ml' | (string & {});

/**
 * 模態 → 單位。沒有 `params.value_unit` 時的退路：PT 沒有標就是 `'a.u.'`
 * （規格允許「無法判定時顯示 stored value 並標 `a.u.`」）。
 */
export function unitForModality(modality: string | null | undefined): VoxelUnit {
  switch ((modality ?? '').toUpperCase()) {
    case 'CT':
    case 'CBCT':
      return 'HU';
    case 'RTDOSE':
      return 'Gy';
    default:
      // MR 沒有絕對單位；不明模態一律照實說
      return 'a.u.';
  }
}

/** 各單位該顯示幾位小數 —— **顯示精度不得暗示超過資料本身的精度**。SUV 存 ×100 → 2 位。 */
export function decimalsForUnit(unit: VoxelUnit): number {
  if (unit === 'Gy') return 3;
  if (unit === 'SUV') return 2;
  return 0;
}

/**
 * image layer 的值怎麼讀 —— 單位 ＋ 存的值要乘多少才是那個單位（PET 存 SUV×100 → 0.01）。
 * 讀數、W/L 欄位、閾值筆刷、量測統計都經過這裡；後端沒給（CT、MR）→ 模態的單位、比例 1。
 */
export interface ValueScale {
  readonly unit: VoxelUnit;
  readonly scale: number;
}

export function valueScaleOf(layer: { readonly modality?: string; readonly params?: Readonly<Record<string, unknown>> } | null | undefined): ValueScale {
  const p = layer?.params;
  const unit = typeof p?.value_unit === 'string' && p.value_unit !== '' ? p.value_unit : unitForModality(layer?.modality);
  const raw = p?.value_scale;
  const scale = typeof raw === 'number' && Number.isFinite(raw) && raw > 0 ? raw : 1;
  return { unit, scale };
}

/** 存的值 → 顯示的值（四捨五入到該單位的小數位數，避免 0.01 × 123 ＝ 1.2300000000000002）。 */
export function toDisplayValue(stored: number, vs: ValueScale): number {
  if (vs.scale === 1) return stored;
  const f = 10 ** decimalsForUnit(vs.unit);
  return Math.round(stored * vs.scale * f) / f;
}

/** 顯示的值（使用者輸入）→ 存的值。 */
export function toStoredValue(display: number, vs: ValueScale): number {
  return vs.scale === 1 ? display : display / vs.scale;
}

export interface ProbeReading {
  readonly layerId: string;
  readonly seriesId: string;
  readonly label: string;
  /** `source_grid`（取像網格）的最近鄰索引。體積外為 null（R1b、R4）。 */
  readonly acquisitionIjk: readonly [number, number, number] | null;
  /** 體素值。**體積外或尚未常駐時為 null，絕不是填充值**（R4）。 */
  readonly value: number | null;
  readonly unit: VoxelUnit;
  /** 取樣網格比取像網格粗 → UI 必須標 `≈`（R1c）。 */
  readonly approximate: boolean;
  /** null = 有值。非 null 才是「為什麼沒有值」—— 不要用 `??` 吞掉它。 */
  readonly unavailable: 'outside-volume' | 'not-resident' | null;
}

export interface ProbeReadout {
  /** primary 世界座標，LPS mm。 */
  readonly world: readonly [number, number, number];
  readonly viewportId: string;
  /**
   * `pointer` = 指標正在該 viewport 內；`frozen` = 指標已離開，這是最後一次讀數。
   *
   * ⚠️ 規則上要求指標離開後回到**十字線**位置，但十字線本身
   * （`navigate` 工具）尚未實作。在它存在之前一律 `frozen`：**保留最後一次
   * 讀數而不是清空** —— 清空會讓使用者以為功能壞了。
   */
  readonly source: 'pointer' | 'frozen';
  readonly readings: readonly ProbeReading[];
  /** 這一點落在哪些**顯示中**的結構裡（與未載入而無法判斷的）。舊呼叫端沒給 ＝ 不列。 */
  readonly structures?: ProbeStructures;
}

/** 一個點所在的結構（只看顯示中的）。 */
export interface ProbeStructureHit {
  readonly layerId: string;
  readonly structureId: string;
  readonly label: string;
  readonly colorRgb: readonly [number, number, number] | null;
}

export interface ProbeStructures {
  readonly inside: readonly ProbeStructureHit[];
  /** 顯示中但體素還沒常駐（分批載入中、Tier C 替代表示）—— 判斷不了，不能當作「不在裡面」（R4）。 */
  readonly notResident: readonly ProbeStructureHit[];
}

/**
 * 索引欄用哪個網格（R1b）。
 *
 * `DisplayGrid.sourceGrid` 是**主序列**的取像網格。GridSet 沒有記錄「display
 * grid 是從哪一個 series 導出的」，因此以 FrameGroup 的 role 判定；次要序列
 * 退回它自己常駐體積的網格。
 *
 * ⚠️ 融合尚未實作，因此目前恆為主序列這一支。接融合時這裡要改成由
 * 後端明說每個 series 的取像網格（標頭已有 grid，缺的是「這是取像網格
 * 還是顯示網格」這個標記）。
 */
function sourceGridFor(
  frameGroup: FrameGroup,
  displayGrid: DisplayGrid,
  entry: ImageEntry | undefined,
): Grid {
  if (frameGroup.role === 'primary') return displayGrid.sourceGrid;
  return entry?.grid ?? displayGrid.sourceGrid;
}

/** 兩個網格的 size 是否相同 —— 用來判斷取樣網格有沒有比取像網格粗。 */
function sameSize(a: Grid, b: Grid): boolean {
  return a.size[0] === b.size[0] && a.size[1] === b.size[1] && a.size[2] === b.size[2];
}

/**
 * 讀一個世界座標上的所有可見 image layer。
 *
 * 🔴 **O(1)，且不觸發任何重切或網路請求。** 這是效能規則，不是最佳化：
 * 讀數跟著指標移動，若它會觸發重切，移動滑鼠就等於在跑全解析度重繪。
 */
export function probeImageLayers(args: {
  world: Vec3;
  layers: readonly Layer[];
  displayGrid: DisplayGrid;
  imageFor: (seriesId: string) => ImageEntry | undefined;
  /** 攤開的那一張／這一格鎖定的相位要看自己的幀 —— 有給就優先用它（以 layer 取，不以序列）。 */
  imageForLayer?: (layer: Layer) => ImageEntry | undefined;
  frameGroupFor: (frameOfReferenceUid: string) => FrameGroup;
}): ProbeReading[] {
  const out: ProbeReading[] = [];
  for (const layer of args.layers) {
    if (layer.kind !== 'image' || !layer.visible) continue;
    const entry = args.imageForLayer ? args.imageForLayer(layer) : args.imageFor(layer.contentRef);
    const frameGroup = args.frameGroupFor(layer.frameOfReferenceUid);
    // R5：回到這個序列自己的世界座標再取樣
    const seriesWorld = fromPrimaryWorld(frameGroup, args.world);
    const sourceGrid = sourceGridFor(frameGroup, args.displayGrid, entry);
    const acqIjk = worldToNearestVoxel(sourceGrid, seriesWorld);
    const insideAcquisition = containsIndex(sourceGrid, acqIjk);
    const vs = valueScaleOf(layer);
    const unit = vs.unit;
    const base = {
      layerId: layer.layerId,
      seriesId: layer.contentRef,
      label: layer.label,
      acquisitionIjk: insideAcquisition ? acqIjk : null,
      unit,
    };

    if (entry === undefined) {
      out.push({ ...base, value: null, approximate: false, unavailable: 'not-resident' });
      continue;
    }
    const sampleIjk = worldToNearestVoxel(entry.grid, seriesWorld);
    if (!insideAcquisition || !containsIndex(entry.grid, sampleIjk)) {
      out.push({ ...base, value: null, approximate: false, unavailable: 'outside-volume' });
      continue;
    }
    const [nx, ny] = entry.grid.size;
    // 體素排列 `i + nx*j + nx*ny*k`（與重切核心的 `sample.rs` 同一個慣例）
    const offset = sampleIjk[0] + nx * (sampleIjk[1] + ny * sampleIjk[2]);
    const stored = entry.voxels[offset];
    out.push({
      ...base,
      value: stored === undefined ? null : toDisplayValue(stored, vs),
      // lod > 0 或 DisplayGrid 相對 source 有降採樣 → 這個值不是取像值（R1c）
      approximate: entry.lod > 0 || !sameSize(entry.grid, sourceGrid),
      unavailable: null,
    });
  }
  return out;
}

/** LPS mm，**1 位小數**（精度規則）。 */
export function formatWorldMm(world: readonly [number, number, number]): string {
  return world.map((v) => v.toFixed(1)).join(', ');
}

/** 值 ＋ 單位。體積外是 `—`，**不是 0、也不是填充值**（R4）。 */
export function formatReadingValue(reading: ProbeReading): string {
  if (reading.value === null) return '—';
  const text = reading.value.toFixed(decimalsForUnit(reading.unit));
  return `${reading.approximate ? '≈ ' : ''}${text} ${reading.unit}`;
}

/**
 * 一個世界座標落在哪些**顯示中**的結構裡。
 *
 * 規則與 `probeImageLayers` 相同：回到該結構自己的 FoR（有對位的 CBCT 結構也對）→ 取該 mask 區塊網格的**最近鄰**體素
 * → 在區塊內且值 ≠ 0 才算在裡面；所以跟畫面上的輪廓一致。slab > 0 時呼叫端仍只給中心點（R2）。
 * 🔴 O(顯示中的結構數) 次查表，不觸發重切或網路 —— 跟讀數同一條效能規則（每次指標移動都會跑）。
 */
export function probeStructures(args: {
  world: Vec3;
  layers: readonly Layer[];
  maskFor: (layer: Layer) => MaskEntry | undefined;
  frameGroupFor: (frameOfReferenceUid: string) => FrameGroup;
}): ProbeStructures {
  const inside: ProbeStructureHit[] = [];
  const notResident: ProbeStructureHit[] = [];
  for (const layer of args.layers) {
    if (layer.kind !== 'mask' || !layer.visible) continue;
    const hit: ProbeStructureHit = {
      layerId: layer.layerId,
      structureId: layer.contentRef,
      label: layer.label,
      colorRgb: layer.color ?? null,
    };
    const entry = args.maskFor(layer);
    if (entry === undefined) {
      notResident.push(hit);
      continue;
    }
    const own = fromPrimaryWorld(args.frameGroupFor(layer.frameOfReferenceUid), args.world);
    const ijk = worldToNearestVoxel(entry.blockGrid, own);
    if (!containsIndex(entry.blockGrid, ijk)) continue;
    const [nx, ny] = entry.sizeIjk;
    if ((entry.voxels[ijk[0] + nx * (ijk[1] + ny * ijk[2])] ?? 0) !== 0) inside.push(hit);
  }
  return { inside, notResident };
}

