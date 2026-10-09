#!/usr/bin/env node
/**
 * 3D 射束 ＋ 2D 弧刻度 —— headless Chrome ＋ CDP（骨架同 `verify-plan-panel.mjs`、零相依），真的滑鼠事件：
 *
 *   3D 格右下角出現小 BEV（跟著計畫面板的射束與 CP）
 *   軸向格的弧刻度：「影像上畫弧刻度」開／關 → 射束藍色像素差 ≥ 100
 *   3D 射束：「3D 顯示射束」開／關 → 3D 圖重畫、射束藍色＋開口黃色像素差 ≥ 50
 *   BEV 拖到 CP 61 → 小 BEV 的標題跟著變
 *   英文模式沒有中文
 *
 * 需要一個開著量測病例（`.rtgaia/perf/case.json`，要有 RTPLAN）的堆疊（伺服器要有 VTK）：
 *   scripts/perf/stack.sh start && scripts/perf/stack.sh load
 *   node scripts/verify-plan-beams3d.mjs --url http://127.0.0.1:5183/#/viewer [--out-dir DIR]
 * 退出碼：任一步失敗 → 1。
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

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

const profile = mkdtempSync(join(tmpdir(), 'rtgaia-plan23c-'));
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
  await shot('plan23c-failed.png').catch(() => undefined);
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
// 從截圖數顏色（overlay 與 3D 的 <img> 都算）：blue ＝ 射束 1 號色 #6c9cff 附近、yellow ＝ 開口 #ffe066 附近
const colorsIn = async (expr) => {
  const r = await evaluate(`(() => { const b = (${expr}).getBoundingClientRect(); return { x: b.left, y: b.top, width: b.width, height: b.height }; })()`);
  const { data } = await send('Page.captureScreenshot', { format: 'png', clip: { ...r, scale: 1 } });
  return evaluate(`new Promise((resolve) => { const img = new Image(); img.onload = () => { const c = document.createElement('canvas'); c.width = img.width; c.height = img.height; const g = c.getContext('2d'); g.drawImage(img, 0, 0); const d = g.getImageData(0, 0, c.width, c.height).data; let blue = 0, yellow = 0; for (let i = 0; i < d.length; i += 4) { const [r, gg, b] = [d[i], d[i + 1], d[i + 2]]; if (b > 190 && r > 70 && r < 150 && gg > 120 && gg < 190) blue += 1; if (r > 200 && gg > 180 && b < 140) yellow += 1; } resolve({ blue, yellow }); }; img.src = 'data:image/png;base64,${data}'; })`);
};
const checkbox = (label) => `[...document.querySelectorAll('.plan-panel .plan-iso label')].find((l) => l.textContent.includes(${JSON.stringify(label)})).querySelector('input')`;
const view3d = `document.querySelector('.render3d-view')`;
// 3D 的數色只看伺服器出的圖：小 BEV（同色系）先藏起來，數完再放回
const colors3d = async () => {
  await evaluate(`document.querySelectorAll('.render3d-overlay').forEach((e) => { e.style.visibility = 'hidden'; }); true`);
  await sleep(150);
  const c = await colorsIn(`${view3d}.querySelector('.render3d-img')`);
  await evaluate(`document.querySelectorAll('.render3d-overlay').forEach((e) => { e.style.visibility = ''; }); true`);
  return c;
};
const img3dSrc = () => evaluate(`${view3d}?.querySelector('.render3d-img')?.src ?? ''`);

await send('Runtime.enable');
await send('Page.enable');
await send('Emulation.setDeviceMetricsOverride', { width: 1600, height: 1000, deviceScaleFactor: 1, mobile: false });
await send('Page.addScriptToEvaluateOnNewDocument', { source: "try { if (!localStorage.getItem('rtgaia.lang')) localStorage.setItem('rtgaia.lang', 'zh-TW'); localStorage.setItem('rtgaia.tour.v1', 'done'); localStorage.setItem('rtgaia.layout.current.v1', '2x2'); localStorage.removeItem('rtgaia.dock.v1'); localStorage.removeItem('rtgaia.layout.trees.v1'); } catch {}" });
if (token) await send('Network.setCookie', { name: 'rtgaia_session', value: token, url: origin, httpOnly: true });
await send('Page.navigate', { url });
await waitFor(`document.querySelectorAll('.viewport-cell canvas').length >= 3 && !!document.querySelector('.plan-toggle button')`, '病例載入（要有 RTPLAN）');
await waitFor(`!document.querySelector('.mask-loading')`, '載入完', 60000);

// 1. 小 BEV
await waitFor(`!!document.querySelector('.render3d-overlay .mini-bev canvas')`, '3D 格右下角的小 BEV', 60000);
await waitFor(`!!${view3d}?.querySelector('.render3d-img')`, '3D 出圖', 60000);
await sleep(1500);
const miniTitle0 = await evaluate(`document.querySelector('.mini-bev').title`);
step(`小 BEV：${miniTitle0}`);

// 2. 弧刻度開／關
await clickEl(`document.querySelector('.plan-toggle button')`);
await waitFor(`!!document.querySelector('.plan-panel .plan-iso label')`, '計畫面板', 20000);
const axial = `${cellSel('軸向')}.querySelector('.viewport-canvas-host')`;
const arcOn = await colorsIn(axial);
await clickEl(checkbox('弧刻度'));
await sleep(700);
const arcOff = await colorsIn(axial);
await clickEl(checkbox('弧刻度'));
await sleep(700);
if (arcOn.blue - arcOff.blue < 100) throw new Error(`弧刻度開／關的藍色像素差不到 100：開 ${JSON.stringify(arcOn)}、關 ${JSON.stringify(arcOff)}`);
await shot('plan23c-arc.png');
step(`弧刻度：開 ${arcOn.blue}、關 ${arcOff.blue}（藍色像素）`);

// 3. 3D 射束開／關（伺服器重畫一張）
const waitNew3d = async (before, what) => {
  const deadline = Date.now() + 60000;
  while (Date.now() < deadline) {
    const now = await img3dSrc();
    const busy = await evaluate(`${view3d}?.dataset.status`);
    if (now && now !== before && busy !== 'loading') return;
    await sleep(300);
  }
  throw new Error(`等不到 3D 重畫：${what}`);
};
const on3d = await colors3d();
let src = await img3dSrc();
await clickEl(checkbox('3D'));
await waitNew3d(src, '關掉射束');
await sleep(800);
const off3d = await colors3d();
src = await img3dSrc();
await clickEl(checkbox('3D'));
await waitNew3d(src, '打開射束');
await sleep(800);
const back3d = await colors3d();
const gained = back3d.blue + back3d.yellow - (off3d.blue + off3d.yellow);
if (gained < 50) throw new Error(`3D 射束開／關的像素差不到 50：開 ${JSON.stringify(on3d)}／${JSON.stringify(back3d)}、關 ${JSON.stringify(off3d)}`);
if (await evaluate(`!!document.querySelector('.mini-bev')`) === false) throw new Error('打開 3D 射束後小 BEV 要回來');
await shot('plan23c-3d.png');
step(`3D 射束：開 ${JSON.stringify(back3d)}、關 ${JSON.stringify(off3d)}`);

// 4. 小 BEV 跟著 CP
await setValue(`document.querySelector('.plan-bev-embedded .bev-slider')`, 60);
await waitFor(`/CP 61/.test(document.querySelector('.mini-bev')?.title ?? '')`, '小 BEV 跟著 CP 61', 10000);
step(`BEV 拖到 CP 61 → 小 BEV「${await evaluate(`document.querySelector('.mini-bev').title`)}」`);

// 5. 英文模式
await send('Page.navigate', { url: url.replace('/#/', '/?lang=en#/') });
await waitFor(`document.querySelectorAll('.viewport-cell canvas').length >= 3 && !!document.querySelector('.plan-toggle button')`, '英文模式載入');
if (!(await evaluate(`!!document.querySelector('.plan-panel')`))) await evaluate(`document.querySelector('.plan-toggle button').click(); true`);
await waitFor(`!!document.querySelector('.plan-panel .plan-iso label') && !!document.querySelector('.mini-bev')`, '英文模式的計畫面板與小 BEV', 30000);
const enText = await evaluate(`[document.querySelector('.plan-panel .plan-iso').innerText, ...[...document.querySelectorAll('.plan-panel .plan-iso [title], .plan-panel .plan-iso label')].map((e) => e.title || ''), document.querySelector('.mini-bev').title].join(' | ')`);
const cjk = enText.match(/[　-鿿＀-￯]+/g);
if (cjk) throw new Error(`英文模式還有中文：${cjk.join(' ')}`);
step('英文模式：計畫面板的顯示選項與小 BEV 沒有中文');

if (errors.length) throw new Error(`頁面例外：${errors.join(' | ')}`);
console.log('全部通過');
process.exit(0);
