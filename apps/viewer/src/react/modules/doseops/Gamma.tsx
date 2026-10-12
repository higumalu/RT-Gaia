/**
 * γ 比較：左側「劑量」面板裡選一個劑量（參考）→ 選同一個空間的另一個劑量（被評估）、設條件 →「計算 γ」。
 * 結果是一個 γ 圖（自己的圖層種類，不是劑量），列在同一個空間底下：通過率、失敗點的說明、直方圖、每個結構的通過率。
 */

import { useState } from 'react';

import { gammaColorFraction, gammaLut, type Layer } from '../../../core';
import { joinClauses, t } from '../../../core/i18n';
import type { ViewerPanelProps } from '../../panels/types';
import type { DoseOpResult, DoseOpSource } from './model';
import {
  DEFAULT_GAMMA_CRITERIA,
  gammaCandidates,
  gammaExplanation,
  gammaRequest,
  gammaSummaryText,
  gammaVerdict,
  pct,
  type GammaRegion,
  type GammaStats,
} from './gammaModel';

const RESOLUTIONS: readonly (3 | 5 | 10)[] = [3, 5, 10];

/** 選取的劑量（參考）底下的「γ 比較」表單。 */
export function GammaForm({ api, reference, sources, onDone }: ViewerPanelProps & { reference: DoseOpSource; sources: readonly DoseOpSource[]; onDone: (id: string) => void }): React.JSX.Element {
  const { studyId } = api.state;
  const candidates = gammaCandidates(reference, sources);
  const [evalId, setEvalId] = useState('');
  const [doseText, setDose] = useState(String(DEFAULT_GAMMA_CRITERIA.dose_pct));
  const [dtaText, setDta] = useState(String(DEFAULT_GAMMA_CRITERIA.dta_mm));
  const [thresholdText, setThreshold] = useState(String(DEFAULT_GAMMA_CRITERIA.threshold_pct));
  const [normalization, setNormalization] = useState<'global' | 'local'>('global');
  const [resolution, setResolution] = useState<3 | 5 | 10>(DEFAULT_GAMMA_CRITERIA.resolution);
  const [maxGamma, setMaxGamma] = useState(DEFAULT_GAMMA_CRITERIA.max_gamma);
  const [busy, setBusy] = useState(false);
  const ev = candidates.find((s) => s.series_id === evalId) ?? candidates[0];
  const refProblems = reference.gamma_problems ?? [];
  const [body, problem] = gammaRequest({ doseText, dtaText, thresholdText, normalization, resolution, maxGamma });
  const blocked = refProblems.length > 0 ? joinClauses(refProblems) : ev === undefined ? t('選被評估的劑量') : problem;
  const run = async (): Promise<void> => {
    if (!studyId || !ev || body === null) return;
    setBusy(true);
    try {
      const r = await api.http.postJson<DoseOpResult>(`/studies/${encodeURIComponent(studyId)}/dose-ops/gamma`, { ...body, reference: reference.series_id, evaluated: ev.series_id });
      onDone(r.series_id);
    } catch (e) {
      api.commands.setError(t('γ 比較失敗：{msg}', { msg: e instanceof Error ? e.message : String(e) }));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="dose-action dose-action-gamma" data-for={reference.series_id}>
      <span className="dose-action-title" title={t('這個劑量當參考，在被評估劑量裡找每一點最接近的相符劑量（3D γ）')}>
        {t('γ 比較')}
      </span>
      {refProblems.length > 0 ? (
        <span className="muted small">{joinClauses(refProblems)}</span>
      ) : candidates.length === 0 ? (
        <span className="muted small">{t('同一個空間沒有可以比較的劑量：先對別的劑量套用 REG，搬到這個空間')}</span>
      ) : (
        <>
          <label className="small">
            {t('被評估')}
            <select value={ev?.series_id ?? ''} onChange={(e) => setEvalId(e.target.value)} data-field="gamma-evaluated">
              {candidates.map((s) => (
                <option key={s.series_id} value={s.series_id}>
                  {s.label}
                  {s.derived ? ` · ${t('暫存結果')}` : ''}
                </option>
              ))}
            </select>
          </label>
          <span className="gamma-criteria small">
            <input className="num" inputMode="decimal" value={doseText} onChange={(e) => setDose(e.target.value)} aria-label={t('劑量差（%）')} data-field="gamma-dose" />
            % /
            <input className="num" inputMode="decimal" value={dtaText} onChange={(e) => setDta(e.target.value)} aria-label={t('距離（mm）')} data-field="gamma-dta" />
            mm
            <select value={normalization} onChange={(e) => setNormalization(e.target.value as 'global' | 'local')} aria-label={t('正規化')} data-field="gamma-norm">
              <option value="global">{t('全域')}</option>
              <option value="local">{t('局部')}</option>
            </select>
            {t('門檻')}
            <input className="num" inputMode="decimal" value={thresholdText} onChange={(e) => setThreshold(e.target.value)} aria-label={t('低劑量門檻（%）')} data-field="gamma-threshold" />%
          </span>
          <details className="small">
            <summary>{t('進階')}</summary>
            <label>
              {t('搜尋間距')}
              <select value={resolution} onChange={(e) => setResolution(Number(e.target.value) as 3 | 5 | 10)} data-field="gamma-resolution">
                {RESOLUTIONS.map((r) => (
                  <option key={r} value={r}>
                    DTA ÷ {r}
                  </option>
                ))}
              </select>
            </label>
            <label>
              {t('γ 上限')}
              <select value={maxGamma} onChange={(e) => setMaxGamma(Number(e.target.value))} data-field="gamma-max">
                <option value={2}>2</option>
                <option value={3}>3</option>
              </select>
            </label>
            <p className="muted">{t('全域：劑量差以參考劑量的最大值為基準；局部：以每一點自己的劑量為基準。低於門檻的點不評估。搜尋間距越細越準、也越慢。')}</p>
          </details>
          <button type="button" className="primary" disabled={busy || blocked !== null} title={blocked ?? undefined} onClick={() => void run()} data-action="gamma">
            {busy ? t('計算中…') : t('計算 γ')}
          </button>
        </>
      )}
    </div>
  );
}

/** 空間底下的一個 γ 圖：顯示開關、通過率；選取後展開說明、直方圖、每個結構的通過率。 */
export function GammaObject({ api, layer, result, selected, onSelect, onDiscarded }: ViewerPanelProps & { layer: Layer; result: DoseOpResult | undefined; selected: boolean; onSelect: () => void; onDiscarded: () => void }): React.JSX.Element {
  const g = result?.gamma;
  const set = (patch: Record<string, unknown>): void => api.commands.setLayerParams(layer.layerId, patch);
  const p = layer.params ?? {};
  const verdict = g ? gammaVerdict(g) : null;
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
  return (
    <li className={`dose-object gamma-object${selected ? ' selected' : ''}`} data-series={layer.contentRef} data-verdict={verdict ?? 'none'}>
      <button type="button" className="dose-object-name" aria-pressed={selected} onClick={onSelect} title={t('選取這個 γ 圖')}>
        {result?.text ?? layer.label}
      </button>
      <div className="layer-row gamma-row">
        <label className="visibility" title={t('顯示／隱藏')}>
          <input type="checkbox" checked={layer.visible} onChange={(e) => api.commands.setVisible(layer.layerId, e.target.checked)} />
        </label>
        <span className="kind">γ</span>
        {g && (
          <span className={`badge gamma-rate${verdict ? ` ${verdict}` : ''}`} title={verdict ? t('TG-218：≥ 95% 容許、< 90% 要處理（只對 3%/2 mm、全域、10% 門檻定義）') : undefined} data-pass-rate={g.pass_rate ?? ''}>
            {pct(g.pass_rate)}
          </span>
        )}
        {layer.visible && (
          <span className="gamma-toggles small">
            <label title={t('只塗 γ > 1 的點')}>
              <input type="checkbox" checked={p['fail_only'] === true} onChange={(e) => set({ fail_only: e.target.checked })} data-field="gamma-fail-only" />
              {t('只看失敗')}
            </label>
            <label title={t('γ ＝ 1 的線（通過與失敗的分界）')}>
              <input type="checkbox" checked={p['isolines'] !== false} onChange={(e) => set({ isolines: e.target.checked })} />
              {t('γ ＝ 1 線')}
            </label>
          </span>
        )}
      </div>
      {selected && g && <GammaDetails api={api} seriesId={layer.contentRef} g={g} onDiscard={() => void discard()} />}
      {selected && !g && (
        <div className="buttons small">
          <button type="button" onClick={() => void discard()}>
            {t('丟棄')}
          </button>
        </div>
      )}
    </li>
  );
}

function GammaDetails({ api, seriesId, g, onDiscard }: ViewerPanelProps & { seriesId: string; g: GammaStats; onDiscard: () => void }): React.JSX.Element {
  const [regions, setRegions] = useState<GammaRegion[] | null>(null);
  const [loading, setLoading] = useState(false);
  const structures = api.state.layers.filter((l) => l.kind === 'mask' && l.visible);
  const loadRegions = async (): Promise<void> => {
    if (structures.length === 0) return;
    setLoading(true);
    try {
      const ids = structures.map((l) => l.contentRef).join(',');
      setRegions((await api.http.getJson<{ regions: GammaRegion[] }>(`/dose/${encodeURIComponent(seriesId)}/gamma-regions?structure_ids=${encodeURIComponent(ids)}`)).regions);
    } catch (e) {
      api.commands.setError(t('結構通過率失敗：{msg}', { msg: e instanceof Error ? e.message : String(e) }));
    } finally {
      setLoading(false);
    }
  };
  return (
    <div className="gamma-details small" data-for={seriesId}>
      <p>
        <strong>{gammaSummaryText(g)}</strong>
      </p>
      <p className="muted">{t('參考：{ref} · 被評估：{ev}', { ref: g.reference_label, ev: g.evaluated_label })}</p>
      <ul className="gamma-explanation">
        {gammaExplanation(g).map((line) => (
          <li key={line}>{line}</li>
        ))}
      </ul>
      <GammaHistogram g={g} />
      <p className="muted">
        {joinClauses([
          t('平均 γ {v}', { v: g.mean_gamma?.toFixed(2) ?? '—' }),
          t('γ 第 95 百分位 {v}', { v: g.p95_gamma?.toFixed(2) ?? '—' }),
          t('{s} 秒', { s: g.seconds.toFixed(1) }),
        ])}
      </p>
      <div className="buttons">
        <button type="button" disabled={loading || structures.length === 0} title={structures.length === 0 ? t('先顯示要看的結構') : t('顯示中的結構各自的通過率')} onClick={() => void loadRegions()} data-action="gamma-regions">
          {loading ? t('計算中…') : t('各結構通過率')}
        </button>
        <button type="button" onClick={onDiscard} title={t('丟棄這個 γ 圖')}>
          {t('丟棄')}
        </button>
      </div>
      {regions && (
        <table className="gamma-regions">
          <thead>
            <tr>
              <th>{t('結構')}</th>
              <th>{t('通過率')}</th>
              <th>{t('平均 γ')}</th>
              <th>{t('最大 γ')}</th>
            </tr>
          </thead>
          <tbody>
            {regions.map((r) => (
              <tr key={r.structure_id} data-structure={r.structure_id}>
                <td>{r.name}</td>
                <td>{r.evaluated > 0 ? pct(r.pass_rate) : t('沒有評估的點')}</td>
                <td>{r.mean_gamma?.toFixed(2) ?? '—'}</td>
                <td>{r.max_gamma?.toFixed(2) ?? '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

const LUT = gammaLut();

/** γ 的直方圖：柱的顏色跟畫面上的色階一樣（1 以下藍綠、以上黃紅）。 */
function GammaHistogram({ g }: { g: GammaStats }): React.JSX.Element | null {
  const { edges, counts } = g.histogram;
  const peak = Math.max(1, ...counts);
  if (counts.length === 0) return null;
  return (
    <div className="gamma-histogram" role="img" aria-label={t('γ 直方圖')}>
      {counts.map((c, i) => {
        const mid = (edges[i]! + edges[i + 1]!) / 2;
        const k = Math.round(gammaColorFraction(mid, g.criteria.max_gamma) * 255);
        return <span key={i} style={{ height: `${Math.max(c > 0 ? 2 : 0, (c / peak) * 100)}%`, background: `rgb(${LUT[k * 3]},${LUT[k * 3 + 1]},${LUT[k * 3 + 2]})` }} title={`γ ${edges[i]!.toFixed(2)}–${edges[i + 1]!.toFixed(2)}: ${c.toLocaleString()}`} />;
      })}
      <span className="gamma-histogram-axis">
        <span style={{ left: 0 }}>0</span>
        <span style={{ left: `${100 / g.criteria.max_gamma}%` }}>1</span>
        <span style={{ right: 0 }}>{g.criteria.max_gamma}</span>
      </span>
    </div>
  );
}
