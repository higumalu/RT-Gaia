#!/usr/bin/env node
/**
 * 次要影像上的結構可以畫、存得進去 —— headless Chrome ＋ CDP（`scripts/lib/cdp.mjs`），量測堆疊的合成病例：
 *
 *   計畫 CT（primary）＋ CBCT（另一個 Frame of Reference，有 REG 對位）
 *   ROI 面板新建 ForCheck，掛在 CBCT 那組影像 → 筆刷在軸向格畫一筆
 *     • `/edit` 帶的是 **CBCT 的** mask_grid_id（以前一律帶 primary 的 → 每一筆 400 I3，存不進去）
 *     • 回 200、後端的體積 > 0、沒有「沒存到」的提示
 *   最後刪掉 ForCheck、釋放這個 session
 *
 *   uv run python packages/rtgaia-testbe/tests/synth_dicom.py data/test_synth_for
 *   scripts/perf/stack.sh start            # 已經開著的話：curl -X POST http://127.0.0.1:8091/api/v1/library/rescan
 *   node scripts/verify-secondary-for-edit.mjs --url http://127.0.0.1:5183/#/library [--out-dir DIR]
 * 退出碼：任一項失敗 → 1。
 */
import { checklist, launch, parseArgs, sleep } from './lib/cdp.mjs';

const args = parseArgs();
const b = await launch({ url: args.url ?? 'http://127.0.0.1:5183/#/library', outDir: args['out-dir'] ?? null, port: Number(args.port ?? 9375) });
const c = checklist();
const { evaluate, waitFor, send } = b;
const NAME = 'ForCheck';

const button = (text, scope = 'document') => `[...(${scope}).querySelectorAll('button')].find((x) => x.textContent.trim() === ${JSON.stringify(text)} && x.getBoundingClientRect().width > 0)`;
const click = (expr) => evaluate(`(() => { const e = ${expr}; if (!e) return false; e.click(); return true; })()`);
const setValue = (expr, value, kind = 'input') =>
  evaluate(`(() => { const el = ${expr}; const proto = el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype; Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, ${JSON.stringify(value)}); el.dispatchEvent(new Event(${JSON.stringify(kind)}, { bubbles: true })); return true; })()`);
const json = (method, path, body) =>
  evaluate(`fetch('/api/v1' + ${JSON.stringify(path)}, { method: ${JSON.stringify(method)}, headers: { 'content-type': 'application/json' }, body: ${body === undefined ? 'undefined' : JSON.stringify(JSON.stringify(body))} }).then(async (r) => ({ status: r.status, body: await r.text() }))`).then((r) => ({ ...r, json: r.body ? JSON.parse(r.body) : null }));
const cellSel = (label) => `[...document.querySelectorAll('.viewport-cell')].find((c) => c.querySelector('.viewport-label')?.textContent.trim() === ${JSON.stringify(label)})`;

await send('Emulation.setFocusEmulationEnabled', { enabled: true });
await b.device('desktop');
await send('Page.navigate', { url: `${b.origin}/#/library` });
await waitFor(`document.readyState === 'complete'`, '頁面載入');

// 用 API 開病例（同一個人），再進檢視器：檢視器載入「目前的 session」
const lib = (await json('GET', '/library/series?patient_id=SYNTH-0001')).json;
const series = lib.patients[0].studies.flatMap((s) => s.series);
const plan = series.find((s) => s.modality === 'CT' && !/CBCT/i.test(s.series_description ?? ''));
const cbct = series.find((s) => s.modality === 'CT' && /CBCT/i.test(s.series_description ?? ''));
const reg = series.find((s) => s.modality === 'REG');
c.check('合成病例有計畫 CT、CBCT、REG', !!(plan && cbct && reg), `${series.length} 個序列`);
const opened = await json('POST', '/sessions', { primary_series_uid: plan.series_instance_uid, image_series_uids: [plan.series_instance_uid, cbct.series_instance_uid], structure_set_uids: [], dose_uids: [], registration_uids: [reg.series_instance_uid], plan_uids: [] });
c.check('開了病例', opened.status === 201, `${opened.status} ${opened.body.slice(0, 60)}`);
const { session_id: sid, study_id: studyId } = opened.json;
await evaluate(`location.hash = '#/viewer'; location.reload(); true`);
await waitFor(`location.hash.includes('viewer') && document.querySelectorAll('.viewport-cell canvas').length >= 1`, '病例開起來', 120000);
await waitFor(`!document.querySelector('.mask-loading')`, '結構載入完', 60000);
await sleep(1000);

const scene = (await json('GET', '/sessions/current')).json;
const cbctFor = cbct.frame_of_reference_uid;
const cbctGrid = scene.gridSet.mask_grids.find((m) => m.grid.frame_of_reference_uid === cbctFor)?.mask_grid_id;
const primaryGrid = scene.gridSet.mask_grid.mask_grid_id;
c.check('CBCT 有自己的 MaskGrid', !!cbctGrid && cbctGrid !== primaryGrid, `${cbctGrid} / ${primaryGrid}`);

// 記下 /edit 的 body 與回應
const edits = new Map();
await send('Network.enable');
b.on('Network.requestWillBeSent', (p) => {
  if (/\/structures\/[^/]+\/edit$/.test(new URL(p.request.url).pathname)) edits.set(p.requestId, { body: JSON.parse(p.request.postData ?? '{}'), status: null });
});
b.on('Network.responseReceived', (p) => {
  if (edits.has(p.requestId)) edits.get(p.requestId).status = p.response.status;
});

// ROI 面板新建，掛在 CBCT 那組影像
await click(button('ROI 編輯'));
await waitFor(`!!document.querySelector('.roi-panel')`, 'ROI 編輯面板');
if (!(await evaluate(`!!document.querySelector('.roi-create')`))) await click(button('新建', "document.querySelector('.roi-panel')"));
await waitFor(`!!document.querySelector('.roi-create input.roi-name')`, '新建列');
await setValue(`document.querySelector('.roi-create input.roi-name')`, NAME);
c.check('新建列可以選影像組', await evaluate(`!!document.querySelector('.roi-create select.roi-set')`), '');
await setValue(`document.querySelector('.roi-create select.roi-set')`, cbctFor, 'change');
await click(button('建立', "document.querySelector('.roi-create')"));
await waitFor(`document.querySelector('.roi-panel .roi-active input.roi-name')?.value === ${JSON.stringify(NAME)}`, '新結構是編輯對象', 20000);
const made = (await json('GET', `/studies/${encodeURIComponent(studyId)}/structures`)).json.find((s) => s.name === NAME);
c.check('結構掛在 CBCT 的 FoR', made?.frame_of_reference_uid === cbctFor, made?.frame_of_reference_uid ?? '');

// 筆刷在軸向格中央畫一筆
await sleep(800);
const ac = await b.centerOf(`${cellSel('軸向')}.querySelector('canvas')`);
await click(button('筆刷', "document.querySelector('.roi-panel')"));
await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: ac.x, y: ac.y, button: 'left', buttons: 1, clickCount: 1 });
for (let i = 1; i <= 8; i += 1) {
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: ac.x + i * 4, y: ac.y + i * 2, buttons: 1, button: 'left' });
  await sleep(30);
}
await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: ac.x + 32, y: ac.y + 16, button: 'left', buttons: 0, clickCount: 1 });
await click(button('筆刷', "document.querySelector('.roi-panel')"));
const deadline = Date.now() + 15000;
while (Date.now() < deadline && ![...edits.values()].some((e) => e.status !== null)) await sleep(200);
await sleep(1500);

const sent = [...edits.values()];
c.check('畫了一筆就送出 /edit', sent.length > 0, `${sent.length} 筆`);
c.check('/edit 帶 CBCT 的 mask_grid_id', sent.length > 0 && sent.every((e) => e.body.mask_grid_id === cbctGrid), sent.map((e) => e.body.mask_grid_id).join(','));
c.check('/edit 都回 200', sent.length > 0 && sent.every((e) => e.status === 200), sent.map((e) => e.status).join(','));
const after = (await json('GET', `/studies/${encodeURIComponent(studyId)}/structures`)).json.find((s) => s.name === NAME);
const vol = Array.isArray(after?.volume_cc) ? after.volume_cc[0] : after?.volume_cc;
c.check('後端體積 > 0', typeof vol === 'number' && vol > 0, String(vol));
const unsaved = await evaluate(`document.body.innerText.includes('沒有存到')`);
c.check('沒有「沒存到」的提示', !unsaved, '');

const removed = await json('DELETE', `/structures/${encodeURIComponent(made.structure_id)}`);
c.check('清掉測試結構', removed.status === 204, String(removed.status));
await json('POST', `/sessions/${encodeURIComponent(sid)}/release`, {});
await sleep(300);
c.check('沒有頁面例外', b.errors.length === 0, b.errors.slice(0, 2).join(' | '));
await b.shot('secondary-for-edit.png');
const failed = c.report();
b.close();
process.exit(failed ? 1 : 0);
