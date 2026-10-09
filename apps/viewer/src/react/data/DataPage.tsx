/**
 * 資料頁 —— `#/library`。取代舊的 `LibraryPage`。
 *
 * 四層懶載入樹：
 * Patient › Study › 影像 Series › { RTSTRUCT | RTPLAN ▸ RTDOSE | 孤兒 RTDOSE | REG }，
 * 搜尋結果**仍是這棵樹**，命中的路徑自動展開、命中列標亮。
 *
 * 純邏輯在 `tree.ts`（樹狀態）與 `selection.ts`（選取）、fetch 在 `catalogApi.ts`；這個檔案只有版面與載入編排。
 * 🔴 預設不顯示 PatientName —— 後端根本不送，除非 `--show-patient-names`。
 */

import { BrandMenu } from '../components/AppNav';
import { TASK_OPEN_STEPS } from '../help/tour';
import { TourOverlay } from '../help/TourOverlay';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { navigate } from '../hooks/useHashRoute';
import { UserBadge } from '../auth/UserBadge';
import type { Principal } from '../auth/authApi';
import { ImportPanel } from './ImportPanel';
import { SendDialog } from './SendDialog';
import { DeleteDialog } from './DeleteDialog';
import type { DeleteTarget } from './deleteModel';
import type { SendTarget } from '../dimse/model';
import { useViewerApi } from '../panels/context';
import {
  catalogApi,
  createSession,
  EMPTY_FILTERS,
  hasAnyFilter,
  type Filters,
  type ImageRow,
  type LibrarySummary,
  type PatientRow,
  type RtRow,
  type SeriesDetail,
  type StudyRow,
  type WorklistCase,
} from './catalogApi';
import { quickOpenChoice } from './quickOpen';
import { useFormFactor } from '../device/useFormFactor';
import { WorklistPanel } from './WorklistPanel';
import { caseByStudy, STATUS_LABEL } from './worklist';
import {
  addSeries,
  EMPTY_SELECTION,
  estimateBytes,
  formatBytes,
  canOpenSeries,
  formatDicomDate,
  isSelected,
  selectionProblems,
  selectionSummary,
  dependencyHint,
  seriesSummary,
  setPrimary,
  toDicomDate,
  toggleSeries,
  toSessionRequest,
  type LibrarySeries,
  type Selection,
} from './selection';
import {
  clearChildren,
  EMPTY_TREE,
  expandable,
  expandMany,
  expandedTargets,
  flatten,
  imageKey,
  isExpanded,
  keysForHit,
  loadedSeries,
  patientKey,
  setError,
  setLoading,
  studyKey,
  toggleExpanded,
  withRt,
  withSeries,
  withStudies,
  type FlatRow,
  type NodeKey,
  type TreeState,
} from './tree';
import { dynamicBadge, dynamicTitle, groupNote, groupState, groupTitle as temporalGroupTitle, isMerged, memberBadge, setMerged, toggleGroup } from './temporalRows';
import type { TemporalCandidate } from './catalogApi';
import { joinClauses, joinList, msg, t } from '../../core/i18n';
import { savePref } from '../prefs/prefs';
import { copyText } from '../components/copyText';

const MODALITY_CHIPS = ['CT', 'MR', 'PT', 'RTSTRUCT', 'RTDOSE', 'RTPLAN', 'REG'];
const HAS_CHIPS: readonly { key: string; label: string }[] = [
  { key: 'rs', label: msg('有結構集') },
  { key: 'dose', label: msg('有劑量') },
  { key: 'reg', label: msg('有對位') },
  { key: 'plan', label: msg('有計畫') },
];
const MAX_AUTO_EXPAND = 30;
const COMPRESS_ZIP_KEY = 'rtgaia.download.compress';
const PAGE_SIZE = 50;

export function DataPage(props: { user?: Principal | null; onLoggedOut?: () => void }): React.JSX.Element {
  const api = useViewerApi();
  // 手機 —— 搜尋 → 病人 → study → 一鍵開啟；篩選收起來；「本次載入」改成底部摘要條；匯入只在平板與桌面
  const phone = useFormFactor() === 'phone';
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [cartOpen, setCartOpen] = useState(false);
  const [summary, setSummary] = useState<LibrarySummary | null>(null);
  const [guideOpen, setGuideOpen] = useState(false);
  const [filters, setFilters] = useState<Filters>(EMPTY_FILTERS);
  const [applied, setApplied] = useState<Filters>(EMPTY_FILTERS);
  const [patients, setPatients] = useState<{ total: number; items: PatientRow[] } | null>(null);
  const [page, setPage] = useState(1);
  const [tree, setTree] = useState<TreeState>(EMPTY_TREE);
  const [selection, setSelection] = useState<Selection>(EMPTY_SELECTION);
  const [drawer, setDrawer] = useState<string | null>(null);
  const [sendTarget, setSendTarget] = useState<SendTarget | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<DeleteTarget | null>(null);
  const canDelete = props.user?.role === 'admin';
  // 下載 zip 要不要壓縮（可選）；記在瀏覽器
  const [compressZip, setCompressZip] = useState<boolean>(() => {
    try {
      return localStorage.getItem(COMPRESS_ZIP_KEY) === '1';
    } catch {
      return false;
    }
  });
  const toggleCompress = (v: boolean): void => {
    setCompressZip(v);
    try {
      savePref(COMPRESS_ZIP_KEY, v ? '1' : '0');
    } catch {
      /* 私密視窗 */
    }
  };
  const [importOpen, setImportOpen] = useState(false);
  // 工作清單面板；病例狀態徽章（study 列）
  const [worklistOpen, setWorklistOpen] = useState(false);
  const [worklistCases, setWorklistCases] = useState<WorklistCase[]>([]);
  useEffect(() => {
    void catalogApi.worklist().then(setWorklistCases, () => undefined);
  }, [worklistOpen]);
  const casesByStudy = useMemo(() => caseByStudy(worklistCases), [worklistCases]);
  const openCase = async (c: WorklistCase): Promise<void> => {
    if (!c.selection) return;
    setOpening(true);
    setMessage(null);
    try {
      const { warnings } = await createSession({ ...c.selection });
      api.commands.reloadCase();
      // 開得起來就不是錯誤：警告用提示（可關閉），上一個病例的錯誤一併清掉
      api.commands.setError(null);
      api.commands.setNotice(warnings.length > 0 ? joinClauses(warnings) : null);
      navigate('viewer');
    } catch (e) {
      setMessage(e instanceof Error ? e.message : String(e));
    } finally {
      setOpening(false);
    }
  };
  const [busy, setBusy] = useState(false);
  const [error, setErrorMsg] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  // 勾影像時一併帶進了什麼：說明，不是錯誤（以前跟錯誤共用一行、紅字）
  const [hint, setHint] = useState<string | null>(null);
  const [opening, setOpening] = useState(false);
  const run = useRef(0);
  // 篩選一變，舊的子項 fetch 回來不能再寫進樹；用世代號擋
  const generation = useRef(0);

  useEffect(() => {
    void catalogApi.summary().then(setSummary, (e: unknown) => setErrorMsg(String(e)));
  }, []);

  // 輸入後 250 ms 才套用（打字中不要每個字都掃一次）
  useEffect(() => {
    const timer = setTimeout(() => setApplied(filters), 250);
    return () => clearTimeout(timer);
  }, [filters]);

  const treeRef = useRef(tree);
  treeRef.current = tree;

  /** 抓某個節點的子項（冪等：已載入或載入中就不重抓）。 */
  const ensure = useCallback(
    async (key: NodeKey, id: string, f: Filters, gen: number): Promise<void> => {
      const t = treeRef.current;
      if (t.loading.has(key)) return;
      if (key.startsWith('p:') && t.studies.has(id)) return;
      if (key.startsWith('s:') && t.series.has(id)) return;
      if (key.startsWith('i:') && t.rt.has(id)) return;
      setTree((prev) => setLoading(prev, key, true));
      try {
        if (key.startsWith('p:')) {
          const rows = await catalogApi.studies(id, f);
          if (generation.current !== gen) return;
          setTree((prev) => withStudies(setLoading(prev, key, false), id, rows));
        } else if (key.startsWith('s:')) {
          const children = await catalogApi.series(id, f);
          if (generation.current !== gen) return;
          setTree((prev) => withSeries(setLoading(prev, key, false), id, children));
        } else if (key.startsWith('i:')) {
          const rows = await catalogApi.rt(id, f);
          if (generation.current !== gen) return;
          setTree((prev) => withRt(setLoading(prev, key, false), id, rows));
        }
      } catch (e) {
        if (generation.current !== gen) return;
        setTree((prev) => setError(setLoading(prev, key, false), key, e instanceof Error ? e.message : String(e)));
      }
    },
    [],
  );

  // 套用的篩選變了：重抓病人；有條件就同時要命中路徑並自動展開
  useEffect(() => {
    if (summary === null || !summary.configured) return;
    const id = ++run.current;
    const gen = ++generation.current;
    setBusy(true);
    setTree((prev) => clearChildren(prev));
    const f = applied;
    void (async () => {
      try {
        const [pts, search] = await Promise.all([
          catalogApi.patients(f, page, PAGE_SIZE),
          hasAnyFilter(f) ? catalogApi.search(f, MAX_AUTO_EXPAND) : Promise.resolve(null),
        ]);
        if (run.current !== id) return;
        setPatients({ total: pts.total, items: pts.items });
        setErrorMsg(null);
        // 🔴 子項快取剛被 clearChildren 清掉，展開中的節點要**重抓**，否則永遠「載入中…」
        //（重新掃描與改篩選都走這條）。由外往內、同層並行。
        const targets = expandedTargets(treeRef.current);
        for (const kind of ['patient', 'study', 'image'] as const) {
          await Promise.all(targets.filter((x) => x.kind === kind).map((x) => ensure(x.key, x.id, f, gen)));
          if (generation.current !== gen) return;
        }
        if (search) {
          const keys = search.hits.flatMap(keysForHit);
          setTree((prev) => expandMany(prev, keys));
          // 沿路徑把子項抓起來（由外往內；同一層的重複請求由 ensure 擋掉）
          const todo: Promise<void>[] = [];
          for (const hit of search.hits) {
            const p = hit.path;
            todo.push(
              (async () => {
                await ensure(patientKey(p.patient_id), p.patient_id, f, gen);
                await ensure(studyKey(p.study_instance_uid), p.study_instance_uid, f, gen);
                if (p.image_series_uid && hit.kind !== 'image') await ensure(imageKey(p.image_series_uid), p.image_series_uid, f, gen);
              })(),
            );
          }
          await Promise.all(todo);
        }
      } catch (e) {
        if (run.current === id) setErrorMsg(e instanceof Error ? e.message : String(e));
      } finally {
        if (run.current === id) setBusy(false);
      }
    })();
  }, [summary, applied, page, ensure]);

  const rows = useMemo(() => (patients ? flatten(tree, patients.items) : []), [tree, patients]);
  const all = useMemo(() => loadedSeries(tree), [tree]);
  const byUid = useMemo(() => new Map(all.map((s) => [s.series_instance_uid, s])), [all]);
  const problems = selectionProblems(selection);

  const onExpand = (row: FlatRow): void => {
    if (!expandable(row)) return;
    const gen = generation.current;
    setTree((prev) => toggleExpanded(prev, row.key));
    if (isExpanded(tree, row.key)) return; // 正在收合
    if (row.kind === 'patient') void ensure(row.key, row.row.patient_id, applied, gen);
    if (row.kind === 'study') void ensure(row.key, row.row.study_instance_uid, applied, gen);
    if (row.kind === 'image') void ensure(row.key, row.row.series_instance_uid, applied, gen);
  };

  /**
   * 勾影像之前把還沒抓的 RT 列抓回來：一份放進樹、一份當這次的 `all`。
   * 🔴 不能 await ensure 之後再讀 treeRef：setTree 還沒 render，treeRef 是舊的 → bundle 帶不進 RS／劑量
   *（勾整組與勾單一影像都會遇到 —— 沒先展開的影像列，RS／劑量都沒跟進來）。
   */
  const withFetchedRt = async (images: readonly ImageRow[]): Promise<LibrarySeries[]> => {
    const missing = images.filter((m) => !treeRef.current.rt.has(m.series_instance_uid) && m.rt_count > 0);
    const fetched = await Promise.all(
      missing.map(async (m) => ({ uid: m.series_instance_uid, rows: await catalogApi.rt(m.series_instance_uid, applied).catch(() => [] as RtRow[]) })),
    );
    if (fetched.length > 0) setTree((prev) => fetched.reduce((t, f) => withRt(t, f.uid, f.rows), prev));
    const extra = fetched.flatMap((f) => f.rows.flatMap((r) => [r, ...(r.doses ?? [])]));
    return [...loadedSeries(treeRef.current), ...extra];
  };

  /** 勾一個序列。勾影像要先把它的 RT 抓回來，bundle 才有東西可帶（懶載入的代價）。 */
  const onToggle = async (s: LibrarySeries): Promise<void> => {
    const loaded = s.is_image ? await withFetchedRt([s as ImageRow]) : loadedSeries(treeRef.current);
    setSelection((sel) => {
      const next = toggleSeries(sel, s, loaded);
      // 勾影像時一併帶進了什麼，當下就說
      setHint(dependencyHint(sel, next, s));
      return next;
    });
  };

  /** 勾整個 4D 組（各相位 ＋ AVG／MIP）。每個有 RT 的成員先把 RT 抓回來，bundle 才帶得進去。 */
  const onToggleGroup = async (group: TemporalCandidate, members: readonly ImageRow[]): Promise<void> => {
    const loaded = await withFetchedRt(members);
    setSelection((sel) => toggleGroup(sel, group, members, loaded));
  };

  const open = async (): Promise<void> => {
    setOpening(true);
    setMessage(null);
    try {
      const { warnings } = await createSession(toSessionRequest(selection));
      api.commands.reloadCase();
      // 開得起來就不是錯誤：警告用提示（可關閉），上一個病例的錯誤一併清掉
      api.commands.setError(null);
      api.commands.setNotice(warnings.length > 0 ? joinClauses(warnings) : null);
      navigate('viewer');
    } catch (e) {
      setMessage(e instanceof Error ? e.message : String(e));
    } finally {
      setOpening(false);
    }
  };

  /**
   * study 列的「開啟」（手機）。這個 study 已經有病例 → 開那個病例（跟工作清單一樣）；
   * 沒有 → 依 `quickOpenChoice` 挑一張影像（或一個 4D 組），照桌面勾選的規則帶進它的 RT，直接開。
   */
  const quickOpen = async (st: StudyRow): Promise<void> => {
    const existing = casesByStudy.get(st.study_instance_uid);
    if (existing?.selection) {
      await openCase(existing);
      return;
    }
    setOpening(true);
    setMessage(null);
    try {
      const children = await catalogApi.series(st.study_instance_uid, EMPTY_FILTERS);
      const choice = quickOpenChoice(children);
      if (choice === null) {
        setMessage(t('這個 study 沒有能開的影像'));
        setCartOpen(true);
        return;
      }
      const images = choice.kind === 'image' ? [choice.image] : choice.members;
      const rts = await Promise.all(images.filter((m) => m.rt_count > 0).map((m) => catalogApi.rt(m.series_instance_uid, EMPTY_FILTERS).catch(() => [] as RtRow[])));
      const all: LibrarySeries[] = [...children.images, ...rts.flat().flatMap((r) => [r, ...(r.doses ?? [])])];
      const sel = choice.kind === 'image' ? addSeries(EMPTY_SELECTION, choice.image, all) : toggleGroup(EMPTY_SELECTION, choice.group, choice.members, all);
      const blocking = selectionProblems(sel);
      if (blocking.length > 0) {
        setSelection(sel);
        setMessage(joinClauses(blocking));
        setCartOpen(true);
        return;
      }
      const { warnings } = await createSession(toSessionRequest(sel));
      api.commands.reloadCase();
      // 開得起來就不是錯誤：警告用提示（可關閉），上一個病例的錯誤一併清掉
      api.commands.setError(null);
      api.commands.setNotice(warnings.length > 0 ? joinClauses(warnings) : null);
      navigate('viewer');
    } catch (e) {
      setMessage(e instanceof Error ? e.message : String(e));
      setCartOpen(true);
    } finally {
      setOpening(false);
    }
  };

  const rescan = async (): Promise<void> => {
    setBusy(true);
    try {
      await catalogApi.rescan();
      setSummary(await catalogApi.summary());
      setApplied((f) => ({ ...f }));
    } catch (e) {
      setErrorMsg(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const patch = (p: Partial<Filters>): void => {
    setPage(1);
    setFilters((f) => ({ ...f, ...p }));
  };
  const toggleIn = (list: readonly string[], v: string): string[] => (list.includes(v) ? list.filter((x) => x !== v) : [...list, v]);

  return (
    <div className="library data-page">
      <header className="library-header">
        <BrandMenu user={props.user ?? null} section={t('資料庫')} />
        {summary?.configured ? (
          <span className="muted library-summary" title={t('資料庫目錄：{root}', { root: summary.root })}>
            {t('{patient_count} 位病人 · {series_count} 個序列 · {file_count}個檔案', { patient_count: summary.patient_count, series_count: summary.series_count, file_count: summary.file_count })}
            {!phone && (
              <button type="button" className="primary" aria-pressed={importOpen} onClick={() => setImportOpen((v) => !v)}>
                {t('匯入…')}
              </button>
            )}
            <details
              className="library-more"
              onToggle={(e) => {
                // 靠近右邊界時往左打開（窄視窗、200% 縮放）
                const body = e.currentTarget.querySelector<HTMLElement>('.library-more-body');
                if (!e.currentTarget.open || !body) return;
                body.classList.remove('flip-left');
                if (body.getBoundingClientRect().right > window.innerWidth) body.classList.add('flip-left');
              }}
            >
              <summary title={t('重新掃描、下載選項、資料庫目錄')}>{t('更多')}</summary>
              <div className="library-more-body">
                <button type="button" onClick={() => void rescan()} disabled={busy}>
                  {t('重新掃描')}
                </button>
                <label className="compress-toggle" title={t('勾：下載的 zip 用 DEFLATE 壓縮（較小、較慢）；不勾：不壓縮（DICOM 影像壓不了多少）')}>
                  <input type="checkbox" checked={compressZip} onChange={(e) => toggleCompress(e.target.checked)} />
                  {t('下載時壓縮')}
                </label>
                <span className="path" title={summary.root ?? ''}>{t('目錄：{root}', { root: summary.root })}</span>
              </div>
            </details>
          </span>
        ) : summary ? (
          <span className="muted">{t('後端沒有設定資料庫根目錄 —— 以 `--library DIR` 或 `RTGAIA_LIBRARY_ROOT` 指定放 DICOM 的目錄')}</span>
        ) : null}
        {/* 任務引導 —— 開一個病例 */}
        {!phone && (
          <button type="button" className="library-guide" title={t('一步一步帶你從資料庫開一個病例')} onClick={() => setGuideOpen(true)}>
            {t('怎麼開病例？')}
          </button>
        )}
        <UserBadge user={props.user ?? null} onLoggedOut={props.onLoggedOut ?? (() => undefined)} />
      </header>
      {guideOpen && <TourOverlay steps={TASK_OPEN_STEPS} title={t('任務：開一個病例')} onFinish={() => setGuideOpen(false)} />}

      <div className="library-body">
        <section className="library-main">
          {summary?.configured && (
            <>
              <form className={`library-search${phone && !filtersOpen ? ' filters-closed' : ''}`} onSubmit={(e) => e.preventDefault()}>
                <label className="grow">
                  {t('搜尋')}
                  <input
                    value={filters.q}
                    placeholder={t('搜尋病歷號、檢查描述或 ROI 名稱')}
                    title={t('可搜：PatientID、Study／Series 描述、StructureSetLabel、RTPlanLabel、ROI 名稱（例：Parotid）')}
                    onChange={(e) => patch({ q: e.target.value })}
                  />
                </label>
                {phone && (
                  <button type="button" className="filters-toggle" aria-expanded={filtersOpen} onClick={() => setFiltersOpen((v) => !v)}>
                    {filtersOpen ? t('收起篩選') : t('篩選…')}
                  </button>
                )}
                <label>
                  PatientID
                  <input value={filters.patientId} onChange={(e) => patch({ patientId: e.target.value })} />
                </label>
                <label>
                  {t('日期從')}
                  <input type="date" onChange={(e) => patch({ dateFrom: toDicomDate(e.target.value) })} />
                </label>
                <label>
                  {t('到')}
                  <input type="date" onChange={(e) => patch({ dateTo: toDicomDate(e.target.value) })} />
                </label>
                <div className="chips">
                  {MODALITY_CHIPS.map((m) => (
                    <button
                      key={m}
                      type="button"
                      aria-pressed={filters.modalities.includes(m)}
                      onClick={() => patch({ modalities: toggleIn(filters.modalities, m) })}
                    >
                      {m}
                    </button>
                  ))}
                </div>
                <div className="chips">
                  {HAS_CHIPS.map((h) => (
                    <button
                      key={h.key}
                      type="button"
                      aria-pressed={filters.has.includes(h.key)}
                      title={t('只列掛著這種 RT 物件的影像')}
                      onClick={() => patch({ has: toggleIn(filters.has, h.key) })}
                    >
                      {t(h.label)}
                    </button>
                  ))}
                </div>
                <span className="muted">
                  {busy ? t('搜尋中…') : patients && patients.total > 0 ? t('{total} 位病人{p1}', { total: patients.total, p1: hasAnyFilter(applied) ? t('（命中路徑已展開）') : '' }) : ''}
                </span>
                {hasAnyFilter(filters) && (
                  <button
                    type="button"
                    className="linkish"
                    title={t('清掉搜尋字、篩選與日期')}
                    onClick={() => {
                      setFilters(EMPTY_FILTERS);
                      setApplied(EMPTY_FILTERS);
                    }}
                  >
                    {t('清除篩選')}
                  </button>
                )}
              </form>
              {error && <p className="error">{error}</p>}
              <div className="worklist-bar">
                <button type="button" aria-pressed={worklistOpen} onClick={() => setWorklistOpen((v) => !v)} title={t('所有病例依狀態（進行中／待審／已簽核／已匯出）列出，一鍵開啟')}>
                  {t('工作清單{p0}', { p0: worklistCases.length > 0 ? t('（{length}）', { length: worklistCases.length }) : '' })}
                </button>
              </div>
              {worklistOpen && <WorklistPanel me={props.user?.username ?? null} onOpen={(c) => void openCase(c)} onClose={() => setWorklistOpen(false)} opening={opening} />}
              <TreeTable
                rows={rows}
                casesByStudy={casesByStudy}
                expandedKeys={tree.expanded}
                selection={selection}
                onExpand={onExpand}
                onToggle={(s) => void onToggle(s)}
                onToggleGroup={(g, m) => void onToggleGroup(g, m)}
                onMergeGroup={(g, merge) => setSelection((sel) => setMerged(sel, g, merge))}
                onDetail={setDrawer}
                onSend={setSendTarget}
                onDelete={canDelete ? setDeleteTarget : null}
                compress={compressZip}
                emptyKind={hasAnyFilter(applied) ? 'no-match' : 'no-data'}
                onImport={() => setImportOpen(true)}
                {...(phone ? { onQuickOpen: (st: StudyRow) => void quickOpen(st), opening } : {})}
                onClearFilters={() => {
                  setFilters(EMPTY_FILTERS);
                  setApplied(EMPTY_FILTERS);
                }}
              />
              {patients && patients.total > PAGE_SIZE && (
                <div className="pager">
                  <button type="button" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>
                    {t('← 上一頁')}
                  </button>
                  <span className="muted">
                    {t('第{page} 頁 / {p1}', { page, p1: Math.ceil(patients.total / PAGE_SIZE) })}
                  </span>
                  <button type="button" disabled={page * PAGE_SIZE >= patients.total} onClick={() => setPage((p) => p + 1)}>
                    {t('下一頁 →')}
                  </button>
                </div>
              )}
            </>
          )}
        </section>

        {drawer !== null && <DetailDrawer uid={drawer} byUid={byUid} onClose={() => setDrawer(null)} onSend={setSendTarget} compress={compressZip} />}
        {sendTarget !== null && <SendDialog target={sendTarget} onClose={() => setSendTarget(null)} />}
        {deleteTarget !== null && (
          <DeleteDialog
            target={deleteTarget}
            onClose={() => setDeleteTarget(null)}
            onDeleted={() => {
              void catalogApi.summary().then(setSummary, () => undefined);
              setApplied((f) => ({ ...f }));
            }}
          />
        )}
        {importOpen && (
          <ImportPanel
            onClose={() => setImportOpen(false)}
            onImported={() => {
              // 索引已重掃：重抓摘要與目前這頁的樹（篩選不變）
              void catalogApi.summary().then(setSummary, () => undefined);
              setApplied((f) => ({ ...f }));
            }}
          />
        )}

        <aside className="library-cart" data-open={!phone || cartOpen ? 'true' : 'false'}>
          {phone ? (
            <button type="button" className="cart-handle" aria-expanded={cartOpen} onClick={() => setCartOpen((v) => !v)}>
              {t('本次載入（{n} 個序列）', { n: selection.images.length + selection.structureSets.length + selection.doses.length + selection.registrations.length + selection.plans.length })} {cartOpen ? '▾' : '▴'}
            </button>
          ) : (
            <h2>{t('本次載入')}</h2>
          )}
          <CartBucket
            title={t('影像（★ ＝ 主要影像，對位基準）')}
            uids={selection.images}
            byUid={byUid}
            onRemove={(s) => void onToggle(s)}
            renderExtra={(s) => (
              <label className="primary-pick" title={t('設為主要影像（其餘序列以 REG 對位到它）')}>
                <input
                  type="radio"
                  name="primary"
                  checked={selection.primary === s.series_instance_uid}
                  onChange={() => setSelection((sel) => setPrimary(sel, s.series_instance_uid))}
                />
                ★
              </label>
            )}
          />
          <CartBucket title={t('結構集')} uids={selection.structureSets} byUid={byUid} onRemove={(s) => void onToggle(s)} />
          <CartBucket title={t('劑量')} uids={selection.doses} byUid={byUid} onRemove={(s) => void onToggle(s)} />
          <CartBucket title={t('對位（REG）')} uids={selection.registrations} byUid={byUid} onRemove={(s) => void onToggle(s)} />
          <CartBucket title={t('計畫')} uids={selection.plans} byUid={byUid} onRemove={(s) => void onToggle(s)} />
          <p className="selection-summary">{selectionSummary(selection, byUid)}</p>
          <p className="muted">{t('預估體素 ≈ {p0}', { p0: formatBytes(estimateBytes(selection, all)) })}</p>
          {problems.map((p) => (
            <p key={p} className="warning">
              {p}
            </p>
          ))}
          {hint && <p className="muted small">{hint}</p>}
          {message && <p className="error">{message}</p>}
          <div className="cart-actions">
            <button type="button" onClick={() => { setSelection(EMPTY_SELECTION); setHint(null); }} disabled={opening}>
              {t('清空')}
            </button>
            <button type="button" className="primary" data-tour="open-case" onClick={() => void open()} disabled={opening || problems.length > 0}>
              {opening ? t('建立中…') : t('開啟')}
            </button>
          </div>
        </aside>
      </div>
    </div>
  );
}

// ── 樹表格 ──────────────────────────────────────────────────────────────────

function TreeTable(props: {
  rows: readonly FlatRow[];
  expandedKeys: ReadonlySet<string>;
  selection: Selection;
  onExpand: (row: FlatRow) => void;
  onToggle: (s: LibrarySeries) => void;
  onToggleGroup: (group: TemporalCandidate, members: readonly ImageRow[]) => void;
  onMergeGroup: (group: TemporalCandidate, merge: boolean) => void;
  onDetail: (uid: string) => void;
  onSend: (t: SendTarget) => void;
  onDelete: ((t: DeleteTarget) => void) | null;
  compress: boolean;
  emptyKind: 'no-data' | 'no-match';
  onImport: () => void;
  onClearFilters: () => void;
  /** study → 病例狀態（徽章）。 */
  casesByStudy?: Map<string, WorklistCase>;
  /** 手機：study 列的一鍵開啟。 */
  onQuickOpen?: (st: StudyRow) => void;
  opening?: boolean;
}): React.JSX.Element {
  if (props.rows.length === 0) {
    return (
      <div className="tree-empty">
        {props.emptyKind === 'no-data' ? (
          <>
            <p className="muted">{t('資料庫目前是空的。')}</p>
            <button type="button" className="primary" onClick={props.onImport}>
              {t('匯入 DICOM…')}
            </button>
          </>
        ) : (
          <>
            <p className="muted">{t('沒有符合的資料。')}</p>
            <button type="button" onClick={props.onClearFilters}>
              {t('清除篩選')}
            </button>
          </>
        )}
      </div>
    );
  }
  return (
    // 以前宣告 role="tree" 卻沒有 treeitem、沒有樹的方向鍵模型 —— 宣告了做不到的語意比不宣告更糟。
    // 回到一般資料表語意（Tab 進每一列的按鈕、展開鈕有名稱與 aria-expanded）；真的要做樹／treegrid 另排
    <table className="catalog-tree" aria-label={t('資料庫目錄：病人 › study › 序列')}>
      <tbody>
        {props.rows.map((row) => (
          <TreeRow key={row.key} row={row} expanded={props.expandedKeys.has(row.key)} {...props} />
        ))}
      </tbody>
    </table>
  );
}

function TreeRow(props: {
  row: FlatRow;
  expanded: boolean;
  selection: Selection;
  onExpand: (row: FlatRow) => void;
  onToggle: (s: LibrarySeries) => void;
  onToggleGroup: (group: TemporalCandidate, members: readonly ImageRow[]) => void;
  onMergeGroup: (group: TemporalCandidate, merge: boolean) => void;
  onDetail: (uid: string) => void;
  onSend: (t: SendTarget) => void;
  onDelete: ((t: DeleteTarget) => void) | null;
  compress: boolean;
  casesByStudy?: Map<string, WorklistCase>;
  onQuickOpen?: (st: StudyRow) => void;
  opening?: boolean;
}): React.JSX.Element {
  const { row } = props;
  const indent = { paddingLeft: `${8 + row.depth * 18}px` };
  const canExpand = expandable(row);
  const arrow = (
    <button
      type="button"
      className="expander"
      aria-label={canExpand ? t('展開／收合') : undefined}
      disabled={!canExpand}
      data-open={canExpand && props.expanded ? 'true' : undefined}
      aria-expanded={canExpand ? props.expanded : undefined}
      // 🔴 箭頭在 <tr onClick=onExpand> 裡：不擋冒泡會切換兩次＝看起來沒展開（實測踩過）
      onClick={(e) => {
        e.stopPropagation();
        props.onExpand(row);
      }}
    >
      {canExpand ? '▸' : ''}
    </button>
  );
  switch (row.kind) {
    case 'loading':
      return (
        <tr className="aux">
          <td style={indent} colSpan={6} className="muted">
            {t('載入中…')}
          </td>
        </tr>
      );
    case 'error':
      return (
        <tr className="aux">
          <td style={indent} colSpan={6} className="error">
            {row.message}
          </td>
        </tr>
      );
    case 'empty':
      return (
        <tr className="aux">
          <td style={indent} colSpan={6} className="muted">
            {row.message}
          </td>
        </tr>
      );
    case 'patient': {
      const p = row.row;
      return (
        <tr className="patient-row" data-kind="patient" onClick={() => props.onExpand(row)}>
          <td style={indent} className="name">
            {arrow}
            <strong>{p.patient_id}</strong>
            {p.patient_name ? <span className="muted"> · {p.patient_name}</span> : null}
          </td>
          <td className="muted">{t('{study_count} 個 study', { study_count: p.study_count })}</td>
          <td className="muted">
            {t('{image_series_count} 個影像 · {p1}個 RT 物件', { image_series_count: p.image_series_count, p1: p.series_count - p.image_series_count })}
          </td>
          <td className="muted">
            {formatDicomDate(p.date_from)}
            {p.date_to && p.date_to !== p.date_from ? t(' ～ {p0}', { p0: formatDicomDate(p.date_to) }) : ''}
          </td>
          <td className="muted">{p.modalities.join(' ')}</td>
          <td className="actions">
            <SendButton onClick={() => props.onSend({ level: 'patient', id: p.patient_id, label: t('病人 {patient_id}', { patient_id: p.patient_id }), seriesCount: p.series_count })} />
            <DownloadLink level="patients" id={p.patient_id} compress={props.compress} />
            {props.onDelete && <DeleteButton onClick={() => props.onDelete?.({ level: 'patients', id: p.patient_id, label: t('病人 {patient_id}', { patient_id: p.patient_id }), seriesCount: p.series_count })} />}
          </td>
        </tr>
      );
    }
    case 'study': {
      const st = row.row;
      return (
        <tr className="study-row" data-kind="study" onClick={() => props.onExpand(row)}>
          <td style={indent} className="name">
            {arrow}
            {formatDicomDate(st.study_date)} <span className="desc">{st.study_description || t('（無描述）')}</span>
            {(() => {
              const c = props.casesByStudy?.get(st.study_instance_uid);
              return c && c.status !== 'none' ? (
                <span className={`badge case-status case-status-${c.status}`} title={t('病例狀態：{p0}{p1}', { p0: STATUS_LABEL[c.status], p1: c.open_users.length ? t('；在線：{p0}', { p0: joinList(c.open_users) }) : '' })}>
                  {t(STATUS_LABEL[c.status])}
                </span>
              ) : null;
            })()}
            {props.onQuickOpen && (
              <button
                type="button"
                className="primary quick-open"
                disabled={props.opening === true}
                title={props.casesByStudy?.get(st.study_instance_uid)?.selection ? t('開這個 study 已有的病例') : t('開這個 study：自動挑主要影像，帶進它的結構、劑量、計畫')}
                onClick={(e) => {
                  e.stopPropagation();
                  props.onQuickOpen?.(st);
                }}
              >
                {props.opening ? t('建立中…') : t('開啟')}
              </button>
            )}
          </td>
          <td className="muted">{t('{image_series_count} 個影像', { image_series_count: st.image_series_count })}</td>
          <td className="muted">
            {t('{rt_object_count} 個 RT 物件{p1}', { rt_object_count: st.rt_object_count, p1: st.unlinked_count > 0 ? t('（{unlinked_count} 未關聯）', { unlinked_count: st.unlinked_count }) : '' })}
          </td>
          <td className="muted" />
          <td className="muted">{st.modalities.join(' ')}</td>
          <td className="actions">
            <SendButton
              onClick={() =>
                props.onSend({
                  level: 'study',
                  id: st.study_instance_uid,
                  label: t('{p0} {p1}', { p0: formatDicomDate(st.study_date), p1: st.study_description || t('（無描述）') }),
                  seriesCount: st.image_series_count + st.rt_object_count,
                })
              }
            />
            <DownloadLink level="studies" id={st.study_instance_uid} compress={props.compress} />
            {props.onDelete && (
              <DeleteButton
                onClick={() =>
                  props.onDelete?.({
                    level: 'studies',
                    id: st.study_instance_uid,
                    label: t('{p0} {p1}', { p0: formatDicomDate(st.study_date), p1: st.study_description || t('（無描述）') }),
                    seriesCount: st.image_series_count + st.rt_object_count,
                  })
                }
              />
            )}
          </td>
        </tr>
      );
    }
    case 'unlinked':
      return (
        <tr className="unlinked-row" data-kind="unlinked" onClick={() => props.onExpand(row)}>
          <td style={indent} className="name" colSpan={6}>
            {arrow}
            <span className="muted">{t('未關聯的 RT 物件（{count}）—— 參照的影像不在庫裡', { count: row.row.count })}</span>
          </td>
        </tr>
      );
    case 'temporal': {
      const { group, members } = row.row;
      const usable = members.filter((m) => m.temporal?.role !== 'excluded');
      const state = groupState(props.selection, usable);
      const merged = isMerged(props.selection, group);
      const first = members[0];
      const note = groupNote(group);
      return (
        <tr data-kind="temporal" data-selected={state === 'all' ? 'true' : undefined} data-merged={merged ? 'true' : undefined} onClick={() => props.onExpand(row)}>
          <td style={indent} className="name">
            {arrow}
            <input
              type="checkbox"
              checked={state === 'all'}
              aria-label={t('選這個 4D 組的全部序列')}
              ref={(el) => {
                if (el) el.indeterminate = state === 'some';
              }}
              onClick={(e) => e.stopPropagation()}
              onChange={() => props.onToggleGroup(group, members)}
            />
            <span className="modality">{first?.modality ?? ''}</span>
            <span className="desc">{temporalGroupTitle(group)}</span>
          </td>
          <td className="muted">{formatDicomDate(first?.series_date)}</td>
          <td className="muted">{note}</td>
          <td className="muted">{t('{n} 個序列', { n: members.length })}</td>
          <td className="badges">
            <label className="merge-toggle" title={t('勾著：開病例時這些序列合成一條時間軸（可以播放）；不勾：各自是一張影像')} onClick={(e) => e.stopPropagation()}>
              <input type="checkbox" checked={merged} onChange={(e) => props.onMergeGroup(group, e.target.checked)} /> {t('合併成時間軸')}
            </label>
            {!group.auto && (
              <span className="badge temporal-low" title={group.warnings.join('\n')}>
                {t('需確認')}
              </span>
            )}
          </td>
          <td className="actions" />
        </tr>
      );
    }
    case 'image': {
      const s = row.row;
      const selected = isSelected(props.selection, s.series_instance_uid);
      const tBadge = memberBadge(s);
      const dyn = dynamicBadge(s);
      return (
        <tr data-kind="image" data-modality={s.modality} data-selected={selected ? 'true' : undefined} data-hit={s.hit ? 'true' : undefined}>
          <td style={indent} className="name">
            {arrow}
            <input
              type="checkbox"
              checked={selected}
              // 解不了的壓縮格式不能選來開病例（已選的仍可取消）；原因在滑鼠提示與「無法解碼」徽章
              disabled={!selected && !canOpenSeries(s)}
              title={canOpenSeries(s) ? undefined : (s.decode_error ?? t('無法解碼'))}
              onChange={() => props.onToggle(s)}
            />
            <span className="modality">{s.modality}</span>
            <button type="button" className="linkish" onClick={() => props.onDetail(s.series_instance_uid)}>
              {s.series_description || t('（無描述）')}
            </button>
          </td>
          <td className="muted">{formatDicomDate(s.series_date)}</td>
          <td className="muted">{seriesSummary(s)}</td>
          <td className="muted">{t('{instance_count} 檔', { instance_count: s.instance_count })}</td>
          <td className="badges">
            {s.decodable === false && (
              <span className="badge undecodable" title={s.decode_error ?? ''}>
                {t('無法解碼')}
              </span>
            )}
            {tBadge && (
              <span className={`badge temporal-member temporal-${s.temporal?.role ?? ''}`} title={tBadge.title}>
                {tBadge.text}
              </span>
            )}
            {dyn && (
              <span className="badge dynamic" title={dynamicTitle(s)}>
                {dyn}
              </span>
            )}
            {s.rtstruct_count > 0 && <span className="badge rs">RS {s.rtstruct_count}</span>}
            {s.plan_count > 0 && <span className="badge plan">PLAN {s.plan_count}</span>}
            {s.dose_count > 0 && <span className="badge dose">DOSE {s.dose_count}</span>}
            {s.registration_count > 0 && <span className="badge reg">REG {s.registration_count}</span>}
            {s.registrations_targeting > 0 && (
              <span className="badge target" title={t('有對位以此影像為目標（fixed 側）')}>
                {t('←{registrations_targeting}對位', { registrations_targeting: s.registrations_targeting })}
              </span>
            )}
            <span className="for" title={s.frame_of_reference_uid}>
              FoR …{s.frame_of_reference_uid.slice(-6)}
            </span>
          </td>
          <td className="actions">
            <SendButton onClick={() => props.onSend({ level: 'series', id: s.series_instance_uid, label: seriesSummary(s), instanceCount: s.instance_count })} />
            <DownloadLink level="series" id={s.series_instance_uid} compress={props.compress} />
            {props.onDelete && <DeleteButton onClick={() => props.onDelete?.({ level: 'series', id: s.series_instance_uid, label: seriesSummary(s), instanceCount: s.instance_count })} />}
          </td>
        </tr>
      );
    }
    case 'rt': {
      const s = row.row;
      const selected = isSelected(props.selection, s.series_instance_uid);
      return (
        <tr
          data-kind="rt"
          data-rt={s.kind}
          data-modality={s.modality}
          data-selected={selected ? 'true' : undefined}
          data-hit={s.hit ? 'true' : undefined}
          data-nested={row.nested ? 'true' : undefined}
        >
          <td style={indent} className="name">
            {arrow}
            <input type="checkbox" checked={selected} onChange={() => props.onToggle(s)} />
            <span className="modality">{s.modality}</span>
            <button type="button" className="linkish" onClick={() => props.onDetail(s.series_instance_uid)}>
              {rtLabel(s)}
            </button>
          </td>
          <td className="muted">{formatDicomDate(s.series_date)}</td>
          <td className="muted">{seriesSummary(s)}</td>
          <td className="muted">{t('{instance_count} 檔', { instance_count: s.instance_count })}</td>
          <td className="badges">
            <RtBadges s={s} />
          </td>
          <td className="actions">
            <SendButton onClick={() => props.onSend({ level: 'series', id: s.series_instance_uid, label: seriesSummary(s), instanceCount: s.instance_count })} />
            <DownloadLink level="series" id={s.series_instance_uid} compress={props.compress} />
            {props.onDelete && <DeleteButton onClick={() => props.onDelete?.({ level: 'series', id: s.series_instance_uid, label: seriesSummary(s), instanceCount: s.instance_count })} />}
          </td>
        </tr>
      );
    }
  }
}

function rtLabel(s: RtRow): string {
  const text = (v: unknown): string => (typeof v === 'string' || typeof v === 'number' ? String(v) : '');
  if (s.kind === 'rtstruct') return text(s.refs['structure_set_label']) || s.series_description || 'RTSTRUCT';
  if (s.kind === 'plan') return text(s.refs['plan_label']) || s.series_description || 'RTPLAN';
  if (s.kind === 'reg') return s.direction ? `→ ${s.direction.to_label}` : s.series_description || 'REG';
  return s.series_description || s.modality;
}

function RtBadges(props: { s: RtRow }): React.JSX.Element {
  const { s } = props;
  return (
    <>
      {s.kind === 'rtstruct' && (s.referenced_by_plans?.length ?? 0) > 0 && (
        <span className="badge clinical" title={t('被計畫參照：{p0}', { p0: joinList(s.referenced_by_plan_labels ?? []) })}>
          {t('被{length}個計畫參照', { length: s.referenced_by_plans!.length })}
        </span>
      )}
      {s.kind === 'plan' && <span className="badge dose">DOSE {s.doses?.length ?? 0}</span>}
      {s.kind === 'dose' && s.plan_missing && <span className="badge warn">{t('計畫未匯入')}</span>}
      {s.kind === 'dose' && s.derived && (
        <span className="badge derived" title={typeof s.refs['derivation_description'] === 'string' ? s.refs['derivation_description'] : undefined}>
          {t('衍生劑量')}
        </span>
      )}
      {s.kind === 'reg' && s.direction && (
        <span className={`badge ${s.direction.deformable ? 'warn' : 'reg'}`}>{s.direction.deformable ? t('形變') : t('剛性')}</span>
      )}
    </>
  );
}

function SendButton(props: { onClick: () => void }): React.JSX.Element {
  return (
    <button
      type="button"
      className="send-btn"
      title={t('以 DIMSE C-STORE 送到登錄的節點（PACS／TPS）')}
      aria-label={t('送到節點')}
      onClick={(e) => {
        e.stopPropagation();
        props.onClick();
      }}
    >
      ⇪
    </button>
  );
}

function DeleteButton(props: { onClick: () => void }): React.JSX.Element {
  return (
    <button
      type="button"
      className="delete-btn"
      title={t('從資料庫移除（搬進 .rtgaia/trash，可救回；只有管理者）')}
      aria-label={t('從資料庫移除')}
      onClick={(e) => {
        e.stopPropagation();
        props.onClick();
      }}
    >
      🗑
    </button>
  );
}

function DownloadLink(props: { level: 'patients' | 'studies' | 'series'; id: string; compress: boolean }): React.JSX.Element {
  return (
    <a
      className="download"
      aria-label={t('下載 zip')}
      href={catalogApi.downloadUrl(props.level, props.id, props.compress)}
      title={t('下載 zip（原始 DICOM，檔名用 UID，{p0}）', { p0: props.compress ? t('DEFLATE 壓縮') : t('不壓縮') })}
      onClick={(e) => e.stopPropagation()}
    >
      ⤓
    </a>
  );
}

// ── 抽屜 ────────────────────────────────────────────────────────────────────

function DetailDrawer(props: { uid: string; byUid: Map<string, LibrarySeries>; onClose: () => void; onSend: (t: SendTarget) => void; compress: boolean }): React.JSX.Element {
  const [detail, setDetail] = useState<SeriesDetail | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    setDetail(null);
    setErr(null);
    void catalogApi.detail(props.uid).then(setDetail, (e: unknown) => setErr(String(e)));
  }, [props.uid]);
  const label = (uid: string): string => detail?.labels[uid] ?? props.byUid.get(uid)?.series_description ?? `…${uid.slice(-8)}`;
  const list = (title: string, uids: readonly string[] | undefined): React.JSX.Element | null =>
    uids && uids.length > 0 ? (
      <div className="drawer-list">
        <h4>{title}</h4>
        <ul>
          {uids.map((u) => (
            <li key={u}>{label(u)}</li>
          ))}
        </ul>
      </div>
    ) : null;
  return (
    <aside className="detail-drawer">
      <header>
        <h3>{detail ? t('{modality} · {p1}', { modality: detail.modality, p1: detail.series_description || t('（無描述）') }) : t('載入中…')}</h3>
        <button type="button" onClick={props.onClose} aria-label={t('關閉')}>
          ×
        </button>
      </header>
      {err && <p className="error">{err}</p>}
      {detail && (
        <>
          <dl>
            <dt>{t('日期')}</dt>
            <dd>{formatDicomDate(detail.series_date) || '—'}</dd>
            <dt>Study</dt>
            <dd>
              {formatDicomDate(detail.study_date)} {detail.study_description}
            </dd>
            <dt>{t('摘要')}</dt>
            <dd>{seriesSummary(detail) || '—'}</dd>
            <dt>{t('檔數')}</dt>
            <dd>{detail.instance_count}</dd>
            {detail.transfer_syntax ? (
              <>
                <dt>{t('壓縮格式')}</dt>
                <dd>
                  {detail.transfer_syntax}
                  {detail.decodable === false && <span className="badge undecodable" title={detail.decode_error ?? ''}>{t('無法解碼')}</span>}
                </dd>
              </>
            ) : null}
            <dt>{t('機型')}</dt>
            <dd>{[detail.manufacturer, detail.manufacturer_model_name].filter(Boolean).join(' ') || '—'}</dd>
            <dt>Series UID</dt>
            <dd className="uid">
              <code>{detail.series_instance_uid}</code>
              <CopyButton text={detail.series_instance_uid} />
            </dd>
            <dt>FoR</dt>
            <dd className="uid">
              <code>{detail.frame_of_reference_uid || '—'}</code>
              {detail.frame_of_reference_uid && <CopyButton text={detail.frame_of_reference_uid} />}
            </dd>
            {detail.directory && (
              <>
                <dt>{t('目錄')}</dt>
                <dd className="uid">
                  <code>{detail.directory}</code>
                </dd>
              </>
            )}
          </dl>
          {detail.attached && (
            <>
              {list(t('結構集'), detail.attached.rtstruct)}
              {list(t('計畫'), detail.attached.plan)}
              {Object.entries(detail.attached.doses_of_plan).map(([p, ds]) => list(t('計畫 {p0} 的劑量', { p0: label(p) }), ds))}
              {list(t('劑量（無計畫）'), detail.attached.dose)}
              {list(t('對位（此為 moving）'), detail.attached.reg)}
              {list(t('被對位指向（此為 fixed）'), detail.attached.registrations_targeting)}
            </>
          )}
          {list(t('被計畫參照'), detail.referenced_by_plans)}
          {detail.derived && <DerivedDoseInfo refs={detail.refs} />}
          {detail.direction && (
            <p className="muted">
              {t('對位方向：{p0} → {to_label}（{p2}）', { p0: label(detail.direction.from_series_uid), to_label: detail.direction.to_label, p2: detail.direction.deformable ? t('形變') : t('剛性') })}
            </p>
          )}
          <p className="drawer-actions">
            <a className="download" href={catalogApi.downloadUrl('series', detail.series_instance_uid, props.compress)}>
              {t('⤓ 下載這個序列（zip）')}
            </a>
            <button
              type="button"
              className="linkish"
              onClick={() => props.onSend({ level: 'series', id: detail.series_instance_uid, label: seriesSummary(detail), instanceCount: detail.instance_count })}
            >
              {t('⇪ 送到節點（C-STORE）')}
            </button>
          </p>
        </>
      )}
    </aside>
  );
}

/** 劑量運算存的 RTDOSE —— 列出運算鏈（`DerivationDescription` 以「 | 」分段）、DoseType／DoseSummationType。 */
function DerivedDoseInfo(props: { refs: Readonly<Record<string, unknown>> }): React.JSX.Element {
  const text = (v: unknown): string => (typeof v === 'string' ? v : '');
  const parts = text(props.refs['derivation_description']).split(' | ').filter(Boolean);
  return (
    <div className="drawer-list derived-dose-info">
      <h4>{t('衍生劑量（RT-Gaia 劑量運算）')}</h4>
      <p className="muted small">{t('這是 RT-Gaia 算出的衍生劑量，不是 TPS 計算結果。')}</p>
      <ul>
        {parts.map((p, i) => (
          <li key={i}>{p}</li>
        ))}
        <li>
          DoseType {text(props.refs['dose_type']) || '—'} · DoseSummationType {text(props.refs['dose_summation_type']) || '—'}
        </li>
      </ul>
    </div>
  );
}

function CopyButton(props: { text: string }): React.JSX.Element {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      className="copy"
      title={t('複製')}
      onClick={() => {
        void copyText(props.text).then((ok) => {
                if (!ok) return;
          setDone(true);
          setTimeout(() => setDone(false), 1200);
        });
      }}
    >
      {done ? t('已複製') : t('複製')}
    </button>
  );
}

// ── 購物車 ──────────────────────────────────────────────────────────────────

function CartBucket(props: {
  title: string;
  uids: readonly string[];
  byUid: Map<string, LibrarySeries>;
  onRemove: (s: LibrarySeries) => void;
  renderExtra?: (s: LibrarySeries) => React.JSX.Element;
}): React.JSX.Element | null {
  if (props.uids.length === 0) return null;
  return (
    <div className="cart-bucket">
      <h3>{props.title}</h3>
      <ul>
        {props.uids.map((uid) => {
          const s = props.byUid.get(uid);
          if (!s) return null;
          return (
            <li key={uid}>
              {props.renderExtra?.(s)}
              <span className="modality">{s.modality}</span>
              <span className="desc">
                {formatDicomDate(s.series_date)} {s.series_description}
              </span>
              <button type="button" title={t('移除')} onClick={() => props.onRemove(s)}>
                ×
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

