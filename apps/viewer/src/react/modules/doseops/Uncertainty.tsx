/**
 * 劑量計算的統計不確定度圖（1σ，%）：載入 Monte Carlo 結果時一起產生，預設隱藏。列在同一個空間底下：
 * 顯示開關、門檻線開關、色階條；選取後有說明與「丟棄」。不是劑量 —— 不能運算、不畫 DVH、不存成 RTDOSE。
 */

import { uncertaintyColorFraction, uncertaintyDisplayOf, uncertaintyLut, type Layer } from '../../../core';
import { t } from '../../../core/i18n';
import type { ViewerPanelProps } from '../../panels/types';
import type { DoseOpResult } from './model';

const LUT = uncertaintyLut();

function rgb(fraction: number): string {
  const k = Math.round(Math.min(1, Math.max(0, fraction)) * 255);
  return `rgb(${LUT[k * 3]},${LUT[k * 3 + 1]},${LUT[k * 3 + 2]})`;
}

export function UncertaintyObject({ api, layer, result, selected, onSelect, onDiscarded }: ViewerPanelProps & { layer: Layer; result: DoseOpResult | undefined; selected: boolean; onSelect: () => void; onDiscarded: () => void }): React.JSX.Element {
  const d = uncertaintyDisplayOf(layer);
  const discard = async (): Promise<void> => {
    const { studyId } = api.state;
    if (!studyId) return;
    try {
      await api.http.deleteJson(`/studies/${encodeURIComponent(studyId)}/dose-ops/${encodeURIComponent(layer.contentRef)}`);
      onDiscarded();
    } catch (e) {
      api.commands.setError(t('丟棄失敗：{msg}', { msg: e instanceof Error ? e.message : String(e) }));
    }
  };
  const stops = [0, 1 / 3, 2 / 3, 1].map((f) => `${rgb(f)} ${Math.round(f * 100)}%`).join(', ');
  return (
    <li className={`dose-object uncertainty-object${selected ? ' selected' : ''}`} data-series={layer.contentRef}>
      <button type="button" className="dose-object-name" aria-pressed={selected} onClick={onSelect} title={t('選取這個不確定度圖')}>
        {result?.text ?? layer.label}
      </button>
      <div className="layer-row uncertainty-row">
        <label className="visibility" title={t('顯示／隱藏')}>
          <input type="checkbox" checked={layer.visible} onChange={(e) => api.commands.setVisible(layer.layerId, e.target.checked)} data-field="uncertainty-visible" />
        </label>
        <span className="kind">σ</span>
        {layer.visible && (
          <label className="small" title={t('不確定度 {p}% 的線', { p: d.thresholdPercent })}>
            <input type="checkbox" checked={d.isolines} onChange={(e) => api.commands.setLayerParams(layer.layerId, { isolines: e.target.checked })} data-field="uncertainty-isolines" />
            {t('{p}% 線', { p: d.thresholdPercent })}
          </label>
        )}
      </div>
      {layer.visible && (
        <div className="uncertainty-scale small" role="img" aria-label={t('色階：0 到 {max}%', { max: d.maxPercent })}>
          <span className="uncertainty-scale-bar" style={{ background: `linear-gradient(to right, ${stops})` }} />
          <span className="uncertainty-scale-axis">
            <span style={{ left: 0 }}>0</span>
            <span style={{ left: `${uncertaintyColorFraction(d.thresholdPercent, d.maxPercent) * 100}%` }}>{d.thresholdPercent}%</span>
            <span style={{ right: 0 }}>≥ {d.maxPercent}%</span>
          </span>
        </div>
      )}
      {selected && (
        <div className="uncertainty-details small" data-for={layer.contentRef}>
          <p>{t('每個體素的統計不確定度（1σ，相對於該點的劑量）。劑量低於最大值 10% 的地方不畫。')}</p>
          <p className="muted">{t('比 {p}% 大的地方，雜訊本身就可能讓 3% 的 γ 判準失敗：加歷史數或用較粗的計算網格可以降低。', { p: d.thresholdPercent })}</p>
          <div className="buttons small">
            <button type="button" onClick={() => void discard()} data-action="uncertainty-discard">
              {t('丟棄')}
            </button>
          </div>
        </div>
      )}
    </li>
  );
}
