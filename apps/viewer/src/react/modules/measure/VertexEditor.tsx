/**
 * 面板「編輯頂點」：已完成面積量測的頂點清單 —— 座標可改、可刪、可插；
 * 滑過某列畫面上對應頂點亮起；「完成」合成一筆 undo 並送後端、「還原」回到進入前的形狀（Esc ＝ 完成）。
 * 期間畫面上該多邊形的頂點不管目前工具都可拖（host 負責）。
 */

import type { Measurement } from '../../../core';
import type { ViewerPanelProps } from '../../panels/types';
import { canInsertAfter, deleteVertex, insertVertexAfter, setVertex, vertexRows } from './model';
import { requiredPoints } from '../../../core';
import { t } from '../../../core/i18n';

export function VertexEditor({ api, measurement }: ViewerPanelProps & { measurement: Measurement }): React.JSX.Element {
  const id = measurement.measurementId;
  const rows = vertexRows(measurement);
  const apply = (points: number[] | null): void => {
    if (points !== null) api.commands.updateMeasurement(id, { points }, { commit: false });
  };
  return (
    <div className="vertex-editor" onMouseLeave={() => api.commands.highlightVertex(id, null)}>
      <header className="slab-header">
        {t('編輯頂點：{label}（{length}點）', { label: measurement.label, length: rows.length })}
        <span className="slab-header-actions">
          <button type="button" className="reset" title={t('回到進入編輯前的形狀')} onClick={() => api.commands.endVertexEdit(false)}>
            {t('還原')}
          </button>
          <button type="button" className="reset primary" title={t('結束編輯：整段合成一筆可復原的修改並存檔（Esc 亦可）')} onClick={() => api.commands.endVertexEdit(true)}>
            {t('完成')}
          </button>
        </span>
      </header>
      <p className="muted hint" style={{ padding: '2px 10px 4px' }}>{t('畫面上可直接拖頂點；這裡可微調座標（只能在該平面內移動）、刪除或在後面插入一點。')}</p>
      <table className="dvh-table vertex-table">
        <thead>
          <tr>
            <th>#</th>
            <th>x</th>
            <th>y</th>
            <th>z</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.index} onMouseEnter={() => api.commands.highlightVertex(id, r.index)}>
              <td>{r.index + 1}</td>
              {(['x', 'y', 'z'] as const).map((axis, k) => (
                <td key={axis}>
                  <input
                    type="number"
                    className="num"
                    step={0.1}
                    value={Number(r[axis].toFixed(1))}
                    aria-label={t('頂點 {p0} {axis}（mm）', { p0: r.index + 1, axis })}
                    onChange={(e) => {
                      const v = Number(e.target.value);
                      if (!Number.isFinite(v)) return;
                      const xyz: [number, number, number] = [r.x, r.y, r.z];
                      xyz[k] = v;
                      apply(setVertex(measurement, r.index, xyz));
                    }}
                  />
                </td>
              ))}
              <td className="vertex-actions">
                <button type="button" className="reset" disabled={!canInsertAfter(measurement, r.index)} title={t('在這一點後面插入一點（與下一點的中點）')} onClick={() => apply(insertVertexAfter(measurement, r.index))}>
                  {t('＋')}
                </button>
                <button type="button" className="reset" disabled={rows.length <= requiredPoints(measurement.kind)} title={rows.length <= requiredPoints(measurement.kind) ? (measurement.kind === 'curve' ? t('曲線至少要兩點') : t('多邊形至少要三點')) : t('刪除這一點')} onClick={() => apply(deleteVertex(measurement, r.index))}>
                  ✕
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
