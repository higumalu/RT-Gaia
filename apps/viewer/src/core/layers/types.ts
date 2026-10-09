/**
 * `Layer` —— 顯示的組織單位。
 */

import type { ViewReference } from '../geometry';

/**
 * 🔴 **開放型別，不是封閉聯集**。
 * 核心內建註冊 image / mask / mesh / measurement；模組可註冊新的 kind。
 */
export type LayerKind = string;

export const BUILTIN_KINDS = ['image', 'mask', 'mesh', 'measurement'] as const;

export type BlendMode = 'normal' | 'additive' | 'checkerboard' | 'difference';

/**
 * mask 的顯示樣式。
 *
 * 🔴 **`renderStyle` 決定「實例化哪些 renderer plugin」，不是單一 renderer 的
 * 顯示旗標**。`'fill+outline'` 因此產生**兩個** `LayerHandle`。
 */
export type MaskRenderStyle = 'fill' | 'outline' | 'fill+outline';

export type ProvenanceSource = 'model' | 'user-edit' | 'post-process' | 'import';

export interface Provenance {
  readonly source: ProvenanceSource;
  readonly parentHash: string | null;
  readonly moduleVersion: string;
  /** `source='user-edit'` 時必填。 */
  readonly viewReference: ViewReference | null;
  readonly createdAt: string;
}

/**
 * 量角類：`angle`（三點，頂點在中間）、`cobb`（兩條線的夾角）、`curve`（開放折線長度）。
 * `landmark`：配準的**地標對** —— 見 `Measurement.pairFrameOfReferenceUid`。
 */
export type MeasurementKind = 'distance' | 'area' | 'roi3d' | 'point' | 'angle' | 'cobb' | 'curve' | 'landmark';

export interface MeasurementResult {
  value: number;
  unit: 'mm' | 'mm2' | 'cc' | 'deg';
  /** `unit` ＝ 統計值的單位（影像的值單位：HU、SUV、Bq/ml…）；沒有 ＝ 舊資料，當 HU。 */
  stats?: { mean: number; min: number; max: number; stdev: number; voxelCount: number; unit?: string };
}

export interface Measurement {
  readonly measurementId: string;
  readonly kind: MeasurementKind;
  label: string;
  readonly frameOfReferenceUid: string;
  /** LPS mm，**世界座標**，非索引座標。 */
  points: Float64Array;
  /** 平面型（area）與 Cobb（量角的平面、決定兩條線的方向）必填；其餘為 null。 */
  viewReference: ViewReference | null;
  /**
   * 地標對的對應關係欄位 —— 只有 `landmark` 用。`points` ＝ [移動點（`frameOfReferenceUid` 自己的座標）,
   * 固定點（這個 FoR ＝ primary 的座標）]；TRE ＝ |T(移動點) − 固定點|，T 用**目前**的對位（微調中即時更新）。
   */
  readonly pairFrameOfReferenceUid?: string;
  /** 由 `points` 導出，**不進 wire**；host 算好掛上來給面板看。 */
  result?: MeasurementResult & { stats?: MeasurementResult['stats'] & { approximate?: boolean } };
  readonly provenance: Provenance;
}

export interface Layer {
  readonly layerId: string;
  readonly kind: LayerKind;
  label: string;
  groupId: string | null;
  /** 決定套用哪個變換。 */
  readonly frameOfReferenceUid: string;
  /** seriesId / structureId / measurementId / … */
  readonly contentRef: string;
  /**
   * 🔴 **直接驅動 GPU 常駐**：隱藏的 layer 其 texture 可被逐出。
   * 這是記憶體預算能成立的唯一機制。
   */
  visible: boolean;
  opacity: number;
  /** 混合順序，小的在下。**實際 zBand 由 renderer 宣告**。 */
  order: number;

  // kind='image' 專用
  /**
   * DICOM Modality（`CT` / `MR` / `PT` / `CBCT` / `RTDOSE` / …）。
   *
   * 🔴 **體素值的單位必須由這裡導出**，不得寫死成 `'HU'`。
   * 先前只有 `label` 字串裡帶著模態（`"CT （主）"`）—— 從字串解析單位是
   * 一個等著發生的臨床錯誤。
   */
  readonly modality?: string;
  windowLevel?: { center: number; width: number };
  colormap?: string;
  blendMode?: BlendMode;

  // kind='mask' 專用
  renderStyle?: MaskRenderStyle;
  color?: [number, number, number];

  // kind='measurement' 專用
  measurement?: Measurement;

  /** 所屬的時間軸群組；靜態 layer 為 null／undefined。 */
  temporalGroupId?: string | null;
  /** 帶時間軸的結構只存在於這幾幀（畫在 4DCT 某一相位上的 RTSTRUCT）；沒有 ＝ 每一幀都有。 */
  frames?: readonly number[];
  /**
   * 時間軸**攤開**成每一幀一張影像時，這張固定看第幾幀（不跟游標走）。
   * 仍帶 `temporalGroupId`（同一條時間軸；結構跟著作用中的那一幀）。沒有 ＝ 一般圖層。
   */
  readonly frameIndex?: number | null;
  /** 固定的那一幀叫什麼（「40%」「t = 30 s」）；面板顯示用。 */
  readonly frameLabel?: string;

  /**
   * 模組專屬參數。
   *
   * > `kind` 開放成 `string` 之後，模組註冊新
   * > kind 卻沒有地方放參數 → 還是要改核心型別。這個欄位讓核心不必認識任何
   * > 模組專屬的型別。
   */
  params?: Record<string, unknown>;

  /**
   * 序列描述：`patient_id`／`series_date`／`series_description`／
   * `manufacturer_model_name`／… snake_case 原樣。**只給面板顯示**，不進幾何。
   */
  readonly seriesMeta?: Record<string, unknown>;
}

/** 圖層群組（`groupId`）必須支援批次開關 —— 182 個結構逐一點是不可用的。 */
export interface LayerGroup {
  readonly groupId: string;
  label: string;
  collapsed: boolean;
}

export function isMaskLayer(layer: Layer): boolean {
  return layer.kind === 'mask';
}

/** 預設 renderStyle：**outline 是預設且主要的模式**。 */
export function effectiveRenderStyle(layer: Layer): MaskRenderStyle {
  return layer.renderStyle ?? 'outline';
}

/**
 * BODY 這類結構（佔滿視野）不給 fill —— 打包 bbox 會變全視野，填色也會把整張影像蓋掉。
 * RTROIInterpretedType `EXTERNAL` 為準；沒有型別時看名稱。
 */
export function isBodyLikeStructure(s: { name: string; interpretedType?: string | null }): boolean {
  if (s.interpretedType) return s.interpretedType.toUpperCase() === 'EXTERNAL';
  return /^(body|external|skin|patient|outline)$/i.test(s.name.trim());
}

/** fill 同時最多 4 個結構。 */
export const MAX_FILL_STRUCTURES = 4;

export function hasFill(layer: Layer): boolean {
  return layer.kind === 'mask' && effectiveRenderStyle(layer).includes('fill');
}

/** 目前設成 fill（含 fill+outline）的結構數 —— 不管顯不顯示（隱藏的再打開不能讓總數破表）。 */
export function fillCount(layers: readonly Layer[]): number {
  return layers.filter(hasFill).length;
}

/** 這個結構能不能改成 `style`：加 fill 時不得超過上限（本來就有 fill 的換樣式不算新增）。 */
export function canUseRenderStyle(layers: readonly Layer[], layerId: string, style: MaskRenderStyle): boolean {
  if (!style.includes('fill')) return true;
  const layer = layers.find((l) => l.layerId === layerId);
  if (layer === undefined || layer.kind !== 'mask') return false;
  return hasFill(layer) || fillCount(layers) < MAX_FILL_STRUCTURES;
}
