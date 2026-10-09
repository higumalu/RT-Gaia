#!/usr/bin/env node
/**
 * BEV／MLC ＋ 控制點時間軸 —— headless Chrome ＋ CDP（骨架同 `verify-plan-panel.mjs`、零相依），真的滑鼠／鍵盤事件：
 *
 *   計畫面板內嵌 BEV：預設第一個治療射束、CP 1 / 180、機架 179°、雙層 MLC（MLCX1／MLCX2）
 *   ▶| 下一個 → CP 2、讀數有 MU/°；拖到最後 → CP 180、機架 180.1°、182.6 / 182.6 MU
 *   開口（黃）畫得出來、面積 > 0；在圖上滾輪 → 下一個 CP；播放 1 秒（30 CP/秒）→ 前進 ≥ 10 個 CP
 *   MLC 分開 → 兩張圖（MLCX1、MLCX2）；放到格子 → 格子裡有 BEV、面板只剩「取回」；取回
 *   英文模式沒有中文
 *
 * 需要一個開著量測病例（`.rtgaia/perf/case.json`，要有 RTPLAN 與劑量）的堆疊：
 *   scripts/perf/stack.sh start && scripts/perf/stack.sh load
 *   node scripts/verify-plan-bev.mjs --url http://127.0.0.1:5183/#/viewer [--out-dir DIR]
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

const profile = mkdtempSync(join(tmpdir(), 'rtgaia-plan23b-'));
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
  await shot('plan23b-failed.png').catch(() => undefined);
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
// 從截圖數黃色（開口）像素：canvas 是 2D，但直接截圖最接近使用者看到的
const yellowIn = async (expr) => {
  const r = await evaluate(`(() => { const b = (${expr}).getBoundingClientRect(); return { x: b.left, y: b.top, width: b.width, height: b.height }; })()`);
  const { data } = await send('Page.captureScreenshot', { format: 'png', clip: { ...r, scale: 1 } });
  return evaluate(`new Promise((resolve) => { const img = new Image(); img.onload = () => { const c = document.createElement('canvas'); c.width = img.width; c.height = img.height; const g = c.getContext('2d'); g.drawImage(img, 0, 0); const d = g.getImageData(0, 0, c.width, c.height).data; let n = 0; for (let i = 0; i < d.length; i += 4) if (d[i] > 90 && d[i + 1] > 80 && d[i + 2] < d[i] * 0.75 && Math.abs(d[i] - d[i + 1]) < 60) n += 1; resolve(n); }; img.src = 'data:image/png;base64,${data}'; })`);
};

await send('Runtime.enable');
await send('Page.enable');
await send('Emulation.setDeviceMetricsOverride', { width: 1600, height: 1000, deviceScaleFactor: 1, mobile: false });
await send('Page.addScriptToEvaluateOnNewDocument', { source: "try { if (!localStorage.getItem('rtgaia.lang')) localStorage.setItem('rtgaia.lang', 'zh-TW'); localStorage.setItem('rtgaia.tour.v1', 'done'); localStorage.setItem('rtgaia.layout.current.v1', '2x2'); localStorage.removeItem('rtgaia.dock.v1'); localStorage.removeItem('rtgaia.layout.trees.v1'); } catch {}" });
if (token) await send('Network.setCookie', { name: 'rtgaia_session', value: token, url: origin, httpOnly: true });
await send('Page.navigate', { url });
await waitFor(`document.querySelectorAll('.viewport-cell canvas').length >= 3 && !!document.querySelector('.plan-toggle button')`, '病例載入（要有 RTPLAN）');
await waitFor(`!document.querySelector('.mask-loading')`, '載入完', 60000);
await sleep(800);

// 1. 計畫面板內嵌 BEV
await clickEl(`document.querySelector('.plan-toggle button')`);
await waitFor(`/CP 1 \\/ 180/.test(${bev}?.querySelector('.bev-readout')?.textContent ?? '')`, 'BEV 讀數 CP 1 / 180', 30000);
// DRR 預設開；這支測 BEV 的幾何（開口黃色像素），先關掉 DRR —— DRR 本身由 verify-plan-drr.mjs 測
await evaluate(`(() => { const box = [...${bev}.querySelectorAll('.bev-drr-row label')].find((l) => l.textContent.trim().startsWith('DRR'))?.querySelector('input'); if (box && box.checked) box.click(); return true; })()`);
await sleep(300);
const r1 = await readout();
if (!/機架 179°/.test(r1)) throw new Error(`第一個 CP 的機架應是 179°：${r1}`);
const mlcOpts = await evaluate(`[...${bev}.querySelectorAll('.bev-toolbar select')].map((s) => [...s.options].map((o) => o.value))`);
if (!mlcOpts.some((o) => o.includes('split'))) throw new Error(`雙層 MLC 應有疊合／分開：${JSON.stringify(mlcOpts)}`);
await shot('plan23b-bev.png');
step(`內嵌 BEV：${r1}`);

// 2. 下一個 → CP 2；MU/°
await clickEl(`[...${bev}.querySelectorAll('.bev-timeline button')][3]`);
await sleep(300);
const r2 = await readout();
if (cpOf(r2) !== 2 || !/MU\/°/.test(r2)) throw new Error(`下一個應到 CP 2 且有 MU/°：${r2}`);
step(`▶| → ${r2}`);

// 3. 拖到最後
await setValue(`${bev}.querySelector('.bev-slider')`, 179);
await sleep(300);
const r3 = await readout();
if (cpOf(r3) !== 180 || !/機架 180\.1°/.test(r3) || !/182\.6 \/ 182\.6 MU/.test(r3)) throw new Error(`最後一個 CP：${r3}`);
step(`最後：${r3}`);

// 4. 開口畫得出來（中間的 CP）
await setValue(`${bev}.querySelector('.bev-slider')`, 90);
await sleep(500);
const area = Number(await evaluate(`${bev}.querySelector('.bev-canvas').dataset.areaCm2`));
const yellow = await yellowIn(`${bev}.querySelector('.bev-canvas')`);
if (!(area > 0) || yellow < 100) throw new Error(`CP 91 的開口：面積 ${area} cm²、黃色像素 ${yellow}`);
await shot('plan23b-aperture.png');
step(`CP 91 開口 ${area} cm²、黃色像素 ${yellow}`);

// 5. 滾輪 → 下一個
const c = await centerOf(`${bev}.querySelector('.bev-canvas')`);
await send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: c.x, y: c.y, deltaX: 0, deltaY: 100 });
await sleep(300);
const r5 = await readout();
if (cpOf(r5) !== 92) throw new Error(`滾輪應前進一個 CP（91 → 92）：${r5}`);
step(`滾輪 → CP ${cpOf(r5)}`);

// 6. 播放 1 秒（30 CP/秒）
await setValue(`${bev}.querySelector('.bev-timeline select')`, 30, 'change');
await setValue(`${bev}.querySelector('.bev-slider')`, 0);
await sleep(200);
await clickEl(`${bev}.querySelector('.bev-play')`);
await sleep(1000);
await clickEl(`${bev}.querySelector('.bev-play')`);
await sleep(300);
const r6 = await readout();
if (!(cpOf(r6) >= 11)) throw new Error(`播放 1 秒應前進 ≥ 10 個 CP：${r6}`);
step(`播放 1 秒 → CP ${cpOf(r6)}`);

// 7. MLC 分開
await setValue(`[...${bev}.querySelectorAll('.bev-toolbar select')].find((s) => [...s.options].some((o) => o.value === 'split'))`, 'split', 'change');
await waitFor(`${bev}.querySelectorAll('.bev-canvas').length === 2`, 'MLC 分開 → 兩張圖', 10000);
await sleep(400);
const areas = await evaluate(`[...${bev}.querySelectorAll('.bev-canvas')].map((c) => Number(c.dataset.areaCm2))`);
await shot('plan23b-split.png');
await setValue(`[...${bev}.querySelectorAll('.bev-toolbar select')].find((s) => [...s.options].some((o) => o.value === 'split'))`, 'overlay', 'change');
step(`MLC 分開：兩層開口 ${areas.join(' / ')} cm²`);

// 8. 放到格子 → 取回
await clickEl(`[...document.querySelectorAll('.plan-bev .slab-header button')].find((b) => /放到格子/.test(b.textContent))`);
await waitFor(`!!document.querySelector('.viewport-cell .bev-view, .layout-cell .bev-view') && !document.querySelector('.plan-bev-embedded')`, 'BEV 進格子', 10000);
await shot('plan23b-cell.png');
await clickEl(`[...document.querySelectorAll('.plan-bev .slab-header button')].find((b) => /取回/.test(b.textContent))`);
await waitFor(`!!document.querySelector('.plan-bev-embedded .bev-view')`, 'BEV 回到面板', 10000);
step('放到格子 → 格子裡有 BEV；取回 → 回到面板');

// 9. 英文模式
await send('Page.navigate', { url: url.replace('/#/', '/?lang=en#/') });
await waitFor(`document.querySelectorAll('.viewport-cell canvas').length >= 3 && !!document.querySelector('.plan-toggle button')`, '英文模式載入');
if (!(await evaluate(`!!document.querySelector('.plan-panel')`))) await evaluate(`document.querySelector('.plan-toggle button').click(); true`);
await waitFor(`/CP 1 \\/ 180/.test(document.querySelector('.plan-bev-embedded .bev-readout')?.textContent ?? '')`, '英文模式的 BEV', 30000);
const enText = await evaluate(`[document.querySelector('.plan-bev').innerText, ...[...document.querySelectorAll('.plan-bev [title], .plan-bev [aria-label]')].map((e) => (e.title || '') + ' ' + (e.getAttribute('aria-label') || ''))].join(' | ')`);
const cjk = enText.match(/[　-鿿＀-￯]+/g);
if (cjk) throw new Error(`英文模式還有中文：${cjk.join(' ')}`);
step('英文模式：BEV 沒有中文');

if (errors.length) throw new Error(`頁面例外：${errors.join(' | ')}`);
console.log('全部通過');
process.exit(0);
