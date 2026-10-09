/**
 * 執行期載入的純邏輯 —— semver、bundle 入口驗證、宣告式表單、選單項目、job 摘要。
 */
import { menuItems, pluginCatalog, type PluginInfo } from '../src/react/plugins/catalog';
import { jobSummary } from '../src/react/plugins/DeclarativePanel';
import { sha256Hex, uiLoadDecision, validateEntry, verifyBundleDigest } from '../src/react/plugins/loader';
import { coerce, fieldsOf, initialParams, missingRequired } from '../src/react/plugins/schemaForm';
import { satisfies } from '../src/react/plugins/semver';
import { defaultSelection, isEmptyStructure } from '../src/react/modules/export/model';
import type { StructureMeta } from '../src/core';
import { isTaskMode, modeChanges } from '../src/react/components/taskBar';

const info = (over: Partial<PluginInfo> = {}): PluginInfo => ({
  plugin_id: 'p', version: '1.2.3', label: 'P', icon: null, description: '', has_ui: true, required_role: 'contourer',
  status: 'active', enabled: true, allowed: true, ...over,
});

describe('semver', () => {
  it('caret / tilde / exact / any', () => {
    expect(satisfies('^0.1.0', '0.1.5')).toBe(true);
    expect(satisfies('^0.1.0', '0.2.0')).toBe(false);
    expect(satisfies('^1.2.0', '1.9.9')).toBe(true);
    expect(satisfies('^1.2.0', '2.0.0')).toBe(false);
    expect(satisfies('~1.2.0', '1.2.9')).toBe(true);
    expect(satisfies('~1.2.0', '1.3.0')).toBe(false);
    expect(satisfies('1.2.3', '1.2.3')).toBe(true);
    expect(satisfies('*', '9.9.9')).toBe(true);
    expect(satisfies('^1.0.0', 'garbage')).toBe(false);
  });
});

describe('bundle entry validation', () => {
  const ok = { id: 'p', version: '1.2.3', sdkVersion: '^0.1.0', register: () => undefined };
  it('accepts a matching entry and names each mismatch', () => {
    expect(validateEntry(ok, info(), '0.1.0')).toBeNull();
    expect(validateEntry({ ...ok, id: 'q' }, info(), '0.1.0')).toMatch(/id/);
    expect(validateEntry({ ...ok, version: '9.0.0' }, info(), '0.1.0')).toMatch(/version/);
    expect(validateEntry({ ...ok, sdkVersion: '^2.0.0' }, info(), '0.1.0')).toMatch(/sdkVersion/);
    expect(validateEntry(null, info(), '0.1.0')).toMatch(/default/);
  });
});

describe('載入前的信任檢查', () => {
  it('uiLoadDecision：沒 UI／沒宣告 trust／沒 digest 都不載；三者齊才 import', () => {
    expect(uiLoadDecision({ has_ui: false })).toMatch(/沒有 UI/);
    expect(uiLoadDecision({ has_ui: true, ui_trust: null, ui_digest: 'ab' })).toMatch(/trust/);
    expect(uiLoadDecision({ has_ui: true, ui_trust: 'host-equivalent', ui_digest: null })).toMatch(/digest/);
    expect(uiLoadDecision({ has_ui: true, ui_trust: 'host-equivalent', ui_digest: 'ab' })).toBeNull();
  });
  it('verifyBundleDigest：先 fetch 比 sha256，不符就回理由（呼叫端不 import）', async () => {
    const js = 'export default { id: "p" };';
    const good = await sha256Hex(js);
    expect(good).toMatch(/^[0-9a-f]{64}$/);
    const fetchOk = (async () => new Response(js, { status: 200 })) as unknown as typeof fetch;
    expect(await verifyBundleDigest('/x.js', good, fetchOk)).toBeNull();
    expect(await verifyBundleDigest('/x.js', good.toUpperCase(), fetchOk)).toBeNull();
    const tampered = (async () => new Response('fetch("/api/v1/cases");' + js, { status: 200 })) as unknown as typeof fetch;
    expect(await verifyBundleDigest('/x.js', good, tampered)).toMatch(/digest 不符/);
    const down = (async () => new Response('', { status: 502 })) as unknown as typeof fetch;
    expect(await verifyBundleDigest('/x.js', good, down)).toMatch(/HTTP 502/);
  });
});

describe('schema form', () => {
  const schema = {
    type: 'object',
    required: ['model'],
    properties: {
      model: { type: 'string', enum: ['hn', 'thorax'], title: '模型' },
      hu_min: { type: 'number', default: 0 },
      n: { type: 'integer' },
      fast: { type: 'boolean', default: true },
      structures: { type: 'array', items: { type: 'string' } },
      pick: { type: 'array', items: { type: 'string', enum: ['a', 'b'] } },
    },
  };
  it('derives fields, defaults and coercion', () => {
    const fields = fieldsOf(schema);
    expect(fields.map((f) => f.type)).toEqual(['enum', 'number', 'integer', 'boolean', 'string[]', 'string[]']);
    expect(fields[5]!.itemEnum).toEqual(['a', 'b']);
    expect(initialParams(fields)).toEqual({ hu_min: 0, fast: true });
    expect(coerce(fields[1]!, '12.5')).toBe(12.5);
    expect(coerce(fields[2]!, '1.5')).toBeUndefined();
    expect(coerce(fields[4]!, 'liver, spleen')).toEqual(['liver', 'spleen']);
    expect(coerce(fields[4]!, '')).toBeUndefined();
    expect(missingRequired(fields, {})).toEqual(['模型']);
    expect(missingRequired(fields, { model: 'hn' })).toEqual([]);
  });
});

describe('menu', () => {
  it('lists usable and explains unusable', () => {
    pluginCatalog.reset();
    pluginCatalog.set(info({ plugin_id: 'a', label: 'A' }), { kind: 'bundle' });
    pluginCatalog.set(info({ plugin_id: 'b', label: 'B', allowed: false, required_role: 'approver' }), { kind: 'unavailable', reason: 'x' });
    pluginCatalog.set(info({ plugin_id: 'c', label: 'C' }), { kind: 'failed', reason: 'sdkVersion 不相容' });
    const items = menuItems(pluginCatalog.list());
    expect(items.map((i) => [i.entry.info.plugin_id, i.usable, i.reason])).toEqual([
      ['a', true, null],
      ['b', false, '需要 approver'],
      ['c', false, 'sdkVersion 不相容'],
    ]);
    expect(pluginCatalog.isStale()).toBe(false);
    pluginCatalog.markStale();
    expect(pluginCatalog.isStale()).toBe(true);
  });
  it('plugin modes are exclusive task modes', () => {
    expect(isTaskMode('plugin:x')).toBe(true);
    expect(modeChanges(['roi', 'mpr'], 'plugin:x', true)).toEqual([{ id: 'roi', enabled: false }, { id: 'plugin:x', enabled: true }]);
    expect(modeChanges(['plugin:x'], 'roi', true)).toEqual([{ id: 'plugin:x', enabled: false }, { id: 'roi', enabled: true }]);
  });
});

describe('job summary', () => {
  it('reads like a sentence', () => {
    expect(jobSummary(null)).toBe('尚未執行');
    expect(jobSummary({ status: 'running', percent: 33.3, phase: 'inference' })).toBe('執行中 33%（inference）');
    expect(jobSummary({ status: 'done', materialized: 3, bundles: [{ rejected: [{ code: 'B8', reason: 'empty' }] }] })).toBe('完成：3 個結構已放入「plugin 結果（未儲存）」；拒收 1：B8 empty');
    expect(jobSummary({ status: 'failed', error: 'B3' })).toBe('失敗：B3');
  });
});

describe('events and export defaults', () => {
  it('keeps the last five events, newest first', () => {
    pluginCatalog.clearEvents();
    for (let i = 0; i < 7; i++) pluginCatalog.addEvent(`e${i}`);
    expect(pluginCatalog.listEvents().map((e) => e.text)).toEqual(['e6', 'e5', 'e4', 'e3', 'e2']);
  });
  it('export default excludes transient results when nothing is approved', () => {
    const sm = (id: string, over: Partial<StructureMeta>): StructureMeta => ({ structureId: id, status: 'ai_generated', volumeCc: 1, ...over });
    const sel = defaultSelection([sm('a', {}), sm('t', { structureSetKind: 'transient' })]);
    expect([...sel]).toEqual(['a']);
    expect([...defaultSelection([sm('a', { status: 'approved' }), sm('t', { structureSetKind: 'transient', status: 'approved' })])]).toEqual(['a', 't']);
  });
  it('empty (volume 0) structures are flagged and excluded from the default export selection', () => {
    const sm = (id: string, over: Partial<StructureMeta>): StructureMeta => ({ structureId: id, status: 'under_review', volumeCc: 1, ...over });
    expect(isEmptyStructure(sm('e', { volumeCc: 0 }))).toBe(true);
    expect(isEmptyStructure(sm('t', { volumeCc: [0, 2] }))).toBe(false);
    expect([...defaultSelection([sm('a', {}), sm('e', { volumeCc: 0 })])]).toEqual(['a']);
    expect([...defaultSelection([sm('a', { status: 'approved' }), sm('e', { status: 'approved', volumeCc: 0 })])]).toEqual(['a']);
  });
});
