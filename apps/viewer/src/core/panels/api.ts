/**
 * `ViewerApi` —— **面板唯一被允許依賴的東西**。
 *
 * ## 為什麼要有這一層，而不是直接把 `App` 的 state 傳下去
 *
 * > **核心不得認識任何模組專屬的型別。核心只認識註冊表與介面。**
 *
 * 面板若直接吃 `App` 的 `useState` 形狀，那個形狀就變成公開契約——之後
 * **改一次 App 的內部狀態就要改所有面板**，包含第三方模組的。這一層的存在
 * 就是為了讓 `App` 內部可以隨便改，只要還能組出 `ViewerApi` 即可。
 *
 * ## 🔴 這個檔案不 import React
 *
 * 界線 1。`ViewerApi` 是純型別 ＋ 一個 overlay 註冊表；`react/` 端用一個
 * context 把它遞下去，`core/` 端完全不知道 React 存在。
 *
 * ## 面板能做什麼、不能做什麼
 *
 * | 能 | 不能 |
 * |---|---|
 * | 讀 `state`（唯讀快照） | 直接改 `state` —— 它是 `readonly`，改了也不會重繪 |
 * | 呼叫 `commands` | 直接碰 `ViewerHost` / `SceneManager` / canvas |
 * | 註冊 `overlay` painter 在影像上畫東西 | 在 `paint()` 裡發網路請求或改 layer（見 `overlayRegistry` 的 P2） |
 *
 * > **刻意還沒開的**：新增／移除 layer、直接寫 mask 體素、註冊工具。
 * > 這些要等到有真實需求時再逐項開，**開了就收不回來**。
 */

import type { EditableBox } from '../scene/ViewerHost';
import type { FrameStats } from '../scene/CpuViewportRenderer';
import type { ProbeReadout } from '../scene/probe';
import type { BrushSpec } from '../edit/brush';
import type { QueueFailure } from '../edit/submitQueue';
import type { BlendMode, Layer, MaskRenderStyle, Measurement, MeasurementKind } from '../layers/types';
import type { CellContent, LayoutSpec } from './layouts';
import type { LayoutNode, NodePath, SplitDirection } from './layoutTree';
import type { ViewportOverlayRegistry } from '../overlay/overlayRegistry';
import type { Quality } from '../raster/types';
import type { SceneNotice } from '../scene/SceneManager';
import type { TemporalState } from '../scene/ViewerHost';
import type { FrameGroup, Mat16, Tier, Vec3, ViewReference } from '../geometry';
import type { SlabOutlineSemantics } from '../overlay/outlineOverlay';
import type { ObliqueAngles, OrthoOrientation } from '../scene/cameras';
import type { TierState } from '../tier/arbitration';
import type { FormFactor } from '../device/formFactor';

/** 一個 2D viewport 的斜面／slab 狀態。 */
export interface ViewportView {
  readonly viewportId: string;
  readonly orientation: OrthoOrientation;
  readonly slabThicknessMm: number;
  /** 法線已偏離網格軸 → 切片序號沒有意義，顯示「斜面」。 */
  readonly oblique: boolean;
  /** 相對正交方位轉了多少（讀數用）。 */
  readonly angles: ObliqueAngles;
}

/** 結構清單上的後端 metadata（不含體素）。 */
export interface StructureMeta {
  readonly structureId: string;
  readonly status: string;
  readonly volumeCc: number | number[];
  /** 名稱／顏色／TG-263／FoR（ROI 編輯面板要顯示與改）。 */
  readonly name?: string;
  readonly colorRgb?: [number, number, number];
  readonly tg263Code?: string | null;
  readonly frameOfReferenceUid?: string;
  /** 來源結構集 id（`ViewerState.structureSets`）；null／undefined ＝ 沒有來源 RS。 */
  readonly structureSetId?: string | null;
  /** 對目前使用者能不能改（匯入集唯讀、別人的工作集唯讀）；undefined ＝ 舊後端／假體（可改）。 */
  readonly editable?: boolean;
  readonly structureSetKind?: 'import' | 'work' | 'transient' | null;
  readonly structureSetOwner?: string | null;
  /** RTROIInterpretedType（`EXTERNAL` ＝ BODY 這類）。 */
  readonly interpretedType?: string | null;
}

/** 誰開著這個病例（`presence` 推送）。 */
export interface PresenceUser {
  readonly user: string;
  readonly sessionId: string;
  readonly connections: number;
  readonly createdAt: string;
  /** 正在編輯的結構 id（編輯工具作用中時）；沒有 ＝ 沒在編輯或舊後端。 */
  readonly editing?: string | null;
}

/** 一套結構集（一份 RTSTRUCT）。多套進同一個病例時，結構清單以它分層。 */
export interface StructureSetInfo {
  readonly structureSetId: string;
  /** StructureSetLabel（沒有就 SeriesDescription／檔名）。 */
  readonly label: string;
  readonly seriesInstanceUid: string | null;
  readonly imageSeriesUid: string;
  /** 它掛的影像：「CT 20260601」。 */
  readonly imageLabel: string;
  readonly frameOfReferenceUid: string;
  readonly date: string;
  readonly roiCount: number;
  readonly role: 'primary' | 'secondary' | 'work';
  /** `import`（來源 RTSTRUCT，唯讀）或 `work`（某使用者的工作集）。 */
  readonly kind: 'import' | 'work' | 'transient';
  readonly owner: string | null;
  /** 使用者寫的描述；後端算好的「是我的」「我能改」。 */
  readonly description?: string;
  readonly mine?: boolean;
  readonly editable?: boolean;
}

/** 後端運算註冊表的一筆（`GET /ops`）。 */
export interface OpDescriptor {
  readonly op: string;
  readonly label: string;
  readonly description: string;
  readonly paramsSchema: Record<string, unknown>;
}

/** 案例選單的一個項目。假體與 DICOM 都走這個型別，UI 不必知道差別。 */
export interface CaseSource {
  readonly id: string;
  readonly label: string;
}

/**
 * 面板看到的完整唯讀狀態。
 *
 * **新增欄位是相容的，改名／改語意不是。** 這裡的每一個欄位都等同公開 API。
 */
export interface ViewerState {
  // ── 場景 ─────────────────────────────────────────────────────────────────
  readonly layers: readonly Layer[];
  readonly structures: readonly StructureMeta[];
  /** 結構集清單（來自 `scene.replace`）；沒有 RTSTRUCT 來源的病例為空。 */
  readonly structureSets: readonly StructureSetInfo[];
  /** 2026-09-24：病例適用結構集規則（library 病例 true、假體 false）；舊後端沒送 → 有集就當 true。 */
  readonly usesStructureSets: boolean;
  /** 誰開著這個病例（含自己）。 */
  readonly presence: readonly PresenceUser[];
  readonly seriesCount: number;
  readonly tier: TierState | null;
  readonly assignedTier: Tier;
  readonly resident: { readonly image: number; readonly mask: number; readonly total: number; readonly wasm?: number };
  readonly budgetBytes: number;
  readonly quality: Quality;
  readonly notices: readonly SceneNotice[];
  /** 目前顯示的是替代表示（唯讀）的 layer。 */
  readonly substitutes: readonly { layerId: string; rendererId: string; notice: string }[];
  readonly kernelReady: boolean;
  readonly kernelError: string | null;

  // ── 編輯 ──────────────────────────────────────────────────────────────
  readonly activeToolId: string | null;
  readonly brush: BrushSpec;
  /**
   * 觸控狀態 —— `windowLevel` 一指拖曳改調窗；`fingerDraws` 手指能不能畫（用過觸控筆就自動關）；
   * `penSeen` 這次用過觸控筆。
   */
  readonly touch: { readonly windowLevel: boolean; readonly fingerDraws: boolean; readonly penSeen: boolean };
  /** 目前的版面（手機／平板／桌面；`core/device/formFactor.ts`）。 */
  readonly formFactor: FormFactor;
  readonly activeStructureId: string | null;
  /** `null` = 可以編輯。**非 null 才是不能編輯的原因**——不要用 `??` 吞掉它。 */
  readonly editingBlockedReason: string | null;
  readonly canUndo: boolean;
  readonly canRedo: boolean;
  readonly undoDepth: number;
  readonly undoBytes: number;
  /** 送出佇列是否清空。切換病例前要等它。 */
  readonly editsFlushed: boolean;
  /**
   * 🔴 **有編輯沒存到後端的結構**。
   *
   * 送出失敗且重試用盡時才會出現在這裡。它必須被顯示出來——否則使用者會帶著
   * 一份「本地看起來對、後端沒有」的輪廓繼續工作，直到匯出 RTSTRUCT 才發現。
   */
  readonly submitFailures: readonly QueueFailure[];

  // ── 讀數 ───────────────────────────────────────────────────────────────
  /**
   * 十字線讀數：物理座標 ＋ 各可見 image layer 的體素值。
   *
   * `null` = 指標還沒進過任何 2D viewport。**面板必須自己處理 null**，不要
   * 用預設值頂替 —— 「還沒有讀數」與「讀數是 0」是兩件事。
   */
  readonly probe: ProbeReadout | null;
  /** 每個時間群組的游標、播放狀態、已載入的相位（沒有時間軸 ＝ 空陣列）。 */
  readonly temporal: readonly TemporalState[];
  /** 每一格鎖定的相位（viewportId → 時間群組 → 幀）；沒有 ＝ 跟游標。 */
  readonly viewportFrames: Readonly<Record<string, Readonly<Record<string, number>>>>;

  // ── 多序列 ──────────────────────────────────────────────────────────
  /** 這個 session 的 FrameGroup（每個影像序列一個；劑量借用同 FoR 的）。 */
  readonly frameGroups: readonly FrameGroup[];
  /** 右鍵 WW/WL 與閾值筆刷的目標影像 layer；null = 最底下的可見影像。 */
  readonly activeImageLayerId: string | null;
  /** 使用者暫時關掉對位（以單位矩陣擺放）的 FoR。 */
  readonly disabledTransforms: readonly string[];
  /** 選中的量測。 */
  readonly selectedMeasurementId: string | null;
  /** 面板「編輯頂點」中的量測；null ＝ 沒有。 */
  readonly vertexEdit: { readonly measurementId: string } | null;
  /** 量測範本：下一個這種量測的名稱（完成後變回 null）。 */
  readonly measurementLabelHint: { readonly kind: MeasurementKind; readonly label: string } | null;
  /** 結構 mask 抓取進度；`null` ＝ 沒有在抓。 */
  readonly maskLoading: { readonly done: number; readonly total: number } | null;
  /** 病例已關閉（資源釋放）；`canReload` ＝ 後端有給 selection 可以重載。 */
  readonly caseClosed: { readonly label: string; readonly canReload: boolean } | null;
  /** 每格最後一幀的量測（診斷面板）。 */
  readonly frames: readonly FrameStats[];
  /** 使用者微調中、尚未提交的對位。 */
  readonly transformOverrides: readonly { frameOfReferenceUid: string; transformToPrimary: Mat16 }[];

  // ── 斜面 MPR 與 slab ─────────────────────────────────────────────────
  readonly viewports: readonly ViewportView[];
  /** A 中心面預設，三種可切換；整個 session 一個設定。 */
  readonly slabOutlineSemantics: SlabOutlineSemantics;
  /** 開著的 UI 模式（例：`'mpr'`）；面板的 `visibleWhen` 靠它決定要不要出現。 */
  readonly modes: readonly string[];
  /** 目前的版面（`layouts.ts` 的 id）。 */
  readonly layoutId: string;
  /** 生效中的版面 ＝ 基底 ＋ 使用者的每格覆寫。 */
  readonly layout: LayoutSpec;
  readonly layoutHasOverrides: boolean;
  /** 目前版面的分割樹（使用者拖過／分割過的，或由具名版面換算）；非切割式格局 → `null`（不能分割／拖曳）。 */
  readonly layoutTree: LayoutNode | null;
  /**
   * 模組狀態袋：`modules[moduleId]` 是該模組自己定義形狀的物件（設定面板與格子面板共用）。
   * 與 `Layer.params`／`ToolContext.params` 同一個哲學 —— 核心不認識任何一個模組的型別。
   */
  readonly modules: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
  /** 每格額外隱藏的 layer（每格覆寫）。 */
  readonly viewportHiddenLayers: Readonly<Record<string, readonly string[]>>;

  // ── 案例、身分與錯誤 ─────────────────────────────────────────────────────
  /** 後端的 Case／study id（簽核與匯出模組打 `/studies/{studyId}/…`、`/cases/{caseId}`）。 */
  readonly caseId: string | null;
  readonly studyId: string | null;
  /** 登入的使用者；`RTGAIA_AUTH=off` 時是 stub（role admin）。null ＝ 還不知道。 */
  readonly user: { readonly username: string; readonly displayName: string; readonly role: string } | null;
  readonly source: string;
  readonly availableSources: readonly CaseSource[];
  readonly error: string | null;
}

/**
 * 面板可以呼叫的指令。
 *
 * 全部同步且不回傳 Promise（`loadCase` 例外地是 fire-and-forget）——面板不必
 * 處理非同步狀態，結果一律經下一次 `state` 反映。
 */
export interface ViewerCommands {
  // 🔴 一律宣告為**函式屬性**（`f: () => void`）而不是方法（`f(): void`）。
  // 面板會把它們直接當 callback 傳（`onClick={api.commands.undo}`），方法語法
  // 在那裡會觸發 `@typescript-eslint/unbound-method` —— 而那條規則是對的：
  // 方法可能依賴 `this`。這些指令一律是綁好的閉包，型別要說出這件事。

  // ── 圖層 ─────────────────────────────────────────────────────────────────
  readonly setVisible: (layerId: string, visible: boolean) => void;
  /** 182 個結構逐一點是不可用的。 */
  readonly setGroupVisible: (groupId: string, visible: boolean) => void;
  readonly setOpacity: (layerId: string, opacity: number) => void;
  /** 結構顯示樣式（outline 預設；fill 同時最多 4 個結構，超過回 false）。 */
  readonly setRenderStyle: (layerId: string, style: MaskRenderStyle) => boolean;
  // ── 每組影像各自的顯示參數 ────────────────────────────────────────────
  readonly setWindowLevel: (layerId: string, windowLevel: { center: number; width: number }) => void;
  readonly setColormap: (layerId: string, colormap: string) => void;
  /** normal／棋盤格／差值。 */
  readonly setBlendMode: (layerId: string, blendMode: BlendMode) => void;
  /** 模組專屬參數（例：劑量的閾值／等劑量線 level）；淺合併進 `Layer.params`。 */
  readonly setLayerParams: (layerId: string, patch: Record<string, unknown>) => void;
  readonly setActiveImageLayer: (layerId: string | null) => void;
  /** 「套用 REG／不套用」。關掉時整個 FrameGroup 以單位矩陣擺放。 */
  readonly setTransformEnabled: (frameOfReferenceUid: string, enabled: boolean) => void;
  /** 覆寫一個次要 FoR 的 `transformToPrimary`；null ＝ 回到後端給的。 */
  readonly setFrameGroupTransform: (frameOfReferenceUid: string, transformToPrimary: Mat16 | null) => void;
  /**
   * 該 FoR **此刻**生效的 `transformToPrimary`（覆寫優先，否則後端的）。連按 ±1 的按鈕要以它為底，
   * 不能用 render 時的快照 —— 否則一次 render 內的五下只算一下（實測）。
   */
  readonly currentTransformToPrimary: (frameOfReferenceUid: string) => Mat16;
  /** 把目前的覆寫提交給後端（`POST /transforms` ＋ `apply_to_frame_group`）；成功後後端推新的 FrameGroup。 */
  readonly submitFrameGroupTransform: (frameOfReferenceUid: string) => Promise<void>;
  /** 模組工具的參數（不具型別的袋子）；合併寫入。 */
  readonly setToolParams: (patch: Record<string, unknown>) => void;
  /** 某影像序列的體積中心（自身 FoR 世界座標）；未載入時 null。 */
  readonly seriesGridCenter: (seriesId: string) => Vec3 | null;
  /** 某影像序列的世界包圍盒（自身 FoR）；未載入時 null。 */
  readonly seriesGridBounds: (seriesId: string) => { min: Vec3; max: Vec3 } | null;
  /** 某影像序列的體素值直方圖（TF 編輯器底圖）；未載入時 null。 */
  readonly seriesHistogram: (seriesId: string, bins?: number, range?: [number, number]) => { counts: number[]; min: number; max: number } | null;

  // ── 編輯 ─────────────────────────────────────────────────────────────────
  readonly setActiveTool: (toolId: string | null) => void;
  readonly setBrush: (patch: Partial<BrushSpec>) => void;
  /** 失敗時附上原因（例如替代表示唯讀）。 */
  readonly setActiveStructure: (
    structureId: string | null,
  ) => { ok: boolean; reason: string | null };
  readonly undo: () => void;
  readonly redo: () => void;
  /** 觸控一指拖曳改調窗寬窗位。 */
  readonly setTouchWindowLevel: (on: boolean) => void;
  /** 手指能不能畫（用過觸控筆後預設不能）。 */
  readonly setFingerDraws: (on: boolean) => void;
  /** 工具的「完成／取消」（觸控沒有 Enter／Esc／雙擊）。 */
  readonly toolAction: (action: 'finish' | 'cancel') => void;

  // ── 視圖 ───────────────────────────────────────────────────────────────
  readonly zoom: (viewportId: string, factor: number) => void;
  readonly fit: (viewportId: string) => void;
  readonly actualSize: (viewportId: string) => void;
  readonly zoomFactor: (viewportId: string) => number;
  readonly sliceLabel: (viewportId: string) => string;
  /** 要求重畫一幀（`final` 品質）。改了 overlay 的資料之後呼叫。 */
  readonly render: () => void;
  /** 只重畫面板 overlay 層（影像、輪廓不動）；painter 的輸入變了（例如 hover 位置）時用，比 `render()` 便宜。 */
  readonly repaintOverlays: () => void;
  /**
   * 交給核心一個可調方框（primary 世界座標）—— 十字線工具下，2D 正交切面上的截面角與邊中點可拖；
   * 拖曳中 `onChange(box, 'move')`、放手 `'end'`。方框本身由模組的 overlay painter 畫。`null` 移除。
   */
  readonly setEditableBox: (ownerId: string, box: EditableBox | null, onChange?: (box: EditableBox, phase: 'move' | 'end') => void) => void;
  // ── 斜面 MPR 與 slab ─────────────────────────────────────────────────
  /** 0–20 mm；0 = 單一平面。 */
  readonly setSlabThickness: (viewportId: string, mm: number) => void;
  readonly setSlabOutlineSemantics: (semantics: SlabOutlineSemantics) => void;
  /** 以十字線為樞紐旋轉平面；`'up'` 法線在水平面掃、`'right'` 上下傾斜。 */
  readonly rotateViewport: (viewportId: string, axis: 'up' | 'right', angleDeg: number) => void;
  /** 回到原本的正交方位（十字線那一點不動）。 */
  readonly resetOrientation: (viewportId: string) => void;
  /** 開／關一個 UI 模式（模組的工具列開關用）。 */
  readonly setMode: (id: string, enabled: boolean) => void;
  /** 切換版面（`registerLayout()` 過的 id）。 */
  readonly setLayout: (layoutId: string) => void;
  /** 使用者改一格的內容（存在瀏覽器，依版面 id）；`null` ＝ 清掉這格的覆寫。 */
  readonly setCellContent: (cellId: string, content: CellContent | null) => void;
  /** 清掉目前版面的所有覆寫（每格內容與分割樹）。 */
  readonly resetLayoutOverrides: () => void;
  /** 把一格分成兩格（`row` 左右、`column` 上下）；新格內容同原格（不跟相機連動）。 */
  readonly splitCell: (cellId: string, dir: SplitDirection) => void;
  /** 關掉一格（合併進旁邊）；最後一格不能關。 */
  readonly closeCell: (cellId: string) => void;
  /** 設定某個 split 的比例（拖完分隔線、雙擊平分）。 */
  readonly resizeLayout: (path: NodePath, sizes: readonly number[]) => void;
  /** 模組狀態袋：合併寫入 `modules[moduleId]`。 */
  readonly setModuleState: (moduleId: string, patch: Record<string, unknown>) => void;

  // ── 量測 ────────────────────────────────────────────────────────────
  readonly selectMeasurement: (measurementId: string | null) => void;
  /** 改名／改點（roi3d 深度等）；進 undo、存後端。`commit:false` ＝ 只改本地（編輯頂點期間用，「完成」時合成一筆）。 */
  readonly updateMeasurement: (measurementId: string, patch: { points?: readonly number[]; label?: string }, opts?: { commit?: boolean }) => void;
  /** 面板「編輯頂點」：開始／結束（`commit` false ＝ 還原）；`highlightVertex` 讓畫面上某個頂點亮起（滑過列）。 */
  readonly beginVertexEdit: (measurementId: string) => void;
  /** 時間軸 —— 跳到某相位、前後一格（播放範圍內，循環或停住）、播放狀態、某序列在一點（預設十字線）的時間曲線。 */
  readonly setTemporalFrame: (groupId: string, frameIndex: number) => void;
  readonly stepTemporal: (groupId: string, delta: number) => void;
  readonly setTemporalPlayback: (groupId: string, patch: Partial<Pick<TemporalState, 'playing' | 'fps' | 'loop' | 'rangeFrom' | 'rangeTo'>>) => void;
  readonly temporalCurve: (seriesId: string, worldPrimary?: readonly [number, number, number]) => (number | null)[];
  /** 這一格把某條時間軸鎖在某一幀（`null` ＝ 解除、跟游標）。 */
  readonly setViewportFrame: (viewportId: string, groupId: string, frame: number | null) => void;
  /**
   * 同一個病例原地組成／拆開／攤開時間軸（後端重組後推 `scene.replace`，時間軸變了前端整條載入鏈重跑）。
   * 失敗拋 Error（訊息是後端的那一句）。
   */
  readonly composeTemporal: (args: { seriesUids: readonly string[]; labels: readonly string[] | null; axis: 'phase' | 'time'; resample?: boolean }) => Promise<void>;
  /** 網格跟第一幀不同的相位重新取樣補進來（true）／照舊排除（false）；同一個病例原地重組。 */
  readonly setTemporalResample: (groupId: string, enabled: boolean) => Promise<void>;
  readonly dissolveTemporal: (groupId: string) => Promise<void>;
  readonly setTemporalView: (groupId: string, mode: 'expanded' | 'timeline') => Promise<void>;
  /** 十字線目前在哪（primary 世界座標）；檢視器還沒就緒 → null。記錄地標用。 */
  readonly crosshairWorld: () => readonly [number, number, number] | null;
  /** 量測範本：下一個 `kind` 量測叫 `label`（草稿就套上）；完成後自動清掉。`null` ＝ 取消。 */
  readonly setMeasurementLabelHint: (hint: { kind: MeasurementKind; label: string } | null) => void;
  readonly endVertexEdit: (commit: boolean) => void;
  readonly highlightVertex: (measurementId: string, index: number | null) => void;
  readonly removeMeasurement: (measurementId: string) => void;
  /** 加一筆已完成的量測（進 undo、存後端）。 */
  readonly addMeasurement: (m: Measurement) => void;
  /** 記錄地標對（移動點＝次要序列自己的座標、固定點＝primary 世界座標）；回傳量測 id。 */
  readonly addLandmarkPair: (args: { movingFrameOfReferenceUid: string; moving: readonly [number, number, number]; fixed: readonly [number, number, number]; label: string }) => string | null;
  /** primary 世界座標 → 某 FoR 自己的座標（目前的對位）；十字線移到某點。 */
  readonly worldToFrame: (frameOfReferenceUid: string, worldPrimary: readonly [number, number, number]) => readonly [number, number, number] | null;
  readonly moveCrosshair: (worldPrimary: readonly [number, number, number]) => void;
  /** 「平行但不同層」淡色可關。 */
  readonly setMeasurementOptions: (opts: { showFaded?: boolean }) => void;
  /** 鍵盤事件（viewport 有焦點時）：工具的 Enter／Esc、選中量測的 Delete。 */
  readonly keyDown: (viewportId: string, key: string) => void;

  // ── ROI 編輯 ─────────────────────────────────────────────────────
  /** 新建空結構；回 id 與 TG-263 建議。 */
  readonly createStructure: (args: { name: string; colorRgb: [number, number, number]; frameOfReferenceUid?: string; structureSetId?: string | null }) => Promise<{ structureId: string; tg263Suggestion: Record<string, unknown> | null }>;
  readonly updateStructureMeta: (structureId: string, patch: { name?: string; colorRgb?: [number, number, number]; tg263Code?: string | null }) => Promise<void>;
  readonly deleteStructure: (structureId: string) => Promise<void>;
  readonly duplicateStructure: (structureId: string) => Promise<{ structureId: string }>;
  /**
   * 4D 的結構。合成：幾個只屬某幾幀的結構 → 一個時間結構；複製到其他相位（預設只補沒有的幀）；
   * ITV：幾個結構在選定各幀的聯集（靜態）。都進我的工作集（複製到其他相位要結構本來就能改）。失敗拋 Error（後端那一句）。
   */
  readonly mergeFrameStructures: (structureIds: readonly string[], name: string) => Promise<{ structureId: string }>;
  readonly propagateStructureFrames: (
    structureId: string,
    args: { sourceFrame: number; targetFrames?: readonly number[]; overwrite?: boolean },
  ) => Promise<{ added: readonly number[]; replaced: readonly number[]; skipped: readonly number[] }>;
  readonly createItv: (args: { structureIds: readonly string[]; frames: readonly number[] | null; name: string }) => Promise<{ structureId: string; volumeCc: number }>;
  /** 現在畫在哪一幀（最後點過的那一格鎖的相位；沒鎖 ＝ 時間軸游標）。 */
  readonly drawingFrame: (groupId: string) => number;
  /**
   * 沒存到後端的那一筆 —— 再送一次（重試次數歸零）、跳到那一塊（十字線移到沒存到的
   * 範圍中心）、放棄並取回後端版本（清空這個結構的 undo、重抓 mask）。沒有失敗的那一筆 → false。
   */
  readonly retryUnsaved: (structureId: string, frameIndex: number | null) => boolean;
  readonly jumpToUnsaved: (structureId: string, frameIndex: number | null) => boolean;
  readonly discardUnsaved: (structureId: string, frameIndex: number | null) => boolean;
  /** 後端運算（後處理／閾值分割／區域生長）；結果套回本地並進 undo。 */
  readonly runPostprocess: (structureId: string, op: string, params: Record<string, unknown>) => Promise<void>;
  readonly listOps: () => Promise<readonly OpDescriptor[]>;
  /** 讀數所在的體素（區域生長的種子）。 */
  readonly probeVoxel: () => { ijk: [number, number, number]; seriesId: string } | null;
  /** 每個 2D viewport 目前的切面（「參考線」：畫其他格的切面在本格的交線）。讀取用，可在 painter 裡呼叫。 */
  readonly viewportCameras: () => readonly { viewportId: string; orientation: OrthoOrientation; camera: ViewReference }[];
  /**
   * 某一格額外隱藏的 layer（整組覆寫）。只能**多藏**不能「只在這格顯示全域隱藏的 layer」——
   * 全域隱藏的 layer 沒有常駐資料，要顯示先 `setVisible(true)`。
   */
  readonly setViewportHiddenLayers: (viewportId: string, layerIds: readonly string[]) => void;

  // ── 案例 ─────────────────────────────────────────────────────────────────
  /** 重抓結構清單（狀態、名稱）—— 簽核之後用；推送的 `layer.update` 不帶 status。 */
  readonly refreshStructures: () => Promise<void>;
  /** 重抓結構集清單（合併、改名、建工作集之後）。 */
  readonly refreshStructureSets: () => Promise<void>;
  readonly loadCase: (source: string) => void;
  /** 沿用後端**目前的** session 重跑載入鏈（資料頁 `POST /sessions` 之後用）。 */
  readonly reloadCase: () => void;
  /** 關閉病例（釋放前後端資源，畫面留「病例已關閉」）／重新載入。 */
  readonly closeCase: () => void;
  readonly reopenCase: () => void;
  /** 說明 —— 快捷鍵表對話框、功能導覽。 */
  readonly openShortcuts: () => void;
  /** 功能導覽（預設）或任務引導（`'draw'`：畫一個結構並確認存好）。 */
  readonly startTour: (kind?: 'feature' | 'draw') => void;
  /** 卸載所有未顯示的影像／劑量 lod 0 與結構 mask 體素。 */
  readonly dropHiddenVolumes: () => { imageBytes: number; maskBytes: number; count: number };
  /** 面板要顯示錯誤時走這裡，不要自己維護一份錯誤狀態。 */
  readonly setError: (message: string | null) => void;
  /**
   * 提示（不是錯誤）：頂部一行、使用者可關閉。例：開病例的警告（「切片間距不完全均勻，在容許值內…」）——
   * 以前也走 `setError`，紅字看起來像壞掉。`null` 收掉。
   */
  readonly setNotice: (message: string | null) => void;
}

/**
 * 遞給每個面板的 props。
 *
 * 面板元件的簽章一律是 `(props: ViewerPanelProps) => JSX.Element`，因此
 * **註冊表不需要知道任何面板專屬的型別**。
 */
export interface ViewerApi {
  readonly state: ViewerState;
  readonly commands: ViewerCommands;
  /** 在 viewport 的畫布上疊自己的向量內容。用法見 `overlayRegistry`。 */
  readonly overlay: ViewportOverlayRegistry;
  /**
   * 模組打自己的後端端點用（`apiNamespace`；DVH 是第一個）。
   * 路徑相對 `/api/v1`；只有 JSON —— 二進位訊框仍走核心的 transport。
   */
  readonly http: ModuleHttp;
}

export interface ModuleHttp {
  getJson<T>(path: string): Promise<T>;
  /** 模組的寫入端點（簽核、匯出、帳號）；JSON 進 JSON 出，非 2xx 拋 Error（訊息含 HTTP 狀態與 body 前段）。 */
  postJson<T>(path: string, body: unknown): Promise<T>;
  patchJson<T>(path: string, body: unknown): Promise<T>;
  /** 刪除端點（結構集）。 */
  deleteJson<T>(path: string): Promise<T>;
  /** 3D 靜態出圖（`server-render` 退路的唯一端點）：回 PNG 位元組 ＋ header（`camera_used`／`content_hash`…）。 */
  render3d(payload: unknown): Promise<{ header: Record<string, unknown>; png: Uint8Array }>;
}
