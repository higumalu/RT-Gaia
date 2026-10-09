#!/usr/bin/env node
/**
 * 3D 反向 pick —— headless Chrome ＋ CDP（骨架同 `verify-mask-fill.mjs`、零相依）：
 *
 *   1. 開檢視器（要有病例）→ 2×2 版面的 3D 格出圖
 *   2. 雙擊 3D 畫面中央（前方視角 ＝ 病人前側皮膚）→ 提示「十字線移到 (…)」、冠狀格的切片號變了（十字線往前移到皮膚）
 *   3. 雙擊 3D 畫面的黑邊外（出圖影像以外）→ 什麼都不發生；雙擊影像內的空氣 → 「那裡沒有打到東西」
 *
 * 需要一個開著病例的堆疊，例如：
 *   scripts/perf/stack.sh start && scripts/perf/stack.sh load
 *   node scripts/verify-3d-pick.mjs --url http://127.0.0.1:5183/#/viewer [--out-dir DIR] [--token <rtgaia_session>]
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
const LAYOUT_KEYS = ['rtgaia.layout.trees.v1', 'rtgaia.layout.overrides.v1'];
const remotePrefs = async () =>
  (await (await fetch(`${origin}/api/v1/auth/me/preferences`, { headers: { authorization: `Bearer ${token}` } })).json()).preferences;

const profile = mkdtempSync(join(tmpdir(), 'rtgaia-pick3d-'));
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
  await shot('pick3d-failed.png').catch(() => undefined);
  throw new Error(`等不到：${what}`);
};
const step = (s) => console.log(`✓ ${s}`);
const mouse = (type, x, y, clickCount) => send('Input.dispatchMouseEvent', { type, x, y, button: 'left', buttons: type === 'mousePressed' ? 1 : 0, clickCount });
const dbl = async (x, y) => {
  await mouse('mouseMoved', x, y, 0);
  await mouse('mousePressed', x, y, 1);
  await mouse('mouseReleased', x, y, 1);
  await mouse('mousePressed', x, y, 2);
  await mouse('mouseReleased', x, y, 2);
};
const slices = () => evaluate(`Object.fromEntries([...document.querySelectorAll('.viewport-cell')].map((c) => [c.querySelector('.viewport-label')?.textContent.trim(), c.querySelector('.viewport-slice')?.textContent.trim()]))`);
const imgRect = () => evaluate(`(() => { const i = document.querySelector('.render3d-img'); if (!i || !i.naturalWidth) return null; const r = i.getBoundingClientRect(); const s = Math.min(r.width / i.naturalWidth, r.height / i.naturalHeight); return { left: r.left, top: r.top, width: r.width, height: r.height, cw: i.naturalWidth * s, ch: i.naturalHeight * s }; })()`);
const note = () => evaluate(`document.querySelector('.render3d-pick-note')?.textContent ?? ''`);

await send('Runtime.enable');
await send('Page.enable');
await send('Emulation.setDeviceMetricsOverride', { width: 1600, height: 1000, deviceScaleFactor: 1, mobile: false });
await send('Page.addScriptToEvaluateOnNewDocument', { source: "try { if (!localStorage.getItem('rtgaia.lang')) localStorage.setItem('rtgaia.lang', 'zh-TW'); localStorage.setItem('rtgaia.tour.v1', 'done'); localStorage.setItem('rtgaia.layout.current.v1', '2x2'); localStorage.removeItem('rtgaia.layout.trees.v1'); } catch {}" });
if (token) await send('Network.setCookie', { name: 'rtgaia_session', value: token, url: origin, httpOnly: true });
await send('Page.navigate', { url });
await waitFor(`document.querySelectorAll('.viewport-cell canvas').length >= 3`, '病例載入（要先開一個病例）');
await waitFor(`(() => { const i = document.querySelector('.render3d-img'); return !!i && i.naturalWidth > 100 && document.querySelector('.render3d-view')?.dataset.status === 'idle'; })()`, '3D 格出圖', 90000);
await sleep(1500);
const r = await imgRect();
step(`3D 出圖 ${Math.round(r.cw)}×${Math.round(r.ch)} px`);

// 2
const before = await slices();
await dbl(r.left + r.width / 2, r.top + r.height / 2);
await waitFor(`/十字線移到/.test(document.querySelector('.render3d-pick-note')?.textContent ?? '')`, '點到東西、十字線移過去', 20000);
await sleep(800);
const after = await slices();
if (after['冠狀'] === before['冠狀']) throw new Error(`冠狀格切片號應該變（十字線移到前側皮膚）：${before['冠狀']} → ${after['冠狀']}`);
step(`雙擊 3D 中央：${await note()}；冠狀切片 ${before['冠狀']} → ${after['冠狀']}`);
await shot('pick3d-hit.png');

// 3
await sleep(2800);
const ox = r.left + (r.width - r.cw) / 2;
const oy = r.top + (r.height - r.ch) / 2;
await dbl(ox + 6, oy + 6); // 影像內、左上角 ＝ 空氣
await waitFor(`/沒有打到/.test(document.querySelector('.render3d-pick-note')?.textContent ?? '')`, '空氣裡沒打到東西', 20000);
const unchanged = await slices();
if (unchanged['冠狀'] !== after['冠狀']) throw new Error('沒打到東西時十字線不該動');
step('雙擊影像角落的空氣：「那裡沒有打到東西」，十字線不動');

if (errors.length > 0) throw new Error(`頁面例外：${errors.join(' | ')}`);
console.log('全部通過');
process.exit(0);
