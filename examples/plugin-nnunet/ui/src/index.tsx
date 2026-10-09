/**
 * nnU-Net plugin 的右側欄面板：ROI 勾選 → 執行；模式（local／remote）與遠端 URL／port（admin 可改）。
 *
 * 只 import `@rtgaia/sdk` 與 React。所有請求走 `api.http`：
 * plugin 自訂端點在 `/modules/nnunet-oar/…`（宿主代理），觸發推論在宿主的 `/plugins/nnunet-oar/run`。
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { registerMessages, registerModule, t, type PluginUiEntry, type ViewerPanelProps } from '@rtgaia/sdk';

import { EN } from './en';

import {
  defaultImageSeries,
  filterLabels,
  imageChoices,
  jobLine,
  modeChangeAction,
  sortedLabels,
  structuresParam,
  toggle,
  validateRemote,
  type JobView,
  type Labels,
  type Settings,
} from './model';

const ID = 'nnunet-oar';
const VERSION = '0.2.2';

/**
 * 面板的樣式：bundle 只能是一個檔（docs/plugin-contract.md#ui-bundles），所以寫在這裡、註冊時插一次。
 * 字級、顏色跟著宿主（inherit），只排版。
 */
const STYLE = `
.nnunet-panel { font-size: inherit; padding: 4px 10px 10px; }
.nnunet-panel h3 { font-size: 1.05em; margin: 4px 0 8px; }
.nnunet-panel fieldset { border: 1px solid rgba(255,255,255,.12); border-radius: 6px; margin: 0 0 8px; padding: 6px 8px; }
.nnunet-panel legend { padding: 0 4px; opacity: .8; }
.nnunet-panel label { display: flex; align-items: center; gap: 6px; margin: 2px 0; }
.nnunet-panel input[type=text], .nnunet-panel input:not([type]), .nnunet-panel select { width: 100%; box-sizing: border-box; }
.nnunet-actions { display: flex; gap: 6px; margin: 6px 0; }
.nnunet-rois { list-style: none; margin: 0; padding: 0; max-height: 40vh; overflow-y: auto; }
.nnunet-rois small { opacity: .6; }
.nnunet-swatch { display: inline-block; width: 10px; height: 10px; border-radius: 2px; flex: none; }
.nnunet-hint { display: block; opacity: .7; margin-top: 4px; }
.nnunet-run { width: 100%; margin-top: 4px; }
.nnunet-job { margin: 6px 0 0; }
`;

function injectStyle(): void {
  if (typeof document === 'undefined' || document.getElementById(`${ID}-style`)) return;
  const el = document.createElement('style');
  el.id = `${ID}-style`;
  el.textContent = STYLE;
  document.head.appendChild(el);
}
const MODE = `plugin:${ID}`;
const BASE = `/modules/${ID}`;

function Panel({ api }: ViewerPanelProps): React.JSX.Element {
  const [labels, setLabels] = useState<Labels | null>(null);
  const [labelsError, setLabelsError] = useState<string | null>(null);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [query, setQuery] = useState('');
  const [job, setJob] = useState<JobView | null>(null);
  const [remoteUrl, setRemoteUrl] = useState('');
  const [remotePort, setRemotePort] = useState('8710');
  const [remoteMsg, setRemoteMsg] = useState<string | null>(null);
  const [modeDraft, setModeDraft] = useState<'local' | 'remote' | null>(null);
  const isAdmin = api.state.user?.role === 'admin';
  const mode = modeDraft ?? settings?.mode ?? 'local';
  // 要推論的影像：沒選過就跟著作用中的影像走
  const choices = imageChoices(api.state.layers);
  const [pickedSeries, setPickedSeries] = useState<string | null>(null);
  const chosenSeries = choices.some((c) => c.seriesId === pickedSeries)
    ? pickedSeries
    : defaultImageSeries(choices, api.state.layers, api.state.activeImageLayerId);

  const reload = useCallback(async () => {
    setLabelsError(null);
    try {
      const s = await api.http.getJson<Settings>(`${BASE}/settings`);
      setSettings(s);
      setRemoteUrl(s.remote_url);
      setRemotePort(String(s.remote_port));
      setLabels(await api.http.getJson<Labels>(`${BASE}/labels`));
    } catch (e) {
      setLabelsError(e instanceof Error ? e.message : String(e));
    }
  }, [api.http]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const rows = useMemo(() => (labels ? filterLabels(sortedLabels(labels), query) : []), [labels, query]);
  const total = labels ? Object.keys(labels).length : 0;

  async function run(): Promise<void> {
    if (!labels) return;
    setJob({ status: 'queued' });
    try {
      // 🔴 以前送 `image_layer_id`，宿主只認 `image_series_id` → 被忽略、永遠推論 primary
      const res = await api.http.postJson<{ job_id: string }>(`/plugins/${ID}/run`, {
        params: { structures: structuresParam(selected, total) },
        image_series_id: chosenSeries,
        ...(api.state.studyId ? { study_id: api.state.studyId } : {}),
      });
      setJob({ status: 'running', percent: 0 });
      // 進度由宿主的 job.progress 推送；這裡保守地輪詢一次到結束
      for (;;) {
        await new Promise((r) => setTimeout(r, 1500));
        const j = await api.http.getJson<JobView>(`/jobs/${res.job_id}`);
        setJob(j);
        if (j.status === 'done' || j.status === 'failed') break;
      }
    } catch (e) {
      setJob({ status: 'failed', error: e instanceof Error ? e.message : String(e) });
    }
  }

  async function saveSettings(next: 'local' | 'remote'): Promise<void> {
    const err = next === 'remote' ? validateRemote(remoteUrl, remotePort, t) : null;
    if (err) {
      setRemoteMsg(err);
      return;
    }
    try {
      const s = await api.http.patchJson<Settings>(`${BASE}/settings`, { mode: next, remote_url: remoteUrl.trim(), remote_port: Number(remotePort) || 8710 });
      setSettings(s);
      setModeDraft(null);
      setRemoteMsg(next === 'remote' ? t('已儲存並切到遠端') : t('已切回本機'));
      await reload();
    } catch (e) {
      setRemoteMsg(e instanceof Error ? e.message : String(e));
    }
  }

  function pickMode(next: 'local' | 'remote'): void {
    setRemoteMsg(null);
    if (modeChangeAction(next) === 'patch-now') {
      void saveSettings('local');
      return;
    }
    setModeDraft('remote'); // 先讓欄位出現；按「儲存」才送出
  }

  async function testRemote(): Promise<void> {
    setRemoteMsg(t('測試中…'));
    try {
      const r = await api.http.postJson<{ ok: boolean; error?: string; engine?: string }>(`${BASE}/remote/health`, {});
      setRemoteMsg(r.ok ? t('連線正常（engine {engine}）', { engine: r.engine ?? '?' }) : t('連不上：{error}', { error: r.error ?? '' }));
    } catch (e) {
      setRemoteMsg(e instanceof Error ? e.message : String(e));
    }
  }

  return (
    <section className="nnunet-panel">
      <h3>{t('AI 圈選（nnU-Net）')}</h3>

      <fieldset>
        <legend>{t('推論來源')}</legend>
        <label>
          <input type="radio" name="nnunet-mode" checked={mode === 'local'} disabled={!isAdmin} onChange={() => pickMode('local')} />
          {t('本機（與 RT-Gaia 一起部署；engine {engine}）', { engine: settings?.engine ?? '?' })}
        </label>
        <label>
          <input type="radio" name="nnunet-mode" checked={mode === 'remote'} disabled={!isAdmin} onChange={() => pickMode('remote')} />
          {t('遠端推論服務')}
        </label>
        {mode === 'remote' && (
          <div className="nnunet-remote">
            <label>
              URL <input value={remoteUrl} disabled={!isAdmin} onChange={(e) => setRemoteUrl(e.target.value)} placeholder="http://gpu-box" />
            </label>
            <label>
              port <input value={remotePort} disabled={!isAdmin} onChange={(e) => setRemotePort(e.target.value)} inputMode="numeric" />
            </label>
            {isAdmin && (
              <button className="primary" onClick={() => void saveSettings('remote')}>
                {t('儲存')}
              </button>
            )}
            {modeDraft === 'remote' && settings?.mode !== 'remote' && <small className="nnunet-hint">{t('填好 URL 與 port 後按「儲存」才會切到遠端')}</small>}
            <button onClick={() => void testRemote()}>{t('測試連線')}</button>
          </div>
        )}
        {remoteMsg && <p className="nnunet-msg">{remoteMsg}</p>}
        {!isAdmin && <p className="nnunet-hint">{t('只有 admin 能改推論來源（目前身分：{role}）。', { role: api.state.user?.role ?? t('未知') })}</p>}
      </fieldset>

      <fieldset className="nnunet-image">
        <legend>{t('要推論的影像')}</legend>
        {choices.length > 1 ? (
          <select value={chosenSeries ?? ''} onChange={(e) => setPickedSeries(e.target.value)}>
            {choices.map((c) => (
              <option key={c.seriesId} value={c.seriesId}>
                {c.label}
              </option>
            ))}
          </select>
        ) : (
          <span>{choices[0]?.label ?? t('（病例裡沒有影像）')}</span>
        )}
        <small className="nnunet-hint"> {t('結果會掛在這組影像的座標系（FoR）上。')}</small>
      </fieldset>

      <fieldset>
        <legend>{t('要推論的 ROI（{n}）', { n: selected.size === 0 ? t('全部') : `${selected.size} / ${total}` })}</legend>
        {labelsError && (
          <p className="nnunet-error">
            {t('取不到 ROI 清單：{error}', { error: labelsError })} <button onClick={() => void reload()}>{t('重試')}</button>
          </p>
        )}
        <input placeholder={t('搜尋名稱或 TG-263')} value={query} onChange={(e) => setQuery(e.target.value)} />
        <div className="nnunet-actions">
          <button onClick={() => setSelected(new Set())}>{t('全部')}</button>
          <button onClick={() => setSelected(new Set(rows.map((r) => r.info.name)))}>{t('選目前顯示的')}</button>
        </div>
        <ul className="nnunet-rois">
          {rows.map((r) => (
            <li key={r.value}>
              <label>
                <input type="checkbox" checked={selected.has(r.info.name)} onChange={() => setSelected(toggle(selected, r.info.name))} />
                <span className="nnunet-swatch" style={{ background: `rgb(${r.info.color.join(',')})` }} />
                {r.info.name}
                {r.info.tg263 && <small> {r.info.tg263}</small>}
              </label>
            </li>
          ))}
        </ul>
      </fieldset>

      <button className="nnunet-run" disabled={!labels || !chosenSeries || job?.status === 'running' || job?.status === 'queued'} onClick={() => void run()}>
        {t('執行推論')}
      </button>
      <p className="nnunet-job">{jobLine(job, t)}</p>
    </section>
  );
}

const entry: PluginUiEntry = {
  id: ID,
  version: VERSION,
  // 0.1.1：用到 SDK 的 registerMessages／t（介面語言）
  sdkVersion: '^0.1.1',
  register() {
    injectStyle();
    registerMessages('en', EN);
    registerModule({
      id: ID,
      version: VERSION,
      panels: [
        // 標題是原文：宿主顯示面板標題時經 t()，英文介面就是 EN 裡的那一條
        { id: `${ID}.panel`, slot: 'right-sidebar', order: 500, title: 'AI 圈選', component: Panel, visibleWhen: (s) => s.modes.includes(MODE) },
      ],
    });
  },
};

export default entry;
