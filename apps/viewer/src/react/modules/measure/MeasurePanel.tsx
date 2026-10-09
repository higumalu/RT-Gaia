/**
 * 量測面板 —— `right-sidebar`，**只在 `'measure'` 模式開著時出現**。
 * 表格內嵌（沒放到格子時）＋ 淡色開關 ＋ 複製 CSV ＋「放到格子」／「取回」。
 */

import { useState } from 'react';

import { layoutCellName } from '../../../core';
import type { ViewerPanelProps } from '../../panels/types';
import { MeasureTable } from './MeasureTable';
import { MeasureTemplates } from './MeasureTemplates';
import { MEASURE_MODULE_ID, MEASURE_TABLE_PANEL_ID } from './mode';
import { measurementRows, toCsv } from './model';
import { t } from '../../../core/i18n';
import { copyText } from '../../components/copyText';

export function MeasurePanel({ api }: ViewerPanelProps): React.JSX.Element {
  const rows = measurementRows(api.state.layers);
  const state = api.state.modules[MEASURE_MODULE_ID] as { showFaded?: boolean } | undefined;
  const showFaded = state?.showFaded ?? true;
  const [copied, setCopied] = useState(false);
  const { layout } = api.state;
  const tableCell = layout.cells.find((c) => c.content.kind === 'panel' && c.content.panelId === MEASURE_TABLE_PANEL_ID) ?? null;
  const putTarget = layout.cells.find((c) => c.content.kind === 'viewport' && c.content.is3D) ?? layout.cells[layout.cells.length - 1] ?? null;

  return (
    <div className="slab-panel measure-panel">
      <header className="slab-header">
        {t('量測（{length}）', { length: rows.length })}
        <span className="slab-header-actions">
          <button
            type="button"
            className="reset"
            disabled={rows.length === 0}
            title={t('把表格複製成 CSV（含 HU 統計與 LPS 座標）')}
            onClick={() => {
              void copyText(toCsv(rows)).then((ok) => {
                if (!ok) return;
                setCopied(true);
                setTimeout(() => setCopied(false), 1500);
              });
            }}
          >
            {copied ? t('已複製') : t('複製 CSV')}
          </button>
          {tableCell === null ? (
            putTarget !== null && (
              <button type="button" className="reset" title={t('把量測表放到「{p0}」那一格', { p0: putTarget.label ?? putTarget.cellId })} onClick={() => api.commands.setCellContent(putTarget.cellId, { kind: 'panel', panelId: MEASURE_TABLE_PANEL_ID })}>
                {t('放到格子')}
              </button>
            )
          ) : (
            <button type="button" className="reset" title={t('那一格還回原本的內容')} onClick={() => api.commands.setCellContent(tableCell.cellId, null)}>
              {t('取回')}
            </button>
          )}
        </span>
      </header>
      <MeasureTemplates api={api} />
      <div className="slab-row">
        <label title={t('面積量測在平行但不同層的切面上以淡色顯示；關掉就只在共面時看到')}>
          <input
            type="checkbox"
            checked={showFaded}
            onChange={(e) => {
              api.commands.setModuleState(MEASURE_MODULE_ID, { showFaded: e.target.checked });
              api.commands.setMeasurementOptions({ showFaded: e.target.checked });
            }}
          />
          {t('不同層的面積以淡色顯示')}
        </label>
        <span className="muted hint">
          {t('面積／曲線：逐點點擊，頂點可拖；雙擊、點回起點（面積）、再點最後一點或 Enter 結束，Esc 取消。角度：依序點三點（第二點是頂點）。Cobb 角：畫兩條終板線（各點兩點），與畫的方向無關，超過 90° 也量得出。已完成的量測：列上 ✎ 進入編輯頂點（任何工具下都可拖），或切回「十字線」工具直接拖；選中後按 Delete 刪除；雙擊名稱改名')}
        </span>
      </div>
      {tableCell === null ? (
        <MeasureTable api={api} />
      ) : (
        <p className="muted hint" style={{ padding: '4px 10px' }}>
          {((name) => (name ? t('表格在「{p0}」那一格。', { p0: name }) : t('表格在版面的另一格。')))(layoutCellName(api.state.layoutId, tableCell.cellId))}
        </p>
      )}
    </div>
  );
}
