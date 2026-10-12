/**
 * 管理頁「CT 校正曲線」分頁 —— HU → 密度 ＋ 材質，劑量計算用。
 *
 * 內建 Schneider 2000（通用、示範用）一直都在：沒有符合比對規則的曲線時用它。使用者的曲線貼點表 → 預覽 → 存成草稿 →
 * 啟用（同一組比對規則的舊曲線自動停用）；啟用過的不能改、不能刪，只能停用。
 */

import { useCallback, useEffect, useState } from 'react';

import { joinClauses, t } from '../../core/i18n';
import {
  CLASS_LABEL,
  compositionText,
  curvePath,
  matchText,
  parsePoints,
  STATUS_LABEL,
  type CalibrationDetail,
  type CalibrationSummary,
  type SampledCurve,
} from './ctCalibrationModel';

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const r = await fetch(`/api/v1${path}`, init);
  if (!r.ok) {
    const text = await r.text();
    let message = text.slice(0, 300);
    try {
      const j = JSON.parse(text) as { detail?: { message?: string } | string };
      message = typeof j.detail === 'string' ? j.detail : (j.detail?.message ?? message);
    } catch {
      /* 不是 JSON */
    }
    throw new Error(message);
  }
  return (await r.json()) as T;
}
const post = (body: unknown): RequestInit => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

export function CtCalibrationTab(): React.JSX.Element {
  const [rows, setRows] = useState<CalibrationSummary[] | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [detail, setDetail] = useState<CalibrationDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [creating, setCreating] = useState(false);

  const load = useCallback(async (): Promise<void> => {
    try {
      setRows((await api<{ calibrations: CalibrationSummary[] }>('/ct-calibrations')).calibrations);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);
  useEffect(() => void load(), [load]);
  useEffect(() => {
    if (selected === null) {
      setDetail(null);
      return;
    }
    let cancelled = false;
    api<CalibrationDetail>(`/ct-calibrations/${encodeURIComponent(selected)}`).then(
      (d) => !cancelled && setDetail(d),
      (e: unknown) => !cancelled && setError(e instanceof Error ? e.message : String(e)),
    );
    return () => {
      cancelled = true;
    };
  }, [selected, rows]);

  const act = async (path: string, init: RequestInit): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      await api(path, init);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="ctcal-tab">
      <h2>{t('CT 校正曲線')}</h2>
      <p className="muted">{t('劑量計算用的 HU → 質量密度 ＋ 材質（元素組成）。每組 CT 依製造商、機型、kVp 對到一條啟用中的曲線；都對不到時用內建的 Schneider 2000 通用曲線（示範用，不代表任何一台 CT），結果會標出來。')}</p>
      {error && <p className="error">{error}</p>}
      <table className="admin-table ctcal-list">
        <thead>
          <tr>
            <th>{t('名稱')}</th>
            <th>{t('狀態')}</th>
            <th>{t('比對規則')}</th>
            <th>HU</th>
            <th>{t('建立／啟用')}</th>
          </tr>
        </thead>
        <tbody>
          {(rows ?? []).map((r) => (
            <tr key={r.calibration_id} data-id={r.calibration_id} data-status={r.status} className={selected === r.calibration_id ? 'selected' : undefined} onClick={() => setSelected(selected === r.calibration_id ? null : r.calibration_id)}>
              <td>
                {r.name} {r.demo && <span className="badge badge-pending">{t('示範用')}</span>}
              </td>
              <td>
                <span className={`badge ctcal-status ${r.status}`}>{t(STATUS_LABEL[r.status])}</span>
              </td>
              <td>{r.builtin ? t('（沒有對到的都用它）') : matchText(r.match)}</td>
              <td>
                {r.hu_range[0]} … {r.hu_range[1]}
              </td>
              <td className="muted">{[r.created_by && `${r.created_by} ${r.created_at?.slice(0, 10) ?? ''}`, r.activated_by && `→ ${r.activated_by} ${r.activated_at?.slice(0, 10) ?? ''}`].filter(Boolean).join(' ')}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="buttons">
        <button type="button" onClick={() => setCreating((v) => !v)} aria-pressed={creating} data-action="ctcal-new">
          {t('＋ 新增曲線')}
        </button>
      </div>
      {creating && (
        <CtCalibrationForm
          busy={busy}
          onSaved={(id) => {
            setCreating(false);
            void load().then(() => setSelected(id));
          }}
          onError={setError}
        />
      )}
      {detail && (
        <div className="ctcal-detail" data-id={detail.calibration_id}>
          <h3>{detail.name}</h3>
          {detail.reference && <p className="muted small">{detail.reference}</p>}
          {detail.note && <p className="small">{detail.note}</p>}
          <CurvePlot curve={detail.curve} materials={detail.materials} />
          <div className="buttons">
            {detail.status === 'draft' && (
              <>
                <button type="button" className="primary" disabled={busy} onClick={() => void act(`/ct-calibrations/${encodeURIComponent(detail.calibration_id)}/activate`, post({}))} title={t('啟用後內容不能改；同一組比對規則的舊曲線會自動停用')} data-action="ctcal-activate">
                  {t('啟用')}
                </button>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() =>
                    void act(`/ct-calibrations/${encodeURIComponent(detail.calibration_id)}`, { method: 'DELETE' }).then(() => setSelected(null))
                  }
                >
                  {t('刪除草稿')}
                </button>
              </>
            )}
            {detail.status === 'active' && (
              <button type="button" disabled={busy} onClick={() => void act(`/ct-calibrations/${encodeURIComponent(detail.calibration_id)}/retire`, post({}))} title={t('停用後不再被選到（保留紀錄，舊的結果仍說得出用了哪一條）')} data-action="ctcal-retire">
                {t('停用')}
              </button>
            )}
          </div>
          <details>
            <summary>{t('材質（Schneider 2000 的 25 段；使用者曲線只換密度、組成照這張表）')}</summary>
            <table className="admin-table ctcal-materials">
              <thead>
                <tr>
                  <th>#</th>
                  <th>HU</th>
                  <th>{t('類別')}</th>
                  <th>{t('元素組成（質量分率）')}</th>
                </tr>
              </thead>
              <tbody>
                {detail.materials.map((m) => (
                  <tr key={m.index}>
                    <td>{m.index + 1}</td>
                    <td>
                      {m.hu_lo} … {m.hu_hi}
                    </td>
                    <td>{t(CLASS_LABEL[m.class])}</td>
                    <td>{compositionText(m.composition)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </details>
        </div>
      )}
    </section>
  );
}

function CtCalibrationForm({ busy, onSaved, onError }: { busy: boolean; onSaved: (id: string) => void; onError: (msg: string) => void }): React.JSX.Element {
  const [name, setName] = useState('');
  const [manufacturer, setManufacturer] = useState('');
  const [model, setModel] = useState('');
  const [kvp, setKvp] = useState('');
  const [reference, setReference] = useState('');
  const [note, setNote] = useState('');
  const [pointsText, setPointsText] = useState('');
  const [preview, setPreview] = useState<SampledCurve | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [points, parseProblem] = parsePoints(pointsText);
  const body = () => ({
    name,
    points,
    reference,
    note,
    match: { manufacturer, model, kvp: kvp.trim() === '' ? null : Number(kvp) },
  });
  const doPreview = async (): Promise<void> => {
    if (parseProblem) {
      setProblem(parseProblem);
      return;
    }
    const r = await api<{ ok: boolean; problems: string[]; curve?: SampledCurve }>('/ct-calibrations/preview', post({ points }));
    setProblem(r.ok ? null : joinClauses(r.problems));
    setPreview(r.curve ?? null);
  };
  const save = async (): Promise<void> => {
    try {
      const r = await api<CalibrationDetail>('/ct-calibrations', post(body()));
      onSaved(r.calibration_id);
    } catch (e) {
      onError(e instanceof Error ? e.message : String(e));
    }
  };
  return (
    <form className="ctcal-form" onSubmit={(e) => e.preventDefault()}>
      <label>
        {t('名稱')}
        <input value={name} onChange={(e) => setName(e.target.value)} data-field="ctcal-name" />
      </label>
      <fieldset>
        <legend>{t('比對規則（空的欄位不比；至少填一項）')}</legend>
        <label>
          {t('製造商')}
          <input value={manufacturer} onChange={(e) => setManufacturer(e.target.value)} placeholder="Siemens" data-field="ctcal-manufacturer" />
        </label>
        <label>
          {t('機型')}
          <input value={model} onChange={(e) => setModel(e.target.value)} placeholder="SOMATOM go.Up" data-field="ctcal-model" />
        </label>
        <label>
          kVp
          <input className="num" inputMode="decimal" value={kvp} onChange={(e) => setKvp(e.target.value)} placeholder="120" data-field="ctcal-kvp" />
        </label>
      </fieldset>
      <label className="ctcal-points">
        {t('點表：一行一點「HU, 密度（g/cm³）」，HU 由小到大')}
        <textarea rows={8} value={pointsText} onChange={(e) => setPointsText(e.target.value)} placeholder={'-1000, 0.001\n-800, 0.20\n0, 1.00\n1000, 1.61\n3000, 2.80'} data-field="ctcal-points" />
      </label>
      <label>
        {t('來源（假體、量測日期、文獻）')}
        <input value={reference} onChange={(e) => setReference(e.target.value)} data-field="ctcal-reference" />
      </label>
      <label>
        {t('備註')}
        <input value={note} onChange={(e) => setNote(e.target.value)} />
      </label>
      {(problem ?? (pointsText.trim() ? parseProblem : null)) && <p className="warning">{problem ?? parseProblem}</p>}
      {preview && <CurvePlot curve={preview} materials={null} />}
      <div className="buttons">
        <button type="button" disabled={busy} onClick={() => void doPreview()} data-action="ctcal-preview">
          {t('預覽')}
        </button>
        <button type="button" className="primary" disabled={busy || parseProblem !== null || name.trim() === ''} onClick={() => void save()} data-action="ctcal-save">
          {t('存成草稿')}
        </button>
      </div>
    </form>
  );
}

const PLOT_W = 560;
const PLOT_H = 240;
const CLASS_FILL: Record<string, string> = { air: '#2a2f3a', lung: '#2f3d4f', adipose: '#4a4430', soft_tissue: '#4a3434', bone: '#3d3d46', metal: '#555' };

/** 密度曲線；有材質表就把各類別的 HU 範圍畫成底色帶。 */
function CurvePlot({ curve, materials }: { curve: SampledCurve; materials: CalibrationDetail['materials'] | null }): React.JSX.Element {
  const { path, x, y, huMax, rhoMax } = curvePath(curve, PLOT_W, PLOT_H);
  const yTicks = [0, 0.5, 1, 1.5, 2, 2.5, 3, 4, 5].filter((v) => v <= rhoMax);
  const xTicks = [-1000, 0, 1000, 2000, 3000].filter((v) => v <= huMax);
  return (
    <svg className="ctcal-plot" viewBox={`0 0 ${PLOT_W} ${PLOT_H}`} role="img" aria-label={t('HU → 密度曲線')}>
      {materials?.map((m) => (
        <rect key={m.index} x={x(m.hu_lo)} y={8} width={Math.max(0, x(Math.min(m.hu_hi, huMax)) - x(m.hu_lo))} height={PLOT_H - 36} fill={CLASS_FILL[m.class]} opacity={0.5}>
          <title>{`${t(CLASS_LABEL[m.class])} ${m.hu_lo} … ${m.hu_hi} HU`}</title>
        </rect>
      ))}
      {yTicks.map((v) => (
        <g key={`y${v}`}>
          <line x1={x(-1000)} x2={x(huMax)} y1={y(v)} y2={y(v)} stroke="currentColor" opacity={0.15} />
          <text x={2} y={y(v) + 3} fontSize={9} fill="currentColor" opacity={0.7}>
            {v}
          </text>
        </g>
      ))}
      {xTicks.map((v) => (
        <text key={`x${v}`} x={x(v)} y={PLOT_H - 8} fontSize={9} textAnchor="middle" fill="currentColor" opacity={0.7}>
          {v}
        </text>
      ))}
      <path d={path} fill="none" stroke="#8ab4f8" strokeWidth={1.5} />
      <text x={PLOT_W - 4} y={PLOT_H - 8} fontSize={9} textAnchor="end" fill="currentColor" opacity={0.7}>
        HU
      </text>
      <text x={4} y={12} fontSize={9} fill="currentColor" opacity={0.7}>
        g/cm³
      </text>
    </svg>
  );
}
