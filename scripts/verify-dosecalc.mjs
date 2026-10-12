#!/usr/bin/env node
/**
 * 重算劑量（計畫面板）—— headless Chrome ＋ CDP（骨架同 `verify-dose-ops.mjs`、零相依），真的滑鼠事件：
 *
 *   開合成計畫的病例（CT ＋ RTPLAN；`rtgaia_testbe.fixtures.synth_plan`）→ 工具列「計畫」→「重算劑量」
 *   引擎清單：Geant4（還沒裝好時停用並說明原因）、流程測試引擎 → 選流程測試引擎、CT 範圍網格 → 送出
 *   工作出現（條件說明：示範模型、通用 CT 曲線、網格、分次）→ 完成 →「載入結果」→ 左側「劑量」面板多 4 個劑量（總 ＋ 3 個射束，射束預設隱藏）
 *   軸向格有劑量的顏色；英文模式沒有中文
 *
 * 需要量測堆疊、帶 `RTGAIA_DOSECALC_TEST_ENGINE=1`、資料庫目錄裡有 `data/test_plan`：
 *   uv run python -m rtgaia_testbe.fixtures.synth_plan --out data/test_plan
 *   RTGAIA_DOSECALC_TEST_ENGINE=1 scripts/perf/stack.sh start
 *   node scripts/verify-dosecalc.mjs --url http://127.0.0.1:5183/#/viewer --api http://127.0.0.1:8091 [--out-dir DIR]
 * 退出碼：任一步失敗 → 1。
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, a, i, arr) => {
    if (a.startsWith('--')) acc.push([a.slice(2), arr[i + 1]?.startsWith('--') || arr[i + 1] === undefined ? 'true' : arr[i + 1]]);
    return acc;
  }, []),
);
const url = args.url ?? 'http://127.0.0.1:5183/#/viewer';
const outDir = args['out-dir'] ?? null;
const port = Number(args.port ?? 9351);
const chrome = args.chrome ?? process.env.CHROME ?? 'google-chrome';
const token = args.token ?? process.env.TOKEN ?? null;
const origin = new URL(url).origin;

const profile = mkdtempSync(join(tmpdir(), 'rtgaia-dosecalc-'));
const proc = spawn(chrome, ['--headless=new', '--no-sandbox', '--password-store=basic', '--disable-gpu', '--hide-scrollbars', '--window-size=1600,1000', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, 'about:blank'], {
  stdio: 'ignore',
});
process.on('exit', () => {
  try {
    proc.kill('SIGKILL');
  } catch {
    /* already gone */
  }
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let targets = null;
for (let i = 0; i < 100 && targets === null; i += 1) {
  try {
    targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  } catch {
    await sleep(100);
  }
}
if (targets === null) throw new Error('Chrome 沒有起來');
const ws = new WebSocket((targets.find((t) => t.type === 'page') ?? targets[0]).webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  ws.onopen = resolve;
  ws.onerror = reject;
});
let seq = 0;
const pending = new Map();
const errors = [];
ws.onmessage = (event) => {
  const msg = JSON.parse(String(event.data));
  if (msg.id !== undefined && pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id);
    pending.delete(msg.id);
    if (msg.error) reject(new Error(msg.error.message));
    else resolve(msg.result);
  } else if (msg.method === 'Runtime.exceptionThrown') {
    errors.push(msg.params.exceptionDetails.exception?.description ?? msg.params.exceptionDetails.text);
  }
};
const send = (method, params = {}) =>
  new Promise((resolve, reject) => {
    const id = ++seq;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });
const evaluate = async (expression) => {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.text + ' ' + (r.exceptionDetails.exception?.description ?? ''));
  return r.result.value;
};
const shot = async (name) => {
  if (!outDir) return;
  const { data } = await send('Page.captureScreenshot', { format: 'png' });
  writeFileSync(join(outDir, name), Buffer.from(data, 'base64'));
};
const waitFor = async (expression, what, ms = 60000) => {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    try {
      if (await evaluate(expression)) return;
    } catch {
      /* 頁面還在換 */
    }
    await sleep(250);
  }
  await shot('dosecalc-failed.png').catch(() => undefined);
  throw new Error(`等不到：${what}`);
};
const step = (s) => console.log(`✓ ${s}`);
const clickAt = async (x, y) => {
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
  await sleep(250);
};
const centerOf = (expr) => evaluate(`(() => { const r = (${expr}).getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
const cellSel = (label) => `[...document.querySelectorAll('.viewport-cell')].find((c) => c.querySelector('.viewport-label')?.textContent.trim() === ${JSON.stringify(label)})`;

const setValue = (selector, value, kind = 'input') =>
  evaluate(`(() => { const el = ${selector}; const proto = el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype; Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, ${JSON.stringify(String(value))}); el.dispatchEvent(new Event(${JSON.stringify(kind)}, { bubbles: true })); return true; })()`);
const clickEl = async (expr) => {
  await evaluate(`(${expr}).scrollIntoView({ block: 'center' }); true`);
  const c = await centerOf(expr);
  await clickAt(c.x, c.y);
};
const panel = `document.querySelector('.dose-panel')`;
const spaces = () => evaluate(`[...${panel}.querySelectorAll('.dose-space')].map((sp) => ({ title: sp.querySelector('.dose-space-head').textContent, doses: [...sp.querySelectorAll('.dose-object')].map((li) => ({ id: li.dataset.series, name: li.querySelector('.dose-object-name').textContent, derived: li.dataset.derived === 'true' })) }))`);
const objectBy = (pred) => `[...${panel}.querySelectorAll('.dose-object')].find((li) => (${pred})(li))`;
const byName = (re) => objectBy(`(li) => ${re}.test(li.querySelector('.dose-object-name').textContent)`);
const actions = `${panel}.querySelector('.dose-actions')`;
const select = async (rowExpr) => {
  // 剛產生的結果會自動選取；已選的再點一次是取消選取 —— 沒選才點
  if (!(await evaluate(`(${rowExpr}).classList.contains('selected')`))) await clickEl(`(${rowExpr}).querySelector('.dose-object-name')`);
  await waitFor(`!!(${rowExpr})?.querySelector('.dose-actions')`, '選取後出現動作', 10000);
  await sleep(300);
};
const countObjects = () => evaluate(`${panel}.querySelectorAll('.dose-object').length`);
const countColors = async () => {
  const r = await evaluate(`(() => { const b = ${cellSel('軸向')}.querySelector('.viewport-canvas-host').getBoundingClientRect(); return { x: b.left, y: b.top, width: b.width, height: b.height }; })()`);
  const { data } = await send('Page.captureScreenshot', { format: 'png', clip: { ...r, scale: 1 } });
  return evaluate(`new Promise((resolve) => { const img = new Image(); img.onload = () => { const c = document.createElement('canvas'); c.width = img.width; c.height = img.height; const g = c.getContext('2d'); g.drawImage(img, 0, 0); const d = g.getImageData(0, 0, c.width, c.height).data; let blue = 0, red = 0; for (let i = 0; i < d.length; i += 4) { if (d[i + 2] > d[i] + 60 && d[i + 2] > d[i + 1] + 20) blue += 1; if (d[i] > d[i + 2] + 60 && d[i] > d[i + 1] + 40) red += 1; } resolve({ blue, red }); }; img.src = 'data:image/png;base64,${data}'; })`);
};


const api = args.api ?? 'http://127.0.0.1:8091';
const expected = JSON.parse((await import('node:fs')).readFileSync(args.expected ?? 'data/test_plan/plan6x/expected.json', 'utf8')).expected;
// 病例：CT ＋ RTPLAN（不帶 TPS 劑量 → 網格用 CT 範圍）
const opened = await (await fetch(`${api}/api/v1/sessions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ primary_series_uid: expected.ct_series_instance_uid, image_series_uids: [expected.ct_series_instance_uid], plan_uids: [expected.plan_series_instance_uid], dose_uids: [] }) })).json();
if (!opened.study_id) throw new Error(`開病例失敗：${JSON.stringify(opened)}`);
// 清掉這個病例以前的暫存劑量
const old = await (await fetch(`${api}/api/v1/studies/${encodeURIComponent(opened.study_id)}/dose-ops`)).json();
for (const r of old.results ?? []) await fetch(`${api}/api/v1/studies/${encodeURIComponent(opened.study_id)}/dose-ops/${r.series_id}`, { method: 'DELETE' });

await send('Runtime.enable');
await send('Page.enable');
await send('Emulation.setDeviceMetricsOverride', { width: 1600, height: 1000, deviceScaleFactor: 1, mobile: false });
await send('Page.addScriptToEvaluateOnNewDocument', { source: "try { if (!localStorage.getItem('rtgaia.lang')) localStorage.setItem('rtgaia.lang', 'zh-TW'); localStorage.setItem('rtgaia.tour.v1', 'done'); localStorage.setItem('rtgaia.layout.current.v1', '2x2'); localStorage.removeItem('rtgaia.dock.v1'); localStorage.removeItem('rtgaia.layout.trees.v1'); } catch {}" });
if (token) await send('Network.setCookie', { name: 'rtgaia_session', value: token, url: origin, httpOnly: true });
await send('Page.navigate', { url });
await waitFor(`document.querySelectorAll('.viewport-cell canvas').length >= 3 && !!document.querySelector('.plan-toggle button')`, '病例載入（工具列有「計畫」）');
await waitFor(`!document.querySelector('.mask-loading')`, '載入完', 60000);
const section = `document.querySelector('.plan-dosecalc')`;
if (!(await evaluate(`!!${section}`))) await clickEl(`document.querySelector('.plan-toggle button')`);
await waitFor(`!!${section}?.querySelector('select[data-field="dosecalc-engine"] option')`, '計畫面板的「重算劑量」', 20000);

// 1. 引擎清單
const opts = await evaluate(`[...${section}.querySelectorAll('select[data-field="dosecalc-engine"] option')].map((o) => ({ v: o.value, t: o.textContent, disabled: o.disabled }))`);
const g4 = opts.find((o) => o.v === 'geant4');
const test = opts.find((o) => o.v === 'pipeline-test');
if (!test || test.disabled || !g4) throw new Error(`引擎清單：${JSON.stringify(opts)}`);
step(`引擎：${opts.map((o) => `${o.t}${o.disabled ? '（停用）' : ''}`).join('；')}`);
await setValue(`${section}.querySelector('select[data-field="dosecalc-engine"]')`, 'pipeline-test', 'change');
await setValue(`${section}.querySelector('select[data-field="dosecalc-grid"]')`, 'ct', 'change');

// 2. 送出 → 工作 → 完成
const before = await evaluate(`${section}.querySelectorAll('.plan-dosecalc-jobs > li').length`);
await clickEl(`${section}.querySelector('button[data-action="dosecalc-submit"]')`);
await waitFor(`${section}.querySelectorAll('.plan-dosecalc-jobs > li').length === ${before + 1}`, '工作出現', 30000);
const jobLi = `${section}.querySelector('.plan-dosecalc-jobs > li')`;
const notes = await evaluate(`[...(${jobLi}).querySelectorAll('.dosecalc-notes li')].map((x) => x.textContent)`);
if (!notes.some((n) => /示範用/.test(n)) || !notes.some((n) => /CT 校正曲線/.test(n)) || !notes.some((n) => /2 次/.test(n))) throw new Error(`條件說明：${JSON.stringify(notes)}`);
step(`送出：${notes.join(' ／ ')}`);
await waitFor(`(${jobLi}).dataset.status === 'done'`, '計算完成', 180000);
step(`完成：${await evaluate(`(${jobLi}).querySelector('.dosecalc-status').textContent`)}`);

// 3. 載入結果 → 左側「劑量」面板多 4 個
const doseCount = () => evaluate(`document.querySelectorAll('.dose-panel .dose-object:not(.gamma-object)').length`);
const n0 = await doseCount();
await clickEl(`(${jobLi}).querySelector('button[data-action="dosecalc-load"]')`);
await waitFor(`!(${jobLi}).querySelector('button[data-action="dosecalc-load"]')`, '載入後按鈕消失', 30000);
await waitFor(`document.querySelectorAll('.dose-panel .dose-object:not(.gamma-object)').length === ${n0 + 4}`, '劑量面板多 4 個', 30000);
const names = await evaluate(`[...document.querySelectorAll('.dose-panel .dose-object:not(.gamma-object)')].map((li) => ({ name: li.querySelector('.dose-object-name').textContent, visible: li.querySelector('.visibility input').checked }))`);
const total = names.find((x) => /pipeline-test$/.test(x.name));
const beams = names.filter((x) => /beam \d$/.test(x.name));
if (!total?.visible || beams.length !== 3 || beams.some((b) => b.visible)) throw new Error(`載入的劑量：${JSON.stringify(names)}`);
step(`載入：${names.map((x) => `${x.name}${x.visible ? '' : '（隱藏）'}`).join('、')}`);

// 4. 軸向格有劑量顏色
const colorful = async () => {
  const r = await evaluate(`(() => { const b = ${cellSel('軸向')}.querySelector('.viewport-canvas-host').getBoundingClientRect(); return { x: b.left, y: b.top, width: b.width, height: b.height }; })()`);
  const { data } = await send('Page.captureScreenshot', { format: 'png', clip: { ...r, scale: 1 } });
  return evaluate(`new Promise((resolve) => { const img = new Image(); img.onload = () => { const c = document.createElement('canvas'); c.width = img.width; c.height = img.height; const g = c.getContext('2d'); g.drawImage(img, 0, 0); const d = g.getImageData(0, 0, c.width, c.height).data; let n = 0; for (let i = 0; i < d.length; i += 4) { const mx = Math.max(d[i], d[i + 1], d[i + 2]), mn = Math.min(d[i], d[i + 1], d[i + 2]); if (mx - mn > 60) n += 1; } resolve(n); }; img.src = 'data:image/png;base64,${data}'; })`);
};
let px = await colorful();
for (let i = 0; i < 40 && px < 500; i += 1) {
  await sleep(500);
  px = await colorful();
}
if (px < 500) throw new Error(`軸向格應有劑量顏色：${px}`);
await shot('dosecalc-loaded.png');
step(`軸向格有劑量顏色（${px} 個像素）`);

// 5. 英文
await send('Page.navigate', { url: url.replace('/#/', '/?lang=en#/') });
await waitFor(`document.querySelectorAll('.viewport-cell canvas').length >= 3 && !!document.querySelector('.plan-toggle button')`, '英文模式載入');
if (!(await evaluate(`!!${section}`))) await clickEl(`document.querySelector('.plan-toggle button')`);
await waitFor(`!!${section}?.querySelector('.plan-dosecalc-jobs > li')`, '英文模式的重算劑量', 20000);
const enText = await evaluate(`[${section}.innerText, ...[...${section}.querySelectorAll('[title],[aria-label]')].map((e) => (e.title || '') + ' ' + (e.getAttribute('aria-label') || ''))].join(' | ')`);
const cjk = enText.match(/[　-鿿＀-￯]+/g);
if (cjk) throw new Error(`英文模式還有中文：${cjk.join(' ')}`);
step('英文模式：重算劑量區塊沒有中文');

if (errors.length) throw new Error(`頁面例外：${errors.join(' | ')}`);
console.log('全部通過');
process.exit(0);
