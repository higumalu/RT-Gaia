/**
 * 手機的檢視器外框 —— 一次一格 ＋ 底部分頁列 ＋ 底部抽屜。
 *
 * ```
 * ┌ 標頭（品牌選單、病例、保存狀態）
 * ├ 方位切換［軸｜冠｜矢｜3D］＋ 觸控按鈕（調窗、完成／取消）
 * │  影像（一格；版面 `phone`，方位存在那一格的覆寫）
 * ├ ROI 工具列（ROI 編輯開著時：工具、筆刷半徑、復原／重做）
 * ├ 讀數、時間軸（bottom slot）
 * └ 分頁［資料｜ROI｜簽核｜DVH｜計畫｜更多］→ 抽屜：該分頁的面板（跟桌面同一批面板，不另做一份）
 * ```
 *
 * * 任務分頁（ROI、簽核、DVH、計畫）＝ 開那個模式 ＋ 打開抽屜；抽屜收起來模式還在（例：收起來畫）。抽屜標頭的「結束」才關模式。
 * * 「更多」的內容**一直掛著**（看不見而已）：工具列的面板有的兼任 overlay painter 的宿主（參考線、計畫的 ISO 標記），
 *   卸載就畫不出來。手機上沒有的任務（量測、對位、匯出、劑量運算、Plugins、MPR、3D 設定）列在那裡、說明要用電腦或平板。
 */

import { useEffect, useState } from 'react';

import { listPanels, type CellContent, type PanelRegistration, type ViewerApi } from '../../core';
import { PanelHost, panelVisibilityState } from '../panels/PanelSlot';
import { ToolPalettePanel } from '../panels/ToolPalettePanel';
import { EditControlsPanel } from '../panels/EditControlsPanel';
import { TouchControlsPanel } from '../panels/TouchControlsPanel';
import { ROI_MODE } from '../modules/roi/mode';
import { REVIEW_MODE } from '../modules/review/mode';
import { DVH_MODE } from '../modules/dvh/mode';
import { DVH_CHART_PANEL_ID } from '../modules/dvh/model';
import { PLAN_MODE } from '../modules/plan/mode';
import { msg, t } from '../../core/i18n';
import { navigate } from '../hooks/useHashRoute';

export const PHONE_CELL_ID = 'phone';

type Tab = 'data' | 'roi' | 'review' | 'dvh' | 'plan' | 'more';

const TAB_MODE: Partial<Record<Tab, string>> = { roi: ROI_MODE, review: REVIEW_MODE, dvh: DVH_MODE, plan: PLAN_MODE };
const TAB_LABEL: Record<Tab, string> = { data: msg('資料'), roi: msg('ROI'), review: msg('簽核'), dvh: 'DVH', plan: msg('計畫'), more: msg('更多') };
const TAB_TITLE: Record<Tab, string> = {
  data: msg('影像、結構、劑量的顯示'),
  roi: msg('ROI 編輯：選結構、筆刷、圈選、後處理'),
  review: msg('簽核：核可／退回／重新開啟'),
  dvh: msg('劑量體積直方圖'),
  plan: msg('計畫：射束、等中心'),
  more: msg('病例、參考線，以及手機上沒有的功能'),
};
/** 任務分頁的抽屜放哪些右欄面板（DVH 這種檢視模式可以跟 ROI 同時開著 —— 抽屜只放按下的那一個）。 */
const TAB_PANELS: Partial<Record<Tab, readonly string[]>> = { roi: ['roi.panel'], review: ['review.panel'], dvh: ['dvh.settings'], plan: ['plan.panel'] };
/** 手機上的工具列面板裡，由分頁列與工具列自己處理的（不放進「更多」）。 */
const NOT_IN_MORE = new Set(['core.tools', 'core.edit', 'core.touch', 'roi.toggle', 'review.toggle', 'dvh.toggle']);

const VIEWS: readonly { key: string; label: string; content: CellContent }[] = [
  { key: 'axial', label: msg('軸'), content: { kind: 'viewport', orientation: 'axial' } },
  { key: 'coronal', label: msg('冠'), content: { kind: 'viewport', orientation: 'coronal' } },
  { key: 'sagittal', label: msg('矢'), content: { kind: 'viewport', orientation: 'sagittal' } },
  { key: '3d', label: '3D', content: { kind: 'viewport', orientation: 'axial', is3D: true } },
];

function viewKeyOf(content: CellContent | undefined): string {
  if (content === undefined) return 'axial';
  if (content.kind === 'panel') return content.panelId === DVH_CHART_PANEL_ID ? 'dvh' : 'panel';
  return content.is3D ? '3d' : content.orientation;
}

/** 方位切換 ＋ 觸控按鈕（影像上方一列）。 */
export function PhoneViewBar({ api }: { api: ViewerApi }): React.JSX.Element {
  const current = viewKeyOf(api.state.layout.cells.find((c) => c.cellId === PHONE_CELL_ID)?.content);
  return (
    <div className="phone-viewbar">
      <div className="phone-views" role="group" aria-label={t('方位')}>
        {VIEWS.map((v) => (
          <button key={v.key} type="button" aria-pressed={current === v.key} onClick={() => api.commands.setCellContent(PHONE_CELL_ID, v.key === 'axial' ? null : v.content)}>
            {t(v.label)}
          </button>
        ))}
      </div>
      <TouchControlsPanel api={api} />
    </div>
  );
}

/** ROI 編輯開著時：工具、筆刷半徑、復原／重做（影像下方一列，可以橫向捲）。 */
export function PhoneToolRow({ api }: { api: ViewerApi }): React.JSX.Element | null {
  if (!api.state.modes.includes(ROI_MODE)) return null;
  const { activeToolId, brush } = api.state;
  const brushy = activeToolId === 'brush' || activeToolId === 'eraser' || activeToolId === 'threshold-brush';
  return (
    <div className="phone-toolrow" role="toolbar" aria-label={t('ROI 工具')}>
      <ToolPalettePanel api={api} />
      {brushy && (
        <label className="phone-radius" title={t('筆刷半徑')}>
          <input type="range" min={0.5} max={30} step={0.5} value={brush.radiusMm} onChange={(e) => api.commands.setBrush({ radiusMm: Number(e.target.value) })} />
          <span>{brush.radiusMm.toFixed(1)} mm</span>
        </label>
      )}
      <EditControlsPanel api={api} />
    </div>
  );
}

/** 抽屜裡挑要編輯的結構（桌面是在左欄的清單點；手機抽屜一次只放一個分頁，ROI 分頁自己帶一個）。 */
function StructurePicker({ api }: { api: ViewerApi }): React.JSX.Element | null {
  const { structures, activeStructureId } = api.state;
  const [reason, setReason] = useState<string | null>(null);
  if (structures.length === 0) return null;
  return (
    <label className="phone-structure-picker">
      <span className="muted">{t('編輯對象')}</span>
      <select
        value={activeStructureId ?? ''}
        onChange={(e) => {
          const r = api.commands.setActiveStructure(e.target.value || null);
          setReason(r.ok ? null : r.reason);
        }}
      >
        <option value="">{t('（選一個結構）')}</option>
        {structures.map((s) => (
          <option key={s.structureId} value={s.structureId}>
            {(s.name ?? s.structureId) + (s.editable === false ? t('（唯讀）') : '')}
          </option>
        ))}
      </select>
      {reason && <span className="warning">{reason}</span>}
    </label>
  );
}

function Panels({ panels, api }: { panels: readonly PanelRegistration[]; api: ViewerApi }): React.JSX.Element {
  return (
    <>
      {panels.map((p) => (
        <PanelHost key={p.id} panel={p} api={api} />
      ))}
    </>
  );
}

/** 分頁列 ＋ 抽屜。 */
export function PhoneTabs({ api }: { api: ViewerApi }): React.JSX.Element {
  const [open, setOpen] = useState<Tab | null>(null);
  const vis = panelVisibilityState(api);
  const modes = api.state.modes;
  const hasDose = vis.hasDoseLayer;
  const toolbar = listPanels('toolbar', vis);
  const hasPlan = toolbar.some((p) => p.id === 'plan.toggle');
  const tabs: Tab[] = ['data', 'roi', 'review', ...(hasDose ? (['dvh'] as const) : []), ...(hasPlan ? (['plan'] as const) : []), 'more'];
  // 模式被別的地方關掉（換病例、任務互斥）→ 那個分頁的抽屜也收起來
  useEffect(() => {
    if (open === null) return;
    const mode = TAB_MODE[open];
    if (mode !== undefined && !modes.includes(mode)) setOpen(null);
  }, [open, modes]);

  const press = (tab: Tab): void => {
    const mode = TAB_MODE[tab];
    if (open === tab) {
      setOpen(null);
      return;
    }
    if (mode !== undefined && !modes.includes(mode)) api.commands.setMode(mode, true);
    setOpen(tab);
  };
  const endTask = (tab: Tab): void => {
    const mode = TAB_MODE[tab];
    if (mode !== undefined) api.commands.setMode(mode, false);
    setOpen(null);
  };

  const left = listPanels('left-sidebar', vis);
  const right = listPanels('right-sidebar', vis);
  const more = toolbar.filter((p) => !NOT_IN_MORE.has(p.id));
  // 手機上沒有的（面板宣告了 formFactors、但不含 phone）：列出名字與說明
  const elsewhere = listPanels('toolbar', { ...vis, formFactor: 'tablet' }).filter((p) => p.formFactors !== undefined && !p.formFactors.includes('phone'));

  return (
    <>
      {open !== null && open !== 'more' && (
        <section className="phone-sheet" role="dialog" aria-label={t(TAB_LABEL[open])} data-tab={open}>
          <header className="phone-sheet-header">
            <strong>{t(TAB_TITLE[open])}</strong>
            {TAB_MODE[open] !== undefined && (
              <button type="button" onClick={() => endTask(open)} title={t('關掉這個任務（ROI 工具列、DVH 等跟著收起）')}>
                {t('結束')}
              </button>
            )}
            <button type="button" className="primary" onClick={() => setOpen(null)}>
              {t('收起 ▾')}
            </button>
          </header>
          <div className="phone-sheet-body">
            {open === 'data' ? (
              <Panels panels={left} api={api} />
            ) : (
              <>
                {open === 'roi' && <StructurePicker api={api} />}
                <Panels panels={right.filter((p) => TAB_PANELS[open]?.includes(p.id) ?? true)} api={api} />
              </>
            )}
          </div>
        </section>
      )}
      {/* 「更多」一直掛著（參考線、計畫 ISO 標記的 painter 宿主），沒打開時只是看不見 */}
      <section className="phone-sheet phone-more" role="dialog" aria-label={t('更多')} hidden={open !== 'more'}>
        <header className="phone-sheet-header">
          <strong>{t(TAB_TITLE.more)}</strong>
          <button type="button" className="primary" onClick={() => setOpen(null)}>
            {t('收起 ▾')}
          </button>
        </header>
        <div className="phone-sheet-body">
          <div className="phone-more-panels">
            <Panels panels={more} api={api} />
            <button type="button" className="phone-help" onClick={() => navigate('help')}>
              {t('使用說明（含手機操作）')}
            </button>
          </div>
          {elsewhere.length > 0 && (
            <div className="phone-elsewhere">
              <p className="muted">{t('這些功能請在電腦或平板上操作：')}</p>
              <ul>
                {elsewhere.map((p) => (
                  <li key={p.id}>{p.title ? t(p.title) : p.id}</li>
                ))}
              </ul>
            </div>
          )}
        </div>
      </section>
      <nav className="phone-tabbar" aria-label={t('分頁')}>
        {tabs.map((tab) => {
          const mode = TAB_MODE[tab];
          const on = mode !== undefined ? modes.includes(mode) : open === tab;
          return (
            <button key={tab} type="button" data-tab={tab} aria-pressed={on} aria-expanded={open === tab} title={t(TAB_TITLE[tab])} onClick={() => press(tab)}>
              {t(TAB_LABEL[tab])}
            </button>
          );
        })}
      </nav>
    </>
  );
}
