/**
 * ROI 編輯模組的**純邏輯**：`GET /ops` 的 JSON schema → 表單欄位、預設參數、
 * 區域生長／閾值的預設集、TG-263 建議的文字。零 React。
 */

import type { OpDescriptor } from '../../../core';
import { msg, t } from '../../../core/i18n';

/** 後端 `x-ui-widget` 的封閉清單（`ops.py` 的詞彙表）。 */
export type UiWidget = 'number' | 'integer' | 'boolean' | 'enum' | 'structure-picker' | 'slice-range' | 'hu-range' | 'seed' | 'bbox';

export interface OpField {
  readonly name: string;
  readonly title: string;
  readonly widget: UiWidget;
  readonly required: boolean;
  readonly default: unknown;
  readonly enumValues?: readonly unknown[];
  readonly unit?: string;
}

/** schema → 欄位清單（不認識的 widget 退回 `number`／`enum`／`boolean` 的合理推斷）。 */
export function fieldsOf(op: OpDescriptor): OpField[] {
  const schema = op.paramsSchema;
  const props = (schema['properties'] as Record<string, Record<string, unknown>> | undefined) ?? {};
  const required = new Set((schema['required'] as string[] | undefined) ?? []);
  return Object.entries(props).map(([name, p]) => {
    const declared = p['x-ui-widget'] as UiWidget | undefined;
    const widget: UiWidget =
      declared ?? (p['enum'] ? 'enum' : p['type'] === 'boolean' ? 'boolean' : p['type'] === 'integer' ? 'integer' : 'number');
    const unit = name.endsWith('_mm') ? 'mm' : name.endsWith('_cc') ? 'cc' : undefined;
    return {
      name,
      title: typeof p['title'] === 'string' ? p['title'] : name,
      widget,
      required: required.has(name),
      default: p['default'],
      ...(p['enum'] ? { enumValues: p['enum'] as unknown[] } : {}),
      ...(unit ? { unit } : {}),
    };
  });
}

/** 每個欄位的預設值（schema 的 default；沒有就照 widget 給一個合理值）。 */
export function defaultParams(op: OpDescriptor): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const f of fieldsOf(op)) {
    if (f.default !== undefined) out[f.name] = f.default;
    else if (f.widget === 'boolean') out[f.name] = false;
    else if (f.widget === 'hu-range') out[f.name] = [-200, 300];
    else if (f.widget === 'enum' && f.enumValues?.length) out[f.name] = f.enumValues[0];
  }
  return out;
}

/** 送出前檢查必填欄位；回缺的欄位名。 */
export function missingRequired(op: OpDescriptor, params: Record<string, unknown>): string[] {
  return fieldsOf(op)
    .filter((f) => f.required && (params[f.name] === undefined || params[f.name] === null || params[f.name] === ''))
    .map((f) => f.title);
}

export interface HuPreset {
  readonly id: string;
  readonly label: string;
  readonly range: [number, number];
}

/** 閾值／區域生長的 HU 預設集。 */
export const HU_PRESETS: readonly HuPreset[] = [
  { id: 'soft', label: msg('軟組織'), range: [-200, 300] },
  { id: 'bone', label: msg('骨'), range: [200, 3000] },
  { id: 'lung', label: msg('肺／空氣'), range: [-1000, -400] },
  { id: 'fat', label: msg('脂肪'), range: [-200, -50] },
  { id: 'body', label: msg('體表（非空氣）'), range: [-500, 3000] },
];

/** 常用顏色（新建結構的預設輪替）。 */
export const STRUCTURE_COLORS: readonly [number, number, number][] = [
  [255, 0, 0], [0, 200, 0], [0, 128, 255], [255, 200, 0], [255, 0, 255], [0, 220, 220], [255, 128, 0], [160, 96, 255],
];

export function nextColor(used: readonly (readonly [number, number, number])[]): [number, number, number] {
  const key = (c: readonly [number, number, number]) => c.join(',');
  const usedKeys = new Set(used.map(key));
  return STRUCTURE_COLORS.find((c) => !usedKeys.has(key(c))) ?? STRUCTURE_COLORS[used.length % STRUCTURE_COLORS.length]!;
}

export function rgbHex(c: readonly [number, number, number]): string {
  return `#${c.map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('')}`;
}

export function hexRgb(hex: string): [number, number, number] {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
  return m ? [parseInt(m[1]!, 16), parseInt(m[2]!, 16), parseInt(m[3]!, 16)] : [255, 0, 0];
}

/**
 * 後端 TG-263 建議裡可以直接拿來改名的那一個名稱（例 `SpinalCord`）；樣板（`PTV_<dose>`）或多選一（`Lung_L / Lung_R`）回 null。
 * 不要從翻譯後的句子裡抓 —— 英文介面的句子沒有「建議：」，按鈕會永遠不出現。
 */
export function tg263Adoptable(s: Record<string, unknown> | null): string | null {
  const suggestion = s && typeof s['suggestion'] === 'string' ? s['suggestion'] : null;
  return suggestion && /^[A-Za-z][A-Za-z0-9_]*$/.test(suggestion) ? suggestion : null;
}

/** 後端 TG-263 建議 → 一句話（沒有就空字串）。 */
export function tg263Text(s: Record<string, unknown> | null): string {
  if (!s) return '';
  const matched = typeof s['matched'] === 'string' ? s['matched'] : null;
  const suggestion = typeof s['suggestion'] === 'string' ? s['suggestion'] : null;
  if (!matched && !suggestion) return '';
  return suggestion ? t('TG-263 建議：{suggestion}{p1}', { suggestion, p1: matched ? t('（比對到 {matched}）', { matched }) : '' }) : t('TG-263：比對到 {matched}', { matched });
}
