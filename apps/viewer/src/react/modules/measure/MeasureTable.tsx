/**
 * 量測表 —— 可放格子的面板（`slot:'cell'`），也被右側面板內嵌。
 * 選中列 ＝ 畫面上高亮；點列選中；名稱可改；方框可改深度；Delete 鈕。
 */

import { useState } from 'react';

import type { ViewerPanelProps } from '../../panels/types';
import { formatStats, measurementRows, withBoxDepth } from './model';
import { VertexEditor } from './VertexEditor';
import { t } from '../../../core/i18n';

export function MeasureTable({ api }: ViewerPanelProps): React.JSX.Element {
  const rows = measurementRows(api.state.layers);
  const selected = api.state.selectedMeasurementId;
  const editingId = api.state.vertexEdit?.measurementId ?? null;
  const editingRow = editingId === null ? null : (rows.find((r) => r.measurementId === editingId) ?? null);
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  if (rows.length === 0) {
    return <p className="muted hint" style={{ padding: '6px 10px' }}>{t('還沒有量測。量測開著時工具列會出現「距離／面積／體積 ROI／標記點／角度／Cobb 角／曲線長度」，選一個在畫面上畫；也可以用上面的範本依序量。')}</p>;
  }
  const commitLabel = (id: string) => {
    if (editing === id && draft.trim()) api.commands.updateMeasurement(id, { label: draft.trim() });
    setEditing(null);
  };
  return (
    <div className="dvh-table-wrap">
      <table className="dvh-table measure-table">
        <thead>
          <tr>
            <th />
            <th>{t('名稱')}</th>
            <th>{t('值')}</th>
            <th>{t('影像值（mean ± sd）')}</th>
            <th>{t('深度')}</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr
              key={r.layerId}
              className={r.measurementId === selected ? 'selected' : ''}
              data-measurement={r.measurementId}
              onClick={() => api.commands.selectMeasurement(r.measurementId === selected ? null : r.measurementId)}
              title={r.frameOfReferenceUid}
            >
              <td>
                <input
                  type="checkbox"
                  checked={r.visible}
                  title={t('顯示／隱藏')}
                  onClick={(e) => e.stopPropagation()}
                  onChange={(e) => api.commands.setVisible(r.layerId, e.target.checked)}
                />
              </td>
              <td onDoubleClick={() => { setEditing(r.measurementId); setDraft(r.label); }}>
                {editing === r.measurementId ? (
                  <input
                    className="measure-rename"
                    autoFocus
                    value={draft}
                    onClick={(e) => e.stopPropagation()}
                    onChange={(e) => setDraft(e.target.value)}
                    onBlur={() => commitLabel(r.measurementId)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') commitLabel(r.measurementId);
                      if (e.key === 'Escape') setEditing(null);
                      e.stopPropagation();
                    }}
                  />
                ) : (
                  <span title={t('雙擊改名')}>
                    <span className="muted">{r.kindLabel}</span> <span data-user-content>{r.label}</span>
                  </span>
                )}
              </td>
              <td>{r.valueText}</td>
              <td>{formatStats(r.stats)}</td>
              <td>
                {r.depthMm !== null ? (
                  <input
                    type="number"
                    className="num"
                    min={0.5}
                    step={1}
                    value={Number(r.depthMm.toFixed(1))}
                    title={t('方框沿 z 的深度（mm）')}
                    onClick={(e) => e.stopPropagation()}
                    onChange={(e) => api.commands.updateMeasurement(r.measurementId, { points: withBoxDepth(r.measurement, Number(e.target.value)) })}
                  />
                ) : (
                  ''
                )}
              </td>
              <td className="measure-row-actions">
                {(r.kind === 'area' || r.kind === 'curve') && (
                  <button
                    type="button"
                    className={`measure-edit-vertices${editingId === r.measurementId ? ' active' : ''}`}
                    aria-pressed={editingId === r.measurementId}
                    title={editingId === r.measurementId ? t('完成編輯頂點') : t('編輯頂點：畫面上可拖每個頂點，下方清單可改座標、刪除、插入')}
                    onClick={(e) => {
                      e.stopPropagation();
                      if (editingId === r.measurementId) api.commands.endVertexEdit(true);
                      else api.commands.beginVertexEdit(r.measurementId);
                    }}
                  >
                    ✎
                  </button>
                )}
                <button
                  type="button"
                  className="measure-delete"
                  title={t('刪除（可復原）')}
                  onClick={(e) => {
                    e.stopPropagation();
                    api.commands.removeMeasurement(r.measurementId);
                  }}
                >
                  ✕
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {editingRow !== null && <VertexEditor api={api} measurement={editingRow.measurement} />}
    </div>
  );
}
