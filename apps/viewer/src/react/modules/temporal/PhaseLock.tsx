/**
 * 每一格角落的相位選單 —— 「跟著時間軸」或鎖在某一幀（`viewport-overlay`）。
 *
 * 鎖住的格子影像、結構、讀數都看那一幀，播放時不動；筆刷畫在那一幀（固定相位上畫的結構屬於那一相位）。
 * 2D 格子與 3D 格、而且時間軸沒攤開時出現（攤開後每一幀本來就是獨立的一張）。
 */

import { t } from '../../../core/i18n';
import type { ViewerPanelProps } from '../../panels/types';
import { groupCaption, isExpanded } from './model';

export function PhaseLock({ api, viewportId }: ViewerPanelProps): React.JSX.Element | null {
  // 3D 格（伺服器出圖）也可以鎖相位 —— 以前 3D 只跟游標
  const cell = api.state.layout.cells.find((c) => c.cellId === viewportId);
  const is3D = cell !== undefined && cell.content.kind === 'viewport' && cell.content.is3D === true;
  if (viewportId === undefined || (!is3D && !api.state.viewports.some((v) => v.viewportId === viewportId))) return null;
  const groups = api.state.temporal.filter((g) => g.frameCount !== null && g.frameCount > 1 && !isExpanded(api.state.layers, g.temporalGroupId));
  if (groups.length === 0) return null;
  const locks = api.state.viewportFrames[viewportId] ?? {};
  return (
    <div className="phase-lock" data-viewport={viewportId}>
      {groups.map((g) => {
        const locked = locks[g.temporalGroupId];
        const labelOf = (i: number): string => g.frameLabels?.[i] ?? `#${i + 1}`;
        return (
          <label
            key={g.temporalGroupId}
            className={locked !== undefined ? 'is-locked' : ''}
            title={locked !== undefined ? t('這一格鎖在 {label}：影像、結構、讀數都看這一幀，播放時不動；筆刷畫在這一幀', { label: labelOf(locked) }) : t('這一格跟著時間軸；選一幀就鎖在那一幀')}
          >
            {groups.length > 1 ? groupCaption(g, api.state.layers, groups.length) : t('相位')}
            <select
              value={locked === undefined ? 'follow' : String(locked)}
              aria-label={t('這一格的相位')}
              onChange={(e) => api.commands.setViewportFrame(viewportId, g.temporalGroupId, e.target.value === 'follow' ? null : Number(e.target.value))}
            >
              <option value="follow">{t('跟著時間軸')}</option>
              {Array.from({ length: g.frameCount ?? 0 }, (_, i) => (
                <option key={i} value={i}>
                  {t('鎖在 {label}', { label: labelOf(i) })}
                </option>
              ))}
            </select>
          </label>
        );
      })}
    </div>
  );
}
