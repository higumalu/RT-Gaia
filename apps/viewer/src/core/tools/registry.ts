/**
 * 工具註冊表。
 *
 * `ToolContext` **必須**暴露：座標轉換鏈、undo stack、圖層讀寫、
 * 目前 `ViewReference`（含相位）。
 *
 * > 🔴 **`ToolContext` 不得暴露 vtk 物件。** 模組一旦直接取得 `vtkActor`，
 * > 它在 Tier C 就會壞掉，**而且是靜默壞掉**。
 */

import { require_ } from '../geometry';
import type { FrameGroup, MaskGrid, Vec3, ViewReference, Mat16 } from '../geometry';
import type { Layer, Measurement } from '../layers/types';
import type { Modifiers } from '../interaction/bindings';
import type { ViewportInfo } from '../raster/types';
import type { UndoStack } from '../edit/undoStack';
import type { VoxelPatch } from '../edit/brush';
import { t } from '../i18n';

/**
 * 工具能取得的一切。
 *
 * **注意這裡沒有任何 vtk／Cornerstone 型別**——這不是疏漏，是規格要求。
 */
export interface ToolContext {
  readonly viewport: ViewportInfo;
  /** 目前平面（含相位）。 */
  readonly camera: ViewReference;

  // ── 座標轉換鏈 ─────────────────────────────────────────────────────────
  /** canvas 像素 → primary 世界座標（LPS mm）。 */
  canvasToWorld(x: number, y: number): Vec3;
  /** primary 世界座標 → canvas 像素。 */
  worldToCanvas(world: Vec3): { x: number; y: number };
  /**
   * 🔴 編輯用的網格。**型別是 `MaskGrid`，不是 `DisplayGrid`**。
   * 型別系統擋住這個錯誤，不靠註解。
   */
  readonly maskGrid: MaskGrid;
  /**
   * 某個 FoR 的結構所在的 MaskGrid（每個 FrameGroup 一個）。
   *
   * 🔴 編輯次要序列的結構時**必須用這個**，`maskGrid` 只是 primary 的。
   * 拿錯的症狀是筆刷落在偏移的位置、或 bbox 超出網格被拒。
   */
  maskGridFor(frameOfReferenceUid: string): MaskGrid;
  frameGroup(frameOfReferenceUid: string): FrameGroup;
  /**
   * 覆寫一個次要 FrameGroup 的 `transformToPrimary`（座標轉換鏈的第三段）。
   * `null` ＝ 回到後端給的那一個。影像、劑量、結構、讀數一起動 —— 它們都經 `frameGroup()`。
   * 這是**本地暫時狀態**；要存回去走面板的「提交」，不在工具裡。
   */
  setFrameGroupTransform(frameOfReferenceUid: string, transformToPrimary: Mat16 | null): void;

  // ── undo stack ─────────────────────────────────────────────────────────
  readonly undo: UndoStack;
  /**
   * 套用一筆體素編輯：**本地立即生效，並累積進當前這一筆筆畫**。
   *
   * 🔴 **這裡不推 undo、也不送後端。** 一次拖曳有幾十個筆點，但整筆只算一個
   * undo 區塊、只送一次 —— 因此提交是 `endStroke()` 的事。
   * 舊的簽章回傳 `EditOp`，那個形狀鼓勵「每個筆點推一筆 undo」，正好是規格
   * 禁止的行為。
   *
   * 回傳 false = 沒有寫進去（結構不在倉裡、或 patch 完全落在網格外）。
   */
  applyPatch(args: {
    structureId: string;
    frameIndex: number | null;
    patch: VoxelPatch;
  }): boolean;
  /**
   * 收筆：整筆推一個 undo 區塊並排入送出佇列。
   *
   * 沒有變更（例如在已經是 1 的地方又畫一次）時什麼都不做 —— 不佔 undo 格、
   * 也不送。
   */
  endStroke(label: string): void;

  // ── 工具自己的參數與影像取樣 ────────────────────────────────────────────
  /**
   * 工具專屬參數（筆刷半徑、形狀、HU 區間…），由 UI 提供。
   *
   * 🔴 **刻意是不具型別的袋子。** 核心不得認識任何模組專屬的型別；
   * 把 `BrushSpec` 放進 `ToolContext` 等於宣告「核心知道有筆刷這種東西」，
   * 那麼下一個工具就要再加一個欄位。
   */
  readonly params: Record<string, unknown>;
  /**
   * 影像體素的 HU 值（閾值筆刷用）。網格外回傳 `-Infinity`。
   *
   * 索引是 **mask grid 的 ijk** —— mask grid 與取像網格描述同一塊空間（I5），
   * 因此可以直接用。
   */
  sampleImageHu(ijk: readonly [number, number, number]): number;

  // ── 圖層讀寫 ───────────────────────────────────────────────────────────
  layers(): readonly Layer[];
  layer(layerId: string): Layer | null;
  setVisible(layerId: string, visible: boolean): void;
  /**
   * 🔴 替代表示為唯讀：**工具啟動前必須檢查並拒絕**，
   * 不得靜默寫進一個沒有在畫面上的 mask。
   */
  isEditable(layerId: string): boolean;
  /** 目前選取的結構（筆刷作用對象）。 */
  activeStructureId(): string | null;
  /** 這個 layer 目前在哪一個相位（靜態 null）；編輯寫進那個相位的 mask。沒給（舊測試假物件）＝ 相位 0。 */
  frameOf?(layer: Pick<Layer, 'temporalGroupId'>): number | null;
  /** 工具沒有作用時告訴使用者為什麼（提示列）。沒給（舊測試假物件）＝ 不提示。 */
  notify?(message: string): void;

  // ── 量測 ─────────────────────────────────────────────────────────────────
  /** 量測綁它的 FoR、取它的 HU：作用中的影像 layer（沒有可見影像回 null）。 */
  activeImageLayer(): Layer | null;
  measurements(): readonly Measurement[];
  /**
   * 放進場景。`commit:false` ＝ 進行中（不進 undo、不存後端；橡皮筋線／未收口的多邊形）；
   * 之後用 `commitMeasurement()` 收尾。
   */
  addMeasurement(m: Measurement, opts?: { commit?: boolean }): void;
  updateMeasurement(measurementId: string, patch: { points?: Float64Array | readonly number[]; label?: string }, opts?: { commit?: boolean }): void;
  removeMeasurement(measurementId: string, opts?: { commit?: boolean }): void;
  /** 把進行中的量測收尾：推 undo（before ＝ 開始時的狀態，建立為 null）並存後端。 */
  commitMeasurement(measurementId: string, before: Measurement | null): void;
  selectMeasurement(measurementId: string | null): void;
  /** CSS 像素 → backing store 像素的比例（判斷「點回第一個頂點」用）。 */
  cssToBackingScale(): { sx: number; sy: number };
  /** 十字線導航：讓所有 2D 格的切面穿過這個 primary 世界座標。 */
  setCrosshair(primaryWorld: Vec3): void;
  /** 圈選進行中的多邊形（primary 世界座標）→ host 畫在這一格的 SVG；`null` 清掉。 */
  setLassoPreview(polygonPrimaryWorld: readonly Vec3[] | null): void;
  /** 強調某個量測的某個頂點（草稿游標吸附到起點時）；`null` 取消。 */
  highlightVertex(measurementId: string, index: number | null): void;
}

export interface ToolInstance {
  /** 工具被切換掉時呼叫。必須釋放所有暫時狀態。 */
  deactivate(): void;
  /** `modifiers`：按下當下的修飾鍵（整段拖曳同一份）。 */
  onPointerDown?(x: number, y: number, modifiers?: Modifiers): void;
  onPointerMove?(x: number, y: number, modifiers?: Modifiers): void;
  onPointerUp?(x: number, y: number, modifiers?: Modifiers): void;
  /** 回 true ＝ 已處理；否則 host 接手（例：選中量測的 Delete）。 */
  onKeyDown?(key: string): boolean | void;
  /**
   * 指標在這一格移動（沒有按鍵、沒有拖曳）；`null` ＝ 離開。給「橡皮筋」類的即時回饋用
   * （面積工具：最後頂點到游標的虛線）。只有 instance 已經存在時才會收到。
   */
  onHover?(position: { x: number; y: number } | null): void;
  /**
   * host 代使用者做的結束動作：`finish`（雙擊、點一下草稿的第一或最後一個頂點）／`cancel`。
   */
  onAction?(action: 'finish' | 'cancel'): void;
}

export interface ToolPlugin {
  readonly id: string;
  readonly label: string;
  readonly icon: string;
  readonly cursor: string;
  /** 例：僅 3D、僅 MPR、僅有時間軸時。 */
  appliesTo?: (vp: ViewportInfo) => boolean;
  /** 不列在工具面板上 —— 由某個模組的面板啟動（例如對位拖曳只在對位模式有意義）。 */
  hidden?: boolean;
  /** 單鍵快捷鍵（一個可列印字元，不分大小寫）；核心的快捷鍵表與說明面板都從這裡讀。 */
  hotkey?: string;
  /**
   * 只在這個任務模式開著時才列在工具列（量測／筆刷那些工具不需要常駐，啟用模組再顯示）。
   * 模式關掉時若它正是作用中的工具，host 會退回十字線（`toolRequiresMode`）。
   */
  requiresMode?: string;
  activate(ctx: ToolContext): ToolInstance;
}

const tools = new Map<string, ToolPlugin>();

export function registerTool(plugin: ToolPlugin): void {
  require_(plugin.id.length > 0, 'TL1', t('tool id 必填'));
  require_(!tools.has(plugin.id), 'TL2', t('tool id 重複註冊'), { id: plugin.id });
  tools.set(plugin.id, plugin);
}

export function hasTool(id: string): boolean {
  return tools.has(id);
}

export function getTool(id: string): ToolPlugin {
  const plugin = tools.get(id);
  require_(plugin !== undefined, 'TL3', t('未註冊的 tool'), { id, known: [...tools.keys()] });
  return plugin!;
}

export function listTools(vp?: ViewportInfo): ToolPlugin[] {
  const all = [...tools.values()];
  if (!vp) return all;
  return all.filter((t) => t.appliesTo?.(vp) ?? true);
}

export function clearTools(): void {
  tools.clear();
}

/** `toolId` 是否宣告「需要 `modeId` 開著」—— 模式關掉時用來決定要不要退回十字線。未註冊的工具回 false。 */
export function toolRequiresMode(toolId: string | null, modeId: string): boolean {
  if (toolId === null) return false;
  const plugin = tools.get(toolId);
  return plugin?.requiresMode === modeId;
}

/**
 * 第一期工具集的 id。
 *
 * 多邊形輪廓工具（spline、livewire、sculptor）**不在第一期**；若臨床
 * 調查顯示是必要規格，需重新評估改用 `@cornerstonejs/tools`。
 */
export const FIRST_PHASE_TOOL_IDS = [
  'navigate', // 十字線導航（左鍵預設）
  'brush',
  'eraser',
  'threshold-brush',
  'scissors',
  'measure-distance',
  'measure-area',
  'measure-roi3d',
  'measure-point',
  // 角度、Cobb、曲線長度
  'measure-angle',
  'measure-cobb',
  'measure-curve',
] as const;
