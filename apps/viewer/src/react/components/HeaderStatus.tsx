/**
 * 頂列固定資訊：病例摘要、編輯對象、保存狀態。純邏輯在 `headerModel.ts`。
 * 唯讀對象旁直接給「合併到我的」入口（不可編輯要有具體原因與可執行入口）。
 */

import { useState } from 'react';

import type { ViewerApi } from '../../core/panels/api';
import { collabApi } from '../collab/collabApi';
import { caseSummaryOf, editTargetOf, onlineOthers, saveStatusOf } from './headerModel';
import { t } from '../../core/i18n';
import { onlineDetails } from '../collab/model';

export function CaseSummaryBadge({ api }: { api: ViewerApi }): React.JSX.Element | null {
  const summary = caseSummaryOf(api.state.layers, api.state.frameGroups);
  if (summary === null) return null;
  const others = onlineOthers(api.state.presence, api.state.user?.username);
  return (
    <span className="case-summary" title={t('病人 {patientId} · {studyDate} · 主要影像 {primaryLabel}{p3}', { patientId: summary.patientId, studyDate: summary.studyDate, primaryLabel: summary.primaryLabel, p3: summary.secondaryCount ? t(' · 另 {secondaryCount} 組影像', { secondaryCount: summary.secondaryCount }) : '' })}>
      <span className="pid">{summary.patientId}</span>
      {summary.studyDate && <span className="muted">{summary.studyDate}</span>}
      <span className="muted">{summary.primaryLabel}</span>
      {summary.secondaryCount > 0 && <span className="muted">{t('＋{secondaryCount} 組影像', { secondaryCount: summary.secondaryCount })}</span>}
      {others > 0 && (
        // 滑鼠提示列出每個人在做什麼（檢視／編輯哪個結構）
        <span className="online" title={[t('其他在線的人'), ...onlineDetails(api.state.presence, api.state.user?.username, (id) => api.state.structures.find((x) => x.structureId === id)?.name ?? null)].join('\n')}>
          {t('● {others} 人在線', { others })}
        </span>
      )}
    </span>
  );
}

export function EditTargetBadge({ api }: { api: ViewerApi }): React.JSX.Element {
  const target = editTargetOf(api.state.structures, api.state.structureSets, api.state.activeStructureId, api.state.user?.username);
  const [busy, setBusy] = useState(false);
  const merge = async (): Promise<void> => {
    const id = api.state.activeStructureId;
    const caseId = api.state.caseId;
    if (!id || !caseId) return;
    setBusy(true);
    try {
      const out = await collabApi.merge(caseId, [id], { [id]: 'rename' });
      await api.commands.refreshStructures();
      await api.commands.refreshStructureSets();
      const mine = out.merged[0]?.structure_id;
      if (mine) api.commands.setActiveStructure(mine);
    } catch (e) {
      api.commands.setError(t('合併失敗：{p0}', { p0: e instanceof Error ? e.message : String(e) }));
    } finally {
      setBusy(false);
    }
  };
  return (
    <span className="edit-target" data-kind={target.kind} title={target.reason ?? (target.kind === 'editable' ? t('筆刷、圈選、後處理都作用在這個結構') : t('在左側資料面板點一個結構名稱'))}>
      {target.text}
      {target.mergeable && (
        <button type="button" className="linkish" disabled={busy} onClick={() => void merge()} title={t('複製一份到我的結構集並切換過去')}>
          {t('合併到我的')}
        </button>
      )}
    </span>
  );
}

export function SaveStatusBadge({ api, lastSavedAt }: { api: ViewerApi; lastSavedAt: number | null }): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const status = saveStatusOf({
    loading: !api.state.kernelReady || api.state.layers.length === 0,
    editsFlushed: api.state.editsFlushed,
    failures: api.state.submitFailures,
    lastSavedAt,
  });
  return (
    <span className="save-status" data-kind={status.kind}>
      <button type="button" className="linkish" onClick={() => setOpen((v) => !v)} aria-expanded={open} title={status.detail}>
        {status.kind === 'failed' ? '⚠ ' : status.kind === 'saved' ? '✓ ' : ''}
        {status.text}
      </button>
      {open && (
        <span className="save-status-detail" role="status">
          {status.detail}
        </span>
      )}
    </span>
  );
}
