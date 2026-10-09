// UI bundle check (same rules as the UI step of rtgaia-plugin-check; see docs/plugin-contract.md#ui-bundles):
// only the four allowed externals are imported, React is not bundled, and the entry's id and version are present.
// Usage: node examples/check-ui-bundle.mjs <bundle.js> <id> <version>
import { readFileSync } from 'node:fs';

const [file, id, version] = process.argv.slice(2);
const js = readFileSync(file, 'utf8');
const ALLOWED = new Set(['react', 'react-dom', 'react/jsx-runtime', '@rtgaia/sdk']);
const specs = [...js.matchAll(/(?:import|from)\s*["']([^"']+)["']/g), ...js.matchAll(/import\(\s*["']([^"']+)["']/g)].map((m) => m[1]);
const bare = [...new Set(specs.filter((s) => !s.startsWith('.') && !s.startsWith('/')))];
const bad = bare.filter((s) => !ALLOWED.has(s));
const problems = [];
if (bad.length) problems.push(`disallowed imports: ${bad.join(', ')}`);
if (js.includes('react.production') || js.includes('__SECRET_INTERNALS_DO_NOT_USE')) problems.push('React is bundled into the bundle');
// A static check can only see literals: the manifest's id and version must appear in the bundle as strings.
if (!js.includes(`"${id}"`) && !js.includes(`'${id}'`)) problems.push(`the bundle does not contain the id string "${id}"`);
if (!js.includes(`"${version}"`) && !js.includes(`'${version}'`)) problems.push(`the bundle does not contain the version string "${version}"`);
console.log(`externals: ${bare.join(', ')}`);
if (problems.length) {
  for (const p of problems) console.error(`❌ ${p}`);
  process.exit(1);
}
console.log('✅ bundle conforms to the UI bundle rules (docs/plugin-contract.md#ui-bundles)');
