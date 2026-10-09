#!/usr/bin/env node
/**
 * 切片捲軸（2026-09-29）—— headless Chrome ＋ CDP（骨架同 `verify-mask-fill.mjs`、零相依），用真的滑鼠／滾輪／鍵盤事件：
 *
 *   1. 開檢視器（要有病例）→ 三個 2D 格右緣都有捲軸、3D 格沒有；canvas 讓出捲軸寬度（不蓋影像）
 *   2. 軸向：點捲軸頂端 → 頭側那一張、切片標示與影像都變了，捲軸提示跟標示同一句
 *   3. 從頂端拖到底端 → 一路單調往後、停在最後一張
 *   4. 滾輪在捲軸上往上三格 → 少三張
 *   5. 鍵盤：PageUp 少十張、↓ 多一張、Home 回第一張、End 到最後一張
 *   6. 反過來：在影像上用滾輪換張，捲軸的位置跟著動
 *
 * 需要一個開著病例的堆疊，例如：
 *   scripts/perf/stack.sh start && scripts/perf/stack.sh load
 *   node scripts/verify-slice-bar.mjs --url http://127.0.0.1:5183/#/viewer [--out-dir DIR] [--token <rtgaia_session>]
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
const port = Number(args.port ?? 9337);
const chrome = args.chrome ?? process.env.CHROME ?? 'google-chrome';
const token = args.token ?? process.env.TOKEN ?? null;
const origin = new URL(url).origin;

const profile = mkdtempSync(join(tmpdir(), 'rtgaia-slicebar-'));
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
  await shot('slicebar-failed.png').catch(() => undefined);
  throw new Error(`等不到：${what}`);
};
const step = (s) => console.log(`✓ ${s}`);
const cellSel = (label) => `[...document.querySelectorAll('.viewport-cell')].find((c) => c.querySelector('.viewport-label')?.textContent.trim() === ${JSON.stringify(label)})`;
/** 某一格的捲軸狀態：aria 值、捲軸在頁面上的矩形、切片標示。 */
const bar = (label) =>
  evaluate(`(() => {
    const cell = ${cellSel(label)};
    const b = cell?.querySelector('.viewport-slicebar');
    if (!b) return null;
    const r = b.getBoundingClientRect();
    return { now: Number(b.getAttribute('aria-valuenow')), max: Number(b.getAttribute('aria-valuemax')), x: r.left + r.width / 2, top: r.top, bottom: r.bottom, width: r.width,
      label: cell.querySelector('.viewport-slice')?.textContent.trim() ?? '', title: b.getAttribute('title') ?? '' };
  })()`);
/** 某一格影像 canvas 的取樣指紋。 */
const pixels = (label) =>
  evaluate(`(() => {
    const c = ${cellSel(label)}.querySelector('canvas.rt-image-canvas');
    const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
    const out = [];
    for (let i = 0; i < d.length; i += 4 * 97) out.push(d[i]);
    return out;
  })()`);
const differs = (a, b) => a.filter((v, i) => Math.abs(v - b[i]) > 8).length;
const mouse = (type, x, y, extra = {}) => send('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1, ...extra });
const key = async (k, code) => {
  await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: k, code: code ?? k, windowsVirtualKeyCode: { PageUp: 33, PageDown: 34, End: 35, Home: 36, ArrowUp: 38, ArrowDown: 40 }[k] });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: k, code: code ?? k });
  await sleep(250);
};

await send('Runtime.enable');
await send('Page.enable');
await send('Emulation.setDeviceMetricsOverride', { width: 1600, height: 1000, deviceScaleFactor: 1, mobile: false });
await send('Page.addScriptToEvaluateOnNewDocument', { source: "try { if (!localStorage.getItem('rtgaia.lang')) localStorage.setItem('rtgaia.lang', 'zh-TW'); localStorage.setItem('rtgaia.tour.v1', 'done'); localStorage.setItem('rtgaia.layout.current.v1', '2x2'); localStorage.removeItem('rtgaia.dock.v1'); localStorage.removeItem('rtgaia.layout.trees.v1'); } catch {}" });
if (token) await send('Network.setCookie', { name: 'rtgaia_session', value: token, url: origin, httpOnly: true });
await send('Page.navigate', { url });
await waitFor(`document.querySelectorAll('.viewport-slicebar').length >= 3`, '病例載入、2D 格出現捲軸（要先開一個病例）');
await waitFor(`!document.querySelector('.mask-loading')`, '載入完', 60000);
await sleep(2000);

// 1
const labels = ['軸向', '冠狀', '矢狀'];
for (const l of labels) {
  const b = await bar(l);
  if (b === null || !(b.max > 1)) throw new Error(`${l} 格沒有捲軸或張數不對：${JSON.stringify(b)}`);
}
const bars3d = await evaluate(`[...document.querySelectorAll('.viewport-cell')].filter((c) => !['軸向','冠狀','矢狀'].includes(c.querySelector('.viewport-label')?.textContent.trim())).filter((c) => c.querySelector('.viewport-slicebar')).length`);
if (bars3d !== 0) throw new Error(`3D／面板格不該有捲軸：${bars3d}`);
const geom = await evaluate(`(() => { const v = ${cellSel('軸向')}.querySelector('.viewport'); const h = v.querySelector('.viewport-canvas-host'); const b = v.querySelector('.viewport-slicebar');
  return { host: h.getBoundingClientRect().right, bar: b.getBoundingClientRect().left }; })()`);
if (geom.host > geom.bar + 1) throw new Error(`canvas 蓋到捲軸：canvas 右緣 ${geom.host}、捲軸左緣 ${geom.bar}`);
const ax0 = await bar('軸向');
step(`三個 2D 格都有捲軸（軸向 ${ax0.max} 張、冠狀 ${(await bar('冠狀')).max}、矢狀 ${(await bar('矢狀')).max}），3D 格沒有；canvas 讓出 ${ax0.width.toFixed(0)} px`);

// 2
const pxBefore = await pixels('軸向');
await mouse('mousePressed', ax0.x, ax0.top + 2);
await mouse('mouseReleased', ax0.x, ax0.top + 2);
await sleep(900);
const top = await bar('軸向');
if (top.now !== 1) throw new Error(`點捲軸頂端應到第 1 張：${top.now}`);
if (top.label === ax0.label) throw new Error(`切片標示沒變：${top.label}`);
// 捲軸的提示跟右上角標示同一句（捲軸方向跟滾輪一致、標示是網格索引，兩者方向可能相反 —— 不能各說各的）
if (!top.title.includes(top.label)) throw new Error(`捲軸提示應與切片標示一致：提示「${top.title}」、標示「${top.label}」`);
if (differs(pxBefore, await pixels('軸向')) < 20) throw new Error('點捲軸後軸向影像沒變');
await shot('slicebar-top.png');
step(`點頂端：${ax0.now} → 1（標示 ${ax0.label} → ${top.label}），影像變了`);


// 3
await mouse('mousePressed', top.x, top.top + 9);
const seen = [];
const n = 12;
for (let i = 1; i <= n; i += 1) {
  await mouse('mouseMoved', top.x, top.top + 9 + ((top.bottom - top.top - 9) * i) / n);
  await sleep(120);
  seen.push((await bar('軸向')).now);
}
await mouse('mouseReleased', top.x, top.bottom - 1);
await sleep(900);
const end = await bar('軸向');
const monotonic = seen.every((v, i) => i === 0 || v >= seen[i - 1]);
if (!monotonic) throw new Error(`拖曳應單調往後：${seen.join(',')}`);
if (end.now !== end.max) throw new Error(`拖到底應是最後一張：${end.now} / ${end.max}`);
await shot('slicebar-bottom.png');
step(`拖曳：${seen.join('→')}，停在 ${end.now} / ${end.max}`);

// 4
for (let i = 0; i < 3; i += 1) {
  await send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: end.x, y: (end.top + end.bottom) / 2, deltaX: 0, deltaY: -100 });
  await sleep(150);
}
await sleep(500);
const wheeled = await bar('軸向');
if (wheeled.now !== end.max - 3) throw new Error(`捲軸上滾輪往上三格應少三張：${wheeled.now}（原 ${end.max}）`);
step(`捲軸上滾輪往上三格：${end.max} → ${wheeled.now}`);

// 5
const vp = await evaluate(`(() => { const r = ${cellSel('軸向')}.querySelector('.viewport-canvas-host').getBoundingClientRect(); return { x: r.left + 30, y: r.bottom - 60 }; })()`);
await mouse('mousePressed', vp.x, vp.y);
await mouse('mouseReleased', vp.x, vp.y);
await sleep(300);
const k0 = (await bar('軸向')).now;
await key('PageUp');
const k1 = (await bar('軸向')).now;
await key('ArrowDown');
const k2 = (await bar('軸向')).now;
await key('Home');
const k3 = (await bar('軸向')).now;
await key('End');
const k4 = (await bar('軸向')).now;
if (k1 !== k0 - 10 || k2 !== k1 + 1 || k3 !== 1 || k4 !== end.max) throw new Error(`鍵盤：${k0} →PageUp ${k1} →↓ ${k2} →Home ${k3} →End ${k4}`);
step(`鍵盤：${k0} →PageUp ${k1} →↓ ${k2} →Home ${k3} →End ${k4}`);

// 6
const img = await evaluate(`(() => { const r = ${cellSel('軸向')}.querySelector('.viewport-canvas-host').getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
const w0 = (await bar('軸向')).now;
for (let i = 0; i < 2; i += 1) {
  await send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: img.x, y: img.y, deltaX: 0, deltaY: -100 });
  await sleep(150);
}
await sleep(500);
const w1 = (await bar('軸向')).now;
if (w1 !== w0 - 2) throw new Error(`影像上滾輪往上兩格，捲軸應少兩張：${w0} → ${w1}`);
step(`影像上滾輪往上兩格：捲軸 ${w0} → ${w1}`);

if (errors.length > 0) throw new Error(`頁面例外：${errors.join(' | ')}`);
console.log('全部通過');
process.exit(0);
