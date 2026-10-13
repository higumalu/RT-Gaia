/**
 * 管理頁「射束模型」分頁 —— 劑量計算用的射束模型（v1 只有內建的示範模型，唯讀）。
 *
 * 每個模型：能譜（圖）、原射源與機頭散射、準直器、MU 校正的參考條件與這台機器上的校正結果（每 MU 歷史數、
 * 參考條件模擬出來的深度劑量曲線）、文獻來源與限制。使用者自己的射束資料之後在這裡加。
 */

import { useEffect, useState } from 'react';

import { t } from '../../core/i18n';
import { calibrationText, collimatorText, COLLIMATOR_KIND_LABEL, pddAt, pddPoints, scientific, spectrumBars, type BeamModel } from './beamModelModel';

const PDD_MAX_DEPTH_MM = 300;

export function BeamModelTab(): React.JSX.Element {
  const [models, setModels] = useState<BeamModel[] | null>(null);
  const [engine, setEngine] = useState('');
  const [selected, setSelected] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    fetch('/api/v1/dosecalc/beam-models')
      .then(async (r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return (await r.json()) as { engine_version: string; models: BeamModel[] };
      })
      .then(
        (d) => {
          if (cancelled) return;
          setModels(d.models);
          setEngine(d.engine_version);
        },
        (e: unknown) => !cancelled && setError(e instanceof Error ? e.message : String(e)),
      );
    return () => {
      cancelled = true;
    };
  }, []);
  const m = models?.find((x) => x.model_id === selected) ?? null;
  return (
    <section className="beammodel-tab">
      <h2>{t('射束模型')}</h2>
      <p className="muted">{t('劑量計算（Monte Carlo）用的射束模型：能譜、射源、機頭散射、jaw／MLC 的幾何、MU 校正。依射束的能量、通量模式與 MLC 種類自動挑選。目前只有內建的示範模型，結果一律標示範用；使用者實測的射束資料之後加。')}</p>
      {error && <p className="error">{error}</p>}
      <table className="admin-table beammodel-list">
        <thead>
          <tr>
            <th>{t('名稱')}</th>
            <th>{t('能量')}</th>
            <th>MLC</th>
            <th>{t('MU 校正')}</th>
          </tr>
        </thead>
        <tbody>
          {(models ?? []).map((x) => (
            <tr key={x.model_id} data-id={x.model_id} className={selected === x.model_id ? 'selected' : undefined} onClick={() => setSelected(selected === x.model_id ? null : x.model_id)}>
              <td>
                {x.name} {x.demo && <span className="badge badge-pending">{t('示範用')}</span>}
              </td>
              <td>
                {x.energy_mv} MV {x.fluence_mode}
              </td>
              <td>{x.mlc_devices.join(' / ') || '—'}</td>
              <td className={x.calibrated ? undefined : 'muted'}>{x.calibrated ? t('已校正（{n} 個歷史）', { n: x.calibrated.histories.toLocaleString() }) : t('還沒校正（第一次計算時自動做）')}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {m && <BeamModelDetail m={m} engine={engine} />}
    </section>
  );
}

function BeamModelDetail({ m, engine }: { m: BeamModel; engine: string }): React.JSX.Element {
  const bars = spectrumBars(m.spectrum.energies_mev, m.spectrum.weights);
  const eMax = m.spectrum.energies_mev.at(-1) ?? 1;
  const cal = m.calibrated;
  const pdd10 = cal ? pddAt(cal.pdd, 100) : null;
  return (
    <div className="beammodel-detail" data-for={m.model_id}>
      <h3>
        {m.name} <span className="muted small">{t('雜湊 {h}', { h: m.model_hash })}</span>
      </h3>
      <div className="beammodel-grid">
        <section>
          <h4>{t('能譜')}</h4>
          <svg className="beammodel-spectrum" viewBox="0 0 300 120" role="img" aria-label={t('能譜')}>
            {bars.map((b) => (
              <rect key={b.hi} x={(b.lo / eMax) * 300} y={110 - b.height * 100} width={Math.max(0.5, ((b.hi - b.lo) / eMax) * 300 - 0.5)} height={b.height * 100} />
            ))}
            <line x1="0" y1="110" x2="300" y2="110" />
            <text x="0" y="120">0</text>
            <text x="300" y="120" textAnchor="end">
              {eMax} MeV
            </text>
          </svg>
          <p className="small">{t('平均能量 {e} MeV（{n} 段）', { e: m.spectrum.mean_mev.toFixed(2), n: bars.length })}</p>
        </section>
        <section>
          <h4>{t('射源')}</h4>
          <ul className="small">
            {m.focal_spot_sigma_mm !== null && <li>{t('焦點：高斯 σ {s} mm', { s: m.focal_spot_sigma_mm })}</li>}
            <li>{m.angular_sigma_deg ? t('角分佈：高斯 σ {s}°（無整平濾片，通量往外掉）', { s: m.angular_sigma_deg }) : t('角分佈：均勻')}</li>
            {m.extra_focal && <li>{t('機頭散射：靶下 {d} mm、σ {s} mm、佔 {p}%', { d: m.extra_focal.distance_below_target_mm, s: m.extra_focal.sigma_mm, p: Math.round(m.extra_focal.fraction * 100) })}</li>}
            {m.field_margin_mm !== null && <li>{t('發射範圍：開口外加 {mm} mm', { mm: m.field_margin_mm })}</li>}
          </ul>
        </section>
      </div>
      <h4>{t('準直器')}</h4>
      <table className="admin-table beammodel-collimators">
        <tbody>
          {m.collimators.map((c) => (
            <tr key={c.device} data-device={c.device}>
              <td>{c.device}</td>
              <td>{t(COLLIMATOR_KIND_LABEL[c.kind])}</td>
              <td>{collimatorText(c)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <h4>{t('MU 校正')}</h4>
      <p className="small">{calibrationText(m.calibration)}</p>
      {cal ? (
        <div className="beammodel-calibration">
          <p className="small">
            {t('每 MU {hpm} 個歷史；dmax {dmax} mm', { hpm: scientific(cal.histories_per_mu), dmax: cal.dmax_mm })}
            {pdd10 !== null && ` · ${t('PDD(10 cm) {v}', { v: pdd10.toFixed(3) })}`}
          </p>
          <svg className="beammodel-pdd" viewBox="0 0 300 120" role="img" aria-label={t('參考條件的深度劑量')}>
            <polyline points={pddPoints(cal.pdd, 300, 110, PDD_MAX_DEPTH_MM)} />
            <line x1="0" y1="110" x2="300" y2="110" />
            <text x="0" y="120">0</text>
            <text x="100" y="120" textAnchor="middle">
              10 cm
            </text>
            <text x="300" y="120" textAnchor="end">
              30 cm
            </text>
          </svg>
          <p className="muted small">{t('{n} 個歷史、{engine}', { n: cal.histories.toLocaleString(), engine: cal.engine_version })}</p>
        </div>
      ) : (
        <p className="muted small">{t('這台機器上還沒做過這個模型的 MU 校正（{engine}）：第一次用它計算時會先模擬參考條件。', { engine })}</p>
      )}
      <h4>{t('來源與限制')}</h4>
      <p className="small">{m.reference}</p>
      <ul className="small beammodel-limitations">
        {m.limitations.map((x) => (
          <li key={x}>{x}</li>
        ))}
      </ul>
    </div>
  );
}
