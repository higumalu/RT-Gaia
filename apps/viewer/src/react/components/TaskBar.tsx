/**
 * 第二層工具列：
 * 左起 病例切換 → **任務**（ROI／量測／簽核／匯出／對位，同時只開一個）→ 通用工具 → 檢視模式（MPR／DVH／3D）
 * → 右側 版面 → 側欄收合／專注影像 → 讀數 → 「診斷」（Tier 等技術資訊收起來）。
 * 面板仍是模組註冊的（`group` 決定放哪一群），這裡只負責排列。
 */

import { useState } from 'react';

import { listPanels, type PanelGroup } from '../../core';
import type { ViewerApi } from '../../core/panels/api';
import { PanelHost, panelVisibilityState } from '../panels/PanelSlot';
import { groupToolbarPanels, type CollapseState } from './taskBar';
import { HelpMenu } from '../help/HelpMenu';
import { msg, t } from '../../core/i18n';
import { savePref } from '../prefs/prefs';

const DENSITY_KEY = 'rtgaia.density';
export function readDensity(): 'compact' | 'comfortable' {
  try {
    const v = typeof localStorage === 'undefined' ? null : localStorage.getItem(DENSITY_KEY);
    const d = v === 'comfortable' ? 'comfortable' : 'compact';
    applyDensity(d);
    return d;
  } catch {
    return 'compact';
  }
}
export function applyDensity(d: 'compact' | 'comfortable'): void {
  if (typeof document !== 'undefined') document.documentElement.setAttribute('data-density', d);
  try {
    if (typeof localStorage !== 'undefined') savePref(DENSITY_KEY, d);
  } catch {
    /* 私密視窗等：不記就算了 */
  }
}

const GROUP_LABEL: Record<PanelGroup, string> = { case: msg('病例'), task: msg('任務'), tool: msg('工具'), view: msg('檢視'), layout: msg('版面'), readout: msg('讀數'), diagnostic: msg('診斷') };

export function TaskBar(props: {
  api: ViewerApi;
  collapsed: CollapseState;
  onToggleSide: (side: 'left' | 'right') => void;
  onToggleFocus: () => void;
}): React.JSX.Element {
  const { api } = props;
  const groups = groupToolbarPanels(listPanels('toolbar', panelVisibilityState(api)));
  const [diagOpen, setDiagOpen] = useState(false);
  // 舒適／緊湊密度；預設緊湊＝現況；記在 localStorage（每人瀏覽器的偏好，不進後端）
  const [density, setDensity] = useState<'compact' | 'comfortable'>(() => readDensity());
  const toggleDensity = (): void => {
    const next = density === 'compact' ? 'comfortable' : 'compact';
    setDensity(next);
    applyDensity(next);
  };
  const focused = props.collapsed.left && props.collapsed.right;
  const left = groups.filter((g) => ['case', 'task', 'tool', 'view'].includes(g.group));
  const layout = groups.find((g) => g.group === 'layout');
  const readout = groups.find((g) => g.group === 'readout');
  const diagnostic = groups.find((g) => g.group === 'diagnostic');
  return (
    <div className="task-bar" role="toolbar" aria-label={t('任務與工具')}>
      {left.map((g) => (
        <div key={g.group} className={`bar-group bar-group-${g.group}`} aria-label={t(GROUP_LABEL[g.group], { ctx: '工具列群組' })}>
          {g.panels.map((p) => (
            <PanelHost key={p.id} panel={p} api={api} />
          ))}
        </div>
      ))}
      <span className="bar-spacer" />
      {layout && (
        <div className="bar-group bar-group-layout" aria-label={t('版面')}>
          {layout.panels.map((p) => (
            <PanelHost key={p.id} panel={p} api={api} />
          ))}
        </div>
      )}
      <div className="bar-group bar-group-chrome" aria-label={t('側欄')}>
        <button type="button" aria-pressed={props.collapsed.left} title={props.collapsed.left ? t('展開左欄（資料與結構）') : t('收合左欄')} onClick={() => props.onToggleSide('left')}>
          {props.collapsed.left ? t('▸ 左欄') : t('◂ 左欄')}
        </button>
        <button type="button" aria-pressed={props.collapsed.right} title={props.collapsed.right ? t('展開右欄（任務設定）') : t('收合右欄')} onClick={() => props.onToggleSide('right')}>
          {props.collapsed.right ? t('右欄 ◂') : t('右欄 ▸')}
        </button>
        <button type="button" aria-pressed={focused} title={focused ? t('回到工作版面（展開側欄）') : t('專注影像：收合兩側欄')} onClick={props.onToggleFocus}>
          {focused ? t('回工作版面') : t('專注影像')}
        </button>
        <button type="button" aria-pressed={density === 'comfortable'} title={t('介面密度：舒適（字級 14px、控制項 32px）／緊湊（13px、28px）')} onClick={toggleDensity}>
          {density === 'comfortable' ? t('舒適') : t('緊湊')}
        </button>
      </div>
      {readout && (
        <div className="bar-group bar-group-readout" aria-label={t('讀數')}>
          {readout.panels.map((p) => (
            <PanelHost key={p.id} panel={p} api={api} />
          ))}
        </div>
      )}
      {/* 說明選單放最右邊（診斷之後） */}
      {diagnostic && (
        <div className="bar-group bar-group-diagnostic">
          <button type="button" className="diag-toggle" aria-expanded={diagOpen} title={t('Tier、GPU、記憶體等技術資訊')} onClick={() => setDiagOpen((v) => !v)}>
            {t('診斷{p0}', { p0: diagOpen ? '▴' : '▾' })}
          </button>
          {diagOpen && (
            <div className="diag-popover">
              {diagnostic.panels.map((p) => (
                <PanelHost key={p.id} panel={p} api={api} />
              ))}
            </div>
          )}
        </div>
      )}
      <HelpMenu onShortcuts={api.commands.openShortcuts} onTour={api.commands.startTour} />
    </div>
  );
}
