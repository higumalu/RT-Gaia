/**
 * 「合併到我的結構集」對話框：從某一套（匯入集或別人的工作集）挑結構 → 合併；
 * 後端回 409 NAME_CONFLICT → 逐一選 跳過／覆蓋為新版本／改名 → 再送。完成後重抓結構與結構集。
 */

import { useEffect, useMemo, useState } from 'react';

import type { StructureMeta, StructureSetInfo, ViewerApi } from '../../core/panels/api';
import { Dialog } from '../components/Dialog';
import { setTitle } from '../components/structureGroups';
import { collabApi, MergeConflictError, type ConflictAction, type MergeConflict, type MergeResult } from './collabApi';
import { defaultResolutions, mergeCandidates, replaceAllowed, summarizeMerge } from './model';
import { t } from '../../core/i18n';

export function MergeDialog(props: {
  api: ViewerApi;
  sourceSet: StructureSetInfo;
  /** 預先勾選的結構（例如從單一列按「→ 我的」）。 */
  preselected?: readonly string[];
  onClose: () => void;
  onMerged?: (result: MergeResult) => void;
}): React.JSX.Element {
  const { api, sourceSet } = props;
  const candidates = useMemo(() => mergeCandidates(api.state.structures, sourceSet.structureSetId), [api.state.structures, sourceSet.structureSetId]);
  const [picked, setPicked] = useState<Set<string>>(() => new Set(props.preselected ?? candidates.map((s) => s.structureId)));
  const [conflicts, setConflicts] = useState<readonly MergeConflict[] | null>(null);
  const [resolutions, setResolutions] = useState<Record<string, ConflictAction>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<MergeResult | null>(null);
  const caseId = api.state.caseId;

  useEffect(() => {
    // 來源結構清單刷新（別人剛合併／新建）→ 移除已不存在的勾選
    setPicked((prev) => new Set([...prev].filter((id) => candidates.some((c) => c.structureId === id))));
  }, [candidates]);

  const toggle = (id: string): void =>
    setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const run = async (): Promise<void> => {
    if (!caseId || picked.size === 0) return;
    setBusy(true);
    setError(null);
    try {
      const result = await collabApi.merge(caseId, [...picked], resolutions);
      setDone(result);
      setConflicts(null);
      await api.commands.refreshStructures();
      await api.commands.refreshStructureSets();
      props.onMerged?.(result);
    } catch (e) {
      if (e instanceof MergeConflictError) {
        setConflicts(e.conflicts);
        setResolutions((prev) => ({ ...defaultResolutions(e.conflicts), ...prev }));
      } else {
        setError(e instanceof Error ? e.message : String(e));
      }
    } finally {
      setBusy(false);
    }
  };

  const nameOf = (id: string): string => api.state.structures.find((s) => s.structureId === id)?.name ?? id;
  const isConflict = (id: string): MergeConflict | undefined => conflicts?.find((c) => c.structure_id === id);

  return (
    <Dialog label={t('合併到我的結構集')} className="merge-dialog" busy={busy} onClose={props.onClose}>
        <header>
          <h3>{t('合併到我的結構集')}</h3>
          <button type="button" onClick={props.onClose} aria-label={t('關閉')} disabled={busy}>
            ×
          </button>
        </header>
        <p className="muted">
          {t('從「{p0}」複製到我的工作集；來源不會被改動，複本的版本鏈會記下來自哪一版。', { p0: setTitle(sourceSet) })}
        </p>
        {done ? (
          <>
            <p className="ok">{t('已合併：{p0}', { p0: summarizeMerge(done.merged) })}</p>
            <div className="buttons">
              <button type="button" className="primary" onClick={props.onClose}>
                {t('關閉')}
              </button>
            </div>
          </>
        ) : (
          <>
            <div className="buttons small">
              <button type="button" onClick={() => setPicked(new Set(candidates.map((s) => s.structureId)))}>
                {t('全選')}
              </button>
              <button type="button" onClick={() => setPicked(new Set())}>
                {t('清空')}
              </button>
              <span className="muted">
                {picked.size} / {candidates.length}
              </span>
            </div>
            <ul className="merge-list">
              {candidates.map((s: StructureMeta) => {
                const c = isConflict(s.structureId);
                return (
                  <li key={s.structureId} data-conflict={c ? 'true' : undefined}>
                    <label>
                      <input type="checkbox" checked={picked.has(s.structureId)} onChange={() => toggle(s.structureId)} disabled={busy} />
                      <span className="swatch" style={{ background: s.colorRgb ? `rgb(${s.colorRgb.join(',')})` : undefined }} />
                      {s.name ?? s.structureId}
                    </label>
                    {c && picked.has(s.structureId) && (
                      <span className="conflict">
                        {t('我的集已有「{p0}」：', { p0: nameOf(c.existing_structure_id) })}
                        {(['replace', 'rename', 'skip'] as ConflictAction[]).map((a) => (
                          <label key={a} title={a === 'replace' && !replaceAllowed(c) ? t('已簽核，不能覆蓋') : undefined}>
                            <input
                              type="radio"
                              name={`res-${s.structureId}`}
                              checked={(resolutions[s.structureId] ?? defaultResolutions([c])[s.structureId]) === a}
                              disabled={a === 'replace' && !replaceAllowed(c)}
                              onChange={() => setResolutions((r) => ({ ...r, [s.structureId]: a }))}
                            />
                            {a === 'replace' ? t('覆蓋為新版本') : a === 'rename' ? t('改名 {name}_2', { name: c.name }) : t('跳過')}
                          </label>
                        ))}
                      </span>
                    )}
                  </li>
                );
              })}
              {candidates.length === 0 && <li className="muted">{t('這一套沒有結構。')}</li>}
            </ul>
            {conflicts && <p className="warning">{t('有 {length} 個同名結構，請逐一決定後再按「合併」。', { length: conflicts.filter((c) => picked.has(c.structure_id)).length })}</p>}
            {error && <p className="error">{error}</p>}
            <div className="buttons">
              <button type="button" onClick={props.onClose} disabled={busy} data-autofocus>
                {t('取消')}
              </button>
              <button type="button" className="primary" disabled={busy || picked.size === 0 || !caseId} onClick={() => void run()}>
                {busy ? t('合併中…') : t('合併 {size} 個', { size: picked.size })}
              </button>
            </div>
          </>
        )}
    </Dialog>
  );
}
