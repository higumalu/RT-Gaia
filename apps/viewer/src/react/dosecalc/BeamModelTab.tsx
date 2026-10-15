/**
 * 管理頁「射束模型」分頁 —— 劑量計算用的射束模型：內建的示範模型（唯讀）與從射束資料擬合出來的模型。
 *
 * 每個模型：能譜（圖）、原射源、機頭散射、電子污染、監測游離腔反散射、準直器、MU 校正的參考條件與這台機器上的校正
 * 結果、來源與限制。擬合出來的模型另外有：擬合的每一段（參數、用到的量測、成本、弱約束）與對擬合用、驗證用資料集的
 * 逐點比對；草稿 → 啟用（admin；同能量、模式、MLC 與機器名稱的舊模型自動停用）→ 停用。「擬合新模型」開 GPU 工作。
 */

import { useCallback, useEffect, useState } from 'react';

import { joinClauses, joinList, t } from '../../core/i18n';
import { beamText, type DatasetSummary } from './beamDataModel';
import {
  calibrationText,
  checkText,
  collimatorText,
  COLLIMATOR_KIND_LABEL,
  parameterText,
  pddAt,
  pddPoints,
  scientific,
  spectrumBars,
  STAGE_LABEL,
  USER_STATUS_LABEL,
  type BeamModel,
  type UserBeamModel,
  type UserBeamModelDetail,
  type UserModelStatus,
} from './beamModelModel';

function statusOf(x: BeamModel | UserBeamModel): UserModelStatus | 'builtin' {
  return 'status' in x ? x.status : 'builtin';
}

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const r = await fetch(`/api/v1${path}`, init);
  if (!r.ok) {
    const text = await r.text();
    let message = text.slice(0, 300);
    try {
      const j = JSON.parse(text) as { detail?: { message?: string; problems?: string[] } | string };
      message = typeof j.detail === 'string' ? j.detail : j.detail?.problems ? joinClauses(j.detail.problems) : (j.detail?.message ?? message);
    } catch {
      /* 不是 JSON */
    }
    throw new Error(message);
  }
  return (await r.json()) as T;
}
const post = (body: unknown): RequestInit => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

const PDD_MAX_DEPTH_MM = 300;

export function BeamModelTab(): React.JSX.Element {
  const [models, setModels] = useState<BeamModel[] | null>(null);
  const [users, setUsers] = useState<UserBeamModel[]>([]);
  const [engine, setEngine] = useState('');
  const [selected, setSelected] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [fitting, setFitting] = useState(false);
  const load = useCallback(async (): Promise<void> => {
    try {
      const d = await api<{ engine_version: string; models: BeamModel[]; user_models?: UserBeamModel[] }>('/dosecalc/beam-models');
      setModels(d.models);
      setUsers(d.user_models ?? []);
      setEngine(d.engine_version);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);
  useEffect(() => void load(), [load]);
  const user = users.find((x) => x.model_id === selected) ?? null;
  const m = user ?? models?.find((x) => x.model_id === selected) ?? null;
  return (
    <section className="beammodel-tab">
      <h2>{t('射束模型')}</h2>
      <p className="muted">{t('劑量計算（Monte Carlo）用的射束模型：能譜、射源、機頭散射、電子污染、jaw／MLC 的幾何、MU 校正。依射束的能量、通量模式、MLC 種類（與機器名稱）自動挑選：啟用中的擬合模型優先，沒有就用內建的示範模型。擬合模型從「射束資料」擬合（GPU）；擬合自非實測資料的一律標示範用。')}</p>
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
          {[...(models ?? []), ...users].map((x) => (
            <tr key={x.model_id} data-id={x.model_id} data-status={statusOf(x)} className={selected === x.model_id ? 'selected' : undefined} onClick={() => setSelected(selected === x.model_id ? null : x.model_id)}>
              <td>
                {x.name} {x.demo && <span className="badge badge-pending">{t('示範用')}</span>}{' '}
                <span className={`badge beammodel-status ${statusOf(x)}`}>{statusOf(x) === 'builtin' ? t('內建') : t(USER_STATUS_LABEL[statusOf(x) as UserModelStatus])}</span>
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
      <div className="buttons">
        <button type="button" onClick={() => setFitting((v) => !v)} aria-pressed={fitting} data-action="beammodel-fit">
          {t('＋ 擬合新模型')}
        </button>
      </div>
      {fitting && (
        <FitForm
          priors={[...(models ?? []), ...users.filter((u) => u.status !== 'retired')]}
          onDone={(id) => {
            setFitting(false);
            void load().then(() => setSelected(id));
          }}
          onError={setError}
        />
      )}
      {m && <BeamModelDetail m={m} engine={engine} />}
      {user && <UserModelPanel key={user.model_id} m={user} onChanged={() => void load()} onError={setError} />}
    </section>
  );
}

/** 擬合出來的模型：擬合的每一段、對資料集的逐點比對、啟用／停用／刪草稿。 */
function UserModelPanel({ m, onChanged, onError }: { m: UserBeamModel; onChanged: () => void; onError: (msg: string) => void }): React.JSX.Element {
  const [detail, setDetail] = useState<UserBeamModelDetail | null>(null);
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    api<UserBeamModelDetail>(`/dosecalc/beam-models/user/${encodeURIComponent(m.model_id)}`).then(
      (d) => !cancelled && setDetail(d),
      (e: unknown) => !cancelled && onError(e instanceof Error ? e.message : String(e)),
    );
    return () => {
      cancelled = true;
    };
  }, [m.model_id, m.status, onError]);
  const act = async (path: string, init: RequestInit): Promise<void> => {
    setBusy(true);
    try {
      await api(path, init);
      onChanged();
    } catch (e) {
      onError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  const base = `/dosecalc/beam-models/user/${encodeURIComponent(m.model_id)}`;
  return (
    <div className="beammodel-fit" data-for={m.model_id}>
      <h4>{t('擬合')}</h4>
      <p className="small">
        {t('先驗：{prior}；擬合用：{sets}', { prior: m.fit?.prior_model_id ?? '—', sets: (m.fit?.datasets ?? []).join(', ') || '—' })}
        {m.machines.length > 0 && ` · ${t('機器名稱：{names}', { names: m.machines.join(', ') })}`}
      </p>
      {m.fit && m.fit.unconstrained.length > 0 && <p className="warning small">{t('沒有資料約束（照先驗）：{names}', { names: joinList(m.fit.unconstrained.map((n) => t(STAGE_LABEL[n] ?? n))) })}</p>}
      <div className="buttons">
        {m.status === 'draft' && (
          <>
            <button type="button" className="primary" disabled={busy} onClick={() => void act(`${base}/activate`, post({}))} title={t('啟用後劑量計算會自動挑它；同能量、模式、MLC 與機器名稱的舊模型自動停用')} data-action="beammodel-activate">
              {t('啟用')}
            </button>
            <button type="button" disabled={busy} onClick={() => void act(base, { method: 'DELETE' })} data-action="beammodel-delete">
              {t('刪除草稿')}
            </button>
          </>
        )}
        {m.status === 'active' && (
          <button type="button" disabled={busy} onClick={() => void act(`${base}/retire`, post({}))} data-action="beammodel-retire">
            {t('停用')}
          </button>
        )}
      </div>
      {detail?.fit_report && (
        <table className="admin-table beammodel-stages">
          <thead>
            <tr>
              <th>{t('輪')}</th>
              <th>{t('段')}</th>
              <th>{t('參數')}</th>
              <th>{t('成本（前 → 後）')}</th>
              <th>{t('量測')}</th>
            </tr>
          </thead>
          <tbody>
            {detail.fit_report.stages.map((st, i) => (
              <tr key={i} data-stage={st.name}>
                <td>{st.round}</td>
                <td>
                  {t(STAGE_LABEL[st.name] ?? st.name)} {st.weakly_constrained && <span className="badge badge-pending" title={t('格點裡還有一樣好的其他值：資料約束不夠')}>{t('弱約束')}</span>}
                  {(st.at_bounds ?? []).length > 0 && (
                    <span className="badge badge-pending" title={t('停在搜尋範圍邊上：{names} —— 資料要的可能是模型沒有的東西', { names: (st.at_bounds ?? []).join(', ') })}>
                      {t('碰到邊界')}
                    </span>
                  )}
                </td>
                <td className="small">
                  {parameterText(st.parameters)}
                  {st.note && <div className="muted">{st.note}</div>}
                </td>
                <td className="small">{st.cost_before !== null && st.cost_after !== null ? `${st.cost_before.toFixed(2)} → ${st.cost_after.toFixed(2)}` : '—'}</td>
                <td className="small" title={st.measurements.join('\n')}>
                  {st.measurements.length}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <h4>{t('比對（擬合後的模型對射束資料）')}</h4>
      {(detail?.check_reports ?? []).map((c) => (
        <details key={`${c.role}:${c.dataset_id}`} open={open === c.dataset_id} onToggle={(e) => setOpen((e.target as HTMLDetailsElement).open ? c.dataset_id : null)} data-dataset={c.dataset_id}>
          <summary>
            <span className={`badge beammodel-role ${c.role}`}>{c.role === 'fit' ? t('擬合用') : t('驗證用')}</span> {c.dataset_id} — {checkText(c.summary)}
          </summary>
          <table className="admin-table beammodel-checks">
            <thead>
              <tr>
                <th>{t('量測')}</th>
                <th>x</th>
                <th>{t('量測值')}</th>
                <th>{t('模型')}</th>
                <th>{t('差（容許的倍數）')}</th>
              </tr>
            </thead>
            <tbody>
              {c.checks.map((r, i) => (
                <tr key={i} data-status={r.status} className={r.status === 'fail' ? 'fail' : undefined}>
                  <td>{r.label}</td>
                  <td>{r.x ?? ''}</td>
                  <td>{r.measured}</td>
                  <td>{r.model !== null ? Number(r.model.toPrecision(4)) : '—'}</td>
                  <td title={r.reason ?? r.note ?? ''}>{r.in_tolerance !== undefined ? r.in_tolerance.toFixed(2) : r.status === 'unsupported' ? t('不支援') : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </details>
      ))}
    </div>
  );
}

const HISTORY_CHOICES = [250_000_000, 500_000_000, 1_000_000_000];

/** 擬合新模型：先驗模型、擬合用與驗證用的射束資料（同能量、模式；內建或已鎖定）、機器名稱 → GPU 工作 → 完成後是草稿。 */
function FitForm({ priors, onDone, onError }: { priors: readonly BeamModel[]; onDone: (id: string) => void; onError: (msg: string) => void }): React.JSX.Element {
  const [datasets, setDatasets] = useState<DatasetSummary[]>([]);
  const [prior, setPrior] = useState(priors[0]?.model_id ?? '');
  const [roles, setRoles] = useState<Record<string, 'fit' | 'validate' | ''>>({});
  const [name, setName] = useState('');
  const [machines, setMachines] = useState('');
  const [histories, setHistories] = useState(500_000_000);
  const [job, setJob] = useState<{ id: string; model: string; phase: string; percent: number } | null>(null);
  useEffect(() => {
    api<{ datasets: DatasetSummary[] }>('/beam-data').then(
      (d) => setDatasets(d.datasets),
      (e: unknown) => onError(e instanceof Error ? e.message : String(e)),
    );
  }, [onError]);
  useEffect(() => {
    if (!job) return;
    const timer = window.setInterval(() => {
      api<{ status: string; phase: string; percent: number; error?: string | null }>(`/jobs/${encodeURIComponent(job.id)}`).then((j) => {
        if (j.status === 'done') {
          window.clearInterval(timer);
          onDone(job.model);
        } else if (j.status === 'failed' || j.status === 'cancelled') {
          window.clearInterval(timer);
          setJob(null);
          onError(j.error ?? j.status);
        } else {
          setJob((cur) => (cur ? { ...cur, phase: j.phase, percent: j.percent } : cur));
        }
      }, () => undefined);
    }, 3000);
    return () => window.clearInterval(timer);
  }, [job?.id]); // eslint-disable-line react-hooks/exhaustive-deps
  const p = priors.find((x) => x.model_id === prior);
  const usable = datasets.filter((d) => (d.status === 'builtin' || d.status === 'locked') && p && Math.abs(d.beam.energy_mv - p.energy_mv) < 0.01 && d.beam.fluence_mode === p.fluence_mode);
  const ids = (role: 'fit' | 'validate'): string[] => usable.filter((d) => roles[d.dataset_id] === role).map((d) => d.dataset_id);
  const start = async (): Promise<void> => {
    try {
      const r = await api<{ job_id: string; model_id: string }>('/dosecalc/beam-models/fit', post({ prior_model_id: prior, fit_datasets: ids('fit'), validate_datasets: ids('validate'), histories, name: name.trim() || undefined, machines: machines.split(/[,，\s]+/).filter(Boolean) }));
      setJob({ id: r.job_id, model: r.model_id, phase: 'queued', percent: 0 });
    } catch (e) {
      onError(e instanceof Error ? e.message : String(e));
    }
  };
  return (
    <form className="beammodel-fit-form" onSubmit={(e) => e.preventDefault()}>
      <label>
        {t('先驗模型（幾何與起始參數）')}
        <select value={prior} onChange={(e) => setPrior(e.target.value)} disabled={job !== null} data-field="fit-prior">
          {priors.map((x) => (
            <option key={x.model_id} value={x.model_id}>
              {x.name}
            </option>
          ))}
        </select>
      </label>
      <table className="admin-table beammodel-fit-datasets">
        <thead>
          <tr>
            <th>{t('射束資料')}</th>
            <th>{t('射束')}</th>
            <th>{t('用途')}</th>
          </tr>
        </thead>
        <tbody>
          {usable.map((d) => (
            <tr key={d.dataset_id} data-id={d.dataset_id}>
              <td>{d.name}</td>
              <td>{beamText(d.beam)}</td>
              <td>
                <select value={roles[d.dataset_id] ?? ''} disabled={job !== null} onChange={(e) => setRoles((r) => ({ ...r, [d.dataset_id]: e.target.value as 'fit' | 'validate' | '' }))} data-field="fit-role">
                  <option value="">{t('不用')}</option>
                  <option value="fit">{t('擬合')}</option>
                  <option value="validate">{t('驗證（不進擬合）')}</option>
                </select>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {usable.length === 0 && <p className="muted small">{t('沒有同能量、模式的內建或已鎖定射束資料')}</p>}
      <label>
        {t('名稱')}
        <input value={name} onChange={(e) => setName(e.target.value)} disabled={job !== null} placeholder={p ? `${p.name} (fitted)` : ''} data-field="fit-name" />
      </label>
      <label>
        {t('機器名稱（RTPLAN 的 TreatmentMachineName；空白 ＝ 所有同類射束）')}
        <input value={machines} onChange={(e) => setMachines(e.target.value)} disabled={job !== null} placeholder="LA3, LA4" data-field="fit-machines" />
      </label>
      <label>
        {t('每個條件的歷史數')}
        <select value={histories} onChange={(e) => setHistories(Number(e.target.value))} disabled={job !== null}>
          {HISTORY_CHOICES.map((h) => (
            <option key={h} value={h}>
              {scientific(h)}
            </option>
          ))}
        </select>
      </label>
      {job ? (
        <p className="small" data-job={job.id}>
          {t('擬合中（GPU，數十分鐘）：{phase}', { phase: job.phase })}
        </p>
      ) : (
        <div className="buttons">
          <button type="button" className="primary" disabled={ids('fit').length === 0} onClick={() => void start()} data-action="fit-start">
            {t('開始擬合')}
          </button>
        </div>
      )}
    </form>
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
