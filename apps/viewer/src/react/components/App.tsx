/**
 * 應用外殼 —— **只做兩件事：載入資料，以及組出 `ViewerApi`**。
 *
 * ## 這個檔案刻意不含任何 chrome
 *
 * 🔴 **UI 一律經 `PanelSlot` 掛載，核心自己的面板也不例外**（`react/panels/`）。
 * 舊版把案例選單、工具列、筆刷控制、undo、Tier 徽章、結構清單全部硬寫在這裡的
 * JSX 裡，而面板註冊表只被用來印一行標題字串 —— 那道縫因此**存在但從來
 * 沒有人走過**，第一個發現它壞掉的會是第一個第三方模組。
 *
 * 現在的版面就是骨架本身：
 *
 * ```
 * toolbar  ─────────────────────────────────
 * left-sidebar │ viewport-grid │ right-sidebar
 * bottom   ─────────────────────────────────
 * ```
 *
 * 要加東西 → 寫一個面板、`registerPanel` 到某個 slot。**不要改這個檔案。**
 *
 * ## 還留在這裡的是什麼
 *
 * 載入流程（探針 → `GET /sessions/current`（或開發用 `_test/load`）→ `POST /grids` → 圖層 → 體素 → WS）。它不是
 * UI，是**應用層的資料編排**，而且與後端端點的順序一一對應 —— 拆進面板反而會
 * 讓「為什麼是這個順序」失去落腳處。
 */

import { BrandMenu } from './AppNav';
import { CaseSummaryBadge, EditTargetBadge, SaveStatusBadge } from './HeaderStatus';
import { TaskBar } from './TaskBar';
import { isCaseMutation } from './pushFallback';
import { useLeaveGuard } from './useLeaveGuard';
import { COLLAPSE_STORAGE_KEY, modeChanges, readCollapsed, toggleFocus, type CollapseState } from './taskBar';

import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';

import {
  arbitrate,
  fromWire,
  isSceneRefetch,
  maskGridOf,
  probeClientCapability,
  PushChannel,
  TransportClient,
  type CaseSource,
  type ClientCapability,
  type GridSet,
  type Layer,
  type PresenceUser,
  type StructureMeta,
  type StructureSetInfo,
  type TierState,
  DEFAULT_LAYOUT_ID,
  LAYOUT_OVERRIDES_STORAGE_KEY,
  CURRENT_LAYOUT_STORAGE_KEY,
  readCurrentLayoutId,
  applyOverrides,
  parseOverrides,
  serializeOverrides,
  type AllLayoutOverrides,
  LAYOUT_TREES_STORAGE_KEY,
  applyTree,
  newCellId,
  parseTrees,
  removeCell,
  serializeTrees,
  setSplitSizes,
  splitCell,
  treeCellIds,
  treeFromGrid,
  type AllLayoutTrees,
  DOCK_STORAGE_KEY,
  parseDock,
  serializeDock,
  type DockState,
  cameraLinkGroups,
  getLayout,
  hasLayout,
  registerBuiltinLayouts,
  type ModuleHttp,
  type ViewerApi,
  type ViewerCommands,
  type ViewerState,
  type StructureEntry,
  disposeModules, subscribePanels, withoutCaseState,
} from '../../core';
import { navigate, routeFromHash, useHashRoute } from '../hooks/useHashRoute';
import { useLang } from '../hooks/useLang';
import { useScene } from '../hooks/useScene';
import { authApi, installUnauthorizedRedirect, type Principal } from '../auth/authApi';
import { LoginPage } from '../auth/LoginPage';
import { UserBadge } from '../auth/UserBadge';
import { DataPage } from '../data/DataPage';
import { registerMprModule } from '../modules/mpr';
import { registerRegistrationModule } from '../modules/registration';
import { registerDvhModule } from '../modules/dvh';
import { registerPlanModule } from '../modules/plan';
import { registerDoseOpsModule } from '../modules/doseops';
import { registerLayoutModule } from '../modules/layout';
import { registerMeasureModule } from '../modules/measure';
import { registerTemporalModule } from '../modules/temporal';
import { backendMessage, keepAllFramesFullRes, neededFullResFrames, readPhaseLocks, temporalSignature, writePhaseLocks } from '../modules/temporal/model';
import { budgetFor, setDeviceMemoryClass } from '../../core/tier/budget';
import { useFormFactor } from '../device/useFormFactor';
import { TouchTitles } from '../device/TouchTitles';
import { PHONE_CELL_ID, PhoneTabs, PhoneToolRow, PhoneViewBar } from './PhoneChrome';
import { registerRender3dModule } from '../modules/render3d';
import { registerRoiModule } from '../modules/roi';
import { registerReviewModule } from '../modules/review';
import { registerExportModule } from '../modules/export';
import { installPluginUis, pluginCatalog, registerPluginsModule } from '../plugins';
import { registerRefLinesModule } from '../modules/reflines';
import { lockedEntries } from '../collab/model';
import { FetchQueue, MASK_FETCH_CONCURRENCY } from '../hooks/fetchQueue';
import { caseSummaryOf } from './headerModel';
import { CaseClosedPane } from './CaseClosedPane';
import { withSetPermissions } from '../collab/structureSetActions';
import { ChangePasswordDialog } from '../auth/ChangePasswordDialog';
import { usesStructureSetsOf } from './structureGroups';
import { ShortcutsDialog } from '../help/ShortcutsDialog';
import { TourOverlay } from '../help/TourOverlay';
import { markTourDone, TASK_DRAW_STEPS, tourDone } from '../help/tour';
import { keyEventOf, resolveGlobalKey } from '../../core/keys';
import { isEditingTool, listTools } from '../../core';
import { registerCoreUi } from '../panels/builtins';
import { ViewerApiProvider } from '../panels/context';
import { PanelSlot } from '../panels/PanelSlot';
import { Sidebar } from './Sidebar';
import { DockProvider } from './Dock';
import { ViewportArea } from './ViewportArea';
import { StorageBanner } from '../storage/StorageBanner';
import { joinList, msg, t } from '../../core/i18n';
import type { LayoutSpec } from '../../core/panels/layouts';
import { loadPrefs, prefStorage, savePref } from '../prefs/prefs';
import { applyIsodoseDefault } from '../prefs/isodoseDefault';

/** 結構清單 → 面板要的 meta（含名稱／顏色／TG-263／FoR／hash）。 */
function structureMetaOf(entry: StructureEntry): StructureMeta {
  return {
    structureId: entry.structureId,
    status: entry.status,
    volumeCc: entry.volumeCc,
    name: entry.name,
    colorRgb: entry.colorRgb,
    tg263Code: entry.tg263Code,
    frameOfReferenceUid: entry.frameOfReferenceUid,
    structureSetId: entry.structureSetId,
    editable: entry.editable,
    structureSetKind: entry.structureSetKind,
    structureSetOwner: entry.structureSetOwner,
    interpretedType: entry.interpretedType ?? null,
    ...(entry.contentHash !== null ? { contentHash: entry.contentHash } : {}),
  };
}

/** `scene.structureSets`（snake_case）→ 面板要的形狀。缺就空陣列（舊後端、假體）。 */
function structureSetsOf(raw: unknown): StructureSetInfo[] {
  if (!Array.isArray(raw)) return [];
  const text = (v: unknown): string => (typeof v === 'string' ? v : typeof v === 'number' ? String(v) : '');
  return raw.map((x) => {
    const w = x as Record<string, unknown>;
    return {
      structureSetId: text(w.structure_set_id),
      label: text(w.label),
      seriesInstanceUid: typeof w.series_instance_uid === 'string' ? w.series_instance_uid : null,
      imageSeriesUid: text(w.image_series_uid),
      imageLabel: text(w.image_label),
      frameOfReferenceUid: text(w.frame_of_reference_uid),
      date: text(w.date),
      roiCount: Number(w.roi_count ?? 0),
      role: w.role === 'secondary' ? 'secondary' : w.role === 'work' ? 'work' : 'primary',
      kind: w.kind === 'work' ? 'work' : w.kind === 'transient' ? 'transient' : 'import',
      owner: typeof w.owner === 'string' ? w.owner : null,
      description: text(w.description),
      mine: w.mine === true,
      editable: w.editable === true,
    };
  });
}

/** 只在後端**沒有資料庫**時用（純假體開發）；有資料庫就不載假體、直接進資料頁。 */
const DEFAULT_PHANTOM = 'phantom:gantry_tilt';

interface SessionState {
  /** 後端 session id（WS 用它，不再用 `current`）。 */
  sessionId: string | null;
  /** 簽核／匯出模組打 `/cases/{caseId}`、`/studies/{studyId}/…`。 */
  caseId: string | null;
  studyId: string | null;
  gridSet: GridSet | null;
  layers: Layer[];
  structures: StructureMeta[];
  /** 結構集（來源 RTSTRUCT）。 */
  structureSets: StructureSetInfo[];
  /** 病例適用結構集規則（`scene.usesStructureSets`）。 */
  usesStructureSets: boolean;
  /** 誰開著這個病例。 */
  presence: PresenceUser[];
  tier: TierState | null;
  seriesCount: number;
  error: string | null;
  /** 關閉病例後留下的重載資訊；null ＝ 正常。 */
  closed: { selection: Record<string, unknown> | null; label: string } | null;
}

// 核心面板的註冊在模組載入時就做掉（冪等）——放在元件裡會與 StrictMode 的
// double-invoke 打架，而 `registerPanel` 對重複 id 是拋例外的（PN2）。
registerCoreUi();
// 模組走與核心相同的註冊路徑；斜面 MPR 是第一個
registerMprModule();
registerRegistrationModule();
registerBuiltinLayouts();
registerDvhModule();
registerPlanModule();
registerDoseOpsModule();
registerLayoutModule();
registerMeasureModule();
registerTemporalModule();
registerRender3dModule();
registerRoiModule();
// 簽核與匯出模組
registerReviewModule();
registerRefLinesModule();
registerExportModule();
registerPluginsModule();


/**
 * 少用的頁面（管理、說明、暫存區、封存區、匯出紀錄）另外一包，進到那一頁才下載 ——
 * 首包不帶它們。檢視器、資料頁照舊在首包（日常入口）。
 */
const AdminPage = lazy(() => import('../auth/AdminPage').then((m) => ({ default: m.AdminPage })));
const HelpPage = lazy(() => import('../help/HelpPage').then((m) => ({ default: m.HelpPage })));
const ArchivePage = lazy(() => import('../retention/ArchivePage').then((m) => ({ default: m.ArchivePage })));
const TrashPage = lazy(() => import('../retention/TrashPage').then((m) => ({ default: m.TrashPage })));
const ExportRecordsPage = lazy(() => import('../modules/export/ExportRecordsPage').then((m) => ({ default: m.ExportRecordsPage })));

function PageLoading(): React.JSX.Element {
  return <p className="muted page-loading">{t('載入中…')}</p>;
}

/** 手機的版面 —— 一格（方位由影像上方的切換改那一格的覆寫）。不註冊進版面清單（桌面的版面選單看不到它）。 */
const PHONE_LAYOUT: LayoutSpec = {
  id: 'phone',
  label: msg('手機'),
  gridTemplateColumns: '1fr',
  gridTemplateRows: '1fr',
  cells: [{ cellId: PHONE_CELL_ID, content: { kind: 'viewport', orientation: 'axial' } }],
};

export function App(): React.JSX.Element {
  const transport = useMemo(() => new TransportClient(), []);
  // 手機／平板／桌面。手機的記憶體預算另一級 —— 要在 useScene 建 host 之前設好
  const formFactor = useFormFactor();
  setDeviceMemoryClass(formFactor === 'phone' ? 'phone' : 'default');
  // 版面是 React 狀態；host 不認識版面，只認識相機連動群與每格隱藏清單
  // 目前選的版面也記住（跟著帳號）
  const [savedLayoutId, setLayoutIdState] = useState<string>(() => readCurrentLayoutId());
  // 手機一次一格（自己的版面 id，不動桌面記住的版面）；方位存在那一格的覆寫
  const phone = formFactor === 'phone';
  const layoutId = phone ? PHONE_LAYOUT.id : savedLayoutId;
  const setLayoutId = useCallback((id: string) => {
    setLayoutIdState(id);
    savePref(CURRENT_LAYOUT_STORAGE_KEY, id);
  }, []);
  // 每格覆寫存在瀏覽器（依版面 id）；壞掉的字串會被 parseOverrides 丟掉
  const [overrides, setOverrides] = useState<AllLayoutOverrides>(() => {
    try {
      return parseOverrides(window.localStorage.getItem(LAYOUT_OVERRIDES_STORAGE_KEY));
    } catch {
      return {};
    }
  });
  // 使用者分割／拖過的版面樹（依版面 id）；沒有 → 由具名版面換算
  const [trees, setTrees] = useState<AllLayoutTrees>(() => {
    try {
      return parseTrees(window.localStorage.getItem(LAYOUT_TREES_STORAGE_KEY));
    } catch {
      return {};
    }
  });
  const baseLayout = useCallback((id: string) => (id === PHONE_LAYOUT.id ? PHONE_LAYOUT : getLayout(id)), []);
  const layoutTree = useMemo(() => trees[layoutId] ?? treeFromGrid(baseLayout(layoutId)), [layoutId, trees, baseLayout]);
  const layout = useMemo(
    () => applyTree(applyOverrides(baseLayout(layoutId), overrides[layoutId]), layoutTree, overrides[layoutId]),
    [layoutId, overrides, layoutTree, baseLayout],
  );
  const updateOverrides = useCallback((next: AllLayoutOverrides) => {
    setOverrides(next);
    try {
      savePref(LAYOUT_OVERRIDES_STORAGE_KEY, serializeOverrides(next));
    } catch {
      // 私密視窗／被封鎖：只活在這次 session
    }
  }, []);
  const updateTrees = useCallback((next: AllLayoutTrees) => {
    setTrees(next);
    savePref(LAYOUT_TREES_STORAGE_KEY, serializeTrees(next));
  }, []);
  // 模組狀態袋（設定面板與格子面板共用）
  const [modules, setModules] = useState<Record<string, Record<string, unknown>>>({});
  // 兩頁（`#/library` 資料選取、其餘 viewer）。切頁只換渲染的區塊，
  // `useScene` 的 ViewerHost 與體素倉留在 App 裡 —— 回到 viewer 不必重抓 200 MB。
  const route = useHashRoute();
  // 語言一換整棵樹重畫（`t()` 在 render 時查字典；專案沒有 React.memo，一次重畫就全到）
  const lang = useLang();
  useEffect(() => {
    document.documentElement.lang = lang;
  }, [lang]);
  // 身分。`authMode === 'off'`（沒有 Postgres）時整段身分不出現。
  const [user, setUser] = useState<Principal | null>(null);
  // plugin 面板在 App render 之後才註冊 → 註冊表變了就重 render
  const [, bumpPanels] = useState(0);
  const [info, setInfo] = useState<string | null>(null);
  useEffect(() => subscribePanels(() => bumpPanels((n) => n + 1)), []);
  const [authMode, setAuthMode] = useState<'required' | 'off' | null>(null);
  useEffect(() => {
    installUnauthorizedRedirect(() => {
      setUser(null);
      navigate('login');
    });
    void authApi.status().then(
      async (st) => {
        // 帳號偏好（版面、側欄、語言…）先寫進 localStorage，再讓檢視器掛上
        if (st.mode === 'required' && st.user !== null && (await loadPrefs())) reloadPrefsIntoState();
        else applyIsodoseDefault(); // 沒有帳號偏好時（auth off）就用這台瀏覽器的
        setAuthMode(st.mode);
        setUser(st.user);
        if (st.mode === 'required' && st.user === null) navigate('login');
      },
      () => setAuthMode('off'),
    );
  }, []);
  const sessionRef = useRef<SessionState>(null as unknown as SessionState);
  const [session, setSession] = useState<SessionState>({
    sessionId: null,
    caseId: null,
    studyId: null,
    gridSet: null,
    layers: [],
    structures: [],
    structureSets: [],
    usesStructureSets: false,
    presence: [],
    tier: null,
    seriesCount: 1,
    error: null,
    closed: null,
  });
  // 說明對話框與功能導覽
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [tourOpen, setTourOpen] = useState<false | 'feature' | 'draw'>(false);
  sessionRef.current = session;
  // 換病例（含從資料頁開另一個病例）：模組狀態裡跟著病例走的欄位清掉（3D 相機與裁切框、選中的計畫…），偏好留著。
  // 以前整袋留著：上一個病例的 3D 相機套到下一個病例，3D 格整片黑，要按「正面」才出來
  const casePrev = useRef<string | null>(null);
  useEffect(() => {
    if (casePrev.current !== null && session.caseId !== casePrev.current) setModules((prev) => withoutCaseState(prev));
    casePrev.current = session.caseId;
  }, [session.caseId]);
  const [source, setSource] = useState<string>('');
  /**
   * 見過的非假體來源（`dicom:...`）。
   *
   * 🔴 沒有這個的話，**切走 DICOM 案例之後就切不回來** —— 選單只列假體，
   * 而 DICOM 選項先前只在「當前就是它」時才渲染。
   */
  const [extraSources, setExtraSources] = useState<string[]>([]);

  /** 網格協商完、`ViewerHost` 就緒之後才抓體素（core 還沒好時抓了沒地方放）。 */
  const pendingFetch = useRef<{
    transport: TransportClient;
    /** 全部要抓的體積（影像 ＋ 劑量），primary 在前。 */
    volumeSeriesIds: string[];
    layers: Layer[];
    /** 這批體素屬於哪一次載入。與 `loadRun` 不符就丟掉。 */
    runId: number;
  } | null>(null);
  /** 已抓過 lod 0 的序列（`${seriesId}#${runId}`；被逐出後重新顯示時要能再補）。 */
  const fetchedFullRes = useRef(new Set<string>());
  /**
   * lod 0 正在抓的 key。「抓過」與「正在抓」分開：抓過、現在卻不在倉裡 ＝ 被全解析度上限逐出（或手動卸載），
   * 有空位時要補回來 —— 以前兩者共用 `fetchedFullRes`，逐出之後就再也不抓（把其他影像關掉，4D 也一直是低解析度）。
   */
  const fullResInflight = useRef(new Set<string>());
  /** 初始那批體素還在抓：期間「變成可見時補抓」的 effect 不動，避免同一份抓兩次。 */
  const initialFetchRunning = useRef(false);
  const loadRun = useRef(0);
  /**
   * 病例載入中（`load()` 開始 → 新 session 的 gridSet 到手）。這段時間畫面上還是**舊**病例的圖層與 host，
   * 「可見就補抓」的 mask／體素 effect 若照跑，會把東西抓進即將被丟掉的舊 host，又把 key 記成已抓 → 新 host 永遠缺
   *（重開同一個病例：輪廓消失；4D：其他相位不抓）。載入中這些 effect 一律不動，等新 host 好了再跑。
   */
  const caseLoading = useRef(false);
  /** I3 只自動重新協商一次；避免無聲的無限重試。 */
  const renegotiated = useRef(false);
  /** 初次體素抓取完成的次數（只用來重跑依賴 `initialFetchRunning` 的 effect）。 */
  const [initialFetchDone, setInitialFetchDone] = useState(0);
  /** 探針結果留著，I3 衝突時要用同一份能力重新協商。 */
  const capabilityRef = useRef<ClientCapability | null>(null);

  const { commands, snapshot, overlays } = useScene({
    // 量測存回後端；失敗顯示在錯誤列（本地已生效）
    onMeasurementChange: (kind, measurement) => {
      const call =
        kind === 'add'
          ? transport.createMeasurement(measurement)
          : kind === 'update'
            ? transport.updateMeasurement(measurement)
            : transport.deleteMeasurement(measurement.measurementId);
      call.catch((e: unknown) =>
        setSession((prev) => ({ ...prev, error: t('量測沒有存到：{p0}', { p0: e instanceof Error ? e.message : String(e) }) })),
      );
    },
    gridSet: session.gridSet,
    tier: session.tier?.assigned ?? 'A',
    seriesCount: session.seriesCount,
    transport,
    // 樂觀更新：本地先畫，背景送出
    submitEdit: async (request) => {
      const result = await transport.submitEdit({
        structureId: request.structureId,
        frameIndex: request.frameIndex,
        baseContentHash: request.baseContentHash,
        clientSeq: request.clientSeq,
        offsetIjk: request.patch.offsetIjk,
        sizeIjk: request.patch.sizeIjk,
        data: request.patch.data,
        viewReference: request.viewReference,
        // 結構所屬 FoR 的 MaskGrid（佇列登記時就是它）—— 以前沒傳，次要影像上的結構每一筆都 400 I3、存不進去
        maskGridId: request.maskGridId,
      });
      // 體積讀數跟著每一筆送出更新（筆刷、undo／redo、後處理都走這裡）
      if (result.status === 'ok' && result.volumeCc !== undefined) {
        const volumeCc = result.volumeCc;
        setSession((prev) => ({
          ...prev,
          structures: prev.structures.map((s) =>
            s.structureId === request.structureId
              ? { ...s, volumeCc: request.frameIndex === null || !Array.isArray(s.volumeCc) ? volumeCc : s.volumeCc.map((v, i) => (i === request.frameIndex ? volumeCc : v)) }
              : s,
          ),
        }));
      }
      return result;
    },
    onConflict: (info) => {
      // 真衝突：清空該結構 undo（core 已做）、UI 明示、下次可見時重抓
      setSession((prev) => ({
        ...prev,
        error: t('「{structureId}」已被其他來源修改，該結構的復原紀錄已清空', { structureId: info.structureId }),
      }));
      fetchedMasks.current.delete(`${info.structureId}@${info.frameIndex ?? 'static'}`);
    },
    // 🔴 送出失敗且重試用盡：**不得靜默**。`SubmitQueue` 已把 bbox 留在佇列裡
    // （`editsFlushed` 因此仍是 false），這裡負責讓使用者看到是哪一個結構。
    // 提示列有一列「沒有存到後端」＋ 再送一次／跳到那一塊／放棄（`NoticesPanel` 的 UnsavedRow，role=alert），
    // 標頭也有「保存失敗 n 筆」—— 不再另外塞全域錯誤列（以前那一句用的是結構 id、重試成功後也不會消失）。
    onSubmitError: (message, request) => {
      console.warn(`edit not saved: ${request.structureId}@${request.frameIndex ?? 'static'}: ${message}`);
    },
    // 2026-10-09：佇列送完才確定推來的是別人改的 → 丟掉本地那份、重抓（跟 onMaskUpdated 同一條路）
    onRemoteMaskChange: (info) => {
      fetchedMasks.current.delete(`${info.structureId}@${info.frameIndex ?? 'static'}`);
      setSession((prev) => ({ ...prev, layers: [...prev.layers] }));
    },
  });
  /** effect 的非同步回呼裡要讀**最新的** snapshot（全解析度抓完時決定留哪幾幀）。 */
  const snapshotRef = useRef(snapshot);
  snapshotRef.current = snapshot;

  /**
   * 載入流程：探針 → `GET /sessions/current`（有 session）或 `_test/load`（開發指定假體）→ `POST /grids` → 圖層 → WS。
   *
   * `source` 為 null 時**沿用後端目前的 session**（不強制載入）。這讓
   * `rtgaia-testbe --load phantom:X` 與「重新整理瀏覽器」都不會被前端的預設值
   * 蓋掉——否則 `--load` 等於無效。
   */
  const load = useCallback(
    async (requested: string | null) => {
      // 重載／換病例 → 已抓過的 mask 記錄歸零（host 會重建、倉是空的；不清就永遠不再抓 —— 「清單有、畫面沒輪廓」）
      fetchedMasks.current.clear();
      fullResBytes.current.clear();
      // 🔴 每次載入取一個遞增代號；await 之後若代號已被後來的載入取代就放棄。
      //
      // StrictMode 的 double-invoke、以及使用者快速切換案例，都會讓兩條載入鏈
      // 同時在跑。沒有這道閘門的話，先開始的那條會在後面覆寫掉狀態，
      // 而它拿的是舊 session 的網格 → 409。
      const runId = loadRun.current + 1;
      loadRun.current = runId;
      const stale = (): boolean => loadRun.current !== runId;
      caseLoading.current = true;
      // 上一個病例的錯誤在這裡清掉；載入期間設的訊息（資料頁開病例的警告：哪個影像沒載入、
      // 時間軸排除了哪一幀…）要留到載入完 —— 以前載入完的 setSession 一律把 error 蓋成 null，警告從來看不到
      setSession((prev) => (prev.error === null ? prev : { ...prev, error: null }));
      try {
        // 1) Tier 探針。第一版沒有 GPU 光柵化，因此 renderFrame 是
        //    一個真正會被 GPU 執行的最小工作：清一次 canvas。
        const capability: ClientCapability = await probeClientCapability(() => {
          const canvas = document.createElement('canvas');
          canvas.width = 128;
          canvas.height = 128;
          canvas.getContext('2d')?.clearRect(0, 0, 128, 128);
        });
        if (stale()) return;
        capabilityRef.current = capability;

        // 2) 取得案例：先看後端有沒有現成的 session
        let studyId: string;
        let scene: Record<string, unknown>;
        let loadedSource = requested;

        // 正式端點。之前打的是測試端點 `_test/state`，`_test/*` 改成 --test-api 才掛之後，
        // 正式配置的後端就沒有任何一條路讓檢視器拿到 session（資料頭「開啟」永遠彈回資料頭）。
        const existing = await fetch('/api/v1/sessions/current');
        if (requested === null && existing.ok) {
          // 🔴 `studyId`、`source`、`gridSet`、`layers` **全部取自同一個回應**。
          //
          // 舊版另外打 `_test/sessions` 再取 `sessions[0]` —— 但 store 會同時
          // 保留不同 study 的 session，於是「清單第一個」不是「當前這個」。
          // 結果是拿 A 的 studyId 去 POST /grids、卻拿 B 的 series 去抓影像，
          // 換來 409 I3；而且只有切換過案例後的第一次重新整理會壞，因此看起來
          // 像「不穩定」。
          scene = (await existing.json()) as Record<string, unknown>;
          studyId = (scene.studyId as string | undefined) ?? '';
          loadedSource = (scene.source as string | undefined) ?? null;
        } else {
          if (requested === null) {
            // 後端沒有現成的 session：有資料庫就到資料頁讓使用者選（不再自動載假體）。
            // 只有人在檢視器頁時才換頁 —— 否則沒開病例時重新整理 `#/admin`／`#/trash`／`#/archive` 會被踢回資料頁
            const lib = await fetch('/api/v1/library');
            if (lib.ok && ((await lib.json()) as { configured?: boolean }).configured) {
              if (!stale() && routeFromHash(location.hash) === 'viewer') navigate('library');
              if (!stale()) caseLoading.current = false; // 沒有病例可載
              return;
            }
          }
          const response = await fetch('/api/v1/_test/load', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ source: requested ?? DEFAULT_PHANTOM }),
          });
          // 🔴 一定要檢查 `ok`。少了這一行，422/500 會變成
          // 「Cannot read properties of undefined (reading 'gridSet')」
          // —— 使用者看到的訊息與原因毫無關係。
          if (!response.ok) {
            const detail = (await response.text()).slice(0, 300);
            throw new Error(
              t('載入「{p0}」失敗（HTTP {status}）：{detail}', { p0: requested ?? DEFAULT_PHANTOM, status: response.status, detail }),
            );
          }
          const loaded = (await response.json()) as {
            study_id: string;
            source: string;
            scene: Record<string, unknown>;
          };
          studyId = loaded.study_id;
          scene = loaded.scene;
          loadedSource = loaded.source;
        }
        if (stale()) return;
        renegotiated.current = false;
        setSource(loadedSource ?? '');
        if (loadedSource !== null && !loadedSource.startsWith('phantom:')) {
          setExtraSources((prev) =>
            prev.includes(loadedSource) ? prev : [...prev, loadedSource],
          );
        }
        // FrameGroup ＝ 影像序列（劑量借用同 FoR 影像的 FrameGroup，不在這裡）
        const seriesIds = (
          (scene.gridSet as Record<string, unknown>).frame_groups as { series_id: string }[]
        ).map((f) => f.series_id);

        // 之後的請求都帶這個 session（伺服器用結構、量測 id 定位時只看它）
        transport.useSession((scene.sessionId as string | undefined) ?? null);

        // 3) 網格由後端決定
        const grids = await transport.createGrids({
          studyId,
          primarySeriesId: seriesIds[0]!,
          seriesIds,
          capability,
        });

        if (stale()) return;
        const tier = arbitrate({
          capability,
          backendAssigned: grids.gridSet.assignedTier,
        });

        const layers = (scene.layers as Record<string, unknown>[]).map((x) => fromWire.layer(x));
        // 結構清單走 HTTP，不從 scene.replace 拿
        // （帶 85 個 ROI 的推送會撞穿 WS 訊息上限）
        const structures = (await transport.fetchStructures()).map(structureMetaOf);

        setSession((prev) => ({
          closed: null,
          sessionId: (scene.sessionId as string | undefined) ?? null,
          caseId: (scene.caseId as string | undefined) ?? null,
          studyId,
          gridSet: grids.gridSet,
          layers,
          structures,
          structureSets: structureSetsOf(scene.structureSets),
          usesStructureSets: usesStructureSetsOf(scene),
          presence: [],
          tier,
          seriesCount: seriesIds.length,
          error: grids.tierConflict ? t('Tier 協商衝突：{p0}', { p0: grids.reason ?? '' }) : prev.error,
        }));
        caseLoading.current = false;

        // 4) 體素：**全部**體積序列（影像 ＋ 劑量），primary 在前；先 lod=2 出畫面，
        //    可見的再補 lod=0（漸進式 lod）
        const volumeSeriesIds = [
          ...seriesIds,
          ...layers.filter((l) => l.kind === 'dose').map((l) => l.contentRef),
        ];
        fetchedFullRes.current.clear();
        fullResInflight.current.clear();
        pendingFetch.current = { transport, volumeSeriesIds, layers, runId };
      } catch (error) {
        if (stale()) return;
        caseLoading.current = false;
        setSession((prev) => ({
          ...prev,
          error: error instanceof Error ? error.message : String(error),
        }));
      }
    },
    [transport],
  );

  useEffect(() => {
    // null = 沿用後端現有的 session（尊重 --load，重新整理也不會換案例）
    // 身分還沒確認（或需要登入）就先不載，登入後 LoginPage 會呼叫 reload
    if (authMode === null || (authMode === 'required' && user === null)) return;
    void load(null);
  }, [load, authMode, user]);

  // 圖層交給 core
  useEffect(() => {
    if (session.layers.length > 0) commands.setLayers(session.layers);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session.layers]);

  /** 某個 FoR 的 mask grid id；session 還沒好或找不到就退回 primary 的。 */
  const maskGridIdFor = useCallback(
    (frameOfReferenceUid: string): string | undefined => {
      const gs = session.gridSet;
      if (gs === null) return undefined;
      try {
        return maskGridOf(gs, frameOfReferenceUid).maskGridId;
      } catch {
        return gs.maskGrid.maskGridId;
      }
    },
    [session.gridSet],
  );

  /**
   * 按需抓 mask —— 使用者打開一個結構時才抓（85 個 ROI 全抓沒有意義）。
   *
   * 走**有上限的佇列**（同時 `MASK_FETCH_CONCURRENCY` 個），進度放進 `maskLoading` 給面板顯示
   * 「載入結構 12／27」。重畫不在這裡叫 —— `host.putMask` 自己排（合併到下一幀）。
   */
  const fetchedMasks = useRef(new Set<string>());
  const maskQueue = useRef(new FetchQueue(MASK_FETCH_CONCURRENCY, (progress) => setMaskLoading(progress)));
  const [maskLoading, setMaskLoading] = useState<{ done: number; total: number } | null>(null);
  /** 游標或播放狀態變了 → 抓新相位的 mask／全解析度（effect 的依賴）。 */
  const temporalKey = snapshot.temporal.map((g) => `${g.temporalGroupId}:${g.cursor}:${g.playing ? 1 : 0}`).join('|');
  /** 每一格鎖定的相位變了 → 補那幾幀的全解析度與結構。 */
  const lockKey = JSON.stringify(snapshot.viewportFrames);
  const ensureMask = useCallback(
    (client: TransportClient, layer: Layer, frameOverride?: number): Promise<void> => {
      // 帶時間軸的結構抓目前相位（游標換了 → 下面的 effect 再叫一次，抓新相位）；預抓別的幀時指定 `frameOverride`
      const frame = frameOverride !== undefined && layer.temporalGroupId ? frameOverride : commands.frameOf(layer);
      // 畫在 4DCT 某一相位上的結構只有那一幀 —— 別的幀沒有東西可抓（畫面上就是沒有它）
      if (frame !== null && layer.frames !== undefined && !layer.frames.includes(frame)) return Promise.resolve();
      const key = `${layer.contentRef}@${frame ?? 'static'}`;
      if (fetchedMasks.current.has(key)) return Promise.resolve();
      fetchedMasks.current.add(key);
      return maskQueue.current.enqueue(async () => {
        try {
          const mask = await client.fetchMask(layer.contentRef, {
            frameIndex: frame,
            // I3 比對的是**該結構 FoR 的** MaskGrid，不是 primary 的
            maskGridId: maskGridIdFor(layer.frameOfReferenceUid),
          });
          // 這個結構還有沒送完的編輯 → 不蓋本地（送完後若後端版本不同，佇列會再叫重抓）
          commands.putFetchedMask({
            structureId: layer.contentRef,
            frameIndex: mask.frameIndex,
            offsetIjk: mask.offsetIjk,
            sizeIjk: mask.sizeIjk,
            voxels: new Uint8Array(mask.voxels),
            contentHash: mask.contentHash,
            // 結構所屬 FoR 決定它的 MaskGrid
            frameOfReferenceUid: layer.frameOfReferenceUid,
          });
        } catch (error) {
          // 抓失敗要把 key 放回去，否則永遠不會重試
          fetchedMasks.current.delete(key);
          setSession((prev) => ({
            ...prev,
            error: t('mask 載入失敗（{label}）：{p1}', { label: layer.label, p1: error instanceof Error ? error.message : String(error) }),
          }));
        }
      });
    },
    [commands, maskGridIdFor],
  );

  /** 任何 mask layer 變成可見時就補抓它的體素。 */
  useEffect(() => {
    if (!snapshot.kernelReady || session.gridSet === null || caseLoading.current) return;
    for (const layer of session.layers) {
      if (layer.kind !== 'mask' || !layer.visible) continue;
      void ensureMask(transport, layer);
      // 每一格鎖定的相位 —— 那一格畫那一幀的結構
      if (layer.temporalGroupId) {
        for (const locks of Object.values(snapshot.viewportFrames)) {
          const f = locks[layer.temporalGroupId];
          if (f !== undefined) void ensureMask(transport, layer, f);
        }
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [snapshot.kernelReady, snapshot.layers, session.layers, session.gridSet, temporalKey, lockKey]);

  /**
   * 影像／劑量 layer 變成可見、而它的 lod 0 不在倉裡（還沒抓、或被全解析度上限逐出）
   * → 補抓。載入時的體積 lod 2 一直都在，所以畫面不會空白，只是先粗後細；載入後才推來的圖層（劑量運算結果）直接抓 lod 0。
   */
  useEffect(() => {
    if (!snapshot.kernelReady || pendingFetch.current !== null || initialFetchRunning.current || caseLoading.current) return;
    // 時間序列看目前相位；播放中不補全解析度（播放用低解析度，暫停後補）。
    // 攤開的那一張看自己的幀；每一格鎖定的相位也要（鎖定的格子不跟著播）
    const needed = neededFullResFrames(snapshot.layers, snapshot.temporal, snapshot.viewportFrames);
    const wants: { layer: Layer; frame: number | null }[] = [];
    for (const layer of snapshot.layers) {
      if ((layer.kind !== 'image' && layer.kind !== 'dose') || !layer.visible) continue;
      const frames = typeof layer.frameIndex === 'number' ? [layer.frameIndex] : [...(needed.get(layer.contentRef) ?? [])];
      for (const frame of frames) if (!wants.some((w) => w.layer.contentRef === layer.contentRef && w.frame === frame)) wants.push({ layer, frame });
    }
    for (const { layer, frame } of wants) {
      if (commands.hasImage(layer.contentRef, 0, frame)) continue;
      // 載入時每個體積都先有 lod 2；之後才加進來的圖層（劑量運算的結果經 `layer.add` 推來）沒有 —— 直接抓 lod 0。
      // 時間序列的相位仍等預抓的 lod 2（播放用）
      if (frame !== null && !commands.hasImage(layer.contentRef, 2, frame)) continue;
      const key = `${layer.contentRef}${frame === null ? '' : `#f${frame}`}#${loadRun.current}`;
      if (fullResInflight.current.has(key)) continue;
      // 抓過、現在不在 ＝ 被逐出 → 有空位（不會再逐出別的可見序列）才補，不然兩個序列互相逐出、一直重抓
      if (fetchedFullRes.current.has(key) && !commands.canHoldFullRes(layer.contentRef)) continue;
      fetchedFullRes.current.add(key);
      fullResInflight.current.add(key);
      void fetchVolume(transport, layer.contentRef, 0, frame)
        .then(() => {
          // 時間序列只留**需要的**相位的全解析度（10 相位全留 = 10 倍記憶體）——
          // 預算放得下、決定每一幀都留的（`fullResAll`）不丟，播放才會像影片；
          // 攤開的幾張、鎖定的格子要的幀也留著（不然兩張攤開的影像互相丟對方的全解析度）
          if (frame === null || fullResAll.current.has(`${layer.contentRef}#${loadRun.current}`)) return;
          const keep = neededFullResFrames(snapshotRef.current.layers, snapshotRef.current.temporal, snapshotRef.current.viewportFrames).get(layer.contentRef) ?? new Set();
          for (const other of fetchedFullRes.current) {
            const m = other.match(/^(.*)#f(\d+)#(\d+)$/);
            if (m && m[1] === layer.contentRef && Number(m[2]) !== frame && !keep.has(Number(m[2]))) {
              commands.dropImageLod(layer.contentRef, 0, Number(m[2]));
              fetchedFullRes.current.delete(other);
            }
          }
        })
        .catch(() => fetchedFullRes.current.delete(key))
        .finally(() => fullResInflight.current.delete(key));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [snapshot.kernelReady, snapshot.layers, temporalKey, initialFetchDone, lockKey]);

  /**
   * 時間序列的每個相位先抓 lod 2（小、播放用）；從目前相位往後依序抓，抓完一個群組再換下一個。
   * 一個序列一次只跑一條（`prefetchingFrames`）；跑完就放掉 —— 圖層一變（例如把其他影像關掉、騰出全解析度的空位）
   * 再跑一次，已經在倉裡的幀直接跳過，被逐出的全解析度在這時補回來。
   */
  const prefetchingFrames = useRef(new Set<string>());
  /** 每個序列一幀全解析度的位元組數（抓過 lod 0 才知道）—— 決定全部幀能不能都留全解析度。 */
  const fullResBytes = useRef(new Map<string, number>());
  /** 這次載入裡「每一幀都留全解析度」的時間序列（`${seriesId}#${loadRun}`）；不在這裡的照舊只留目前那一幀。 */
  const fullResAll = useRef(new Set<string>());
  useEffect(() => {
    if (!snapshot.kernelReady || pendingFetch.current !== null || initialFetchRunning.current || caseLoading.current) return;
    for (const g of snapshot.temporal) {
      if (g.frameCount === null) continue;
      for (const seriesId of g.seriesIds) {
        // 攤開後同一個序列有好幾張（各自顯示／隱藏）—— 任何一張看得見就預抓
        const layer = snapshot.layers.find((l) => l.contentRef === seriesId && l.visible) ?? snapshot.layers.find((l) => l.contentRef === seriesId);
        const runKey = `${seriesId}#${loadRun.current}`;
        if (layer === undefined || !layer.visible || prefetchingFrames.current.has(runKey)) continue;
        prefetchingFrames.current.add(runKey);
        const run = loadRun.current;
        const count = g.frameCount;
        const start = g.cursor;
        const groupId = g.temporalGroupId;
        const imageBudget = budgetFor(session.tier?.assigned ?? 'A', session.seriesCount).imageBytes;
        const prefetchFrames = async (): Promise<void> => {
          const frames = Array.from({ length: count }, (_, i) => (start + i) % count);
          for (const f of frames) {
            if (run !== loadRun.current) return;
            if (commands.hasImage(seriesId, 2, f)) continue;
            try {
              await fetchVolume(transport, seriesId, 2, f);
            } catch {
              return; // 下次圖層一變再試
            }
          }
          // 每一幀的輪廓也先抓（可見的、這一幀有的），播放時輪廓跟著影像走，不是換幀才抓
          for (const f of frames) {
            if (run !== loadRun.current) return;
            for (const m of sessionRef.current.layers) {
              if (m.kind === 'mask' && m.visible && m.temporalGroupId === groupId) void ensureMask(transport, m, f);
            }
          }
          // 預算放得下 → 每一幀都抓全解析度並留著（像影片一樣播放）；放不下照舊（只有目前那一幀）
          // 已佔用只算現在真的有全解析度在倉裡的（被逐出、卸載的不算）
          const bytes = fullResBytes.current.get(seriesId);
          const used = [...fullResBytes.current.entries()].filter(([id]) => id !== seriesId && commands.hasFullResAnyFrame(id)).reduce((a, [, b]) => a + b, 0);
          if (bytes === undefined || !keepAllFramesFullRes(bytes, count, imageBudget, used)) {
            fullResAll.current.delete(runKey);
            return;
          }
          fullResAll.current.add(runKey);
          for (const f of frames) {
            if (run !== loadRun.current) return;
            if (commands.hasImage(seriesId, 0, f)) continue;
            const key = `${seriesId}#f${f}#${run}`;
            if (fullResInflight.current.has(key)) continue;
            // 全解析度上限已被別的可見序列佔滿 → 先不抓（抓了會逐出它們、它們再逐出這裡）；騰出空位時這裡會再跑
            if (!commands.canHoldFullRes(seriesId)) return;
            fetchedFullRes.current.add(key);
            fullResInflight.current.add(key);
            try {
              await fetchVolume(transport, seriesId, 0, f);
            } catch {
              fetchedFullRes.current.delete(key);
              return;
            } finally {
              fullResInflight.current.delete(key);
            }
          }
        };
        void prefetchFrames().finally(() => prefetchingFrames.current.delete(runKey));
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [snapshot.kernelReady, snapshot.layers, temporalKey, initialFetchDone]);

  /** 抓一個體積序列的某個 lod 進倉（影像 int16 或劑量 float32，依 header）。 */
  const fetchVolume = useCallback(
    async (client: TransportClient, seriesId: string, lod: number, frameIndex: number | null = null) => {
      const image = await client.fetchImage({ seriesId, lod, frameIndex });
      // 解壓後的 body 是一塊只屬於這次回應的新緩衝（zstd），直接留著；只有當它是
      // 訊框緩衝上的視圖（raw 編碼、與 header 共用一塊）才複製 —— 100 MB 的體積
      // 多複製一份就是多 100 MB 的瞬間壓力。
      const voxels = image.voxels.byteOffset === 0 && image.voxels.byteLength === image.voxels.buffer.byteLength
        ? image.voxels
        : image.header.dtype === 'float32'
          ? new Float32Array(image.voxels)
          : new Int16Array(image.voxels);
      if (lod === 0) fullResBytes.current.set(seriesId, voxels.byteLength);
      commands.putImage({
        seriesId,
        lod,
        frameIndex,
        grid: image.gridSet.grid,
        voxels,
        defaultWindow: {
          center: (image.header.default_window as number[])?.[0] ?? 40,
          width: (image.header.default_window as number[])?.[1] ?? 400,
        },
      });
    },
    [commands],
  );

  // 體素：ViewerHost 就緒後才抓
  useEffect(() => {
    const pending = pendingFetch.current;
    if (!snapshot.kernelReady || pending === null) return;
    pendingFetch.current = null;
    const { transport: client, volumeSeriesIds, layers, runId } = pending;
    // 這批體素屬於一次已被取代的載入 → 直接丟掉（見 load 的執行代號）
    if (runId !== loadRun.current) return;

    initialFetchRunning.current = true;
    void (async () => {
      try {
        // 每個體積先 lod=2 出畫面（primary 在前）
        // 時間序列先抓相位 0（其餘相位由預抓 effect 補）
        const frameZero = (seriesId: string): number | null => (layers.some((l) => l.contentRef === seriesId && l.temporalGroupId) ? 0 : null);
        // 劑量運算的暫存結果可能在載入途中被丟棄（404）—— 那一個跳過，不讓整個病例的體素載入失敗
        const tolerate = async (seriesId: string, p: Promise<void>): Promise<void> => {
          try {
            await p;
          } catch (e) {
            if (seriesId.startsWith('doseop_') && /\b404\b/.test(e instanceof Error ? e.message : String(e))) return;
            throw e;
          }
        };
        for (const seriesId of volumeSeriesIds) {
          if (runId !== loadRun.current) return;
          await tolerate(seriesId, fetchVolume(client, seriesId, 2, frameZero(seriesId)));
        }
        // 可見的再補 lod=0；隱藏的留在 lod 2，顯示時由下面的 effect 補
        const visible = new Set(
          layers.filter((l) => (l.kind === 'image' || l.kind === 'dose') && l.visible).map((l) => l.contentRef),
        );
        for (const seriesId of volumeSeriesIds.filter((id) => visible.has(id))) {
          if (runId !== loadRun.current) return;
          // 與下面「變成可見時補抓」的 effect 用同一把 key，否則同一份 lod 0 會被抓兩次
          const f0 = frameZero(seriesId);
          fetchedFullRes.current.add(`${seriesId}${f0 === null ? '' : `#f${f0}`}#${runId}`);
          await tolerate(seriesId, fetchVolume(client, seriesId, 0, f0));
        }
        // mask 只抓預設可見的；其餘由 ensureMask 在使用者打開時按需抓
        for (const layer of layers.filter((l) => l.kind === 'mask' && l.visible)) {
          await ensureMask(client, layer);
        }
        commands.render();
      } catch (error) {
        if (runId !== loadRun.current) return;
        const message = error instanceof Error ? error.message : String(error);
        // 🔴 I3（網格 id 過期）是**可回復**的 —— 後端的錯誤訊息本身就寫著
        // 「請重新 POST /grids」。客戶端該照做一次，而不是把畫面留在錯誤狀態。
        // 只重試一次：真的談不成就要讓使用者看到，不能無聲重試到永遠。
        if (/\bI3\b/.test(message) && !renegotiated.current) {
          renegotiated.current = true;
          setSession((prev) => ({ ...prev, error: null }));
          void load(null);
          return;
        }
        setSession((prev) => ({ ...prev, error: t('體素載入失敗：{message}', { message }) }));
      } finally {
        initialFetchRunning.current = false;
        // 初次抓取期間，相位預抓與「可見就補 lod 0」的 effect 會直接返回（看到 initialFetchRunning）；
        // 抓完要讓它們再跑一次 —— 否則從資料頁開 4D 病例（兩條載入鏈重疊）時其他相位永遠不會抓
        setInitialFetchDone((n) => n + 1);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [snapshot.kernelReady, session.gridSet]);

  /**
   * 場景走 HTTP 拿（`GET /sessions/{id}/scene`，跟 `scene.replace` 同形）—— 推送太大時伺服器改送
   * `{refetch: true}`、或推送根本沒到（WS 斷線）時用。拿不到就把原因顯示出來，不讓畫面默默停住。
   */
  const sceneSeq = useRef(0);
  /** 收到過幾則「病例變了」的推送（scene／layer／mask／結構集）—— 改了病例的操作之後拿來判斷推送有沒有到。 */
  const pushSeq = useRef(0);
  const applySceneRef = useRef<((scene: Record<string, unknown>) => void) | null>(null);
  const refetchScene = useCallback(async (): Promise<void> => {
    const sid = sessionRef.current.sessionId;
    if (sid === null) return;
    try {
      const scene = await transport.getJson<Record<string, unknown>>(`/sessions/${encodeURIComponent(sid)}/scene`);
      sceneSeq.current += 1;
      applySceneRef.current?.(scene);
    } catch (e) {
      setSession((prev) => ({ ...prev, error: t('畫面沒有更新（{p0}）；請重新整理頁面', { p0: backendMessage(e) }) }));
    }
  }, [transport]);
  /**
   * 改了病例的操作（組成／拆開／攤開）之後：後端推的 scene.replace 會更新畫面；1.5 秒內沒收到任何場景 → 自己走 HTTP 拿。
   * `before` 是送出請求**之前**的場景計數（推送可能比 HTTP 回應先到）。以前只在「時間軸換了」時才重載，
   * 攤開／收回（時間軸不變）推送沒到就停在原地。
   */
  const refetchSceneRef = useRef<(() => Promise<void>) | null>(null);
  refetchSceneRef.current = refetchScene;
  const syncSceneAfter = useCallback(
    (before: number): void => {
      window.setTimeout(() => {
        if (caseLoading.current || sceneSeq.current !== before) return;
        void refetchScene();
      }, 1500);
    },
    [refetchScene],
  );

  /**
   * 每一格鎖定的相位存在這個瀏覽器（依病例）。**使用者改的時候才寫**（`setViewportFrameSaved`）；
   * host 上的跟存的不一樣（新 host、重新載入、換版面後才建出來的格子）→ 套回存的。以前是「把 host 的狀態鏡射進儲存」，
   * 還原後 host 剛好重建一次，鎖定就丟了、還把存的清成空的。
   */
  const setViewportFrameSaved = useCallback(
    (viewportId: string, groupId: string, frame: number | null): void => {
      commands.setViewportFrame(viewportId, groupId, frame);
      const caseId = sessionRef.current.caseId;
      if (caseId === null) return;
      const all = readPhaseLocks(prefStorage, caseId);
      const cell = { ...(all[viewportId] ?? {}) };
      if (frame === null) delete cell[groupId];
      else cell[groupId] = frame;
      const next = { ...all, [viewportId]: cell };
      if (Object.keys(cell).length === 0) delete next[viewportId];
      writePhaseLocks(prefStorage, caseId, next);
    },
    [commands],
  );
  const temporalIdsKey = snapshot.temporal.map((g) => g.temporalGroupId).join('|');
  useEffect(() => {
    const caseId = session.caseId;
    if (!snapshot.kernelReady || caseId === null || snapshot.temporal.length === 0 || caseLoading.current) return;
    const groups = new Set(snapshot.temporal.map((g) => g.temporalGroupId));
    for (const [vp, locks] of Object.entries(readPhaseLocks(prefStorage, caseId))) {
      for (const [groupId, frame] of Object.entries(locks)) {
        if (groups.has(groupId) && snapshot.viewportFrames[vp]?.[groupId] === undefined) commands.setViewportFrame(vp, groupId, frame);
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [snapshot.kernelReady, session.caseId, temporalIdsKey, lockKey, initialFetchDone]);

  // Push 通道（含自動重連 —— chaos: disconnect 的對應行為）
  useEffect(() => {
    if (session.gridSet === null) return undefined;
    // 用自己的 session id 連（多人時 `current` 是別人的機率很高）
    const sid = session.sessionId ?? 'current';
    const url = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/api/v1/session/${encodeURIComponent(sid)}/events`;
    const applyScene = (scene: Record<string, unknown>): void => {
      // 🔴 `scene.replace` 若帶著**不同的網格**（驅動腳本 `s.load()` 換了病例、
      // 或資料頁在另一個分頁建了新 session），只換 layers 會讓下一次抓 mask 撞 409 I3。
      // 網格 id 變了就整條載入鏈重跑（沿用後端目前的 session）。
      const incoming = scene.gridSet as { display_grid?: { display_grid_id?: string } } | undefined;
      const incomingId = incoming?.display_grid?.display_grid_id;
      if (incomingId !== undefined && incomingId !== session.gridSet?.displayGrid.displayGridId) {
        void load(null);
        return;
      }
      // 時間軸組成／拆開了（同一個病例原地重組；網格可能沒變）→ host 的時間群組要重建 → 整條重載
      const incomingTemporal = (scene.gridSet as { temporal_groups?: { temporal_group_id: string }[] } | undefined)?.temporal_groups;
      if (incomingTemporal !== undefined && temporalSignature(incomingTemporal) !== temporalSignature((session.gridSet?.temporalGroups ?? []).map((g) => ({ temporal_group_id: g.temporalGroupId, frame_count: g.frameCount })))) {
        if (!caseLoading.current) void load(null);
        return;
      }
      const layers = (scene.layers as Record<string, unknown>[]).map((x) => fromWire.layer(x));
      const structureSets = structureSetsOf(scene.structureSets);
      // 提交對位後 FrameGroup 換了 —— 網格沒變，直接餵給 host，不重建
      if (incoming !== undefined) {
        const frameGroups = fromWire.gridSet(incoming).frameGroups;
        // 🔴 不改 `session.gridSet` —— 它的 identity 一變，useScene 就會整個重建 host
        //（體積全部重抓）。FrameGroup 的真相在 host；`state.frameGroups` 讀的是 snapshot。
        commands.setFrameGroups(frameGroups);
        setSession((prev) => ({ ...prev, layers, structureSets }));
        return;
      }
      setSession((prev) => ({ ...prev, layers, structureSets }));
    };
    applySceneRef.current = applyScene;
    const channel = new PushChannel(url, {
      // 伺服器因帳號失效關掉推送 → 重新確認登入狀態；真的失效就回登入頁（HTTP 401 同一條路）
      onAuthLost: () => {
        void authApi.status().then((st) => {
          if (st.mode === 'required' && st.user === null) {
            setUser(null);
            navigate('login');
          } else {
            setUser(st.user);
          }
        });
      },
      onScene: (scene) => {
        sceneSeq.current += 1;
        pushSeq.current += 1;
        // 太大推不過來 → 伺服器只送「去拿」的通知
        if (isSceneRefetch(scene)) void refetchScene();
        else applyScene(scene);
      },
      // 別的 client（或後處理）改了 mask → 丟掉本地那份，下次可見時重抓。
      // 2026-10-09：自己那筆的回音、或這個結構還有沒送完的編輯 → 不重抓（重抓會用後端舊版蓋掉還沒送出的筆畫）；
      // 忙的時候推來的若真是別人改的，送出佇列送完後經 `onRemoteMaskChange` 再叫重抓
      onMaskUpdated: (payload) => {
        pushSeq.current += 1;
        const structureId = String(payload.structureId);
        const frameIndex = payload.frameIndex ?? null;
        if (!commands.remoteMaskUpdate(structureId, frameIndex, String(payload.contentHash))) return;
        fetchedMasks.current.delete(`${structureId}@${frameIndex ?? 'static'}`);
        setSession((prev) => ({ ...prev, layers: [...prev.layers] }));
      },
      onLayer: (kind, layer) => {
        pushSeq.current += 1;
        setSession((prev) => ({
          ...prev,
          layers:
            kind === 'remove'
              ? prev.layers.filter((l) => l.layerId !== layer.layerId)
              : [...prev.layers.filter((l) => l.layerId !== layer.layerId), layer],
        }));
        // 別人簽核／改名推來的 `layer.update` 不帶 status，結構清單要重抓
        if (layer.layerId.startsWith('mask:')) void refreshStructures().catch(() => undefined);
      },
      // 誰在線；結構集變了（別人建了工作集、合併、改名）→ 重抓
      onPresence: (info) => setSession((prev) => ({ ...prev, presence: info.users })),
      onStructureSetsChanged: () => {
        pushSeq.current += 1;
        void refreshStructureSets().catch(() => undefined);
        void refreshStructures().catch(() => undefined);
      },
      // plugin 登錄／版本／停用變了 → 只標記，選單提示重新載入（不在頁內熱替換）
      onPluginsChanged: () => pluginCatalog.markStale(),
      // L0 節點回傳 → 事件進 Plugins 選單 ＋ 提示列（物件已在資料庫，到資料頭加入病例）
      onServiceReceived: (p) => {
        const what = joinList(p.received.map((r) => `${r.modality}×${r.count}`));
        pluginCatalog.addEvent(t('{p0} 回傳了 {what}，已進資料庫；到「資料庫…」把它加入病例', { p0: p.nodeName ?? p.nodeId ?? t('節點'), what }));
        setInfo(t('{p0} 回傳了 {what}，已進資料庫；到「資料庫…」把它加入病例', { p0: p.nodeName ?? t('節點'), what }));
      },
    });
    channel.connect();
    return () => channel.close();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session.gridSet]);

  // 版面換了 → 相機連動群跟著換（並排的兩格；2×2 沒有）
  useEffect(() => {
    commands.setCameraLinks(cameraLinkGroups(layout));
  }, [layout, commands, snapshot.kernelReady]);

  // ── presence「正在編輯哪個結構」—— 編輯工具作用中時回報作用中的結構，停 0.4 s 才送（換工具／換結構不連發）──
  const editingNow = isEditingTool(snapshot.activeToolId) ? (snapshot.activeStructureId ?? null) : null;
  const editingSent = useRef<{ sid: string | null; id: string | null }>({ sid: null, id: null });
  useEffect(() => {
    const sid = session.sessionId;
    if (!sid || session.closed) return undefined;
    if (editingSent.current.sid !== sid && editingNow === null) {
      editingSent.current = { sid, id: null }; // 新的 session 本來就是「沒在編輯」
      return undefined;
    }
    if (editingSent.current.sid === sid && editingSent.current.id === editingNow) return undefined;
    const timer = window.setTimeout(() => {
      editingSent.current = { sid, id: editingNow };
      transport.putJson(`/sessions/${encodeURIComponent(sid)}/editing`, { structure_id: editingNow }).catch(() => {
        editingSent.current = { sid: null, id: null }; // 下次變化再送（presence 是輔助資訊，不報錯）
      });
    }, 400);
    return () => window.clearTimeout(timer);
  }, [editingNow, session.sessionId, session.closed, transport]);

  // ── 登入後載入 plugin UI（bundle 經宿主代理 import()；沒有 bundle 的用宣告式面板）──
  useEffect(() => {
    if (user === null && route !== 'viewer') return;
    void installPluginUis();
  }, [user?.username, route === 'viewer']); // eslint-disable-line react-hooks/exhaustive-deps

  // ── 離開保護（在 `useLeaveGuard`）────────────────────────────────────────────────────────────────────────
  const { dirty, confirmLeave } = useLeaveGuard({ snapshot, session, user, route });

  // ── 組出 ViewerApi ─────────────────────────────────────────────────────────
  //
  // 🔴 **這是 `App` 的內部狀態與面板之間唯一的接縫。** 上面那些 `useState`
  // 想怎麼改都行，只要還能組出這個形狀；面板一個都不必動。

  // 見過的病例（資料庫建的 session 與 dicom: 目錄）。假體不再列在 UI 上：
  // 它們是測試資料來源，不是使用者要看的東西。
  const availableSources = useMemo<CaseSource[]>(
    () =>
      extraSources.map((id) => ({
        id,
        label: id.startsWith('library:') ? t('資料庫病例 …{p0}', { p0: id.slice(-8) }) : id.replace('dicom:', 'DICOM '),
      })),
    [extraSources],
  );

  // 量測圖層以 host 為真相（本地建的、以及 host 算好的 result／HU 統計）；其餘照後端
  const layersForPanels = useMemo(() => {
    const hostMeasurements = snapshot.layers.filter((l) => l.kind === 'measurement');
    if (hostMeasurements.length === 0 && !session.layers.some((l) => l.kind === 'measurement')) return session.layers;
    return [...session.layers.filter((l) => l.kind !== 'measurement'), ...hostMeasurements];
  }, [session.layers, snapshot.layers]);
  const state: ViewerState = {
    layers: layersForPanels,
    structures: session.structures,
    structureSets: withSetPermissions(session.structureSets, user ? { username: user.username, role: user.role } : null),
    usesStructureSets: session.usesStructureSets,
    presence: session.presence,
    seriesCount: session.seriesCount,
    tier: session.tier,
    assignedTier: session.tier?.assigned ?? 'A',
    resident: snapshot.resident,
    budgetBytes: snapshot.budgetBytes,
    quality: snapshot.quality,
    notices: snapshot.notices,
    substitutes: snapshot.substitutes,
    kernelReady: snapshot.kernelReady,
    kernelError: snapshot.kernelError,
    activeToolId: snapshot.activeToolId,
    brush: snapshot.brush,
    touch: snapshot.touch,
    formFactor,
    activeStructureId: snapshot.activeStructureId,
    editingBlockedReason: snapshot.editingBlockedReason,
    canUndo: snapshot.canUndo,
    canRedo: snapshot.canRedo,
    undoDepth: snapshot.undoDepth,
    undoBytes: snapshot.undoBytes,
    editsFlushed: snapshot.editsFlushed,
    submitFailures: snapshot.submitFailures,
    probe: snapshot.probe,
    // host 是唯一真相（後端推來新對位時它會換）；host 還沒建時退回 session 的那份
    frameGroups: snapshot.frameGroups.length > 0 ? snapshot.frameGroups : (session.gridSet?.frameGroups ?? []),
    transformOverrides: snapshot.transformOverrides,
    activeImageLayerId: snapshot.activeImageLayerId,
    disabledTransforms: snapshot.disabledTransforms,
    viewports: snapshot.viewports,
    slabOutlineSemantics: snapshot.slabOutlineSemantics,
    modes: snapshot.modes,
    layoutId,
    layout,
    selectedMeasurementId: snapshot.selectedMeasurementId,
    vertexEdit: snapshot.vertexEdit,
    measurementLabelHint: snapshot.measurementLabelHint,
    temporal: snapshot.temporal,
    viewportFrames: snapshot.viewportFrames,
    layoutHasOverrides: Object.keys(overrides[layoutId] ?? {}).length > 0 || trees[layoutId] !== undefined,
    layoutTree,
    modules,
    viewportHiddenLayers: snapshot.viewportHiddenLayers,
    caseId: session.caseId,
    studyId: session.studyId,
    maskLoading,
    frames: snapshot.frames,
    caseClosed: session.closed ? { label: session.closed.label, canReload: session.closed.selection !== null } : null,
    user: user ? { username: user.username, displayName: user.display_name, role: user.role } : null,
    source,
    availableSources,
    error: session.error,
  };

  // 側欄收合／專注影像（記在瀏覽器）
  const [collapsed, setCollapsed] = useState<CollapseState>(() => {
    try {
      return readCollapsed(localStorage.getItem(COLLAPSE_STORAGE_KEY));
    } catch {
      return { left: false, right: false };
    }
  });
  const rememberedCollapse = useRef<CollapseState | null>(null);
  /** 偏好載入後 +1 —— 在掛載時讀 localStorage 的元件（側欄寬度、密度）以它當 key 重掛。 */
  const [prefsEpoch, setPrefsEpoch] = useState(0);
  // 側欄面板的擺法（哪一側、順序、摺起來）
  const [dock, setDockState] = useState<DockState>(() => {
    try {
      return parseDock(localStorage.getItem(DOCK_STORAGE_KEY));
    } catch {
      return parseDock(null);
    }
  });
  const setDock = useCallback((next: DockState) => {
    setDockState(next);
    savePref(DOCK_STORAGE_KEY, serializeDock(next));
  }, []);
  /** 帳號偏好寫進 localStorage 之後，把 App 層從 localStorage 初始化的狀態重讀一次（檢視器的元件之後才掛）。 */
  const reloadPrefsIntoState = (): void => {
    setPrefsEpoch((n) => n + 1);
    applyIsodoseDefault(); // 等劑量線預設（核心的 doseDisplayOf 不碰 localStorage）
    try {
      setOverrides(parseOverrides(localStorage.getItem(LAYOUT_OVERRIDES_STORAGE_KEY)));
      setTrees(parseTrees(localStorage.getItem(LAYOUT_TREES_STORAGE_KEY)));
      setCollapsed(readCollapsed(localStorage.getItem(COLLAPSE_STORAGE_KEY)));
      setDockState(parseDock(localStorage.getItem(DOCK_STORAGE_KEY)));
    } catch {
      /* 私密視窗 */
    }
    setLayoutIdState(readCurrentLayoutId());
  };
  const persistCollapsed = (next: CollapseState): void => {
    try {
      savePref(COLLAPSE_STORAGE_KEY, JSON.stringify(next));
    } catch {
      /* 私密視窗 */
    }
  };
  const toggleSide = useCallback((side: 'left' | 'right') => {
    setCollapsed((prev) => {
      const next = { ...prev, [side]: !prev[side] };
      persistCollapsed(next);
      return next;
    });
  }, []);
  const toggleFocusMode = useCallback(() => {
    setCollapsed((prev) => {
      const r = toggleFocus(prev, rememberedCollapse.current);
      rememberedCollapse.current = r.remembered;
      persistCollapsed(r.state);
      return r.state;
    });
  }, []);
  // 最近一次確定寫進後端的時間 —— 佇列清空、或任何寫入後重抓結構清單
  const [lastSavedAt, setLastSavedAt] = useState<number | null>(null);
  const prevFlushed = useRef<boolean>(true);
  useEffect(() => {
    const flushed = snapshot.editsFlushed;
    if (flushed && !prevFlushed.current && snapshot.submitFailures.length === 0) setLastSavedAt(Date.now());
    prevFlushed.current = flushed;
  }, [snapshot.editsFlushed, snapshot.submitFailures.length]);
  const refreshStructures = useCallback(async () => {
    const structures = (await transport.fetchStructures()).map(structureMetaOf);
    setSession((prev) => ({ ...prev, structures }));
    // 清單裡有、圖層裡沒有（新建／合併的 layer.add 沒推到）→ 1.5 秒後還缺就走 HTTP 拿場景
    window.setTimeout(() => {
      const have = new Set(sessionRef.current.layers.filter((l) => l.kind === 'mask').map((l) => l.contentRef));
      if (!caseLoading.current && sessionRef.current.structures.some((st) => !have.has(st.structureId))) void refetchSceneRef.current?.();
    }, 1500);
  }, [transport]);
  const markSaved = useCallback(() => setLastSavedAt(Date.now()), []);
  // 結構集清單（含工作集）—— `GET /cases/{id}/structure-sets`
  const refreshStructureSets = useCallback(async () => {
    const caseId = sessionRef.current.caseId;
    if (!caseId) return;
    const raw = await transport.getJson<unknown>(`/cases/${encodeURIComponent(caseId)}/structure-sets`);
    setSession((prev) => ({ ...prev, structureSets: structureSetsOf(raw) }));
  }, [transport]);
  /**
   * 改了病例的操作（新建／刪除／複製／合併結構、ITV、對位、簽核、劑量運算…）之後，推送（layer.add、scene.replace…）
   * 1.5 秒內一則都沒到 → 自己走 HTTP 拿場景、結構清單、結構集（WS 斷線、推送掉了也不會停在舊畫面）。
   * 以前只有時間軸的四個操作有這條退路。
   */
  const expectPush = useCallback(
    (before: number): void => {
      window.setTimeout(() => {
        if (caseLoading.current || pushSeq.current !== before) return;
        void refetchSceneRef.current?.();
        void refreshStructures().catch(() => undefined);
        void refreshStructureSets().catch(() => undefined);
      }, 1500);
    },
    [refreshStructures, refreshStructureSets],
  );
  const withPush = useCallback(
    async <T,>(fn: () => Promise<T>): Promise<T> => {
      const before = pushSeq.current;
      const out = await fn();
      expectPush(before);
      return out;
    },
    [expectPush],
  );

  const pendingActive = useRef<{ id: string; prev: string | null; until: number } | null>(null);
  const activeStructureRef = useRef<string | null>(null);
  activeStructureRef.current = snapshot.activeStructureId;
  useEffect(() => {
    const p = pendingActive.current;
    if (p === null) return;
    const active = snapshot.activeStructureId;
    if (active === p.id || Date.now() > p.until || (active !== null && active !== p.prev)) {
      pendingActive.current = null;
      return;
    }
    if (commands.setActiveStructure(p.id).ok) pendingActive.current = null;
  }, [snapshot, commands]);

  // 已簽核的結構對編輯工具唯讀（後端也擋 409 APPROVED_LOCKED）；
  // 匯入集與別人的工作集也唯讀（後端擋 403），原因帶到工具的停用說明
  useEffect(() => {
    commands.setLockedStructures(lockedEntries(session.structures));
  }, [commands, session.structures]);

  const apiCommands = useMemo<ViewerCommands>(
    () => ({
      refreshStructures,
      refreshStructureSets,
      setTouchWindowLevel: commands.setTouchWindowLevel,
      setFingerDraws: commands.setFingerDraws,
      toolAction: commands.toolAction,
      setVisible: commands.setVisible,
      setGroupVisible: commands.setGroupVisible,
      setOpacity: commands.setOpacity,
      setRenderStyle: commands.setRenderStyle,
      setWindowLevel: commands.setWindowLevel,
      setColormap: commands.setColormap,
      setBlendMode: commands.setBlendMode,
      setLayerParams: commands.setLayerParams,
      setActiveImageLayer: commands.setActiveImageLayer,
      setTransformEnabled: commands.setTransformEnabled,
      setFrameGroupTransform: commands.setFrameGroupTransform,
      currentTransformToPrimary: commands.currentTransformToPrimary,
      submitFrameGroupTransform: async (uid) => {
        const fgs = commands.currentFrameGroups();
        const fg = fgs.find((f) => f.frameOfReferenceUid === uid);
        const primary = fgs.find((f) => f.role === 'primary');
        const matrix = commands.transformOverrideFor(uid);
        if (!fg || !primary || matrix === null) return;
        await withPush(() =>
          transport.createTransform({
            matrixColumnMajor: matrix,
            fixedSeriesId: primary.seriesId,
            movingSeriesId: fg.seriesId,
            applyToFrameGroup: true,
            description: t('檢視器對位微調'),
          }),
        );
        // 後端會推 scene.replace（帶新的 frameGroups）→ onScene → setFrameGroups 清掉覆寫
      },
      setToolParams: commands.setToolParams,
      seriesGridCenter: commands.seriesGridCenter,
      seriesGridBounds: commands.seriesGridBounds,
      seriesHistogram: commands.seriesHistogram,
      setSlabThickness: commands.setSlabThickness,
      setSlabOutlineSemantics: commands.setSlabOutlineSemantics,
      rotateViewport: commands.rotateViewport,
      resetOrientation: commands.resetOrientation,
      // 任務模式互斥 —— 開 ROI 就關掉量測／簽核／匯出／對位；檢視模式（MPR／DVH／3D）不受影響
      setMode: (id, enabled) => {
        for (const c of modeChanges(snapshot.modes, id, enabled)) commands.setMode(c.id, c.enabled);
      },
      setLayout: (id) => setLayoutId(hasLayout(id) ? id : DEFAULT_LAYOUT_ID),
      setCellContent: (cellId, content) => {
        const current = { ...(overrides[layoutId] ?? {}) };
        if (content === null) delete current[cellId];
        else current[cellId] = content;
        const next = { ...overrides };
        if (Object.keys(current).length === 0) delete next[layoutId];
        else next[layoutId] = current;
        updateOverrides(next);
      },
      resetLayoutOverrides: () => {
        const next = { ...overrides };
        delete next[layoutId];
        updateOverrides(next);
        const nextTrees = { ...trees };
        delete nextTrees[layoutId];
        updateTrees(nextTrees);
      },
      splitCell: (cellId, dir) => {
        if (layoutTree === null) return;
        const source = layout.cells.find((c) => c.cellId === cellId);
        if (source === undefined) return;
        const id = newCellId(treeCellIds(layoutTree));
        // 新格內容同原格，但不跟相機連動（連動群是具名版面設計好的）
        const content = source.content.kind === 'viewport' ? { kind: 'viewport' as const, orientation: source.content.orientation, ...(source.content.is3D ? { is3D: true } : {}) } : source.content;
        updateOverrides({ ...overrides, [layoutId]: { ...(overrides[layoutId] ?? {}), [id]: content } });
        updateTrees({ ...trees, [layoutId]: splitCell(layoutTree, cellId, dir, id) });
      },
      closeCell: (cellId) => {
        if (layoutTree === null || treeCellIds(layoutTree).length <= 1) return;
        updateTrees({ ...trees, [layoutId]: removeCell(layoutTree, cellId) });
        const current = { ...(overrides[layoutId] ?? {}) };
        if (cellId in current) {
          delete current[cellId];
          const next = { ...overrides };
          if (Object.keys(current).length === 0) delete next[layoutId];
          else next[layoutId] = current;
          updateOverrides(next);
        }
      },
      resizeLayout: (path, sizes) => {
        if (layoutTree === null) return;
        updateTrees({ ...trees, [layoutId]: setSplitSizes(layoutTree, path, sizes) });
      },
      setModuleState: (moduleId, patch) =>
        setModules((prev) => ({ ...prev, [moduleId]: { ...(prev[moduleId] ?? {}), ...patch } })),
      selectMeasurement: commands.selectMeasurement,
      updateMeasurement: commands.updateMeasurement,
      removeMeasurement: commands.removeMeasurement,
      addMeasurement: commands.addMeasurement,
      addLandmarkPair: (a) => commands.addLandmarkPair({ movingFrameOfReferenceUid: a.movingFrameOfReferenceUid, moving: [a.moving[0], a.moving[1], a.moving[2]], fixed: [a.fixed[0], a.fixed[1], a.fixed[2]], label: a.label }),
      worldToFrame: (uid, w) => commands.worldToFrame(uid, [w[0], w[1], w[2]]),
      moveCrosshair: (w) => commands.moveCrosshair([w[0], w[1], w[2]]),
      beginVertexEdit: commands.beginVertexEdit,
      setMeasurementLabelHint: commands.setMeasurementLabelHint,
      setTemporalFrame: commands.setTemporalFrame,
      setViewportFrame: setViewportFrameSaved,
      // 後端原地重組 → 推 scene.replace（時間軸變了 onScene 會整條重載）；
      // 推送沒到（WS 斷線）就自己重載
      composeTemporal: async ({ seriesUids, labels, axis, resample }) => {
        const before = sceneSeq.current;
        await transport.postJson(`/studies/${encodeURIComponent(sessionRef.current.studyId ?? '')}/temporal-groups`, { series_uids: seriesUids, labels, axis, ...(resample ? { resample: true } : {}) });
        syncSceneAfter(before);
      },
      setTemporalResample: async (groupId, enabled) => {
        const before = sceneSeq.current;
        await transport.postJson(`/studies/${encodeURIComponent(sessionRef.current.studyId ?? '')}/temporal-groups/${encodeURIComponent(groupId)}/resample`, { enabled });
        syncSceneAfter(before);
      },
      dissolveTemporal: async (groupId) => {
        const before = sceneSeq.current;
        await transport.deleteJson(`/studies/${encodeURIComponent(sessionRef.current.studyId ?? '')}/temporal-groups/${encodeURIComponent(groupId)}`);
        syncSceneAfter(before);
      },
      setTemporalView: async (groupId, mode) => {
        const before = sceneSeq.current;
        await transport.postJson(`/studies/${encodeURIComponent(sessionRef.current.studyId ?? '')}/temporal-groups/${encodeURIComponent(groupId)}/view`, { mode });
        syncSceneAfter(before);
      },
      crosshairWorld: commands.crosshairWorld,
      stepTemporal: commands.stepTemporal,
      setTemporalPlayback: commands.setTemporalPlayback,
      temporalCurve: (seriesId, world) => commands.temporalCurve(seriesId, world ? [world[0], world[1], world[2]] : undefined),
      endVertexEdit: commands.endVertexEdit,
      highlightVertex: commands.highlightVertex,
      setMeasurementOptions: commands.setMeasurementOptions,
      keyDown: commands.keyDown,
      // ── ROI 編輯：後端為真相，改完重抓結構清單；圖層由 layer.* 推送更新
      createStructure: async ({ name, colorRgb, frameOfReferenceUid, structureSetId }) => {
        const gridSet = session.gridSet;
        const primary = gridSet?.frameGroups.find((f) => f.role === 'primary');
        const uid = frameOfReferenceUid ?? primary?.frameOfReferenceUid ?? '';
        const maskGridId = gridSet ? maskGridOf(gridSet, uid).maskGridId : '';
        // 這個 FoR 的影像是時間軸（4DCT）→ 新結構只屬於目前那一幀。
        // 最後按過的格子鎖了相位 → 那一幀；攤開時 → 作用中的那一張（游標跟著它）
        const image = session.layers.find((l) => l.kind === 'image' && l.frameOfReferenceUid === uid && l.temporalGroupId);
        const frameIndex = image?.temporalGroupId ? commands.drawingFrame(image.temporalGroupId) : null;
        const out = await withPush(() => transport.createStructure({ name, colorRgb, frameOfReferenceUid: uid, maskGridId, structureSetId: structureSetId ?? null, frameIndex }));
        // 新結構的圖層與（空的）體素到了才能設成編輯對象 —— 推送慢的時候（CI 實測）面板緊接著的
        // setActiveStructure 會失敗、筆刷一直沒有對象。到了就自動補設（15 秒內；使用者先選了別的就不搶）。
        pendingActive.current = { id: out.structureId, prev: activeStructureRef.current, until: Date.now() + 15000 };
        await refreshStructures();
        markSaved();
        return { structureId: out.structureId, tg263Suggestion: out.tg263Suggestion };
      },
      updateStructureMeta: async (structureId, patch) => {
        await withPush(() => transport.updateStructure(structureId, patch));
        await refreshStructures();
        markSaved();
      },
      deleteStructure: async (structureId) => {
        await withPush(() => transport.deleteStructure(structureId));
        fetchedMasks.current.delete(`${structureId}@static`);
        fetchedMasks.current.delete(`${structureId}@0`);
        commands.setActiveStructure(null);
        await refreshStructures();
      },
      duplicateStructure: async (structureId) => {
        const out = await withPush(() => transport.copyStructure(structureId));
        await refreshStructures();
        return out;
      },
      mergeFrameStructures: async (structureIds, name) => {
        const out = await withPush(() => transport.mergeFrameStructures(sessionRef.current.studyId ?? '', structureIds, name));
        await refreshStructures();
        return { structureId: out.structureId };
      },
      propagateStructureFrames: async (structureId, args) => {
        const local = commands.maskEntry(structureId, args.sourceFrame);
        const out = await withPush(() => transport.propagateFrames(structureId, { ...args, ...(local?.contentHash ? { baseContentHash: local.contentHash } : {}) }));
        // 蓋掉的幀：本地那份作廢（推送的 mask.updated 也會做；這裡先清，免得推送比回應晚）
        for (const f of out.replaced) fetchedMasks.current.delete(`${structureId}@${f}`);
        await refreshStructures();
        return out;
      },
      createItv: async (args) => {
        const out = await withPush(() => transport.createItv(sessionRef.current.studyId ?? '', args));
        await refreshStructures();
        return out;
      },
      drawingFrame: (groupId) => commands.drawingFrame(groupId),
      retryUnsaved: (structureId, frameIndex) => commands.retrySubmit(structureId, frameIndex),
      jumpToUnsaved: (structureId, frameIndex) => {
        const c = commands.unsavedCenter(structureId, frameIndex);
        if (c === null) return false;
        commands.moveCrosshair(c);
        return true;
      },
      discardUnsaved: (structureId, frameIndex) => {
        if (!commands.discardUnsaved(structureId, frameIndex)) return false;
        // 取回後端版本：本地那份作廢 → 下一輪抓 mask 時重抓（跟真衝突同一條路）
        fetchedMasks.current.delete(`${structureId}@${frameIndex ?? 'static'}`);
        setSession((prev) => ({ ...prev, layers: [...prev.layers] }));
        return true;
      },
      runPostprocess: async (structureId, op, params) => {
        const layer = session.layers.find((l) => l.kind === 'mask' && l.contentRef === structureId);
        const frameIndex = layer ? commands.frameOf(layer) : null;
        const local = commands.maskEntry(structureId, frameIndex);
        const meta = session.structures.find((s) => s.structureId === structureId) as (StructureMeta & { contentHash?: string }) | undefined;
        const baseContentHash = local?.contentHash ?? meta?.contentHash ?? '';
        const maskGridId = layer ? maskGridIdFor(layer.frameOfReferenceUid) : undefined;
        const payload = await transport.postprocess({ structureId, op, params, baseContentHash, frameIndex, ...(maskGridId ? { maskGridId } : {}) });
        commands.replaceMask({
          structureId,
          frameIndex: payload.frameIndex,
          offsetIjk: payload.offsetIjk,
          sizeIjk: payload.sizeIjk,
          voxels: new Uint8Array(payload.voxels),
          contentHash: payload.contentHash,
          label: op,
        });
        fetchedMasks.current.add(`${structureId}@${frameIndex ?? 'static'}`);
        await refreshStructures();
        markSaved();
      },
      listOps: async () =>
        (await transport.listOps()).map((o) => ({
          op: String(o['op']),
          label: typeof o['label'] === 'string' ? o['label'] : String(o['op']),
          description: typeof o['description'] === 'string' ? o['description'] : '',
          paramsSchema: (o['params_schema'] as Record<string, unknown>) ?? {},
        })),
      probeVoxel: commands.probeVoxel,
      viewportCameras: commands.viewportCameras,
      setViewportHiddenLayers: commands.setViewportHiddenLayers,
      setActiveTool: commands.setActiveTool,
      setBrush: commands.setBrush,
      setActiveStructure: commands.setActiveStructure,
      undo: commands.undo,
      redo: commands.redo,
      zoom: commands.zoom,
      fit: commands.fit,
      actualSize: commands.actualSize,
      zoomFactor: commands.zoomFactor,
      sliceLabel: commands.sliceLabel,
      render: commands.render,
      repaintOverlays: commands.repaintOverlays,
      setEditableBox: commands.setEditableBox,
      loadCase: (next) => {
        // 未提交、失敗、未保存 plugin 結果 → 同一個判斷、同一句話
        if (!confirmLeave(t('切換病例'))) return;
        disposeModules(); // 模組的 onDispose（plugin 清 painter／訂閱）
        void load(next);
      },
      reloadCase: () => {
        if (!confirmLeave(t('重新載入'))) return;
        disposeModules();
        void load(null);
      },
      closeCase: () => {
        if (!confirmLeave(t('關閉病例'))) return;
        disposeModules();
        const sid = session.sessionId;
        const label = caseSummaryOf(session.layers, session.gridSet?.frameGroups ?? [])?.text ?? source;
        const release = sid ? transport.postJson<{ selection?: Record<string, unknown> | null }>(`/sessions/${encodeURIComponent(sid)}/release`, {}) : Promise.resolve({ selection: null });
        void release
          .catch(() => ({ selection: null }))
          .then((rel) => {
            fetchedMasks.current.clear();
            transport.useSession(null);
            setSession({
              sessionId: null,
              caseId: null,
              studyId: null,
              gridSet: null, // → useScene 的 effect 清掉 host（wasm volumes、快取、canvas）
              layers: [],
              structures: [],
              structureSets: [],
              usesStructureSets: false,
              presence: [],
              tier: null,
              seriesCount: 1,
              error: null,
              closed: { selection: rel.selection ?? null, label },
            });
          });
      },
      reopenCase: () => {
        const closed = session.closed;
        if (closed === null) return;
        if (closed.selection === null) {
          navigate('library');
          return;
        }
        // 後端的病例可能已從記憶體淘汰：同一個 selection 再 POST /sessions 會從 DB／檔案重建（case_reused）
        void transport
          .postJson('/sessions', { ...closed.selection, client_capability: capabilityRef.current ?? null })
          .then(() => load(null))
          .catch((e: unknown) => setSession((prev) => ({ ...prev, error: t('重新載入失敗：{p0}', { p0: e instanceof Error ? e.message : String(e) }) })));
      },
      openShortcuts: () => setShortcutsOpen((v) => !v),
      startTour: (kind) => {
        setShortcutsOpen(false);
        setTourOpen(kind ?? 'feature');
      },
      dropHiddenVolumes: () => {
        let imageBytes = 0;
        let maskBytes = 0;
        let count = 0;
        for (const layer of session.layers) {
          if (layer.visible) continue;
          if (layer.kind === 'image' || layer.kind === 'dose') {
            const b = commands.dropImageLod(layer.contentRef, 0);
            if (b > 0) {
              imageBytes += b;
              count += 1;
            }
          } else if (layer.kind === 'mask') {
            const frameIndex = commands.frameOf(layer);
            const b = commands.dropMaskVoxels(layer.contentRef, frameIndex);
            if (b > 0) {
              maskBytes += b;
              count += 1;
              fetchedMasks.current.delete(`${layer.contentRef}@${frameIndex ?? 'static'}`);
            }
          }
        }
        return { imageBytes, maskBytes, count };
      },
      setError: (message) => setSession((prev) => ({ ...prev, error: message })),
      setNotice: (message) => setInfo(message),
    }),
    [commands, load, transport, maskGridIdFor, overrides, layoutId, updateOverrides, trees, updateTrees, layoutTree, layout, refreshStructures, refreshStructureSets, markSaved, setLayoutId, confirmLeave, snapshot.modes, session.gridSet, session.layers, session.structures, session.sessionId, session.closed, source, syncSceneAfter, setViewportFrameSaved, withPush],
  );

  // 全域鍵 —— 工具字母鍵、Ctrl+Z／Y、?（文字輸入中不攔；對話框開著只處理 ?）
  useEffect(() => {
    if (route !== 'viewer') return undefined;
    const onKey = (e: KeyboardEvent): void => {
      const action = resolveGlobalKey(keyEventOf(e), listTools());
      if (action === null) return;
      if (action.kind === 'help') {
        e.preventDefault();
        setShortcutsOpen((v) => !v);
        return;
      }
      if (document.querySelector('[role="dialog"]') !== null || tourOpen) return;
      if (action.kind === 'undo') commands.undo();
      else if (action.kind === 'redo') commands.redo();
      else if (session.gridSet !== null) commands.setActiveTool(action.toolId);
      else return;
      e.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [route, commands, session.gridSet, tourOpen]);
  // 第一次載入病例自動開導覽（可跳過；之後從說明選單重看）
  useEffect(() => {
    if (route !== 'viewer' || session.gridSet === null || !snapshot.kernelReady || phone) return;
    if (tourDone(typeof localStorage === 'undefined' ? null : localStorage)) return;
    const t = window.setTimeout(() => setTourOpen('feature'), 800);
    return () => window.clearTimeout(t);
  }, [route, session.gridSet, snapshot.kernelReady, phone]);

  const http = useMemo<ModuleHttp>(
    () => ({
      getJson: (path) => transport.getJson(path),
      // 面板改病例的請求（結構、結構集、簽核、劑量運算…）也有「推送沒到就自己拿」的退路
      postJson: (path, body) => (isCaseMutation(path) ? withPush(() => transport.postJson(path, body)) : transport.postJson(path, body)),
      patchJson: (path, body) => (isCaseMutation(path) ? withPush(() => transport.patchJson(path, body)) : transport.patchJson(path, body)),
      deleteJson: (path) => (isCaseMutation(path) ? withPush(() => transport.deleteJson(path)) : transport.deleteJson(path)),
      render3d: async (payload) => {
        const ref = await transport.fetchRender3d(payload);
        const data = ref.data as { header: Record<string, unknown>; png: Uint8Array };
        return { header: data.header, png: data.png };
      },
    }),
    [transport, withPush],
  );
  const api: ViewerApi = { state, commands: apiCommands, overlay: overlays, http };

  return (
    <ViewerApiProvider value={api}>
      {formFactor !== 'desktop' && <TouchTitles />}
      {/* 臨時密碼登入 → 先改密碼（不能關；伺服器也擋其他 API） */}
      {user?.must_change_password && route !== 'login' && <ChangePasswordDialog user={user} forced onDone={setUser} />}
      {/* 容量超過門檻，所有頁面頂端提醒 */}
      {route !== 'login' && (authMode === 'off' || user !== null) && <StorageBanner />}
      {route === 'login' ? (
        <LoginPage
          onLoggedIn={() => {
            void authApi.status().then(async (st) => {
              if (st.mode === 'required' && st.user !== null && (await loadPrefs())) reloadPrefsIntoState();
              setAuthMode(st.mode);
              setUser(st.user);
            });
          }}
        />
      ) : route === 'admin' ? (
        <Suspense fallback={<PageLoading />}>
          <AdminPage user={user} />
        </Suspense>
      ) : route === 'help' ? (
        <Suspense fallback={<PageLoading />}>
          <HelpPage />
        </Suspense>
      ) : route === 'trash' ? (
        <Suspense fallback={<PageLoading />}>
          <TrashPage user={user} />
        </Suspense>
      ) : route === 'archive' ? (
        <Suspense fallback={<PageLoading />}>
          <ArchivePage user={user} />
        </Suspense>
      ) : route === 'exports' ? (
        <Suspense fallback={<PageLoading />}>
          <ExportRecordsPage user={user} />
        </Suspense>
      ) : route === 'library' ? (
        <DataPage user={user} onLoggedOut={() => setUser(null)} />
      ) : (
      <div className={phone ? 'app app-phone' : 'app'}>
        <header className="app-header">
          <BrandMenu user={user} section={t('檢視器')} />
          <CaseSummaryBadge api={api} />
          <span className="header-status">
            <EditTargetBadge api={api} />
            <SaveStatusBadge api={api} lastSavedAt={lastSavedAt} />
          </span>
          <UserBadge user={user} onLoggedOut={() => setUser(null)} beforeLogout={() => confirmLeave(t('登出'))} onUserChanged={setUser} />
        </header>
        {phone ? <PhoneViewBar api={api} /> : <TaskBar key={`taskbar-${prefsEpoch}`} api={api} collapsed={collapsed} onToggleSide={toggleSide} onToggleFocus={toggleFocusMode} />}
        {shortcutsOpen && <ShortcutsDialog onClose={() => setShortcutsOpen(false)} onStartTour={() => apiCommands.startTour()} />}
        {tourOpen && (
          <TourOverlay
            {...(tourOpen === 'draw' ? { steps: TASK_DRAW_STEPS, title: t('任務：畫一個結構') } : {})}
            onFinish={() => {
              setTourOpen(false);
              markTourDone(prefStorage);
            }}
          />
        )}

        {session.error !== null && <p className="error">{session.error}</p>}
        {dirty !== null && snapshot.submitFailures.length + (snapshot.editsFlushed ? 0 : 1) > 0 && (
          <p className="notice notice-dirty" role="status" title={t('關頁、切病例、登出前都會再確認；瀏覽器的原生對話框無法自訂文字，所以先在這裡說清楚')}>
            {t('{dirty}——離開前請等它送完或處理失敗的筆數。', { dirty })}
          </p>
        )}
        {info !== null && (
          <p className="notice">
            {info}{' '}
            <button type="button" className="linkish" onClick={() => setInfo(null)}>
              {t('關閉')}
            </button>
          </p>
        )}

        <DockProvider dock={dock} setDock={setDock}>
        <div className="app-body">
          {!phone && <Sidebar key={`left-${prefsEpoch}`} side="left" slot="left-sidebar" collapsed={collapsed.left} onExpand={() => toggleSide('left')} />}
          {session.closed ? (
            <CaseClosedPane label={session.closed.label} canReload={session.closed.selection !== null} onReload={apiCommands.reopenCase} onLibrary={() => navigate('library')} />
          ) : (
          <ViewportArea
            layout={layout}
            tree={layoutTree}
            kernelReady={snapshot.kernelReady}
            kernelError={snapshot.kernelError}
            tier={state.assignedTier}
            zoomFactor={commands.zoomFactor}
            sliceLabel={commands.sliceLabel}
            sliceNav={commands.sliceNav}
            onScrubSlice={commands.scrubSlice}
            onStepSlice={commands.stepSlice}
            onZoom={commands.zoom}
            onFit={commands.fit}
            onActualSize={commands.actualSize}
            onAttach={commands.attachViewport}
            onDetach={commands.detachViewport}
            onKey={commands.keyDown}
          />
          )}
          {!phone && <Sidebar key={`right-${prefsEpoch}`} side="right" slot="right-sidebar" collapsed={collapsed.right} onExpand={() => toggleSide('right')} />}
        </div>
        </DockProvider>

        {phone && <PhoneToolRow api={api} />}
        <PanelSlot name="bottom" className="bottom-panels" />
        {phone && <PhoneTabs api={api} />}
      </div>
      )}
    </ViewerApiProvider>
  );
}
