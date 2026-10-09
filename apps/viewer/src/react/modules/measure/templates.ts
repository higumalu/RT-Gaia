/**
 * 量測範本：一組依序要量的東西（種類 ＋ 名稱）。按「開始」後面板一步一步帶：
 * 切到該種類的工具、下一個量測自動用那一步的名稱（`setMeasurementLabelHint`），量完換下一步。
 *
 * 內建幾個常見的（不能改，可以複製成自己的）；使用者的範本存 `rtgaia.measure.templates.v1`（跟著帳號）。
 * 純邏輯、零 React。
 */

import type { MeasurementKind } from '../../../core';
import { msg, t } from '../../../core/i18n';

export interface TemplateStep {
  readonly kind: MeasurementKind;
  readonly label: string;
}

export interface MeasureTemplate {
  readonly id: string;
  readonly name: string;
  readonly steps: readonly TemplateStep[];
  /** 內建：名稱與步驟名是原文（顯示時翻），不能改。 */
  readonly builtin?: boolean;
}

export const TEMPLATES_STORAGE_KEY = 'rtgaia.measure.templates.v1';
export const TEMPLATE_KINDS: readonly MeasurementKind[] = ['distance', 'area', 'roi3d', 'point', 'angle', 'cobb', 'curve'];
export const MAX_TEMPLATE_STEPS = 20;
export const MAX_LABEL_LENGTH = 64;

export const BUILTIN_TEMPLATES: readonly MeasureTemplate[] = [
  {
    id: 'builtin:recist',
    name: msg('RECIST 標靶病灶（長徑、短徑）'),
    builtin: true,
    steps: [
      { kind: 'distance', label: msg('長徑') },
      { kind: 'distance', label: msg('短徑') },
    ],
  },
  {
    id: 'builtin:scoliosis',
    name: msg('脊椎側彎（主彎、次彎 Cobb 角）'),
    builtin: true,
    steps: [
      { kind: 'cobb', label: msg('主彎 Cobb 角') },
      { kind: 'cobb', label: msg('次彎 Cobb 角') },
    ],
  },
  {
    id: 'builtin:hu',
    name: msg('HU 取樣（病灶、正常組織）'),
    builtin: true,
    steps: [
      { kind: 'area', label: msg('病灶') },
      { kind: 'area', label: msg('正常組織') },
    ],
  },
];

/** 顯示用名稱（內建的翻、使用者的原樣）。 */
export function templateName(tpl: MeasureTemplate): string {
  return tpl.builtin ? t(tpl.name) : tpl.name;
}

/** 這一步量完的量測叫什麼（內建的依目前語言翻；之後就是使用者資料，不再翻）。 */
export function stepLabel(tpl: MeasureTemplate, index: number): string {
  const step = tpl.steps[index];
  if (step === undefined) return '';
  return tpl.builtin ? t(step.label) : step.label;
}

/** 使用者範本的問題（空名稱、沒有步驟、步驟名空白或太長、不認識的種類）；空陣列 ＝ 可存。 */
export function templateProblems(tpl: Pick<MeasureTemplate, 'name' | 'steps'>): string[] {
  const out: string[] = [];
  if (tpl.name.trim() === '') out.push(t('範本要有名稱'));
  if (tpl.steps.length === 0) out.push(t('範本至少要一步'));
  if (tpl.steps.length > MAX_TEMPLATE_STEPS) out.push(t('範本最多 {n} 步', { n: MAX_TEMPLATE_STEPS }));
  tpl.steps.forEach((s, i) => {
    if (!TEMPLATE_KINDS.includes(s.kind)) out.push(t('第 {n} 步的種類不對', { n: i + 1 }));
    if (s.label.trim() === '') out.push(t('第 {n} 步要有名稱', { n: i + 1 }));
    else if (s.label.trim().length > MAX_LABEL_LENGTH) out.push(t('第 {n} 步的名稱太長（最多 {max} 字）', { n: i + 1, max: MAX_LABEL_LENGTH }));
  });
  return out;
}

/** 存起來的使用者範本：壞掉的字串、形狀不對或有問題的範本丟掉，不拋。 */
export function parseTemplates(text: string | null | undefined): MeasureTemplate[] {
  if (!text) return [];
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return [];
  }
  if (!Array.isArray(raw)) return [];
  const out: MeasureTemplate[] = [];
  const ids = new Set<string>();
  for (const item of raw) {
    const r = item as Record<string, unknown> | null;
    if (typeof r?.['id'] !== 'string' || typeof r['name'] !== 'string' || !Array.isArray(r['steps']) || ids.has(r['id']) || r['id'].startsWith('builtin:')) continue;
    const steps = (r['steps'] as unknown[]).map((s) => s as Record<string, unknown> | null);
    if (!steps.every((s) => typeof s?.['kind'] === 'string' && typeof s['label'] === 'string')) continue;
    const tpl: MeasureTemplate = { id: r['id'], name: r['name'], steps: steps.map((s) => ({ kind: s!['kind'] as MeasurementKind, label: s!['label'] as string })) };
    if (templateProblems(tpl).length > 0) continue;
    ids.add(tpl.id);
    out.push(tpl);
  }
  return out;
}

export function serializeTemplates(templates: readonly MeasureTemplate[]): string {
  return JSON.stringify(templates.filter((x) => !x.builtin).map(({ id, name, steps }) => ({ id, name, steps })));
}

/** 新增或取代（同 id）；名稱與步驟名去掉頭尾空白。 */
export function upsertTemplate(templates: readonly MeasureTemplate[], tpl: MeasureTemplate): MeasureTemplate[] {
  const clean: MeasureTemplate = { id: tpl.id, name: tpl.name.trim(), steps: tpl.steps.map((s) => ({ kind: s.kind, label: s.label.trim() })) };
  const i = templates.findIndex((x) => x.id === tpl.id);
  return i < 0 ? [...templates, clean] : templates.map((x, j) => (j === i ? clean : x));
}

/** 複製一個範本成使用者的（內建的名稱與步驟名用目前語言展開）。 */
export function copyTemplate(tpl: MeasureTemplate, newId: string): MeasureTemplate {
  return { id: newId, name: t('{name}（複本）', { name: templateName(tpl) }), steps: tpl.steps.map((_, i) => ({ kind: tpl.steps[i]!.kind, label: stepLabel(tpl, i) })) };
}

export function newTemplateId(random: () => number = Math.random): string {
  return `tpl_${Date.now().toString(36)}${Math.floor(random() * 1e6).toString(36)}`;
}

/** 範本進行中的狀態（放在模組狀態袋）。 */
export interface TemplateRun {
  readonly templateId: string;
  readonly step: number;
}

/** 量完一步 → 下一步；最後一步量完 → `null`（完成）。 */
export function nextRun(run: TemplateRun, tpl: MeasureTemplate): TemplateRun | null {
  return run.step + 1 < tpl.steps.length ? { templateId: run.templateId, step: run.step + 1 } : null;
}
