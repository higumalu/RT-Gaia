#!/usr/bin/env node
/**
 * 3D 補完 —— headless Chrome ＋ CDP 真的操作一次（與 `screenshot.mjs` 同一套骨架、零相依）：
 *
 *   1. 開檢視器（要有病例）→ 工具列「3D」→ 勾「裁切範圍」→「中心 ⅛」
 *   2. 找一格的角把手（`.rt-box-handle.corner`）拖 (+40, +30) px → 右側面板三軸範圍：恰好兩軸變（法線軸不動）
 *   3. 同一格的邊把手（`.rt-box-handle.edge`）拖 → 恰好一軸變
 *   4. 拖曳中不發 `render3d`（只動本地草稿），放手後才重畫
 *   5. 3D 格「匯出 PNG」→ 真的下載一個 PNG，邊長大於格子裡那張（另出高解析度）
 *
 * 需要一個開著病例的堆疊，例如：
 *   scripts/perf/stack.sh start && scripts/perf/stack.sh load
 *   node scripts/verify-render3d.mjs --url http://127.0.0.1:5183/#/viewer [--out-dir DIR]
 * 退出碼：任一步失敗 → 1。
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
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
const port = Number(args.port ?? 9336);
const chrome = args.chrome ?? process.env.CHROME ?? 'google-chrome';

const profile = mkdtempSync(join(tmpdir(), 'rtgaia-render3d-'));
const downloads = mkdtempSync(join(tmpdir(), 'rtgaia-render3d-dl-'));
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
let render3dRequests = 0;
ws.onmessage = (event) => {
  const msg = JSON.parse(String(event.data));
  if (msg.id !== undefined && pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id);
    pending.delete(msg.id);
    if (msg.error) reject(new Error(msg.error.message));
    else resolve(msg.result);
  } else if (msg.method === 'Runtime.exceptionThrown') {
    errors.push(msg.params.exceptionDetails.exception?.description ?? msg.params.exceptionDetails.text);
  } else if (msg.method === 'Network.requestWillBeSent' && msg.params.request.url.endsWith('/render3d')) {
    render3dRequests += 1;
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
  await shot('crop-failed.png').catch(() => undefined);
  throw new Error(`等不到：${what}`);
};
const clickText = (selector, text) =>
  evaluate(`(() => {
    const el = [...document.querySelectorAll(${JSON.stringify(selector)})].find((x) => x.textContent.trim().startsWith(${JSON.stringify(text)}));
    if (!el) throw new Error('找不到 ' + ${JSON.stringify(text)});
    el.click();
    return true;
  })()`);
/** 三軸的範圍文字（`-120 ～ 80 mm`）。 */
const ranges = () => evaluate(`[...document.querySelectorAll('.render3d-crop-axis .render3d-range')].map((e) => e.textContent.replace(/\\s+/g, ' ').trim())`);
/** 同一格（第一個有把手的 SVG）裡某種把手的中心（CSS px）。 */
const handleAt = (kind, index) =>
  evaluate(`(() => {
    const all = [...document.querySelectorAll('.rt-box-handle.${kind}')];
    if (all.length === 0) return null;
    const svg = all[0].ownerSVGElement;
    const mine = all.filter((h) => h.ownerSVGElement === svg);
    const r = mine[${index} % mine.length].getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2, count: mine.length };
  })()`);
const drag = async (from, dx, dy) => {
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: from.x, y: from.y });
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: from.x, y: from.y, button: 'left', buttons: 1, clickCount: 1 });
  const before = render3dRequests;
  for (let k = 1; k <= 8; k += 1) {
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: from.x + (dx * k) / 8, y: from.y + (dy * k) / 8, button: 'left', buttons: 1 });
    await sleep(40);
  }
  const duringDrag = render3dRequests - before;
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: from.x + dx, y: from.y + dy, button: 'left', buttons: 0, clickCount: 1 });
  await sleep(600);
  return duringDrag;
};
const changedAxes = (a, b) => a.map((v, i) => (v !== b[i] ? i : -1)).filter((i) => i >= 0);
const step = (s) => console.log(`✓ ${s}`);

await send('Runtime.enable');
await send('Page.enable');
await send('Network.enable');
await send('Emulation.setDeviceMetricsOverride', { width: 1600, height: 1000, deviceScaleFactor: 1, mobile: false });
await send('Page.addScriptToEvaluateOnNewDocument', { source: "try { if (!localStorage.getItem('rtgaia.lang')) localStorage.setItem('rtgaia.lang', 'zh-TW'); localStorage.setItem('rtgaia.tour.v1', 'done') } catch {}" });
await send('Page.navigate', { url });
await waitFor(`/結構（[1-9]/.test(document.body.innerText) && !!document.querySelector('.render3d-toggle button')`, '病例載入（要先開一個病例）');
await clickText('.render3d-toggle button', '3D');
await waitFor(`[...document.querySelectorAll('label')].some((l) => l.textContent.trim() === '裁切範圍')`, '3D 設定面板');
const cropBox = `[...document.querySelectorAll('label')].find((l) => l.textContent.trim() === '裁切範圍').querySelector('input')`;
await waitFor(`!${cropBox}.disabled`, '裁切勾選可用（影像包圍盒）');
await evaluate(`${cropBox}.click(); true`);
await waitFor(`[...document.querySelectorAll('button')].some((b) => b.textContent.trim() === '中心 ⅛')`, '裁切快速鈕');
await clickText('button', '中心 ⅛');
await waitFor(`document.querySelectorAll('.rt-box-handle.corner').length >= 4`, '2D 上的方框把手');
const r0 = await ranges();
step(`方框把手出現；範圍 ${r0.join(' / ')}`);
await shot('crop-before.png');

// 「中心 ⅛」本身會觸發一次 3D 重畫；等它結束再拖，否則那一次請求會被算成「拖曳中發的」
await waitFor(`!document.querySelector('.render3d-status') || !/更新中|Updating|建立 3D/.test(document.querySelector('.render3d-status').textContent)`, '3D 重畫結束', 90000);
await sleep(800);
const corner = await handleAt('corner', 0);
const during1 = await drag(corner, 40, 30);
const r1 = await ranges();
const c1 = changedAxes(r0, r1);
if (c1.length !== 2) throw new Error(`拖角應該恰好兩軸變：${r0.join(' / ')} → ${r1.join(' / ')}`);
if (during1 !== 0) throw new Error(`拖曳中不該發 render3d（發了 ${during1} 次）`);
step(`拖角：兩軸變（${c1.join('、')}），拖曳中 render3d 0 次；${r1.join(' / ')}`);
await shot('crop-corner.png');

const edge = await handleAt('edge', 1);
await drag(edge, 25, 25);
const r2 = await ranges();
const c2 = changedAxes(r1, r2);
if (c2.length !== 1) throw new Error(`拖邊應該恰好一軸變：${r1.join(' / ')} → ${r2.join(' / ')}`);
step(`拖邊：一軸變（${c2.join('、')}）；${r2.join(' / ')}`);
await shot('crop-edge.png');

await send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: downloads });
await waitFor(`[...document.querySelectorAll('.render3d-bar button')].some((b) => b.textContent.trim() === '匯出 PNG' && !b.disabled)`, '「匯出 PNG」可按（3D 已出圖）', 90000);
const shownPx = await evaluate(`document.querySelector('.render3d-img').naturalWidth`);
await clickText('.render3d-bar button', '匯出 PNG');
const deadline = Date.now() + 60000;
let file = null;
while (Date.now() < deadline && file === null) {
  file = readdirSync(downloads).find((f) => f.endsWith('.png')) ?? null;
  await sleep(300);
}
if (file === null) throw new Error('沒有下載到 PNG');
const png = readFileSync(join(downloads, file));
const width = png.readUInt32BE(16);
if (png.subarray(1, 4).toString() !== 'PNG' || !/^rtgaia-3d-\d{8}-\d{4}\.png$/.test(file)) throw new Error(`下載的不是預期的 PNG：${file}`);
if (width <= shownPx) throw new Error(`匯出應比格子裡那張大：${width} ≤ ${shownPx}`);
step(`匯出 PNG：${file} ${width}px（格子裡 ${shownPx}px）`);

if (errors.length > 0) throw new Error(`頁面例外：${errors.join(' | ')}`);
console.log('全部通過');
process.exit(0);
