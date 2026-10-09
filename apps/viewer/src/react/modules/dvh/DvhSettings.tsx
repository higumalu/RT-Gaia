/**
 * DVH 設定面板 —— `right-sidebar`，**只在 `'dvh'` 模式開著時出現**（與 `DvhChart` 分開的設定那一半）。
 *
 * 選劑量（可多選；不同劑量不同線型）、參考劑量、依 FrameGroup 分組的結構清單 —— 全部寫進
 * `api.state.modules.dvh`，圖（`DvhChart`）從那裡讀。圖沒放到任何格子時就內嵌在這裡，
 * 使用者不自訂版面也不會少東西；放到格子後這裡只剩設定 ＋「取回」。
 */

import { useMemo, useState } from 'react';

import { layoutCellName } from '../../../core';
import { groupLayersByFrame } from '../../panels/dataModel';
import type { ViewerPanelProps } from '../../panels/types';
import { DvhChart, doseTitle } from './DvhChart';
import { canDvh, DVH_CHART_PANEL_ID, DVH_MODULE_ID, dvhSelection, isSignedDose, noDvhReason, rgbCss, toggleId, type DvhModuleState } from './model';
import { t } from '../../../core/i18n';

export function DvhSettings({ api }: ViewerPanelProps): React.JSX.Element {
  const { layers, frameGroups, layout } = api.state;
  const doses = useMemo(() => layers.filter((l) => l.kind === 'dose'), [layers]);
  const masks = useMemo(() => layers.filter((l) => l.kind === 'mask'), [layers]);
  const groups = useMemo(() => groupLayersByFrame(layers, frameGroups).filter((g) => g.masks.length > 0), [layers, frameGroups]);
  const sel = dvhSelection(layers, api.state.modules[DVH_MODULE_ID]);
  const [structsOpen, setStructsOpen] = useState(true);
  const set = (patch: Partial<DvhModuleState>) => api.commands.setModuleState(DVH_MODULE_ID, patch);

  // 圖在哪一格？（沒有 ＝ 內嵌在這裡）
  const chartCell = layout.cells.find((c) => c.content.kind === 'panel' && c.content.panelId === DVH_CHART_PANEL_ID) ?? null;
  const putTarget = layout.cells.find((c) => c.content.kind === 'viewport' && c.content.is3D) ?? layout.cells[layout.cells.length - 1] ?? null;

  if (doses.length === 0) {
    return (
      <div className="slab-panel dvh-panel">
        <header className="slab-header">DVH</header>
        <p className="muted hint" style={{ padding: '6px 10px' }}>{t('這個病例沒有劑量。')}</p>
      </div>
    );
  }

  return (
    <div className="slab-panel dvh-panel">
      <header className="slab-header">
        DVH
        <span className="slab-header-actions">
          {chartCell === null ? (
            putTarget !== null && (
              <button
                type="button"
                className="reset"
                title={t('把 DVH 圖放到「{p0}」那一格（每格右上角的選單也能換）', { p0: putTarget.label ?? putTarget.cellId })}
                onClick={() => api.commands.setCellContent(putTarget.cellId, { kind: 'panel', panelId: DVH_CHART_PANEL_ID })}
              >
                {t('放到格子')}
              </button>
            )
          ) : (
            <button type="button" className="reset" title={t('把那一格還回原本的內容，圖回到這裡')} onClick={() => api.commands.setCellContent(chartCell.cellId, null)}>
              {t('取回')}
            </button>
          )}
        </span>
      </header>
      <div className="slab-row dvh-doses">
        <span className="muted">{t('劑量')}</span>
        {doses.map((d, i) => {
          const gy = canDvh(d);
          return (
            <label key={d.layerId} className={gy ? undefined : 'dvh-dose-nongy'} title={gy ? t('{label}；線型 {p1}', { label: d.label, p1: i === 0 ? t('實線') : i === 1 ? t('虛線') : t('點線') }) : noDvhReason(d)}>
              <input type="checkbox" disabled={!gy} checked={gy && sel.doseIds.includes(d.contentRef)} onChange={() => set({ doseIds: toggleId(sel.doseIds, d.contentRef) })} />
              <span className="dvh-dash" data-dash={i % 4} /> {doseTitle(d)}
              {!gy && <span className="muted"> {isSignedDose(d) ? t('（差值）') : t('（非 Gy）')}</span>}
            </label>
          );
        })}
        <label title={t('V(ref)：收到 ≥ 參考劑量的體積百分比；圖上畫一條橘色虛線')}>
          {t('參考')}
          <input type="number" className="num" min={0} step={1} value={sel.referenceGy} onChange={(e) => set({ referenceGy: Math.max(0, Number(e.target.value)) })} />
          Gy
        </label>
      </div>
      <div className="dvh-structs">
        <button type="button" className="dvh-structs-toggle" onClick={() => setStructsOpen((v) => !v)} aria-expanded={structsOpen}>
          {t('{p0} 結構（已選 {length}／{length2}）', { p0: structsOpen ? '▾' : '▸', length: sel.structureIds.length, length2: masks.length })}
        </button>
        {sel.structureIds.length > 0 && (
          <button type="button" className="dvh-structs-clear" onClick={() => set({ structureIds: [] })} title={t('全部取消')}>
            {t('清空')}
          </button>
        )}
        {structsOpen && (
          <div className="dvh-structs-list">
            {groups.map((g) => (
              <div key={g.frameOfReferenceUid} className="dvh-structs-group">
                <div className="muted dvh-structs-title">
                  {g.title}
                  {g.role === 'primary' && <span className="badge badge-primary"> primary</span>}
                </div>
                {g.masks.map((m) => (
                  <label key={m.layerId} title={m.frameOfReferenceUid}>
                    <input
                      type="checkbox"
                      checked={sel.structureIds.includes(m.contentRef)}
                      onChange={() => set({ structureIds: toggleId(sel.structureIds, m.contentRef) })}
                    />
                    <span className="dvh-swatch" style={{ background: m.color ? rgbCss(m.color) : '#888' }} /> {m.label}
                  </label>
                ))}
              </div>
            ))}
          </div>
        )}
      </div>
      {chartCell === null ? (
        <div className="dvh-inline-chart">
          <DvhChart api={api} />
        </div>
      ) : (
        <p className="muted hint" style={{ padding: '4px 10px' }}>
          {((name) => (name ? t('圖在「{p0}」那一格。', { p0: name }) : t('圖在版面的另一格。')))(layoutCellName(api.state.layoutId, chartCell.cellId))}
        </p>
      )}
    </div>
  );
}
