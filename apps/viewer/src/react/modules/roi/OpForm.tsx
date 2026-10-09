/**
 * 由 `GET /ops` 的 JSON schema 生成的參數表單（新增運算不必改前端）。
 * widget 詞彙表見 `ops.py`；不在清單內的退回數字欄。
 */

import type { OpDescriptor, StructureMeta } from '../../../core';
import { fieldsOf, HU_PRESETS, type OpField } from './model';
import { t } from '../../../core/i18n';

/** enum／structure-picker 的值只會是字串或數字；其他型別顯示空字串。 */
function strOf(v: unknown): string {
  return typeof v === 'string' ? v : typeof v === 'number' ? String(v) : '';
}

export interface OpFormProps {
  readonly op: OpDescriptor;
  readonly params: Record<string, unknown>;
  readonly onChange: (params: Record<string, unknown>) => void;
  /** structure-picker 用：同 FoR 的其他結構。 */
  readonly otherStructures: readonly StructureMeta[];
  /** slice-range 用：目前切片索引（沒有就 null）。 */
  readonly currentSlice: () => number | null;
  /** seed 用：十字線所在體素。 */
  readonly probeSeed: () => [number, number, number] | null;
  /**
   * hu-range 的單位 —— 這個結構 FoR 的影像（後端運算用的那張）的值單位。
   * 不是 HU（PET 換成 SUV、MR）→ 不給 HU 預設集、標實際單位；沒給 ＝ HU。
   */
  readonly valueUnit?: string;
}

export function OpForm({ op, params, onChange, otherStructures, currentSlice, probeSeed, valueUnit = 'HU' }: OpFormProps): React.JSX.Element {
  const set = (name: string, value: unknown) => onChange({ ...params, [name]: value });
  const field = (f: OpField): React.JSX.Element => {
    const v = params[f.name];
    switch (f.widget) {
      case 'boolean':
        return <input type="checkbox" checked={v === true} onChange={(e) => set(f.name, e.target.checked)} />;
      case 'enum':
        return (
          <select value={strOf(v)} onChange={(e) => set(f.name, coerceEnum(f, e.target.value))}>
            {(f.enumValues ?? []).map((o) => (
              <option key={String(o)} value={String(o)}>
                {String(o)}
              </option>
            ))}
          </select>
        );
      case 'integer':
        return <input type="number" className="num" step={1} value={typeof v === 'number' ? v : ''} onChange={(e) => set(f.name, e.target.value === '' ? undefined : Math.round(Number(e.target.value)))} />;
      case 'number':
        return (
          <>
            <input type="number" className="num" step={0.5} value={typeof v === 'number' ? v : ''} onChange={(e) => set(f.name, e.target.value === '' ? undefined : Number(e.target.value))} />
            {f.unit && <span className="muted">{f.unit}</span>}
          </>
        );
      case 'structure-picker':
        return (
          <select value={strOf(v)} onChange={(e) => set(f.name, e.target.value || undefined)}>
            <option value="">{t('— 選一個結構 —')}</option>
            {otherStructures.map((s) => (
              <option key={s.structureId} value={s.structureId}>
                {s.name ?? s.structureId}
              </option>
            ))}
          </select>
        );
      case 'slice-range': {
        const r = Array.isArray(v) ? (v as number[]) : [0, 0];
        return (
          <span className="roi-inline">
            <input type="number" className="num" value={r[0] ?? 0} onChange={(e) => set(f.name, [Number(e.target.value), r[1] ?? 0])} />
            <button type="button" className="mini" title={t('把目前切片當起點')} onClick={() => { const k = currentSlice(); if (k !== null) set(f.name, [k, r[1] ?? k]); }}>{t('起＝目前')}</button>
            {t('～')}
            <input type="number" className="num" value={r[1] ?? 0} onChange={(e) => set(f.name, [r[0] ?? 0, Number(e.target.value)])} />
            <button type="button" className="mini" title={t('把目前切片當終點')} onClick={() => { const k = currentSlice(); if (k !== null) set(f.name, [r[0] ?? k, k]); }}>{t('終＝目前')}</button>
          </span>
        );
      }
      case 'hu-range': {
        const r = Array.isArray(v) ? (v as number[]) : [-200, 300];
        return (
          <span className="roi-inline">
            {valueUnit === 'HU' && (
              <select
                value={HU_PRESETS.find((p) => p.range[0] === r[0] && p.range[1] === r[1])?.id ?? 'custom'}
                onChange={(e) => { const p = HU_PRESETS.find((x) => x.id === e.target.value); if (p) set(f.name, [...p.range]); }}
              >
                {HU_PRESETS.map((p) => (
                  <option key={p.id} value={p.id}>
                    {t(p.label)}
                  </option>
                ))}
                <option value="custom">{t('自訂')}</option>
              </select>
            )}
            <input type="number" className="num" step={valueUnit === 'HU' ? 10 : 0.5} value={r[0] ?? -200} onChange={(e) => set(f.name, [Number(e.target.value), r[1] ?? 300])} />
            {t('～')}
            <input type="number" className="num" step={valueUnit === 'HU' ? 10 : 0.5} value={r[1] ?? 300} onChange={(e) => set(f.name, [r[0] ?? -200, Number(e.target.value)])} />
            <span className="muted">{valueUnit}</span>
          </span>
        );
      }
      case 'seed': {
        const s = Array.isArray(v) ? (v as number[]) : null;
        return (
          <span className="roi-inline">
            <span className="muted">{s ? `(${s.join(', ')})` : t('未設')}</span>
            <button type="button" className="mini" title={t('把十字線（讀數）所在的體素當種子')} onClick={() => { const seed = probeSeed(); if (seed) set(f.name, seed); }}>
              {t('以十字線為種子')}
            </button>
          </span>
        );
      }
      case 'bbox':
        return <span className="muted hint">{t('整個影像')}</span>;
    }
  };
  return (
    <div className="roi-op-form">
      {fieldsOf(op).map((f) => (
        <label key={f.name} className="roi-field" title={f.name}>
          <span className="roi-field-title">
            {f.title}
            {f.required && <span className="warn"> *</span>}
          </span>
          {field(f)}
        </label>
      ))}
    </div>
  );
}

function coerceEnum(f: OpField, raw: string): unknown {
  const match = (f.enumValues ?? []).find((o) => String(o) === raw);
  return match ?? raw;
}
