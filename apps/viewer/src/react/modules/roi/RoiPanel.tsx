/**
 * ROI 編輯面板（對照 Slicer Segment Editor）—— `right-sidebar`，`'roi'` 模式開著時。
 *
 * 分區：作用中結構（改名／改色／新建 ＋ TG-263／複製／刪除）、手繪（筆刷／橡皮擦／閾值筆刷／圈選 ＋ 參數）、
 * 區域生長、閾值分割、後處理（表單由 `GET /ops` schema 生成）。所有後端運算結果都可 undo。
 */

import { useEffect, useMemo, useState } from 'react';

import { collabApi } from '../../collab/collabApi';
import { readOnlyReason } from '../../collab/model';

import { DEFAULT_THRESHOLD_HU, toDisplayValue, toStoredValue, valueScaleOf, type OpDescriptor } from '../../../core';
import { windowTargetId } from '../../panels/dataModel';
import type { ViewerPanelProps } from '../../panels/types';
import { ROI_MODULE_ID } from './mode';
import { statusLabel } from '../review/model';
import { defaultParams, hexRgb, missingRequired, nextColor, rgbHex, tg263Adoptable, tg263Text } from './model';
import { OpForm } from './OpForm';
import { joinList, msg, t } from '../../../core/i18n';

const DRAW_TOOLS = [
  { id: 'brush', label: msg('筆刷') },
  { id: 'eraser', label: msg('橡皮擦') },
  { id: 'threshold-brush', label: msg('閾值筆刷') },
  { id: 'scissors', label: msg('圈選') },
] as const;

const DEDICATED_OPS = new Set(['threshold', 'region_grow']);

export interface RoiLogEntry {
  readonly at: string;
  readonly text: string;
}

export function RoiPanel({ api }: ViewerPanelProps): React.JSX.Element {
  const { structures, activeStructureId, brush, activeToolId, frameGroups, structureSets } = api.state;
  const active = structures.find((s) => s.structureId === activeStructureId) ?? null;
  const [ops, setOps] = useState<readonly OpDescriptor[] | null>(null);
  const [newForUid, setNewForUid] = useState<string | null>(null);
  const [mergeBusy, setMergeBusy] = useState(false);
  const [opId, setOpId] = useState<string>('fill_holes');
  const [opParams, setOpParams] = useState<Record<string, unknown>>({});
  const [growParams, setGrowParams] = useState<Record<string, unknown> | null>(null);
  const [thParams, setThParams] = useState<Record<string, unknown> | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState('');
  const [newColor, setNewColor] = useState<[number, number, number]>(() => nextColor(structures.map((s) => s.colorRgb ?? [255, 0, 0])));
  const [tg263, setTg263] = useState<{ readonly text: string; readonly adopt: string | null } | null>(null);
  const [nameDraft, setNameDraft] = useState<string | null>(null);
  const log = ((api.state.modules[ROI_MODULE_ID] as { log?: RoiLogEntry[] } | undefined)?.log ?? []);
  const lassoMode = ((api.state.modules[ROI_MODULE_ID] as { lassoMode?: 'add' | 'subtract' } | undefined)?.lassoMode ?? 'add');

  useEffect(() => {
    let alive = true;
    api.commands
      .listOps()
      .then((list) => {
        if (!alive) return;
        setOps(list);
        const grow = list.find((o) => o.op === 'region_grow');
        const th = list.find((o) => o.op === 'threshold');
        if (grow) setGrowParams(defaultParams(grow));
        if (th) setThParams(defaultParams(th));
        const first = list.find((o) => !DEDICATED_OPS.has(o.op));
        if (first) {
          setOpId(first.op);
          setOpParams(defaultParams(first));
        }
      })
      .catch((e: unknown) => api.commands.setError(t('讀取運算清單失敗：{p0}', { p0: e instanceof Error ? e.message : String(e) })));
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const currentOp = ops?.find((o) => o.op === opId) ?? null;
  const growOp = ops?.find((o) => o.op === 'region_grow') ?? null;
  const thOp = ops?.find((o) => o.op === 'threshold') ?? null;
  // 作用中的結構在時間軸上 → 目前畫在哪一幀；布林運算的另一個結構要在這一幀也有（只在其他相位的不列）
  const activeLayer = api.state.layers.find((l) => l.kind === 'mask' && l.contentRef === activeStructureId) ?? null;
  const phaseGroup = activeLayer?.temporalGroupId ? (api.state.temporal.find((g) => g.temporalGroupId === activeLayer.temporalGroupId) ?? null) : null;
  const phaseFrame = phaseGroup ? api.commands.drawingFrame(phaseGroup.temporalGroupId) : null;
  const framesOf = (sid: string): readonly number[] | undefined => api.state.layers.find((l) => l.kind === 'mask' && l.contentRef === sid)?.frames;
  const others = useMemo(
    () =>
      structures.filter((s) => {
        if (s.structureId === activeStructureId || (active && s.frameOfReferenceUid !== active.frameOfReferenceUid)) return false;
        const f = framesOf(s.structureId);
        return phaseFrame === null || f === undefined || f.includes(phaseFrame);
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [structures, activeStructureId, active, phaseFrame, api.state.layers],
  );
  const [overwriteFrames, setOverwriteFrames] = useState(false);

  const pushLog = (text: string) => {
    const next = [{ at: new Date().toLocaleTimeString(), text }, ...log].slice(0, 20);
    api.commands.setModuleState(ROI_MODULE_ID, { log: next });
  };
  const run = (label: string, fn: () => Promise<unknown>): void => {
    setBusy(label);
    void fn()
      .then(() => pushLog(label))
      .catch((e: unknown) => api.commands.setError(t('{label} 失敗：{p1}', { label, p1: e instanceof Error ? e.message : String(e) })))
      .finally(() => setBusy(null));
  };
  const currentSlice = (): number | null => {
    const vp = api.state.viewports.find((v) => v.orientation === 'axial') ?? api.state.viewports[0];
    if (!vp) return null;
    const m = /^(\d+)\s*\//.exec(api.commands.sliceLabel(vp.viewportId));
    return m ? Number(m[1]) - 1 : null;
  };
  const probeSeed = (): [number, number, number] | null => api.commands.probeVoxel()?.ijk ?? null;
  const huRange = brush.huRange ?? DEFAULT_THRESHOLD_HU;
  // 閾值筆刷看作用中影像的值 —— PET 換成 SUV 時欄位用 SUV（存的是 ×100），單位跟著影像
  const targetId = windowTargetId(api.state.layers, api.state.activeImageLayerId);
  const vs = valueScaleOf(api.state.layers.find((l) => l.layerId === targetId));
  const rangeStep = vs.scale !== 1 ? 0.5 : 50;
  // 閾值分割／區域生長在後端用「這個結構 FoR 的第一張影像」（`image_series_for`，資料集順序 ＝ 初始圖層順序）；
  // 區間的單位跟著它（後端已把 PET 換成 SUV 再比）
  const opImage = active
    ? [...api.state.layers].filter((l) => l.kind === 'image' && l.frameOfReferenceUid === active.frameOfReferenceUid && l.frameIndex === undefined).sort((a, b) => a.order - b.order)[0]
    : undefined;
  const opUnit = valueScaleOf(opImage).unit;
  const primaryFor = frameGroups.find((f) => f.role === 'primary')?.frameOfReferenceUid;
  const volumeText = active ? (Array.isArray(active.volumeCc) ? `${active.volumeCc[0]?.toFixed(1) ?? '–'} cc` : `${active.volumeCc.toFixed(1)} cc`) : '';

  return (
    <div className="slab-panel roi-panel">
      <header className="slab-header">
        {t('ROI 編輯')}
        <span className="slab-header-actions">
          <button type="button" className="reset" aria-pressed={creating} onClick={() => { setCreating((v) => !v); setNewColor(nextColor(structures.map((s) => s.colorRgb ?? [255, 0, 0]))); }}>
            {t('新建')}
          </button>
        </span>
      </header>

      {creating && (
        <div className="slab-row roi-create">
          <input className="roi-name" placeholder={t('結構名稱（例：PTV_7000）')} value={newName} onChange={(e) => setNewName(e.target.value)} />
          <input type="color" value={rgbHex(newColor)} onChange={(e) => setNewColor(hexRgb(e.target.value))} title={t('顏色')} />
          {frameGroups.length > 1 && (
            <select className="roi-set" value={newForUid ?? primaryFor ?? ''} title={t('新結構掛在哪一組影像（進我在那組影像的工作集）')} onChange={(e) => setNewForUid(e.target.value || null)}>
              {frameGroups.map((fg) => (
                <option key={fg.frameOfReferenceUid} value={fg.frameOfReferenceUid}>
                  {fg.role === 'primary' ? t('主要影像') : t('次要影像')} …{fg.frameOfReferenceUid.slice(-8)}
                </option>
              ))}
            </select>
          )}
          {structureSets.length > 0 && <span className="muted small">{t('→ 我的結構集')}</span>}
          <button
            type="button"
            className="reset"
            disabled={!newName.trim() || busy !== null}
            onClick={() =>
              run(t('新建 {p0}', { p0: newName.trim() }), async () => {
                // 新建一律進我在該組影像的工作集（後端自動建）
                const forUid = newForUid ?? primaryFor;
                const out = await api.commands.createStructure({ name: newName.trim(), colorRgb: newColor, ...(forUid ? { frameOfReferenceUid: forUid } : {}) });
                const text = tg263Text(out.tg263Suggestion);
                setTg263(text ? { text, adopt: tg263Adoptable(out.tg263Suggestion) } : null);
                api.commands.setActiveStructure(out.structureId);
                setNewName('');
                setCreating(false);
              })
            }
          >
            {t('建立')}
          </button>
        </div>
      )}
      {tg263 && (
        <div className="slab-row roi-tg263">
          <span className="muted">{tg263.text}</span>
          {active && tg263.adopt && (
            <button type="button" className="mini" disabled={readOnlyReason(active) !== null} onClick={() => run(t('採用 TG-263 名稱'), async () => { await api.commands.updateStructureMeta(active.structureId, { name: tg263.adopt! }); setTg263(null); })}>
              {t('採用')}
            </button>
          )}
          <button type="button" className="mini" onClick={() => setTg263(null)}>✕</button>
        </div>
      )}

      {active !== null && active.editable !== false && active.status === 'approved' && (
        <div className="slab-row roi-readonly">
          <span className="warning">{readOnlyReason(active)}</span>
        </div>
      )}
      {active !== null && active.editable === false && (
        <div className="slab-row roi-readonly">
          <span className="warning">{readOnlyReason(active)}</span>
          <button
            type="button"
            className="mini"
            disabled={mergeBusy || !api.state.caseId}
            title={t('複製一份到我的結構集並切換過去')}
            onClick={() =>
              run(t('合併到我的結構集'), async () => {
                setMergeBusy(true);
                try {
                  const out = await collabApi.merge(api.state.caseId as string, [active.structureId], { [active.structureId]: 'rename' });
                  await api.commands.refreshStructures();
                  await api.commands.refreshStructureSets();
                  const mine = out.merged[0]?.structure_id;
                  if (mine) api.commands.setActiveStructure(mine);
                } finally {
                  setMergeBusy(false);
                }
              })
            }
          >
            {t('合併到我的結構集')}
          </button>
        </div>
      )}
      {active === null ? (
        <p className="muted hint" style={{ padding: '6px 10px' }}>{api.state.formFactor === 'phone' ? t('在上面「編輯對象」選一個結構（或按「新建」）。') : t('在左側資料面板點一個結構（或按「新建」）。')}</p>
      ) : (
        <div className="slab-row roi-active">
          <input type="color" value={rgbHex(active.colorRgb ?? [255, 0, 0])} title={readOnlyReason(active) ?? t('顏色')} disabled={readOnlyReason(active) !== null} onChange={(e) => run(t('改色'), () => api.commands.updateStructureMeta(active.structureId, { colorRgb: hexRgb(e.target.value) }))} />
          <input
            className="roi-name"
            value={nameDraft ?? active.name ?? active.structureId}
            readOnly={readOnlyReason(active) !== null}
            title={readOnlyReason(active) ?? t('改名（Enter 或離開欄位生效）')}
            onChange={(e) => setNameDraft(e.target.value)}
            onBlur={() => { if (nameDraft !== null && nameDraft.trim() && nameDraft !== active.name) run(t('改名'), () => api.commands.updateStructureMeta(active.structureId, { name: nameDraft.trim() })); setNameDraft(null); }}
            onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
          />
          <span className="muted">{volumeText} · {statusLabel(active.status)}</span>
          <button type="button" className="mini" title={t('複製成新結構')} onClick={() => run(t('複製'), async () => { const out = await api.commands.duplicateStructure(active.structureId); api.commands.setActiveStructure(out.structureId); })}>{t('複製')}</button>
          <button type="button" className="mini danger" title={t('刪除（不可復原）')} onClick={() => { if (window.confirm(t('刪除「{p0}」？不可復原。', { p0: active.name ?? active.structureId }))) run(t('刪除'), () => api.commands.deleteStructure(active.structureId)); }}>{t('刪除')}</button>
        </div>
      )}

      {active !== null && phaseGroup !== null && activeLayer?.frames && phaseFrame !== null && (
        <div className="slab-row roi-section roi-phase" data-frames={activeLayer.frames.join(',')}>
          <span className="muted roi-section-title">{t('相位')}</span>
          <span className="muted small">
            {t('在 {n}／{total} 幀；現在畫在 {label}', {
              n: activeLayer.frames.length,
              total: phaseGroup.frameCount ?? 1,
              label: phaseGroup.frameLabels?.[phaseFrame] || `#${phaseFrame + 1}`,
            })}
          </span>
          <button
            type="button"
            className="mini"
            disabled={busy !== null || active.editable === false || !activeLayer.frames.includes(phaseFrame) || (!overwriteFrames && activeLayer.frames.length >= (phaseGroup.frameCount ?? 1))}
            title={!activeLayer.frames.includes(phaseFrame) ? t('這一幀沒有這個結構；先切到有它的相位') : t('把這一幀的輪廓複製到其他相位（預設只補還沒有的幀）')}
            onClick={() =>
              run(t('複製到其他相位'), async () => {
                const out = await api.commands.propagateStructureFrames(active.structureId, { sourceFrame: phaseFrame, overwrite: overwriteFrames });
                pushLog(t('補了 {a} 幀、蓋掉 {r} 幀、略過 {k} 幀', { a: out.added.length, r: out.replaced.length, k: out.skipped.length }));
              })
            }
          >
            {t('複製這一幀到其他相位')}
          </button>
          <label className="small" title={t('勾了會把其他相位已經畫好的輪廓換成這一幀的')}>
            <input type="checkbox" checked={overwriteFrames} onChange={(e) => setOverwriteFrames(e.target.checked)} />
            {t('蓋掉已有的')}
          </label>
        </div>
      )}

      <div className="slab-row roi-section">
        <span className="muted roi-section-title">{t('手繪')}</span>
        <span className="slab-presets">
          {DRAW_TOOLS.map((tool) => (
            <button key={tool.id} type="button" aria-pressed={activeToolId === tool.id} disabled={active === null} onClick={() => api.commands.setActiveTool(activeToolId === tool.id ? 'navigate' : tool.id)}>
              {t(tool.label)}
            </button>
          ))}
        </span>
      </div>
      {(activeToolId === 'brush' || activeToolId === 'eraser' || activeToolId === 'threshold-brush') && (
        <div className="slab-row roi-brush">
          <span className="muted">{t('半徑')}</span>
          <input type="range" min={0.5} max={30} step={0.5} value={brush.radiusMm} onChange={(e) => api.commands.setBrush({ radiusMm: Number(e.target.value) })} />
          <span className="render3d-range">{brush.radiusMm.toFixed(1)} mm</span>
          <select value={brush.shape} onChange={(e) => api.commands.setBrush({ shape: e.target.value as 'sphere' | 'disc' })}>
            <option value="sphere">{t('球（跨切面）')}</option>
            <option value="disc">{t('圓（單一平面）')}</option>
          </select>
          {activeToolId === 'threshold-brush' && (
            <span className="roi-inline" title={t('閾值筆刷只作用於此區間內的體素（作用中影像的值）')}>
              {vs.unit}
              <input type="number" className="num" step={rangeStep} value={toDisplayValue(huRange[0], vs)} onChange={(e) => api.commands.setBrush({ huRange: [toStoredValue(Number(e.target.value), vs), huRange[1]] })} />
              {t('～')}
              <input type="number" className="num" step={rangeStep} value={toDisplayValue(huRange[1], vs)} onChange={(e) => api.commands.setBrush({ huRange: [huRange[0], toStoredValue(Number(e.target.value), vs)] })} />
            </span>
          )}
        </div>
      )}
      {activeToolId === 'scissors' && (
        <div className="slab-row roi-brush">
          <span className="muted">{t('圈選')}</span>
          <span className="slab-presets">
            <button type="button" aria-pressed={lassoMode === 'add'} onClick={() => { api.commands.setModuleState(ROI_MODULE_ID, { lassoMode: 'add' }); api.commands.setToolParams({ lasso: { mode: 'add' } }); }}>{t('加入')}</button>
            <button type="button" aria-pressed={lassoMode === 'subtract'} onClick={() => { api.commands.setModuleState(ROI_MODULE_ID, { lassoMode: 'subtract' }); api.commands.setToolParams({ lasso: { mode: 'subtract' } }); }}>{t('移除')}</button>
          </span>
          <span className="muted hint">{api.state.formFactor === 'desktop' ? t('逐點點擊，點回起點或 Enter 收口，Esc 取消') : t('逐點點，點回起點、點兩下或按「完成」收口；「取消」放棄')}</span>
        </div>
      )}

      {growOp && growParams && (
        <div className="slab-row roi-section roi-op">
          <span className="muted roi-section-title">{t('區域生長')}</span>
          <OpForm op={growOp} params={growParams} onChange={setGrowParams} otherStructures={others} currentSlice={currentSlice} probeSeed={probeSeed} valueUnit={opUnit} />
          <button type="button" className="reset" disabled={active === null || busy !== null || missingRequired(growOp, growParams).length > 0} title={joinList(missingRequired(growOp, growParams)) || t('執行')} onClick={() => active && run(t('區域生長'), () => api.commands.runPostprocess(active.structureId, 'region_grow', growParams))}>
            {t('執行')}
          </button>
        </div>
      )}
      {thOp && thParams && (
        <div className="slab-row roi-section roi-op">
          <span className="muted roi-section-title">{t('閾值分割')}</span>
          <OpForm op={thOp} params={thParams} onChange={setThParams} otherStructures={others} currentSlice={currentSlice} probeSeed={probeSeed} valueUnit={opUnit} />
          <button type="button" className="reset" disabled={active === null || busy !== null} onClick={() => active && run(t('閾值分割'), () => api.commands.runPostprocess(active.structureId, 'threshold', thParams))}>
            {t('執行')}
          </button>
        </div>
      )}

      <div className="slab-row roi-section roi-op">
        <span className="muted roi-section-title">{t('後處理')}</span>
        {ops === null ? (
          <span className="muted hint">{t('讀取運算清單…')}</span>
        ) : (
          <>
            <select value={opId} onChange={(e) => { setOpId(e.target.value); const o = ops.find((x) => x.op === e.target.value); if (o) setOpParams(defaultParams(o)); }}>
              {ops.filter((o) => !DEDICATED_OPS.has(o.op)).map((o) => (
                <option key={o.op} value={o.op} title={o.description}>
                  {o.label}
                </option>
              ))}
            </select>
            {currentOp && (
              <>
                <span className="muted hint">{currentOp.description}</span>
                <OpForm op={currentOp} params={opParams} onChange={setOpParams} otherStructures={others} currentSlice={currentSlice} probeSeed={probeSeed} valueUnit={opUnit} />
                <button type="button" className="reset" disabled={active === null || busy !== null || missingRequired(currentOp, opParams).length > 0} title={joinList(missingRequired(currentOp, opParams)) || t('執行')} onClick={() => active && run(currentOp.label, () => api.commands.runPostprocess(active.structureId, currentOp.op, opParams))}>
                  {t('執行')}
                </button>
              </>
            )}
          </>
        )}
      </div>

      <div className="slab-row">
        <button type="button" className="reset" disabled={!api.state.canUndo} onClick={api.commands.undo}>{t('復原')}</button>
        <button type="button" className="reset" disabled={!api.state.canRedo} onClick={api.commands.redo}>{t('重做')}</button>
        {busy && <span className="muted">{busy}…</span>}
        {log[0] && <span className="muted hint">{t('上次：{at} {text}', { at: log[0].at, text: log[0].text })}</span>}
      </div>
    </div>
  );
}
