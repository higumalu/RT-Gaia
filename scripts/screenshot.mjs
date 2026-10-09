#!/usr/bin/env node
/**
 * 用 headless Chrome ＋ CDP 對 viewer 截圖 —— 驗收多序列疊合、劑量顯示等「看得見才算」的東西。
 *
 * 用法：
 *   node scripts/screenshot.mjs --url http://127.0.0.1:5183/ --out shot.png \
 *     [--wait-ms 20000] [--until "JS 表達式（回 true 才截）"] [--eval "截圖前執行的 JS"] \
 *     [--width 1600 --height 1000] [--console]
 *
 * 與 `--screenshot --virtual-time-budget` 的差別：那個會在虛擬時間用完時**中止進行中的
 * fetch**（畫面上出現「Failed to fetch」），這裡等的是真時間與你給的條件。
 * 零相依：Node ≥ 22 有全域 WebSocket。
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
const url = args.url ?? 'http://127.0.0.1:5173/';
const out = args.out ?? 'screenshot.png';
const waitMs = Number(args['wait-ms'] ?? 15000);
const width = Number(args.width ?? 1600);
const height = Number(args.height ?? 1000);
const port = Number(args.port ?? 9333);
const chrome = args.chrome ?? process.env.CHROME ?? 'google-chrome';

const profile = mkdtempSync(join(tmpdir(), 'rtgaia-shot-'));
const proc = spawn(
  chrome,
  [
    '--headless=new',
    '--no-sandbox',
    '--password-store=basic',
    '--disable-gpu',
    '--hide-scrollbars',
    `--window-size=${width},${height}`,
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profile}`,
    'about:blank',
  ],
  { stdio: 'ignore' },
);
const cleanup = () => {
  try {
    proc.kill('SIGKILL');
  } catch {
    /* already gone */
  }
};
process.on('exit', cleanup);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let targets = null;
for (let i = 0; i < 100 && targets === null; i += 1) {
  try {
    targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  } catch {
    await sleep(100);
  }
}
if (targets === null) throw new Error('Chrome 沒有起來（remote debugging 連不上）');
const page = targets.find((t) => t.type === 'page') ?? targets[0];
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  ws.onopen = resolve;
  ws.onerror = reject;
});

let seq = 0;
const pending = new Map();
const consoleLines = [];
ws.onmessage = (event) => {
  const msg = JSON.parse(String(event.data));
  if (msg.id !== undefined && pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id);
    pending.delete(msg.id);
    if (msg.error) reject(new Error(msg.error.message));
    else resolve(msg.result);
  } else if (msg.method === 'Runtime.consoleAPICalled') {
    consoleLines.push(`[${msg.params.type}] ${msg.params.args.map((a) => a.value ?? a.description ?? '').join(' ')}`);
  } else if (msg.method === 'Runtime.exceptionThrown') {
    consoleLines.push(`[exception] ${msg.params.exceptionDetails.text} ${msg.params.exceptionDetails.exception?.description ?? ''}`);
  } else if (msg.method === 'Network.requestWillBeSent') {
    requestUrls.set(msg.params.requestId, msg.params.request.url);
    if (args.trace === 'true' && msg.params.request.url.includes('/api/')) {
      consoleLines.push(`[net-start ${(performance.now() / 1000).toFixed(1)}s] ${msg.params.request.url.split('/api/v1/')[1]?.slice(0, 90)}`);
    }
  } else if (msg.method === 'Network.loadingFinished' && args.trace === 'true') {
    const u = requestUrls.get(msg.params.requestId) ?? '';
    if (u.includes('/api/')) consoleLines.push(`[net-done  ${(performance.now() / 1000).toFixed(1)}s] ${u.split('/api/v1/')[1]?.slice(0, 90)} ${msg.params.encodedDataLength}B`);
  } else if (msg.method === 'Page.frameStartedLoading' || msg.method === 'Page.frameNavigated') {
    consoleLines.push(`[page ${(performance.now() / 1000).toFixed(1)}s] ${msg.method} ${msg.params.frame?.url ?? ''}`);
  } else if (msg.method === 'Network.loadingFailed') {
    // 「Failed to fetch」在 JS 端只有這一句；真正的原因（net::ERR_…）只有這裡看得到
    consoleLines.push(`[net-failed ${(performance.now() / 1000).toFixed(1)}s] ${msg.params.errorText} ${msg.params.canceled ? '(canceled)' : ''} ${requestUrls.get(msg.params.requestId) ?? ''}`);
  }
};
const requestUrls = new Map();
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

await send('Runtime.enable');
await send('Page.enable');
await send('Network.enable');
await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
// `--init "JS"`：在頁面任何腳本之前執行（例如包住 fetch 記錄呼叫）
if (args.init) await send('Page.addScriptToEvaluateOnNewDocument', { source: args.init });
await send('Page.navigate', { url });

const deadline = Date.now() + waitMs;
if (args.until) {
  let ok = false;
  while (Date.now() < deadline) {
    try {
      ok = Boolean(await evaluate(args.until));
    } catch {
      ok = false;
    }
    if (ok) break;
    await sleep(250);
  }
  if (!ok) console.error(`⚠️ 等待條件在 ${waitMs} ms 內沒有成立：${args.until}`);
} else {
  await sleep(waitMs);
}
if (args.eval) {
  await evaluate(args.eval);
  await sleep(Number(args['settle-ms'] ?? 1500));
}
// `--dump "JS"`：截圖前把這個表達式的值印出來（診斷用）
if (args.dump) console.log('[dump]', JSON.stringify(await evaluate(args.dump), null, 1).slice(0, 4000));
const shot = await send('Page.captureScreenshot', { format: 'png' });
writeFileSync(out, Buffer.from(shot.data, 'base64'));
console.log(`寫出 ${out}`);
if (args.console === 'true') for (const line of consoleLines) console.log(line);
const errors = consoleLines.filter(
  (l) => l.startsWith('[error]') || l.startsWith('[exception]') || l.startsWith('[net-failed]'),
);
if (errors.length > 0) {
  console.error(`⚠️ 頁面有 ${errors.length} 則錯誤：`);
  for (const line of errors.slice(0, 10)) console.error('  ' + line);
}
ws.close();
cleanup();
process.exit(0);
