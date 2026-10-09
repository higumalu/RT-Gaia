#!/usr/bin/env node
/**
 * 地標對與 TG-132 TRE —— headless Chrome ＋ CDP（骨架同 `verify-mask-fill.mjs`、零相依）：
 *
 *   1. 開檢視器（要有帶次要序列＋REG 的病例）→ 開「對位」→ 面板有「地標對（TG-132 TRE）」
 *   2. 十字線不動：記錄固定點、記錄移動點 → 地標 1，TRE 0.00；畫面上有固定點圈與移動點叉
 *   3. 次要序列 x +1 mm → 地標 1 的 TRE 即時變 1.00
 *   4. 軸向格點別處移十字線 → 再記一對（在 +1 mm 下記的）→ 「重設為 REG」後地標 1 回 0.00、地標 2 變 1.00
 *   5. 門檻 0.5 → 「1 對超過門檻」
 *   6. 重新整理 → 兩對從後端回來、TRE 不變
 *   7. 收尾：刪掉
 *
 * 需要一個開著病例（有次要序列）的堆疊，例如：
 *   scripts/perf/stack.sh start && scripts/perf/stack.sh load
 *   node scripts/verify-landmarks.mjs --url http://127.0.0.1:5183/#/viewer [--out-dir DIR] [--token <rtgaia_session>]
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

const profile = mkdtempSync(join(tmpdir(), 'rtgaia-landmark-'));
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
  await shot('landmark-failed.png').catch(() => undefined);
  throw new Error(`等不到：${what}`);
};
const step = (s) => console.log(`✓ ${s}`);
const rows = () => evaluate(`[...document.querySelectorAll('.reg-landmark-table tbody tr')].map((r) => ({ id: r.dataset.measurement, label: r.children[0].textContent.trim(), tre: Number(r.children[1].textContent.trim()) }))`);
const clickButton = (text) =>
  waitFor(`(() => { const b = [...document.querySelectorAll('button')].find((x) => x.textContent.trim() === ${JSON.stringify(text)} || x.textContent.trim().startsWith(${JSON.stringify(text + ' ')})); if (!b || b.disabled) return false; b.click(); return true; })()`, `按鈕 ${text}`, 10000);
const regButton = (text) => evaluate(`(() => { const b = [...document.querySelectorAll('.reg-panel button')].find((x) => x.textContent.trim().startsWith(${JSON.stringify(text)})); if (!b) throw new Error('找不到 ' + ${JSON.stringify(text)}); b.click(); return true; })()`);
const nudgeX = () => evaluate(`(() => { const span = [...document.querySelectorAll('.reg-panel .slab-presets')].find((s) => s.textContent.startsWith('L–R (x)')); [...span.querySelectorAll('button')].find((b) => b.textContent.trim() === '+1').click(); return true; })()`);
const mouse = (type, x, y) => send('Input.dispatchMouseEvent', { type, x, y, button: 'left', buttons: type === 'mousePressed' ? 1 : 0, clickCount: type === 'mouseMoved' ? 0 : 1 });

await send('Runtime.enable');
await send('Page.enable');
await send('Emulation.setDeviceMetricsOverride', { width: 1600, height: 1000, deviceScaleFactor: 1, mobile: false });
await send('Page.addScriptToEvaluateOnNewDocument', { source: "try { if (!localStorage.getItem('rtgaia.lang')) localStorage.setItem('rtgaia.lang', 'zh-TW'); localStorage.setItem('rtgaia.tour.v1', 'done'); localStorage.setItem('rtgaia.layout.current.v1', '2x2'); localStorage.removeItem('rtgaia.dock.v1'); } catch {}" });
if (token) await send('Network.setCookie', { name: 'rtgaia_session', value: token, url: origin, httpOnly: true });
await send('Page.navigate', { url });
await waitFor(`document.querySelectorAll('.viewport-cell canvas').length >= 3 && [...document.querySelectorAll('button')].some((x) => x.textContent.trim() === '對位')`, '病例載入（要先開一個有次要序列的病例）');
await sleep(1000);

// 1
const openReg = async () => {
  for (let i = 0; i < 5 && !(await evaluate(`!!document.querySelector('.reg-landmarks')`)); i += 1) {
    await clickButton('對位');
    await sleep(1200);
  }
  await waitFor(`!!document.querySelector('.reg-landmarks')`, '對位面板的地標區塊', 10000);
};
await openReg();
const start = await rows();
if (start.length !== 0) throw new Error(`這個 FoR 一開始不該有地標對：${JSON.stringify(start)}`);
step('對位面板有「地標對（TG-132 TRE）」');

// 2
await regButton('記錄固定點');
await sleep(200);
await regButton('記錄移動點');
await waitFor(`document.querySelectorAll('.reg-landmark-table tbody tr').length === 1`, '地標 1', 5000);
let r = await rows();
if (!/地標 1/.test(r[0].label) || Math.abs(r[0].tre) > 0.02) throw new Error(`十字線不動記的一對 TRE 應 0：${JSON.stringify(r)}`);
await sleep(500);
const svg = await evaluate(`!!document.querySelector('.rt-landmark-fixed') && !!document.querySelector('.rt-landmark-moving')`);
if (!svg) throw new Error('畫面上應有固定點圈與移動點叉');
step(`${r[0].label}：TRE ${r[0].tre.toFixed(2)} mm；畫面上有固定點與移動點`);

// 3
await nudgeX();
await sleep(500);
r = await rows();
if (Math.abs(r[0].tre - 1) > 0.02) throw new Error(`x +1 mm 後 TRE 應 1.00：${JSON.stringify(r)}`);
step(`次要序列 x +1 mm → ${r[0].label} TRE 即時變 ${r[0].tre.toFixed(2)} mm`);
await shot('landmark-nudged.png');

// 4
const rect = await evaluate(`(() => { const cell = [...document.querySelectorAll('.viewport-cell')].find((c) => c.querySelector('.viewport-label')?.textContent.trim() === '軸向'); const b = cell.querySelector('canvas').getBoundingClientRect(); return { x: b.left + b.width * 0.6, y: b.top + b.height * 0.45 }; })()`);
await mouse('mouseMoved', rect.x, rect.y);
await mouse('mousePressed', rect.x, rect.y);
await mouse('mouseReleased', rect.x, rect.y);
await sleep(500);
await regButton('記錄固定點');
await sleep(200);
await regButton('記錄移動點');
await waitFor(`document.querySelectorAll('.reg-landmark-table tbody tr').length === 2`, '地標 2', 5000);
await regButton('重設為 REG');
await sleep(600);
r = await rows();
if (Math.abs(r[0].tre) > 0.02 || Math.abs(r[1].tre - 1) > 0.02) throw new Error(`重設後地標 1 應 0、地標 2 應 1：${JSON.stringify(r)}`);
step(`再記一對（在 +1 mm 下）→ 重設為 REG：${r.map((x) => `${x.label} ${x.tre.toFixed(2)}`).join('、')} mm`);

// 5
await evaluate(`(() => { const s = document.querySelector('.reg-tre-summary input'); const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; set.call(s, '0.5'); s.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
await sleep(300);
const summary = await evaluate(`document.querySelector('.reg-tre-summary').textContent`);
if (!/2 對/.test(summary) || !/1 對超過門檻/.test(summary)) throw new Error(`摘要不對：${summary}`);
step(`門檻 0.5 mm：${summary.replace(/\s+/g, ' ').trim()}`);

// 6
const before = await rows();
await send('Page.reload');
await waitFor(`document.querySelectorAll('.viewport-cell canvas').length >= 3 && [...document.querySelectorAll('button')].some((x) => x.textContent.trim() === '對位')`, '重新整理後病例');
await sleep(1000);
await openReg();
await waitFor(`document.querySelectorAll('.reg-landmark-table tbody tr').length === 2`, '兩對從後端回來', 15000);
r = await rows();
for (const b of before) {
  const got = r.find((x) => x.id === b.id);
  if (!got || Math.abs(got.tre - b.tre) > 0.02) throw new Error(`重新整理後 ${b.label} 應在且 TRE 不變：${JSON.stringify(r)}`);
}
step('重新整理後兩對從後端回來、TRE 不變');

// 7
for (const x of r) {
  await evaluate(`document.querySelector('.reg-landmark-table tr[data-measurement="${x.id}"] .measure-delete').click(); true`);
  await sleep(300);
}
if ((await rows()).length !== 0) throw new Error('收尾沒刪乾淨');
step('收尾：刪掉');

if (errors.length > 0) throw new Error(`頁面例外：${errors.join(' | ')}`);
console.log('全部通過');
process.exit(0);
