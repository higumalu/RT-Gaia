/**
 * 量測範本的面板區塊：選範本 → 開始 → 一步一步量（切工具、自動命名）；可以略過、停止；
 * 「管理範本」新增、複製、改、刪使用者的範本。純邏輯在 `templates.ts`。
 */

import { useEffect, useRef, useState } from 'react';

import { KIND_LABEL, measureToolFor, type MeasurementKind } from '../../../core';
import { t } from '../../../core/i18n';
import type { ViewerPanelProps } from '../../panels/types';
import { savePref } from '../../prefs/prefs';
import { MEASURE_MODULE_ID } from './mode';
import {
  BUILTIN_TEMPLATES,
  copyTemplate,
  newTemplateId,
  nextRun,
  parseTemplates,
  serializeTemplates,
  stepLabel,
  TEMPLATE_KINDS,
  templateName,
  templateProblems,
  TEMPLATES_STORAGE_KEY,
  upsertTemplate,
  type MeasureTemplate,
  type TemplateRun,
} from './templates';

function readUserTemplates(): MeasureTemplate[] {
  try {
    return parseTemplates(localStorage.getItem(TEMPLATES_STORAGE_KEY));
  } catch {
    return [];
  }
}

export function MeasureTemplates({ api }: ViewerPanelProps): React.JSX.Element {
  const [userTemplates, setUserTemplates] = useState<MeasureTemplate[]>(readUserTemplates);
  const all = [...BUILTIN_TEMPLATES, ...userTemplates];
  const moduleState = api.state.modules[MEASURE_MODULE_ID] as { templateRun?: TemplateRun | null; templatePick?: string; templateDone?: string | null } | undefined;
  const run = moduleState?.templateRun ?? null;
  const pick = moduleState?.templatePick ?? all[0]!.id;
  const picked = all.find((x) => x.id === pick) ?? all[0]!;
  const running = run === null ? null : (all.find((x) => x.id === run.templateId) ?? null);
  const [managing, setManaging] = useState(false);
  const [editing, setEditing] = useState<MeasureTemplate | null>(null);
  const hint = api.state.measurementLabelHint;

  const saveTemplates = (next: MeasureTemplate[]): void => {
    setUserTemplates(next);
    savePref(TEMPLATES_STORAGE_KEY, serializeTemplates(next));
  };

  const arm = (tpl: MeasureTemplate, step: number): void => {
    const s = tpl.steps[step]!;
    api.commands.setModuleState(MEASURE_MODULE_ID, { templateRun: { templateId: tpl.id, step }, templateDone: null });
    api.commands.setMeasurementLabelHint({ kind: s.kind, label: stepLabel(tpl, step) });
    api.commands.setActiveTool(measureToolFor(s.kind));
  };
  const stop = (done: string | null): void => {
    api.commands.setModuleState(MEASURE_MODULE_ID, { templateRun: null, templateDone: done });
    api.commands.setMeasurementLabelHint(null);
  };
  const advance = (tpl: MeasureTemplate, current: TemplateRun): void => {
    const next = nextRun(current, tpl);
    if (next === null) stop(templateName(tpl));
    else arm(tpl, next.step);
  };

  // 這一步的名稱提示「出現過又消失」＝ 量完了（host 在第一次 commit 時清掉）。只看消失會誤判：
  // 按下開始的那一刻模組狀態先更新、host 的提示還沒到。
  const seen = useRef<string | null>(null);
  const key = run === null ? null : `${run.templateId}:${run.step}`;
  useEffect(() => {
    if (run === null || running === null) {
      seen.current = null;
      return;
    }
    if (hint !== null && hint.label === stepLabel(running, run.step)) seen.current = key;
    else if (hint === null && seen.current === key) {
      seen.current = null;
      advance(running, run);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 只跟著提示與步驟走
  }, [hint, key]);

  return (
    <div className="measure-templates">
      {running !== null && run !== null ? (
        <div className="slab-row measure-template-run" data-template-step={run.step}>
          <span>
            {t('範本「{name}」第 {n}／{total} 步：', { name: templateName(running), n: run.step + 1, total: running.steps.length })}
            <strong>{stepLabel(running, run.step)}</strong>
            <span className="muted">{t('（{kind}）', { kind: t(KIND_LABEL[running.steps[run.step]!.kind]) })}</span>
            <span className="muted hint"> {t('在影像上畫')}</span>
          </span>
          <span className="slab-header-actions">
            <button type="button" className="reset" title={t('這一步不量，跳到下一步')} onClick={() => advance(running, run)}>
              {t('略過')}
            </button>
            <button type="button" className="reset" onClick={() => stop(null)}>
              {t('停止')}
            </button>
          </span>
        </div>
      ) : (
        <div className="slab-row">
          <label>
            {t('範本')}{' '}
            <select value={picked.id} onChange={(e) => api.commands.setModuleState(MEASURE_MODULE_ID, { templatePick: e.target.value })}>
              {all.map((x) => (
                <option key={x.id} value={x.id}>
                  {templateName(x)}
                </option>
              ))}
            </select>
          </label>
          <button type="button" className="reset" title={t('依序量這個範本的每一步：自動切工具、自動命名')} onClick={() => arm(picked, 0)}>
            {t('開始')}
          </button>
          <button type="button" className="reset" aria-expanded={managing} onClick={() => setManaging((v) => !v)}>
            {t('管理範本')}
          </button>
          {moduleState?.templateDone ? <span className="muted hint">{t('✓ 範本「{name}」量完了', { name: moduleState.templateDone })}</span> : null}
        </div>
      )}
      {managing && running === null && (
        <div className="measure-template-manage">
          {editing === null ? (
            <>
              <ul className="measure-template-list">
                {all.map((x) => (
                  <li key={x.id}>
                    <span>
                      {templateName(x)} <span className="muted">· {t('{n} 步', { n: x.steps.length })}</span>
                    </span>
                    <span className="slab-header-actions">
                      {!x.builtin && (
                        <button type="button" className="reset" onClick={() => setEditing(x)}>
                          {t('編輯')}
                        </button>
                      )}
                      <button type="button" className="reset" title={t('複製成自己的範本再改')} onClick={() => setEditing(copyTemplate(x, newTemplateId()))}>
                        {t('複製')}
                      </button>
                      {!x.builtin && (
                        <button type="button" className="reset" onClick={() => saveTemplates(userTemplates.filter((u) => u.id !== x.id))}>
                          {t('刪除')}
                        </button>
                      )}
                    </span>
                  </li>
                ))}
              </ul>
              <button type="button" className="reset" onClick={() => setEditing({ id: newTemplateId(), name: '', steps: [{ kind: 'distance', label: '' }] })}>
                {t('＋ 新範本')}
              </button>
            </>
          ) : (
            <TemplateEditor
              template={editing}
              onCancel={() => setEditing(null)}
              onSave={(tpl) => {
                saveTemplates(upsertTemplate(userTemplates, tpl));
                api.commands.setModuleState(MEASURE_MODULE_ID, { templatePick: tpl.id });
                setEditing(null);
              }}
            />
          )}
        </div>
      )}
    </div>
  );
}

function TemplateEditor({ template, onSave, onCancel }: { template: MeasureTemplate; onSave: (tpl: MeasureTemplate) => void; onCancel: () => void }): React.JSX.Element {
  const [draft, setDraft] = useState<MeasureTemplate>(template);
  const problems = templateProblems(draft);
  const setStep = (i: number, patch: Partial<{ kind: MeasurementKind; label: string }>): void =>
    setDraft({ ...draft, steps: draft.steps.map((s, j) => (j === i ? { ...s, ...patch } : s)) });
  return (
    <div className="measure-template-editor">
      <label className="slab-row">
        {t('名稱')} <input value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
      </label>
      <ol>
        {draft.steps.map((s, i) => (
          <li key={i} className="slab-row">
            <select value={s.kind} aria-label={t('第 {n} 步的種類', { n: i + 1 })} onChange={(e) => setStep(i, { kind: e.target.value as MeasurementKind })}>
              {TEMPLATE_KINDS.map((k) => (
                <option key={k} value={k}>
                  {t(KIND_LABEL[k])}
                </option>
              ))}
            </select>
            <input value={s.label} placeholder={t('量測名稱')} aria-label={t('第 {n} 步的名稱', { n: i + 1 })} onChange={(e) => setStep(i, { label: e.target.value })} />
            <button type="button" className="reset" disabled={draft.steps.length <= 1} title={t('刪掉這一步')} onClick={() => setDraft({ ...draft, steps: draft.steps.filter((_, j) => j !== i) })}>
              ✕
            </button>
          </li>
        ))}
      </ol>
      <div className="slab-row">
        <button type="button" className="reset" onClick={() => setDraft({ ...draft, steps: [...draft.steps, { kind: draft.steps[draft.steps.length - 1]?.kind ?? 'distance', label: '' }] })}>
          {t('＋ 加一步')}
        </button>
        <span className="slab-header-actions">
          <button type="button" className="reset" disabled={problems.length > 0} title={problems.join('\n')} onClick={() => onSave(draft)}>
            {t('儲存')}
          </button>
          <button type="button" className="reset" onClick={onCancel}>
            {t('取消')}
          </button>
        </span>
      </div>
      {problems.length > 0 && <p className="muted hint">{problems[0]}</p>}
    </div>
  );
}
