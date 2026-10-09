// RT-Gaia plugin shim (docs/plugin-contract.md, UI bundles): gives plugin bundles the host's @rtgaia/sdk instance as an ES module.
// The import map in index.html points here; the host fills globalThis.__rtgaia__ in src/sdk/expose.ts.
const H = globalThis.__rtgaia__;
if (!H) throw new Error('RT-Gaia host is not loaded (globalThis.__rtgaia__ is missing); plugin bundles can only be loaded by the RT-Gaia viewer');
const M = H.sdk;
export default M;
export const { registerModule, registerLayout, hasLayout, useViewerApi, getLang, msg, registerMessages, t, SDK_VERSION } = M;
