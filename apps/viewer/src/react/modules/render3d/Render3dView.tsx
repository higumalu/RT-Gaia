/**
 * 3D 格的後端出圖 —— `viewport-overlay` 面板，只在該格是 3D 時畫。
 *
 * 相機（`camera3d.ts`）：左鍵拖曳繞焦點轉、滾輪前進後退、右鍵／中鍵／Shift＋左鍵平移。
 * 拖曳中每 60 ms 要一張小圖，放手要格子大小的；以請求序號丟掉過期回應。
 * 技法：`composite`（VTK；GPU 優先 CPU 備援）或 `mip`（Rust）。
 */

import { useCallback, useEffect, useRef, useState } from 'react';

import type { ViewerPanelProps } from '../../panels/types';
import { cameraToWire, defaultCamera, dollyByWheel, fitDistance, followCrosshair, isValidCamera, orbit, pan, type Camera3d } from './camera3d';
import { contributed3dLayers, render3dOverlays } from './contrib';
import { exportFileName, exportSize, imagePixelAt, outputSize, RENDER3D_MODULE_ID, render3dLayers, windowOf, type Render3dState } from './model';
import { parseTf, presetTf, TF_PRESETS } from './transferFunction';
import { TF_STORAGE_KEY } from './Render3dSettings';
import { SingleFlight } from './singleFlight';
import { t } from '../../../core/i18n';

const DRAG_THROTTLE_MS = 60;
/** 一次預熱多少個結構的 mesh（進度的粒度）。 */
export const PREPARE_CHUNK = 6;
/** 新出現的結構達到這個數才走預熱（少量直接出圖，省一趟）。 */
export const PREPARE_MIN_NEW = 4;

export function Render3dView({ api, viewportId }: ViewerPanelProps): React.JSX.Element | null {
  const cell = api.state.layout.cells.find((c) => c.cellId === viewportId);
  const is3D = cell !== undefined && cell.content.kind === 'viewport' && cell.content.is3D === true;
  const st = (api.state.modules[RENDER3D_MODULE_ID] as Render3dState | undefined) ?? {};
  const technique = st.technique ?? 'composite';
  const mapper = st.mapper ?? 'auto';
  const primary = api.state.frameGroups.find((f) => f.role === 'primary') ?? null;
  const bounds = primary ? api.commands.seriesGridBounds(primary.seriesId) : null;
  const tf = st.tf ?? presetTf(TF_PRESETS[0]!.id);
  const window3d = windowOf(st);
  const crop = st.crop ?? null;
  const cropKey = crop ? JSON.stringify(crop) : '';
  // 🔴 每次 render 重算：可見性是就地改在同一批物件上，useMemo 依陣列 identity 不會重算
  // 時間序列的相位 ＝ 所屬群組的游標（api.state.temporal）；這一格鎖了相位 → 那一幀
  const locks = viewportId !== undefined ? (api.state.viewportFrames[viewportId] ?? {}) : {};
  const cursorOf = (l: { temporalGroupId?: string | null }): number | null =>
    (l.temporalGroupId ? locks[l.temporalGroupId] : undefined) ?? api.state.temporal.find((g) => g.temporalGroupId === l.temporalGroupId)?.cursor ?? null;
  const ownLayers = render3dLayers(api.state.layers, primary, { technique, window: window3d, tf, frameOf: cursorOf });
  // 其他模組加的圖層（計畫射束）；沒有自己的影像／結構時不單獨出圖
  const layersPayload = ownLayers.length > 0 ? [...ownLayers, ...contributed3dLayers(api.state)] : ownLayers;
  const layersKey = JSON.stringify(layersPayload);
  const displayGridId = api.state.layers.find((l) => l.kind === 'image')?.frameOfReferenceUid ?? '';
  const { setModuleState } = api.commands;
  const { http } = api;

  // 相機：第一次有包圍盒時建預設；之後由模組狀態持有
  const camera: Camera3d | null = isValidCamera(st.camera) ? st.camera : bounds ? defaultCamera(bounds) : null;
  const cameraRef = useRef<Camera3d | null>(camera);
  cameraRef.current = camera;
  useEffect(() => {
    if (!isValidCamera(st.camera) && bounds) setModuleState(RENDER3D_MODULE_ID, { camera: defaultCamera(bounds) });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bounds !== null]);
  // 第一次載入：從瀏覧器讀上次的 TF
  useEffect(() => {
    if (st.tf) return;
    try {
      const saved = parseTf(window.localStorage.getItem(TF_STORAGE_KEY));
      if (saved) setModuleState(RENDER3D_MODULE_ID, { tf: saved });
    } catch {
      // 私密視窗
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const rootRef = useRef<HTMLDivElement | null>(null);
  const [imgUrl, setImgUrl] = useState<string | null>(null);
  const [status, setStatus] = useState<'idle' | 'loading' | 'error'>('idle');
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<{ mapper: string; technique: string; hash: string }>({ mapper: '', technique: '', hash: '' });
  const [dragging, setDragging] = useState<'orbit' | 'pan' | null>(null);
  const seq = useRef(0);
  const lastDragRequest = useRef(0);
  // 同時只飛一個 render3d；已預熱過的結構、預熱進度
  const flight = useRef(new SingleFlight<{ header: Record<string, unknown>; png: Uint8Array }>());
  const prepared = useRef(new Set<string>());
  const [preparing, setPreparing] = useState<{ done: number; total: number } | null>(null);
  const meshIds = layersPayload.flatMap((l) => (l['renderer'] === 'mesh' ? [String(l['structure_id'])] : []));
  const meshKey = meshIds.join('|');
  const drag = useRef<{ x: number; y: number; cam: Camera3d; mode: 'orbit' | 'pan' } | null>(null);
  const cameraKey = camera ? JSON.stringify(camera) : '';
  // 焦點跟著 2D 十字線（第一個 2D 格的 planeOrigin）
  const crosshair = st.followCrosshair ? (api.commands.viewportCameras().find((v) => v.viewportId !== viewportId)?.camera.planeOrigin ?? null) : null;
  const crosshairKey = crosshair ? crosshair.map((v) => Math.round(v * 100) / 100).join(',') : '';
  useEffect(() => {
    if (!crosshair || !camera || dragging !== null) return;
    const next = followCrosshair(camera, [crosshair[0], crosshair[1], crosshair[2]]);
    if (next !== camera) setModuleState(RENDER3D_MODULE_ID, { camera: next });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [crosshairKey, st.followCrosshair]);

  const payloadFor = (cam: Camera3d, size: [number, number], interactive: boolean): Record<string, unknown> => ({
    display_grid_id: displayGridId,
    camera: cameraToWire(cam, primary?.frameOfReferenceUid ?? '', displayGridId),
    output_size_px: size,
    frame_index: null,
    layers: layersPayload,
    technique,
    mapper,
    // 拖曳中的小圖只畫 mesh（伺服器有 mesh 時略過 volume ray-cast）
    interactive,
    ...(crop ? { crop } : {}),
  });

  // 匯出 PNG —— 同一個相機／圖層／裁切，另要一張高解析度（預算內）；失敗就退回目前這張
  const [exporting, setExporting] = useState(false);
  const exportPng = async (): Promise<void> => {
    if (camera === null || primary === null) return;
    setExporting(true);
    const save = (blob: Blob): void => {
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = exportFileName(new Date());
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
    };
    try {
      const s = exportSize(layersPayload.length);
      const { png } = await http.render3d(payloadFor(camera, [s, s], false));
      save(new Blob([png as BlobPart], { type: 'image/png' }));
    } catch (e) {
      if (imgUrl !== null) save(await (await fetch(imgUrl)).blob());
      else setError(e instanceof Error ? e.message : String(e));
    } finally {
      setExporting(false);
    }
  };

  // 反向 pick：雙擊 3D 畫面 → 伺服器用同一個場景沿那條視線找第一個打到的東西 → 2D 十字線移過去
  const lastSize = useRef<[number, number] | null>(null);
  const [pickNote, setPickNote] = useState<string | null>(null);
  const pickAt = async (clientX: number, clientY: number, img: HTMLImageElement): Promise<void> => {
    const cam = cameraRef.current;
    const size = lastSize.current;
    if (cam === null || size === null || api.state.studyId === null) return;
    const px = imagePixelAt(clientX, clientY, img.getBoundingClientRect(), size);
    if (px === null) return;
    try {
      const r = await http.postJson<{ hit: boolean; world: [number, number, number] | null }>(`/studies/${encodeURIComponent(api.state.studyId)}/render3d/pick`, {
        ...payloadFor(cam, size, false),
        pick: { x: px[0], y: px[1] },
      });
      if (r.hit && r.world) {
        api.commands.moveCrosshair(r.world);
        setPickNote(t('十字線移到 ({p0})', { p0: r.world.map((v) => v.toFixed(1)).join(', ') }));
      } else setPickNote(t('那裡沒有打到東西'));
    } catch (e) {
      setPickNote(e instanceof Error ? e.message : String(e));
    }
    setTimeout(() => setPickNote(null), 2500);
  };

  const request = useCallback(
    (cam: Camera3d, small: boolean) => {
      if (!is3D || primary === null || layersPayload.length === 0) return;
      const root = rootRef.current;
      const [w, h] = outputSize(root?.clientWidth ?? 384, root?.clientHeight ?? 384, small);
      const mine = (seq.current += 1);
      setStatus('loading');
      const payload = payloadFor(cam, [w, h], small);
      if (!small) lastSize.current = [w, h];
      flight.current
        .run(() => http.render3d(payload))
        .then(({ header, png }) => {
          if (mine !== seq.current) return;
          const url = URL.createObjectURL(new Blob([png as BlobPart], { type: 'image/png' }));
          setImgUrl((prev) => {
            if (prev) URL.revokeObjectURL(prev);
            return url;
          });
          setInfo({
            mapper: typeof header['mapper_used'] === 'string' ? header['mapper_used'] : '',
            technique: typeof header['technique_used'] === 'string' ? header['technique_used'] : '',
            hash: typeof header['content_hash'] === 'string' ? header['content_hash'].slice(0, 12) : '',
          });
          setStatus('idle');
          setError(null);
        })
        .catch((e: unknown) => {
          if (mine !== seq.current) return;
          setStatus('error');
          setError(e instanceof Error ? e.message : String(e));
        });
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [is3D, primary?.frameOfReferenceUid, layersKey, cropKey, technique, mapper, displayGridId, http],
  );

  // 圖層／TF／相機／裁切變了 → 全解析度重畫（拖曳中不重複）
  /**
   * 一次冒出很多新結構（全顯示）→ 先分批叫 `render3d/prepare` 建 mesh（磁碟快取有就讀），
   * 3D 格顯示「建立 3D 模型 12／35」，全部好了才出圖；少量新結構直接出圖。
   */
  const [prepareTick, setPrepareTick] = useState(0);
  useEffect(() => {
    if (!is3D || technique !== 'composite' || !api.state.studyId) return;
    const fresh = meshIds.filter((id) => !prepared.current.has(id));
    if (fresh.length < PREPARE_MIN_NEW) {
      for (const id of fresh) prepared.current.add(id);
      return;
    }
    let cancelled = false;
    const studyId = api.state.studyId;
    void (async () => {
      setPreparing({ done: 0, total: fresh.length });
      for (let i = 0; i < fresh.length; i += PREPARE_CHUNK) {
        const chunk = fresh.slice(i, i + PREPARE_CHUNK);
        try {
          await http.postJson(`/studies/${encodeURIComponent(studyId)}/render3d/prepare`, { structure_ids: chunk });
        } catch {
          // 預熱失敗不是錯誤：出圖時會自己建
        }
        for (const id of chunk) prepared.current.add(id);
        if (cancelled) return;
        setPreparing({ done: Math.min(fresh.length, i + chunk.length), total: fresh.length });
      }
      setPreparing(null);
      setPrepareTick((t) => t + 1);
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [is3D, technique, meshKey, api.state.studyId]);
  useEffect(() => {
    if (dragging !== null || camera === null || preparing !== null) return;
    request(camera, false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [request, cameraKey, dragging, preparing, prepareTick]);

  useEffect(
    () => () => {
      if (imgUrl) URL.revokeObjectURL(imgUrl);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  useEffect(() => {
    if (dragging === null) return undefined;
    const onMove = (e: PointerEvent): void => {
      const d = drag.current;
      if (d === null) return;
      const dx = e.clientX - d.x;
      const dy = e.clientY - d.y;
      const heightPx = rootRef.current?.clientHeight ?? 400;
      const next = d.mode === 'orbit' ? orbit(d.cam, dx, dy) : pan(d.cam, dx, dy, heightPx);
      setModuleState(RENDER3D_MODULE_ID, { camera: next });
      const now = performance.now();
      if (now - lastDragRequest.current > DRAG_THROTTLE_MS) {
        lastDragRequest.current = now;
        request(next, true);
      }
    };
    const onUp = (): void => {
      drag.current = null;
      setDragging(null);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
  }, [dragging, request, setModuleState]);

  if (!is3D) return null;
  const waiting = primary === null || camera === null ? t('等影像載入…') : layersPayload.length === 0 ? t('沒有可見的影像或結構') : null;
  return (
    <div
      ref={rootRef}
      className="render3d-view"
      data-status={status}
      data-dragging={dragging ?? 'none'}
      onPointerDown={(e) => {
        const cam = cameraRef.current;
        if (!cam) return;
        const mode: 'orbit' | 'pan' | null = e.button === 0 ? (e.shiftKey ? 'pan' : 'orbit') : e.button === 1 || e.button === 2 ? 'pan' : null;
        if (mode === null) return;
        drag.current = { x: e.clientX, y: e.clientY, cam, mode };
        setDragging(mode);
        e.preventDefault();
      }}
      onContextMenu={(e) => e.preventDefault()}
      onDoubleClick={(e) => {
        const img = (e.currentTarget as HTMLElement).querySelector<HTMLImageElement>('.render3d-img');
        if (img !== null && !(e.target as Element).closest('.render3d-bar')) void pickAt(e.clientX, e.clientY, img);
      }}
      onWheel={(e) => {
        e.preventDefault();
        const cam = cameraRef.current;
        if (!cam) return;
        const next = dollyByWheel(cam, e.deltaY);
        cameraRef.current = next;
        setModuleState(RENDER3D_MODULE_ID, { camera: next });
      }}
      title={`${info.technique || technique} · ${info.mapper} · ${info.hash}`}
    >
      {imgUrl !== null && <img className="render3d-img" src={imgUrl} alt={t('3D 出圖')} draggable={false} />}
      {waiting !== null && imgUrl === null && <div className="render3d-waiting muted">{waiting}</div>}
      {pickNote !== null && <div className="render3d-pick-note" role="status">{pickNote}</div>}
      {render3dOverlays().map(([id, Overlay]) => (
        <div key={id} className="render3d-overlay" onPointerDown={(e) => e.stopPropagation()} onWheel={(e) => e.stopPropagation()} onDoubleClick={(e) => e.stopPropagation()}>
          <Overlay api={api} />
        </div>
      ))}
      <div className="render3d-bar" onPointerDown={(e) => e.stopPropagation()}>
        <span className="badge badge-registered" title={t('由伺服器出圖的靜態 3D（拖曳後重新請求一張）；GPU／CPU 指伺服器端的 mapper，與這台電腦的顯卡無關')}>
          {technique === 'mip' ? t('3D 靜態出圖 · MIP') : t('3D 靜態出圖 · 體積渲染{p0}', { p0: info.mapper ? t('（伺服器 {p0}）', { p0: info.mapper.toUpperCase() }) : '' })}
        </span>
        <button type="button" onClick={() => bounds && setModuleState(RENDER3D_MODULE_ID, { camera: defaultCamera(bounds) })} title={t('回到前方視角')}>
          {t('回正面')}
        </button>
        <button type="button" onClick={() => bounds && camera && setModuleState(RENDER3D_MODULE_ID, { camera: fitDistance(camera, bounds) })} title={t('保留方向、重設距離')}>
          Fit
        </button>
        <button type="button" onClick={() => camera && request(camera, false)} title={t('重新向後端要一張')}>
          {t('重畫')}
        </button>
        <button type="button" disabled={exporting || imgUrl === null || dragging !== null} onClick={() => void exportPng()} title={t('以目前的相機、圖層、裁切另出一張高解析度 PNG 並下載')}>
          {exporting ? t('匯出中…') : t('匯出 PNG')}
        </button>
        {crop && <span className="badge badge-registered" title={t('渲染範圍已裁切（右側「3D」面板調整）')}>{t('裁切')}</span>}
        <span className="muted render3d-status" role="status">
          {preparing !== null
            ? t('建立 3D 模型 {done}／{total}…', { done: preparing.done, total: preparing.total })
            : status === 'loading'
              ? t('更新中…')
              : status === 'error'
                ? t('失敗：{p0}', { p0: error ?? '' })
                : t('左鍵轉 · 滾輪前後 · 右鍵平移 · 雙擊：十字線移到那裡')}
        </span>
      </div>
    </div>
  );
}
