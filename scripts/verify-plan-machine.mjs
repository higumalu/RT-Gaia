#!/usr/bin/env node
/**
 * 機架／治療床示意 —— headless Chrome ＋ CDP（骨架同 `verify-plan-panel.mjs`、零相依）：
 *
 *   計畫面板的 BEV 下面有示意圖（機型跟治療機一致：Halcyon／Ethos 是環型機，其他是 C 臂）、讀數 HFS
 *   拖到不同 CP → 示意圖的機架角跟著變（canvas 的 data-gantry ＝ 讀數的機架角），畫面也真的變了（截圖像素差）
 *   「機架示意」關掉 → 示意圖消失；打開 → 回來
 *   英文模式沒有中文
 *
 * 需要一個開著量測病例（`.rtgaia/perf/case.json`，要有 RTPLAN 與劑量）的堆疊：
 *   scripts/perf/stack.sh start && scripts/perf/stack.sh load
 *   node scripts/verify-plan-machine.mjs --url http://127.0.0.1:5183/#/viewer [--out-dir DIR]
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
const port = Number(args.port ?? 9345);
const chrome = args.chrome ?? process.env.CHROME ?? 'google-chrome';
const token = args.token ?? process.env.TOKEN ?? null;
const origin = new URL(url).origin;

const profile = mkdtempSync(join(tmpdir(), 'rtgaia-plan23e-'));
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
  await shot('plan23e-failed.png').catch(() => undefined);
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
await send('Page.addScriptToEvaluateOnNewDocument', { source: "try { if (!localStorage.getItem('rtgaia.lang')) localStorage.setItem('rtgaia.lang', 'zh-TW'); localStorage.setItem('rtgaia.tour.v1', 'done'); localStorage.setItem('rtgaia.layout.current.v1', '2x2'); localStorage.removeItem('rtgaia.dock.v1'); localStorage.removeItem('rtgaia.layout.trees.v1'); } catch {}" });
if (token) await send('Network.setCookie', { name: 'rtgaia_session', value: token, url: origin, httpOnly: true });
await send('Page.navigate', { url });
await waitFor(`document.querySelectorAll('.viewport-cell canvas').length >= 3 && !!document.querySelector('.plan-toggle button')`, '病例載入（要有 RTPLAN → 工具列「計畫」）');
await waitFor(`!document.querySelector('.mask-loading')`, '載入完', 60000);
await sleep(1200);
const setValue = (selector, value, kind = 'input') =>
  evaluate(`(() => { const el = ${selector}; const proto = el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype; Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, ${JSON.stringify(String(value))}); el.dispatchEvent(new Event(${JSON.stringify(kind)}, { bubbles: true })); return true; })()`);
const clickEl = async (expr) => {
  await evaluate(`(${expr}).scrollIntoView({ block: 'center' }); true`);
  const c = await centerOf(expr);
  await clickAt(c.x, c.y);
};
const bev = `document.querySelector('.plan-bev-embedded .bev-view')`;
const readout = () => evaluate(`${bev}.querySelector('.bev-readout')?.textContent ?? ''`);
const cpOf = (text) => Number((text.match(/CP (\d+) \//) ?? [])[1]);
const sketch = `document.querySelector('.plan-bev-embedded .machine-sketch')`;
const shotOf = async (expr) => {
  await evaluate(`(${expr}).scrollIntoView({ block: 'center' }); true`);
  await sleep(200);
  const r = await evaluate(`(() => { const b = (${expr}).getBoundingClientRect(); return { x: b.left, y: b.top, width: b.width, height: b.height }; })()`);
  return (await send('Page.captureScreenshot', { format: 'png', clip: { ...r, scale: 1 } })).data;
};

await send('Runtime.enable');
await send('Page.enable');
await send('Emulation.setDeviceMetricsOverride', { width: 1600, height: 1000, deviceScaleFactor: 1, mobile: false });
await send('Page.addScriptToEvaluateOnNewDocument', { source: "try { if (!localStorage.getItem('rtgaia.lang')) localStorage.setItem('rtgaia.lang', 'zh-TW'); localStorage.setItem('rtgaia.tour.v1', 'done'); localStorage.setItem('rtgaia.layout.current.v1', '2x2'); localStorage.removeItem('rtgaia.dock.v1'); localStorage.removeItem('rtgaia.layout.trees.v1'); } catch {}" });
if (token) await send('Network.setCookie', { name: 'rtgaia_session', value: token, url: origin, httpOnly: true });
await send('Page.navigate', { url });
await waitFor(`document.querySelectorAll('.viewport-cell canvas').length >= 3 && !!document.querySelector('.plan-toggle button')`, '病例載入（要有 RTPLAN）');
await waitFor(`!document.querySelector('.mask-loading')`, '載入完', 60000);
await clickEl(`document.querySelector('.plan-toggle button')`);
await waitFor(`!!${sketch}?.querySelector('canvas')`, 'BEV 下面的機架示意', 30000);
await sleep(500);

// 1. 環型機、HFS
const kindText = await evaluate(`${sketch}.title + ' | ' + ${sketch}.nextElementSibling?.textContent`);
const plan0 = await evaluate(`fetch('/api/v1/sessions/current').then((r) => r.json()).then((s) => fetch('/api/v1/studies/' + encodeURIComponent(s.studyId) + '/plans')).then((r) => r.json()).then((d) => d.plans[0])`);
const ring = plan0.machines.some((m) => /halcyon|ethos/i.test(`${m.name} ${m.model}`) || /^(hal|eth)/i.test(m.name.trim()));
if (!(ring ? /環型機/ : /C 臂/).test(kindText) || !/HFS/.test(kindText)) throw new Error(`機型應是${ring ? '環型機' : 'C 臂'}、HFS：${kindText}`);
step(`機型：${kindText}`);

// 2. 跟著 CP
const gantryOf = () => evaluate(`Number(${sketch}.querySelector('canvas').dataset.gantry)`);
const g0 = await gantryOf();
const img0 = await shotOf(sketch);
await setValue(`${bev}.querySelector('.bev-slider')`, 45);
await sleep(500);
const g45 = await gantryOf();
const img45 = await shotOf(sketch);
const readGantry = Number((((await readout()).match(/機架 ([\d.]+)°/) ?? [])[1]));
if (g45 === g0 || Math.abs(g45 - readGantry) > 0.05) throw new Error(`示意圖的機架角應跟著讀數：CP1 ${g0}、CP46 ${g45}、讀數 ${readGantry}`);
if (img0 === img45) throw new Error('換了 CP，示意圖的畫面沒變');
await shot('plan23e-sketch.png');
step(`機架角跟著 CP：${g0}° → ${g45}°（讀數 ${readGantry}°），畫面有變`);

// 3. 關掉／打開
const box = `[...${bev}.querySelectorAll('.bev-toolbar label')].find((l) => /機架示意/.test(l.textContent)).querySelector('input')`;
await clickEl(box);
await waitFor(`!${sketch}`, '關掉後示意圖消失', 5000);
await clickEl(box);
await waitFor(`!!${sketch}?.querySelector('canvas')`, '打開後示意圖回來', 5000);
step('「機架示意」關掉 → 消失；打開 → 回來');

// 4. 英文模式
await send('Page.navigate', { url: url.replace('/#/', '/?lang=en#/') });
await waitFor(`document.querySelectorAll('.viewport-cell canvas').length >= 3 && !!document.querySelector('.plan-toggle button')`, '英文模式載入');
if (!(await evaluate(`!!document.querySelector('.plan-panel')`))) await evaluate(`document.querySelector('.plan-toggle button').click(); true`);
await waitFor(`!!${sketch}?.querySelector('canvas')`, '英文模式的示意圖', 30000);
const enText = await evaluate(`[${sketch}.title, ${sketch}.nextElementSibling?.textContent ?? '', ...[...${bev}.querySelectorAll('.bev-toolbar label')].map((l) => l.textContent + ' ' + (l.title || ''))].join(' | ')`);
const cjk = enText.match(/[　-鿿＀-￯]+/g);
if (cjk) throw new Error(`英文模式還有中文：${cjk.join(' ')}`);
step('英文模式：示意圖與開關沒有中文');

if (errors.length) throw new Error(`頁面例外：${errors.join(' | ')}`);
console.log('全部通過');
process.exit(0);
