/**
 * 計畫面板的「重算劑量」：選引擎與劑量網格 → 送出（伺服器的 worker 在背景算）→ 進度 → 載入結果。
 * 結果是暫存劑量（只有自己看得到），出現在左側「劑量」面板，可以跟 TPS 劑量做 γ、看 DVH、存成 RTDOSE。
 */

import { useCallback, useEffect, useState } from 'react';

import { t } from '../../../core/i18n';
import type { ViewerPanelProps } from '../../panels/types';
import type { PlanInfo } from './model';
import { gammaSummaryText, gammaVerdict, type GammaStats } from '../doseops/gammaModel';
import type { DoseOpResult } from '../doseops/model';
import { DVH_MODE } from '../dvh/mode';
import { DVH_MODULE_ID, type DvhModuleState } from '../dvh/model';
import { CALC_SPACINGS, engineLabel, HISTORY_PRESETS, isActive, jobsForPlan, jobStatusText, summaryNotes, tpsDvhDoseIds, tpsGammaBody, uncertaintyNotes, type DosecalcEngine, type DosecalcJob } from './dosecalcModel';

const POLL_MS = 2000;

export function DoseCalcSection({ api, plan }: ViewerPanelProps & { plan: PlanInfo }): React.JSX.Element | null {
  const { studyId } = api.state;
  const { http } = api;
  const [engines, setEngines] = useState<DosecalcEngine[] | null>(null);
  const [engine, setEngine] = useState('');
  const [grid, setGrid] = useState<'tps' | 'ct'>('tps');
  const [histories, setHistories] = useState<number>(HISTORY_PRESETS[1]!.value);
  const [spacing, setSpacing] = useState<number | null>(CALC_SPACINGS[0]!.value);
  const [jobs, setJobs] = useState<DosecalcJob[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [compared, setCompared] = useState<Record<string, GammaStats>>({});
  const planSop = plan.sop_instance_uid;
  const base = studyId ? `/studies/${encodeURIComponent(studyId)}/dosecalc` : '';

  useEffect(() => {
    let cancelled = false;
    http.getJson<{ engines: DosecalcEngine[] }>('/dosecalc/engines').then(
      (r) => {
        if (cancelled) return;
        setEngines(r.engines);
        setEngine((cur) => cur || r.engines.find((e) => e.ready && !e.test_only)?.name || r.engines.find((e) => e.ready)?.name || '');
      },
      () => !cancelled && setEngines([]),
    );
    return () => {
      cancelled = true;
    };
  }, [http]);
  const reload = useCallback(async (): Promise<void> => {
    if (!base) return;
    try {
      setJobs((await http.getJson<{ jobs: DosecalcJob[] }>(base)).jobs);
    } catch {
      /* 清單只是補充 */
    }
  }, [http, base]);
  useEffect(() => void reload(), [reload]);
  const mine = jobsForPlan(jobs, planSop);
  const active = mine.some(isActive);
  useEffect(() => {
    if (!active) return undefined;
    const id = window.setInterval(() => void reload(), POLL_MS);
    return () => window.clearInterval(id);
  }, [active, reload]);

  if (!planSop) return null;
  const submit = async (): Promise<void> => {
    setBusy('submit');
    setProblem(null);
    try {
      await http.postJson(base, { plan_sop_uid: planSop, engine, grid, ...(chosen?.test_only ? {} : { histories, calc_spacing_mm: spacing }) });
      await reload();
    } catch (e) {
      setProblem(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };
  const load = async (j: DosecalcJob): Promise<void> => {
    setBusy(j.job_id);
    try {
      await http.postJson(`${base}/${encodeURIComponent(j.job_id)}/load`, {});
      await reload();
      api.commands.setNotice(t('結果已載入左側「劑量」面板（暫存，只有你看得到）'));
    } catch (e) {
      api.commands.setError(t('載入結果失敗：{msg}', { msg: e instanceof Error ? e.message : String(e) }));
    } finally {
      setBusy(null);
    }
  };
  const compareGamma = async (j: DosecalcJob): Promise<void> => {
    const body = tpsGammaBody(j);
    if (!body || !studyId) return;
    setBusy(`gamma:${j.job_id}`);
    try {
      const r = await http.postJson<DoseOpResult>(`/studies/${encodeURIComponent(studyId)}/dose-ops/gamma`, body);
      if (r.gamma) setCompared((cur) => ({ ...cur, [j.job_id]: r.gamma! }));
      api.commands.setNotice(t('γ 圖已加到左側「劑量」面板'));
    } catch (e) {
      api.commands.setError(t('γ 比較失敗：{msg}', { msg: e instanceof Error ? e.message : String(e) }));
    } finally {
      setBusy(null);
    }
  };
  const compareDvh = (j: DosecalcJob): void => {
    const cur = (api.state.modules[DVH_MODULE_ID] as DvhModuleState | undefined)?.doseIds ?? [];
    api.commands.setModuleState(DVH_MODULE_ID, { doseIds: tpsDvhDoseIds(j, cur) });
    api.commands.setMode(DVH_MODE, true);
  };
  const cancel = async (j: DosecalcJob): Promise<void> => {
    try {
      await http.deleteJson(`${base}/${encodeURIComponent(j.job_id)}`);
      await reload();
    } catch (e) {
      api.commands.setError(t('取消失敗：{msg}', { msg: e instanceof Error ? e.message : String(e) }));
    }
  };
  const chosen = engines?.find((e) => e.name === engine);
  return (
    <section className="plan-dosecalc" data-plan={planSop}>
      <header className="slab-header">{t('重算劑量')}</header>
      <p className="muted small">{t('用獨立的引擎在計畫 CT 上重算這份計畫，跟 TPS 劑量比對（γ、DVH）。結果先暫存，只有你看得到。')}</p>
      {engines === null ? (
        <p className="muted small">{t('讀取引擎…')}</p>
      ) : (
        <div className="slab-row plan-dosecalc-form">
          <select value={engine} onChange={(e) => setEngine(e.target.value)} aria-label={t('引擎')} data-field="dosecalc-engine">
            {engines.map((e) => (
              <option key={e.name} value={e.name} disabled={!e.ready} title={e.reason || undefined}>
                {engineLabel(e.name)}
                {e.ready ? '' : ` — ${e.reason}`}
              </option>
            ))}
          </select>
          <select value={grid} onChange={(e) => setGrid(e.target.value as 'tps' | 'ct')} aria-label={t('劑量網格')} data-field="dosecalc-grid">
            <option value="tps">{t('跟 TPS 劑量同網格')}</option>
            <option value="ct">{t('CT 範圍 2.5 mm')}</option>
          </select>
          {!chosen?.test_only && (
            <select value={histories} onChange={(e) => setHistories(Number(e.target.value))} aria-label={t('統計量')} data-field="dosecalc-histories" title={t('歷史數越多，統計不確定度越小、計算越久')}>
              {HISTORY_PRESETS.map((h) => (
                <option key={h.value} value={h.value}>
                  {t(h.label)}
                </option>
              ))}
            </select>
          )}
          {!chosen?.test_only && (
            <select value={spacing ?? ''} onChange={(e) => setSpacing(e.target.value === '' ? null : Number(e.target.value))} aria-label={t('計算網格')} data-field="dosecalc-calc-spacing" title={t('Monte Carlo 計分的網格：粗一點雜訊少、跑得快，半影會被平均掉一點')}>
              {CALC_SPACINGS.map((c) => (
                <option key={String(c.value)} value={c.value ?? ''}>
                  {t(c.label)}
                </option>
              ))}
            </select>
          )}
          <button type="button" className="primary" disabled={busy !== null || !chosen?.ready} onClick={() => void submit()} data-action="dosecalc-submit" title={chosen && !chosen.ready ? chosen.reason : undefined}>
            {busy === 'submit' ? t('準備中…') : t('重算劑量')}
          </button>
        </div>
      )}
      {problem && <p className="warning small dosecalc-problem">{problem}</p>}
      {mine.length > 0 && (
        <ul className="plan-dosecalc-jobs">
          {mine.map((j) => (
            <li key={j.job_id} data-job={j.job_id} data-status={j.status}>
              <div className="dosecalc-job-head">
                <span>{engineLabel(j.summary.engine)}</span>
                <span className="muted small">{j.requested_at.slice(5, 16).replace('T', ' ')}</span>
                <span className="small dosecalc-status">{jobStatusText(j)}</span>
              </div>
              {isActive(j) && <progress max={100} value={j.percent} />}
              <ul className="muted small dosecalc-notes">
                {summaryNotes(j.summary).map((n) => (
                  <li key={n}>{n}</li>
                ))}
              </ul>
              {uncertaintyNotes(j).map((n) => (
                <p key={n.text} className={n.noisy ? 'warning small dosecalc-noise' : 'small dosecalc-uncertainty'}>
                  {n.text}
                </p>
              ))}
              <div className="buttons small">
                {isActive(j) && (
                  <button type="button" onClick={() => void cancel(j)} data-action="dosecalc-cancel">
                    {t('取消')}
                  </button>
                )}
                {j.status === 'done' && j.loaded.length === 0 && (
                  <button type="button" className="primary" disabled={busy !== null} onClick={() => void load(j)} data-action="dosecalc-load">
                    {busy === j.job_id ? t('載入中…') : t('載入結果')}
                  </button>
                )}
                {j.loaded.length > 0 && <span className="muted">{t('已載入左側「劑量」面板')}</span>}
                {tpsGammaBody(j) && (
                  <>
                    <button type="button" disabled={busy !== null} onClick={() => void compareGamma(j)} data-action="dosecalc-tps-gamma" title={t('參考 ＝ TPS 劑量、被評估 ＝ 重算的總劑量；3%/2 mm、全域、10% 門檻（TG-218）')}>
                      {busy === `gamma:${j.job_id}` ? t('計算中…') : t('γ 比對 TPS（3%/2 mm）')}
                    </button>
                    <button type="button" onClick={() => compareDvh(j)} data-action="dosecalc-tps-dvh" title={t('TPS 劑量與重算的總劑量一起放進 DVH')}>
                      {t('DVH 對照')}
                    </button>
                  </>
                )}
              </div>
              {compared[j.job_id] && (
                <p className={`small dosecalc-gamma gamma-rate ${gammaVerdict(compared[j.job_id]!) ?? ''}`} data-pass-rate={compared[j.job_id]!.pass_rate ?? ''}>
                  {gammaSummaryText(compared[j.job_id]!)}
                </p>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
