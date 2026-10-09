/** 夠用的 semver：`^`、`~`、`>=`、精確、`*`／`x`。plugin bundle 的 `sdkVersion` 對宿主 `SDK_VERSION`。 */

export function parseVersion(v: string): [number, number, number] | null {
  const m = /^v?(\d+)\.(\d+)\.(\d+)/.exec(v.trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

function cmp(a: [number, number, number], b: [number, number, number]): number {
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i]! - b[i]!;
  return 0;
}

export function satisfies(range: string, version: string): boolean {
  const v = parseVersion(version);
  if (v === null) return false;
  const r = range.trim();
  if (r === '' || r === '*' || r === 'x') return true;
  const op = /^(\^|~|>=|=)?\s*(.+)$/.exec(r);
  if (!op) return false;
  const base = parseVersion(op[2]!);
  if (base === null) return false;
  switch (op[1] ?? '=') {
    case '^': {
      if (cmp(v, base) < 0) return false;
      // 0.x：只允許同 minor；否則同 major
      return base[0] === 0 ? v[0] === 0 && v[1] === base[1] : v[0] === base[0];
    }
    case '~':
      return cmp(v, base) >= 0 && v[0] === base[0] && v[1] === base[1];
    case '>=':
      return cmp(v, base) >= 0;
    default:
      return cmp(v, base) === 0;
  }
}
