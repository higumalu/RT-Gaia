/**
 * 簽核面板 —— `right-sidebar`，`'review'` 模式開著時。
 *
 * 結構依狀態分組、勾選批次「核可／退回／重新開啟」＋備註；每個結構可展開版本鏈（回到某一版）；
 * 底下是這個病例的簽核事件。純邏輯在 `model.ts`；後端 `POST /studies/{studyId}/review`、
 * `GET /cases/{caseId}`、`GET /structures/{id}/versions`、`POST /structures/{id}/revert`。
 */

import { useCallback, useEffect, useState } from 'react';

import type { ViewerPanelProps } from '../../panels/types';
import {
  actionAllowed,
  canReview,
  formatEvent,
  countBySet,
  filterBySet,
  groupByStatus,
  reviewBody,
  statusLabel,
  summarize,
  VERSION_KIND_LABEL,
  type ReviewAction,
  type ReviewEvent,
  type VersionInfo, actionCount } from './model';
import { formatDateTime, t } from '../../../core/i18n';
import { setLabel as displaySetLabel } from '../../components/structureGroups';
import { deviceClass } from '../../device/useFormFactor';

interface CaseDetail {
  review_notes?: ReviewEvent[];
  review_events?: ReviewEvent[];
}

export function ReviewPanel({ api }: ViewerPanelProps): React.JSX.Element {
  const { structures, studyId, caseId, user } = api.state;
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [events, setEvents] = useState<ReviewEvent[]>([]);
  const [openVersions, setOpenVersions] = useState<string | null>(null);
  const [versions, setVersions] = useState<VersionInfo[] | null>(null);
  const [head, setHead] = useState<string | null>(null);
  const reviewer = canReview(user?.role);
  const nameOf = useCallback((id: string): string => structures.find((s) => s.structureId === id)?.name ?? id, [structures]);

  const loadEvents = useCallback(async () => {
    if (!caseId) return;
    try {
      const c = await api.http.getJson<CaseDetail>(`/cases/${encodeURIComponent(caseId)}`);
      setEvents([...(c.review_events ?? c.review_notes ?? [])].reverse());
    } catch {
      /* 抽屜資料不是關鍵路徑 */
    }
  }, [api.http, caseId]);

  useEffect(() => {
    void loadEvents();
  }, [loadEvents, structures]);

  const loadVersions = async (structureId: string): Promise<void> => {
    setOpenVersions(structureId);
    setVersions(null);
    try {
      const v = await api.http.getJson<{ head_version_id: string; versions: VersionInfo[] }>(`/structures/${encodeURIComponent(structureId)}/versions`);
      setVersions([...v.versions].reverse());
      setHead(v.head_version_id);
    } catch (e) {
      api.commands.setError(t('讀取版本失敗：{p0}', { p0: e instanceof Error ? e.message : String(e) }));
    }
  };

  const act = async (action: ReviewAction): Promise<void> => {
    if (!studyId) return;
    const body = reviewBody(action, structures, selected, note);
    if (!body) return;
    setBusy(action);
    try {
      // 簽核事件記下在哪一類裝置上簽的（手機／平板／電腦）
      await api.http.postJson(`/studies/${encodeURIComponent(studyId)}/review`, { ...body, device: deviceClass() });
      await api.commands.refreshStructures();
      setSelected(new Set());
      setNote('');
      await loadEvents();
    } catch (e) {
      api.commands.setError(t('簽核失敗：{p0}', { p0: e instanceof Error ? e.message : String(e) }));
    } finally {
      setBusy(null);
    }
  };

  const revert = async (structureId: string, versionId: string): Promise<void> => {
    setBusy('revert');
    try {
      await api.http.postJson(`/structures/${encodeURIComponent(structureId)}/revert`, { version_id: versionId });
      await api.commands.refreshStructures();
      await loadVersions(structureId);
    } catch (e) {
      api.commands.setError(t('回復失敗：{p0}', { p0: e instanceof Error ? e.message : String(e) }));
    } finally {
      setBusy(null);
    }
  };

  const toggle = (id: string): void =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const selectGroup = (ids: string[], on: boolean): void =>
    setSelected((prev) => {
      const next = new Set(prev);
      for (const id of ids) if (on) next.add(id);
      else next.delete(id);
      return next;
    });

  // 依結構集篩選、每個結構標它的集
  const [setFilter, setSetFilter] = useState<string | null>(null);
  const sets = api.state.structureSets;
  // 預設工作集名稱依介面語言顯示（存的是「physicist 的結構集」）
  const setLabel = (id: string | null | undefined): string | null => {
    const set = id ? sets.find((x) => x.structureSetId === id) : undefined;
    return set ? displaySetLabel(set) : null;
  };
  const bySet = countBySet(structures);
  const groups = groupByStatus(filterBySet(structures, setFilter));
  const canDo = (action: ReviewAction): boolean =>
    reviewer && busy === null && structures.some((s) => selected.has(s.structureId) && actionAllowed(action, s.status));

  return (
    <div className="panel review-panel">
      <h3>{t('簽核')}</h3>
      <p className="muted">{summarize(structures) || t('（沒有結構）')}</p>
      {sets.length >= 2 && (
        <label className="review-set-filter">
          {t('結構集')}
          <select value={setFilter ?? ''} onChange={(e) => setSetFilter(e.target.value === '' ? null : e.target.value)}>
            <option value="">{t('全部（{length}）', { length: structures.length })}</option>
            {sets.map((x) => (
              <option key={x.structureSetId} value={x.structureSetId}>
                {t('{label}{p1}（{p2}）', { label: displaySetLabel(x), p1: x.kind === 'import' ? t('（匯入）') : x.kind === 'transient' ? t('（未儲存）') : '', p2: bySet.get(x.structureSetId) ?? 0 })}
              </option>
            ))}
          </select>
        </label>
      )}
      {api.state.assignedTier === 'C' && (
        <p className="notice" title={t('Tier C（CPU 顯示）允許簽核；簽核事件會記下 Tier，事後可查')}>
          {t('目前以 Tier C（CPU 顯示）檢視；簽核照常可用，事件會記下 Tier C。')}
        </p>
      )}
      {!reviewer && <p className="warning">{t('你的角色是「{p0}」，只能檢視；核可／退回／重新開啟需要審核者。', { p0: user?.role ?? t('未知') })}</p>}
      <div className="review-actions">
        <input value={note} placeholder={t('備註（會記進簽核事件）')} onChange={(e) => setNote(e.target.value)} disabled={!reviewer} />
        <div className="buttons">
          <button type="button" className="ok" disabled={!canDo('approve')} onClick={() => void act('approve')} title={t('只作用在選取中還沒簽核的結構')}>
            {t('核可{p0}', { p0: canDo('approve') ? t(' {p0} 個', { p0: actionCount('approve', structures, selected) }) : '' })}
          </button>
          <button type="button" className="danger" disabled={!canDo('reject')} onClick={() => void act('reject')} title={t('只作用在選取中未簽核、未退回的結構')}>
            {t('退回{p0}', { p0: canDo('reject') ? t(' {p0} 個', { p0: actionCount('reject', structures, selected) }) : '' })}
          </button>
          <button type="button" disabled={!canDo('reopen')} onClick={() => void act('reopen')} title={t('已簽核或退回的結構重新開啟編輯')}>
            {t('重新開啟{p0}', { p0: canDo('reopen') ? t(' {p0} 個', { p0: actionCount('reopen', structures, selected) }) : '' })}
          </button>
        </div>
        <span className="muted small">{t('已選 {size}', { size: selected.size })}</span>
      </div>
      {groups.map((g) => {
        const ids = g.items.map((s) => s.structureId);
        const allOn = ids.every((id) => selected.has(id));
        return (
          <section key={g.status} className={`review-group status-${g.status}`}>
            <h4>
              <label>
                <input type="checkbox" checked={allOn} onChange={(e) => selectGroup(ids, e.target.checked)} />
                {statusLabel(g.status)} <span className="muted">{g.items.length}</span>
              </label>
            </h4>
            <ul>
              {g.items.map((s) => (
                <li key={s.structureId} data-status={s.status}>
                  <label>
                    <input type="checkbox" checked={selected.has(s.structureId)} onChange={() => toggle(s.structureId)} />
                    <span className="swatch" style={{ background: s.colorRgb ? `rgb(${s.colorRgb.join(',')})` : undefined }} />
                    {s.name ?? s.structureId}
                    {setFilter === null && setLabel(s.structureSetId) && (
                      <span className="badge set-chip" title={t('所屬結構集')}>
                        {setLabel(s.structureSetId)}
                      </span>
                    )}
                  </label>
                  <button type="button" className="linkish" onClick={() => (openVersions === s.structureId ? setOpenVersions(null) : void loadVersions(s.structureId))}>
                    {t('版本')}
                  </button>
                  {openVersions === s.structureId && (
                    <ul className="versions">
                      {versions === null && <li className="muted">{t('載入中…')}</li>}
                      {versions?.map((v) => (
                        <li key={v.version_id} data-head={v.version_id === head ? 'true' : undefined}>
                          <span className="kind">{t(VERSION_KIND_LABEL[v.kind] ?? v.kind)}</span> {v.created_by} · {formatDateTime(v.created_at)} · {v.voxel_count} vox
                          {v.note ? <span className="muted"> · {v.note}</span> : null}
                          {v.version_id === head ? (
                            <span className="badge">{t('目前')}</span>
                          ) : (
                            <button
                              type="button"
                              disabled={busy !== null || s.status === 'approved'}
                              title={s.status === 'approved' ? t('已簽核，先重新開啟') : t('以 {version_id} 的內容建立新的一版（歷史不刪）', { version_id: v.version_id })}
                              onClick={() => void revert(s.structureId, v.version_id)}
                            >
                              {t('回到此版')}
                            </button>
                          )}
                        </li>
                      ))}
                    </ul>
                  )}
                </li>
              ))}
            </ul>
          </section>
        );
      })}
      <section className="review-events">
        <h4>{t('簽核事件')}</h4>
        {events.length === 0 ? (
          <p className="muted">{t('（還沒有）')}</p>
        ) : (
          <ul>
            {events.slice(0, 30).map((e) => (
              <li key={e.event_id}>{formatEvent(e, nameOf)}</li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
