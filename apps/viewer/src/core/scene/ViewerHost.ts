/**
 * `ViewerHost` —— 把「一個 3D ＋ 時間空間」的所有參與者組裝起來的地方。
 *
 * 它擁有：WASM 重切核心、體素倉、`SceneManager`、每個 viewport 的相機與互動。
 * **`react/` 只交出容器與指令**，不碰其中任何一項（`SceneManager` 的三條界線）。
 *
 * ## 為什麼需要這一層
 *
 * `SceneManager` 管的是「圖層 → handle → 記憶體」；相機、體素、互動是另一組
 * 關注點。把它們塞進 `useScene` 會讓 React 的 hook 變成事實上的應用核心 ——
 * 那正是界線 1 要避免的東西（與 React × vtk.js 的阻抗問題同源）。
 */

import { DEFAULT_BRUSH, type BrushSpec, type VoxelPatch } from '../edit/brush';
import { BRUSH_PREVIEW_TOOL_IDS, brushCursorPx } from '../tools/brushCursor';
import { StrokeAccumulator } from '../edit/stroke';
import {
  SubmitQueue,
  type ConflictInfo,
  type QueueFailure,
  type SubmitRequest,
  type SubmitResult,
} from '../edit/submitQueue';
import { isEditOp, UndoStack, type EditOp, type MeasurementOp, type UndoEntry } from '../edit/undoStack';
import { EventLayer } from '../interaction/eventLayer';
import { TouchGestures, type TouchMode, type TouchOp } from '../interaction/touchGestures';
import { getTool, type ToolContext, type ToolInstance } from '../tools/registry';
import type { InteractionCommand } from '../interaction/eventLayer';
import type { Modifiers } from '../interaction/bindings';
import { CLOSE_POLYGON_PX } from '../tools/measure';
import type { Layer, MaskRenderStyle, Measurement, MeasurementKind } from '../layers/types';
import { canUseRenderStyle } from '../layers/types';
import type { ViewportOverlayRegistry } from '../overlay/overlayRegistry';
import {
  DEFAULT_SLAB_OUTLINE_SEMANTICS,
  type SlabOutlineSemantics,
} from '../overlay/outlineOverlay';
import { dialAngleDeg, rotationAxisOf, SvgOverlayHost } from '../overlay/svgOverlayHost';
import { formatMeasurementValue, measurementHandles, measurementNodes, type MeasurementSvgInput } from '../overlay/measurementSvg';
import { isMeasurementEditable, measurementDisplayMode, type SvgHandle } from '../overlay/svgOverlay';
import {
  boxCorners,
  dragBoxCorner,
  dragBoxEdge,
  isComplete,
  createMeasurement,
  isPlanarKind,
  landmarkTre,
  orthogonalAxisOf,
  translatePoints,
  measurementStats,
  measurementValue,
  voxelAt,
  pointsToPrimary,
  polygonPlaneIntersection,
  boxPlaneSection,
  viewToPrimary,
} from '../measure';
import { viewInFrame } from '../geometry';
import { makeStubHandle } from '../raster/builtins';
import { WasmResliceKernel, loadResliceKernel } from '../raster/resliceKernel';
import type { Quality, Tier, TransportLike, Vec2, ViewportInfo } from '../raster/types';
import { budgetFor, maxFullResVolumes } from '../tier/budget';
import type { FrameGroup, GridSet, MaskGrid, Mat16, Vec3, ViewReference } from '../geometry';
import { cornersWorld, fromPrimaryWorld, indexToWorld, maskGridOf, primaryFrameGroupOf, signedDistance, toPrimaryWorld, worldToNearestVoxel } from '../geometry';
import { imageVolumeKey, voxelStorageOf, maskVolumeKey } from './volumeStore';
import { stepInRange, type TemporalGroup } from '../geometry/temporal';
import {
  cameraAtSlice,
  displaySliceIndex,
  fitCamera,
  fitPxMm,
  formatDeg,
  isObliqueTo,
  obliqueAngles,
  orthoCamera,
  type ObliqueAngles,
  panInPlane,
  planeIntersectsGrid,
  rotateInPlane,
  sliceRange,
  stepAlongNormal,
  zoomCameraAtCursor,
  type SliceRange,
  type OrthoOrientation,
} from './cameras';
import { createViewReference } from '../geometry';
import { CachingResliceKernel, planeCacheKey } from '../raster/resliceCache';
import { imageResliceArgs } from '../raster/cpuBackends';
import { cameraKey, shouldRequestHighQuality } from './hybridReslice';
import { CpuViewportRenderer, type FrameStats } from './CpuViewportRenderer';
import { SceneManager, type SceneNotice } from './SceneManager';
import { blockGridOf, VolumeStore, type FrameOverride } from './volumeStore';
import { ViewportFrameLocks } from './viewportFrames';
import { probeImageLayers, probeStructures, toDisplayValue, valueScaleOf, type ProbeReadout } from './probe';
import { onLangChange, t } from '../i18n';

/** 每格滾輪 = 一張切片；Ctrl＋滾輪的縮放倍率。 */
const ZOOM_STEP = 1.15;
/** PageUp／PageDown 一次跳幾張。 */
const SLICE_PAGE_STEP = 10;
/** WW/WL 拖曳的靈敏度（HU / px）。右鍵水平拖 = width、垂直拖 = center。 */
const WINDOW_SENSITIVITY = 4;

/** 可調方框（primary 世界座標 LPS mm）。 */
export interface EditableBox {
  readonly min: Vec3;
  readonly max: Vec3;
}

export interface ViewportBinding {
  readonly info: ViewportInfo;
  /** 3D viewport 為 null —— Tier C 不提供互動式體積渲染。 */
  readonly renderer: CpuViewportRenderer | null;
  readonly events: EventLayer | null;
  readonly orientation: OrthoOrientation;
  camera: ViewReference;
  /** 十字線 ＋ 旋轉 handle 的 SVG 層；3D viewport 為 null。 */
  readonly svg: SvgOverlayHost | null;
  detach: () => void;
}

/** slab 的最大厚度（面板上限）。 */
export const SLAB_MAX_MM = 20;

/** 一個時間群組在面板上看到的狀態。 */
export interface TemporalState {
  readonly temporalGroupId: string;
  readonly kind: TemporalGroup['kind'];
  readonly frameCount: number | null;
  /** 實際時間戳（秒，DCE 等）；沒有 → null。 */
  readonly frameTimes: readonly number[] | null;
  readonly axisLabel: string;
  /** 每一幀的名字；沒有 → null。 */
  readonly frameLabels: readonly string[] | null;
  readonly unit: string | null;
  readonly cursor: number;
  readonly playing: boolean;
  readonly fps: number;
  readonly loop: boolean;
  /** 播放範圍（含兩端；DCE 的時間窗）。 */
  readonly rangeFrom: number;
  readonly rangeTo: number;
  /** 群組內每個體積序列都已有體素（任何 lod）的相位。 */
  readonly residentFrames: readonly number[];
  /** 群組內每個體積序列都已有**全解析度**（lod 0）的相位。 */
  readonly fullResFrames: readonly number[];
  readonly seriesIds: readonly string[];
}

interface TemporalRuntime {
  readonly group: TemporalGroup;
  cursor: number;
  playing: boolean;
  fps: number;
  loop: boolean;
  rangeFrom: number;
  rangeTo: number;
}

export interface ViewerHostOptions {
  gridSet: GridSet;
  tier: Tier;
  seriesCount: number;
  transport: TransportLike;
  onNotice?: (notice: SceneNotice) => void;
  onFrame?: (stats: FrameStats) => void;
  /** 相機或圖層改變後通知 React 重繪狀態列（不是重繪畫面）。 */
  onStateChange?: () => void;
  /** 送出編輯到後端（`POST /edit`）。不給則只在本地生效。 */
  submitEdit?: (request: SubmitRequest) => Promise<SubmitResult>;
  /** 真外部衝突（409）—— 需要重取 mask ＋ 清空該結構 undo。 */
  onConflict?: (info: ConflictInfo) => void;
  /**
   * 🔴 **送出失敗且重試用盡** —— 這一筆編輯沒有存到後端。
   *
   * 先前 `ViewerHostOptions` **根本沒有這個欄位**，`SubmitQueue` 因此永遠拿不到
   * `onError`：筆畫本地畫上去、後端沒收到、沒重試也沒提示，而且
   * `baseContentHash` 沒推進所以後端也不會回 409 —— 永久且無聲，直到匯出
   * RTSTRUCT 才會發現。UI 必須把它顯示出來。
   */
  onSubmitError?: (message: string, request: SubmitRequest) => void;
  /** 別人改過某個結構（佇列送完後才確定），呼叫端要重抓它的 mask（`SubmitQueue.onRemoteChange`）。 */
  onRemoteMaskChange?: (info: { structureId: string; frameIndex: number | null; contentHash: string }) => void;
  /**
   * 面板註冊的 viewport overlay painter。
   *
   * 🔴 **由呼叫端持有並跨 `ViewerHost` 重建保留。** `ViewerHost` 會因為換病例
   * 而整個重建；註冊表若掛在它身上，面板的 painter 會在切換病例時靜默消失，
   * 而面板不會知道要重新註冊。
   */
  overlays?: ViewportOverlayRegistry;
  /**
   * 量測存回後端。不給則只在本地。host 不認識 transport 的形狀 —— 由 App 接到
   * `TransportClient.createMeasurement／updateMeasurement／deleteMeasurement`。
   */
  onMeasurementChange?: (kind: 'add' | 'update' | 'remove', measurement: Measurement) => void;
  /** 注入用（測試）。 */
  kernel?: WasmResliceKernel;
}

/** 指標按下時把焦點給最近的 `[tabindex]` 祖先（鍵盤 Enter／Esc／Delete 要進得來）。沒有 DOM 的環境直接略過。 */
function focusViewportContainer(target: HTMLElement): void {
  const focusable = typeof target.closest === 'function' ? target.closest<HTMLElement>('[tabindex]') : null;
  if (focusable !== null && typeof focusable.focus === 'function') focusable.focus({ preventScroll: true });
}

export class ViewerHost {
  readonly scene: SceneManager;
  readonly volumes = new VolumeStore();
  readonly kernel: WasmResliceKernel;
  /** 重切／輪廓結果快取，所有格共用（key 含相機與尺寸，不會互撞）。 */
  readonly resliceCache: CachingResliceKernel;
  /** hybrid 高品質重切用；可能沒有 `fetchHighQualityReslice`。 */
  private readonly transport: TransportLike | undefined;
  /** 只有 `setFrameGroups()`（後端推來新的對位）會換掉它；網格本身不變。 */
  private gridSet: GridSet;
  /** 這個 session 判定的 Tier —— renderer 用它解析 fallback。 */
  private readonly tier: Tier;
  private readonly bindings = new Map<string, ViewportBinding>();
  /** 最後一個 2D 格拆掉時的十字線與相位（換格子方位時新格子接著用；見 `attachViewport`）。 */
  private lastCrosshair: Pick<ViewReference, 'planeOrigin' | 'temporalGroupId' | 'frameIndex'> | null = null;
  private readonly onStateChange: () => void;
  /** 工具給使用者的提示（提示列）。 */
  private readonly onNotice: (notice: SceneNotice) => void;
  /** 十字線讀數。null = 指標還沒進過任何 viewport。 */
  private probeReadout: ProbeReadout | null = null;
  private pendingHover: { viewportId: string; position: Vec2 } | null = null;
  private probeScheduled = false;
  private readonly onFrame: ((stats: FrameStats) => void) | undefined;
  /** 面板的 overlay painter。由外部持有，這裡只是轉交給 renderer。 */
  readonly overlays: ViewportOverlayRegistry | undefined;
  private layers: readonly Layer[] = [];
  private disposed = false;
  /** 語言切換 → 重同步 SVG 上的文字（斜面角度、量測標籤）並重畫。 */
  private readonly offLang: () => void;
  /**
   * 使用者暫時關掉對位的 FoR（「套用 REG／不套用」切換）。
   *
   * 關掉時 `frameGroupFor()` 回單位矩陣的 FrameGroup —— 影像、輪廓、劑量、讀數、
   * 筆刷全部經同一個查表，因此**一起**跳回原生座標（分開套用是錯的）。
   */
  private readonly disabledTransforms = new Set<string>();
  /**
   * 使用者微調中的對位：FoR → 覆寫的 `transformToPrimary`。
   * **本地暫時狀態**，提交後由後端推來的新 FrameGroup 取代（`setFrameGroups()` 會清掉）。
   */
  private readonly transformOverrides = new Map<string, Mat16>();
  /**
   * 模組工具的參數袋（核心不認識任何模組專屬型別）。與 `brush` 一起併進
   * `ToolContext.params`；每次讀都是最新的，工具不必為了拿新參數重新啟動。
   */
  private toolParams: Record<string, unknown> = {};
  /** 每格額外隱藏的 layer（並排比較用）。renderer 拿到的是過濾後的清單。 */
  private readonly hiddenPerViewport = new Map<string, Set<string>>();
  /** 每一格鎖定的相位、最後按過的那一格（見 `viewportFrames.ts`）。 */
  private readonly frameLocks = new ViewportFrameLocks();
  /** viewportId → 相機連動群（同群的格子相機一起動）。 */
  private readonly cameraLinks = new Map<string, string>();
  /**
   * 右鍵 WW/WL 與閾值筆刷的目標影像 layer。null = 最底下那個可見影像。
   *
   * 先前固定打 `order` 最小的那層 —— 多序列時永遠只能調計畫 CT。
   */
  private activeImageLayerId: string | null = null;
  /** slab 輪廓語意，整個 host 一個（三格共用，比較才有意義）。 */
  private slabOutlineSemantics: SlabOutlineSemantics = DEFAULT_SLAB_OUTLINE_SEMANTICS;
  /**
   * 開著的 UI 模式（例：`'mpr'`）。核心只保存字串集合，不認識任何模式的意義 ——
   * 例外是十字線／handle 的顯示：它們屬於 `'mpr'` 模式（斜面 MPR 模組的開關）。
   */
  private readonly modes = new Set<string>();
  /** 拖曳 handle 中累積的角度（這一筆），顯示成 `Δ+3.2°`；放手清空。 */
  private readonly dragAngle = new Map<string, number>();

  // ── 編輯狀態 ──────────────────────────────────────────────────────────────
  readonly undo: UndoStack;
  readonly submitQueue: SubmitQueue;
  /** 目前選取的工具 id。null = 只導航。 */
  private activeToolId: string | null = 'navigate';
  /** 觸控的一指拖曳改成調窗寬窗位（工具列「調窗」）。 */
  private touchWindowLevel = false;
  /**
   * 手指能不能畫。第一次用觸控筆就自動關掉（筆畫、手指只移動畫面，手掌碰到也不會畫）；
   * 工具列可以再打開。
   */
  private fingerDraws = true;
  private penSeen = false;
  /** 觸控筆正壓在畫面上的指標數：這段時間的手指觸控一律忽略（手掌）。 */
  private readonly penDown = new Set<number>();
  /** 每格的觸控放大鏡（手指畫的時候才出現）。 */
  private readonly loupes = new Map<string, HTMLCanvasElement>();
  /** 筆刷參數（半徑以 **mm** 為單位）。 */
  private brush: BrushSpec = { ...DEFAULT_BRUSH };
  /** 筆刷的作用對象。**沒有選結構就不能編輯。** */
  private activeStructureId: string | null = null;
  /** 一次拖曳＝一個 undo 單位；`null` 表示目前沒有在畫。 */
  /**
   * 進行中的筆畫。
   *
   * 🔴 一次拖曳有幾十個筆點，但**整筆只算一個 undo 區塊、只送一次**。
   * 舊版每個筆點覆寫 `patch`，於是 `finishStroke()` 只送出最後一個
   * 筆點——本地畫了一整筆、後端只收到最後一小塊，而且不會有任何錯誤，
   * 直到匯出 RTSTRUCT 才發現大部分筆畫不見了。
   */
  private stroke:
    | { structureId: string; frameIndex: number | null; acc: StrokeAccumulator; label: string }
    | null = null;
  /** 目前作用中的工具實例。換工具或換 viewport 時重建。 */
  private activeTool: { toolId: string; viewportId: string; instance: ToolInstance } | null = null;
  /** 這一筆下筆時的視圖（追溯要求：最後一筆編輯在哪個平面）。 */
  private strokeView: ViewReference | null = null;

  // ── 量測 ──────────────────────────────────────────────────────────────────
  /**
   * 量測的本地真相。後端推來的 `kind:'measurement'` layer 若本地已有同 id 就以本地為準
   * （本地先建、後端 echo 後到）；本地沒有的就收進來（重新整理後從後端回來）。
   */
  private readonly measurements = new Map<string, Measurement>();
  /** 進行中（`commit:false`）的量測：不出控制點 —— 否則「點回第一個頂點收口」會被 hit-test 攔成拖曳。 */
  private readonly draftMeasurementIds = new Set<string>();
  private measurementLabelHint: { kind: MeasurementKind; label: string } | null = null;
  /** 每個時間群組的游標與播放狀態（前端狀態，不需端點）。 */
  private readonly temporal = new Map<string, TemporalRuntime>();
  private playbackTimer: ReturnType<typeof setInterval> | null = null;
  /**
   * 本地刪掉、後端 echo 還沒到的 id。少了它，下一次 `setLayers()` 會把後端還沒移除的那個
   * layer 又收回本地 —— 被刪的量測復活，redo 時 PATCH 打到 404（實測）。
   */
  private readonly removedMeasurementIds = new Set<string>();
  private selectedMeasurementId: string | null = null;
  /** 拖控制點中：開始時的快照（放手推一筆 undo）。 */
  private measurementDrag: {
    measurementId: string;
    before: Measurement;
    index: number;
    kind: SvgHandle['kind'];
    startPrimary: [number, number, number];
    /** 按下時的 CSS 像素位置：放開時沒移動 ＝「點一下」（草稿頂點：點第一／最後一點 ＝ 收口）。 */
    startPx: Vec2;
  } | null = null;
  /**
   * 模組交給核心的可調方框（primary 世界座標，例：3D 裁切範圍）。十字線工具下，正交切面上的截面角與邊中點可拖；
   * 拖曳中 `onChange(box, 'move')`、放手 `'end'`。畫方框仍是模組的 overlay painter（核心只負責把手與拖曳）。
   */
  private readonly editableBoxes = new Map<string, { box: EditableBox; onChange: (box: EditableBox, phase: 'move' | 'end') => void }>();
  private boxDrag: { ownerId: string; before: EditableBox; kind: SvgHandle['kind']; startPrimary: Vec3; edge: [Vec3, Vec3] | null } | null = null;
  /** 「平行但不同層」淡色可關。 */
  private showFadedMeasurements = true;
  /**
   * 面板的「編輯頂點」模式：這個量測的頂點不管目前工具都可拖；期間所有拖動不 commit，
   * `endVertexEdit(true)` 合成一筆 undo 並送後端，`endVertexEdit(false)` 回到 `before`。
   */
  private vertexEdit: { measurementId: string; before: Measurement } | null = null;
  /** 強調的頂點（草稿吸附到起點、面板滑過某列）。 */
  private highlightedVertex: { measurementId: string; index: number } | null = null;
  private readonly onMeasurementChange: ViewerHostOptions['onMeasurementChange'];
  /** 圈選進行中的多邊形（primary 世界座標），每格一份。 */
  private readonly lassoPreview = new Map<string, readonly Vec3[]>();

  private constructor(options: ViewerHostOptions, kernel: WasmResliceKernel) {
    this.gridSet = options.gridSet;
    this.tier = options.tier;
    this.kernel = kernel;
    this.resliceCache = new CachingResliceKernel(kernel);
    this.transport = options.transport;
    this.onStateChange = options.onStateChange ?? (() => {});
    this.onNotice = options.onNotice ?? (() => {});
    this.onFrame = options.onFrame;
    this.overlays = options.overlays;
    this.onMeasurementChange = options.onMeasurementChange;
    for (const g of options.gridSet.temporalGroups ?? []) {
      this.temporal.set(g.temporalGroupId, {
        group: g,
        cursor: 0,
        playing: false,
        fps: g.kind === 'series' ? 4 : 8,
        loop: g.kind === 'cyclic',
        rangeFrom: 0,
        rangeTo: Math.max(0, (g.frameCount ?? 1) - 1),
      });
    }
    this.volumes.setFrameResolver((groupId) => this.temporal.get(groupId)?.cursor ?? 0);
    this.offLang = onLangChange(() => {
      for (const id of this.bindings.keys()) this.syncSvg(id);
      this.render('final');
    });
    this.undo = new UndoStack((op, direction) => this.applyUndoEntry(op, direction));
    this.submitQueue = new SubmitQueue({
      submit:
        options.submitEdit ??
        (() => Promise.resolve({ status: 'ok', contentHash: 'local-only' } as SubmitResult)),
      readBlock: (args) => this.volumes.readMaskBlock(args),
      onConflict: (info) => {
        // 真衝突流程：清空該結構的 undo（本地紀錄已與後端分歧）
        this.undo.invalidateStructure(info.structureId, info.frameIndex);
        options.onConflict?.(info);
        this.onStateChange();
      },
      onError: (message, request) => {
        // 🔴 一定要往上傳。`SubmitQueue` 已經把 bbox 留在佇列裡（`isIdle()`
        // 因此仍是 false），但只有 UI 說得出「這一筆沒有存到」。
        options.onSubmitError?.(message, request);
        this.onStateChange();
      },
      onRemoteChange: (info) => options.onRemoteMaskChange?.(info),
    });
    this.scene = new SceneManager({
      gridSet: options.gridSet,
      tier: options.tier,
      budgetBytes: budgetFor(options.tier, options.seriesCount).totalBytes,
      transport: options.transport,
      createHandle: (args) => makeStubHandle(args),
      ...(options.onNotice ? { onNotice: options.onNotice } : {}),
      // renderer 由 attachViewport 自己建（需要容器），因此這裡不給 createRenderer
    });
  }

  static async create(options: ViewerHostOptions): Promise<ViewerHost> {
    const kernel = options.kernel ?? (await loadResliceKernel());
    return new ViewerHost(options, kernel);
  }

  // ── viewport ─────────────────────────────────────────────────────────────

  /**
   * 掛上一個 viewport。**canvas 與事件監聽都由這裡建立**（界線 3）。
   */
  attachViewport(args: {
    info: ViewportInfo;
    container: HTMLElement;
    orientation: OrthoOrientation;
  }): ViewportBinding {
    // 換這一格的方位（或版面多出一格）：新切面穿過**目前的十字線**、沿用目前的相位，不回到體積中心
    //（2026-10-09 錄 demo 時發現）。React 換格子是先拆舊的再掛新的 —— 1×1 版面拆完就沒有相機可量，用拆的時候記下的
    this.detachViewport(args.info.viewportId);
    const keep = this.crosshairState();

    const imageGrid = this.gridSet.displayGrid.grid;
    if (args.info.is3D) {
      // 🔴 3D viewport **不建 CPU renderer**。
      //
      // 完整體積 ray-cast 在 CPU 上做不到互動速度（512² × ~500 樣本/射線
      // ≈ 1.3 億次取樣），因此 Tier C 不提供；改由後端出靜態圖。
      // 但**仍要註冊到 `SceneManager`** —— 那是 `volume-3d` 的
      // `unsupported ＋ server-render` 退路被解析、以及使用者看到「這是替代
      // 表示」的地方。少了這一步，退路就成了型別上存在、執行期不存在的東西。
      this.scene.attachViewport(args.info);
      const camera = orthoCamera({
        grid: imageGrid,
        orientation: args.orientation,
        displayGridId: this.gridSet.displayGrid.displayGridId,
      });
      const stub: ViewportBinding = {
        info: args.info,
        renderer: null,
        events: null,
        orientation: args.orientation,
        camera,
        svg: null,
        detach: () => {},
      };
      this.bindings.set(args.info.viewportId, stub);
      return stub;
    }

    const renderer = new CpuViewportRenderer({
      info: args.info,
      container: args.container,
      kernel: this.resliceCache,
      volumes: this.volumes,
      imageGrid,
      gridSet: this.gridSet,
      tier: this.tier,
      frameGroupResolver: (uid) => this.frameGroupFor(uid),
      frameOverride: this.frameOverrideFor(args.info.viewportId),
      viewportParams: () => ({ slabOutlineSemantics: this.slabOutlineSemantics }),
      // 每幀之後同步十字線／handle 的位置（它們跟著 planeOrigin 的投影走）
      onFrame: (stats) => {
        this.syncSvg(args.info.viewportId);
        this.onFrame?.(stats);
      },
      ...(this.overlays ? { overlays: this.overlays } : {}),
    });
    const centered = orthoCamera({
      grid: imageGrid,
      orientation: args.orientation,
      displayGridId: this.gridSet.displayGrid.displayGridId,
    });
    const camera = keep === null ? centered : { ...centered, ...keep };
    renderer.setCamera(camera);
    renderer.setLayers(this.layersFor(args.info.viewportId));
    // 界線 3：SVG 節點由 core 建立，react 只給了容器
    const svg = typeof document === 'undefined' ? null : new SvgOverlayHost(args.info.viewportId, args.container);

    const events = new EventLayer({
      viewportId: args.info.viewportId,
      onCommand: (command) => this.handleCommand(args.info.viewportId, command),
      // hit-test 優先於綁定表。座標是 CSS 像素 → 換成 backing store 再問
      hitTest: (position) => {
        if (svg === null) return null;
        const { sx, sy } = renderer.cssToBackingScale();
        return svg.hitTest({ x: position.x * sx, y: position.y * sy });
      },
      onInteractionBegin: () => {
        // 🔴 這裡**不渲染**。互動剛開始時什麼都還沒改，畫一次是純浪費 ——
        // 而且滾輪一格會走 onCommand → begin → end，於是每格滾輪渲染兩次，
        // 把效能量測值直接放大一倍。切換品質狀態就好，重繪由 onCommand 負責。
        this.scene.beginInteraction();
      },
      onInteractionEnd: () => {
        this.scene.endInteraction(() => {
          this.render('final');
          this.scheduleHighQuality();
        });
      },
      // 讀數的探測點。**不經 onCommand** —— hover 不是一個動作
      onHover: (position, modifiers) => this.handleHover(args.info.viewportId, position, modifiers),
    });

    const binding: ViewportBinding = {
      info: args.info,
      renderer,
      events,
      orientation: args.orientation,
      camera,
      svg,
      detach: () => {},
    };

    // DOM 事件 → 指令（vtk.js widget 接不進來）
    const target = args.container;
    const rect = () => target.getBoundingClientRect();
    const sync = (): void => {
      const r = rect();
      events.setOrigin({ x: r.left, y: r.top });
    };
    // 觸控交給手勢層（一指換切片／畫、雙指縮放平移、長按十字線）；滑鼠與觸控筆照舊走 EventLayer
    target.style.touchAction = 'none';
    const local = (p: { x: number; y: number }): Vec2 => {
      const r = rect();
      return { x: p.x - r.left, y: p.y - r.top };
    };
    const touch = new TouchGestures({
      mode: () => this.touchModeFor(),
      emit: (op) => this.handleTouchOp(args.info.viewportId, events, local, op),
    });
    const touchPoint = (e: PointerEvent) => ({ id: e.pointerId, x: e.clientX, y: e.clientY });
    const onDown = (e: PointerEvent): void => {
      if (e.pointerType === 'pen') {
        this.penDown.add(e.pointerId);
        if (!this.penSeen) {
          this.penSeen = true;
          this.fingerDraws = false;
          this.onStateChange();
        }
      }
      if (e.pointerType === 'touch') {
        if (this.penDown.size > 0) return; // 筆壓著時的觸控 ＝ 手掌
        sync();
        this.frameLocks.lastPointerViewportId = args.info.viewportId;
        focusViewportContainer(target);
        target.setPointerCapture(e.pointerId);
        e.preventDefault();
        touch.down(touchPoint(e));
        return;
      }
      sync();
      this.frameLocks.lastPointerViewportId = args.info.viewportId; // 新結構屬於這一格鎖定的相位
      // 🔴 `EventLayer.pointerDown` 會 preventDefault（擋右鍵選單／拖曳選字），而 Chrome 把 pointerdown 取消
      // 視為「不要改 focus」—— 於是 `.viewport[tabindex]` 從來沒拿到焦點，Enter／Esc／Delete 全部落空
      // （面積量測按 Enter 收不了口）。這裡自己把焦點給最近的可聚焦祖先。
      focusViewportContainer(target);
      // 雙擊（第二下的 pointerdown `detail >= 2`）＝ 結束目前工具的動作（面積草稿收口：第一下已經把雙擊處加成最後頂點）。
      // 不再送進 EventLayer，否則第二下又變成一個頂點或一次拖曳。
      if (e.button === 0 && e.detail >= 2 && this.activeTool !== null && this.activeTool.viewportId === args.info.viewportId && this.activeTool.instance.onAction) {
        this.activeTool.instance.onAction('finish');
        return;
      }
      target.setPointerCapture(e.pointerId);
      events.pointerDown(e);
    };
    const onMove = (e: PointerEvent): void => {
      // 🔴 **hover 也需要正確的原點。** `sync()` 原本只在 pointerdown／wheel
      // 呼叫，因此純 hover（沒有按鍵）拿到的是**頁面座標**而不是容器座標 ——
      // 症狀是十字線讀數整片偏掉，偏移量剛好等於容器在頁面上的左上角
      // （實測：軸向格中心量到 x = 635.6 mm，而網格 x 只到 348.6；
      // 容器左緣 330 px × 1.979 mm/px = 653 mm，正好是誤差量）。
      //
      // **拖曳中刻意不同步**：origin 一變，`delta` 會跳一格 —— 而拖曳的原點
      // 已經在 pointerdown 同步過了。
      if (e.pointerType === 'touch') {
        touch.move(touchPoint(e));
        return;
      }
      if (!events.isActive()) sync();
      events.pointerMove(e);
    };
    const onUp = (e: PointerEvent): void => {
      if (e.pointerType === 'pen') this.penDown.delete(e.pointerId);
      if (e.pointerType === 'touch') {
        if (e.type === 'pointercancel') touch.cancel(touchPoint(e));
        else touch.up(touchPoint(e));
      } else {
        events.pointerUp(e);
      }
      if (target.hasPointerCapture(e.pointerId)) target.releasePointerCapture(e.pointerId);
    };
    const onWheel = (e: WheelEvent): void => {
      sync();
      events.wheel(e);
    };
    const onContext = (e: Event): void => e.preventDefault();
    // 觸控放開也會 pointerleave —— 讀數要留著（手指離開就是離開，沒有「移過去看一下」）
    const onLeave = (e: PointerEvent): void => {
      if (e.pointerType !== 'touch') events.pointerLeave();
    };

    // 🔴 手機實測：在影像上拖曳之後，下一次點按鈕（例：關掉「調窗」）沒有作用 —— Chrome 從這段觸控產生了
    // 慣性滑動（fling），下一個點擊被當成「停住滑動」吞掉、不送 click。`touch-action: none` 擋不掉；原生 touchstart／touchmove
    // preventDefault 才讓 Chrome 不為這段觸控產生任何手勢。我們的手勢全走 pointer events，不受影響。
    const onNativeTouch = (e: TouchEvent): void => {
      if (e.cancelable) e.preventDefault();
    };
    target.addEventListener('touchstart', onNativeTouch, { passive: false });
    target.addEventListener('touchmove', onNativeTouch, { passive: false });
    target.addEventListener('pointerdown', onDown);
    target.addEventListener('pointermove', onMove);
    target.addEventListener('pointerup', onUp);
    target.addEventListener('pointercancel', onUp);
    target.addEventListener('pointerleave', onLeave);
    target.addEventListener('wheel', onWheel, { passive: false });
    target.addEventListener('contextmenu', onContext);
    (binding as { detach: () => void }).detach = () => {
      svg?.dispose();
      this.loupes.get(args.info.viewportId)?.remove();
      this.loupes.delete(args.info.viewportId);
      target.removeEventListener('touchstart', onNativeTouch);
      target.removeEventListener('touchmove', onNativeTouch);
      target.removeEventListener('pointerdown', onDown);
      target.removeEventListener('pointermove', onMove);
      target.removeEventListener('pointerup', onUp);
      target.removeEventListener('pointercancel', onUp);
      target.removeEventListener('pointerleave', onLeave);
      target.removeEventListener('wheel', onWheel);
      target.removeEventListener('contextmenu', onContext);
    };

    this.bindings.set(args.info.viewportId, binding);
    // 相機連動：晚掛上來的格子先對齊同群已在的那一格
    const group = this.cameraLinks.get(args.info.viewportId);
    if (group !== undefined) {
      const partner = [...this.cameraLinks].find(([id, g]) => g === group && id !== args.info.viewportId && this.bindings.get(id)?.renderer);
      if (partner !== undefined) this.mirrorCamera(partner[0]);
    }
    this.scene.attachViewport(args.info);
    renderer.render('final');
    return binding;
  }

  /** 十字線與相位：還有 2D 格就從相機算；都拆掉了就用最後一格拆掉時記下的（`detachViewport`）。 */
  private crosshairState(): Pick<ViewReference, 'planeOrigin' | 'temporalGroupId' | 'frameIndex'> | null {
    const ref = [...this.bindings.values()].find((b) => b.renderer !== null)?.camera;
    if (ref === undefined) return this.lastCrosshair;
    return { planeOrigin: this.crosshairWorld(), temporalGroupId: ref.temporalGroupId, frameIndex: ref.frameIndex };
  }

  detachViewport(viewportId: string): void {
    const binding = this.bindings.get(viewportId);
    if (!binding) return;
    if (binding.renderer !== null) this.lastCrosshair = this.crosshairState();
    if (this.activeTool?.viewportId === viewportId) this.releaseTool();
    binding.detach();
    binding.renderer?.dispose();
    this.bindings.delete(viewportId);
    this.scene.detachViewport(viewportId);
  }

  viewportIds(): string[] {
    return [...this.bindings.keys()];
  }

  binding(viewportId: string): ViewportBinding | undefined {
    return this.bindings.get(viewportId);
  }

  /** 目前平面的切片序號 —— **僅供 UI 顯示**（不得儲存）。 */
  sliceLabel(viewportId: string): string {
    const binding = this.bindings.get(viewportId);
    if (!binding) return '';
    const grid = this.gridSet.displayGrid.grid;
    // 斜面沒有切片序號；顯示厚度與「斜面」而不是一個沒有意義的數字
    if (isObliqueTo(grid, binding.camera)) {
      const slab = binding.camera.slabThicknessMm;
      return t('斜面{p0}', { p0: slab > 0 ? ` · slab ${slab} mm` : '' });
    }
    const index = displaySliceIndex(grid, binding.camera);
    const axis = binding.orientation === 'axial' ? 2 : binding.orientation === 'coronal' ? 1 : 0;
    const slab = binding.camera.slabThicknessMm;
    return `${index + 1} / ${grid.size[axis]}${slab > 0 ? ` · slab ${slab} mm` : ''}`;
  }

  /** 切片捲軸的位置（`sliceRange`；斜面也有）。3D 格或還沒掛上 → null。**僅供 UI**。 */
  sliceNav(viewportId: string): SliceRange | null {
    const binding = this.bindings.get(viewportId);
    if (!binding || binding.renderer === null || binding.info.is3D) return null;
    return sliceRange(this.gridSet.displayGrid.grid, binding.camera);
  }

  /**
   * 切片捲軸拖曳／點選／鍵盤跳張：`begin` 進互動品質、`move` 移到第 `index` 張（夾在範圍內）、
   * `end` 走跟滾輪一樣的 settle（SETTLE_MS 後補 final ＋ 高品質重切）。點一下 ＝ begin＋move＋end。
   */
  scrubSlice(viewportId: string, phase: 'begin' | 'move' | 'end', index?: number): void {
    const binding = this.bindings.get(viewportId);
    if (!binding || binding.renderer === null || binding.info.is3D) return;
    if (phase === 'begin') {
      this.scene.beginInteraction();
      return;
    }
    if (phase === 'end') {
      this.scene.endInteraction(() => {
        this.render('final');
        this.scheduleHighQuality();
      });
      return;
    }
    if (index === undefined) return;
    const grid = this.gridSet.displayGrid.grid;
    if (sliceRange(grid, binding.camera).index === Math.round(index)) return;
    binding.camera = cameraAtSlice(grid, binding.camera, index);
    binding.renderer.setCamera(binding.camera);
    binding.renderer.render(this.scene.currentQuality());
    this.mirrorCamera(viewportId);
    this.onStateChange();
  }

  /**
   * 相對跳張（捲軸上的滾輪、鍵盤）：以**現在的相機**為準算目標 —— 快速連續的滾輪事件不必等 React 重繪拿新的 index。
   * 夾在範圍內；走 scrubSlice 的 begin／move／end（settle 同滾輪）。
   */
  stepSlice(viewportId: string, delta: number, absolute?: 'first' | 'last'): void {
    const nav = this.sliceNav(viewportId);
    if (nav === null) return;
    const target = absolute === 'first' ? 0 : absolute === 'last' ? nav.count - 1 : nav.index + delta;
    this.scrubSlice(viewportId, 'begin');
    this.scrubSlice(viewportId, 'move', target);
    this.scrubSlice(viewportId, 'end');
  }

  /** 鍵盤跳張：↑／↓ 一張、PageUp／PageDown 十張、Home／End 到頭（方向同滾輪與捲軸）。 */
  private keySliceStep(viewportId: string, key: string): boolean {
    if (this.sliceNav(viewportId) === null) return false;
    if (key === 'Home' || key === 'End') {
      this.stepSlice(viewportId, 0, key === 'Home' ? 'first' : 'last');
      return true;
    }
    const delta = key === 'ArrowUp' ? -1 : key === 'ArrowDown' ? 1 : key === 'PageUp' ? -SLICE_PAGE_STEP : key === 'PageDown' ? SLICE_PAGE_STEP : 0;
    if (delta === 0) return false;
    this.stepSlice(viewportId, delta);
    return true;
  }

  // ── 斜面 MPR 與 slab ──────────────────────────────────────────────────────

  /** 這一格的 slab 厚度（mm）。0 = 單一平面。 */
  setSlabThickness(viewportId: string, mm: number): void {
    const binding = this.bindings.get(viewportId);
    if (!binding || binding.renderer === null) return;
    const clamped = Math.max(0, Math.min(SLAB_MAX_MM, mm));
    binding.camera = createViewReference({ ...binding.camera, slabThicknessMm: clamped });
    binding.renderer.setCamera(binding.camera);
    binding.renderer.render('final');
    this.mirrorCamera(viewportId);
    this.scheduleHighQuality(); // 按鈕轉的斜面／slab 也要高品質
    this.onStateChange();
  }

  slabThickness(viewportId: string): number {
    return this.bindings.get(viewportId)?.camera.slabThicknessMm ?? 0;
  }

  /** 三種 slab 輪廓語意可切換；整個 host 一個設定。 */
  setSlabOutlineSemantics(semantics: SlabOutlineSemantics): void {
    this.slabOutlineSemantics = semantics;
    this.render('final');
    this.onStateChange();
  }

  currentSlabOutlineSemantics(): SlabOutlineSemantics {
    return this.slabOutlineSemantics;
  }

  /** 以目前十字線那一點為樞紐旋轉。`axis='up'` 法線在水平面上掃、`'right'` 上下傾斜。 */
  rotateViewport(viewportId: string, axis: 'up' | 'right', angleDeg: number): void {
    const binding = this.bindings.get(viewportId);
    if (!binding || binding.renderer === null || angleDeg === 0) return;
    binding.camera = rotateInPlane(binding.camera, axis, angleDeg);
    binding.renderer.setCamera(binding.camera);
    binding.renderer.render(this.scene.currentQuality());
    this.mirrorCamera(viewportId);
    this.scheduleHighQuality(); // 按鈕轉的斜面／slab 也要高品質
    this.onStateChange();
  }

  /** 回到這一格原本的正交方位，**十字線那一點不動**。 */
  resetOrientation(viewportId: string): void {
    const binding = this.bindings.get(viewportId);
    if (!binding || binding.renderer === null) return;
    binding.camera = orthoCamera({
      grid: this.gridSet.displayGrid.grid,
      orientation: binding.orientation,
      displayGridId: this.gridSet.displayGrid.displayGridId,
      planeOrigin: binding.camera.planeOrigin,
      slabThicknessMm: binding.camera.slabThicknessMm,
    });
    binding.renderer.setCamera(binding.camera);
    binding.renderer.render('final');
    this.mirrorCamera(viewportId);
    this.scheduleHighQuality(); // 按鈕轉的斜面／slab 也要高品質
    this.onStateChange();
  }

  isOblique(viewportId: string): boolean {
    const binding = this.bindings.get(viewportId);
    return binding !== undefined && isObliqueTo(this.gridSet.displayGrid.grid, binding.camera);
  }

  /** 開／關一個 UI 模式（模組的工具列開關呼叫）。 */
  setMode(id: string, enabled: boolean): void {
    if (enabled) this.modes.add(id);
    else this.modes.delete(id);
    for (const vid of this.bindings.keys()) this.syncSvg(vid);
    this.onStateChange();
  }

  currentModes(): string[] {
    return [...this.modes];
  }

  /** 這一格相對正交方位轉了多少（讀數用）。 */
  viewportAngles(viewportId: string): ObliqueAngles | null {
    const binding = this.bindings.get(viewportId);
    if (!binding || binding.renderer === null) return null;
    return obliqueAngles(binding.orientation, binding.camera);
  }

  /** 十字線與 handle 跟著 `planeOrigin` 的投影；只在 `'mpr'` 模式、且沒有編輯工具作用中時顯示。 */
  private syncSvg(viewportId: string): void {
    const binding = this.bindings.get(viewportId);
    if (!binding || binding.renderer === null || binding.svg === null) return;
    const editing = this.activeToolId !== null && this.activeToolId !== 'navigate';
    const angles = obliqueAngles(binding.orientation, binding.camera);
    const dragging = this.dragAngle.get(viewportId);
    const parts: string[] = [];
    if (dragging !== undefined) parts.push(`Δ${formatDeg(dragging)}`);
    if (angles.totalDeg > 0.05 || dragging !== undefined) {
      parts.push(t('水平 {p0} · 傾斜 {p1}', { p0: formatDeg(angles.aroundUpDeg), p1: formatDeg(angles.aroundRightDeg) }));
    }
    binding.svg.update({
      center: binding.renderer.worldToCanvas(binding.camera.planeOrigin),
      width: binding.info.width,
      height: binding.info.height,
      visible: this.modes.has('mpr') && !editing,
      oblique: this.isOblique(viewportId),
      label: parts.join('  '),
    });
    const { nodes, handles } = this.measurementSvg(viewportId);
    const boxHandles = this.editableBoxHandles(viewportId);
    // 可調方框的把手也畫在 SVG（跟量測把手同一層；角實心、邊空心）
    const boxNodes = boxHandles.map((h) => ({
      tag: 'rect' as const,
      attrs: {
        class: `rt-box-handle ${h.kind === 'editable-box-corner' ? 'corner' : 'edge'}`,
        x: (h.position.x - 4).toFixed(1),
        y: (h.position.y - 4).toFixed(1),
        width: '8',
        height: '8',
        'data-owner': h.ownerId,
        'data-index': String(h.pointIndex ?? 0),
      },
    }));
    binding.svg.updateMeasurements([...nodes, ...boxNodes], [...handles, ...boxHandles]);
    const lasso = this.lassoPreview.get(viewportId);
    binding.svg.updateLasso(lasso ? lasso.map((p) => binding.renderer!.worldToCanvas(p)) : null);
  }

  // ── 圖層與體素 ───────────────────────────────────────────────────────────

  setLayers(layers: readonly Layer[]): void {
    this.layers = this.withMeasurementLayers(layers);
    this.syncSeriesFrames();
    this.scene.setLayers(this.layers);
    for (const [id, binding] of this.bindings) binding.renderer?.setLayers(this.layersFor(id));
    this.followPinnedTarget();
  }

  /**
   * 攤開的時間軸 —— **實際作用中**的影像（`windowTargetLayer`：指定的那張，沒指定就最底下的可見影像）是某一幀
   * → 游標跟過去：結構顯示那一幀、新畫的屬於那一幀。只顯示一張時它自動是作用中（點「作用中」不會觸發 onChange），
   * 所以顯示／隱藏、換作用中、換圖層都要檢查，不能只在 setActiveImageLayer 裡做。
   */
  private followPinnedTarget(): void {
    const target = this.windowTargetLayer();
    if (target?.temporalGroupId && typeof target.frameIndex === 'number' && this.temporal.get(target.temporalGroupId)?.cursor !== target.frameIndex) {
      this.setTemporalFrame(target.temporalGroupId, target.frameIndex);
    }
  }

  /**
   * 把本地量測併進圖層清單（量測是 `kind='measurement'` 的 Layer）。
   * 後端來的同 id → 用本地的內容但保留它的顯示狀態；本地沒有的 → 收進本地；
   * 本地有而後端還沒 echo 的 → 補一個 layer。幂等。
   */
  private withMeasurementLayers(layers: readonly Layer[]): Layer[] {
    const out: Layer[] = [];
    const seen = new Set<string>();
    for (const layer of layers) {
      if (layer.kind !== 'measurement') {
        out.push(layer);
        continue;
      }
      const id = layer.contentRef;
      if (this.removedMeasurementIds.has(id)) continue; // 後端還沒 echo 的刪除
      seen.add(id);
      const local = this.measurements.get(id);
      if (local === undefined) {
        if (layer.measurement !== undefined) this.measurements.set(id, layer.measurement);
        out.push(this.decorateMeasurementLayer(layer, layer.measurement ?? null));
      } else {
        out.push(this.decorateMeasurementLayer(layer, local));
      }
    }
    let n = 0;
    for (const [id, m] of this.measurements) {
      n += 1;
      if (seen.has(id)) continue;
      out.push(
        this.decorateMeasurementLayer(
          {
            layerId: `measurement:${id}`,
            kind: 'measurement',
            label: m.label,
            groupId: 'measurements',
            frameOfReferenceUid: m.frameOfReferenceUid,
            contentRef: id,
            visible: true,
            opacity: 1,
            order: 1000 + n,
          },
          m,
        ),
      );
    }
    return out;
  }

  /** 掛上 `result`（值 ＋ HU 統計；由 points 導出，不存）。 */
  private decorateMeasurementLayer(layer: Layer, m: Measurement | null): Layer {
    if (m === null) return layer;
    const image = this.layers.find((l) => l.kind === 'image' && l.frameOfReferenceUid === m.frameOfReferenceUid) ??
      this.scene.orderedLayers().find((l) => l.kind === 'image' && l.frameOfReferenceUid === m.frameOfReferenceUid);
    const entry = image ? this.volumes.image(image.contentRef) : undefined;
    // 地標對的 TRE 用**目前**的對位（含未提交的微調、關掉對位時就是未對位的誤差）
    const value =
      m.kind === 'landmark'
        ? { value: landmarkTre(m.points, (p) => toPrimaryWorld(this.frameGroupFor(m.frameOfReferenceUid), p)) ?? 0, unit: 'mm' as const }
        : measurementValue(m);
    const raw = isComplete(m) ? measurementStats(m, entry) : null;
    // 統計值換成影像的單位（PET 存 SUV×100 → SUV）
    const vs = valueScaleOf(image);
    const stats =
      raw === null
        ? null
        : vs.scale === 1
          ? { ...raw, unit: vs.unit }
          : { ...raw, mean: raw.mean * vs.scale, stdev: raw.stdev * vs.scale, min: toDisplayValue(raw.min, vs), max: toDisplayValue(raw.max, vs), unit: vs.unit };
    const decorated: Measurement = { ...m, result: { ...value, ...(stats ? { stats } : {}) } };
    return { ...layer, label: m.label, measurement: decorated };
  }

  /** 量測改了 → 重組圖層、重畫 SVG、通知 UI（不重切影像）。 */
  private refreshMeasurements(): void {
    this.setLayers(this.scene.orderedLayers());
    for (const id of this.bindings.keys()) this.syncSvg(id);
    this.onStateChange();
  }

  currentMeasurements(): readonly Measurement[] {
    return [...this.measurements.values()];
  }

  currentSelectedMeasurement(): string | null {
    return this.selectedMeasurementId;
  }

  selectMeasurement(measurementId: string | null): void {
    this.selectedMeasurementId = measurementId !== null && this.measurements.has(measurementId) ? measurementId : null;
    for (const id of this.bindings.keys()) this.syncSvg(id);
    this.onStateChange();
  }

  /**
   * 量測範本：下一個這種量測用這個名稱（草稿一建立就套上），完成（第一次 commit）後清掉 ——
   * 面板看到它變回 null 就知道這一步量完了、換下一步。
   */
  setMeasurementLabelHint(hint: { kind: MeasurementKind; label: string } | null): void {
    this.measurementLabelHint = hint;
    this.onStateChange();
  }

  currentMeasurementLabelHint(): { kind: MeasurementKind; label: string } | null {
    return this.measurementLabelHint;
  }

  // ── 時間軸 ────────────────────────────────────────────────────────────────

  /** 時間序列（影像／劑量）的目前相位告訴倉庫 —— `image(seriesId)` 因此預設就是這個相位。 */
  private syncSeriesFrames(): void {
    for (const layer of this.layers) {
      if (!layer.temporalGroupId || voxelStorageOf(layer.kind) !== 'volume') continue;
      this.volumes.setSeriesFrame(layer.contentRef, this.temporal.get(layer.temporalGroupId)?.cursor ?? 0);
    }
  }

  /** 每個時間群組的狀態（面板用）。 */
  currentTemporal(): TemporalState[] {
    return [...this.temporal.values()].map((r) => {
      // 攤開的每一幀共用同一個序列 → 去重
      const seriesIds = [...new Set(this.layers.filter((l) => l.temporalGroupId === r.group.temporalGroupId && voxelStorageOf(l.kind) === 'volume').map((l) => l.contentRef))];
      const resident = seriesIds.length === 0 ? [] : seriesIds.map((id) => new Set(this.volumes.residentFrames(id))).reduce((a, b) => new Set([...a].filter((f) => b.has(f))));
      const fullRes = seriesIds.length === 0 ? [] : seriesIds.map((id) => new Set(this.volumes.residentFrames(id, 0))).reduce((a, b) => new Set([...a].filter((f) => b.has(f))));
      return {
        temporalGroupId: r.group.temporalGroupId,
        kind: r.group.kind,
        frameCount: r.group.frameCount,
        frameTimes: r.group.frameTimes ? [...r.group.frameTimes] : null,
        axisLabel: r.group.axisLabel,
        frameLabels: r.group.frameLabels ? [...r.group.frameLabels] : null,
        unit: r.group.unit ?? null,
        cursor: r.cursor,
        playing: r.playing,
        fps: r.fps,
        loop: r.loop,
        rangeFrom: r.rangeFrom,
        rangeTo: r.rangeTo,
        residentFrames: [...resident].sort((a, b) => a - b),
        fullResFrames: [...fullRes].sort((a, b) => a - b),
        seriesIds,
      };
    });
  }

  /** 跳到某個相位（夾在 0..frameCount-1）；該群組的影像、劑量、結構一起換（游標屬於群組）。 */
  setTemporalFrame(groupId: string, frameIndex: number): void {
    const r = this.temporal.get(groupId);
    if (r === undefined) return;
    const max = (r.group.frameCount ?? Number.MAX_SAFE_INTEGER) - 1;
    const next = Math.min(max, Math.max(0, Math.round(frameIndex)));
    if (next === r.cursor) return;
    r.cursor = next;
    this.syncSeriesFrames();
    // ViewReference 帶相位：在相位 3 上量的距離要回得到相位 3。只記主影像所屬的群組
    const primaryTemporal = this.windowTargetLayer()?.temporalGroupId ?? null;
    if (primaryTemporal === groupId) {
      for (const binding of this.bindings.values()) binding.camera = { ...binding.camera, temporalGroupId: groupId, frameIndex: next };
    }
    if (this.measurements.size > 0) this.setLayers(this.scene.orderedLayers()); // HU 統計換相位
    // 這一幀的全解析度已經在倉裡 → 播放中也用全品質畫（像影片一樣；播放中的低解析度只在還沒抓到時）
    this.render(r.playing && !this.frameIsFullRes(groupId, next) ? 'interactive' : 'final');
    this.onStateChange();
  }

  /** 群組裡每個可見的體積序列在這一幀都有 lod 0。 */
  private frameIsFullRes(groupId: string, frame: number): boolean {
    const ids = this.layers.filter((l) => l.visible && l.temporalGroupId === groupId && voxelStorageOf(l.kind) === 'volume').map((l) => l.contentRef);
    return ids.length > 0 && ids.every((id) => this.volumes.hasImageLod(id, 0, frame));
  }

  /** 播放範圍內前進／後退一格（`cyclic` 或開了循環就繞回；否則到頭停住並停止播放）。 */
  stepTemporal(groupId: string, delta: number): void {
    const r = this.temporal.get(groupId);
    if (r === undefined) return;
    const { frame, stop } = stepInRange({ cursor: r.cursor, delta, from: r.rangeFrom, to: r.rangeTo, loop: r.loop });
    if (stop && r.playing) this.setTemporalPlayback(groupId, { playing: false });
    this.setTemporalFrame(groupId, frame);
  }

  /** 播放狀態：播放／暫停、fps（1–30）、循環、播放範圍（DCE 的時間窗）。 */
  setTemporalPlayback(groupId: string, patch: Partial<Pick<TemporalState, 'playing' | 'fps' | 'loop' | 'rangeFrom' | 'rangeTo'>>): void {
    const r = this.temporal.get(groupId);
    if (r === undefined) return;
    const last = Math.max(0, (r.group.frameCount ?? 1) - 1);
    if (patch.fps !== undefined) r.fps = Math.min(30, Math.max(1, patch.fps));
    if (patch.loop !== undefined) r.loop = patch.loop;
    if (patch.rangeFrom !== undefined) r.rangeFrom = Math.min(last, Math.max(0, Math.round(patch.rangeFrom)));
    if (patch.rangeTo !== undefined) r.rangeTo = Math.min(last, Math.max(0, Math.round(patch.rangeTo)));
    if (patch.playing !== undefined) r.playing = patch.playing;
    this.restartPlayback();
    // 停下來 → 補一張全品質（播放中低解析度、暫停後補到全解析度）
    if (patch.playing === false) this.render('final');
    this.onStateChange();
  }

  /** 一個計時器推所有播放中的群組（各自的 fps 用累積時間算）。 */
  private restartPlayback(): void {
    if (this.playbackTimer !== null) clearInterval(this.playbackTimer);
    this.playbackTimer = null;
    const playing = [...this.temporal.values()].filter((r) => r.playing);
    if (playing.length === 0) return;
    const tickMs = Math.max(15, Math.min(...playing.map((r) => 1000 / r.fps)));
    const due = new Map(playing.map((r) => [r.group.temporalGroupId, performance.now() + 1000 / r.fps]));
    this.playbackTimer = setInterval(() => {
      const now = performance.now();
      for (const r of this.temporal.values()) {
        if (!r.playing) continue;
        const at = due.get(r.group.temporalGroupId) ?? now;
        if (now + 1 < at) continue;
        due.set(r.group.temporalGroupId, at + 1000 / r.fps);
        this.stepTemporal(r.group.temporalGroupId, 1);
      }
    }, tickMs);
  }

  /**
   * 某個時間序列在一點（沒給 ＝ 十字線）上的時間曲線（DCE 的 time-intensity curve）—— 每個已載入相位取最近體素的值（該序列 FoR 的世界座標）。
   * 沒載入的相位回 null。
   */
  temporalCurve(seriesId: string, worldPrimary: Vec3 = this.crosshairWorld()): (number | null)[] {
    const layer = this.layers.find((l) => l.contentRef === seriesId && voxelStorageOf(l.kind) === 'volume');
    const group = layer?.temporalGroupId ? this.temporal.get(layer.temporalGroupId) : undefined;
    if (layer === undefined || group === undefined || group.group.frameCount === null) return [];
    const own = fromPrimaryWorld(this.frameGroupFor(layer.frameOfReferenceUid), worldPrimary);
    const out: (number | null)[] = [];
    for (let f = 0; f < group.group.frameCount; f += 1) {
      const entry = [0, 1, 2].map((lod) => this.volumes.image(seriesId, lod, f)).find((e) => e !== undefined && e.frameIndex === f);
      if (entry === undefined) {
        out.push(null);
        continue;
      }
      const ijk = worldToNearestVoxel(entry.grid, own);
      out.push(ijk === null ? null : voxelAt(entry, ijk));
    }
    return out;
  }

  /** 面板「編輯頂點」：只對已完成的面積與曲線；草稿進行中先收掉（釋放工具）。 */
  beginVertexEdit(measurementId: string): void {
    const m = this.measurements.get(measurementId);
    if (m === undefined || (m.kind !== 'area' && m.kind !== 'curve') || this.draftMeasurementIds.has(measurementId)) return;
    if (this.vertexEdit !== null && this.vertexEdit.measurementId !== measurementId) this.endVertexEdit(true);
    this.releaseTool();
    this.vertexEdit = { measurementId, before: m };
    this.selectedMeasurementId = measurementId;
    this.refreshMeasurements();
  }

  /** `commit`：合成一筆 undo 並送後端（沒改就什麼都不做）；否則回到進入編輯前的形狀。 */
  endVertexEdit(commit: boolean): void {
    const edit = this.vertexEdit;
    if (edit === null) return;
    this.vertexEdit = null;
    this.highlightedVertex = null;
    const now = this.measurements.get(edit.measurementId);
    if (now === undefined) return;
    const changed = now.points.length !== edit.before.points.length || now.points.some((v, i) => v !== edit.before.points[i]);
    if (commit) {
      if (changed) this.commitMeasurement(edit.measurementId, edit.before);
    } else if (changed) {
      this.measurements.set(edit.measurementId, edit.before);
    }
    this.refreshMeasurements();
  }

  currentVertexEdit(): { measurementId: string } | null {
    return this.vertexEdit === null ? null : { measurementId: this.vertexEdit.measurementId };
  }

  highlightVertex(measurementId: string, index: number | null): void {
    const next = index === null ? null : { measurementId, index };
    if (next === null && (this.highlightedVertex === null || this.highlightedVertex.measurementId !== measurementId)) return;
    this.highlightedVertex = next;
    for (const id of this.bindings.keys()) this.syncSvg(id);
  }

  setMeasurementOptions(opts: { showFaded?: boolean }): void {
    if (opts.showFaded !== undefined) this.showFadedMeasurements = opts.showFaded;
    for (const id of this.bindings.keys()) this.syncSvg(id);
    this.onStateChange();
  }

  /** `commit:false` ＝ 進行中（橡皮筋線／未收口的多邊形）：不進 undo、不存後端。 */
  addMeasurement(m: Measurement, opts: { commit?: boolean } = {}): void {
    const hint = this.measurementLabelHint;
    if (hint !== null && hint.kind === m.kind) m = { ...m, label: hint.label };
    this.measurements.set(m.measurementId, m);
    this.removedMeasurementIds.delete(m.measurementId);
    this.selectedMeasurementId = m.measurementId;
    if (opts.commit !== false) this.commitMeasurement(m.measurementId, null);
    else this.draftMeasurementIds.add(m.measurementId);
    this.refreshMeasurements();
  }

  updateMeasurement(
    measurementId: string,
    patch: { points?: Float64Array | readonly number[]; label?: string },
    opts: { commit?: boolean } = {},
  ): void {
    const before = this.measurements.get(measurementId);
    if (before === undefined) return;
    const after: Measurement = {
      ...before,
      ...(patch.points !== undefined ? { points: Float64Array.from(patch.points) } : {}),
      ...(patch.label !== undefined ? { label: patch.label } : {}),
    };
    this.measurements.set(measurementId, after);
    if (opts.commit !== false) this.commitMeasurement(measurementId, before);
    this.refreshMeasurements();
  }

  removeMeasurement(measurementId: string, opts: { commit?: boolean } = {}): void {
    const before = this.measurements.get(measurementId);
    if (before === undefined) return;
    this.measurements.delete(measurementId);
    this.draftMeasurementIds.delete(measurementId);
    if (this.vertexEdit?.measurementId === measurementId) this.vertexEdit = null;
    if (this.selectedMeasurementId === measurementId) this.selectedMeasurementId = null;
    if (opts.commit !== false) {
      this.undo.push(this.measurementOp(measurementId, before, null));
      this.onMeasurementChange?.('remove', before);
    }
    // 🔴 草稿也要記進 removedMeasurementIds：`refreshMeasurements()` 會把 scene 裡**還在**的那個 layer 餵回
    // `withMeasurementLayers()`，不記的話它被當成「後端來的、本地沒有的」收回來 —— 按 ✕ 取消的多邊形變成一個已完成的幽靈
    // （2026-09-16 headless Chrome 重現）。
    this.removedMeasurementIds.add(measurementId);
    this.refreshMeasurements();
  }

  /** 進行中的量測收尾：推 undo（建立時 before 為 null）＋ 存後端（新建 POST、否則 PATCH）。 */
  commitMeasurement(measurementId: string, before: Measurement | null): void {
    const after = this.measurements.get(measurementId);
    if (after === undefined) return;
    if (this.draftMeasurementIds.delete(measurementId)) {
      for (const id of this.bindings.keys()) this.syncSvg(id);
    }
    if (before !== null && before.points.length === after.points.length && before.label === after.label &&
        before.points.every((v, i) => v === after.points[i])) {
      return; // 沒動：不佔 undo 格、不送
    }
    this.undo.push(this.measurementOp(measurementId, before, after));
    this.onMeasurementChange?.(before === null ? 'add' : 'update', after);
    const hint = this.measurementLabelHint;
    if (before === null && hint !== null && hint.kind === after.kind && hint.label === after.label) this.measurementLabelHint = null;
    this.onStateChange();
  }

  private measurementOp(measurementId: string, before: Measurement | null, after: Measurement | null): MeasurementOp {
    const view = [...this.bindings.values()].find((b) => b.renderer !== null)?.camera ?? (before ?? after)!.provenance.viewReference!;
    const label = (after ?? before)?.kind;
    return { kind: 'measurement', measurementId, before, after, viewReference: view, ...(label !== undefined ? { label } : {}) };
  }

  private applyUndoEntry(op: UndoEntry, direction: 'undo' | 'redo'): void {
    if (isEditOp(op)) {
      this.applyEditOp(op, direction);
      return;
    }
    const target = direction === 'undo' ? op.before : op.after;
    const existed = this.measurements.has(op.measurementId);
    if (target === null) {
      const prev = this.measurements.get(op.measurementId);
      this.measurements.delete(op.measurementId);
      this.removedMeasurementIds.add(op.measurementId);
      if (this.selectedMeasurementId === op.measurementId) this.selectedMeasurementId = null;
      if (prev !== undefined) this.onMeasurementChange?.('remove', prev);
    } else {
      this.measurements.set(op.measurementId, target);
      this.removedMeasurementIds.delete(op.measurementId);
      this.onMeasurementChange?.(existed ? 'update' : 'add', target);
    }
    this.refreshMeasurements();
  }

  /** 量測所屬 FoR 的作用中影像 layer：`windowTargetLayer()`（可見、作用中或最底下那張）。 */
  activeImageLayerForMeasure(): Layer | null {
    return this.windowTargetLayer();
  }

  /** 鍵盤（選取後按 Delete 刪除；工具自己的 Enter／Esc）。 */
  handleKey(viewportId: string, key: string): boolean {
    if (this.vertexEdit !== null) {
      // 編輯頂點中：Esc ＝ 完成；Delete 不刪整個量測（面板列上有刪頂點）
      if (key === 'Escape') this.endVertexEdit(true);
      return key === 'Escape' || key === 'Delete' || key === 'Backspace';
    }
    const instance = this.toolInstanceFor(viewportId);
    if (instance?.onKeyDown && instance.onKeyDown(key) === true) return true;
    if ((key === 'Delete' || key === 'Backspace') && this.selectedMeasurementId !== null) {
      this.removeMeasurement(this.selectedMeasurementId);
      return true;
    }
    if (key === 'Escape' && this.selectedMeasurementId !== null) {
      this.selectMeasurement(null);
      return true;
    }
    return this.keySliceStep(viewportId, key);
  }

  /** 這一格的量測 SVG：投影、顯示模式、交線／截面、控制點。 */
  private measurementSvg(viewportId: string): { nodes: ReturnType<typeof measurementNodes>; handles: SvgHandle[] } {
    const binding = this.bindings.get(viewportId);
    const nodes: ReturnType<typeof measurementNodes> = [];
    const handles: SvgHandle[] = [];
    if (!binding || binding.renderer === null) return { nodes, handles };
    const renderer = binding.renderer;
    const camera = binding.camera;
    const hidden = this.hiddenPerViewport.get(viewportId);
    // 🔴 只有十字線工具作用中，既有量測才可拖（身體把手、頂點把手）。
    // 原本量測工具也可以 —— 結果畫第二個面積時，點在前一個多邊形的邊或頂點附近就變成「拖前一個」，
    // 面積工具看起來像壞掉（headless Chrome 重現：前一個多邊形被選中、面積值一直變）。
    const drawingTool = this.activeToolId !== null && this.activeToolId !== 'navigate';
    for (const layer of this.layers) {
      if (layer.kind !== 'measurement' || !layer.visible || layer.measurement === undefined) continue;
      if (hidden?.has(layer.layerId)) continue;
      const m = layer.measurement;
      const fg = this.frameGroupFor(m.frameOfReferenceUid);
      // 地標對：移動點經目前對位搬進 primary，固定點本來就是 primary 座標
      const primaryPts: Vec3[] =
        m.kind === 'landmark' && m.points.length >= 6 ? [toPrimaryWorld(fg, [m.points[0]!, m.points[1]!, m.points[2]!]), [m.points[3]!, m.points[4]!, m.points[5]!]] : pointsToPrimary(m, fg);
      const inPrimary: Measurement = {
        ...m,
        viewReference: m.viewReference ? viewToPrimary(m.viewReference, fg) : null,
      };
      const mode = measurementDisplayMode(camera, inPrimary);
      if (mode === 'hidden' || (mode === 'faded' && !this.showFadedMeasurements)) continue;
      const isDraft = this.draftMeasurementIds.has(m.measurementId);
      const editingVertices = this.vertexEdit?.measurementId === m.measurementId;
      // 草稿（進行中的多邊形）與面板編輯中的量測：頂點永遠可拖；其他已完成的只在十字線工具下可拖
      const editable = isMeasurementEditable(camera, inPrimary) && m.kind !== 'roi3d' && m.kind !== 'landmark' && (isDraft || editingVertices || !drawingTool);
      const ownView = viewInFrame(camera, fg);
      const input: MeasurementSvgInput = {
        measurement: m,
        pointsPx: primaryPts.map((p) => renderer.worldToCanvas(p)),
        mode,
        selected: this.selectedMeasurementId === m.measurementId,
        editable,
        draft: isDraft,
        editingVertices,
        highlightIndex: this.highlightedVertex?.measurementId === m.measurementId ? this.highlightedVertex.index : null,
        // 編輯頂點期間其他量測都不吃點擊（點空白也不開新多邊形，見 handleToolCommand）
        allowBody: !drawingTool && !isDraft && (this.vertexEdit === null || editingVertices),
        boxCornersDraggable: m.kind === 'roi3d' && orthogonalAxisOf(ownView.viewPlaneNormal) !== null,
        valueText: formatMeasurementValue(m, m.result),
        ...(m.kind === 'area' && mode === 'intersection-only'
          ? { intersectionPx: polygonPlaneIntersection(primaryPts, camera).map(([a, b]) => [renderer.worldToCanvas(a), renderer.worldToCanvas(b)] as const) }
          : {}),
        ...(m.kind === 'roi3d' && m.points.length >= 6
          ? { sectionPx: boxPlaneSection(boxCorners(m.points).map((c) => toPrimaryWorld(fg, c)), camera).map((p) => renderer.worldToCanvas(p)) }
          : {}),
      };
      nodes.push(...measurementNodes(input));
      handles.push(...measurementHandles(input));
    }
    return { nodes, handles };
  }

  /** 這一格要畫的 layer：全部減掉這格額外隱藏的。 */
  private layersFor(viewportId: string): readonly Layer[] {
    const hidden = this.hiddenPerViewport.get(viewportId);
    if (hidden === undefined || hidden.size === 0) return this.layers;
    return this.layers.filter((l) => !hidden.has(l.layerId));
  }

  // ── 每格覆寫與相機連動 ────────────────────────────────────────────────────

  /** 這一格額外隱藏哪些 layer（整組覆寫；空陣列 ＝ 清掉）。 */
  setViewportHiddenLayers(viewportId: string, layerIds: readonly string[]): void {
    if (layerIds.length === 0) this.hiddenPerViewport.delete(viewportId);
    else this.hiddenPerViewport.set(viewportId, new Set(layerIds));
    const binding = this.bindings.get(viewportId);
    binding?.renderer?.setLayers(this.layersFor(viewportId));
    binding?.renderer?.render('final');
    this.onStateChange();
  }

  viewportHiddenLayers(): Record<string, string[]> {
    const out: Record<string, string[]> = {};
    for (const [id, set] of this.hiddenPerViewport) out[id] = [...set];
    return out;
  }

  /** 相機連動群（整組覆寫）：`{ group: [viewportId…] }`。設定當下就把同群對齊到第一個已掛載的格子。 */
  setCameraLinks(groups: Readonly<Record<string, readonly string[]>>): void {
    this.cameraLinks.clear();
    for (const [group, ids] of Object.entries(groups)) {
      for (const id of ids) this.cameraLinks.set(id, group);
      const source = ids.find((id) => this.bindings.get(id)?.renderer !== null && this.bindings.has(id));
      if (source !== undefined) this.mirrorCamera(source);
    }
  }

  cameraLinkGroups(): Record<string, string[]> {
    const out: Record<string, string[]> = {};
    for (const [id, group] of this.cameraLinks) (out[group] ??= []).push(id);
    return out;
  }

  /** 把這一格的相機（含 zoom）複製到同群的其他格並重畫。沒有連動時什麼都不做。 */
  private mirrorCamera(viewportId: string): void {
    const group = this.cameraLinks.get(viewportId);
    if (group === undefined) return;
    const source = this.bindings.get(viewportId);
    if (!source || source.renderer === null) return;
    for (const [id, link] of this.cameraLinks) {
      if (link !== group || id === viewportId) continue;
      const target = this.bindings.get(id);
      if (!target || target.renderer === null) continue;
      target.camera = source.camera;
      target.renderer.setPxMm(source.renderer.currentPxMm());
      target.renderer.setCamera(target.camera);
      target.renderer.render(this.scene.currentQuality());
    }
  }

  currentLayers(): readonly Layer[] {
    return this.scene.orderedLayers();
  }

  setVisible(layerId: string, visible: boolean): void {
    this.scene.setVisible(layerId, visible);
    this.setLayers(this.scene.orderedLayers()); // 內含 followPinnedTarget（作用中的那張可能換了）
    this.enforceFullResBudget();
    this.render('final');
    this.onStateChange();
  }

  setGroupVisible(groupId: string, visible: boolean): void {
    this.scene.setGroupVisible(groupId, visible);
    this.setLayers(this.scene.orderedLayers());
    this.enforceFullResBudget();
    this.render('final');
    this.onStateChange();
  }

  /**
   * 結構的顯示樣式（outline／fill／fill+outline）。改的是 scene 裡**同一個** layer 物件（同 `setOpacity`），
   * `SceneManager.setLayer` 依 `resolveRenderers` 的 diff 只加／減 fill 那個 handle，輪廓不重建。
   * 超過 fill 上限（4 個結構）回 false、不改。
   */
  setRenderStyle(layerId: string, style: MaskRenderStyle): boolean {
    const layer = this.scene.layer(layerId);
    if (layer === null || layer.kind !== 'mask') return false;
    if (!canUseRenderStyle(this.scene.orderedLayers(), layerId, style)) return false;
    layer.renderStyle = style;
    this.scene.setLayer(layer);
    this.setLayers(this.scene.orderedLayers());
    this.render('final');
    this.onStateChange();
    return true;
  }

  setOpacity(layerId: string, opacity: number): void {
    this.scene.setOpacity(layerId, opacity);
    this.setLayers(this.scene.orderedLayers());
    this.render('final');
    this.onStateChange();
  }

  /**
   * 改一個 layer 的可變顯示欄位：`windowLevel`／`colormap`／`params`。
   *
   * 走 `SceneManager.layer()` 拿到的是**同一個物件**（`setOpacity` 也是這樣改的），
   * 因此 renderer 下一幀就看到；不重建 handle。
   */
  updateLayer(
    layerId: string,
    patch: {
      windowLevel?: { center: number; width: number };
      colormap?: string;
      blendMode?: Layer['blendMode'];
      params?: Record<string, unknown>;
    },
  ): boolean {
    const layer = this.scene.layer(layerId);
    if (layer === null) return false;
    if (patch.windowLevel !== undefined) layer.windowLevel = patch.windowLevel;
    if (patch.colormap !== undefined) layer.colormap = patch.colormap;
    if (patch.blendMode !== undefined) layer.blendMode = patch.blendMode;
    if (patch.params !== undefined) layer.params = { ...(layer.params ?? {}), ...patch.params };
    this.setLayers(this.scene.orderedLayers());
    this.render('final');
    this.onStateChange();
    return true;
  }

  /** 右鍵 WW/WL 與閾值筆刷的目標影像。null = 回到「最底下的可見影像」。 */
  setActiveImageLayer(layerId: string | null): void {
    this.activeImageLayerId = layerId;
    // 攤開的那一張變成作用中 → 時間軸游標跟過去（結構跟著作用中的那一幀；新畫的結構屬於它）
    this.followPinnedTarget();
    this.onStateChange();
  }

  // ── 每一格鎖定相位 ────────────────────────────────────────────────────────

  /** 這一格的相位覆寫（renderer、筆刷、讀數共用）；每次呼叫讀最新的表。 */
  private frameOverrideFor(viewportId: string): FrameOverride {
    return this.frameLocks.overrideFor(viewportId);
  }

  /** 這一格把某條時間軸鎖在第 `frame` 幀（`null` ＝ 解除、跟游標）。 */
  setViewportFrame(viewportId: string, groupId: string, frame: number | null): void {
    const r = this.temporal.get(groupId);
    this.frameLocks.set(viewportId, groupId, frame, r === undefined ? null : (r.group.frameCount ?? 1));
    this.bindings.get(viewportId)?.renderer?.render('final');
    this.onStateChange();
  }

  /**
   * 面板上新建的結構屬於哪一幀 —— 最後按過的那一格鎖了相位就是那一幀，否則游標（攤開時 ＝ 作用中的那一張）。
   */
  drawingFrame(groupId: string): number {
    return this.frameLocks.drawingLock(groupId) ?? this.temporal.get(groupId)?.cursor ?? 0;
  }

  viewportFrameLocks(): Record<string, Record<string, number>> {
    return this.frameLocks.snapshot();
  }

  currentActiveImageLayer(): string | null {
    return this.activeImageLayerId;
  }

  /**
   * 「套用 REG／不套用」。關掉的 FoR 以單位矩陣擺放 —— 整個 FrameGroup
   * 一起（影像、劑量、結構、讀數、筆刷），因為它們都經 `frameGroupFor()`。
   */
  setTransformEnabled(frameOfReferenceUid: string, enabled: boolean): void {
    if (enabled) this.disabledTransforms.delete(frameOfReferenceUid);
    else this.disabledTransforms.add(frameOfReferenceUid);
    if ([...this.measurements.values()].some((m) => m.kind === 'landmark')) this.setLayers(this.scene.orderedLayers());
    this.render('final');
    this.onStateChange();
  }

  disabledTransformUids(): string[] {
    return [...this.disabledTransforms];
  }

  // ── 對位微調 ──────────────────────────────────────────────────────────────

  /**
   * 覆寫一個 FoR 的 `transformToPrimary`；`null` ＝ 回到後端給的。
   * 只是換掉 `frameGroupFor()` 的回答 —— 影像、劑量、結構、讀數、筆刷一起動。
   */
  setFrameGroupTransform(frameOfReferenceUid: string, transformToPrimary: Mat16 | null): void {
    if (transformToPrimary === null) this.transformOverrides.delete(frameOfReferenceUid);
    else {
      if (transformToPrimary.length !== 16) throw new Error(t('transformToPrimary 必須是 16 個 float'));
      this.transformOverrides.set(frameOfReferenceUid, [...transformToPrimary]);
    }
    // 地標對的 TRE 跟著微調即時變
    if ([...this.measurements.values()].some((m) => m.kind === 'landmark')) this.setLayers(this.scene.orderedLayers());
    this.render('final');
    this.onStateChange();
  }

  transformOverrideFor(frameOfReferenceUid: string): Mat16 | null {
    return this.transformOverrides.get(frameOfReferenceUid) ?? null;
  }

  transformOverrideList(): { frameOfReferenceUid: string; transformToPrimary: Mat16 }[] {
    return [...this.transformOverrides].map(([frameOfReferenceUid, transformToPrimary]) => ({
      frameOfReferenceUid,
      transformToPrimary,
    }));
  }

  /**
   * 後端推來新的 FrameGroup（提交對位之後的 `scene.replace`）。網格不變，因此不必
   * 重建 host；被換掉的 FoR 的本地覆寫同時清掉 —— 它已經被存進去了。
   */
  setFrameGroups(frameGroups: readonly FrameGroup[]): void {
    this.gridSet = { ...this.gridSet, frameGroups };
    for (const fg of frameGroups) this.transformOverrides.delete(fg.frameOfReferenceUid);
    this.render('final');
    this.onStateChange();
  }

  setToolParams(patch: Record<string, unknown>): void {
    this.toolParams = { ...this.toolParams, ...patch };
    this.onStateChange();
  }

  currentToolParams(): Record<string, unknown> {
    return this.toolParams;
  }

  /**
   * 某個影像序列的體素值直方圖（TF 編輯器的底圖）。等距取樣最多約 200 萬個體素；`counts.length === bins`。
   * 還沒載進來時 null。
   */
  imageHistogram(seriesId: string, bins = 128, range: [number, number] = [-1024, 3071]): { counts: number[]; min: number; max: number } | null {
    const entry = this.volumes.image(seriesId);
    if (entry === undefined) return null;
    const v = entry.voxels;
    const stride = Math.max(1, Math.floor(v.length / 2_000_000));
    const counts = new Array<number>(bins).fill(0);
    const [lo, hi] = range;
    const scale = bins / (hi - lo);
    for (let i = 0; i < v.length; i += stride) {
      const x = v[i]!;
      let b = Math.floor((x - lo) * scale);
      if (b < 0) b = 0;
      else if (b >= bins) b = bins - 1;
      counts[b] = counts[b]! + 1;
    }
    return { counts, min: lo, max: hi };
  }

  /** 某個影像序列的世界包圍盒（自身 FoR；8 個角的極值）；還沒載進來時 null。 */
  imageGridBounds(seriesId: string): { min: [number, number, number]; max: [number, number, number] } | null {
    const entry = this.volumes.image(seriesId);
    if (entry === undefined) return null;
    const corners = cornersWorld(entry.grid);
    const min: [number, number, number] = [Infinity, Infinity, Infinity];
    const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
    for (const c of corners) for (let a = 0; a < 3; a += 1) {
      min[a] = Math.min(min[a]!, c[a]!);
      max[a] = Math.max(max[a]!, c[a]!);
    }
    return { min, max };
  }

  /** 某個影像序列的體積中心（**自身 FoR** 的世界座標）；還沒載進來時 null。 */
  imageGridCenter(seriesId: string): [number, number, number] | null {
    const entry = this.volumes.image(seriesId);
    if (entry === undefined) return null;
    const [nx, ny, nz] = entry.grid.size;
    return indexToWorld(entry.grid, [(nx - 1) / 2, (ny - 1) / 2, (nz - 1) / 2]);
  }

  /** 影像／劑量體素進倉，並立刻重繪（漸進式 lod 的每一階都會走這裡）。 */
  putImage(args: {
    seriesId: string;
    lod: number;
    frameIndex?: number | null;
    grid: import('../geometry').Grid;
    voxels: Int16Array | Float32Array;
    defaultWindow: { center: number; width: number };
  }): void {
    this.volumes.putImage(args);
    this.enforceFullResBudget();
    // 影像到了（或 lod 升級）→ 量測的 HU 統計重算、≈ 去掉
    if (this.measurements.size > 0) this.setLayers(this.scene.orderedLayers());
    this.render('final');
    this.onStateChange();
  }

  /** `frameIndex` 沒給 ＝ 時間序列看目前相位、靜態序列看它自己。 */
  hasImage(seriesId: string, lod: number, frameIndex?: number | null): boolean {
    return frameIndex === undefined ? this.volumes.hasImageLod(seriesId, lod) : this.volumes.hasImageLod(seriesId, lod, frameIndex);
  }

  /** 這個序列有沒有任何一幀的全解析度在倉裡（「每一幀都留」的預算只算真的佔著的）。 */
  hasFullResAnyFrame(seriesId: string): boolean {
    return this.volumes.hasImageLodAnyFrame(seriesId, 0);
  }

  /**
   * 放這個序列的 lod 0 進來，會不會逐出別的**可見**序列（全解析度上限）。
   * 被逐出過的全解析度只在有空位時補回來 —— 不然兩個序列會互相逐出、一直重抓；
   * 以前則是逐出之後就再也不補（前端以為抓過了），把其他影像關掉 4D 也回不到每一幀都清楚。
   */
  canHoldFullRes(seriesId: string): boolean {
    const visible = new Set(this.layers.filter((l) => l.visible && voxelStorageOf(l.kind) === 'volume').map((l) => l.contentRef));
    return this.volumes.canHoldFullRes(seriesId, visible, maxFullResVolumes(this.tier), this.temporalVisibleSeries());
  }

  /** 看得見的時間序列（逐出全解析度時最後才走）。 */
  private temporalVisibleSeries(): Set<string> {
    return new Set(this.layers.filter((l) => l.visible && l.kind === 'image' && l.temporalGroupId).map((l) => l.contentRef));
  }

  /** 這個 layer 現在用哪一個相位（靜態 null）。App 抓 mask、後處理都要跟著它。 */
  frameOf(layer: Pick<Layer, 'temporalGroupId' | 'frameIndex'>): number | null {
    return this.volumes.frameOf(layer);
  }

  /**
   * 同時全解析度常駐的體積數依 Tier 限制；超過的丟 lod 0、保留 lod 2。
   * 被丟掉的也要從 wasm 的上傳快取移除，否則那 512 MB 還是被佔著。
   */
  private enforceFullResBudget(): void {
    const visible = new Set(
      this.layers.filter((l) => l.visible && voxelStorageOf(l.kind) === 'volume').map((l) => l.contentRef),
    );
    for (const key of this.volumes.enforceFullResBudget(visible, maxFullResVolumes(this.tier), this.temporalVisibleSeries())) {
      this.dropVolume(key);
    }
  }

  /**
   * 推送來的 `mask.updated`：要不要現在重抓（`SubmitQueue.remoteUpdate`）。自己那筆的回音、或這個結構還有沒送完的編輯
   * → 不重抓（重抓會用後端舊版蓋掉還沒送出的筆畫）；別人改的，佇列送完後經 `onRemoteMaskChange` 通知。
   */
  remoteMaskUpdate(structureId: string, frameIndex: number | null, contentHash: string): boolean {
    return this.submitQueue.remoteUpdate(structureId, frameIndex, contentHash);
  }

  /**
   * 從後端抓回來的 mask 進倉 —— 這個結構還有沒送完的編輯時**不蓋**：佇列送出時才從本地讀資料，
   * 蓋掉就等於丟掉還沒送出的筆畫。改成記下這個 hash，送完後跟最後一次 200 比，不一樣才再通知重抓。回傳有沒有放進去。
   */
  putFetchedMask(args: Parameters<ViewerHost['putMask']>[0]): boolean {
    if (this.submitQueue.busy(args.structureId, args.frameIndex)) {
      this.submitQueue.remoteUpdate(args.structureId, args.frameIndex, args.contentHash);
      return false;
    }
    this.putMask(args);
    return true;
  }

  /** mask 區塊進倉。**存的是裁切後的區塊，不是全網格**。 */
  putMask(args: {
    structureId: string;
    frameIndex: number | null;
    offsetIjk: readonly [number, number, number];
    sizeIjk: readonly [number, number, number];
    voxels: Uint8Array;
    contentHash: string;
    /** 結構所屬 FoR（決定用哪個 MaskGrid）。省略 ＝ 從 layer 清單查，再退回 primary。 */
    frameOfReferenceUid?: string;
  }): void {
    const maskGrid = this.maskGridForStructure(args.structureId, args.frameOfReferenceUid);
    this.volumes.putMask({
      structureId: args.structureId,
      frameIndex: args.frameIndex,
      blockGrid: blockGridOf(maskGrid.grid, args.offsetIjk, args.sizeIjk),
      offsetIjk: args.offsetIjk,
      sizeIjk: args.sizeIjk,
      voxels: args.voxels,
      contentHash: args.contentHash,
      revision: 0,
    });
    this.submitQueue.register({
      structureId: args.structureId,
      frameIndex: args.frameIndex,
      maskGridId: maskGrid.maskGridId,
      contentHash: args.contentHash,
    });
    // 重畫由 host 自己排（合併到下一幀）；App 不再每個 mask 叫一次 render()
    this.render('final');
  }

  /**
   * 某個結構的 MaskGrid。FoR 來自呼叫端或 layer 清單；都沒有就用 primary 的。
   */
  private maskGridForStructure(structureId: string, frameOfReferenceUid?: string): MaskGrid {
    const uid =
      frameOfReferenceUid ??
      this.layers.find((l) => l.kind === 'mask' && l.contentRef === structureId)?.frameOfReferenceUid;
    if (uid === undefined) return this.gridSet.maskGrid;
    try {
      return maskGridOf(this.gridSet, uid);
    } catch {
      return this.gridSet.maskGrid;
    }
  }

  /** 有編輯沒送到後端的結構（要在 UI 明示）。 */
  submitFailures(): QueueFailure[] {
    return this.submitQueue.failures();
  }

  /** 沒存到的那一筆再送一次。 */
  retrySubmit(structureId: string, frameIndex: number | null): boolean {
    const ok = this.submitQueue.retry(structureId, frameIndex);
    this.onStateChange();
    return ok;
  }

  /**
   * 放棄沒存到的那一筆 —— 佇列清掉、這個結構（這一幀）的 undo 清空（本地已經跟後端分歧）；
   * 呼叫端接著重抓後端的 mask 蓋掉本地的。
   */
  discardUnsaved(structureId: string, frameIndex: number | null): boolean {
    const ok = this.submitQueue.discard(structureId, frameIndex);
    if (ok) this.undo.invalidateStructure(structureId, frameIndex);
    this.onStateChange();
    return ok;
  }

  /** 沒存到的那一塊的中心（primary 世界座標），給「跳到那一塊」；沒有 → null。 */
  unsavedCenter(structureId: string, frameIndex: number | null): Vec3 | null {
    const f = this.submitQueue.failures().find((x) => x.structureId === structureId && x.frameIndex === frameIndex);
    const layer = this.layers.find((l) => l.kind === 'mask' && l.contentRef === structureId);
    if (f?.pending == null || layer === undefined) return null;
    const { offsetIjk: o, sizeIjk: z } = f.pending;
    const grid = this.maskGridForStructure(structureId, layer.frameOfReferenceUid).grid;
    const world = indexToWorld(grid, [o[0] + (z[0] - 1) / 2, o[1] + (z[1] - 1) / 2, o[2] + (z[2] - 1) / 2]);
    return toPrimaryWorld(this.frameGroupFor(layer.frameOfReferenceUid), world);
  }

  residentBytes(): { image: number; mask: number; total: number; wasm: number } {
    return { ...this.volumes.residentBytes(), wasm: this.kernel.memoryBytes() };
  }

  /** 卸載某影像／劑量的一個 lod（倉 ＋ wasm ＋ 重切快取）。回傳釋放的 bytes。 */
  dropImageLod(seriesId: string, lod: number, frameIndex?: number | null): number {
    // 時間序列：沒指定相位 ＝ 所有已載入的相位都卸（「卸載未顯示」）
    const frames = frameIndex !== undefined ? [frameIndex] : this.volumes.residentFrames(seriesId, lod).length > 0 ? this.volumes.residentFrames(seriesId, lod) : [null];
    let bytes = 0;
    for (const f of frames) {
      const b = this.volumes.dropImage(seriesId, lod, f);
      if (b > 0) this.dropVolume(imageVolumeKey(seriesId, lod, f));
      bytes += b;
    }
    return bytes;
  }

  /** 卸載一個 mask 的體素（倉 ＋ wasm ＋ 輪廓快取）。之後顯示時由 App 的 ensureMask 再抓。 */
  dropMaskVoxels(structureId: string, frameIndex: number | null): number {
    const entry = this.volumes.mask(structureId, frameIndex);
    if (entry === undefined) return 0;
    const key = maskVolumeKey(entry);
    const bytes = this.volumes.dropMask(structureId, frameIndex);
    this.dropVolume(key);
    return bytes;
  }

  // ── 渲染 ─────────────────────────────────────────────────────────────────

  /**
   * 重畫所有格 —— **合併到下一個動畫幀**。
   *
   * 2026-09-23 量到全顯示卡 5 秒：27 個 mask 在 92 ms 內到齊、每個都各叫一次 `render()`，每次同步
   * 重切 3 格的影像／劑量並重算全部可見輪廓。同一幀內的多次呼叫現在只畫一次，品質取最高
   * （有人要 final 就 final）。要立刻畫（測試、量測）用 `renderNow()`。
   */
  render(quality: Quality = 'final'): void {
    if (this.disposed) return;
    this.pendingRenderQuality = quality === 'final' || this.pendingRenderQuality === 'final' ? 'final' : 'interactive';
    if (this.renderScheduled) return;
    this.renderScheduled = true;
    const run = (): void => {
      this.flushRender();
    };
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(run);
    else setTimeout(run, 0);
  }

  /** 把排隊中的重畫立刻做掉（沒排就不動）。回傳有沒有真的畫。 */
  flushRender(): boolean {
    if (!this.renderScheduled) return false;
    this.renderScheduled = false;
    const quality = this.pendingRenderQuality ?? 'final';
    this.pendingRenderQuality = null;
    if (this.disposed) return false;
    this.renderNow(quality);
    return true;
  }

  /** 同步重畫所有格（不合併）。 */
  renderNow(quality: Quality = 'final'): void {
    if (this.disposed) return;
    for (const binding of this.bindings.values()) binding.renderer?.render(quality);
  }

  private renderScheduled = false;
  private pendingRenderQuality: Quality | null = null;

  /**
   * hybrid 重切：互動停止後，斜面的格向後端要 bspline 高品質重切（只對 `image` 層），
   * 放進重切快取同一個 key → 下一幀 `drawImage` 命中；相機再動就自然失效（key 含相機）。
   * 沒有 transport 或它沒有 `fetchHighQualityReslice` 就不做。
   */
  private hqSeq = 0;

  scheduleHighQuality(): void {
    const fetch = this.transport?.fetchHighQualityReslice?.bind(this.transport);
    if (!fetch || this.disposed) return;
    const seq = (this.hqSeq += 1);
    for (const [viewportId, binding] of this.bindings) {
      const renderer = binding.renderer;
      if (renderer === null) continue;
      const camera = binding.camera;
      const size: [number, number] = [binding.info.width, binding.info.height];
      const pxMm = renderer.currentPxMm();
      const images = this.layers.filter((l) => l.kind === 'image' && l.visible && !this.hiddenPerViewport.get(viewportId)?.has(l.layerId));
      const pending = images.flatMap((layer) => {
        const entry = this.volumes.forLayer(layer);
        if (entry === null) return [];
        let fg = null;
        try {
          fg = this.frameGroupFor(layer.frameOfReferenceUid);
        } catch {
          fg = null;
        }
        const view = viewInFrame(camera, fg);
        const args = imageResliceArgs(entry, view, size, pxMm);
        const key = planeCacheKey(args);
        return shouldRequestHighQuality({ view, alreadyHighQuality: this.resliceCache.isHighQuality(key), visibleImages: 1 })
          ? [{ layer, view, key, volumeKey: entry.volumeKey }]
          : [];
      });
      if (pending.length === 0) continue;
      const camKey = cameraKey(camera);
      for (const p of pending) {
        void fetch({ viewReference: p.view, outputSizePx: size, interpolator: 'bspline', seriesId: p.layer.contentRef, pxMm, outsideNaN: true })
          .then(({ plane }: { plane: Float32Array }) => {
            if (this.disposed || seq !== this.hqSeq) return;
            const b = this.bindings.get(viewportId);
            if (!b || cameraKey(b.camera) !== camKey || plane.length !== size[0] * size[1]) return;
            this.resliceCache.putPlane(p.key, plane, p.volumeKey);
            this.render('final');
          })
          .catch(() => undefined); // 高品質是加分項：失敗就留本地重切
      }
    }
  }

  /** 體積從 wasm 逐出時，它的重切／輪廓快取一起丟。 */
  private dropVolume(volumeKey: string): void {
    this.kernel.dropVolume(volumeKey);
    this.resliceCache.invalidateVolume(volumeKey);
  }

  /** 只重畫每格的面板 overlay 層（不重算影像與輪廓）。 */
  repaintOverlays(): void {
    if (this.disposed) return;
    for (const binding of this.bindings.values()) binding.renderer?.repaintOverlays();
  }

  /** 登記（或以 `null` 移除）一個可調方框；見 `editableBoxes`。拖曳中外部再設同一個 id 只換方框、不打斷拖曳。 */
  setEditableBox(ownerId: string, box: EditableBox | null, onChange?: (box: EditableBox, phase: 'move' | 'end') => void): void {
    if (box === null || onChange === undefined) this.editableBoxes.delete(ownerId);
    else this.editableBoxes.set(ownerId, { box, onChange });
    for (const id of this.bindings.keys()) this.syncSvg(id);
  }

  /** 這一格可調方框的把手：只在正交切面、十字線工具下；截面每個角一個、每條邊中點一個。 */
  private editableBoxHandles(viewportId: string): SvgHandle[] {
    const binding = this.bindings.get(viewportId);
    if (!binding || binding.renderer === null || this.editableBoxes.size === 0) return [];
    if (this.activeToolId !== null && this.activeToolId !== 'navigate') return [];
    if (orthogonalAxisOf(binding.camera.viewPlaneNormal) === null) return [];
    const renderer = binding.renderer;
    const out: SvgHandle[] = [];
    for (const [ownerId, { box }] of this.editableBoxes) {
      const section = boxPlaneSection(boxCorners([...box.min, ...box.max]), binding.camera);
      section.forEach((p, i) => {
        out.push({ id: `${ownerId}:corner:${i}`, kind: 'editable-box-corner', ownerId, pointIndex: i, position: renderer.worldToCanvas(p) });
        const q = section[(i + 1) % section.length]!;
        const mid: Vec3 = [(p[0] + q[0]) / 2, (p[1] + q[1]) / 2, (p[2] + q[2]) / 2];
        out.push({ id: `${ownerId}:edge:${i}`, kind: 'editable-box-edge', ownerId, pointIndex: i, position: renderer.worldToCanvas(mid) });
      });
    }
    return out;
  }

  /** 拖可調方框的角／邊（正交切面；沿法線的軸不動）。 */
  private dragEditableBox(viewportId: string, command: InteractionCommand): void {
    const handle = command.handle;
    const binding = this.bindings.get(viewportId);
    if (!handle || !binding || binding.renderer === null) return;
    const entry = this.editableBoxes.get(handle.ownerId);
    const axis = orthogonalAxisOf(binding.camera.viewPlaneNormal);
    if (entry === undefined || axis === null) return;
    const now = binding.renderer.canvasToWorld(command.position.x, command.position.y);
    if (command.phase === 'begin') {
      const section = boxPlaneSection(boxCorners([...entry.box.min, ...entry.box.max]), binding.camera);
      const i = handle.pointIndex ?? 0;
      const edge: [Vec3, Vec3] | null =
        handle.kind === 'editable-box-edge' && section.length >= 3 ? [section[i % section.length]!, section[(i + 1) % section.length]!] : null;
      const start: Vec3 = handle.kind === 'editable-box-corner' && section[i] !== undefined ? section[i] : now;
      this.boxDrag = { ownerId: handle.ownerId, before: entry.box, kind: handle.kind, startPrimary: start, edge };
      return;
    }
    const drag = this.boxDrag;
    if (drag === null || drag.ownerId !== handle.ownerId) return;
    const before = [...drag.before.min, ...drag.before.max];
    const next = drag.edge !== null ? dragBoxEdge(before, drag.edge, now, axis) : dragBoxCorner(before, drag.startPrimary, now, axis);
    const box: EditableBox = { min: [next[0]!, next[1]!, next[2]!], max: [next[3]!, next[4]!, next[5]!] };
    entry.box = box;
    if (command.phase === 'end') this.boxDrag = null;
    this.syncSvg(viewportId);
    entry.onChange(box, command.phase === 'end' ? 'end' : 'move');
  }

  /** 目前所有 viewport 的最後一幀量測（效能實測用）。 */
  frameStats(): FrameStats[] {
    return [...this.bindings.values()]
      .map((b) => b.renderer?.lastStats ?? null)
      .filter((s): s is FrameStats => s !== null);
  }

  // ── 互動 ─────────────────────────────────────────────────────────────────

  private handleCommand(viewportId: string, command: InteractionCommand): void {
    const binding = this.bindings.get(viewportId);
    if (!binding || binding.renderer === null) return;
    const grid = this.gridSet.displayGrid.grid;
    let changed = false;

    switch (command.action) {
      case 'scroll-slice': {
        const next = stepAlongNormal(grid, binding.camera, command.wheelTicks);
        // 捲到頭就停住，不要滑出資料範圍
        if (planeIntersectsGrid(grid, next)) {
          binding.camera = next;
          binding.renderer.setCamera(next);
          changed = true;
        }
        break;
      }
      case 'pan': {
        if (command.phase === 'move') {
          binding.camera = panInPlane(binding.camera, command.delta, binding.renderer.currentPxMm());
          binding.renderer.setCamera(binding.camera);
          changed = true;
        }
        break;
      }
      case 'zoom': {
        // 🔴 滾輪**往上**（deltaY < 0 → wheelTicks < 0）＝ 放大。
        // 先前寫反了，症狀是「捲上去影像越來越小」（見 zoomCameraAtCursor 的說明）。
        const factor = command.wheelTicks < 0 ? ZOOM_STEP : 1 / ZOOM_STEP;
        this.zoomViewport(viewportId, factor, command.position);
        changed = true;
        break;
      }
      case 'window-level': {
        if (command.phase === 'move') changed = this.adjustWindow(command);
        break;
      }
      case 'active-tool': {
        changed = this.handleToolCommand(viewportId, command);
        break;
      }
      case 'handle-drag': {
        if (command.handle?.kind === 'editable-box-corner' || command.handle?.kind === 'editable-box-edge') {
          this.dragEditableBox(viewportId, command);
          break;
        }
        if (
          command.handle?.kind === 'measurement-point' ||
          command.handle?.kind === 'measurement-body' ||
          command.handle?.kind === 'measurement-box-corner'
        ) {
          this.dragMeasurement(viewportId, command);
          break;
        }
        // 轉錶盤 → 繞該 handle 的軸旋轉平面，樞紐是 planeOrigin；
        // 拖曳中把累積角度顯示在十字線旁（使用者要知道轉了多少）
        if (command.handle?.kind !== 'crosshair-rotate' || binding.svg === null) break;
        if (command.phase === 'begin') {
          this.dragAngle.set(viewportId, 0);
          this.syncSvg(viewportId);
        } else if (command.phase === 'move') {
          const { sx, sy } = binding.renderer.cssToBackingScale();
          const to = { x: command.position.x * sx, y: command.position.y * sy };
          const from = { x: (command.position.x - command.delta.x) * sx, y: (command.position.y - command.delta.y) * sy };
          const angle = dialAngleDeg(binding.svg.center(), from, to);
          if (angle !== 0) {
            binding.camera = rotateInPlane(binding.camera, rotationAxisOf(command.handle), angle);
            binding.renderer.setCamera(binding.camera);
            this.dragAngle.set(viewportId, (this.dragAngle.get(viewportId) ?? 0) + angle);
            changed = true;
          }
        } else {
          this.dragAngle.delete(viewportId);
          this.syncSvg(viewportId);
          this.onStateChange();
        }
        break;
      }
      case 'none':
        break;
    }

    if (changed) {
      binding.renderer.render(this.scene.currentQuality());
      // 相機連動：pan／捲動／旋轉都經這裡；zoom 在 zoomViewport 裡自己 mirror
      if (command.action !== 'zoom' && command.action !== 'window-level' && command.action !== 'active-tool') {
        this.mirrorCamera(viewportId);
      }
      this.onStateChange();
    }
  }

  /**
   * 拖量測（選取後可編輯）：
   * * 頂點（`measurement-point`）：那一點跟著游標（面積的點留在自己的平面上）。
   * * 身體（`measurement-body`）：按下選中；拖了整體平移（位移換到該量測的 FoR；面積的位移投到自己的平面）。
   * * 方框角（`measurement-box-corner`）：在正交切面拉角 → 平面內兩軸的 min／max 跟著改。
   * 拖曳中本地改、放手推一筆 undo ＋ PATCH；沒動就只是選中。
   */
  private dragMeasurement(viewportId: string, command: InteractionCommand): void {
    const handle = command.handle;
    const binding = this.bindings.get(viewportId);
    if (!handle || !binding || binding.renderer === null) return;
    const id = handle.ownerId;
    if (command.phase === 'begin') {
      const m = this.measurements.get(id);
      if (m === undefined) return;
      const startPrimary = binding.renderer.canvasToWorld(command.position.x, command.position.y);
      this.measurementDrag = { measurementId: id, before: m, index: handle.pointIndex ?? -1, kind: handle.kind, startPrimary, startPx: command.position };
      this.selectMeasurement(id);
      return;
    }
    const drag = this.measurementDrag;
    if (drag === null || drag.measurementId !== id) return;
    if (command.phase === 'move') {
      const m = this.measurements.get(id);
      if (m === undefined) return;
      const fg = this.frameGroupFor(m.frameOfReferenceUid);
      const nowPrimary = binding.renderer.canvasToWorld(command.position.x, command.position.y);
      const own = fromPrimaryWorld(fg, nowPrimary);
      if (drag.kind === 'measurement-point' && drag.index >= 0) {
        let p = own;
        if (isPlanarKind(m.kind) && m.viewReference !== null) {
          const d = signedDistance(m.viewReference, p);
          const n = m.viewReference.viewPlaneNormal;
          p = [p[0] - n[0] * d, p[1] - n[1] * d, p[2] - n[2] * d];
        }
        const pts = Float64Array.from(m.points);
        pts.set(p, drag.index * 3);
        this.updateMeasurement(id, { points: pts }, { commit: false });
      } else if (drag.kind === 'measurement-body') {
        const startOwn = fromPrimaryWorld(fg, drag.startPrimary);
        const delta: [number, number, number] = [own[0] - startOwn[0], own[1] - startOwn[1], own[2] - startOwn[2]];
        this.updateMeasurement(id, { points: translatePoints(drag.before, delta) }, { commit: false });
      } else if (drag.kind === 'measurement-box-corner' && m.kind === 'roi3d') {
        const ownView = viewInFrame(binding.camera, fg);
        const axis = orthogonalAxisOf(ownView.viewPlaneNormal);
        if (axis === null) return;
        const startOwn = fromPrimaryWorld(fg, drag.startPrimary);
        this.updateMeasurement(id, { points: dragBoxCorner(drag.before.points, startOwn, own, axis) }, { commit: false });
      }
      return;
    }
    this.measurementDrag = null;
    if (this.vertexEdit?.measurementId === id) {
      // 面板編輯頂點中：每次拖不 commit，「完成」時合成一筆
      this.refreshMeasurements();
      return;
    }
    if (this.draftMeasurementIds.has(id)) {
      // 草稿：拖頂點不 commit（還在畫）。沒移動＝點一下：點第一或最後一個頂點 ＝ 收口（沿用「點回起點／雙擊」的習慣）
      const moved = Math.hypot(command.position.x - drag.startPx.x, command.position.y - drag.startPx.y) > CLOSE_POLYGON_PX;
      const m = this.measurements.get(id);
      const lastIndex = m === undefined ? -1 : m.points.length / 3 - 1;
      if (!moved && drag.kind === 'measurement-point' && (drag.index === 0 || drag.index === lastIndex)) {
        this.toolInstanceFor(viewportId)?.onAction?.('finish');
      }
      this.refreshMeasurements();
      return;
    }
    this.commitMeasurement(id, drag.before);
  }

  /**
   * 右鍵拖曳調 WW/WL。**每個 image layer 各自獨立。**
   *
   * 目標 ＝ `setActiveImageLayer()` 指定的那一層（可見時）；沒指定就是最底下的
   * 可見影像（以前永遠是後者，多序列時調不到 CBCT）。
   */
  private adjustWindow(command: InteractionCommand): boolean {
    const layer = this.windowTargetLayer();
    if (layer === null) return false;
    const entry = this.volumes.image(layer.contentRef);
    const current = layer.windowLevel ?? entry?.defaultWindow ?? { center: 40, width: 400 };
    const next = {
      center: current.center + command.delta.y * WINDOW_SENSITIVITY,
      width: Math.max(1, current.width + command.delta.x * WINDOW_SENSITIVITY),
    };
    layer.windowLevel = next;
    for (const [id, binding] of this.bindings) binding.renderer?.setLayers(this.layersFor(id));
    return true;
  }

  /** WW/WL 的目標影像 layer：作用中的那一層，否則最底下的可見影像。 */
  windowTargetLayer(): Layer | null {
    const imageLayers = this.layers.filter((l) => l.kind === 'image' && l.visible);
    if (imageLayers.length === 0) return null;
    const active = imageLayers.find((l) => l.layerId === this.activeImageLayerId);
    return active ?? [...imageLayers].sort((a, b) => a.order - b.order)[0]!;
  }

  // ── 工具與筆刷 ────────────────────────────────────────────────────────────

  setActiveTool(toolId: string | null): void {
    if (toolId !== this.activeToolId) {
      // 🔴 先收掉舊的 instance —— 它的 `deactivate()` 會把進行中的筆畫收筆。
      // 少了這一步，「畫到一半按下橡皮擦」那一筆永遠不會進 undo，也不會送出。
      this.releaseTool();
    }
    this.activeToolId = toolId;
    for (const id of this.bindings.keys()) {
      this.syncSvg(id);
      this.bindings.get(id)?.svg?.updateBrushCursor(null); // 換工具 → 舊游標不留
    }
    this.onStateChange();
  }

  currentTool(): string | null {
    return this.activeToolId;
  }

  // ── 觸控 ──────────────────────────────────────────────────────────────────

  setTouchWindowLevel(on: boolean): void {
    this.touchWindowLevel = on;
    this.onStateChange();
  }

  touchState(): { windowLevel: boolean; fingerDraws: boolean; penSeen: boolean } {
    return { windowLevel: this.touchWindowLevel, fingerDraws: this.fingerDraws, penSeen: this.penSeen };
  }

  setFingerDraws(on: boolean): void {
    this.fingerDraws = on;
    this.onStateChange();
  }

  /**
   * 工具列的「完成／取消」（觸控沒有 Enter／Esc／雙擊）：交給作用中的工具；
   * 工具沒有 `onAction` 就當成按了 Enter／Esc。
   */
  toolAction(action: 'finish' | 'cancel'): void {
    if (this.vertexEdit !== null) {
      this.endVertexEdit(action === 'finish');
      return;
    }
    const active = this.activeTool;
    if (active === null) return;
    if (active.instance.onAction) active.instance.onAction(action);
    else active.instance.onKeyDown?.(action === 'finish' ? 'Enter' : 'Escape');
    this.onStateChange();
  }

  /**
   * 觸控放大鏡 —— 手指會擋住正在畫的地方，畫的時候在格子上方角落顯示手指底下那一塊（2 倍、含筆刷範圍與中心點）。
   * 手指在左半邊就放右上角，反之放左上角。只有觸控畫圖時出現（滑鼠、觸控筆看得到游標，不需要）。
   */
  private updateLoupe(viewportId: string, position: Vec2 | null): void {
    const binding = this.bindings.get(viewportId);
    if (binding === undefined || binding.renderer === null || typeof document === 'undefined') return;
    const renderer = binding.renderer;
    const host = renderer.layerCanvases()[0]?.parentElement ?? null;
    let loupe = this.loupes.get(viewportId) ?? null;
    if (position === null) {
      if (loupe !== null) loupe.style.display = 'none';
      return;
    }
    if (host === null) return;
    const SIZE = 132;
    const ZOOM = 2;
    const { sx, sy } = renderer.cssToBackingScale();
    if (loupe === null || loupe.parentElement !== host) {
      loupe?.remove();
      loupe = document.createElement('canvas');
      loupe.className = 'touch-loupe';
      Object.assign(loupe.style, { position: 'absolute', top: '6px', width: `${SIZE}px`, height: `${SIZE}px`, zIndex: '6', pointerEvents: 'none', borderRadius: '10px', border: '2px solid #78afff', background: '#000', boxShadow: '0 4px 14px #000a' });
      host.appendChild(loupe);
      this.loupes.set(viewportId, loupe);
    }
    const W = Math.round(SIZE * sx);
    if (loupe.width !== W) {
      loupe.width = W;
      loupe.height = W;
    }
    const rect = host.getBoundingClientRect();
    const onLeft = position.x < rect.width / 2;
    loupe.style.left = onLeft ? '' : '6px';
    loupe.style.right = onLeft ? '6px' : '';
    loupe.style.display = 'block';
    const ctx = loupe.getContext('2d');
    if (ctx === null) return;
    const cx = position.x * sx;
    const cy = position.y * sy;
    const src = W / ZOOM;
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, W, W);
    ctx.imageSmoothingEnabled = false;
    for (const layer of renderer.layerCanvases()) ctx.drawImage(layer, cx - src / 2, cy - src / 2, src, src, 0, 0, W, W);
    // 筆刷範圍（跟 SVG 游標同一個算法）＋ 中心點
    if (this.activeToolId !== null && BRUSH_PREVIEW_TOOL_IDS.has(this.activeToolId)) {
      const circle = brushCursorPx(renderer, { x: cx, y: cy }, this.brush.radiusMm, binding.camera.viewUp);
      ctx.strokeStyle = this.activeToolId === 'eraser' ? '#ff8a80' : '#ffffff';
      ctx.lineWidth = Math.max(1, sx);
      ctx.setLineDash(this.activeToolId === 'eraser' ? [4 * sx, 3 * sx] : []);
      ctx.beginPath();
      ctx.arc(W / 2, W / 2, circle.r * ZOOM, 0, Math.PI * 2);
      ctx.stroke();
      ctx.setLineDash([]);
    }
    ctx.fillStyle = '#78afff';
    ctx.fillRect(W / 2 - sx, W / 2 - sx, 2 * sx, 2 * sx);
  }

  private touchModeFor(): TouchMode {
    if (this.touchWindowLevel) return 'window';
    const drawing = this.activeToolId !== null && this.activeToolId !== 'navigate';
    return drawing && this.fingerDraws ? 'tool' : 'scroll';
  }

  private handleTouchOp(viewportId: string, events: EventLayer, local: (p: { x: number; y: number }) => Vec2, op: TouchOp): void {
    const binding = this.bindings.get(viewportId);
    if (binding === undefined || binding.renderer === null) return;
    const none = { shift: false, ctrl: false, alt: false };
    const command = (action: InteractionCommand['action'], position: Vec2, extra: Partial<InteractionCommand>): InteractionCommand => ({
      action,
      viewportId,
      position,
      delta: { x: 0, y: 0 },
      wheelTicks: 0,
      phase: 'move',
      modifiers: none,
      ...extra,
    });
    switch (op.kind) {
      case 'begin':
        this.scene.beginInteraction();
        return;
      case 'end':
        this.scene.endInteraction(() => {
          this.render('final');
          this.scheduleHighQuality();
        });
        return;
      case 'scroll':
        this.handleCommand(viewportId, command('scroll-slice', local(op.position), { wheelTicks: op.ticks }));
        return;
      case 'window':
        this.handleCommand(viewportId, command('window-level', local(op.position), { delta: op.delta }));
        return;
      case 'pinch': {
        const center = local(op.center);
        if (op.scale !== 1) this.zoomViewport(viewportId, op.scale, center);
        if (op.pan.x !== 0 || op.pan.y !== 0) this.handleCommand(viewportId, command('pan', center, { delta: op.pan }));
        return;
      }
      case 'tool': {
        const e = { clientX: op.position.x, clientY: op.position.y, button: 0, shiftKey: false, ctrlKey: false, altKey: false };
        if (op.phase === 'down') events.pointerDown(e);
        else if (op.phase === 'move') events.pointerMove(e);
        else {
          events.pointerUp(e);
          binding.svg?.updateBrushCursor(null); // 手指放開 → 筆刷範圍不留在畫面上
        }
        this.updateLoupe(viewportId, op.phase === 'up' ? null : local(op.position));
        return;
      }
      case 'tap':
        this.handleHover(viewportId, local(op.position));
        return;
      case 'long-press': {
        const p = local(op.position);
        this.syncTo(binding.renderer.canvasToWorld(p.x, p.y));
        this.handleHover(viewportId, p);
        return;
      }
      case 'double-tap':
        // ＝ 滑鼠雙擊；圈選沒有 onAction → toolAction 退回 Enter
        if (this.activeTool !== null && this.activeTool.viewportId === viewportId) this.toolAction('finish');
        return;
    }
  }

  setBrush(patch: Partial<BrushSpec>): void {
    this.brush = { ...this.brush, ...patch };
    this.onStateChange();
  }

  currentBrush(): BrushSpec {
    return this.brush;
  }

  /**
   * 選取編輯對象。
   *
   * 🔴 **替代表示為唯讀**：選到不可編輯的 layer 會被拒絕，
   * 不得靜默寫進一個沒有在畫面上的 mask。
   */
  setActiveStructure(structureId: string | null): { ok: boolean; reason: string | null } {
    if (structureId === null) {
      this.activeStructureId = null;
      this.onStateChange();
      return { ok: true, reason: null };
    }
    const layer = this.layers.find((l) => l.kind === 'mask' && l.contentRef === structureId);
    if (layer === undefined) return { ok: false, reason: t('這個結構不在圖層清單上') };
    if (!this.scene.isEditable(layer.layerId)) {
      return { ok: false, reason: t('這個結構目前顯示的是替代表示（唯讀）') };
    }
    // 只屬某幾幀的結構、每一格鎖定的相位 —— 游標那一幀沒有它不代表沒載入（例：在鎖在第 6 幀的格子上新建的結構，
    // 游標在第 10 幀）。任何一個會畫它的幀有體素就行；筆刷依按下的那一格決定寫哪一幀
    const frames = new Set<number | null>([this.volumes.frameOf(layer)]);
    if (layer.temporalGroupId) {
      for (const locks of this.frameLocks.allLockedFrames()) {
        const f = locks.get(layer.temporalGroupId);
        if (f !== undefined) frames.add(f);
      }
      for (const f of layer.frames ?? []) frames.add(f);
    }
    if (![...frames].some((f) => this.volumes.mask(structureId, f) !== undefined)) {
      return { ok: false, reason: t('這個結構的體素還沒載入（先讓它顯示）') };
    }
    this.activeStructureId = structureId;
    this.onStateChange();
    return { ok: true, reason: null };
  }

  currentStructure(): string | null {
    return this.activeStructureId;
  }

  /** 唯讀的結構 → 原因：已簽核（後端擋 409 APPROVED_LOCKED）、匯入集／別人的工作集（後端擋 403）。 */
  private lockedStructures: ReadonlyMap<string, string> = new Map();

  setLockedStructures(locks: readonly (string | { structureId: string; reason: string })[]): void {
    this.lockedStructures = new Map(
      locks.map((l) => (typeof l === 'string' ? [l, t('結構已簽核（approved），唯讀；審核者可在「簽核」面板重新開啟')] : [l.structureId, l.reason])),
    );
  }

  /** 編輯工具需要一個可寫的目標；UI 據此停用按鈕與顯示原因。 */
  editingBlockedReason(): string | null {
    if (this.activeStructureId === null) return t('先在左側點選一個結構');
    const locked = this.lockedStructures.get(this.activeStructureId);
    if (locked !== undefined) return locked;
    const layer = this.layers.find(
      (l) => l.kind === 'mask' && l.contentRef === this.activeStructureId,
    );
    if (layer === undefined) return t('選取的結構不在圖層清單上');
    if (!layer.visible) return t('選取的結構目前隱藏');
    if (!this.scene.isEditable(layer.layerId)) return t('替代表示為唯讀');
    return null;
  }

  /**
   * 左鍵拖曳 → **交給註冊表裡的工具**。
   *
   * 🔴 舊版是一個寫死的 `switch`：`new Set(['brush','eraser','threshold-brush'])`
   * ＋ 內聯的筆刷光柵化。註冊的九個工具 `activate()` 沒有人呼叫，因此工具
   * 的外掛接縫存在、型別是最終形狀、但**沒有承重** —— 加一個新工具要改這裡，
   * 不是註冊一個 plugin。
   *
   * 現在這個函式只做三件事：確保有 instance、轉發指標事件、回報是否要重繪。
   * **它不認識「筆刷」這兩個字。**
   */
  private handleToolCommand(viewportId: string, command: InteractionCommand): boolean {
    if (command.action !== 'active-tool') return false;
    if (this.vertexEdit !== null) return false; // 編輯頂點期間點空白處不開新多邊形、不下筆
    const instance = this.toolInstanceFor(viewportId);
    if (instance === null) return false;
    const { x, y } = command.position;
    switch (command.phase) {
      case 'begin':
        instance.onPointerDown?.(x, y, command.modifiers);
        return true;
      case 'move':
        instance.onPointerMove?.(x, y, command.modifiers);
        return true;
      case 'end':
        instance.onPointerUp?.(x, y, command.modifiers);
        // 收筆本身不改變畫面（本地早就畫上去了），但狀態列的 undo 深度要更新
        this.onStateChange();
        return false;
      default:
        return false;
    }
  }

  /**
   * 目前作用中的工具實例；沒有可用的就回 null。
   *
   * **懶建立**：`activate()` 會拒絕不可編輯的目標（唯讀的替代表示），
   * 因此不能在「選了工具」的當下就建 —— 那時使用者可能還沒選結構。
   */
  private toolInstanceFor(viewportId: string): ToolInstance | null {
    const toolId = this.activeToolId;
    if (toolId === null) return null;
    const binding = this.bindings.get(viewportId);
    if (!binding || binding.renderer === null) return null;
    if (this.activeTool !== null) {
      if (this.activeTool.toolId === toolId && this.activeTool.viewportId === viewportId) {
        return this.activeTool.instance;
      }
      this.releaseTool();
    }
    let plugin;
    try {
      plugin = getTool(toolId);
    } catch {
      return null;
    }
    if (!(plugin.appliesTo?.(binding.info) ?? true)) return null;
    try {
      const instance = plugin.activate(this.toolContext(viewportId));
      this.activeTool = { toolId, viewportId, instance };
      return instance;
    } catch {
      // `activate()` 拒絕（沒選結構、或目標是唯讀替代表示）。UI 已經由
      // `editingBlockedReason()` 說明原因，這裡不重複吵。
      return null;
    }
  }

  /** 收掉目前的工具實例（換工具、換 viewport、關閉前）。 */
  private releaseTool(): void {
    const active = this.activeTool;
    this.activeTool = null;
    // 🔴 `deactivate()` 會把進行中的筆畫收掉。少了這一步，切換工具時
    // 最後一筆永遠不會進 undo、也不會送到後端 —— 而畫面上它已經在了。
    active?.instance.deactivate();
  }

  /**
   * 建 `ToolContext` —— 工具需要的四樣東西全部在這裡兌現。
   *
   * | 要求 | 兌現 |
   * |---|---|
   * | 座標轉換鏈 | `canvasToWorld` / `worldToCanvas` / `maskGrid` / `frameGroup` |
   * | undo stack | `undo` / `applyPatch` / `endStroke` |
   * | 圖層讀寫 | `layers` / `layer` / `setVisible` / `isEditable` |
   * | 目前 `ViewReference`（含相位） | `camera` |
   *
   * 🔴 **裡面沒有任何 vtk／Cornerstone 型別。** 模組一旦拿到 `vtkActor`，
   * 它在 Tier C 就會壞掉，而且是靜默壞掉。
   */
  private toolContext(viewportId: string): ToolContext {
    const binding = this.bindings.get(viewportId)!;
    const renderer = binding.renderer!;
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const host = this;
    return {
      viewport: binding.info,
      camera: binding.camera,
      canvasToWorld: (x, y) => renderer.canvasToWorld(x, y),
      worldToCanvas: (world) => renderer.worldToCanvas(world),
      maskGrid: this.gridSet.maskGrid,
      maskGridFor: (uid) => {
        try {
          return maskGridOf(this.gridSet, uid);
        } catch {
          return this.gridSet.maskGrid;
        }
      },
      frameGroup: (uid) => this.frameGroupFor(uid),
      setFrameGroupTransform: (uid, m) => this.setFrameGroupTransform(uid, m),
      undo: this.undo,
      applyPatch: (args) => this.applyToolPatch(viewportId, args),
      endStroke: () => this.finishStroke(),
      // getter：工具每次讀到的都是最新的參數（筆刷半徑、對位目標…），不必重新啟動
      get params(): Record<string, unknown> {
        return { brush: host.brush, ...host.toolParams };
      },
      sampleImageHu: (ijk) => this.sampleImageHu(ijk),
      layers: () => this.layers,
      layer: (layerId) => this.layers.find((l) => l.layerId === layerId) ?? null,
      setVisible: (layerId, visible) => this.setVisible(layerId, visible),
      isEditable: (structureId) => {
        const layer = this.layers.find((l) => l.kind === 'mask' && l.contentRef === structureId);
        return layer !== undefined && this.scene.isEditable(layer.layerId);
      },
      activeStructureId: () => this.activeStructureId,
      // 這一格鎖定了相位 → 筆刷、新結構寫進那一幀
      frameOf: (layer) => this.volumes.frameOf(layer, this.frameOverrideFor(viewportId)),
      notify: (message) => this.onNotice({ kind: 'tool', message }),
      // 量測
      activeImageLayer: () => this.windowTargetLayer(),
      measurements: () => this.currentMeasurements(),
      addMeasurement: (m, opts) => this.addMeasurement(m, opts),
      updateMeasurement: (id, patch, opts) => this.updateMeasurement(id, patch, opts),
      removeMeasurement: (id, opts) => this.removeMeasurement(id, opts),
      commitMeasurement: (id, before) => this.commitMeasurement(id, before),
      selectMeasurement: (id) => this.selectMeasurement(id),
      cssToBackingScale: () => renderer.cssToBackingScale(),
      setCrosshair: (world) => this.syncTo(world),
      setLassoPreview: (poly) => {
        if (poly === null || poly.length === 0) this.lassoPreview.delete(viewportId);
        else this.lassoPreview.set(viewportId, poly);
        this.syncSvg(viewportId);
      },
      highlightVertex: (measurementId, index) => this.highlightVertex(measurementId, index),
    };
  }

  /**
   * 影像 HU 取樣（閾值筆刷）。mask grid 與取像網格描述同一塊空間（I5）——
   * 因此取的是**作用中結構同一個 FoR** 的影像（CBCT 的結構取 CBCT 的 HU）。
   */
  private sampleImageHu(ijk: readonly [number, number, number]): number {
    const entry = this.imageEntryForHu();
    if (entry === undefined) return Number.NEGATIVE_INFINITY;
    const size = entry.grid.size;
    const [i, j, k] = ijk;
    if (i < 0 || j < 0 || k < 0 || i >= size[0] || j >= size[1] || k >= size[2]) {
      return Number.NEGATIVE_INFINITY;
    }
    return entry.voxels[(k * size[1] + j) * size[0] + i] ?? Number.NEGATIVE_INFINITY;
  }

  /**
   * 工具寫進一筆 patch：**本地立即生效並累積進當前筆畫**，不推 undo、不送後端。
   *
   * 提交是 `endStroke()`（＝ `finishStroke()`）的事 —— 一次拖曳有幾十個筆點，
   * 但整筆只算一個 undo 區塊、只送一次。
   */
  private applyToolPatch(
    viewportId: string,
    args: { structureId: string; frameIndex: number | null; patch: VoxelPatch },
  ): boolean {
    const binding = this.bindings.get(viewportId);
    if (!binding) return false;
    const { structureId, frameIndex, patch } = args;
    const applied = this.volumes.applyMaskPatch({
      structureId,
      frameIndex,
      offsetIjk: patch.offsetIjk,
      sizeIjk: patch.sizeIjk,
      data: patch.data,
      // 🔴 只寫球內：否則每個筆點會擦掉自己外接方塊的角落
      coverage: patch.coverage,
      maskGrid: this.maskGridForStructure(structureId).grid,
    });
    if (applied === null) return false;
    // 舊修訂號的上傳可以立刻丟掉，不必等 LRU
    this.dropVolume(applied.previousKey);

    const dab = {
      bounds: { offsetIjk: patch.offsetIjk, sizeIjk: patch.sizeIjk },
      before: applied.before,
      after: applied.after,
    };
    if (
      this.stroke !== null &&
      this.stroke.structureId === structureId &&
      this.stroke.frameIndex === frameIndex
    ) {
      this.stroke.acc.add({
        ...dab,
        // bbox 長大時新露出的格子用**當前內容**填，不能填 0（見 `add()` 的註解）
        readLive: (bounds) =>
          this.volumes.readMaskBlock({
            structureId,
            frameIndex,
            offsetIjk: bounds.offsetIjk,
            sizeIjk: bounds.sizeIjk,
          }),
      });
    } else {
      // 換結構／換 frame 時先把前一筆結掉，不要把兩筆黏成一個 undo 區塊
      this.finishStroke();
      this.stroke = {
        structureId,
        frameIndex,
        acc: new StrokeAccumulator(dab),
        label: this.activeToolId ?? 'edit',
      };
    }
    this.strokeView = binding.camera;
    return true;
  }

  /**
   * 放開滑鼠：整筆記一個 undo 區塊，並送進佇列。
   *
   * 送出的是 **bbox**，資料由佇列在真正發請求前從本地 mask 讀出——理由見
   * `unionPatchBounds`：patch 語意是整塊取代，先合併資料會在筆點之間的空隙
   * 寫 0。
   */
  private finishStroke(): void {
    const stroke = this.stroke;
    this.stroke = null;
    if (stroke === null) return;
    const view =
      this.strokeView ?? [...this.bindings.values()].find((b) => b.renderer !== null)?.camera;
    if (view === undefined) return;
    if (stroke.acc.isNoop()) {
      // 在已經是 1 的地方又畫一次：不佔 undo 格、也不必送
      this.onStateChange();
      return;
    }
    // 這裡**不要**加 `this.render('final')`。mask 是 3D 的，一筆確實會改變另外
    // 兩個 MPR 視圖，但互動停止後的 settle 已經負責這件事：pointerup 觸發
    // `scene.endInteraction()`，它在 SETTLE_MS 後 `renderAll()` 並補 final 品質。
    // 在這裡再補一次 = 每一筆多跑一次三格重切。
    const { bounds, before, after } = stroke.acc.result();
    this.undo.push({
      structureId: stroke.structureId,
      frameIndex: stroke.frameIndex,
      offsetIjk: bounds.offsetIjk,
      sizeIjk: bounds.sizeIjk,
      before,
      after,
      viewReference: view,
      label: stroke.label,
    });
    this.submitQueue.enqueue({
      structureId: stroke.structureId,
      frameIndex: stroke.frameIndex,
      bounds,
      viewReference: view,
    });
    this.onStateChange();
  }

  /**
   * 後端運算（後處理、閾值分割、區域生長）的結果套回本地：
   * 以新舊 bbox 聯集為一筆 **可 undo 的 EditOp**（before／after），不再送出 —— 後端已是新內容，
   * `baseContentHash` 直接推進到回傳的 hash。
   */
  replaceMask(args: {
    structureId: string;
    frameIndex: number | null;
    offsetIjk: readonly [number, number, number];
    sizeIjk: readonly [number, number, number];
    voxels: Uint8Array;
    contentHash: string;
    label?: string;
  }): boolean {
    const existing = this.volumes.mask(args.structureId, args.frameIndex);
    const maskGrid = this.maskGridForStructure(args.structureId);
    if (existing === undefined) {
      // 本地還沒有這份 mask（沒打開過）：直接收進倉，沒有 before 可 undo
      this.putMask({ ...args });
      return true;
    }
    // 聯集 bbox：新值填進去，其餘 0（整塊取代語意，coverage 全 1）
    const lo = [0, 1, 2].map((a) => Math.min(existing.offsetIjk[a]!, args.offsetIjk[a]!)) as [number, number, number];
    const hi = [0, 1, 2].map((a) => Math.max(existing.offsetIjk[a]! + existing.sizeIjk[a]!, args.offsetIjk[a]! + args.sizeIjk[a]!)) as [number, number, number];
    const size = [hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]] as [number, number, number];
    const data = new Uint8Array(size[0] * size[1] * size[2]);
    const [ox, oy, oz] = args.offsetIjk;
    const [sx, sy, sz] = args.sizeIjk;
    for (let k = 0; k < sz; k += 1) {
      for (let j = 0; j < sy; j += 1) {
        const src = k * sy * sx + j * sx;
        const dst = (k + oz - lo[2]) * size[1] * size[0] + (j + oy - lo[1]) * size[0] + (ox - lo[0]);
        data.set(args.voxels.subarray(src, src + sx), dst);
      }
    }
    const applied = this.volumes.applyMaskPatch({
      structureId: args.structureId,
      frameIndex: args.frameIndex,
      offsetIjk: lo,
      sizeIjk: size,
      data,
      coverage: new Uint8Array(data.length).fill(1),
      maskGrid: maskGrid.grid,
    });
    if (applied === null) return false;
    this.dropVolume(applied.previousKey);
    const view = [...this.bindings.values()].find((b) => b.renderer !== null)?.camera;
    if (view !== undefined) {
      this.undo.push({
        structureId: args.structureId,
        frameIndex: args.frameIndex,
        offsetIjk: lo,
        sizeIjk: size,
        before: applied.before,
        after: applied.after,
        viewReference: view,
        ...(args.label !== undefined ? { label: args.label } : {}),
      });
    }
    this.submitQueue.register({ structureId: args.structureId, frameIndex: args.frameIndex, maskGridId: maskGrid.maskGridId, contentHash: args.contentHash });
    this.render('final');
    this.onStateChange();
    return true;
  }

  /** 讀數所在的體素（區域生長的種子）：`(ijk, frameOfReferenceUid)`；沒有讀數回 null。 */
  probeVoxel(): { ijk: [number, number, number]; seriesId: string } | null {
    const p = this.probeReadout;
    // 滑鼠在畫面上就用讀數；不在（例如去按面板的按鈕）就退回十字線交點 —— 種子按鈕靠這個
    const readings =
      p !== null
        ? p.readings
        : probeImageLayers({
            world: this.crosshairWorld(),
            layers: this.layers,
            displayGrid: this.gridSet.displayGrid,
            imageFor: (seriesId) => this.volumes.image(seriesId),
            frameGroupFor: (uid) => this.frameGroupFor(uid),
          });
    const r = readings.find((x) => x.acquisitionIjk !== null);
    return r && r.acquisitionIjk ? { ijk: [...r.acquisitionIjk] as [number, number, number], seriesId: r.seriesId } : null;
  }

  /**
   * 十字線交點：三個平面的交點。從第一個平面的中心出發，沿其他平面的法向量投影到那個平面上
   * （正交平面時就是交點；只有一個視埠時就是它的平面中心）。
   */
  /** primary 世界座標 → 某 FoR 自己的座標（用**目前**的對位，含未提交的微調）。 */
  worldToFrame(frameOfReferenceUid: string, worldPrimary: Vec3): [number, number, number] {
    return fromPrimaryWorld(this.frameGroupFor(frameOfReferenceUid), worldPrimary);
  }

  /**
   * 記錄一個地標對（`kind: 'landmark'` 的量測；進 undo、存後端）。`moving` 是次要序列自己的座標、
   * `fixed` 是 primary 世界座標；Provenance 的平面取目前（第一個）影像格的相機。回傳量測 id。
   */
  addLandmarkPair(args: { movingFrameOfReferenceUid: string; moving: Vec3; fixed: Vec3; label: string }): string {
    const primaryUid = this.gridSet.frameGroups.find((f) => f.role === 'primary')?.frameOfReferenceUid ?? this.gridSet.displayGrid.grid.frameOfReferenceUid;
    const camera = [...this.bindings.values()].find((b) => b.renderer !== null)?.camera ?? createViewReference({
      frameOfReferenceUid: primaryUid,
      displayGridId: this.gridSet.displayGrid.displayGridId,
      planeOrigin: [...args.fixed],
      viewPlaneNormal: [0, 0, 1],
      viewUp: [0, -1, 0],
      slabThicknessMm: 0,
      temporalGroupId: null,
      frameIndex: null,
    });
    const m: Measurement = {
      ...createMeasurement({ kind: 'landmark', frameOfReferenceUid: args.movingFrameOfReferenceUid, points: [...args.moving, ...args.fixed], viewReference: null, editedOn: camera, label: args.label }),
      pairFrameOfReferenceUid: primaryUid,
    };
    this.addMeasurement(m);
    return m.measurementId;
  }

  /** 十字線移到某一點（primary 世界座標；對位面板點地標列時用）。 */
  moveCrosshair(worldPrimary: Vec3): void {
    this.syncTo(worldPrimary);
  }

  crosshairWorld(): [number, number, number] {
    const cams = [...this.bindings.values()].filter((b) => b.renderer !== null).map((b) => b.camera);
    const first = cams[0];
    if (first === undefined) return [0, 0, 0];
    const pt: [number, number, number] = [first.planeOrigin[0], first.planeOrigin[1], first.planeOrigin[2]];
    for (const cam of cams.slice(1)) {
      const n = cam.viewPlaneNormal;
      const d = (cam.planeOrigin[0] - pt[0]) * n[0] + (cam.planeOrigin[1] - pt[1]) * n[1] + (cam.planeOrigin[2] - pt[2]) * n[2];
      pt[0] += n[0] * d;
      pt[1] += n[1] * d;
      pt[2] += n[2] * d;
    }
    return pt;
  }

  /** undo/redo 的套用：把子區塊寫回去、重繪、並同步到後端。 */
  private applyEditOp(op: EditOp, direction: 'undo' | 'redo'): void {
    const data = direction === 'undo' ? op.before : op.after;
    const result = this.volumes.applyMaskPatch({
      structureId: op.structureId,
      frameIndex: op.frameIndex,
      offsetIjk: op.offsetIjk,
      sizeIjk: op.sizeIjk,
      data,
      maskGrid: this.maskGridForStructure(op.structureId).grid,
    });
    if (result !== null) this.dropVolume(result.previousKey);
    this.render('final');
    // undo/redo 也要同步到後端 —— 否則重新載入會看到被 undo 掉的內容
    this.submitQueue.enqueue({
      structureId: op.structureId,
      frameIndex: op.frameIndex,
      bounds: { offsetIjk: op.offsetIjk, sizeIjk: op.sizeIjk },
      viewReference: op.viewReference,
    });
    this.onStateChange();
  }

  // ── 十字線讀數 ────────────────────────────────────────────────────────────

  /** 目前的讀數。`null` = 指標還沒進過任何 2D viewport。 */
  probe(): ProbeReadout | null {
    return this.probeReadout;
  }

  /**
   * 指標移動 → 讀數。
   *
   * 🔴 **每個 rAF 最多算一次**（效能規則）。`pointermove` 在 120 Hz
   * 的裝置上可以一秒送出上百個事件，而每一次都會讓 React 重繪整個狀態列。
   */
  /** 筆刷／橡皮擦游標（backing px）。`position` 是容器 CSS px；離開或非筆刷類工具 → 隱藏。 */
  private updateBrushCursor(viewportId: string, position: Vec2 | null): void {
    const b = this.bindings.get(viewportId);
    if (b === undefined || b.svg === null) return;
    if (position === null || this.activeToolId === null || !BRUSH_PREVIEW_TOOL_IDS.has(this.activeToolId) || b.renderer === null) {
      b.svg.updateBrushCursor(null);
      return;
    }
    const { sx, sy } = b.renderer.cssToBackingScale();
    const circle = brushCursorPx(b.renderer, { x: position.x * sx, y: position.y * sy }, this.brush.radiusMm, b.camera.viewUp);
    b.svg.updateBrushCursor({ ...circle, erase: this.activeToolId === 'eraser' });
  }

  private handleHover(viewportId: string, position: Vec2 | null, modifiers?: Modifiers): void {
    // Shift ＋ 滑動（不按鍵）→ 其他格跟著滑鼠座標對切面（Slicer 的 shift-hover）。
    // 拖曳中不做（那是各工具自己的事，例如十字線工具的 Shift＋左鍵拖曳）。
    if (position !== null && modifiers?.shift === true) {
      const b = this.bindings.get(viewportId);
      if (b !== undefined && b.renderer !== null && b.events !== null && !b.events.isActive()) {
        this.shiftHoverTo(viewportId, b.renderer.canvasToWorld(position.x, position.y));
      }
    }
    // 筆刷／橡皮擦範圍預覽：不需要 instance（第一次按下才會有），host 直接依 activeToolId 與筆刷設定畫
    this.updateBrushCursor(viewportId, position);
    // 工具的即時回饋（面積工具的橡皮筋）：只給已存在的 instance，不在 hover 時憑空建一個
    if (this.activeTool !== null && this.activeTool.viewportId === viewportId && this.vertexEdit === null) {
      const b = this.bindings.get(viewportId);
      if (position === null || (b?.events !== null && b?.events !== undefined && !b.events.isActive())) this.activeTool.instance.onHover?.(position);
    }
    if (position === null) {
      // 指標離開：**保留最後一次讀數並標成凍結，不清空**。
      // 清空會讓使用者以為功能壞了。
      if (this.probeReadout === null || this.probeReadout.source === 'frozen') return;
      this.probeReadout = { ...this.probeReadout, source: 'frozen' };
      this.onStateChange();
      return;
    }
    this.pendingHover = { viewportId, position };
    if (this.probeScheduled) return;
    this.probeScheduled = true;
    const run = (): void => {
      this.probeScheduled = false;
      const pending = this.pendingHover;
      this.pendingHover = null;
      if (pending !== null) this.updateProbe(pending.viewportId, pending.position);
    };
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(run);
    else run();
  }

  private updateProbe(viewportId: string, position: Vec2): void {
    const binding = this.bindings.get(viewportId);
    if (binding === undefined || binding.renderer === null) return;
    const world = binding.renderer.canvasToWorld(position.x, position.y);
    this.probeReadout = {
      world,
      viewportId,
      source: 'pointer',
      readings: probeImageLayers({
        world,
        layers: this.layers,
        displayGrid: this.gridSet.displayGrid,
        // lod 0 沒到就用較粗的那份 —— `probeImageLayers` 會據此標 `≈`（R1c）
        imageFor: (seriesId) => this.volumes.image(seriesId),
        // 攤開的那一張、這一格鎖定的相位 → 讀那一幀的值
        imageForLayer: (layer) => this.volumes.image(layer.contentRef, 0, this.volumes.frameOf(layer, this.frameOverrideFor(viewportId)) ?? undefined),
        frameGroupFor: (uid) => this.frameGroupFor(uid),
      }),
      // 這一點在哪些顯示中的結構裡 —— 用指標所在這一格的圖層（該格額外隱藏的結構畫面上沒有，也不列）
      structures: probeStructures({
        world,
        layers: this.layersFor(viewportId),
        maskFor: (layer) => this.volumes.mask(layer.contentRef, this.volumes.frameOf(layer, this.frameOverrideFor(viewportId))),
        frameGroupFor: (uid) => this.frameGroupFor(uid),
      }),
    };
    this.onStateChange();
  }

  /**
   * FrameGroup 查表 —— 渲染、讀數、筆刷**都**經這裡（整組連動靠它）。
   * 使用者關掉對位的 FoR 回單位矩陣版本。
   */
  frameGroupFor(frameOfReferenceUid: string): FrameGroup {
    const found =
      this.gridSet.frameGroups.find((f) => f.frameOfReferenceUid === frameOfReferenceUid) ??
      primaryFrameGroupOf(frameOfReferenceUid, 'unknown');
    if (found.role === 'secondary' && this.disabledTransforms.has(frameOfReferenceUid)) {
      return {
        ...found,
        transformToPrimary: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
        transformKind: 'identity',
      };
    }
    const override = this.transformOverrides.get(frameOfReferenceUid);
    if (override !== undefined && found.role === 'secondary') {
      return {
        ...found,
        transformToPrimary: override,
        transformKind: 'rigid',
        registration: {
          source: 'manual',
          sopInstanceUid: found.registration?.sopInstanceUid ?? null,
          matrixType: 'RIGID',
          description: t('微調中（尚未提交）'),
        },
      };
    }
    return found;
  }

  currentGridSet(): GridSet {
    return this.gridSet;
  }

  private imageEntryForHu(): ReturnType<VolumeStore['image']> {
    const structureFor = this.layers.find(
      (l) => l.kind === 'mask' && l.contentRef === this.activeStructureId,
    )?.frameOfReferenceUid;
    const images = this.layers.filter((l) => l.kind === 'image' && l.visible);
    const sameFrame = structureFor ? images.find((l) => l.frameOfReferenceUid === structureFor) : undefined;
    const imageLayer = sameFrame ?? images[0];
    return imageLayer ? this.volumes.image(imageLayer.contentRef) : undefined;
  }

  /**
   * 以游標（或畫面中心）為樞紐縮放一個 viewport。
   *
   * UI 的 `＋` / `－` 按鈕與滾輪走同一條路徑，因此手感一致。
   */
  zoomViewport(
    viewportId: string,
    factor: number,
    cursorPx?: { x: number; y: number },
  ): void {
    const binding = this.bindings.get(viewportId);
    if (!binding || binding.renderer === null) return;
    const canvas = { width: binding.info.width, height: binding.info.height };
    const result = zoomCameraAtCursor({
      camera: binding.camera,
      pxMm: binding.renderer.currentPxMm(),
      canvas,
      cursorPx: cursorPx ?? { x: (canvas.width - 1) / 2, y: (canvas.height - 1) / 2 },
      factor,
    });
    binding.camera = result.camera;
    binding.renderer.setPxMm(result.pxMm);
    binding.renderer.setCamera(result.camera);
    binding.renderer.render(this.scene.currentQuality());
    this.mirrorCamera(viewportId);
    this.onStateChange();
  }

  /** Fit：整個網格回到視野內；切面（切片、斜切、slab、相位）不動。 */
  fitViewport(viewportId: string): void {
    const binding = this.bindings.get(viewportId);
    if (!binding || binding.renderer === null) return;
    binding.camera = fitCamera(this.gridSet.displayGrid.grid, binding.camera);
    binding.renderer.resetZoom();
    binding.renderer.setCamera(binding.camera);
    binding.renderer.render('final');
    this.mirrorCamera(viewportId);
    this.onStateChange();
  }

  /** 1:1 —— 一個螢幕像素對一個體素。 */
  actualSizeViewport(viewportId: string): void {
    const binding = this.bindings.get(viewportId);
    if (!binding || binding.renderer === null) return;
    const grid = this.gridSet.displayGrid.grid;
    // 平面內最細的體素間距 —— 這才是「一個像素一個體素」的意思
    binding.renderer.setPxMm(Math.min(grid.spacing[0], grid.spacing[1], grid.spacing[2]));
    binding.renderer.setCamera(binding.camera);
    binding.renderer.render('final');
    this.mirrorCamera(viewportId);
    this.onStateChange();
  }

  /** 目前的縮放倍率（相對 fit）—— 狀態列顯示用。 */
  zoomFactor(viewportId: string): number {
    const binding = this.bindings.get(viewportId);
    if (!binding || binding.renderer === null) return 1;
    const fit = fitPxMm(this.gridSet.displayGrid.grid, binding.camera, {
      w: binding.info.width,
      h: binding.info.height,
    });
    return fit / binding.renderer.currentPxMm();
  }

  /** 讓所有 viewport 的十字線指到同一個世界座標（相機同步）。 */
  private shiftHoverPending: { viewportId: string; world: [number, number, number] } | null = null;
  private shiftHoverScheduled = false;

  /** Shift＋滑動：每個 rAF 最多對一次切面（120 Hz 的 pointermove 每次都重切三格會卡）；本格不動，只動其他格。 */
  private shiftHoverTo(sourceViewportId: string, world: [number, number, number]): void {
    this.shiftHoverPending = { viewportId: sourceViewportId, world };
    if (this.shiftHoverScheduled) return;
    this.shiftHoverScheduled = true;
    const run = (): void => {
      this.shiftHoverScheduled = false;
      const pending = this.shiftHoverPending;
      this.shiftHoverPending = null;
      if (pending === null) return;
      for (const [id, binding] of this.bindings) {
        if (id === pending.viewportId || binding.renderer === null) continue;
        binding.camera = { ...binding.camera, planeOrigin: [pending.world[0], pending.world[1], pending.world[2]] };
        binding.renderer.setCamera(binding.camera);
      }
      this.render('interactive');
      this.onStateChange();
    };
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(run);
    else run();
  }

  syncTo(world: readonly [number, number, number]): void {
    for (const binding of this.bindings.values()) {
      binding.camera = { ...binding.camera, planeOrigin: [world[0], world[1], world[2]] };
      binding.renderer?.setCamera(binding.camera);
    }
    this.render('final');
    this.onStateChange();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.playbackTimer !== null) clearInterval(this.playbackTimer);
    this.playbackTimer = null;
    this.offLang();
    this.releaseTool();
    for (const id of [...this.bindings.keys()]) this.detachViewport(id);
    this.scene.dispose();
    this.volumes.clear();
    this.resliceCache.clear();
    this.renderScheduled = false;
    this.kernel.dispose();
  }

  isDisposed(): boolean {
    return this.disposed;
  }
}
