/**
 * BEV／MLC 開口 ＋ 控制點時間軸 —— `slot:'cell'`（可以放進任何版面格子，像 DVH 圖），
 * 沒放進格子時內嵌在計畫面板。
 *
 * 射束選單、雙層 MLC 疊合／分開、跟著准直器旋轉；時間軸：拖曳、播放（速度是「控制點／秒」，不是真實的照射時間）、
 * 逐 CP（按鈕、方向鍵、在圖上滾輪）。讀數：機架、准直器、床、累積 MU、每度 MU。
 * 目前的射束與 CP 寫進模組狀態（之後 3D 射束跟著它動）；播放中只在本地跑，停下來才寫。
 * 只看計畫內容 —— 不是照射模擬，也不檢查葉片速度或劑量率。
 */

import { useEffect, useMemo, useRef, useState } from 'react';

import type { ViewerPanelProps } from '../../panels/types';
import { drawBev } from './bevDraw';
import { drawMachine } from './machineDraw';
import {
  bevViewHalfMm,
  clampCp,
  CP_SPEEDS,
  cpReadout,
  defaultBevBeam,
  DRR_PRESETS,
  fetchBeamControlPoints,
  isGammaKnife,
  leafOpacityOf,
  machineKind,
  machineKindText,
  machinePose,
  mlcLayers,
  showDrrOf,
  type BevViewMode,
  type MachineKind,
  PLAN_MODULE_ID,
  type BeamControlPoints,
  type DrrContour,
  type DrrPreset,
  type MlcView,
  type PlanModuleState,
} from './model';
import { useBevDrr } from './useBevDrr';
import { usePlans } from './usePlans';
import { t } from '../../../core/i18n';

export interface BevExtras {
  readonly background?: { readonly image: CanvasImageSource; readonly halfMm: number; readonly opacity: number } | undefined;
  readonly contours?: readonly DrrContour[] | undefined;
  readonly leafOpacity?: number | undefined;
}

export function BevCanvas(props: {
  bcp: BeamControlPoints;
  cp: number;
  only?: string | undefined;
  rotate: boolean;
  title?: string | undefined;
  onWheel: (dir: number) => void;
  /** Ctrl＋滾輪：放大（> 1）／縮小。 */
  onZoom?: ((factor: number) => void) | undefined;
  extras?: BevExtras | undefined;
  /** 視野半邊（mm）；沒給 ＝ 適合開口。 */
  viewHalfMm?: number | undefined;
}): React.JSX.Element {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return undefined;
    const ro = new ResizeObserver(() => setSize({ w: host.clientWidth, h: host.clientHeight }));
    ro.observe(host);
    setSize({ w: host.clientWidth, h: host.clientHeight });
    return () => ro.disconnect();
  }, []);
  const fit = useMemo(() => bevViewHalfMm(props.bcp, 'fit'), [props.bcp]);
  const half = props.viewHalfMm ?? fit;
  const { onWheel, onZoom } = props;
  useEffect(() => {
    const canvas = canvasRef.current;
    const cp = props.bcp.control_points[clampCp(props.cp, props.bcp.control_points.length)];
    if (!canvas || cp === undefined || size.w === 0 || size.h === 0) return;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(size.w * dpr);
    canvas.height = Math.round(size.h * dpr);
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const area = drawBev(ctx, size.w, size.h, {
      cp,
      devices: props.bcp.devices,
      halfMm: half,
      only: props.only,
      rotate: props.rotate,
      dpr,
      ...(props.title ? { title: props.title } : {}),
      background: props.extras?.background,
      contours: props.extras?.contours,
      leafOpacity: props.extras?.leafOpacity,
    });
    canvas.dataset['areaCm2'] = area.areaCm2.toFixed(2);
  }, [props.bcp, props.cp, props.only, props.rotate, props.title, props.extras, size, half]);
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return undefined;
    const handler = (e: WheelEvent): void => {
      e.preventDefault();
      if ((e.ctrlKey || e.metaKey) && onZoom) onZoom(e.deltaY > 0 ? 1 / 1.15 : 1.15);
      else onWheel(e.deltaY > 0 ? 1 : -1);
    };
    canvas.addEventListener('wheel', handler, { passive: false });
    return () => canvas.removeEventListener('wheel', handler);
  }, [onWheel, onZoom]);
  return (
    <div className="bev-canvas-host" ref={hostRef}>
      <canvas ref={canvasRef} className="bev-canvas" style={{ width: '100%', height: '100%' }} />
    </div>
  );
}

/** 機架／治療床示意（正面 ＋ 俯視），跟著目前的控制點。 */
export function MachineSketch(props: { bcp: BeamControlPoints; cp: number; kind: MachineKind; position: string; vertical?: boolean }): React.JSX.Element {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return undefined;
    const ro = new ResizeObserver(() => setSize({ w: host.clientWidth, h: host.clientHeight }));
    ro.observe(host);
    setSize({ w: host.clientWidth, h: host.clientHeight });
    return () => ro.disconnect();
  }, []);
  useEffect(() => {
    const canvas = canvasRef.current;
    const cp = props.bcp.control_points[clampCp(props.cp, props.bcp.control_points.length)];
    if (!canvas || cp === undefined || size.w === 0 || size.h === 0) return;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(size.w * dpr);
    canvas.height = Math.round(size.h * dpr);
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    drawMachine(ctx, size.w, size.h, { kind: props.kind, pose: machinePose(cp), position: props.position, dpr, vertical: props.vertical === true });
    canvas.dataset['gantry'] = String(cp.gantry_deg ?? '');
  }, [props.bcp, props.cp, props.kind, props.position, props.vertical, size]);
  return (
    <div className="machine-sketch" ref={hostRef} title={machineKindText(props.kind)}>
      <canvas ref={canvasRef} className="machine-canvas" style={{ width: '100%', height: '100%' }} />
    </div>
  );
}

export function BevView({ api }: ViewerPanelProps): React.JSX.Element {
  const { plans, loading, error } = usePlans(api);
  const st = api.state.modules[PLAN_MODULE_ID] as PlanModuleState | undefined;
  const set = (patch: Partial<PlanModuleState>): void => api.commands.setModuleState(PLAN_MODULE_ID, patch);
  const plan = plans.find((p) => p.plan_id === st?.planId) ?? plans[0] ?? null;
  const beamNumber = plan ? defaultBevBeam(plan, st?.bevBeam) : null;
  const [bcp, setBcp] = useState<BeamControlPoints | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState<number>(10);
  const [local, setLocal] = useState<number>(st?.cp ?? 0);
  // 寬的格子（寬 ≥ 高、至少 420 px）：示意圖改放 BEV 右邊
  const rootRef = useRef<HTMLDivElement | null>(null);
  const [wide, setWide] = useState(false);
  useEffect(() => {
    const el = rootRef.current;
    if (!el) return undefined;
    const update = (): void => setWide(el.clientWidth >= 420 && el.clientWidth >= el.clientHeight * 0.95);
    const ro = new ResizeObserver(update);
    ro.observe(el);
    update();
    return () => ro.disconnect();
  });
  const studyId = api.state.studyId;
  const { http } = api;
  const mlcView: MlcView = st?.mlcView ?? 'overlay';
  const rotate = st?.bevRotate !== false;

  useEffect(() => {
    if (!studyId || !plan || beamNumber === null) return undefined;
    let cancelled = false;
    setBcp(null);
    setLoadError(null);
    fetchBeamControlPoints(studyId, plan.plan_id, beamNumber, http.getJson.bind(http)).then(
      (r) => !cancelled && setBcp(r),
      (e: unknown) => !cancelled && setLoadError(e instanceof Error ? e.message : String(e)),
    );
    return () => {
      cancelled = true;
    };
  }, [studyId, plan, beamNumber, http]);

  const n = bcp?.control_points.length ?? 0;
  // DRR（CT 的射束視角）當背景 —— 預設開；停下來抓全尺寸，播放中抓小張、一次一個（`useBevDrr`）
  const showDrr = showDrrOf(st);
  const drrPreset: DrrPreset = st?.drrPreset ?? 'high';
  const drrOpacity = st?.drrOpacity ?? 1;
  const leafOpacity = leafOpacityOf(st);
  const drrContoursOn = st?.drrContours !== false;
  const visibleMasks = api.state.layers.filter((l) => l.kind === 'mask' && l.visible).map((l) => l.contentRef);
  const contourKey = drrContoursOn ? visibleMasks.slice(0, 12).join(',') : '';
  // 視野：預設適合開口（所有 CP 開口的最大範圍）；可切整個照野；Ctrl＋滾輪縮放（只在這個元件裡）
  const viewMode: BevViewMode = st?.bevView ?? 'fit';
  const [zoom, setZoom] = useState(1);
  useEffect(() => setZoom(1), [viewMode, beamNumber]);
  const halfMm = bcp ? bevViewHalfMm(bcp, viewMode, zoom) : 150;
  // 不在播放時跟著模組狀態（別的面板改了 CP 也跟著）
  useEffect(() => {
    if (!playing) setLocal(clampCp(st?.cp ?? 0, n));
  }, [st?.cp, n, playing]);
  const cp = clampCp(local, n);
  const { drr, error: drrError } = useBevDrr(
    http,
    showDrr && studyId && plan && beamNumber !== null && bcp !== null && n > 0
      ? {
          studyId,
          planId: plan.plan_id,
          beam: beamNumber,
          cp,
          halfMm,
          preset: drrPreset,
          wc: st?.drrWc ?? 0.5,
          ww: st?.drrWw ?? 1,
          structureIds: contourKey ? contourKey.split(',') : [],
          playing,
        }
      : null,
  );
  const extras = useMemo(
    () =>
      showDrr && drr !== null
        ? { background: { image: drr.image, halfMm: drr.resp.half_mm, opacity: drrOpacity }, contours: drr.resp.contours, leafOpacity }
        : { leafOpacity },
    [showDrr, drr, drrOpacity, leafOpacity],
  );

  const commit = (i: number): void => {
    const c = clampCp(i, n);
    setLocal(c);
    set({ cp: c });
  };
  const stepBy = (d: number): void => commit(cp + d);
  const zoomBy = (f: number): void => setZoom((z) => Math.max(0.5, Math.min(4, z * f)));

  useEffect(() => {
    if (!playing || n === 0) return undefined;
    const timer = setInterval(() => {
      setLocal((i) => {
        const next = i + 1;
        if (next >= n) {
          setPlaying(false);
          return n - 1;
        }
        return next;
      });
    }, 1000 / speed);
    return () => clearInterval(timer);
  }, [playing, speed, n]);
  // 播放停下來（按暫停或播到底）→ 寫回模組狀態
  const wasPlaying = useRef(false);
  useEffect(() => {
    if (wasPlaying.current && !playing) set({ cp: clampCp(local, n) });
    wasPlaying.current = playing;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playing]);

  if (loading) return <p className="muted hint bev-empty">{t('讀取計畫…')}</p>;
  if (error !== null || plan === null) return <p className="muted hint bev-empty">{error !== null ? t('讀不到計畫：{msg}', { msg: error }) : t('這個病例沒有 RTPLAN。')}</p>;
  if (isGammaKnife(plan)) return <p className="muted hint bev-empty">{t('Gamma Knife 計畫沒有直線加速器的射束，沒有 BEV／MLC 可看；shot 位置標在影像上。')}</p>;
  const layers = bcp ? mlcLayers(bcp.devices) : [];
  const beam = plan.beams.find((b) => b.number === beamNumber);
  const split = mlcView === 'split' && layers.length > 1;

  const machineOn = st?.showMachine !== false;
  const sideSketch = machineOn && wide;
  return (
    <div
      ref={rootRef}
      className={`bev-view${wide ? ' wide' : ''}`}
      tabIndex={0}
      onKeyDown={(e) => {
        // 工具列的下拉選單、滑桿、勾選框照原生行為：以前在「射束」選單上按方向鍵換的是控制點，選單換不了；
        // 按鈕上的空白鍵是按那個按鈕（例：「下一個」），不是播放
        const target = e.target as HTMLElement;
        if (target !== e.currentTarget && (target.closest('select, input, textarea') !== null || (e.key === ' ' && target.closest('button') !== null))) return;
        if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
          e.preventDefault();
          stepBy(1);
        } else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
          e.preventDefault();
          stepBy(-1);
        } else if (e.key === ' ') {
          e.preventDefault();
          setPlaying((p) => !p);
        }
      }}
    >
      <div className="bev-toolbar">
        <select
          value={beamNumber ?? ''}
          aria-label={t('射束')}
          onChange={(e) => {
            setPlaying(false);
            set({ bevBeam: Number(e.target.value), cp: 0 });
          }}
        >
          {plan.beams
            .filter((b) => b.number !== null && b.control_points > 0)
            .map((b) => (
              <option key={b.number} value={b.number!}>
                {`${b.number} ${b.name}`}
                {b.is_treatment ? '' : ` (${t('設定', { ctx: '射束' })})`}
              </option>
            ))}
        </select>
        {layers.length > 1 && (
          <select value={mlcView} aria-label={t('雙層 MLC')} title={t('雙層 MLC：疊在一起看開口（兩層都開才有光），或分開看每一層')} onChange={(e) => set({ mlcView: e.target.value as MlcView })}>
            <option value="overlay">{t('MLC 疊合')}</option>
            <option value="split">{t('MLC 分開')}</option>
          </select>
        )}
        <select value={viewMode} aria-label={t('BEV 視野')} title={t('適合開口：放大到所有控制點開口的最大範圍；整個照野：畫到葉片與 jaw 的最大範圍。Ctrl＋滾輪可以再縮放')} onChange={(e) => set({ bevView: e.target.value as BevViewMode })}>
          <option value="fit">{t('適合開口')}</option>
          <option value="field">{t('整個照野')}</option>
        </select>
        <label title={t('整張圖轉准直器角（示意）')}>
          <input type="checkbox" checked={rotate} onChange={(e) => set({ bevRotate: e.target.checked })} /> {t('跟著准直器轉')}
        </label>
        <label title={t('機架／治療床示意：依機型畫環型機或 C 臂，跟著控制點的機架、床角動（不是碰撞檢查）')}>
          <input type="checkbox" checked={st?.showMachine !== false} onChange={(e) => set({ showMachine: e.target.checked })} /> {t('機架示意')}
        </label>
      </div>
      <div className="bev-toolbar bev-drr-row">
        <label title={t('BEV 背景畫 DRR（用 CT 沿射源到 BEV 平面的透視射線積分；每個控制點由伺服器算一張，播放中用小張）')}>
          <input type="checkbox" checked={showDrr} onChange={(e) => set({ showDrr: e.target.checked })} /> DRR
        </label>
        {showDrr && (
          <>
            <select value={drrPreset} aria-label={t('DRR 對比')} onChange={(e) => set({ drrPreset: e.target.value as DrrPreset })}>
              {DRR_PRESETS.map((p) => (
                <option key={p.id} value={p.id}>
                  {t(p.label)}
                </option>
              ))}
            </select>
            {drrPreset === 'custom' && (
              <>
                <label title={t('窗中心（0–1）')}>
                  C <input type="range" min={0} max={1} step={0.01} value={st?.drrWc ?? 0.5} onChange={(e) => set({ drrWc: Number(e.target.value) })} />
                </label>
                <label title={t('窗寬（0–2）')}>
                  W <input type="range" min={0.05} max={2} step={0.01} value={st?.drrWw ?? 1} onChange={(e) => set({ drrWw: Number(e.target.value) })} />
                </label>
              </>
            )}
            <label title={t('DRR 不透明度')}>
              DRR <input type="range" className="bev-opacity" min={0} max={1} step={0.05} value={drrOpacity} onChange={(e) => set({ drrOpacity: Number(e.target.value) })} />
            </label>
            <label title={t('葉片不透明度')}>
              {t('葉片')} <input type="range" className="bev-opacity" min={0} max={1} step={0.05} value={leafOpacity} onChange={(e) => set({ leafOpacity: Number(e.target.value) })} />
            </label>
            <label title={t('把顯示中的結構投影到 BEV（最多 12 個）')}>
              <input type="checkbox" checked={drrContoursOn} onChange={(e) => set({ drrContours: e.target.checked })} /> {t('投影輪廓')}
            </label>
            {drr !== null && <span className="muted small bev-drr-note">{t('DRR @ CP {n}', { n: drr.resp.cp + 1 })}</span>}
          </>
        )}
      </div>
      {showDrr && drrError && <p className="error small bev-drr-error">{drrError}</p>}
      {loadError && <p className="error small">{loadError}</p>}
      {bcp === null && !loadError && <p className="muted hint">{t('讀取控制點…')}</p>}
      {bcp !== null && n > 0 && (
        <>
          {/* 格子夠寬時示意圖放 BEV 右邊（上下排），BEV 用滿高度；窄的時候放在時間軸下面 */}
          <div className={`bev-stage${sideSketch ? ' with-side' : ''}`}>
            <div className={`bev-canvases ${split ? 'split' : ''}`}>
              {split ? (
                layers.map((l) => <BevCanvas key={l.type} bcp={bcp} cp={cp} only={l.type} rotate={rotate} title={l.type} onWheel={stepBy} onZoom={zoomBy} extras={extras} viewHalfMm={halfMm} />)
              ) : (
                <BevCanvas bcp={bcp} cp={cp} rotate={rotate} title={beam ? `${beam.number} ${beam.name}` : undefined} onWheel={stepBy} onZoom={zoomBy} extras={extras} viewHalfMm={halfMm} />
              )}
            </div>
            {sideSketch && <MachineSketch bcp={bcp} cp={cp} kind={machineKind(bcp)} position={plan.patient_positions[0] ?? 'HFS'} vertical />}
          </div>
          <div className="bev-timeline">
            <button type="button" onClick={() => commit(0)} title={t('第一個控制點')} aria-label={t('第一個控制點')}>
              ⏮
            </button>
            <button type="button" onClick={() => stepBy(-1)} title={t('上一個控制點（←）')} aria-label={t('上一個控制點')}>
              ◀
            </button>
            <button type="button" className="bev-play" aria-pressed={playing} onClick={() => setPlaying((p) => (cp >= n - 1 && !p ? (commit(0), true) : !p))} title={playing ? t('暫停（空白鍵）') : t('播放（空白鍵）')}>
              {playing ? '⏸' : '▶'}
            </button>
            <button type="button" onClick={() => stepBy(1)} title={t('下一個控制點（→）')} aria-label={t('下一個控制點')}>
              ▶|
            </button>
            <button type="button" onClick={() => commit(n - 1)} title={t('最後一個控制點')} aria-label={t('最後一個控制點')}>
              ⏭
            </button>
            <input
              type="range"
              className="bev-slider"
              min={0}
              max={Math.max(0, n - 1)}
              step={1}
              value={cp}
              aria-label={t('控制點')}
              onChange={(e) => {
                setPlaying(false);
                commit(Number(e.target.value));
              }}
            />
            <select value={speed} onChange={(e) => setSpeed(Number(e.target.value))} title={t('播放速度：每秒幾個控制點（不是真實的照射時間）')} aria-label={t('播放速度')}>
              {CP_SPEEDS.map((v) => (
                <option key={v} value={v}>
                  {t('{n} CP/秒', { n: v })}
                </option>
              ))}
            </select>
          </div>
          <p className="bev-readout small">{cpReadout(bcp, cp)}</p>
          {machineOn && !sideSketch && <MachineSketch bcp={bcp} cp={cp} kind={machineKind(bcp)} position={plan.patient_positions[0] ?? 'HFS'} />}
          {machineOn && <p className="muted small">{t('{kind} · {position}', { kind: machineKindText(machineKind(bcp)), position: plan.patient_positions[0] ?? 'HFS' })}</p>}
        </>
      )}
      <p className="muted small plan-disclaimer">{t('示意：只顯示計畫內容，不是照射模擬（不考慮葉片速度與劑量率）。')}</p>
    </div>
  );
}
