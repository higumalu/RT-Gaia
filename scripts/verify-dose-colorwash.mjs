#!/usr/bin/env node
/**
 * 劑量 colorwash 真的上畫面 —— headless Chrome ＋ CDP（骨架同 `verify-mask-fill.mjs`、零相依）。
 * 2026-09-29 回歸：曾經把 `overlay` band 丟進 blit 之後的分片階段，colorwash 畫了卻永遠不上畫面，只剩等劑量線。
 *
 *   1. 開檢視器（病例要有 RTDOSE）→ 劑量列顯示中、colorwash 勾著
 *   2. 軸向格影像 canvas 上有大量「彩色」像素（CT 是灰階，彩色只可能來自 colorwash）
 *   3. 取消 colorwash → 彩色像素幾乎消失（等劑量線畫在另一層，不算）
 *   4. 勾回 → 彩色像素回來
 *
 * 需要一個開著病例的堆疊，例如：
 *   scripts/perf/stack.sh start && scripts/perf/stack.sh load
 *   node scripts/verify-dose-colorwash.mjs --url http://127.0.0.1:5183/#/viewer [--out-dir DIR] [--token <rtgaia_session>]
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

const profile = mkdtempSync(join(tmpdir(), 'rtgaia-dose-'));
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
  await shot('dose-failed.png').catch(() => undefined);
  throw new Error(`等不到：${what}`);
};
const step = (s) => console.log(`✓ ${s}`);
/** 軸向格影像 canvas 上的彩色像素數（取樣）：灰階 CT 的 r≈g≈b，colorwash 的 jet 色階不是。 */
const colorful = () =>
  evaluate(`(() => {
    const cell = [...document.querySelectorAll('.viewport-cell')].find((c) => c.querySelector('.viewport-label')?.textContent.trim() === '軸向');
    let n = 0;
    for (const c of cell.querySelectorAll('canvas.rt-image-canvas')) {
      const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
      for (let i = 0; i < d.length; i += 4 * 3) if (Math.abs(d[i] - d[i + 1]) + Math.abs(d[i + 1] - d[i + 2]) > 60) n += 1;
    }
    return n;
  })()`);
const setCheck = (label, on) =>
  evaluate(`(() => {
    const row = document.querySelector('.dose-row');
    const lab = [...row.querySelectorAll('label')].find((l) => l.textContent.trim().startsWith(${JSON.stringify(label)}));
    const cb = lab.querySelector('input[type=checkbox]');
    if (cb.checked !== ${on}) cb.click();
    return cb.checked;
  })()`);

await send('Runtime.enable');
await send('Page.enable');
await send('Emulation.setDeviceMetricsOverride', { width: 1600, height: 1000, deviceScaleFactor: 1, mobile: false });
await send('Page.addScriptToEvaluateOnNewDocument', { source: "try { if (!localStorage.getItem('rtgaia.lang')) localStorage.setItem('rtgaia.lang', 'zh-TW'); localStorage.setItem('rtgaia.tour.v1', 'done'); localStorage.setItem('rtgaia.layout.current.v1', '2x2'); localStorage.removeItem('rtgaia.dock.v1'); } catch {}" });
if (token) await send('Network.setCookie', { name: 'rtgaia_session', value: token, url: origin, httpOnly: true });
await send('Page.navigate', { url });
await waitFor(`document.querySelectorAll('.viewport-cell canvas').length >= 3 && !!document.querySelector('.dose-row')`, '病例載入（要先開一個有 RTDOSE 的病例）');
await waitFor(`!document.querySelector('.mask-loading')`, '載入完', 60000);
await sleep(2500);

// 1
if ((await evaluate(`document.querySelector('.dose-row').dataset.visible`)) !== 'true') {
  await evaluate(`document.querySelector('.dose-row input[type=checkbox]').click(); true`);
  await sleep(1500);
}
await setCheck('colorwash', true);
await sleep(1500);
step('劑量列顯示中、colorwash 勾著');

// 2
const on = await colorful();
await shot('dose-on.png');
if (on < 500) throw new Error(`軸向格影像層上應有 colorwash 的彩色像素：只有 ${on} 個（colorwash 沒上畫面？）`);
step(`軸向格影像層有 ${on} 個彩色取樣像素`);

// 3
await setCheck('colorwash', false);
await sleep(1500);
const off = await colorful();
await shot('dose-off.png');
if (off > on * 0.1) throw new Error(`取消 colorwash 後彩色像素應幾乎消失：${on} → ${off}`);
step(`取消 colorwash：${on} → ${off}`);

// 4
await setCheck('colorwash', true);
await sleep(1500);
const again = await colorful();
if (again < on * 0.8) throw new Error(`勾回 colorwash 後彩色像素應回來：${again}（原本 ${on}）`);
step(`勾回 colorwash：${again}`);

if (errors.length > 0) throw new Error(`頁面例外：${errors.join(' | ')}`);
console.log('全部通過');
process.exit(0);
