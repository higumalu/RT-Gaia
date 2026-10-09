/**
 * 4D 的結構 —— 時間軸列「相位結構…」。
 *
 * * 合成一個時間結構：自動找「同一個結構在不同相位」（`GTV_c00`…`GTV_c90`、`GTV_00`／`GTV_50`；名字去掉相位尾巴後相同、幀不重疊），
 *   一組一列、可改名後合成；也可以自己勾。結果進我的工作集，來源不動（匯入的本來就唯讀）。
 * * ITV：勾幾個結構、勾要哪幾幀（預設全部）→ 聯集成一個靜態結構（每一幀都顯示）。
 * 複製到其他相位在 ROI 編輯面板（對作用中的結構）。
 */

import { useMemo, useState } from 'react';

import type { TemporalState } from '../../../core';
import { joinList, t } from '../../../core/i18n';
import { Dialog } from '../../components/Dialog';
import type { ViewerPanelProps } from '../../panels/types';
import { backendMessage, frameName, mergedFrames, phaseStructureGroups, phaseStructures, type PhaseStructure } from './model';

function framesText(labels: readonly string[] | null, frames: readonly number[]): string {
  if (frames.length > 4) return t('{n} 幀', { n: frames.length });
  return joinList(frames.map((f) => frameName(labels, f)));
}

export function PhaseStructuresDialog({ api, g, onClose }: ViewerPanelProps & { g: TemporalState; onClose: () => void }): React.JSX.Element {
  const items = useMemo(() => phaseStructures(api.state.layers, g.temporalGroupId), [api.state.layers, g.temporalGroupId]);
  const count = g.frameCount ?? 1;
  const groups = useMemo(() => phaseStructureGroups(items, g.frameLabels, count), [items, g.frameLabels, count]);
  const [names, setNames] = useState<Record<string, string>>({});
  const [picked, setPicked] = useState<ReadonlySet<string>>(new Set());
  const [pickedName, setPickedName] = useState('');
  const [itvPicked, setItvPicked] = useState<ReadonlySet<string>>(new Set());
  const [itvFrames, setItvFrames] = useState<ReadonlySet<number>>(() => new Set(Array.from({ length: count }, (_, k) => k)));
  const [itvName, setItvName] = useState('ITV');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  const run = (label: string, fn: () => Promise<string>): void => {
    setBusy(true);
    setError(null);
    setDone(null);
    fn()
      .then((id) => {
        setDone(label);
        api.commands.setActiveStructure(id);
      })
      .catch((e: unknown) => setError(backendMessage(e)))
      .finally(() => setBusy(false));
  };
  const merge = (members: readonly PhaseStructure[], name: string): void =>
    run(t('已合成「{name}」', { name }), async () => (await api.commands.mergeFrameStructures(members.map((m) => m.structureId), name)).structureId);
  const toggle = <T,>(set: ReadonlySet<T>, v: T): Set<T> => {
    const next = new Set(set);
    if (next.has(v)) next.delete(v);
    else next.add(v);
    return next;
  };
  const pickedItems = items.filter((i) => picked.has(i.structureId));
  const pickedFrames = mergedFrames(pickedItems);

  return (
    <Dialog label={t('相位結構')} className="phase-structures-dialog" busy={busy} onClose={onClose}>
      <h3>{t('相位結構')}</h3>
      {items.length === 0 ? (
        <p className="muted">{t('這條時間軸上沒有只屬某幾幀的結構。在某一相位上畫的結構會只屬那一幀；靜態結構（每一幀都顯示）不在這裡。')}</p>
      ) : (
        <>
          <section className="phase-structures-merge">
            <h4>{t('合成一個時間結構')}</h4>
            <p className="muted small">{t('同一個結構在不同相位各一個（例：GTV_c00…GTV_c90）→ 合成一個，切相位時跟著換。結果進我的結構集，原本的不動。')}</p>
            {groups.length === 0 ? (
              <p className="muted small">{t('沒有自動找到（名字去掉相位尾巴後相同、幀不重疊的）；可以在下面自己勾。')}</p>
            ) : (
              <ul className="phase-groups">
                {groups.map((grp) => {
                  const name = names[grp.stem] ?? grp.stem;
                  return (
                    <li key={grp.stem} data-stem={grp.stem}>
                      <input className="phase-group-name" value={name} aria-label={t('合成後的名稱')} onChange={(e) => setNames({ ...names, [grp.stem]: e.target.value })} />
                      <span className="muted small" title={joinList(grp.members.map((m) => m.name))}>
                        {t('← {names}（{frames}）', {
                          names: joinList(grp.members.map((m) => m.name).slice(0, 3)) + (grp.members.length > 3 ? '…' : ''),
                          frames: framesText(g.frameLabels, mergedFrames(grp.members) ?? []),
                        })}
                      </span>
                      <button type="button" disabled={busy || !name.trim()} onClick={() => merge(grp.members, name.trim())}>
                        {t('合成')}
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
            <details className="phase-pick">
              <summary>{t('自己選')}</summary>
              <ul className="phase-pick-list">
                {items.map((it) => (
                  <li key={it.structureId}>
                    <label>
                      <input type="checkbox" checked={picked.has(it.structureId)} onChange={() => setPicked(toggle(picked, it.structureId))} />
                      {it.name} <span className="muted small">{t('（{p0}）', { p0: framesText(g.frameLabels, it.frames) })}</span>
                    </label>
                  </li>
                ))}
              </ul>
              <input className="phase-group-name" placeholder={t('合成後的名稱')} value={pickedName} onChange={(e) => setPickedName(e.target.value)} />
              {pickedItems.length >= 2 && pickedFrames === null && <span className="warning small">{t('勾的結構有重疊的幀')}</span>}
              <button type="button" disabled={busy || pickedItems.length < 2 || pickedFrames === null || !pickedName.trim()} onClick={() => merge(pickedItems, pickedName.trim())}>
                {t('合成（{n} 個）', { n: pickedItems.length })}
              </button>
            </details>
          </section>
          <section className="phase-structures-itv">
            <h4>{t('ITV（各幀聯集）')}</h4>
            <ul className="phase-pick-list">
              {items.map((it) => (
                <li key={it.structureId}>
                  <label>
                    <input type="checkbox" checked={itvPicked.has(it.structureId)} onChange={() => setItvPicked(toggle(itvPicked, it.structureId))} />
                    {it.name} <span className="muted small">{t('（{p0}）', { p0: framesText(g.frameLabels, it.frames) })}</span>
                  </label>
                </li>
              ))}
            </ul>
            <div className="phase-frames" role="group" aria-label={t('用哪幾幀')}>
              {Array.from({ length: count }, (_, k) => (
                <label key={k}>
                  <input type="checkbox" checked={itvFrames.has(k)} onChange={() => setItvFrames(toggle(itvFrames, k))} />
                  {frameName(g.frameLabels, k)}
                </label>
              ))}
            </div>
            <input className="phase-group-name" value={itvName} aria-label={t('ITV 的名稱')} onChange={(e) => setItvName(e.target.value)} />
            <button
              type="button"
              disabled={busy || itvPicked.size === 0 || itvFrames.size === 0 || !itvName.trim()}
              onClick={() =>
                run(t('已建立「{name}」', { name: itvName.trim() }), async () => {
                  const all = itvFrames.size === count;
                  const out = await api.commands.createItv({ structureIds: [...itvPicked], frames: all ? null : [...itvFrames].sort((a, b) => a - b), name: itvName.trim() });
                  return out.structureId;
                })
              }
            >
              {t('建立 ITV')}
            </button>
          </section>
        </>
      )}
      {error && <p className="error">{error}</p>}
      {done && <p className="ok">{done}</p>}
      <div className="dialog-actions">
        <button type="button" onClick={onClose} disabled={busy}>
          {t('關閉')}
        </button>
      </div>
    </Dialog>
  );
}
