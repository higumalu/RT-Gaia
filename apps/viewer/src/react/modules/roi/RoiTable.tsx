/** 可放格子的 ROI 摘要：結構清單 ＋ 最近的運算紀錄。 */

import { statusLabel } from '../review/model';
import type { ViewerPanelProps } from '../../panels/types';
import { ROI_MODULE_ID } from './mode';
import type { RoiLogEntry } from './RoiPanel';
import { rgbHex } from './model';
import { t } from '../../../core/i18n';

export function RoiTable({ api }: ViewerPanelProps): React.JSX.Element {
  const log = ((api.state.modules[ROI_MODULE_ID] as { log?: RoiLogEntry[] } | undefined)?.log ?? []);
  return (
    <div className="dvh-table-wrap roi-table">
      <table className="dvh-table">
        <thead>
          <tr>
            <th>{t('結構')}</th>
            <th>{t('體積')}</th>
            <th>{t('狀態')}</th>
          </tr>
        </thead>
        <tbody>
          {api.state.structures.map((s) => (
            <tr key={s.structureId} className={s.structureId === api.state.activeStructureId ? 'selected' : ''} onClick={() => api.commands.setActiveStructure(s.structureId)}>
              <td>
                <span className="dvh-swatch" style={{ background: rgbHex(s.colorRgb ?? [255, 0, 0]) }} /> {s.name ?? s.structureId}
              </td>
              <td>{Array.isArray(s.volumeCc) ? s.volumeCc[0]?.toFixed(1) : s.volumeCc.toFixed(1)}</td>
              <td>{statusLabel(s.status)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {log.length > 0 && (
        <ul className="roi-log">
          {log.map((l, i) => (
            <li key={i}>
              <span className="muted">{l.at}</span> {l.text}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
