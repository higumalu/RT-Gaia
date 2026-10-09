#!/usr/bin/env node
/**
 * 面積量測工具的瀏覽器重現腳本（2026-09-16 「面積量測工具無法使用」）—— headless Chrome ＋ CDP，零相依（Node ≥ 22）。
 * 對著跑起來的 dev server 開檢視器、選「面積」、在一格點四個頂點、再用指定方式收口，逐步印出 SVG 裡的量測形狀／把手／標籤。
 *
 * 用法：
 *   TOKEN=<rtgaia_session cookie 值> node scripts/area-tool-repro.mjs
 * env：URL（預設 http://127.0.0.1:5173/#/viewer）、PORT（CDP 埠）、DPR（deviceScaleFactor）、JITTER（按下到放開的位移 px）、
 *      VIEWPORT（axial|coronal|sagittal）、CLOSE（click＝點回起點｜snap＝靠近起點看吸附再點｜dbl＝雙擊最後頂點｜dblnew＝雙擊新位置｜enter＝按 Enter）、DRAG=1（先拖第二個草稿頂點）、EDIT=1（收口後走面板編輯頂點）
 * token 可用後端 `make_token(user_id, load_secret())` 產生（見 `packages/rtgaia-testbe/src/rtgaia_testbe/auth.py`）。
 *
 * 這不是自動測試（要有 server 與資料）；它是找到根因的工具，留下來給下次「畫面上看起來壞了」用。
 */
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const url = process.env.URL ?? 'http://127.0.0.1:5173/#/viewer';
const token = process.env.TOKEN;
const port = Number(process.env.PORT ?? 9345);
const dpr = Number(process.env.DPR ?? 1);
const jitter = Number(process.env.JITTER ?? 0);
const vpWant = process.env.VIEWPORT ?? 'axial';
const closeMode = process.env.CLOSE ?? 'click';
const profile = mkdtempSync(join(tmpdir(), 'rtgaia-area-'));
const proc = spawn('google-chrome', ['--headless=new', '--no-sandbox', '--password-store=basic', '--disable-gpu', '--hide-scrollbars', '--window-size=1600,1000', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, 'about:blank'], { stdio: 'ignore' });
process.on('exit', () => { try { proc.kill('SIGKILL'); } catch {} });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let targets = null;
for (let i = 0; i < 100 && targets === null; i += 1) { try { targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json(); } catch { await sleep(100); } }
const page = targets.find((t) => t.type === 'page') ?? targets[0];
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
let seq = 0; const pending = new Map(); const log = [];
ws.onmessage = (ev) => {
  const msg = JSON.parse(String(ev.data));
  if (msg.id !== undefined && pending.has(msg.id)) { const { resolve, reject } = pending.get(msg.id); pending.delete(msg.id); msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result); }
  else if (msg.method === 'Runtime.consoleAPICalled') log.push(`[${msg.params.type}] ${msg.params.args.map((a) => a.value ?? a.description ?? '').join(' ')}`);
  else if (msg.method === 'Runtime.exceptionThrown') log.push(`[exception] ${msg.params.exceptionDetails.text} ${msg.params.exceptionDetails.exception?.description ?? ''}`);
};
const send = (method, params = {}) => new Promise((resolve, reject) => { const id = ++seq; pending.set(id, { resolve, reject }); ws.send(JSON.stringify({ id, method, params })); });
const evaluate = async (expression) => { const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }); if (r.exceptionDetails) throw new Error(r.exceptionDetails.text + ' ' + (r.exceptionDetails.exception?.description ?? '')); return r.result.value; };
const until = async (expr, ms = 30000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await evaluate(expr)) return true; await sleep(250); } throw new Error('timeout: ' + expr); };

await send('Runtime.enable'); await send('Page.enable'); await send('Network.enable');
await send('Page.addScriptToEvaluateOnNewDocument', { source: "try { if (!localStorage.getItem('rtgaia.lang')) localStorage.setItem('rtgaia.lang', 'zh-TW'); } catch {}" }); // 選擇器是中文字樣；介面預設英文
await send('Emulation.setDeviceMetricsOverride', { width: 1600, height: 1000, deviceScaleFactor: dpr, mobile: false });
if (token) await send('Network.setCookie', { name: 'rtgaia_session', value: token, url: 'http://127.0.0.1:5173/' });
await send('Page.navigate', { url });
await until(`document.querySelector('.viewport[data-viewport-id] canvas') !== null`, 60000);
await sleep(4000);
const clickTool = async (text) => evaluate(`(() => { const b = [...document.querySelectorAll('.toolbar button')].find(b => b.textContent.trim().endsWith(${JSON.stringify(text)})); if (!b) return false; b.click(); return true; })()`);
// 量測工具只在「量測」模式開著時列在工具列 → 先按任務列的量測開關
console.log('量測 mode:', await evaluate(`(() => { const b = document.querySelector('.measure-toggle button'); if (!b) return 'no toggle'; if (b.getAttribute('aria-pressed') !== 'true') b.click(); return true; })()`));
await sleep(400);
console.log('toolbar:', await evaluate(`[...document.querySelectorAll('.toolbar button')].map(b => b.textContent.trim())`));
console.log('面積 button:', await clickTool('面積'));
await sleep(400);
console.log('active tool:', await evaluate(`[...document.querySelectorAll('.toolbar button[aria-pressed="true"]')].map(b => b.textContent.trim())`));
const rect = await evaluate(`(() => { const v = document.querySelector('.viewport[data-viewport-id=${JSON.stringify(vpWant)}]'); const r = v.getBoundingClientRect(); return { id: v.dataset.viewportId, x: r.left, y: r.top, w: r.width, h: r.height }; })()`);
console.log('viewport', rect, 'dpr', dpr, 'jitter', jitter, 'close', closeMode);
const observe = () => evaluate(`(() => { const s = document.querySelector('.viewport[data-viewport-id="${rect.id}"] svg'); if (!s) return 'no svg';
  const shapes = [...s.querySelectorAll('polyline.rt-measure-area, polygon.rt-measure-area')].filter(p => !p.classList.contains('rt-measure-section'));
  const lasso = s.querySelector('.rt-lasso');
  return { shapes: shapes.map(p => p.tagName + (p.classList.contains('selected') ? '*' : '') + ':' + (p.getAttribute('points') || '').split(' ').length), knobs: s.querySelectorAll('.rt-measure-knob').length, draftKnobs: s.querySelectorAll('.rt-measure-knob.draft').length, buttons: [...s.querySelectorAll('circle.rt-measure-btn')].map(b => b.getAttribute('data-action')), lasso: lasso && lasso.style.display !== 'none' ? (lasso.getAttribute('points') || '').split(' ').length : 0, labels: [...s.querySelectorAll('text.rt-measure-label')].map(t => t.textContent) }; })()`);
const mouse = async (type, x, y, extra = {}) => send('Input.dispatchMouseEvent', { type, x, y, ...extra });
const click = async (fx, fy, count = 1) => {
  const x = rect.x + rect.w * fx, y = rect.y + rect.h * fy;
  await mouse('mouseMoved', x, y);
  await mouse('mousePressed', x, y, { button: 'left', clickCount: count });
  await sleep(50);
  if (jitter > 0) { await mouse('mouseMoved', x + jitter, y + jitter, { button: 'left', buttons: 1 }); await sleep(20); }
  await mouse('mouseReleased', x + jitter, y + jitter, { button: 'left', clickCount: count });
  await sleep(150);
};
const pts = [[0.4, 0.4], [0.6, 0.4], [0.6, 0.6], [0.4, 0.6]];
console.log('before:', JSON.stringify(await observe()));
for (const [fx, fy] of pts) {
  await click(fx, fy);
  // hover 一下：橡皮筋要出來
  await mouse('mouseMoved', rect.x + rect.w * 0.5, rect.y + rect.h * 0.5); await sleep(80);
  console.log(`click ${fx},${fy} + hover →`, JSON.stringify(await observe()));
}
if (process.env.DRAG === '1') {
  // 拖第二個草稿頂點（0.6,0.4）往右下 30px
  const x = rect.x + rect.w * 0.6, y = rect.y + rect.h * 0.4;
  await mouse('mouseMoved', x, y); await mouse('mousePressed', x, y, { button: 'left', clickCount: 1 }); await sleep(40);
  for (let i = 1; i <= 3; i += 1) { await mouse('mouseMoved', x + 10 * i, y + 10 * i, { button: 'left', buttons: 1 }); await sleep(20); }
  await mouse('mouseReleased', x + 30, y + 30, { button: 'left', clickCount: 1 }); await sleep(150);
  console.log('after drag vertex 2 →', JSON.stringify(await observe()));
}
if (closeMode === 'enter') {
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
  await sleep(300);
  console.log('focused:', await evaluate(`(document.activeElement?.className ?? '') + ' ' + (document.activeElement?.dataset?.viewportId ?? '')`));
} else if (closeMode === 'dblnew') {
  // 雙擊一個新位置：第一下＝最後頂點，第二下（detail 2）收口
  await click(0.5, 0.7, 1);
  const x = rect.x + rect.w * 0.5, y = rect.y + rect.h * 0.7;
  await mouse('mousePressed', x, y, { button: 'left', clickCount: 2 }); await sleep(40); await mouse('mouseReleased', x, y, { button: 'left', clickCount: 2 }); await sleep(200);
} else if (closeMode === 'snap') {
  // 游標移到起點旁 5px → 起點應放大（highlight），橡皮筋只剩 2 點；再點下去收口
  await mouse('mouseMoved', rect.x + rect.w * 0.4 + 5, rect.y + rect.h * 0.4 + 3); await sleep(120);
  console.log('near start →', JSON.stringify(await evaluate(`(() => { const s = document.querySelector('.viewport[data-viewport-id="${rect.id}"] svg'); return { highlight: s.querySelectorAll('.rt-measure-knob.highlight').length, lasso: (s.querySelector('.rt-lasso')?.getAttribute('points') || '').split(' ').length }; })()`)));
  await click(0.4, 0.4);
} else if (closeMode === 'dbl') {
  await click(0.4, 0.6, 2);
} else if (closeMode === 'last') {
  await click(0.4, 0.6, 1);
} else {
  await click(0.4, 0.4);
}
console.log('after close →', JSON.stringify(await observe()));
if (process.env.EDIT === '1') {
  // 面板：開量測面板 → 列上 ✎ → 畫面上頂點（黃）可拖（面積工具仍作用中）→ 清單插入／刪除 → 完成
  await evaluate(`(() => { const b = document.querySelector('.measure-toggle button'); if (b && b.getAttribute('aria-pressed') !== 'true') b.click(); })()`); await sleep(400);
  console.log('edit button:', await evaluate(`(() => { const b = document.querySelector('.measure-table button.measure-edit-vertices'); if (!b) return false; b.click(); return true; })()`)); await sleep(300);
  console.log('editing →', JSON.stringify(await observe()), 'rows:', await evaluate(`document.querySelectorAll('.vertex-table tbody tr').length`));
  Object.assign(rect, await evaluate(`(() => { const r = document.querySelector('.viewport[data-viewport-id="${rect.id}"]').getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }; })()`));
  // 拖第 1 個頂點往左上 20px —— 面板打開後版面變了，頂點位置要從 SVG 重新讀（viewBox → CSS）
  const knob = await evaluate(`(() => { const svg = document.querySelector('.viewport[data-viewport-id="${rect.id}"] svg'); const k = svg && svg.querySelector('circle.rt-measure-knob.editing[data-index="0"]'); if (!k) return null; const vb = svg.viewBox.baseVal; const r = svg.getBoundingClientRect(); return { x: r.left + Number(k.getAttribute('cx')) * r.width / vb.width, y: r.top + Number(k.getAttribute('cy')) * r.height / vb.height }; })()`);
  console.log('knob 0 at:', knob);
  const kx = knob.x, ky = knob.y;
  await mouse('mouseMoved', kx, ky); await mouse('mousePressed', kx, ky, { button: 'left', clickCount: 1 }); await sleep(40);
  for (let i = 1; i <= 2; i += 1) { await mouse('mouseMoved', kx - 10 * i, ky - 10 * i, { button: 'left', buttons: 1 }); await sleep(20); }
  await mouse('mouseReleased', kx - 20, ky - 20, { button: 'left', clickCount: 1 }); await sleep(200);
  console.log('after drag in edit →', JSON.stringify(await observe()));
  // 點空白不該開新多邊形
  await click(0.8, 0.8); console.log('click empty in edit →', JSON.stringify(await observe()));
  // 清單：在第 1 點後插入、刪第 2 點
  await evaluate(`document.querySelector('.vertex-table tbody tr:nth-child(1) .vertex-actions button:nth-child(1)').click()`); await sleep(150);
  console.log('after insert →', 'rows:', await evaluate(`document.querySelectorAll('.vertex-table tbody tr').length`), JSON.stringify(await observe()));
  await evaluate(`document.querySelector('.vertex-table tbody tr:nth-child(2) .vertex-actions button:nth-child(2)').click()`); await sleep(150);
  console.log('after delete →', 'rows:', await evaluate(`document.querySelectorAll('.vertex-table tbody tr').length`), JSON.stringify(await observe()));
  await evaluate(`[...document.querySelectorAll('.vertex-editor button')].find(b => b.textContent.trim() === '完成').click()`); await sleep(300);
  console.log('after 完成 →', JSON.stringify(await observe()), 'editor open:', await evaluate(`document.querySelector('.vertex-editor') !== null`));
}
console.log('--- console ---'); for (const l of log.filter((l) => !l.startsWith('[debug]') && !l.includes('DevTools'))) console.log(l);
process.exit(0);
