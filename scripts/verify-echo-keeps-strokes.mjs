#!/usr/bin/env node
/**
 * 自己編輯的 `mask.updated` 回音不能蓋掉還沒送出的筆畫 —— headless Chrome ＋ CDP（`scripts/lib/cdp.mjs`），
 * 量測堆疊的合成病例 SYNTH-0001（計畫 CT）：
 *
 *   對照：結構 EchoA 畫兩筆（左、右各一筆），每筆等送完 → 後端體積 Vc
 *   測試：結構 EchoB 畫同樣兩筆，但第一筆的 `/edit` 回應先扣住（模擬遠端延遲）：
 *     第一筆已經在後端套用、回音推到檢視器 → 以前會重抓整份 mask、蓋掉本地 →
 *     這時畫第二筆（還在佇列裡等第一筆回應）→ 重抓回來的舊版蓋掉它 → 佇列送出時從本地讀資料，第二筆就沒了
 *     • 兩筆都送完後，後端體積 ＝ Vc（以前比 Vc 小）
 *     • 沒有假的 409（衝突提示）
 *   最後刪掉兩個結構。
 *
 *   uv run python packages/rtgaia-testbe/tests/synth_dicom.py data/test_synth_for
 *   scripts/perf/stack.sh start            # 已經開著的話：curl -X POST http://127.0.0.1:8091/api/v1/library/rescan
 *   node scripts/verify-echo-keeps-strokes.mjs --url http://127.0.0.1:5183/#/library [--out-dir DIR]
 * 退出碼：任一項失敗 → 1。
 */
import { checklist, launch, parseArgs, sleep } from './lib/cdp.mjs';

const args = parseArgs();
const b = await launch({ url: args.url ?? 'http://127.0.0.1:5183/#/library', outDir: args['out-dir'] ?? null, port: Number(args.port ?? 9376) });
const c = checklist();
const { evaluate, waitFor, send } = b;

const button = (text, scope = 'document') => `[...(${scope}).querySelectorAll('button')].find((x) => x.textContent.trim() === ${JSON.stringify(text)} && x.getBoundingClientRect().width > 0)`;
const click = (expr) => evaluate(`(() => { const e = ${expr}; if (!e) return false; e.click(); return true; })()`);
const setValue = (expr, value) =>
  evaluate(`(() => { const el = ${expr}; Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, ${JSON.stringify(value)}); el.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
const json = (method, path, body) =>
  evaluate(`fetch('/api/v1' + ${JSON.stringify(path)}, { method: ${JSON.stringify(method)}, headers: { 'content-type': 'application/json' }, body: ${body === undefined ? 'undefined' : JSON.stringify(JSON.stringify(body))} }).then(async (r) => ({ status: r.status, body: await r.text() }))`).then((r) => ({ ...r, json: r.body ? JSON.parse(r.body) : null }));
const cellSel = (label) => `[...document.querySelectorAll('.viewport-cell')].find((c) => c.querySelector('.viewport-label')?.textContent.trim() === ${JSON.stringify(label)})`;

await send('Emulation.setFocusEmulationEnabled', { enabled: true });
await b.device('desktop');
await send('Page.navigate', { url: `${b.origin}/#/library` });
await waitFor(`document.readyState === 'complete'`, '頁面載入');
const lib = (await json('GET', '/library/series?patient_id=SYNTH-0001')).json;
const plan = lib.patients[0].studies.flatMap((s) => s.series).find((s) => s.modality === 'CT' && !/CBCT/i.test(s.series_description ?? ''));
const opened = await json('POST', '/sessions', { primary_series_uid: plan.series_instance_uid, image_series_uids: [plan.series_instance_uid], structure_set_uids: [], dose_uids: [], registration_uids: [], plan_uids: [] });
c.check('開了病例', opened.status === 201, String(opened.status));
const { session_id: sid, study_id: studyId } = opened.json;
await evaluate(`location.hash = '#/viewer'; location.reload(); true`);
await waitFor(`location.hash.includes('viewer') && document.querySelectorAll('.viewport-cell canvas').length >= 1`, '病例開起來', 120000);
await waitFor(`!document.querySelector('.mask-loading')`, '結構載入完', 60000);
await sleep(800);
const listed = async (name) => (await json('GET', `/studies/${encodeURIComponent(studyId)}/structures`)).json.find((s) => s.name === name);
for (const name of ['EchoA', 'EchoB']) {
  const old = await listed(name);
  if (old) await json('DELETE', `/structures/${encodeURIComponent(old.structure_id)}`);
}

await click(button('ROI 編輯'));
await waitFor(`!!document.querySelector('.roi-panel')`, 'ROI 編輯面板');
const create = async (name) => {
  if (!(await evaluate(`!!document.querySelector('.roi-create')`))) await click(button('新建', "document.querySelector('.roi-panel')"));
  await waitFor(`!!document.querySelector('.roi-create input.roi-name')`, '新建列');
  await setValue(`document.querySelector('.roi-create input.roi-name')`, name);
  await click(button('建立', "document.querySelector('.roi-create')"));
  await waitFor(`document.querySelector('.roi-panel .roi-active input.roi-name')?.value === ${JSON.stringify(name)}`, `${name} 是編輯對象`, 20000);
  await sleep(500);
};
const ac = await b.centerOf(`${cellSel('軸向')}.querySelector('canvas')`);
const stroke = async (dx) => {
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: ac.x + dx, y: ac.y - 20, button: 'left', buttons: 1, clickCount: 1 });
  for (let i = 1; i <= 8; i += 1) {
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: ac.x + dx, y: ac.y - 20 + i * 5, buttons: 1, button: 'left' });
    await sleep(20);
  }
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: ac.x + dx, y: ac.y + 20, button: 'left', buttons: 0, clickCount: 1 });
};
const volumeOf = async (name) => {
  const s = await listed(name);
  return Array.isArray(s?.volume_cc) ? s.volume_cc[0] : s?.volume_cc;
};
/** 等這個結構的 /edit 都回來、後端體積穩定。 */
const settle = async (name) => {
  let last = null;
  for (let i = 0; i < 40; i += 1) {
    await sleep(250);
    const v = await volumeOf(name);
    if (v === last && v > 0) return v;
    last = v;
  }
  return last;
};

// 對照
await create('EchoA');
await click(button('筆刷', "document.querySelector('.roi-panel')"));
await stroke(-40);
await settle('EchoA');
await stroke(40);
const vc = await settle('EchoA');
await click(button('筆刷', "document.querySelector('.roi-panel')"));
c.check('對照：兩筆都存進去', typeof vc === 'number' && vc > 0, String(vc));

// 測試：扣住第一筆的 /edit 回應與回音觸發的 mask 重抓
const held = [];
let holding = true;
b.on('Fetch.requestPaused', (p) => {
  if (holding) held.push({ id: p.requestId, mask: p.request.url.includes('/mask') });
  else void send('Fetch.continueRequest', { requestId: p.requestId });
});
await create('EchoB');
const echoB = (await listed('EchoB')).structure_id;
await send('Fetch.enable', {
  patterns: [
    { urlPattern: `*/api/v1/structures/${echoB}/edit*`, requestStage: 'Response' },
    { urlPattern: `*/api/v1/structures/${echoB}/mask*`, requestStage: 'Response' },
  ],
});
await click(button('筆刷', "document.querySelector('.roi-panel')"));
await stroke(-40);
await sleep(1200); // 第一筆已在後端套用，回音推到；（以前）重抓的 GET /mask 也送出去了、回應被扣住
const heldEdits = held.filter((h) => !h.mask).length;
const heldRefetches = held.filter((h) => h.mask).length;
await stroke(40); // 第二筆：第一筆的回應還沒回來，留在佇列
await sleep(300);
holding = false;
// 先放回音觸發的 mask 重抓（若有）：它回來時第二筆還在佇列裡；再放第一筆的 /edit 回應，佇列才送第二筆
for (const h of held.filter((x) => x.mask)) await send('Fetch.continueRequest', { requestId: h.id });
await sleep(500);
for (const h of held.filter((x) => !x.mask)) await send('Fetch.continueRequest', { requestId: h.id });
held.length = 0;
const vt = await settle('EchoB');
await click(button('筆刷', "document.querySelector('.roi-panel')"));
await send('Fetch.disable');
c.check('第一筆的回應有被扣住', heldEdits >= 1, `/edit ${heldEdits} 個、mask 重抓 ${heldRefetches} 個`);
c.check('延遲下兩筆都存進去（體積 ＝ 對照）', vt === vc, `${vt} vs ${vc}`);
const conflict = await evaluate(`document.body.innerText.includes('已被其他來源修改')`);
c.check('沒有假的衝突提示', !conflict, '');

for (const name of ['EchoA', 'EchoB']) {
  const s = await listed(name);
  if (s) await json('DELETE', `/structures/${encodeURIComponent(s.structure_id)}`);
}
await json('POST', `/sessions/${encodeURIComponent(sid)}/release`, {});
await sleep(300);
c.check('沒有頁面例外', b.errors.length === 0, b.errors.slice(0, 2).join(' | '));
await b.shot('echo-keeps-strokes.png');
const failed = c.report();
b.close();
process.exit(failed ? 1 : 0);
