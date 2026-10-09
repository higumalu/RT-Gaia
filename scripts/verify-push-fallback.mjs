#!/usr/bin/env node
/**
 * 推送沒到也不會停在舊畫面 —— headless Chrome ＋ CDP（骨架同 `verify-temporal-compose.mjs`、零相依）。
 * 「推送沒到就自己拿」擴大到其他改病例的操作。
 *
 * 頁面載入前包一層 WebSocket：`window.__dropPush = true` 時收到的推送全部丟掉（連線還開著 —— 模擬推送掉了、不是斷線）。
 *   SYN4D-CT1：
 *   1. 丟推送 → ROI「新建」PushProbe → 左欄結構清單 6 秒內出現 PushProbe（layer.add 沒到，走 HTTP 拿場景）
 *   2. 丟推送 →「攤開成 3D」→ 左欄 8 秒內變 10 張（＋ AVG／MIP／MinIP）→「收回成 4D」→ 1 張（scene.replace 沒到）
 *   結束時刪掉 PushProbe、恢復推送。
 *
 *   scripts/perf/stack.sh start
 *   node scripts/verify-push-fallback.mjs --url http://127.0.0.1:5183/#/library [--out-dir DIR] [--token <rtgaia_session>]
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
const port = Number(args.port ?? 9346);
const chrome = args.chrome ?? process.env.CHROME ?? 'google-chrome';
const token = args.token ?? process.env.TOKEN ?? null;
const origin = new URL(url).origin;

const profile = mkdtempSync(join(tmpdir(), 'rtgaia-push-fallback-'));
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
  await shot('push-fallback-failed.png').catch(() => undefined);
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


// 推送掉了的模擬：頁面自己的 WebSocket 外面包一層；`window.__dropPush` 時收到的訊息不交給 onmessage
const DROP_SCRIPT = `(() => {
  const W = window.WebSocket;
  window.__rtgaiaSockets = [];
  window.__droppedCount = 0;
  window.WebSocket = class extends W {
    constructor(...a) {
      super(...a);
      window.__rtgaiaSockets.push(this);
      let handler = null;
      Object.defineProperty(this, 'onmessage', { configurable: true, get: () => handler, set: (fn) => { handler = fn; } });
      super.addEventListener('message', (e) => {
        if (window.__dropPush) { window.__droppedCount += 1; return; }
        if (handler) handler.call(this, e);
      });
    }
  };
})();`;
await send('Runtime.enable');
await send('Page.enable');
await send('Emulation.setDeviceMetricsOverride', { width: 1600, height: 1000, deviceScaleFactor: 1, mobile: false });
await send('Page.addScriptToEvaluateOnNewDocument', { source: DROP_SCRIPT });
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


const sid = await (async () => {
  await openStudy('SYN4D-CT1', 'synth4d');
  await waitFor(`!!${rowWith('temporal', '4D · 10 個相位')}`, 'SYN4D-CT1 的 4D 組');
  await evaluate(`${rowWith('temporal', '4D · 10 個相位')}.querySelector('input[type=checkbox]').click(); true`);
  await openCase(true);
  return studyId();
})();
const listed = (name) => evaluate(`fetch('/api/v1/studies/${sid}/structures').then((r) => r.json()).then((l) => (Array.isArray(l) ? l : l.structures ?? []).filter((x) => x.name === ${JSON.stringify(name)}).map((x) => x.structure_id))`);
for (const id of await listed('PushProbe')) await evaluate(`fetch('/api/v1/structures/${id}', { method: 'DELETE' }).then((r) => r.status)`);
if (await evaluate(`!!document.querySelector('.time-group.is-expanded')`)) {
  await clickButton(`document.querySelector('.time-group')`, '收回成 4D');
  await waitFor(`!document.querySelector('.time-group.is-expanded')`, '收回上一輪的攤開', 30000);
}
await sleep(1000);
if (!(await evaluate(`Array.isArray(window.__rtgaiaSockets) && window.__rtgaiaSockets.length > 0`))) throw new Error('WebSocket 沒包到');

// 1
await expandStructures();
await evaluate(`window.__dropPush = true; true`);
await clickButton('document', 'ROI 編輯');
await waitFor(`!!document.querySelector('.roi-panel')`, 'ROI 編輯面板');
await clickButton(`document.querySelector('.roi-panel')`, '新建');
await waitFor(`!!document.querySelector('.roi-create .roi-name')`, '新建欄位');
await evaluate(`(() => { const el = document.querySelector('.roi-create .roi-name'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, 'PushProbe'); el.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
const t1 = Date.now();
await clickButton(`document.querySelector('.roi-create')`, '建立');
await waitFor(`[...document.querySelectorAll('.structure-list li')].some((li) => li.textContent.includes('PushProbe'))`, '推送掉了，左欄仍出現 PushProbe', 6000);
const dropped1 = await evaluate(`window.__droppedCount ?? 0`);
if (dropped1 < 1) throw new Error('應該至少丟掉一則推送（layer.add）');
step(`丟推送時新建 PushProbe → ${((Date.now() - t1) / 1000).toFixed(1)} s 後左欄出現（丟掉 ${dropped1} 則推送，走 HTTP 拿場景）`);
await clickButton('document', 'ROI 編輯');

// 2
const before2 = await evaluate(`window.__droppedCount ?? 0`);
const t2 = Date.now();
await clickButton(`document.querySelector('.time-group')`, '攤開成 3D');
// CT1 同一組還有 AVG／MIP／MinIP 三張靜態影像 → 攤開後 10 ＋ 3 列
await waitFor(`${rows}.length === 13 && !!document.querySelector('.time-group.is-expanded')`, '推送掉了，仍攤開成 10 張', 8000);
if ((await evaluate(`window.__droppedCount ?? 0`)) <= before2) throw new Error('攤開時應該丟掉 scene.replace');
const s2 = ((Date.now() - t2) / 1000).toFixed(1);
await clickButton(`document.querySelector('.time-group')`, '收回成 4D');
await waitFor(`${rows}.length === 4 && !document.querySelector('.time-group.is-expanded')`, '推送掉了，仍收回成 1 張', 8000);
step(`丟推送時攤開成 3D → ${s2} s 後左欄 10 張；收回 → 1 張`);

await evaluate(`window.__dropPush = false; true`);
for (const id of await listed('PushProbe')) await evaluate(`fetch('/api/v1/structures/${id}', { method: 'DELETE' }).then((r) => r.status)`);

if (errors.length > 0) throw new Error(`頁面例外：${errors.join(' | ')}`);
console.log('全部通過');
process.exit(0);
