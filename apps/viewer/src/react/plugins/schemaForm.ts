/** 宣告式面板（沒有 UI bundle 的 plugin）：從 `params_schema` 生表單的純邏輯。 */

export type FieldType = 'string' | 'number' | 'integer' | 'boolean' | 'enum' | 'string[]';

export interface Field {
  readonly name: string;
  readonly title: string;
  readonly description: string;
  readonly type: FieldType;
  readonly enum?: readonly string[];
  readonly itemEnum?: readonly string[];
  readonly default?: unknown;
  readonly required: boolean;
}

type Schema = Record<string, unknown>;

export function fieldsOf(schema: Schema | null | undefined): Field[] {
  if (!schema) return [];
  const props = (schema['properties'] ?? {}) as Record<string, Schema>;
  const required = new Set((schema['required'] as string[] | undefined) ?? []);
  return Object.entries(props).map(([name, p]) => {
    const t = Array.isArray(p['type']) ? (p['type'] as string[])[0] : (p['type'] as string | undefined);
    let type: FieldType = 'string';
    let itemEnum: readonly string[] | undefined;
    if (Array.isArray(p['enum'])) type = 'enum';
    else if (t === 'number') type = 'number';
    else if (t === 'integer') type = 'integer';
    else if (t === 'boolean') type = 'boolean';
    else if (t === 'array') {
      type = 'string[]';
      const items = (p['items'] ?? {}) as Schema;
      if (Array.isArray(items['enum'])) itemEnum = items['enum'] as string[];
    }
    return {
      name,
      title: text(p['title'], name),
      description: text(p['description'], ''),
      type,
      ...(type === 'enum' ? { enum: (p['enum'] as unknown[]).map(String) } : {}),
      ...(itemEnum ? { itemEnum } : {}),
      ...('default' in p ? { default: p['default'] } : {}),
      required: required.has(name),
    };
  });
}

export function initialParams(fields: readonly Field[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const f of fields) if (f.default !== undefined) out[f.name] = f.default;
  return out;
}

/** 文字輸入 → schema 型別；空字串＝拿掉這個欄位。 */
function text(v: unknown, fallback: string): string {
  return typeof v === 'string' ? v : fallback;
}

/** 給輸入框顯示用：字串／數字／布林以外一律空字串。 */
export function asText(v: unknown): string {
  return typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean' ? String(v) : Array.isArray(v) ? v.map(String).join(', ') : '';
}

export function coerce(field: Field, raw: string | boolean | string[]): unknown {
  if (field.type === 'boolean') return Boolean(raw);
  if (field.type === 'string[]') {
    if (Array.isArray(raw)) return raw;
    const list = String(raw).split(/[,\s]+/).map((s) => s.trim()).filter(Boolean);
    return list.length ? list : undefined;
  }
  const s = String(raw).trim();
  if (s === '') return undefined;
  if (field.type === 'number') return Number.isFinite(Number(s)) ? Number(s) : undefined;
  if (field.type === 'integer') return /^-?\d+$/.test(s) ? Number(s) : undefined;
  return s;
}

export function missingRequired(fields: readonly Field[], params: Record<string, unknown>): string[] {
  return fields.filter((f) => f.required && params[f.name] === undefined).map((f) => f.title);
}
