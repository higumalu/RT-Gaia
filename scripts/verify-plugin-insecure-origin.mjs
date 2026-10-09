#!/usr/bin/env node
/**
 * Plugin UI 在**非安全環境**載得起來（曾經在區網 IP 下 nnU-Net plugin 整個載不起來）—— headless Chrome ＋ CDP。
 *
 * 以區網 IP 走 http 開檢視器（`http://192.168.x.x:5173`）：那不是安全環境，`crypto.subtle` 不存在，
 * bundle digest 驗證丟例外 → plugin 被標成載入失敗、面板出不來；在 localhost 上測永遠看不到。這支腳本：
 *   1. 確認頁面真的是非安全環境（`isSecureContext === false`、沒有 `crypto.subtle`）—— 否則測的不是這件事，直接失敗
 *   2. Plugins 選單裡每個有 UI 的 plugin 都沒有失敗原因；打開第一個 → 它的面板出現、面板內容向 plugin 端點取過資料
 *
 * 需要一個以區網 IP 可連的檢視器（vite 綁 0.0.0.0）＋已登錄 plugin 的後端，例如：
 *   scripts/perf/stack.sh start && scripts/perf/stack.sh load
 *   curl -X POST -H 'content-type: application/json' -d '{"endpoint":"http://127.0.0.1:8702","token":""}' http://127.0.0.1:8091/api/v1/plugins
 *   (cd apps/viewer && RTGAIA_API=http://127.0.0.1:8091 npx vite --host 0.0.0.0 --port 5191)
 *   node scripts/verify-plugin-insecure-origin.mjs --url http://$(hostname -I | cut -d' ' -f1):5191/#/viewer
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

const profile = mkdtempSync(join(tmpdir(), 'rtgaia-insecure-'));
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
  await shot('insecure-failed.png').catch(() => undefined);
  throw new Error(`等不到：${what}`);
};
const step = (s) => console.log(`✓ ${s}`);

await send('Runtime.enable');
await send('Page.enable');
await send('Emulation.setDeviceMetricsOverride', { width: 1600, height: 1000, deviceScaleFactor: 1, mobile: false });
await send('Page.addScriptToEvaluateOnNewDocument', { source: "try { if (!localStorage.getItem('rtgaia.lang')) localStorage.setItem('rtgaia.lang', 'zh-TW'); localStorage.setItem('rtgaia.tour.v1', 'done'); } catch {}" });
if (token) await send('Network.setCookie', { name: 'rtgaia_session', value: token, url: origin, httpOnly: true });
await send('Page.navigate', { url });
await waitFor(`document.querySelectorAll('.viewport-cell canvas').length >= 3 && !!document.querySelector('.plugins-menu .task-toggle')`, '檢視器載入（要先開一個病例、登錄 plugin）');
await sleep(1500);

// 1
const ctx = await evaluate(`({ secure: window.isSecureContext, subtle: !!(window.crypto && window.crypto.subtle), origin: location.origin })`);
if (ctx.secure || ctx.subtle) throw new Error(`這個網址是安全環境（${ctx.origin}），測不到問題；請用區網 IP 走 http 開`);
step(`非安全環境：${ctx.origin}（isSecureContext=false、沒有 crypto.subtle）`);

// 2
await evaluate(`document.querySelector('.plugins-menu .task-toggle').click(); true`);
await waitFor(`document.querySelectorAll('.plugins-dropdown [role=menuitemcheckbox]').length > 0`, 'Plugins 選單有 plugin', 10000);
const items = await evaluate(`[...document.querySelectorAll('.plugins-dropdown [role=menuitemcheckbox]')].map((b) => ({ text: b.textContent.trim(), disabled: b.disabled, reason: b.querySelector('small')?.textContent.trim() ?? '' }))`);
const failed = items.filter((i) => /失敗|digest|failed/i.test(i.reason) || i.disabled);
if (failed.length > 0) throw new Error(`plugin 載入失敗：${JSON.stringify(failed)}`);
const before = await evaluate(`document.querySelectorAll('.dock-item').length`);
await evaluate(`document.querySelector('.plugins-dropdown [role=menuitemcheckbox]').click(); true`);
await waitFor(`document.querySelectorAll('.dock-item').length > ${before}`, 'plugin 的面板出現', 15000);
await sleep(2500);
const panel = await evaluate(`(() => { const d = [...document.querySelectorAll('.dock-item')].at(-1); return { title: d.querySelector('.dock-title')?.textContent.trim(), chars: d.textContent.trim().length, err: /載入失敗|digest/.test(d.textContent) }; })()`);
await shot('insecure-plugin.png');
if (panel.err || panel.chars < 80) throw new Error(`plugin 面板沒有正常顯示：${JSON.stringify(panel)}`);
step(`Plugins 選單 ${items.length} 個都沒有失敗原因；打開「${items[0].text}」→ 面板「${panel.title}」（${panel.chars} 字）`);

if (errors.length > 0) throw new Error(`頁面例外：${errors.join(' | ')}`);
console.log('全部通過');
process.exit(0);
