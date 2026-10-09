#!/usr/bin/env node
/**
 * 沒存到後端的編輯可以處理 —— headless Chrome ＋ CDP（骨架同 `verify-temporal-compose.mjs`）。
 * 以前只說「請重畫一次，或重新載入本病例」。CDP `Fetch` 攔下 `/edit` 讓它網路失敗（模擬斷線）：
 *
 *   SYN4D-CT1：ROI 新建 SaveProbe（只在目前那一幀）→ 斷線 → 筆刷一筆 → 重試用盡後提示列一列「🔴「SaveProbe」（0%）有編輯沒有存到後端（已重試 4 次）」＋三個按鈕
 *   1.「跳到那一塊」：軸向格先捲到別片 → 按 → 回到畫的那一片
 *   2. 網路恢復 →「再送一次」→ 那一列消失、後端體積 > 0
 *   3. 再斷線、再畫一筆 →「放棄，取回後端版本」→「確定放棄」→ 那一列消失、後端體積不變（上一步存到的那份）
 *   結束時刪掉 SaveProbe。
 *
 *   scripts/perf/stack.sh start
 *   node scripts/verify-save-recovery.mjs --url http://127.0.0.1:5183/#/library
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
const url = args.url ?? 'http://127.0.0.1:5183/#/library';
const outDir = args['out-dir'] ?? null;
const port = Number(args.port ?? 9349);
const chrome = args.chrome ?? process.env.CHROME ?? 'google-chrome';
const token = args.token ?? process.env.TOKEN ?? null;
const origin = new URL(url).origin;

const profile = mkdtempSync(join(tmpdir(), 'rtgaia-save-recovery-'));
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
  await shot('save-recovery-failed.png').catch(() => undefined);
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

await send('Runtime.enable');
await send('Page.enable');
await send('Emulation.setDeviceMetricsOverride', { width: 1600, height: 1000, deviceScaleFactor: 1, mobile: false });
const initScript = await send('Page.addScriptToEvaluateOnNewDocument', { source: "try { if (!localStorage.getItem('rtgaia.lang')) localStorage.setItem('rtgaia.lang', 'zh-TW'); localStorage.setItem('rtgaia.tour.v1', 'done'); localStorage.setItem('rtgaia.layout.current.v1', '2x2'); localStorage.removeItem('rtgaia.dock.v1'); localStorage.removeItem('rtgaia.layout.trees.v1'); } catch {}" });
if (token) await send('Network.setCookie', { name: 'rtgaia_session', value: token, url: origin, httpOnly: true });

const rowWith = (kind, text) => `[...document.querySelectorAll('.catalog-tree tr[data-kind="${kind}"]')].find((r) => r.textContent.includes(${JSON.stringify(text)}))`;
const rowsWith = (kind, text) => `[...document.querySelectorAll('.catalog-tree tr[data-kind="${kind}"]')].filter((r) => r.textContent.includes(${JSON.stringify(text)}))`;
/** 資料頁：清空選取 → 展開病人 → 展開第一個描述含 `study` 的 study。 */
const openStudy = async (patientId, study, { reload = true } = {}) => {
  if (reload) await send('Page.navigate', { url: `${origin}/#/library` });
  else await evaluate(`[...document.querySelectorAll('button')].find((b) => b.textContent.trim() === '資料庫…').click(); true`);
  await waitFor(`!!${rowWith('patient', patientId)}`, `資料頁有 ${patientId}`, 60000);
  await evaluate(`[...document.querySelectorAll('button')].find((b) => b.textContent.trim() === '清空')?.click(); true`);
  await evaluate(`${rowWith('patient', patientId)}.click(); true`);
  await waitFor(`!!${rowWith('study', study)}`, `${patientId} 的 study「${study}」`);
  await evaluate(`${rowWith('study', study)}.click(); true`);
  await waitFor(`!!document.querySelector('.catalog-tree tr[data-kind="image"], .catalog-tree tr[data-kind="temporal"]')`, `${study} 的影像`);
  await sleep(500);
};
const summary = () => evaluate(`document.querySelector('.selection-summary')?.textContent.trim() ?? ''`);
const openCase = async (needTime = false) => {
  // 勾影像要先抓它的 RT 列才進選取（懶載入）→ 等摘要有主要影像再按開啟
  await waitFor(`document.querySelector('.selection-summary')?.textContent.includes('主要影像')`, '選取有主要影像', 20000);
  await evaluate(`[...document.querySelectorAll('button.primary')].find((b) => b.textContent.trim() === '開啟').click(); true`);
  await waitFor(`location.hash.includes('viewer') && document.querySelectorAll('.viewport-cell canvas').length >= 3${needTime ? " && !!document.querySelector('.time-group')" : ''}`, '病例開起來', 180000);
  await waitFor(`!document.querySelector('.mask-loading')`, '結構載入完', 120000);
  await sleep(1500);
};
const pageText = () => evaluate(`document.body.innerText`);
const structureCount = () => evaluate(`document.querySelectorAll('.structure-list li').length`);
/** 資料面板的「▸ 結構（…）」收合時清單不渲染 → 展開。 */
const expandStructures = () => evaluate(`(() => { const h = [...document.querySelectorAll('button, summary, span, div')].find((e) => e.children.length === 0 && /^▸ 結構（/.test(e.textContent.trim())); h?.click(); return !!h; })()`);


const rows = `[...document.querySelectorAll('.frame-group .image-row')]`;
const caseId = () => evaluate(`fetch('/api/v1/sessions/current').then((r) => r.json()).then((s) => s.caseId)`);
const studyId = () => evaluate(`fetch('/api/v1/sessions/current').then((r) => r.json()).then((s) => s.studyId)`);
/** 某一格 canvas 的指紋（取樣像素和）—— 比較兩張畫面是不是同一張。 */
const canvasSum = (label) => evaluate(`(() => { const c = ${cellSel(label)}?.querySelector('canvas'); const x = c?.getContext('2d'); if (!x) return -1; const d = x.getImageData(0, 0, c.width, c.height).data; let s = 0; for (let i = 0; i < d.length; i += 16) s += d[i]; return s; })()`);
const timeText = () => evaluate(`document.querySelector('.time-group .time-text')?.textContent.trim() ?? null`);
const clickButton = (scope, text) => evaluate(`(() => { const b = [...(${scope}).querySelectorAll('button')].find((x) => x.textContent.trim() === ${JSON.stringify(text)}); if (!b) return false; b.click(); return true; })()`);


let offline = false;
ws.addEventListener('message', (e) => {
  const m = JSON.parse(String(e.data));
  if (m.method === 'Fetch.requestPaused') {
    if (offline) void send('Fetch.failRequest', { requestId: m.params.requestId, errorReason: 'InternetDisconnected' });
    else void send('Fetch.continueRequest', { requestId: m.params.requestId });
  }
});
await send('Fetch.enable', { patterns: [{ urlPattern: '*/api/v1/structures/*/edit*', requestStage: 'Request' }] });

await openStudy('SYN4D-CT1', 'synth4d');
await waitFor(`!!${rowWith('temporal', '4D · 10 個相位')}`, 'SYN4D-CT1 的 4D 組');
await evaluate(`${rowWith('temporal', '4D · 10 個相位')}.querySelector('input[type=checkbox]').click(); true`);
await openCase(true);
const sid = await studyId();
const listed = (name) => evaluate(`fetch('/api/v1/studies/${sid}/structures').then((r) => r.json()).then((l) => (Array.isArray(l) ? l : l.structures ?? []).filter((x) => x.name === ${JSON.stringify(name)}))`);
for (const x of await listed('SaveProbe')) await evaluate(`fetch('/api/v1/structures/${x.structure_id}', { method: 'DELETE' }).then((r) => r.status)`);
await clickButton('document', 'ROI 編輯');
await waitFor(`!!document.querySelector('.roi-panel')`, 'ROI 編輯面板');
await clickButton(`document.querySelector('.roi-panel')`, '新建');
await waitFor(`!!document.querySelector('.roi-create .roi-name')`, '新建欄位');
await evaluate(`(() => { const el = document.querySelector('.roi-create .roi-name'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, 'SaveProbe'); el.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
await clickButton(`document.querySelector('.roi-create')`, '建立');
await waitFor(`!!document.querySelector('.roi-active')`, 'SaveProbe 作用中', 15000);
await sleep(1000);
const ac = await centerOf(`${cellSel('軸向')}.querySelector('canvas')`);
const stroke = async (dx = 0) => {
  await clickButton(`document.querySelector('.roi-panel')`, '筆刷');
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: ac.x + dx, y: ac.y, button: 'left', buttons: 1, clickCount: 1 });
  for (let i = 1; i <= 6; i += 1) {
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: ac.x + dx + i * 3, y: ac.y + i, buttons: 1, button: 'left' });
    await sleep(30);
  }
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: ac.x + dx + 18, y: ac.y + 6, button: 'left', buttons: 0, clickCount: 1 });
  await clickButton(`document.querySelector('.roi-panel')`, '筆刷');
};
const sliceOf = () => evaluate(`${cellSel('軸向')}.querySelector('.slice-index, .viewport-slice')?.textContent ?? [...${cellSel('軸向')}.querySelectorAll('span')].map((s) => s.textContent).find((x) => /^\\d+ \\/ \\d+$/.test(x.trim())) ?? null`);
const volume = async () => {
  const [x] = await listed('SaveProbe');
  return Array.isArray(x.volume_cc) ? x.volume_cc[0] : x.volume_cc;
};

offline = true;
const drawnAt = await sliceOf();
await stroke();
await waitFor(`!!document.querySelector('.unsaved-row')`, '重試用盡後提示列出現（約 2 秒）', 15000);
const rowText = await evaluate(`document.querySelector('.unsaved-row').textContent`);
if (!rowText.includes('SaveProbe') || !rowText.includes('0%')) throw new Error(`提示列：${rowText}`);
await shot('save-recovery-row.png');
step(`斷線時畫一筆 → 「${rowText.replace(/再送一次.*/, '').trim()}」＋ 三個按鈕`);

// 1
for (let i = 0; i < 5; i += 1) await send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: ac.x, y: ac.y, deltaX: 0, deltaY: 120 });
await sleep(500);
const moved = await sliceOf();
if (moved === drawnAt) throw new Error(`捲動之後切片沒變：${moved}`);
await clickButton(`document.querySelector('.unsaved-row')`, '跳到那一塊');
await sleep(500);
const back = await sliceOf();
if (back !== drawnAt) throw new Error(`跳到那一塊：應該回到 ${drawnAt}，現在 ${back}`);
step(`捲到 ${moved} →「跳到那一塊」→ 回到畫的那一片 ${back}`);

// 2
offline = false;
await clickButton(`document.querySelector('.unsaved-row')`, '再送一次');
await waitFor(`!document.querySelector('.unsaved-row')`, '再送一次之後那一列消失', 15000);
let v = 0;
for (let i = 0; i < 20 && !(v > 0); i += 1) {
  await sleep(250);
  v = await volume();
}
if (!(v > 0)) throw new Error(`再送一次之後後端體積應該 > 0：${v}`);
step(`網路恢復 →「再送一次」→ 存到了（後端 ${v.toFixed(3)} cc）`);

// 3
offline = true;
await stroke(40);
await waitFor(`!!document.querySelector('.unsaved-row')`, '第二筆也沒存到', 15000);
await clickButton(`document.querySelector('.unsaved-row')`, '放棄，取回後端版本');
await clickButton(`document.querySelector('.unsaved-row')`, '確定放棄');
await waitFor(`!document.querySelector('.unsaved-row')`, '放棄之後那一列消失', 10000);
offline = false;
await sleep(1500);
const v2 = await volume();
if (Math.abs(v2 - v) > 1e-9) throw new Error(`放棄之後後端體積應該不變：${v} → ${v2}`);
step(`再斷線畫一筆 →「放棄，取回後端版本」→ 那一列消失、後端仍是 ${v2.toFixed(3)} cc`);

await clickButton('document', 'ROI 編輯');
for (const x of await listed('SaveProbe')) await evaluate(`fetch('/api/v1/structures/${x.structure_id}', { method: 'DELETE' }).then((r) => r.status)`);
if (errors.length > 0) throw new Error(`頁面例外：${errors.join(' | ')}`);
console.log('全部通過');
process.exit(0);
