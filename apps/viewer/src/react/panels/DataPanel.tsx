/**
 * 「資料」面板 —— `left-sidebar`（3D Slicer 的 Data ＋ Volumes 的合體）。
 *
 * 依 FrameGroup（FoR）分組：每組一個標題（模態、日期、描述、對位狀態、「套用對位」
 * 開關、「只看這組」），底下影像列（眼睛、不透明度、W/L 預設＋數值、色階、作用中）、
 * 劑量列（眼睛、不透明度、colorwash／等劑量線、絕對／%、參考劑量、閾值、level、色階）、
 * 結構清單（沿用 `StructureList`，批次開關只作用在這一組）。
 *
 * 純邏輯在 `dataModel.ts`；這裡只有版面與 `api.commands` 的接線。
 */

import { useEffect, useState } from 'react';

import { doseDisplayOf, dosePlanName, getUserIsodoseDefault, isBodyLikeStructure, MAX_FILL_STRUCTURES, toDisplayValue, toStoredValue, valueScaleOf, VISIBLE_STRUCTURE_LIMIT, type Layer, type TemporalState } from '../../core';
import { MergeDialog } from '../collab/MergeDialog';
import { StructureSetDialog } from '../collab/StructureSetDialog';
import { ComposeDialog } from '../modules/temporal/ComposeDialog';
import { deleteConfirmText, describeSetError } from '../collab/structureSetActions';
import { editorsByStructure, onlineUsers } from '../collab/model';
import type { StructureSetInfo } from '../../core/panels/api';
import { StructureList, type StructureRow } from '../components/StructureList';
import {
  BLEND_MODES,
  DOSE_COLORMAPS,
  groupLayersByFrame,
  IMAGE_COLORMAPS,
  imageRowName,
  opacityFromPercent,
  opacityPercent,
  presetIdFor,
  registrationBadge,
  soloVisibility,
  withPendingOverride,
  type WindowPreset,
  addUserPreset,
  allPresets,
  isUserPreset,
  readUserPresets,
  removeUserPreset,
  writeUserPresets,
  type FrameGroupView,
  rowExpanded,
  windowTargetId,
} from './dataModel';
import type { ViewerPanelProps } from './types';
import { joinList, t } from '../../core/i18n';
import { prefStorage } from '../prefs/prefs';
import { saveIsodoseDefault } from '../prefs/isodoseDefault';
import { fmtLevelGy, isodoseLevelsText, isodoseSourceLabel, percentsOf } from './doseLevels';

export function DataPanel({ api }: ViewerPanelProps): React.JSX.Element {
  // 卸載結果提示；hooks 一律放函式頂端
  const [dropped, setDropped] = useState<string | null>(null);
  const hiddenCount = api.state.layers.filter((l) => !l.visible && (l.kind === 'image' || l.kind === 'dose' || l.kind === 'mask')).length;
  const groups = groupLayersByFrame(api.state.layers, api.state.frameGroups);
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  // 「合併到我的…」對話框（來源集 ＋ 預選的結構）
  const [merge, setMerge] = useState<{ setId: string; structureIds?: readonly string[] } | null>(null);
  const me = api.state.user?.username ?? null;
  const online = onlineUsers(api.state.presence);
  if (groups.length === 0) return <p className="muted data-empty">{t('尚未載入任何序列')}</p>;
  const mergeSource = merge ? api.state.structureSets.find((s) => s.structureSetId === merge.setId) ?? null : null;
  return (
    <div className="data-panel">
      {/* 分層卸載 —— 沒顯示的影像／劑量 lod 0 與結構 mask 體素從瀏覽器釋放；勾回顯示時再抓 */}
      {hiddenCount > 0 && api.state.caseId && (
        <div className="drop-hidden">
          <button
            type="button"
            title={t('釋放沒顯示的影像／劑量全解析度體素與結構 mask（wasm 記憶體）；再勾選顯示會重新從伺服器抓')}
            onClick={() => {
              const r = api.commands.dropHiddenVolumes();
              const mb = (b: number): string => `${(b / 1e6).toFixed(0)} MB`;
              setDropped(r.count === 0 ? t('沒有可卸載的體素（未顯示的都還沒載入）') : t('已卸載 {count} 個：影像／劑量 {p1}、結構 {p2}', { count: r.count, p1: mb(r.imageBytes), p2: mb(r.maskBytes) }));
            }}
          >
            {t('卸載未顯示的（{hiddenCount}）', { hiddenCount })}
          </button>
          {dropped && <span className="muted small">{dropped}</span>}
        </div>
      )}
      {online.length > 0 && (
        <p className="presence muted" title={t('有 WS 連線的人')}>
          {t('在線：{p0}', { p0: joinList(online.map((u) => (u === me ? t('{u}（我）', { u }) : u))) })}
        </p>
      )}
      {groups.map((g) => (
        <FrameGroupSection
          key={g.frameOfReferenceUid}
          group={g}
          groups={groups}
          api={api}
          collapsed={collapsed[g.frameOfReferenceUid] ?? false}
          onCollapse={(v) => setCollapsed((c) => ({ ...c, [g.frameOfReferenceUid]: v }))}
          me={me}
          online={online}
          onMerge={(setId, structureIds) => setMerge(structureIds ? { setId, structureIds } : { setId })}
        />
      ))}
      {merge && mergeSource && (
        <MergeDialog
          api={api}
          sourceSet={mergeSource}
          {...(merge.structureIds ? { preselected: merge.structureIds } : {})}
          onClose={() => setMerge(null)}
          onMerged={(result) => {
            // 合併一個 → 直接把新的那個設為編輯對象
            const first = result.merged.find((m) => m.structure_id && m.action !== 'skip');
            if (first?.structure_id && merge.structureIds?.length === 1) api.commands.setActiveStructure(first.structure_id);
          }}
        />
      )}
    </div>
  );
}

function FrameGroupSection(props: {
  group: FrameGroupView;
  groups: readonly FrameGroupView[];
  api: ViewerPanelProps['api'];
  collapsed: boolean;
  onCollapse: (v: boolean) => void;
  me: string | null;
  online: readonly string[];
  onMerge: (setId: string, structureIds?: readonly string[]) => void;
}): React.JSX.Element {
  const { group: g, api } = props;
  // 結構清單預設只有 primary 展開：35 個結構會把其他 FrameGroup 推到捲軸下面，
  // 使用者根本看不到還有 CBCT 可以打開（實測）。
  const [structuresOpen, setStructuresOpen] = useState(g.role === 'primary');
  // 新建／編輯結構集的對話框；null ＝ 關
  const [setDialog, setSetDialog] = useState<{ set: StructureSetInfo | null } | null>(null);
  const setsBase = api.state.caseId ? `/cases/${encodeURIComponent(api.state.caseId)}/structure-sets` : null;
  const refreshSets = (): Promise<void> => api.commands.refreshStructureSets().then(() => api.commands.refreshStructures());
  const fail = (e: unknown): void => api.commands.setError(describeSetError(e instanceof Error ? e.message : String(e)));
  const visibleMasks = g.masks.filter((l) => l.visible).length;
  const disabled = api.state.disabledTransforms.includes(g.frameOfReferenceUid);
  const pending = api.state.transformOverrides.some((o) => o.frameOfReferenceUid === g.frameOfReferenceUid);
  const badge = registrationBadge(withPendingOverride(g.frameGroup, api.state.transformOverrides), disabled, pending);
  // 別人正在編輯的結構（presence）
  const editors = editorsByStructure(api.state.presence, api.state.user?.username);
  const structureRows: StructureRow[] = g.masks.map((layer) => {
    const meta = api.state.structures.find((s) => s.structureId === layer.contentRef);
    const substitute = api.state.substitutes.find((s) => s.layerId === layer.layerId);
    return {
      layer,
      status: meta?.status ?? 'ai_generated',
      volumeCc: meta?.volumeCc ?? 0,
      substituteNotice: substitute?.notice ?? null,
      structureSetId: meta?.structureSetId ?? null,
      editable: meta?.editable ?? true,
      bodyLike: isBodyLikeStructure({ name: meta?.name ?? layer.label, interpretedType: meta?.interpretedType ?? null }),
      frameNote: frameNoteOf(layer, api.state.temporal),
      editors: editors.get(layer.contentRef) ?? [],
    };
  });
  // 這一組（FoR）底下的結構集 —— 多套 RTSTRUCT 掛同一組影像時，結構清單以它分層
  const setsHere = api.state.structureSets.filter((s) => s.frameOfReferenceUid === g.frameOfReferenceUid);
  const knownSetIds = new Set(setsHere.map((s) => s.structureSetId));
  // 這一組有兩張以上的單張影像 → 可以組成 4D（從資料庫開的病例才行：組成會改病例的選取）
  const staticImages = g.images.filter((l) => !l.temporalGroupId);
  const [composing, setComposing] = useState(false);
  return (
    <section className="frame-group" data-role={g.role}>
      <header className="frame-group-header">
        <button type="button" className="collapse" onClick={() => props.onCollapse(!props.collapsed)} title={t('收合')}>
          {props.collapsed ? '▸' : '▾'}
        </button>
        <div className="frame-group-title" title={g.subtitle ? `${g.title} ${g.subtitle}` : g.title}>
          <strong>{g.title}</strong>
          {g.subtitle && <span className="muted"> {g.subtitle}</span>}
        </div>
        <button
          type="button"
          className="solo"
          title={t('只顯示這一組的影像（其他組的影像與劑量隱藏）')}
          onClick={() => {
            for (const [layerId, visible] of soloVisibility(props.groups, g.frameOfReferenceUid)) {
              api.commands.setVisible(layerId, visible);
            }
          }}
        >
          {t('只看')}
        </button>
        {staticImages.length >= 2 && api.state.usesStructureSets && (
          <button type="button" className="solo compose-4d" title={t('把這一組的幾張影像組成一條時間軸（4D），可以播放、逐幀標記')} onClick={() => setComposing(true)}>
            {t('組成 4D')}
          </button>
        )}
        {composing && <ComposeDialog api={api} images={staticImages} onClose={() => setComposing(false)} />}
        {/* 對位徽章、套用對位放第二列 —— 跟標題擠同一列時，secondary 的標題被擠到只剩「C…」。
            「只看」很窄，留在第一列標題右邊 */}
        <div className="frame-group-actions">
          <span className={`badge badge-${badge.kind}`} title={badge.detail}>
            {badge.text}
          </span>
          {g.role === 'secondary' && badge.canToggle && (
            <label className="apply-reg" title={t('關掉時整組（影像、劑量、結構）以單位矩陣擺放 —— 用來對照對位前後')}>
              <input
                type="checkbox"
                checked={!disabled}
                onChange={(e) => api.commands.setTransformEnabled(g.frameOfReferenceUid, e.target.checked)}
              />
              {t('套用對位')}
            </label>
          )}
        </div>
      </header>
      {!props.collapsed && (
        <>
          {g.images.map((layer) => (
            <ImageRow key={layer.layerId} layer={layer} api={api} name={imageRowName(layer, g.images.length)} />
          ))}
          {/* 劑量是空間裡的 3D 物件 —— 統一列在左側「劑量」面板（模組 doseops），這裡只留一行指引 */}
          {g.doses.length > 0 && (
            <p className="muted small dose-moved-hint">{t('{n} 個劑量 → 見「劑量」面板', { n: g.doses.length })}</p>
          )}
          {/* 2026-09-24：library 病例的主影像組一律有結構區（沒有 RS、或唯一那套是空的時候也要能「＋ 新結構集」、看到集標題） */}
          {(structureRows.length > 0 || setsHere.length > 0 || (api.state.usesStructureSets && g.role === 'primary')) && (
            <div className="structures-block">
              <button
                type="button"
                className="structures-toggle"
                aria-expanded={structuresOpen}
                onClick={() => setStructuresOpen((v) => !v)}
              >
                {t('{p0} 結構（{length}，顯示 {visibleMasks}{p3}）', { p0: structuresOpen ? '▾' : '▸', length: structureRows.length, visibleMasks, p3: setsHere.length >= 2 ? t('，{length} 套 RS', { length: setsHere.length }) : '' })}
                {api.state.maskLoading && (
                  <span className="mask-loading" role="status" aria-live="polite">
                    {t('載入結構{done}／{total}…', { done: api.state.maskLoading.done, total: api.state.maskLoading.total })}
                  </span>
                )}
              </button>
              {structuresOpen && (
                <StructureList
                  rows={structureRows}
                  visibleLimit={VISIBLE_STRUCTURE_LIMIT.outline}
                  activeStructureId={api.state.activeStructureId}
                  onSelect={(structureId) => {
                    const result = api.commands.setActiveStructure(structureId);
                    api.commands.setError(result.ok ? null : result.reason);
                  }}
                  onToggle={api.commands.setVisible}
                  loading={api.state.maskLoading}
                  // 批次開關只作用在**這一組**的結構（後端的 groupId 仍是全域常數）
                  onToggleGroup={(_groupId, visible) => {
                    for (const layer of g.masks) api.commands.setVisible(layer.layerId, visible);
                  }}
                  structureSets={setsHere}
                  onTransient={(setId, action) => {
                    const ids = api.state.structures.filter((s) => s.structureSetId === setId).map((s) => s.structureId);
                    if (!api.state.caseId || ids.length === 0) return;
                    void api.http
                      .postJson(`/cases/${encodeURIComponent(api.state.caseId)}/transient/${action}`, { structure_ids: ids })
                      .then(() => api.commands.refreshStructureSets())
                      .then(() => api.commands.refreshStructures())
                      .catch((e: unknown) => api.commands.setError(e instanceof Error ? e.message : String(e)));
                  }}
                  me={props.me}
                  onlineUsers={props.online}
                  onMerge={props.onMerge}
                  onToggleSet={(setId, visible) => {
                    for (const row of structureRows) {
                      const inSet = setId === null ? !row.structureSetId || !knownSetIds.has(row.structureSetId) : row.structureSetId === setId;
                      if (inSet) api.commands.setVisible(row.layer.layerId, visible);
                    }
                  }}
                  onOpacity={api.commands.setOpacity}
                  onRenderStyle={(layerId, style) => {
                    const ok = api.commands.setRenderStyle(layerId, style);
                    if (!ok) api.commands.setError(t('填色同時最多 {n} 個結構（先把別的改回輪廓）', { n: MAX_FILL_STRUCTURES }));
                    return ok;
                  }}
                  {...(setsBase && api.state.usesStructureSets
                    ? {
                        onCreateSet: () => setSetDialog({ set: null }),
                        onEditSet: (set: StructureSetInfo) => setSetDialog({ set }),
                        onDeleteSet: (set: StructureSetInfo, rows: readonly StructureRow[]) => {
                          const text = deleteConfirmText(set, rows.map((r) => ({ name: r.layer.label, status: r.status })));
                          if (!window.confirm(text)) return;
                          void api.http
                            .deleteJson(`${setsBase}/${encodeURIComponent(set.structureSetId)}`)
                            .then(() => {
                              if (api.state.activeStructureId && rows.some((r) => r.layer.contentRef === api.state.activeStructureId)) {
                                api.commands.setActiveStructure(null);
                              }
                            })
                            .then(refreshSets)
                            .catch(fail);
                        },
                        onDelete: (structureId: string, label: string) => {
                          if (!window.confirm(t('刪除結構「{label}」？會先放進暫存區，14 天內可以救回；已簽核的會進封存區（管理者可見）。', { label }))) return;
                          void api.http
                            .deleteJson(`/structures/${encodeURIComponent(structureId)}`)
                            .then(() => {
                              if (api.state.activeStructureId === structureId) api.commands.setActiveStructure(null);
                            })
                            .then(refreshSets)
                            .catch(fail);
                        },
                        onMoveActiveHere: (set: StructureSetInfo, structureId: string) => {
                          void api.http
                            .postJson(`${setsBase}/${encodeURIComponent(set.structureSetId)}/move`, { structure_ids: [structureId] })
                            .then(refreshSets)
                            .catch(fail);
                        },
                      }
                    : {})}
                />
              )}
              {setDialog && (
                <StructureSetDialog
                  api={api}
                  set={setDialog.set}
                  frameOfReferenceUid={g.frameOfReferenceUid}
                  onClose={() => setSetDialog(null)}
                  onSaved={() => void refreshSets().catch(fail)}
                />
              )}
            </div>
          )}
        </>
      )}
    </section>
  );
}

function ImageRow({ layer, api, name }: { layer: Layer; api: ViewerPanelProps['api']; name: string | null }): React.JSX.Element {
  const wl = layer.windowLevel;
  // PET 換成 SUV 時存的是 SUV×100 —— W/L 欄位顯示與輸入都用 SUV（`value_scale`），送出前換回存的值
  const vs = valueScaleOf(layer);
  const scaled = vs.scale !== 1;
  const shown = (v: number | undefined): number | '' => (v === undefined ? '' : toDisplayValue(v, vs));
  // 自訂 WW/WL 預設集（localStorage）
  const [userPresets, setUserPresets] = useState<WindowPreset[]>(() => readUserPresets(typeof localStorage === 'undefined' ? null : localStorage));
  const presets = allPresets(userPresets);
  const presetId = presetIdFor(wl, presets);
  const saveUserPresets = (next: WindowPreset[]): void => {
    setUserPresets(next);
    writeUserPresets(prefStorage, next);
  };
  // radio 勾的是**實際**作用的那張（沒指定時是最底下的可見影像，跟右鍵 W/L 一致）
  const isActive = windowTargetId(api.state.layers, api.state.activeImageLayerId) === layer.layerId;
  // 影像列的設定一律預設收起，按「設定」才展開；
  // 展開後就留著（以前作用中且可見的那張自動展開、換作用中或切顯示就回到自動）
  const [expanded, setExpanded] = useState(false);
  return (
    <div className="layer-row image-row" data-visible={layer.visible ? 'true' : 'false'} data-expanded={expanded ? 'true' : 'false'}>
      {name !== null && (
        <span className="image-row-name" title={layer.label}>
          {name}
        </span>
      )}
      <label className="visibility" title={t('顯示／隱藏')}>
        <input type="checkbox" checked={layer.visible} onChange={(e) => api.commands.setVisible(layer.layerId, e.target.checked)} />
      </label>
      <span className="kind">{t('影像')}</span>
      <label className="active-pick" title={t('右鍵 WW/WL 與閾值筆刷的目標')}>
        <input type="radio" name="active-image" checked={isActive} onChange={() => api.commands.setActiveImageLayer(layer.layerId)} />
        {t('作用中')}
      </label>
      <label className="opacity" title={t('不透明度')}>
        <input
          type="range"
          min={0}
          max={1}
          step={0.05}
          value={layer.opacity}
          onChange={(e) => api.commands.setOpacity(layer.layerId, Number(e.target.value))}
        />
      </label>
      <RowMoreToggle expanded={expanded} onToggle={() => setExpanded(!expanded)} title={t('顯示／收起不透明度、W/L、色階、混合')} />
      {expanded && (
      <>
      {/* 不透明度也放進設定，可以打數字（0–100 %）；上面那條滑桿照舊（快速調） */}
      <label className="opacity-setting" title={t('不透明度（0–100 %）')}>
        {t('不透明度')}
        <input type="range" min={0} max={1} step={0.01} value={layer.opacity} aria-label={t('不透明度')} onChange={(e) => api.commands.setOpacity(layer.layerId, Number(e.target.value))} />
        <input
          type="number"
          className="num"
          min={0}
          max={100}
          step={1}
          aria-label={t('不透明度（%）')}
          value={opacityPercent(layer.opacity)}
          onChange={(e) => {
            const v = opacityFromPercent(e.target.value);
            if (v !== null) api.commands.setOpacity(layer.layerId, v);
          }}
        />
        %
      </label>
      <label className="wl">
        W/L
        <select
          value={presetId}
          onChange={(e) => {
            const p = presets.find((x) => x.id === e.target.value);
            if (p) api.commands.setWindowLevel(layer.layerId, { center: p.center, width: p.width });
          }}
        >
          <option value="custom">{t('自訂')}</option>
          {presets.map((p) => (
            <option key={p.id} value={p.id}>
              {t(p.label)}
              {isUserPreset(p.id) ? ' ★' : ''}
            </option>
          ))}
        </select>
        <input
          type="number"
          className="num"
          title={scaled ? `center (${vs.unit})` : 'center'}
          step={scaled ? 0.1 : 1}
          value={shown(wl?.center)}
          onChange={(e) => api.commands.setWindowLevel(layer.layerId, { center: toStoredValue(Number(e.target.value), vs), width: wl?.width ?? 400 })}
        />
        /
        <input
          type="number"
          className="num"
          title={scaled ? `width (${vs.unit})` : 'width'}
          min={scaled ? vs.scale : 1}
          step={scaled ? 0.1 : 1}
          value={shown(wl?.width)}
          onChange={(e) => api.commands.setWindowLevel(layer.layerId, { center: wl?.center ?? 40, width: Math.max(1, toStoredValue(Number(e.target.value), vs)) })}
        />
        {scaled && <span className="muted small">{vs.unit}</span>}
        <button
          type="button"
          className="mini"
          title={t('把目前的 W/L 存成自訂預設集（存在這個瀏覽器）')}
          aria-label={t('存成自訂 W/L 預設集')}
          onClick={() => {
            if (!wl) return;
            const name = window.prompt(t('預設集名稱（W {width}／L {center}）', { width: toDisplayValue(wl.width, vs), center: toDisplayValue(wl.center, vs) }), '');
            if (name === null) return;
            const r = addUserPreset(userPresets, name, wl);
            if ('error' in r) api.commands.setError(r.error);
            else saveUserPresets(r.presets);
          }}
        >
          {t('＋')}
        </button>
        {isUserPreset(presetId) && (
          <button type="button" className="mini danger" title={t('刪除這個自訂預設集')} aria-label={t('刪除這個自訂預設集')} onClick={() => saveUserPresets(removeUserPreset(userPresets, presetId))}>
            ×
          </button>
        )}
      </label>
      <label className="colormap">
        {t('色階')}
        <select value={layer.colormap ?? 'gray'} onChange={(e) => api.commands.setColormap(layer.layerId, e.target.value)}>
          {IMAGE_COLORMAPS.map((c) => (
            <option key={c.id} value={c.id}>
              {t(c.label)}
            </option>
          ))}
        </select>
      </label>
      <label className="blend" title={t('棋盤格露出下面的影像；差值讓對位偏差在邊緣亮起來')}>
        {t('混合')}
        <select
          value={layer.blendMode ?? 'normal'}
          onChange={(e) => api.commands.setBlendMode(layer.layerId, e.target.value as NonNullable<Layer['blendMode']>)}
        >
          {BLEND_MODES.map((b) => (
            <option key={b.id} value={b.id}>
              {t(b.label)}
            </option>
          ))}
        </select>
        {layer.blendMode === 'checkerboard' && (
          <input
            type="number"
            className="num"
            min={4}
            max={256}
            step={4}
            title={t('棋盤格大小（px）')}
            value={typeof layer.params?.['checkerboard_px'] === 'number' ? (layer.params['checkerboard_px']) : 32}
            onChange={(e) => api.commands.setLayerParams(layer.layerId, { checkerboard_px: Number(e.target.value) })}
          />
        )}
      </label>
      </>
      )}
    </div>
  );
}

/** 一列的「設定 ▸／▾」—— 收起時細部設定不佔位置，需要時一鍵展開。 */
function RowMoreToggle(props: { expanded: boolean; onToggle: () => void; title: string }): React.JSX.Element {
  return (
    <button type="button" className="row-more" aria-expanded={props.expanded} title={props.title} onClick={props.onToggle}>
      {t('設定')} {props.expanded ? '▾' : '▸'}
    </button>
  );
}

/**
 * 色階的上下界（相減之後要能調 color bar 的上下界，否則細微的差異很難視覺化）。
 * 差值：一條「±」滑桿（對數刻度，從 max|值| 到它的 1／200）＋ 下界／上界兩格（可以不對稱）；一般劑量：下界／上界兩格。
 * 「自動」清掉設定（差值回到 ±max|值|、一般劑量回到 0 … 最大值）。等劑量線沒自訂時跟著範圍走。
 */
function DoseRangeControls({ layer, api }: { layer: Layer; api: ViewerPanelProps['api'] }): React.JSX.Element {
  const d = doseDisplayOf(layer);
  const set = (patch: Record<string, unknown>): void => api.commands.setLayerParams(layer.layerId, patch);
  const dataMax = Math.max(d.maxGy, -d.minGy, 1e-6);
  const commit = (key: 'range_lo_gy' | 'range_hi_gy', text: string): void => {
    const v = Number(text);
    if (text.trim() === '' || !Number.isFinite(v)) return;
    set({ [key]: v });
  };
  const sym = Math.max(-d.rangeLoGy, d.rangeHiGy);
  const logMin = Math.log10(dataMax / 200);
  const logMax = Math.log10(dataMax);
  return (
    <div className="dose-range" data-signed={d.signed ? 'true' : 'false'}>
      <span className="dose-range-title" title={t('色階對應的劑量範圍；超出範圍的顯示成兩端的顏色')}>
        {t('色階範圍')}
      </span>
      {d.signed && (
        <input
          type="range"
          className="dose-range-slider"
          min={logMin}
          max={logMax}
          step={(logMax - logMin) / 200}
          value={Math.log10(Math.min(dataMax, Math.max(dataMax / 200, sym)))}
          aria-label={t('差值的色階範圍（±）')}
          title={t('±{v} Gy：往左拖放大細微的差異', { v: fmtLevelGy(sym) })}
          onChange={(e) => {
            const r = Number((10 ** Number(e.target.value)).toPrecision(2));
            set({ range_lo_gy: -r, range_hi_gy: r });
          }}
        />
      )}
      <input
        key={`lo:${d.rangeLoGy}`}
        className="num"
        defaultValue={fmtLevelGy(d.rangeLoGy)}
        aria-label={t('下界')}
        title={t('下界（Gy）')}
        data-field="range-lo"
        onBlur={(e) => commit('range_lo_gy', e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
        }}
      />
      <span className="muted">…</span>
      <input
        key={`hi:${d.rangeHiGy}`}
        className="num"
        defaultValue={fmtLevelGy(d.rangeHiGy)}
        aria-label={t('上界')}
        title={t('上界（Gy）')}
        data-field="range-hi"
        onBlur={(e) => commit('range_hi_gy', e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
        }}
      />
      <span className="muted">Gy</span>
      {d.rangeCustom && (
        <button type="button" onClick={() => set({ range_lo_gy: undefined, range_hi_gy: undefined })} title={t('回到自動範圍')}>
          {t('自動')}
        </button>
      )}
    </div>
  );
}

export function DoseRow({ layer, api }: { layer: Layer; api: ViewerPanelProps['api'] }): React.JSX.Element {
  const d = doseDisplayOf(layer);
  const params = layer.params ?? {};
  const set = (patch: Record<string, unknown>): void => api.commands.setLayerParams(layer.layerId, patch);
  const planLabel = dosePlanName(layer);
  // 劑量運算的暫存結果
  const derivedInfo = params['derived'];
  const derived = derivedInfo !== null && typeof derivedInfo === 'object';
  const rawText = derived ? (derivedInfo as Record<string, unknown>)['text'] : undefined;
  const derivedText = typeof rawText === 'string' ? rawText : '';
  // `DoseUnits` 不是 GY 的劑量不能標 Gy —— 顯示「相對值」並在 title 說明
  const units = typeof params['units'] === 'string' ? params['units'].toUpperCase() : '';
  const isGy = units === 'GY';
  const unitLabel = isGy ? 'Gy' : t('（相對值）');
  // 隱藏中的劑量不展開 colorwash／等劑量線／單位／參考／閾值／level／色階
  const [override, setOverride] = useState<boolean | null>(null);
  useEffect(() => setOverride(null), [layer.visible]);
  const expanded = rowExpanded(layer.visible, override);
  // 存成預設／清除預設改的是模組層的值（不是 React 狀態）—— 用一個計數讓這列重畫
  const [, bumpDefault] = useState(0);
  const [jumping, setJumping] = useState(false);
  const otherDoses = api.state.layers.filter((l) => l.kind === 'dose' && l.layerId !== layer.layerId);
  /** 跟著預設走（沒有自己的 levels）的其他劑量先把目前的線固定下來 —— 存／清預設不改已經開著的劑量。 */
  const freezeOthers = (): void => {
    for (const l of otherDoses) {
      if (Array.isArray(l.params?.['levels'])) continue;
      const od = doseDisplayOf(l);
      api.commands.setLayerParams(l.layerId, { levels: od.display === 'percent' ? percentsOf(od) : od.levelsGy.map((g) => Number(g.toFixed(3))) });
    }
  };
  const saveAsDefault = (): void => {
    freezeOthers();
    saveIsodoseDefault(percentsOf(d));
    set({ levels: undefined }); // 這個劑量改成跟著預設（線不變）
    bumpDefault((n) => n + 1);
  };
  const clearDefault = (): void => {
    freezeOthers();
    saveIsodoseDefault(null);
    set({ levels: undefined });
    bumpDefault((n) => n + 1);
  };
  const jumpToMax = async (): Promise<void> => {
    setJumping(true);
    try {
      const r = await api.http.getJson<{ world_primary_mm: [number, number, number] }>(`/dose/${encodeURIComponent(layer.contentRef)}/max`);
      api.commands.moveCrosshair(r.world_primary_mm);
    } catch (e) {
      api.commands.setError(t('找不到最大劑量點：{msg}', { msg: e instanceof Error ? e.message : String(e) }));
    } finally {
      setJumping(false);
    }
  };
  return (
    <div className="layer-row dose-row" data-visible={layer.visible ? 'true' : 'false'} data-expanded={expanded ? 'true' : 'false'} data-dose-units={units || 'missing'}>
      <label className="visibility" title={t('顯示／隱藏')}>
        <input type="checkbox" checked={layer.visible} onChange={(e) => api.commands.setVisible(layer.layerId, e.target.checked)} />
      </label>
      <span className="kind">{t('劑量')}</span>
      {derived && (
        <span className="badge derived" title={t('劑量運算的暫存結果：{text}（關掉病例就會消失；要留下來請到「劑量運算」面板存成 RTDOSE）', { text: derivedText })}>
          {t('運算')}
        </span>
      )}
      {d.signed ? (
        <span className="muted" title={t('差值（有負值）：藍＝負、紅＝正；不畫 DVH 曲線')}>
          {t('差值 {min} … {max} Gy', { min: d.minGy.toFixed(2), max: d.maxGy.toFixed(2) })}
        </span>
      ) : (
        <span className="muted" title={isGy ? undefined : t('DoseUnits={p0}：不是 Gy，讀數與等劑量線都是相對值；不提供 Gy 統計', { p0: units || t('(缺)') })}>
          max {d.maxGy.toFixed(2)} {unitLabel}
          {planLabel ? ` · ${planLabel}` : ''}
        </span>
      )}
      <button type="button" className="dose-jump-max" disabled={jumping} onClick={() => void jumpToMax()} title={t('十字線移到最大劑量點（Dmax）')}>
        {t('到 Dmax')}
      </button>
      <label className="opacity" title={t('不透明度')}>
        <input
          type="range"
          min={0}
          max={1}
          step={0.05}
          value={layer.opacity}
          onChange={(e) => api.commands.setOpacity(layer.layerId, Number(e.target.value))}
        />
      </label>
      <RowMoreToggle expanded={expanded} onToggle={() => setOverride(!expanded)} title={t('顯示／收起劑量的顯示設定')} />
      {expanded && (
      <>
      <label>
        <input type="checkbox" checked={d.colorwash} onChange={(e) => set({ colorwash: e.target.checked })} />
        colorwash
      </label>
      <label>
        <input type="checkbox" checked={d.isolines} onChange={(e) => set({ isolines: e.target.checked })} />
        {t('等劑量線')}
      </label>
      {!d.signed && (
      <>
      <label>
        {t('單位')}
        <select value={d.display} onChange={(e) => set({ display: e.target.value })}>
          <option value="absolute">{isGy ? 'Gy' : t('原始值')}</option>
          <option value="percent">{t('% 參考')}</option>
        </select>
      </label>
      <label title={t('percent 模式的 100%；預設處方，沒處方就最大劑量')}>
        {t('參考')}
        <input
          type="number"
          className="num"
          step={0.1}
          value={Number(d.referenceGy.toFixed(2))}
          onChange={(e) => set({ reference_gy: Number(e.target.value) })}
        />
        Gy
      </label>
      </>
      )}
      {d.colorwash && (
      <label title={d.signed ? t('差值的絕對值小於這個就不上色') : t('colorwash 的低劑量截止')}>
        {d.signed ? t('|差值| 閾值') : t('閾值')}
        <input
          type="number"
          className="num"
          step={0.1}
          value={Number(d.thresholdGy.toFixed(2))}
          onChange={(e) => set({ threshold_gy: Number(e.target.value) })}
        />
        Gy
      </label>
      )}
      {d.colorwash && <DoseRangeControls layer={layer} api={api} />}
      {d.isolines && (
      <>
      <label title={(d.display === 'percent' ? t('等劑量線（% 參考劑量），逗號分隔') : t('等劑量線（Gy），逗號分隔')) + t('；改完離開欄位只套用到這個劑量')}>
        level
        <input
          // 預設來源一變（存成預設、回到預設、換單位）就重建，顯示的數字才跟著變
          key={`${d.levelSource}:${d.display}:${isodoseLevelsText(d, params)}`}
          className="levels"
          defaultValue={isodoseLevelsText(d, params)}
          onBlur={(e) => {
            const levels = e.target.value
              .split(/[,\s]+/)
              .map(Number)
              // 差值的等劑量線可以是負的（−1 Gy）；一般劑量只收正的
              .filter((v) => Number.isFinite(v) && (d.signed ? v !== 0 : v > 0));
            set({ levels });
          }}
        />
      </label>
      <span className="muted dose-level-source" data-source={d.levelSource}>{isodoseSourceLabel(d.levelSource)}</span>
      <span className="dose-level-actions">
        {!d.signed && (
          <button type="button" onClick={saveAsDefault} title={t('把這組等劑量線存成之後開啟劑量時的預設（以 % 參考劑量存、跟著帳號）；已經開著的其他劑量不變')}>
            {t('存成預設')}
          </button>
        )}
        {d.levelSource === 'custom' && (
          <button type="button" onClick={() => set({ levels: undefined })} title={t('這個劑量回到預設的等劑量線')}>
            {t('回到預設')}
          </button>
        )}
        {!d.signed && getUserIsodoseDefault() !== null && (
          <button type="button" onClick={clearDefault} title={t('清除你存的預設，回到內建規則（有處方用 % 處方，沒處方自動等距）')}>
            {t('清除我的預設')}
          </button>
        )}
      </span>
      </>
      )}
      <label>
        {t('色階')}
        <select value={d.colormap} onChange={(e) => set({ colormap: e.target.value })}>
          {DOSE_COLORMAPS.map((c) => (
            <option key={c.id} value={c.id}>
              {t(c.label)}
            </option>
          ))}
        </select>
      </label>
      </>
      )}
    </div>
  );
}

/** 只在某幾幀的結構 → 「只在 50%」（幀的名字來自時間軸；沒有名字用序號）。 */
export function frameNoteOf(layer: Pick<Layer, 'frames' | 'temporalGroupId'>, temporal: readonly Pick<TemporalState, 'temporalGroupId' | 'frameLabels' | 'frameCount'>[]): string | null {
  if (!layer.frames || layer.frames.length === 0 || !layer.temporalGroupId) return null;
  const g = temporal.find((x) => x.temporalGroupId === layer.temporalGroupId);
  if (g && g.frameCount !== null && layer.frames.length >= g.frameCount) return null;
  const names = layer.frames.map((f) => g?.frameLabels?.[f] ?? `#${f + 1}`);
  return t('只在 {frames}', { frames: joinList(names) });
}
