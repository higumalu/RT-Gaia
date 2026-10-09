/**
 * `useScene` —— 🔴 **回傳指令函式，絕不回傳 vtk 物件或 canvas**。
 *
 * > **React 負責「這塊畫面在哪」，core 負責「這塊畫面上有什麼」。**
 *
 * `ViewerHost` 以 `useRef` 單例持有；`useEffect` cleanup 必須呼叫 `dispose()`。
 * **開發階段一律開著 StrictMode**——因此 `dispose()` 是冪等的，重複 mount 會
 * 正確重建。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import {
  budgetFor,
  DEFAULT_BRUSH,
  registerCoreBuiltins,
  type ProbeReadout,
  ViewerHost,
  type TemporalState,
  type BlendMode,
  type BrushSpec,
  type ConflictInfo,
  type QueueFailure,
  type FrameStats,
  type SubmitRequest,
  type SubmitResult,
  type GridSet,
  type Layer,
  type OrthoOrientation,
  type SceneNotice,
  type SlabOutlineSemantics,
  type Tier,
  type TransportLike,
  type ViewportInfo,
  type ViewportView,
  IDENTITY_MAT16,
  type FrameGroup,
  type Mat16,
  type Measurement,
  type MeasurementKind,
  type MaskRenderStyle,
  type Vec3,
  type EditableBox,
  type ViewReference,
} from '../../core';
import { ViewportOverlayRegistry } from '../../core';
import { toolRequiresMode } from '../../core/tools/registry';
import { t } from '../../core/i18n';

export interface SceneCommands {
  /** 由 `ViewportHost` 呼叫：**交出容器**，core 在裡面建 canvas 與事件監聽。 */
  attachViewport: (
    info: ViewportInfo,
    container: HTMLElement,
    orientation: OrthoOrientation,
  ) => void;
  detachViewport: (viewportId: string) => void;
  setLayers: (layers: readonly Layer[]) => void;
  setVisible: (layerId: string, visible: boolean) => void;
  setGroupVisible: (groupId: string, visible: boolean) => void;
  setOpacity: (layerId: string, opacity: number) => void;
  setRenderStyle: (layerId: string, style: MaskRenderStyle) => boolean;
  putImage: (args: {
    seriesId: string;
    lod: number;
    frameIndex?: number | null;
    grid: Parameters<ViewerHost['putImage']>[0]['grid'];
    voxels: Int16Array | Float32Array;
    defaultWindow: { center: number; width: number };
  }) => void;
  /** 這個序列的某個 lod 是否已常駐（多序列的按需補抓用）。 */
  hasImage: (seriesId: string, lod: number, frameIndex?: number | null) => boolean;
  /** 這個序列有沒有任何一幀的 lod 0 在倉裡。 */
  hasFullResAnyFrame: (seriesId: string) => boolean;
  /** 放這個序列的 lod 0 進來不會逐出別的可見序列（逐出過的只在這時補回來）。 */
  canHoldFullRes: (seriesId: string) => boolean;
  /** 卸載體素；回傳釋放的 bytes。 */
  dropImageLod: (seriesId: string, lod: number, frameIndex?: number | null) => number;
  dropMaskVoxels: (structureId: string, frameIndex: number | null) => number;
  putMask: (args: Parameters<ViewerHost['putMask']>[0]) => void;
  /** 抓回來的 mask：這個結構還有沒送完的編輯就不蓋（`ViewerHost.putFetchedMask`）；回傳有沒有放進去。 */
  putFetchedMask: (args: Parameters<ViewerHost['putMask']>[0]) => boolean;
  /** 推送來的 `mask.updated` 要不要現在重抓（`ViewerHost.remoteMaskUpdate`）；還沒有 host → 重抓。 */
  remoteMaskUpdate: (structureId: string, frameIndex: number | null, contentHash: string) => boolean;
  render: () => void;
  /** 只重畫面板 overlay 層（便宜；hover 同步游標用）。 */
  repaintOverlays: () => void;
  /** 模組交給核心的可調方框（2D 正交切面可拖角／邊）；`null` 移除。 */
  setEditableBox: (ownerId: string, box: EditableBox | null, onChange?: (box: EditableBox, phase: 'move' | 'end') => void) => void;
  // ── 每組影像各自的顯示參數 ─────────────────────────────────────────────
  setWindowLevel: (layerId: string, windowLevel: { center: number; width: number }) => void;
  setColormap: (layerId: string, colormap: string) => void;
  setBlendMode: (layerId: string, blendMode: BlendMode) => void;
  setLayerParams: (layerId: string, patch: Record<string, unknown>) => void;
  setActiveImageLayer: (layerId: string | null) => void;
  setTransformEnabled: (frameOfReferenceUid: string, enabled: boolean) => void;
  setFrameGroupTransform: (frameOfReferenceUid: string, transformToPrimary: Mat16 | null) => void;
  transformOverrideFor: (frameOfReferenceUid: string) => Mat16 | null;
  currentTransformToPrimary: (frameOfReferenceUid: string) => Mat16;
  setFrameGroups: (frameGroups: readonly FrameGroup[]) => void;
  /** 已簽核（approved）的結構唯讀。 */
  setLockedStructures: (locks: readonly (string | { structureId: string; reason: string })[]) => void;
  currentFrameGroups: () => FrameGroup[];
  setToolParams: (patch: Record<string, unknown>) => void;
  seriesGridCenter: (seriesId: string) => Vec3 | null;
  seriesGridBounds: (seriesId: string) => { min: Vec3; max: Vec3 } | null;
  seriesHistogram: (seriesId: string, bins?: number, range?: [number, number]) => { counts: number[]; min: number; max: number } | null;
  setViewportHiddenLayers: (viewportId: string, layerIds: readonly string[]) => void;
  setCameraLinks: (groups: Readonly<Record<string, readonly string[]>>) => void;
  selectMeasurement: (measurementId: string | null) => void;
  updateMeasurement: (measurementId: string, patch: { points?: readonly number[]; label?: string }, opts?: { commit?: boolean }) => void;
  removeMeasurement: (measurementId: string) => void;
  addMeasurement: (m: Measurement) => void;
  addLandmarkPair: (args: { movingFrameOfReferenceUid: string; moving: Vec3; fixed: Vec3; label: string }) => string | null;
  worldToFrame: (frameOfReferenceUid: string, worldPrimary: Vec3) => Vec3 | null;
  moveCrosshair: (worldPrimary: Vec3) => void;
  beginVertexEdit: (measurementId: string) => void;
  setMeasurementLabelHint: (hint: { kind: MeasurementKind; label: string } | null) => void;
  setTemporalFrame: (groupId: string, frameIndex: number) => void;
  setViewportFrame: (viewportId: string, groupId: string, frame: number | null) => void;
  drawingFrame: (groupId: string) => number;
  /** 沒存到的那一筆再送／放棄／那一塊的中心。 */
  retrySubmit: (structureId: string, frameIndex: number | null) => boolean;
  discardUnsaved: (structureId: string, frameIndex: number | null) => boolean;
  unsavedCenter: (structureId: string, frameIndex: number | null) => readonly [number, number, number] | null;
  stepTemporal: (groupId: string, delta: number) => void;
  setTemporalPlayback: (groupId: string, patch: Partial<Pick<TemporalState, 'playing' | 'fps' | 'loop' | 'rangeFrom' | 'rangeTo'>>) => void;
  temporalCurve: (seriesId: string, worldPrimary?: Vec3) => (number | null)[];
  frameOf: (layer: Pick<Layer, 'temporalGroupId' | 'frameIndex'>) => number | null;
  crosshairWorld: () => Vec3 | null;
  endVertexEdit: (commit: boolean) => void;
  highlightVertex: (measurementId: string, index: number | null) => void;
  setMeasurementOptions: (opts: { showFaded?: boolean }) => void;
  keyDown: (viewportId: string, key: string) => void;
  setTouchWindowLevel: (on: boolean) => void;
  setFingerDraws: (on: boolean) => void;
  toolAction: (action: 'finish' | 'cancel') => void;
  replaceMask: (args: { structureId: string; frameIndex: number | null; offsetIjk: readonly [number, number, number]; sizeIjk: readonly [number, number, number]; voxels: Uint8Array; contentHash: string; label?: string }) => boolean;
  probeVoxel: () => { ijk: [number, number, number]; seriesId: string } | null;
  viewportCameras: () => { viewportId: string; orientation: OrthoOrientation; camera: ViewReference }[];
  maskEntry: (structureId: string, frameIndex: number | null) => { contentHash: string } | undefined;
  // ── 斜面 MPR 與 slab ───────────────────────────────────────────────────
  setSlabThickness: (viewportId: string, mm: number) => void;
  setSlabOutlineSemantics: (semantics: SlabOutlineSemantics) => void;
  rotateViewport: (viewportId: string, axis: 'up' | 'right', angleDeg: number) => void;
  resetOrientation: (viewportId: string) => void;
  /** 開／關一個 UI 模式（例：`'mpr'`）。 */
  setMode: (id: string, enabled: boolean) => void;
  /** `factor > 1` 放大。不給 `cursorPx` 時以畫面中心為樞紐。 */
  zoom: (viewportId: string, factor: number) => void;
  /** Fit：整個網格回到視野內。 */
  fit: (viewportId: string) => void;
  /** 1:1：一個螢幕像素對一個體素。 */
  actualSize: (viewportId: string) => void;
  zoomFactor: (viewportId: string) => number;
  sliceLabel: (viewportId: string) => string;
  /** 切片捲軸（2026-09-29）：位置、拖曳／點選、相對跳張。 */
  sliceNav: (viewportId: string) => { index: number; count: number } | null;
  scrubSlice: (viewportId: string, phase: 'begin' | 'move' | 'end', index?: number) => void;
  stepSlice: (viewportId: string, delta: number) => void;

  // ── 編輯 ──────────────────────────────────────────────────────────────
  setActiveTool: (toolId: string | null) => void;
  setBrush: (patch: Partial<BrushSpec>) => void;
  /** 回傳是否成功；失敗時附上原因（例如替代表示唯讀）。 */
  setActiveStructure: (structureId: string | null) => { ok: boolean; reason: string | null };
  undo: () => void;
  redo: () => void;
}

export interface SceneSnapshot {
  layers: Layer[];
  /** 體素常駐（CPU 路徑的「常駐」就是這個，記憶體配額對應它）。 */
  resident: { image: number; mask: number; total: number; wasm: number };
  budgetBytes: number;
  tier: Tier;
  notices: SceneNotice[];
  substitutes: { layerId: string; rendererId: string; notice: string }[];
  quality: 'interactive' | 'final';
  /** 🔴 每幀量測 —— outline 重算時間就在這裡。 */
  frames: FrameStats[];
  kernelReady: boolean;
  kernelError: string | null;
  /** 游標讀數；null = 指標還沒進過任何 2D viewport。 */
  probe: ProbeReadout | null;
  /** 右鍵 WW/WL 的目標影像 layer；null = 最底下的可見影像。 */
  activeImageLayerId: string | null;
  /** 使用者暫時關掉對位的 FoR。 */
  disabledTransforms: string[];
  /** host 目前的 FrameGroup（後端推來新對位時會換；host 是唯一真相）。空 ＝ host 還沒建。 */
  frameGroups: FrameGroup[];
  /** 微調中、尚未提交的對位。 */
  transformOverrides: { frameOfReferenceUid: string; transformToPrimary: Mat16 }[];
  /** 每個 2D viewport 的斜面／slab 狀態。 */
  viewports: ViewportView[];
  slabOutlineSemantics: SlabOutlineSemantics;
  modes: string[];
  viewportHiddenLayers: Record<string, string[]>;
  selectedMeasurementId: string | null;
  vertexEdit: { measurementId: string } | null;
  measurementLabelHint: { kind: MeasurementKind; label: string } | null;
  temporal: readonly TemporalState[];
  viewportFrames: Record<string, Record<string, number>>;

  // ── 編輯狀態 ─────────────────────────────────────────────────────────────
  activeToolId: string | null;
  brush: BrushSpec;
  touch: { windowLevel: boolean; fingerDraws: boolean; penSeen: boolean };
  activeStructureId: string | null;
  /** null = 可以編輯；非 null 是不能編輯的原因（顯示在 UI 上）。 */
  editingBlockedReason: string | null;
  canUndo: boolean;
  canRedo: boolean;
  undoDepth: number;
  /** undo stack 佔用的位元組（每筆 2 × 子區塊）。 */
  undoBytes: number;
  /** 送出佇列是否清空 —— 切換病例前要等它。 */
  editsFlushed: boolean;
  /**
   * 🔴 **有編輯沒存到後端的結構。**
   *
   * `editsFlushed` 只是是非題；使用者需要知道**是哪一個結構**。空陣列 =
   * 沒有失敗，不是「不知道」。
   */
  submitFailures: QueueFailure[];
}

export interface UseSceneArgs {
  gridSet: GridSet | null;
  tier: Tier;
  seriesCount: number;
  transport: TransportLike;
  /** `POST /edit`。不給則編輯只在本地生效。 */
  submitEdit?: (request: SubmitRequest) => Promise<SubmitResult>;
  onConflict?: (info: ConflictInfo) => void;
  /** 送出失敗且重試用盡 —— UI 必須明示「這一筆沒有存到」。 */
  onSubmitError?: (message: string, request: SubmitRequest) => void;
  /** 別人改過某個結構、要重抓它的 mask（`ViewerHostOptions.onRemoteMaskChange`）。 */
  onRemoteMaskChange?: (info: { structureId: string; frameIndex: number | null; contentHash: string }) => void;
  /** 量測存回後端。 */
  onMeasurementChange?: (kind: 'add' | 'update' | 'remove', measurement: Measurement) => void;
}

const EMPTY_RESIDENT = { image: 0, mask: 0, total: 0, wasm: 0 };

export function useScene(args: UseSceneArgs): {
  commands: SceneCommands;
  snapshot: SceneSnapshot;
  /** 面板註冊 overlay painter 的地方。 */
  overlays: ViewportOverlayRegistry;
  ready: boolean;
} {
  const hostRef = useRef<ViewerHost | null>(null);
  /**
   * 🔴 目前的 host 是用哪一組 (gridSet, tier, seriesCount) 建的。
   *
   * 換病例時 host 是**非同步**重建的：gridSet 剛換的那次 render，hostRef 還是舊 host（cleanup 在 commit 之後才跑）。
   * 以前 `kernelReady` 只看 `host !== null` → 那一刻回報 true，App 的體素 effect 就開始抓、`putImage` 進了
   * 已 dispose 的舊 host（或 null）被丟掉。靜態影像之後由「可見就補 lod 0」補回來，時間軸的相位卻被記成已預抓、
   * 永遠不再抓 —— 症狀：先開別的病例再開 4D 病例，畫面一直黑、停在「載入中…」。
   */
  const hostArgs = useRef<{ gridSet: GridSet; tier: Tier; seriesCount: number } | null>(null);
  /**
   * 🔴 **overlay 註冊表由 hook 持有，不由 `ViewerHost` 持有。**
   *
   * `ViewerHost` 會因為換病例（`gridSet` 改變）而整個重建。註冊表若掛在它
   * 身上，面板註冊的 painter 會在切換病例時**靜默消失**——而面板的
   * `useEffect` 不會重跑，所以它不知道要重新註冊。症狀是「切一次案例之後
   * 我的 overlay 就不見了」。
   */
  const overlaysRef = useRef<ViewportOverlayRegistry | null>(null);
  overlaysRef.current ??= new ViewportOverlayRegistry();
  const overlays = overlaysRef.current;
  /**
   * 🔴 尚未套用的 viewport 掛載請求。
   *
   * `ViewerHost.create()` 是非同步的（要載 WASM 核心），而 `ViewportHost` 的
   * mount effect 比它先跑。舊版用 `hostRef.current?.attachViewport(...)`，
   * 於是那次呼叫**靜默什麼都沒做**、之後也沒有人重試 —— 結果是 DOM 裡一個
   * canvas 都沒有、畫面全黑、而且沒有任何錯誤訊息。
   *
   * 因此改成排隊：core 就緒時一次沖出。同一個 viewportId 只保留最後一次請求。
   */
  const pendingAttach = useRef(
    new Map<string, { info: ViewportInfo; container: HTMLElement; orientation: OrthoOrientation }>(),
  );
  const [notices, setNotices] = useState<SceneNotice[]>([]);
  const [kernelError, setKernelError] = useState<string | null>(null);
  const [version, setVersion] = useState(0);
  const budgetBytes = useMemo(
    () => budgetFor(args.tier, args.seriesCount).totalBytes,
    [args.tier, args.seriesCount],
  );
  const bump = useCallback(() => setVersion((v) => v + 1), []);
  const carriedModes = useRef<{ key: string; modes: string[] }>({ key: '', modes: [] });
  /** host 還在建（或重建）時按的模式開關：建好後套用（以前這段時間的點擊被靜默丟掉）。 */
  const pendingModes = useRef<Map<string, boolean>>(new Map());

  useEffect(() => {
    if (args.gridSet === null) return undefined;
    const gridSet = args.gridSet;
    // 註冊在 main.tsx 就做過了；這裡是測試直接用 hook 時的保險（冪等）
    registerCoreBuiltins();

    let host: ViewerHost | null = null;
    let cancelled = false;
    // 同一個病例（primary FoR 相同）才帶模式；換病例從頭開始
    const caseKey = args.gridSet.frameGroups.find((g) => g.role === 'primary')?.frameOfReferenceUid ?? args.gridSet.frameGroups[0]?.frameOfReferenceUid ?? '';
    void ViewerHost.create({
      gridSet: args.gridSet,
      tier: args.tier,
      seriesCount: args.seriesCount,
      transport: args.transport,
      overlays,
      onNotice: (notice) => setNotices((prev) => [...prev.slice(-49), notice]),
      onStateChange: bump,
      onFrame: () => bump(),
      ...(args.submitEdit ? { submitEdit: args.submitEdit } : {}),
      ...(args.onConflict ? { onConflict: args.onConflict } : {}),
      ...(args.onSubmitError ? { onSubmitError: args.onSubmitError } : {}),
      ...(args.onRemoteMaskChange ? { onRemoteMaskChange: args.onRemoteMaskChange } : {}),
      ...(args.onMeasurementChange ? { onMeasurementChange: args.onMeasurementChange } : {}),
    })
      .then((created) => {
        if (cancelled) {
          created.dispose();
          return;
        }
        host = created;
        hostRef.current = created;
        hostArgs.current = { gridSet, tier: args.tier, seriesCount: args.seriesCount };
        setKernelError(null);
        // 多組影像陸續到齊時 gridSet／seriesCount 會變 → host 重建；使用者在那之前開的 UI 模式（MPR、DVH…）要帶過來
        if (carriedModes.current.key === caseKey) for (const mode of carriedModes.current.modes) created.setMode(mode, true);
        for (const [mode, enabled] of pendingModes.current) created.setMode(mode, enabled);
        pendingModes.current.clear();
        // 沖出在 core 就緒前排隊的掛載請求
        for (const request of pendingAttach.current.values()) {
          created.attachViewport(request);
        }
        bump();
      })
      .catch((error: unknown) => {
        // 🔴 核心載不起來時必須說清楚，不能只是畫面一片黑。
        setKernelError(
          error instanceof Error ? error.message : String(error),
        );
      });

    return () => {
      cancelled = true;
      if (host !== null) carriedModes.current = { key: caseKey, modes: host.currentModes() };
      // 冪等 —— StrictMode double-mount 會走兩次
      host?.dispose();
      if (hostRef.current === host) {
        hostRef.current = null;
        hostArgs.current = null;
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [args.gridSet, args.tier, args.seriesCount, args.transport, bump, overlays]);

  // painter 註冊集合或停用狀態改變時要重繪狀態列（否則被停用的 painter 是靜默消失的）
  useEffect(() => {
    overlays.setChangeListener(bump);
    return () => overlays.setChangeListener(null);
  }, [overlays, bump]);

  const commands = useMemo<SceneCommands>(
    () => ({
      attachViewport: (info, container, orientation) => {
        pendingAttach.current.set(info.viewportId, { info, container, orientation });
        hostRef.current?.attachViewport({ info, container, orientation });
        bump();
      },
      detachViewport: (viewportId) => {
        pendingAttach.current.delete(viewportId);
        hostRef.current?.detachViewport(viewportId);
        bump();
      },
      setLayers: (layers) => {
        hostRef.current?.setLayers(layers);
        bump();
      },
      setVisible: (layerId, visible) => hostRef.current?.setVisible(layerId, visible),
      setGroupVisible: (groupId, visible) =>
        hostRef.current?.setGroupVisible(groupId, visible),
      setOpacity: (layerId, opacity) => hostRef.current?.setOpacity(layerId, opacity),
      setRenderStyle: (layerId, style) => hostRef.current?.setRenderStyle(layerId, style) ?? false,
      putImage: (entry) => hostRef.current?.putImage(entry),
      hasImage: (seriesId, lod, frameIndex) => hostRef.current?.hasImage(seriesId, lod, frameIndex) ?? false,
      hasFullResAnyFrame: (seriesId) => hostRef.current?.hasFullResAnyFrame(seriesId) ?? false,
      canHoldFullRes: (seriesId) => hostRef.current?.canHoldFullRes(seriesId) ?? false,
      dropImageLod: (seriesId, lod, frameIndex) => hostRef.current?.dropImageLod(seriesId, lod, frameIndex) ?? 0,
      dropMaskVoxels: (structureId, frameIndex) => hostRef.current?.dropMaskVoxels(structureId, frameIndex) ?? 0,
      putMask: (entry) => hostRef.current?.putMask(entry),
      putFetchedMask: (entry) => hostRef.current?.putFetchedMask(entry) ?? false,
      remoteMaskUpdate: (structureId, frameIndex, contentHash) => hostRef.current?.remoteMaskUpdate(structureId, frameIndex, contentHash) ?? true,
      render: () => hostRef.current?.render('final'),
      repaintOverlays: () => hostRef.current?.repaintOverlays(),
      setEditableBox: (ownerId, box, onChange) => hostRef.current?.setEditableBox(ownerId, box, onChange),
      setWindowLevel: (layerId, windowLevel) => hostRef.current?.updateLayer(layerId, { windowLevel }),
      setColormap: (layerId, colormap) => hostRef.current?.updateLayer(layerId, { colormap }),
      setBlendMode: (layerId, blendMode) => hostRef.current?.updateLayer(layerId, { blendMode }),
      setLayerParams: (layerId, params) => hostRef.current?.updateLayer(layerId, { params }),
      setActiveImageLayer: (layerId) => hostRef.current?.setActiveImageLayer(layerId),
      setTransformEnabled: (uid, enabled) => hostRef.current?.setTransformEnabled(uid, enabled),
      setFrameGroupTransform: (uid, m) => hostRef.current?.setFrameGroupTransform(uid, m),
      transformOverrideFor: (uid) => hostRef.current?.transformOverrideFor(uid) ?? null,
      currentTransformToPrimary: (uid) =>
        hostRef.current?.transformOverrideFor(uid) ??
        hostRef.current?.currentGridSet().frameGroups.find((f) => f.frameOfReferenceUid === uid)?.transformToPrimary ??
        IDENTITY_MAT16,
      setFrameGroups: (frameGroups) => hostRef.current?.setFrameGroups(frameGroups),
      setLockedStructures: (locks) => {
        hostRef.current?.setLockedStructures(locks);
        bump();
      },
      currentFrameGroups: () => [...(hostRef.current?.currentGridSet().frameGroups ?? [])],
      setToolParams: (patch) => hostRef.current?.setToolParams(patch),
      seriesGridCenter: (seriesId) => hostRef.current?.imageGridCenter(seriesId) ?? null,
      seriesGridBounds: (seriesId) => hostRef.current?.imageGridBounds(seriesId) ?? null,
      seriesHistogram: (seriesId, bins, range) => hostRef.current?.imageHistogram(seriesId, bins, range) ?? null,
      setViewportHiddenLayers: (viewportId, ids) => hostRef.current?.setViewportHiddenLayers(viewportId, ids),
      setCameraLinks: (groups) => hostRef.current?.setCameraLinks(groups),
      selectMeasurement: (id) => hostRef.current?.selectMeasurement(id),
      updateMeasurement: (id, patch, opts) => hostRef.current?.updateMeasurement(id, patch, opts ?? {}),
      removeMeasurement: (id) => hostRef.current?.removeMeasurement(id),
      addMeasurement: (m) => hostRef.current?.addMeasurement(m),
      addLandmarkPair: (args) => hostRef.current?.addLandmarkPair(args) ?? null,
      worldToFrame: (uid, world) => hostRef.current?.worldToFrame(uid, world) ?? null,
      moveCrosshair: (world) => hostRef.current?.moveCrosshair(world),
      beginVertexEdit: (id) => hostRef.current?.beginVertexEdit(id),
      setMeasurementLabelHint: (hint) => hostRef.current?.setMeasurementLabelHint(hint),
      setTemporalFrame: (groupId, frameIndex) => hostRef.current?.setTemporalFrame(groupId, frameIndex),
      setViewportFrame: (viewportId, groupId, frame) => hostRef.current?.setViewportFrame(viewportId, groupId, frame),
      drawingFrame: (groupId) => hostRef.current?.drawingFrame(groupId) ?? 0,
      retrySubmit: (structureId, frameIndex) => hostRef.current?.retrySubmit(structureId, frameIndex) ?? false,
      discardUnsaved: (structureId, frameIndex) => hostRef.current?.discardUnsaved(structureId, frameIndex) ?? false,
      unsavedCenter: (structureId, frameIndex) => hostRef.current?.unsavedCenter(structureId, frameIndex) ?? null,
      stepTemporal: (groupId, delta) => hostRef.current?.stepTemporal(groupId, delta),
      setTemporalPlayback: (groupId, patch) => hostRef.current?.setTemporalPlayback(groupId, patch),
      temporalCurve: (seriesId, world) => hostRef.current?.temporalCurve(seriesId, world) ?? [],
      // host 還沒建好時退回相位 0（與先前的硬編碼一致）
      frameOf: (layer) => hostRef.current?.frameOf(layer) ?? (layer.temporalGroupId ? 0 : null),
      crosshairWorld: () => hostRef.current?.crosshairWorld() ?? null,
      endVertexEdit: (commit) => hostRef.current?.endVertexEdit(commit),
      highlightVertex: (id, index) => hostRef.current?.highlightVertex(id, index),
      setMeasurementOptions: (opts) => hostRef.current?.setMeasurementOptions(opts),
      keyDown: (viewportId, key) => {
        hostRef.current?.handleKey(viewportId, key);
        bump();
      },
      setTouchWindowLevel: (on) => hostRef.current?.setTouchWindowLevel(on),
      setFingerDraws: (on) => hostRef.current?.setFingerDraws(on),
      toolAction: (action) => hostRef.current?.toolAction(action),
      replaceMask: (args) => hostRef.current?.replaceMask(args) ?? false,
      probeVoxel: () => hostRef.current?.probeVoxel() ?? null,
      viewportCameras: () => {
        const host = hostRef.current;
        if (!host) return [];
        return host.viewportIds().flatMap((id) => {
          const b = host.binding(id);
          return b && b.renderer !== null ? [{ viewportId: id, orientation: b.orientation, camera: b.camera }] : [];
        });
      },
      maskEntry: (structureId, frameIndex) => hostRef.current?.volumes.mask(structureId, frameIndex),
      setSlabThickness: (viewportId, mm) => hostRef.current?.setSlabThickness(viewportId, mm),
      setSlabOutlineSemantics: (semantics) => hostRef.current?.setSlabOutlineSemantics(semantics),
      rotateViewport: (viewportId, axis, deg) => hostRef.current?.rotateViewport(viewportId, axis, deg),
      resetOrientation: (viewportId) => hostRef.current?.resetOrientation(viewportId),
      setMode: (id, enabled) => {
        const host = hostRef.current;
        if (host === null) {
          pendingModes.current.set(id, enabled);
          return;
        }
        host.setMode(id, enabled);
        // 模式關掉 → 它的工具從工具列消失；若那正是作用中的工具，退回十字線（否則看不見的工具還在吃左鍵）
        if (!enabled && toolRequiresMode(host.currentTool(), id)) host.setActiveTool('navigate');
      },
      zoom: (viewportId, factor) => hostRef.current?.zoomViewport(viewportId, factor),
      fit: (viewportId) => hostRef.current?.fitViewport(viewportId),
      actualSize: (viewportId) => hostRef.current?.actualSizeViewport(viewportId),
      zoomFactor: (viewportId) => hostRef.current?.zoomFactor(viewportId) ?? 1,
      sliceLabel: (viewportId) => hostRef.current?.sliceLabel(viewportId) ?? '',
      sliceNav: (viewportId) => hostRef.current?.sliceNav(viewportId) ?? null,
      scrubSlice: (viewportId, phase, index) => hostRef.current?.scrubSlice(viewportId, phase, index),
      stepSlice: (viewportId, delta) => hostRef.current?.stepSlice(viewportId, delta),
      setActiveTool: (toolId) => hostRef.current?.setActiveTool(toolId),
      setBrush: (patch) => hostRef.current?.setBrush(patch),
      setActiveStructure: (structureId) =>
        hostRef.current?.setActiveStructure(structureId) ?? {
          ok: false,
          reason: t('檢視器尚未就緒'),
        },
      undo: () => {
        hostRef.current?.undo.undo();
        bump();
      },
      redo: () => {
        hostRef.current?.undo.redo();
        bump();
      },
    }),
    [bump],
  );

  const built = hostArgs.current;
  const host = built !== null && built.gridSet === args.gridSet && built.tier === args.tier && built.seriesCount === args.seriesCount ? hostRef.current : null;
  const snapshot = useMemo<SceneSnapshot>(
    () => ({
      layers: host?.currentLayers() ? [...host.currentLayers()] : [],
      resident: host?.residentBytes() ?? EMPTY_RESIDENT,
      budgetBytes,
      tier: args.tier,
      notices,
      substitutes: host?.scene.substituteNotices() ?? [],
      quality: host?.scene.currentQuality() ?? 'final',
      frames: host?.frameStats() ?? [],
      kernelReady: host !== null,
      kernelError,
      probe: host?.probe() ?? null,
      activeImageLayerId: host?.currentActiveImageLayer() ?? null,
      disabledTransforms: host?.disabledTransformUids() ?? [],
      frameGroups: host ? [...host.currentGridSet().frameGroups] : [],
      transformOverrides: host?.transformOverrideList() ?? [],
      viewports:
        host?.viewportIds().flatMap((id) => {
          const b = host.binding(id);
          if (!b || b.renderer === null) return [];
          return [
            {
              viewportId: id,
              orientation: b.orientation,
              slabThicknessMm: b.camera.slabThicknessMm,
              oblique: host.isOblique(id),
              angles: host.viewportAngles(id) ?? { aroundUpDeg: 0, aroundRightDeg: 0, totalDeg: 0 },
            },
          ];
        }) ?? [],
      slabOutlineSemantics: host?.currentSlabOutlineSemantics() ?? 'center',
      modes: host?.currentModes() ?? [],
      viewportHiddenLayers: host?.viewportHiddenLayers() ?? {},
      selectedMeasurementId: host?.currentSelectedMeasurement() ?? null,
      vertexEdit: host?.currentVertexEdit() ?? null,
      measurementLabelHint: host?.currentMeasurementLabelHint() ?? null,
      temporal: host?.currentTemporal() ?? [],
      viewportFrames: host?.viewportFrameLocks() ?? {},
      activeToolId: host?.currentTool() ?? null,
      brush: host?.currentBrush() ?? DEFAULT_BRUSH,
      touch: host?.touchState() ?? { windowLevel: false, fingerDraws: true, penSeen: false },
      activeStructureId: host?.currentStructure() ?? null,
      // 🔴 不可寫成 `host?.editingBlockedReason() ?? '尚未就緒'`：
      // `editingBlockedReason()` 回傳 `null` 正是「可以編輯」，會被 `??` 吞掉，
      // 於是筆刷永遠停用。host 不存在與「沒有阻擋原因」是兩件事。
      editingBlockedReason: host === null ? t('檢視器尚未就緒') : host.editingBlockedReason(),
      canUndo: host?.undo.canUndo() ?? false,
      canRedo: host?.undo.canRedo() ?? false,
      undoDepth: host?.undo.undoDepth ?? 0,
      undoBytes: host?.undo.bytes() ?? 0,
      editsFlushed: host?.submitQueue.isIdle() ?? true,
      submitFailures: host?.submitFailures() ?? [],
    }),
    // version 是刻意的依賴：core 的狀態變更透過它通知 React 重繪
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [host, budgetBytes, args.tier, notices, kernelError, version],
  );

  return { commands, snapshot, overlays, ready: host !== null };
}
