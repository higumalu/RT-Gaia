import { licenseNotice, parseAllowLicenses, registerProblems, sortRows, statusClass } from '../src/react/plugins/model';
import type { PluginRow } from '../src/react/plugins/pluginsApi';

const row = (over: Partial<PluginRow>): PluginRow => ({
  plugin_id: 'x', version: '1', label: 'X', icon: null, description: '', has_ui: false, required_role: 'contourer',
  status: 'active', enabled: true, allowed: true, ...over,
});

describe('plugins admin model', () => {
  it('validates the register form', () => {
    expect(registerProblems('http://p:8702', 'abc')).toBeNull();
    expect(registerProblems('p:8702', 'abc')).toMatch(/endpoint/);
    expect(registerProblems('http://p', 'a b')).toMatch(/token/);
  });
  it('parses allow-licenses', () => {
    expect(parseAllowLicenses(' GPL-3.0-only, AGPL-3.0 GPL-3.0-only ')).toEqual(['GPL-3.0-only', 'AGPL-3.0']);
  });
  it('flags non-commercial weights and admin overrides', () => {
    expect(licenseNotice(row({ manifest: { soup: [{ name: 'w', version: '1', license: 'CC-BY-NC-SA-4.0', kind: 'model-weights' }] } }))).toMatch(/非商業/);
    expect(licenseNotice(row({ allow_licenses: ['GPL-3.0-only'] }))).toMatch(/放行/);
    expect(licenseNotice(row({}))).toBeNull();
  });
  it('maps status to a class and sorts by label', () => {
    expect(statusClass('active')).toBe('ok');
    expect(statusClass('license')).toBe('warning');
    expect(sortRows([row({ label: 'b' }), row({ label: 'a' })]).map((r) => r.label)).toEqual(['a', 'b']);
  });
});
