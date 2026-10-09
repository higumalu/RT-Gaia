/**
 * 匯出面板 —— `right-sidebar`，`'export'` 模式開著時。
 *
 * 選結構（預設只選已簽核）→ `POST /studies/{studyId}/export` → 輪詢 `GET /jobs/{id}` → 進度 → 下載連結、
 * 被跳過的結構與送出的版本；底下是這個病例的匯出紀錄。純邏輯在 `model.ts`。
 * 匯出完成後可「送到節點」（`SendToNode.tsx`，C-STORE 到登錄的 PACS／TPS）。
 * 底下的清單是這個病例的匯出紀錄（`ExportRecordList`：重新下載、重送）。
 */

import { useCallback, useEffect, useRef, useState } from 'react';

import { defaultExportSelection } from '../../collab/model';
import { statusLabel } from '../review/model';
import { setLabel, setTitle } from '../../components/structureGroups';
import type { ViewerPanelProps } from '../../panels/types';
import { ExportRecordList } from './ExportRecordList';
import type { ExportRecord } from './exportRecords';
import { SendToNode } from './SendToNode';
import { exportBody, exportSummary, exportTargets, formatBytes, hasUnapproved, isTerminal, phaseLabel, SKIP_REASON, summarizeJob, TAG_LABEL, tagProblems, type EditableTag, type ExportPurpose, type JobInfo , isEmptyStructure, describeProfileWarning } from './model';
import { joinClauses, t } from '../../../core/i18n';

const POLL_MS = 600;

export function ExportPanel({ api }: ViewerPanelProps): React.JSX.Element {
  const { structures, studyId, caseId, frameGroups, structureSets } = api.state;
  const [selected, setSelected] = useState<Set<string>>(() => defaultExportSelection(structures, api.state.user?.username));
  const [target, setTarget] = useState<string | null>(null);
  // 預設匿名（假名）；關閉 → RTSTRUCT 帶真實病人識別，TPS 才掛得到病人
  const [anonymize, setAnonymize] = useState(true);
  // 可改的 DICOM 標籤（白名單由後端給）；同時匯入資料庫
  const [whitelist, setWhitelist] = useState<EditableTag[]>([]);
  const [tags, setTags] = useState<Record<string, string>>({});
  const [tagsOpen, setTagsOpen] = useState(false);
  const [purpose, setPurpose] = useState<ExportPurpose>('download');
  // 匯出 profile（預設 Varian Eclipse；清單與預設由後端給）
  const [profiles, setProfiles] = useState<{ id: string; label: string }[]>([]);
  const [profile, setProfile] = useState<string>('');
  const [uidRoot, setUidRoot] = useState<string>('');
  const saveToLibrary = purpose === 'library';
  useEffect(() => {
    api.http.getJson<{ tags: EditableTag[] }>('/export/tags').then((r) => setWhitelist(r.tags), () => setWhitelist([]));
    api.http
      .getJson<{ default: string; profiles: { id: string; label: string }[]; uid_root: string }>('/export/profiles')
      .then(
        (r) => {
          setProfiles(r.profiles);
          setProfile((p) => p || r.default);
          setUidRoot(r.uid_root);
        },
        () => setProfiles([]),
      );
  }, [api.http]);
  const problems = tagProblems(tags, whitelist);
  const [job, setJob] = useState<JobInfo | null>(null);
  const [recent, setRecent] = useState<ExportRecord[]>([]);
  const [busy, setBusy] = useState(false);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const primaryFor = frameGroups.find((fg) => fg.role === 'primary')?.frameOfReferenceUid ?? null;
  const targets = exportTargets(api.state.layers, frameGroups);
  const nameOf = (id: string): string => structures.find((s) => s.structureId === id)?.name ?? id;

  const loadRecent = useCallback(async () => {
    if (!caseId) return;
    try {
      // 匯出紀錄（下載、存入資料庫、送出都在；之前是 job 清單，混著匯入等其他工作）
      setRecent((await api.http.getJson<{ items: ExportRecord[] }>(`/export-records?case_id=${encodeURIComponent(caseId)}&limit=20`)).items);
    } catch {
      /* 不是關鍵路徑 */
    }
  }, [api.http, caseId]);
  useEffect(() => {
    void loadRecent();
  }, [loadRecent]);

  const run = async (): Promise<void> => {
    if (!studyId || selected.size === 0) return;
    setBusy(true);
    try {
      const started = await api.http.postJson<{ job_id: string }>(`/studies/${encodeURIComponent(studyId)}/export`, exportBody(selected, target ?? primaryFor, { anonymize: anonymize && !saveToLibrary, tags, saveToLibrary, ...(profile ? { profile } : {}) }));
      for (;;) {
        const j = await api.http.getJson<JobInfo>(`/jobs/${encodeURIComponent(started.job_id)}`);
        if (!alive.current) return;
        setJob(j);
        if (isTerminal(j.status)) break;
        await new Promise((r) => setTimeout(r, POLL_MS));
      }
      await loadRecent();
    } catch (e) {
      api.commands.setError(t('匯出失敗：{p0}', { p0: e instanceof Error ? e.message : String(e) }));
    } finally {
      setBusy(false);
    }
  };

  const toggle = (id: string): void =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  return (
    <div className="panel export-panel">
      <h3>{t('匯出 RTSTRUCT')}</h3>
      <div className="buttons small">
        <button type="button" onClick={() => setSelected(new Set(structures.filter((s) => s.status === 'approved').map((s) => s.structureId)))}>
          {t('只選已簽核')}
        </button>
        {structures.some((s) => s.structureSetKind === 'work' && s.structureSetOwner === api.state.user?.username) && (
          <button type="button" onClick={() => setSelected(new Set(structures.filter((s) => s.structureSetKind === 'work' && s.structureSetOwner === api.state.user?.username).map((s) => s.structureId)))}>
            {t('只選我的')}
          </button>
        )}
        <button type="button" onClick={() => setSelected(new Set(structures.map((s) => s.structureId)))}>
          {t('全選')}
        </button>
        <button type="button" onClick={() => setSelected(new Set())}>
          {t('清空')}
        </button>
      </div>
      {structureSets.length >= 2 && (
        <div className="buttons small export-sets">
          <span className="muted">{t('只選一套：')}</span>
          {structureSets.map((s) => (
            <button
              key={s.structureSetId}
              type="button"
              title={t('{label}（{imageLabel}）', { label: setLabel(s), imageLabel: s.imageLabel })}
              onClick={() => { setSelected(new Set(structures.filter((x) => x.structureSetId === s.structureSetId).map((x) => x.structureId))); setTarget(s.frameOfReferenceUid); }}
            >
              {setTitle(s)}
            </button>
          ))}
        </div>
      )}
      <ul className="export-list">
        {structures.map((s) => (
          <li key={s.structureId} data-status={s.status}>
            <label>
              <input type="checkbox" checked={selected.has(s.structureId)} onChange={() => toggle(s.structureId)} />
              <span className="swatch" style={{ background: s.colorRgb ? `rgb(${s.colorRgb.join(',')})` : undefined }} />
              {s.name ?? s.structureId}
              {isEmptyStructure(s) && (
                <span className="badge empty" title={t('體積 0：沒有任何體素（例：AI 找不到這個器官）。預設不匯出；勾了會寫成沒有輪廓的 ROI')}>
                  {t('空')}
                </span>
              )}
              <span className="muted"> {statusLabel(s.status)}</span>
            </label>
          </li>
        ))}
      </ul>
      {frameGroups.length > 1 && (
        <label className="target">
          {t('目標影像（FoR）')}
          {/* 模態＋日期＋描述（跟資料面板同一套名字）；FoR 放 title */}
          <select value={target ?? primaryFor ?? ''} onChange={(e) => setTarget(e.target.value)} title={targets.find((x) => x.frameOfReferenceUid === (target ?? primaryFor))?.detail}>
            {targets.map((x) => (
              <option key={x.frameOfReferenceUid} value={x.frameOfReferenceUid} title={x.detail}>
                {x.label}
              </option>
            ))}
          </select>
        </label>
      )}
      <fieldset className="export-purpose">
        <legend>{t('目的')}</legend>
        <label>
          <input type="radio" name="export-purpose" checked={purpose === 'download'} onChange={() => setPurpose('download')} />
          {t('下載檔案')} <span className="muted">{t('（之後也可送到節點）')}</span>
        </label>
        <label title={t('匯出後直接進匯入管線：資料庫該影像底下多一套 RTSTRUCT（唯讀的匯入集）；病例裡的工作集不動。編輯本來就會自動保存，這是做一份成品放進庫裡')}>
          <input type="radio" name="export-purpose" checked={purpose === 'library'} onChange={() => setPurpose('library')} />
          {t('存入資料庫')} <span className="muted">{t('（成為一套 RTSTRUCT；一律帶病人識別）')}</span>
        </label>
        {purpose === 'download' && (
          <label className="anonymize sub" title={t('勾：PatientName／ID 以假名取代（PHANTOM^RTGAIA）；不勾：寫入原影像的病人識別與 study 描述，TPS 才能掛到正確病人')}>
            <input type="checkbox" checked={anonymize} onChange={(e) => setAnonymize(e.target.checked)} />
            {t('匿名化（病人識別以假名取代）')}
          </label>
        )}
      </fieldset>
      {profiles.length > 0 && (
        <label className="export-profile" title={t('依接收端 TPS 的匯入限制調整 ROI 名稱、類型與字元集；每一項改動都會列在結果裡。UID 前綴：{uidRoot}', { uidRoot })}>
          TPS profile
          <select value={profile} onChange={(e) => setProfile(e.target.value)}>
            {profiles.map((p) => (
              <option key={p.id} value={p.id}>
                {t(p.label)}
              </option>
            ))}
          </select>
        </label>
      )}
      {!(anonymize && !saveToLibrary) && <p className="warning">{t('匯出檔會含病人識別資料（PHI）：姓名、病歷號、出生日期、性別與 study 描述。請確認接收端與傳輸路徑受信任。')}</p>}
      <details className="export-tags" open={tagsOpen} onToggle={(e) => setTagsOpen((e.target as HTMLDetailsElement).open)}>
        <summary>{t('DICOM 標籤（選填，留空用預設）')}</summary>
        <div className="tag-grid">
          {whitelist.map((tag) => (
            <label key={tag.keyword} title={t('{keyword} · {vr} · 最多 {max_length} 字{p3}', { keyword: tag.keyword, vr: tag.vr, max_length: tag.max_length, p3: tag.phi ? ' · PHI' : '' })}>
              <span className={tag.phi ? 'phi' : undefined}>{t(TAG_LABEL[tag.keyword] ?? tag.keyword)}</span>
              <input
                value={tags[tag.keyword] ?? ''}
                maxLength={tag.max_length}
                placeholder={tag.phi ? (anonymize && !saveToLibrary ? t('假名') : t('沿用原影像')) : tag.keyword === 'OperatorsName' ? api.state.user?.username ?? '' : t('預設')}
                onChange={(e) => setTags((prev) => ({ ...prev, [tag.keyword]: e.target.value }))}
              />
            </label>
          ))}
        </div>
        {problems.length > 0 && <p className="warning">{joinClauses(problems)}</p>}
      </details>
      {hasUnapproved(structures, selected) && <p className="warning">{t('選取中有未簽核的結構：匯出的是草稿，不是臨床核可版本。')}</p>}
      <p className="export-summary" title={t('按下去送出的內容')}>
        {exportSummary({
          count: selected.size,
          targetLabel: targets.find((x) => x.frameOfReferenceUid === (target ?? primaryFor))?.label ?? null,
          draftCount: structures.filter((s) => selected.has(s.structureId) && s.status !== 'approved').length,
          purpose,
          anonymize,
          tagCount: Object.values(tags).filter((v) => v.trim() !== '').length,
        })}
      </p>
      <button type="button" className="primary" disabled={busy || selected.size === 0 || !studyId || problems.length > 0} onClick={() => void run()}>
        {busy ? t('匯出中…') : purpose === 'library' ? t('產生並存入資料庫') : t('產生並下載')}
      </button>
      {job && (
        <div className={`job ${job.status}`}>
          <p>
            {phaseLabel(job.phase)} {job.percent}%
          </p>
          <progress value={job.percent} max={100} />
          {job.status === 'done' && (
            <>
              <p>
                <a className="download" href={job.download_url ?? '#'}>
                  {t('⤓ 下載{p0}', { p0: formatBytes(job.bytes) })}
                </a>{' '}
                <span className="muted">{summarizeJob(job)}</span>
              </p>
              {job.saved_to_library && (
                <p className="ok">{t('已存入資料庫：資料頁該影像底下多了「{structure_set_label}」（匯入集，唯讀）。要用它請重新從資料頁選取。', { structure_set_label: job.structure_set_label })}</p>
              )}
              {job.anonymize_forced_reason && <p className="muted small">{job.anonymize_forced_reason}</p>}
              {job.profile_warnings && job.profile_warnings.length > 0 && (
                <details className="profile-warnings">
                  <summary>
                    {t('{p0} profile 調整了 {length}項', { p0: job.profile === 'varian' ? 'Varian' : t('通用'), length: job.profile_warnings.length })}
                  </summary>
                  <ul className="small">
                    {job.profile_warnings.map((w, i) => (
                      <li key={`${w.structure_id ?? 'h'}-${w.field}-${i}`}>{describeProfileWarning(w)}</li>
                    ))}
                  </ul>
                </details>
              )}
              {job.skipped && job.skipped.length > 0 && (
                <ul className="small">
                  {job.skipped.map((sk) => (
                    <li key={sk.structure_id}>
                      {t('跳過{p0}：{p1}', { p0: nameOf(sk.structure_id), p1: SKIP_REASON[sk.reason] ?? sk.reason })}
                    </li>
                  ))}
                </ul>
              )}
              <SendToNode exportJobId={job.job_id} caseId={caseId ?? null} onDone={() => void loadRecent()} />
            </>
          )}
          {job.status === 'failed' && <p className="error">{job.error}</p>}
        </div>
      )}
      <section className="recent">
        <h4>{t('匯出紀錄（這個病例）')}</h4>
        <ExportRecordList records={recent} onChanged={() => void loadRecent()} />
      </section>
    </div>
  );
}
