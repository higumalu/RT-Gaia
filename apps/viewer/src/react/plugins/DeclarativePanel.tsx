/**
 * 沒有 UI bundle 的 plugin 的右側欄面板：`params_schema` 生表單 → 執行 → job 進度 → 結果。
 * 結果進暫存集後由 `layer.add` 推送出現在畫面上；這裡只顯示摘要。
 */

import { useEffect, useMemo, useState } from 'react';

import type { ViewerPanelProps } from '../panels/types';
import type { PluginInfo } from './catalog';
import { asText, coerce, fieldsOf, initialParams, missingRequired, type Field } from './schemaForm';
import { joinList, t } from '../../core/i18n';

interface JobWire {
  readonly status: 'queued' | 'running' | 'done' | 'failed';
  readonly percent?: number;
  readonly phase?: string;
  readonly error?: string | null;
  readonly accepted?: number;
  readonly rejected?: number;
  readonly materialized?: number;
  readonly bundles?: { rejected: { code: string; reason: string }[] }[];
}

export function jobSummary(job: JobWire | null): string {
  if (job === null) return t('尚未執行');
  if (job.status === 'queued') return t('排隊中');
  if (job.status === 'running') return t('執行中 {p0}%{p1}', { p0: Math.round(job.percent ?? 0), p1: job.phase ? t('（{phase}）', { phase: job.phase }) : '' });
  if (job.status === 'failed') return t('失敗：{p0}', { p0: job.error ?? t('未知原因') });
  const rejected = job.bundles?.flatMap((b) => b.rejected) ?? [];
  const tail = rejected.length ? t('；拒收 {length}：{p1}', { length: rejected.length, p1: joinList(rejected.map((r) => `${r.code} ${r.reason}`)) }) : '';
  return t('完成：{p0} 個結構已放入「plugin 結果（未儲存）」{tail}', { p0: job.materialized ?? job.accepted ?? 0, tail });
}

export function DeclarativePanel({ api, plugin }: ViewerPanelProps & { plugin: PluginInfo }): React.JSX.Element {
  const fields = useMemo(() => fieldsOf(plugin.params_schema ?? null), [plugin.params_schema]);
  const [params, setParams] = useState<Record<string, unknown>>(() => initialParams(fields));
  const [raw, setRaw] = useState<Record<string, string>>({});
  const [job, setJob] = useState<JobWire | null>(null);
  const [jobId, setJobId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!jobId) return;
    let stop = false;
    const tick = async (): Promise<void> => {
      try {
        const j = await api.http.getJson<JobWire>(`/jobs/${encodeURIComponent(jobId)}`);
        if (stop) return;
        setJob(j);
        if (j.status === 'done' || j.status === 'failed') {
          if (j.status === 'done') void api.commands.refreshStructureSets().then(() => api.commands.refreshStructures());
          return;
        }
      } catch (e) {
        if (!stop) setError(e instanceof Error ? e.message : String(e));
        return;
      }
      setTimeout(() => void tick(), 1000);
    };
    void tick();
    return () => {
      stop = true;
    };
  }, [jobId, api.http, api.commands]);

  const set = (f: Field, value: string | boolean | string[]): void => {
    if (typeof value === 'string') setRaw((r) => ({ ...r, [f.name]: value }));
    const v = coerce(f, value);
    setParams((p) => {
      const next = { ...p };
      if (v === undefined) delete next[f.name];
      else next[f.name] = v;
      return next;
    });
  };

  const run = async (): Promise<void> => {
    const missing = missingRequired(fields, params);
    if (missing.length) {
      setError(t('必填：{p0}', { p0: joinList(missing) }));
      return;
    }
    setError(null);
    setJob({ status: 'queued' });
    try {
      const r = await api.http.postJson<{ job_id: string }>(`/plugins/${encodeURIComponent(plugin.plugin_id)}/run`, {
        params,
        study_id: api.state.studyId ?? undefined,
      });
      setJobId(r.job_id);
    } catch (e) {
      setJob(null);
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const busy = job?.status === 'queued' || job?.status === 'running';
  return (
    <section className="plugin-panel">
      <h3>
        {plugin.icon ? `${plugin.icon} ` : ''}
        {t(plugin.label)} <small className="muted">{plugin.version}</small>
      </h3>
      {plugin.description && <p className="muted small">{t(plugin.description)}</p>}
      {fields.length === 0 ? (
        <p className="muted small">{t('這個 plugin 沒有參數。')}</p>
      ) : (
        <div className="plugin-fields">
          {fields.map((f) => (
            <label key={f.name} title={f.description}>
              <span>
                {f.title}
                {f.required ? ' *' : ''}
              </span>
              {f.type === 'boolean' ? (
                <input type="checkbox" checked={params[f.name] === true} onChange={(e) => set(f, e.target.checked)} />
              ) : f.type === 'enum' ? (
                <select value={asText(params[f.name])} onChange={(e) => set(f, e.target.value)}>
                  <option value="">—</option>
                  {f.enum!.map((v) => (
                    <option key={v} value={v}>
                      {v}
                    </option>
                  ))}
                </select>
              ) : f.type === 'string[]' && f.itemEnum ? (
                <span className="plugin-checks">
                  {f.itemEnum.map((v) => {
                    const cur = (params[f.name] as string[] | undefined) ?? [];
                    return (
                      <label key={v}>
                        <input
                          type="checkbox"
                          checked={cur.includes(v)}
                          onChange={(e) => set(f, e.target.checked ? [...cur, v] : cur.filter((x) => x !== v))}
                        />
                        {v}
                      </label>
                    );
                  })}
                </span>
              ) : (
                <input
                  value={raw[f.name] ?? asText(params[f.name])}
                  inputMode={f.type === 'number' || f.type === 'integer' ? 'decimal' : undefined}
                  placeholder={f.type === 'string[]' ? t('以逗號分隔') : undefined}
                  onChange={(e) => set(f, e.target.value)}
                />
              )}
            </label>
          ))}
        </div>
      )}
      <button className="primary plugin-run" disabled={busy} onClick={() => void run()}>
        {t('執行')}
      </button>
      <p className="plugin-job">{jobSummary(job)}</p>
      {error && <p className="error-text">{error}</p>}
    </section>
  );
}
