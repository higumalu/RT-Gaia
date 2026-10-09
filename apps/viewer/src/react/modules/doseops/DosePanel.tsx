/**
 * 左側「劑量」面板 —— 劑量是空間裡的 3D 物件。
 *
 * 操作模型（取代一鍵的「累積劑量」—— 那樣綁得太死）：
 * 1. 先**選一個劑量物件**（清單依空間分組：計畫 CT、各個 CBCT…）；
 * 2. 要換空間 →「套用 REG」：選病例裡的哪一個 REG（或目前的對位）→ 產生**新的劑量物件**，放在目標空間；
 * 3. **同一個空間的劑量才能運算**（＋ − 兩個劑量、× ÷ 固定值）→ 新的劑量物件；結果可以再運算（串接）。
 * 例：fx1 套用 REG → CT、fx2 套用 REG → CT → 兩個相加 → 計畫 × 0.2 → 相減 ＝ 實際與計畫的差異。
 * 結果都是暫存的（只有自己看得到、關掉病例就沒了），「存檔…」在右側面板存成 RTDOSE。
 *
 * 病例裡有射束劑量（BEAM）時，上面多一區「射束劑量 → 計畫劑量」：
 * 射束齊全（剛好是計畫 fraction group 的全部射束）才能合成，不齊全就列出缺哪個、多哪個。
 */

import { useCallback, useEffect, useMemo, useState } from 'react';

import { groupLayersByFrame } from '../../panels/dataModel';
import { DoseRow } from '../../panels/DataPanel';
import type { ViewerPanelProps } from '../../panels/types';
import { DVH_MODE } from '../dvh/mode';
import { DVH_MODULE_ID, type DvhModuleState } from '../dvh/model';
import { DOSE_OPS_MODE } from './mode';
import { DOSE_OPS_MODULE_ID, type DoseOpsModuleState } from './state';
import { SignedStats } from './SignedStats';
import {
  DOSE_OPS,
  formProblem,
  needsB,
  previewText,
  sameSpaceOperands,
  sourceOptionText,
  summaryText,
  transformText,
  type DoseOp,
  type DoseOpResult,
  type DoseOpSource,
  type DoseTransform,
  beamGroupText,
  type BeamGroup,
} from './model';
import { joinClauses, t } from '../../../core/i18n';

export function DosePanel({ api }: ViewerPanelProps): React.JSX.Element | null {
  const { layers, frameGroups, studyId } = api.state;
  const doses = layers.filter((l) => l.kind === 'dose');
  const doseKey = doses.map((l) => l.layerId).join('|');
  const [sources, setSources] = useState<DoseOpSource[]>([]);
  const [results, setResults] = useState<DoseOpResult[]>([]);
  const [beamGroups, setBeamGroups] = useState<BeamGroup[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [summing, setSumming] = useState<string | null>(null);
  const { http } = api;
  const reload = useCallback(async (): Promise<void> => {
    if (!studyId) return;
    const base = `/studies/${encodeURIComponent(studyId)}/dose-ops`;
    try {
      const [src, res] = await Promise.all([http.getJson<{ sources: DoseOpSource[]; beam_groups?: BeamGroup[] }>(`${base}/sources`), http.getJson<{ results: DoseOpResult[] }>(base)]);
      setSources(src.sources);
      setBeamGroups(src.beam_groups ?? []);
      setResults(res.results);
    } catch {
      /* 清單照樣顯示；來源資訊只是補充 */
    }
  }, [http, studyId]);
  useEffect(() => {
    void reload();
  }, [reload, doseKey]);

  // 依空間（FoR）分組，順序跟資料面板的影像組一樣（主要影像在前）
  const spaces = useMemo(
    () =>
      groupLayersByFrame(layers, frameGroups)
        .filter((g) => g.doses.length > 0)
        .map((g) => ({ forUid: g.frameOfReferenceUid, title: `${g.title}${g.role === 'primary' ? t('（主要）') : ''}`, doses: g.doses })),
    [layers, frameGroups],
  );
  if (doses.length === 0) return null;
  const sel = selected !== null && doses.some((l) => l.contentRef === selected) ? selected : null;
  const beamSum = async (g: BeamGroup): Promise<void> => {
    if (!studyId) return;
    setSumming(g.plan_sop_uid);
    try {
      const r = await http.postJson<DoseOpResult>(`/studies/${encodeURIComponent(studyId)}/dose-ops`, { op: 'beam_sum', plan_sop_uid: g.plan_sop_uid });
      await reload();
      setSelected(r.series_id);
    } catch (e) {
      api.commands.setError(t('合成計畫劑量失敗：{msg}', { msg: e instanceof Error ? e.message : String(e) }));
    } finally {
      setSumming(null);
    }
  };
  return (
    <div className="dose-panel">
      <p className="muted small dose-panel-hint">{t('點一個劑量選取它，再「套用 REG」搬到別的空間，或跟同一個空間的劑量運算。')}</p>
      {beamGroups.length > 0 && (
        <section className="dose-beam-groups">
          <header className="dose-space-head">{t('射束劑量 → 計畫劑量')}</header>
          {beamGroups.map((g) => (
            <div key={g.plan_sop_uid || 'none'} className="dose-beam-group" data-plan={g.plan_sop_uid} data-eligible={g.eligible ? 'true' : 'false'}>
              <span className="small">{beamGroupText(g)}</span>
              {g.eligible ? (
                <button
                  type="button"
                  className="primary"
                  disabled={summing !== null}
                  data-action="beam-sum"
                  title={t('把這個計畫的射束劑量加起來，產生計畫劑量（暫存結果；射束剛好是計畫 fraction group {fg} 的全部射束）', { fg: g.fraction_group ?? 1 })}
                  onClick={() => void beamSum(g)}
                >
                  {summing === g.plan_sop_uid ? t('計算中…') : t('合成計畫劑量')}
                </button>
              ) : (
                <span className="warning small">{joinClauses(g.problems)}</span>
              )}
            </div>
          ))}
        </section>
      )}
      {spaces.map((sp) => (
        <section key={sp.forUid} className="dose-space" data-for={sp.forUid}>
          <header className="dose-space-head">{t('空間：{name}', { name: sp.title })}</header>
          <ul className="dose-objects">
            {sp.doses.map((layer) => {
              const src = sources.find((s) => s.series_id === layer.contentRef);
              const res = results.find((r) => r.series_id === layer.contentRef);
              const isSel = sel === layer.contentRef;
              return (
                <li key={layer.layerId} className={`dose-object${isSel ? ' selected' : ''}`} data-series={layer.contentRef} data-derived={res ? 'true' : 'false'}>
                  <button type="button" className="dose-object-name" aria-pressed={isSel} onClick={() => setSelected(isSel ? null : layer.contentRef)} title={t('選取這個劑量')}>
                    {res ? res.text : src?.label ?? layer.label}
                  </button>
                  <span className="muted small dose-object-where">
                    {joinClauses(
                      [
                        res ? t('暫存結果') : '',
                        src?.fractions_planned ? t('{n} 次', { n: src.fractions_planned }) : '',
                        typeof src?.max_gy === 'number' ? (src.min_gy !== null && src.min_gy < 0 ? t('{min} … {max} Gy', { min: src.min_gy.toFixed(2), max: src.max_gy.toFixed(2) }) : `Dmax ${src.max_gy.toFixed(2)} Gy`) : '',
                      ].filter(Boolean),
                    )}
                  </span>
                  <DoseRow layer={layer} api={api} />
                  {isSel && <DoseActions api={api} a={src} result={res} sources={sources} onChanged={(id) => {
                    void reload();
                    if (id !== undefined) setSelected(id);
                  }} />}
                </li>
              );
            })}
          </ul>
        </section>
      ))}
    </div>
  );
}

/** 選取的劑量能做的事：套用 REG、運算（同一個空間）、在 DVH 看；暫存結果多存檔、丟棄、差值統計。 */
function DoseActions({
  api,
  a,
  result,
  sources,
  onChanged,
}: ViewerPanelProps & { a: DoseOpSource | undefined; result: DoseOpResult | undefined; sources: readonly DoseOpSource[]; onChanged: (newId?: string | null) => void }): React.JSX.Element {
  const { studyId } = api.state;
  const { http } = api;
  const [transforms, setTransforms] = useState<DoseTransform[] | null>(null);
  const [transformId, setTransformId] = useState('');
  const [op, setOp] = useState<DoseOp>('add');
  const [bId, setB] = useState('');
  const [kText, setK] = useState('');
  const [busy, setBusy] = useState(false);
  const [warnings, setWarnings] = useState<readonly string[]>([]);
  const [stats, setStats] = useState(false);
  const aId = a?.series_id;
  useEffect(() => {
    if (!studyId || !aId) return;
    let cancelled = false;
    setTransforms(null);
    http.getJson<{ transforms: DoseTransform[] }>(`/studies/${encodeURIComponent(studyId)}/dose-ops/transforms?series_id=${encodeURIComponent(aId)}`).then(
      (r) => {
        if (cancelled) return;
        setTransforms(r.transforms);
        setTransformId(r.transforms.find((x) => !x.problem && x.kind === 'REG')?.transform_id ?? r.transforms.find((x) => !x.problem)?.transform_id ?? '');
      },
      () => !cancelled && setTransforms([]),
    );
    return () => {
      cancelled = true;
    };
  }, [http, studyId, aId]);
  const sameSpace = sameSpaceOperands(a, sources).filter((s) => s.eligible);
  const b = sameSpace.find((s) => s.series_id === bId) ?? sameSpace[0];
  const problem = formProblem(a, op, needsB(op) ? b : undefined, kText);
  const base = studyId ? `/studies/${encodeURIComponent(studyId)}/dose-ops` : '';

  const run = async (path: string, body: Record<string, unknown>, what: string): Promise<void> => {
    setBusy(true);
    try {
      const r = await http.postJson<DoseOpResult>(path, body);
      setWarnings(r.warnings);
      onChanged(r.series_id);
    } catch (e) {
      api.commands.setError(t('{what}失敗：{msg}', { what, msg: e instanceof Error ? e.message : String(e) }));
    } finally {
      setBusy(false);
    }
  };
  const applyReg = (): Promise<void> => run(`${base}/transform`, { series_id: aId, transform_id: transformId }, t('套用 REG'));
  const compute = (): Promise<void> =>
    run(base, needsB(op) ? { op, a: aId, b: b?.series_id } : { op, a: aId, k: Number(kText) }, t('劑量運算'));
  const showInDvh = (): void => {
    if (!aId) return;
    const cur = (api.state.modules[DVH_MODULE_ID] as DvhModuleState | undefined)?.doseIds ?? [];
    api.commands.setModuleState(DVH_MODULE_ID, { doseIds: cur.includes(aId) ? cur : [...cur, aId] });
    api.commands.setMode(DVH_MODE, true);
  };
  const discard = async (): Promise<void> => {
    if (!result || !studyId) return;
    try {
      await http.deleteJson(`${base}/${encodeURIComponent(result.series_id)}`);
      onChanged(null);
    } catch (e) {
      api.commands.setError(t('丟棄失敗：{msg}', { msg: e instanceof Error ? e.message : String(e) }));
    }
  };
  const openSave = (): void => {
    if (!result) return;
    api.commands.setModuleState(DOSE_OPS_MODULE_ID, { focus: result.series_id } satisfies Partial<DoseOpsModuleState>);
    api.commands.setMode(DOSE_OPS_MODE, true);
  };
  if (a === undefined) return <p className="muted small dose-actions">{t('讀取劑量資訊…')}</p>;
  return (
    <div className="dose-actions" data-for={aId}>
      {!a.eligible && <p className="warning small">{joinClauses(a.problems)}</p>}
      <div className="dose-action dose-action-reg">
        <span className="dose-action-title">{t('套用 REG')}</span>
        {transforms === null ? (
          <span className="muted small">{t('讀取…')}</span>
        ) : transforms.length === 0 ? (
          <span className="muted small">{t('這個空間沒有可以套用的 REG')}</span>
        ) : (
          <>
            <select value={transformId} onChange={(e) => setTransformId(e.target.value)} data-field="transform">
              {transforms.map((x) => (
                <option key={x.transform_id} value={x.transform_id} disabled={x.problem !== null} title={x.problem ?? undefined}>
                  {transformText(x)}
                  {x.problem ? ` — ${x.problem}` : ''}
                </option>
              ))}
            </select>
            <button type="button" disabled={busy || !transformId || !a.eligible} onClick={() => void applyReg()} title={t('依這個 REG 把劑量重取樣到目標空間，產生新的劑量物件（原劑量不動）')}>
              {t('套用 → 新劑量')}
            </button>
          </>
        )}
      </div>
      <div className="dose-action dose-action-op">
        <span className="dose-action-title">{t('運算')}</span>
        <span className="dose-op-ops" role="group" aria-label={t('運算')}>
          {DOSE_OPS.map((o) => (
            <button key={o.op} type="button" aria-pressed={op === o.op} title={t(o.title)} data-op={o.op} onClick={() => setOp(o.op)}>
              {o.symbol}
            </button>
          ))}
        </span>
        {needsB(op) ? (
          sameSpace.length === 0 ? (
            <span className="muted small">{t('同一個空間沒有其他劑量：先對別的劑量套用 REG，搬到這個空間')}</span>
          ) : (
            <select value={b?.series_id ?? ''} onChange={(e) => setB(e.target.value)} data-field="b" aria-label="B">
              {sameSpace.map((s) => (
                <option key={s.series_id} value={s.series_id}>
                  {sourceOptionText(s)}
                </option>
              ))}
            </select>
          )
        ) : (
          <>
            <input className="num" inputMode="decimal" value={kText} onChange={(e) => setK(e.target.value)} placeholder="k" data-field="k" aria-label="k" />
            {a.fractions_planned ? (
              <button type="button" className="link" onClick={() => setK(String(op === 'div' ? a.fractions_planned : 1 / a.fractions_planned!))} title={t('計畫的分次數')}>
                {op === 'div' ? `÷ ${a.fractions_planned}` : `× 1/${a.fractions_planned}`}
              </button>
            ) : null}
          </>
        )}
        <span className="dose-op-preview small">{previewText(a, op, needsB(op) ? b : undefined, kText)}</span>
        <button type="button" className="primary" disabled={busy || problem !== null} onClick={() => void compute()} title={problem ?? undefined} data-action="compute">
          {busy ? t('計算中…') : t('產生')}
        </button>
      </div>
      {warnings.length > 0 && (
        <ul className="warning small">
          {warnings.map((w) => (
            <li key={w}>{w}</li>
          ))}
        </ul>
      )}
      <div className="buttons small">
        <button type="button" onClick={showInDvh} title={t('把這個劑量加進 DVH（可以跟其他劑量比較）')} disabled={a.min_gy !== null && a.min_gy < 0}>
          {t('在 DVH 看')}
        </button>
        {result?.signed && (
          <button type="button" aria-pressed={stats} onClick={() => setStats((v) => !v)}>
            {t('差值統計')}
          </button>
        )}
        {result && (
          <>
            <button type="button" onClick={openSave} title={t('存成 RTDOSE（下載或存入資料庫）')}>
              {t('存檔…')}
            </button>
            <button type="button" onClick={() => void discard()} title={t('丟棄這個暫存結果')}>
              {t('丟棄')}
            </button>
          </>
        )}
      </div>
      {result && <p className="muted small">{summaryText(result)}</p>}
      {stats && result && <SignedStats api={api} seriesId={result.series_id} />}
    </div>
  );
}
