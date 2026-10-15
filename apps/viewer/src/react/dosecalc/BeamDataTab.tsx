/**
 * 管理頁「射束資料」分頁 —— 射束模型擬合與驗證用的量測資料集（PDD、側向分佈、輸出因子、單一量值、絕對校正）。
 *
 * 內建的是公開文獻（CC BY）的表格，唯讀、標示範用；使用者的資料集：填機器、射束、來源 → 貼通用 CSV（解析預覽）→
 * 存成草稿（可以再改）→ 鎖定（之後不能改、不能刪，擬合要引用固定的內容）。任何一份都能複製成新草稿。
 */

import { useCallback, useEffect, useState } from 'react';

import { joinClauses, t } from '../../core/i18n';
import {
  beamText,
  countsText,
  curvePath,
  KIND_LABEL,
  machineText,
  plottable,
  SOURCE_LABEL,
  STATUS_LABEL,
  toCsv,
  type DatasetDetail,
  type DatasetSummary,
  type Measurement,
  type SourceKind,
} from './beamDataModel';

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
const send = (body: unknown, method = 'POST'): RequestInit => ({ method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

interface FormSeed {
  readonly mode: 'new' | 'copy' | 'edit';
  readonly from?: DatasetDetail;
}

export function BeamDataTab(): React.JSX.Element {
  const [rows, setRows] = useState<DatasetSummary[] | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [detail, setDetail] = useState<DatasetDetail | null>(null);
  const [measurement, setMeasurement] = useState<string | null>(null);
  const [form, setForm] = useState<FormSeed | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async (): Promise<void> => {
    try {
      setRows((await api<{ datasets: DatasetSummary[] }>('/beam-data')).datasets);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);
  useEffect(() => void load(), [load]);
  useEffect(() => {
    setMeasurement(null);
    if (selected === null) {
      setDetail(null);
      return;
    }
    let cancelled = false;
    api<DatasetDetail>(`/beam-data/${encodeURIComponent(selected)}`).then(
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
  const m = detail?.measurements.find((x) => x.measurement_id === measurement) ?? null;

  return (
    <section className="beamdata-tab">
      <h2>{t('射束資料')}</h2>
      <p className="muted">{t('射束模型擬合與驗證用的量測資料：深度劑量、側向分佈、輸出因子、單一量值（dmax、TPR20/10、半影、MLC 穿透…）與絕對校正。每一份都帶來源、引用與授權；不是實測的資料擬合出來的模型一律標示範用。內建的是公開文獻（CC BY）的表格，可以複製成新草稿再改；自己的資料用通用 CSV 匯入。')}</p>
      {error && <p className="error">{error}</p>}
      <table className="admin-table beamdata-list">
        <thead>
          <tr>
            <th>{t('名稱')}</th>
            <th>{t('機器')}</th>
            <th>{t('射束')}</th>
            <th>{t('來源')}</th>
            <th>{t('狀態')}</th>
            <th>{t('量測')}</th>
          </tr>
        </thead>
        <tbody>
          {(rows ?? []).map((r) => (
            <tr key={r.dataset_id} data-id={r.dataset_id} data-status={r.status} className={selected === r.dataset_id ? 'selected' : undefined} onClick={() => setSelected(selected === r.dataset_id ? null : r.dataset_id)}>
              <td>
                {r.name} {r.demo && <span className="badge badge-pending">{t('示範用')}</span>}
              </td>
              <td>{machineText(r.machine)}</td>
              <td>{beamText(r.beam)}</td>
              <td>{t(SOURCE_LABEL[r.source.kind])}</td>
              <td>
                <span className={`badge beamdata-status ${r.status}`}>{t(STATUS_LABEL[r.status])}</span>
              </td>
              <td className="muted">{countsText(r.measurement_counts, (k) => t(KIND_LABEL[k]))}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="buttons">
        <button type="button" onClick={() => setForm(form?.mode === 'new' ? null : { mode: 'new' })} aria-pressed={form?.mode === 'new'} data-action="beamdata-new">
          {t('＋ 新增資料集')}
        </button>
      </div>
      {form && (
        <BeamDataForm
          key={`${form.mode}:${form.from?.dataset_id ?? ''}`}
          seed={form}
          busy={busy}
          onCancel={() => setForm(null)}
          onSaved={(id) => {
            setForm(null);
            void load().then(() => setSelected(id));
          }}
          onError={setError}
        />
      )}
      {detail && (
        <div className="beamdata-detail" data-id={detail.dataset_id}>
          <h3>{detail.name}</h3>
          <p className="small">
            {machineText(detail.machine)} · {beamText(detail.beam)} · {t(SOURCE_LABEL[detail.source.kind])}
          </p>
          {detail.source.citation && <p className="muted small">{detail.source.citation}</p>}
          {(detail.source.licence || detail.source.url) && (
            <p className="muted small">
              {detail.source.licence}
              {detail.source.licence && detail.source.url ? ' · ' : ''}
              {detail.source.url && (
                <a href={detail.source.url} target="_blank" rel="noreferrer">
                  {detail.source.url}
                </a>
              )}
            </p>
          )}
          {detail.source.note && <p className="small">{detail.source.note}</p>}
          {detail.derived_from && <p className="muted small">{t('複製自 {id}', { id: detail.derived_from })}</p>}
          <div className="buttons">
            <button type="button" disabled={busy} onClick={() => setForm({ mode: 'copy', from: detail })} data-action="beamdata-copy">
              {t('複製成新草稿')}
            </button>
            {detail.status === 'draft' && (
              <>
                <button type="button" disabled={busy} onClick={() => setForm({ mode: 'edit', from: detail })} data-action="beamdata-edit">
                  {t('編輯')}
                </button>
                <button type="button" className="primary" disabled={busy} onClick={() => void act(`/beam-data/${encodeURIComponent(detail.dataset_id)}/lock`, send({}))} title={t('鎖定後內容不能改、不能刪（擬合要引用固定的內容）')} data-action="beamdata-lock">
                  {t('鎖定')}
                </button>
                <button type="button" disabled={busy} onClick={() => void act(`/beam-data/${encodeURIComponent(detail.dataset_id)}`, { method: 'DELETE' }).then(() => setSelected(null))}>
                  {t('刪除草稿')}
                </button>
              </>
            )}
          </div>
          <MeasurementTable measurements={detail.measurements} selected={measurement} onSelect={setMeasurement} />
          {m && <MeasurementView m={m} />}
        </div>
      )}
    </section>
  );
}

function MeasurementTable({ measurements, selected, onSelect, onRemove }: { measurements: readonly Measurement[]; selected: string | null; onSelect: (id: string | null) => void; onRemove?: (id: string) => void }): React.JSX.Element {
  return (
    <table className="admin-table beamdata-measurements">
      <thead>
        <tr>
          <th>{t('量測')}</th>
          <th>{t('種類')}</th>
          <th>{t('點數')}</th>
          <th>{t('統計')}</th>
          {onRemove && <th />}
        </tr>
      </thead>
      <tbody>
        {measurements.map((x) => (
          <tr key={x.measurement_id} data-id={x.measurement_id} className={selected === x.measurement_id ? 'selected' : undefined} onClick={() => onSelect(selected === x.measurement_id ? null : x.measurement_id)}>
            <td>{x.label ?? x.measurement_id}</td>
            <td>{t(KIND_LABEL[x.kind])}</td>
            <td>{x.points.length}</td>
            <td className="muted">{[x.statistic === 'single' ? '' : x.statistic, x.n !== null ? `n=${x.n}` : ''].filter(Boolean).join(' ')}</td>
            {onRemove && (
              <td>
                <button
                  type="button"
                  className="small"
                  onClick={(e) => {
                    e.stopPropagation();
                    onRemove(x.measurement_id);
                  }}
                  data-action="beamdata-remove-measurement"
                >
                  {t('移除')}
                </button>
              </td>
            )}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

const PLOT_W = 520;
const PLOT_H = 220;

/** 一筆量測：條件、資料點（曲線類畫折線）。 */
function MeasurementView({ m }: { m: Measurement }): React.JSX.Element {
  const plot = plottable(m) ? curvePath(m, PLOT_W, PLOT_H) : null;
  return (
    <div className="beamdata-measurement" data-id={m.measurement_id}>
      <h4>{m.label ?? m.measurement_id}</h4>
      <p className="muted small">
        {Object.entries(m.conditions)
          .map(([k, v]) => `${k} = ${Array.isArray(v) ? `${v[0]} × ${v[1]}` : String(v)}`)
          .join(' · ')}
        {` · unit = ${m.unit}`}
      </p>
      {m.reference && <p className="muted small">{m.reference}</p>}
      {plot && (
        <svg className="beamdata-plot" viewBox={`0 0 ${PLOT_W} ${PLOT_H}`} role="img" aria-label={t('量測曲線')}>
          <path d={plot.path} fill="none" stroke="#8ab4f8" strokeWidth={1.5} />
          {plot.dots.map(([x, y], i) => (
            <circle key={i} cx={x} cy={y} r={2} fill="#8ab4f8" />
          ))}
          <text x={4} y={PLOT_H - 8} fontSize={9} fill="currentColor" opacity={0.7}>
            {plot.xMin}
          </text>
          <text x={PLOT_W - 4} y={PLOT_H - 8} fontSize={9} textAnchor="end" fill="currentColor" opacity={0.7}>
            {`${plot.xMax} ${m.columns[0]}`}
          </text>
          <text x={4} y={12} fontSize={9} fill="currentColor" opacity={0.7}>
            {`${(plot.yMax / 1.1).toPrecision(3)} ${m.unit}`}
          </text>
        </svg>
      )}
      <table className="admin-table beamdata-points">
        <thead>
          <tr>
            {m.columns.map((c) => (
              <th key={c}>{c}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {m.points.slice(0, 200).map((r, i) => (
            <tr key={i}>
              {r.map((v, j) => (
                <td key={j}>{v === null ? '' : v}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function BeamDataForm({ seed, busy, onSaved, onCancel, onError }: { seed: FormSeed; busy: boolean; onSaved: (id: string) => void; onCancel: () => void; onError: (msg: string) => void }): React.JSX.Element {
  const from = seed.from;
  const copy = seed.mode === 'copy';
  const [name, setName] = useState(from ? (copy ? t('{name}（副本）', { name: from.name }) : from.name) : '');
  const [manufacturer, setManufacturer] = useState(from?.machine.manufacturer ?? '');
  const [model, setModel] = useState(from?.machine.model ?? '');
  const [machineName, setMachineName] = useState(from?.machine.name ?? '');
  const [energy, setEnergy] = useState(from ? String(from.beam.energy_mv) : '6');
  const [mode, setMode] = useState<'STANDARD' | 'FFF'>(from?.beam.fluence_mode ?? 'STANDARD');
  const [sourceKind, setSourceKind] = useState<SourceKind>(from?.source.kind ?? 'measured');
  const [citation, setCitation] = useState(from?.source.citation ?? '');
  const [licence, setLicence] = useState(from?.source.licence ?? '');
  const [url, setUrl] = useState(from?.source.url ?? '');
  const [sourceNote, setSourceNote] = useState(from?.source.note ?? '');
  const [measurements, setMeasurements] = useState<Measurement[]>(from ? [...from.measurements] : []);
  const [csv, setCsv] = useState('');
  const [problems, setProblems] = useState<string[]>([]);
  const [selected, setSelected] = useState<string | null>(null);

  const parse = async (): Promise<void> => {
    const r = await api<{ ok: boolean; problems: string[]; measurements: Measurement[] }>('/beam-data/parse-csv', send({ text: csv }));
    setProblems(r.problems);
    if (r.ok) {
      setMeasurements((ms) => [...ms, ...r.measurements]);
      setCsv('');
    }
  };
  const save = async (): Promise<void> => {
    const body = {
      name,
      machine: { manufacturer, model, name: machineName },
      beam: { energy_mv: Number(energy), fluence_mode: mode },
      source: { kind: sourceKind, citation, licence, url, note: sourceNote },
      measurements: measurements.map(({ label: _label, ...rest }) => rest),
      derived_from: copy ? from?.dataset_id : from?.derived_from,
    };
    try {
      const r = seed.mode === 'edit' && from ? await api<DatasetDetail>(`/beam-data/${encodeURIComponent(from.dataset_id)}`, send(body, 'PUT')) : await api<DatasetDetail>('/beam-data', send(body));
      onSaved(r.dataset_id);
    } catch (e) {
      onError(e instanceof Error ? e.message : String(e));
    }
  };
  const m = measurements.find((x) => x.measurement_id === selected) ?? null;
  return (
    <form className="beamdata-form" onSubmit={(e) => e.preventDefault()} data-mode={seed.mode}>
      {from && <p className="muted small">{seed.mode === 'edit' ? t('編輯草稿「{name}」', { name: from.name }) : t('以「{name}」為底的新草稿', { name: from.name })}</p>}
      <label>
        {t('名稱')}
        <input value={name} onChange={(e) => setName(e.target.value)} data-field="beamdata-name" />
      </label>
      <fieldset>
        <legend>{t('機器與射束')}</legend>
        <label>
          {t('製造商')}
          <input value={manufacturer} onChange={(e) => setManufacturer(e.target.value)} placeholder="Varian" data-field="beamdata-manufacturer" />
        </label>
        <label>
          {t('機型')}
          <input value={model} onChange={(e) => setModel(e.target.value)} placeholder="TrueBeam" data-field="beamdata-model" />
        </label>
        <label>
          {t('機器名稱')}
          <input value={machineName} onChange={(e) => setMachineName(e.target.value)} placeholder="LA3" />
        </label>
        <label>
          {t('能量（MV）')}
          <input className="num" inputMode="decimal" value={energy} onChange={(e) => setEnergy(e.target.value)} data-field="beamdata-energy" />
        </label>
        <label>
          {t('通量模式')}
          <select value={mode} onChange={(e) => setMode(e.target.value as 'STANDARD' | 'FFF')} data-field="beamdata-mode">
            <option value="STANDARD">STANDARD</option>
            <option value="FFF">FFF</option>
          </select>
        </label>
      </fieldset>
      <fieldset>
        <legend>{t('來源')}</legend>
        <label>
          {t('種類')}
          <select value={sourceKind} onChange={(e) => setSourceKind(e.target.value as SourceKind)} data-field="beamdata-source">
            {(Object.keys(SOURCE_LABEL) as SourceKind[]).map((k) => (
              <option key={k} value={k}>
                {t(SOURCE_LABEL[k])}
              </option>
            ))}
          </select>
        </label>
        <label className="wide">
          {t('出處（文獻、量測日期與設備）')}
          <input value={citation} onChange={(e) => setCitation(e.target.value)} data-field="beamdata-citation" />
        </label>
        <label>
          {t('授權')}
          <input value={licence} onChange={(e) => setLicence(e.target.value)} placeholder="CC BY 4.0" />
        </label>
        <label className="wide">
          URL
          <input value={url} onChange={(e) => setUrl(e.target.value)} />
        </label>
        <label className="wide">
          {t('備註')}
          <input value={sourceNote} onChange={(e) => setSourceNote(e.target.value)} />
        </label>
      </fieldset>
      {sourceKind !== 'measured' && <p className="warning small">{t('不是實測的資料：擬合出來的模型會標示範用')}</p>}
      <MeasurementTable measurements={measurements} selected={selected} onSelect={setSelected} onRemove={(id) => setMeasurements((ms) => ms.filter((x) => x.measurement_id !== id))} />
      {m && <MeasurementView m={m} />}
      <label className="beamdata-csv">
        {t('加入量測：貼通用 CSV（每筆以「# kind:」開頭，格式見管理文件）')}
        <textarea rows={8} value={csv} onChange={(e) => setCsv(e.target.value)} placeholder={'# kind: depth_dose\n# quantity: pdd\n# field_mm: 100 x 100\n# ssd_mm: 1000\n# unit: percent\n15, 100\n100, 66.4'} data-field="beamdata-csv" />
      </label>
      {problems.length > 0 && <p className="warning">{joinClauses(problems)}</p>}
      <div className="buttons">
        <button type="button" disabled={busy || csv.trim() === ''} onClick={() => void parse()} data-action="beamdata-parse">
          {t('解析並加入')}
        </button>
        {measurements.length > 0 && (
          <button
            type="button"
            onClick={() => {
              setCsv([toCsv(measurements), csv].filter((x) => x.trim() !== '').join('\n\n'));
              setMeasurements([]);
              setSelected(null);
            }}
            title={t('把目前的量測搬到 CSV 欄位裡改，改完再按「解析並加入」')}
            data-action="beamdata-export"
          >
            {t('改成 CSV 編輯')}
          </button>
        )}
      </div>
      <div className="buttons">
        <button type="button" className="primary" disabled={busy || name.trim() === ''} onClick={() => void save()} data-action="beamdata-save">
          {seed.mode === 'edit' ? t('存檔') : t('存成草稿')}
        </button>
        <button type="button" disabled={busy} onClick={onCancel}>
          {t('取消')}
        </button>
      </div>
    </form>
  );
}
