#!/usr/bin/env node
/**
 * 容量提醒與完整性巡檢 —— 瀏覽器那一半；由 `scripts/verify-storage.py` 起好暫存堆疊再叫它。
 *
 *   1. 資料頁頂端出現容量提醒（門檻被壓到 50%）；檢視器頁也有
 *   2. 管理 › 服務設定有「儲存空間」：磁碟列、使用率、完整性摘要
 *   3. 按「全部驗一次」→ 已驗數 ＝ 總數、沒有問題
 *   4. （harness 改掉一個檔）再驗一次 → 問題清單出現「內容被改」→ 按「重設基準」→ 清單清空
 *
 *   node scripts/verify-storage.mjs --url http://127.0.0.1:<port>/ --tamper <檔案路徑> [--out-dir DIR]
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

const profile = mkdtempSync(join(tmpdir(), 'rtgaia-storage-'));
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
  await shot('storage-failed.png').catch(() => undefined);
  throw new Error(`等不到：${what}`);
};
const step = (s) => console.log(`✓ ${s}`);
const tamper = args.tamper;
const base = url.replace(/#.*$/, '').replace(/\/$/, '');

await send('Runtime.enable');
await send('Page.enable');
await send('Emulation.setDeviceMetricsOverride', { width: 1500, height: 1000, deviceScaleFactor: 1, mobile: false });
await send('Page.addScriptToEvaluateOnNewDocument', { source: "try { if (!localStorage.getItem('rtgaia.lang')) localStorage.setItem('rtgaia.lang', 'zh-TW'); localStorage.setItem('rtgaia.tour.v1', 'done'); } catch {}" });

// 1
await send('Page.navigate', { url: `${base}/#/library` });
await waitFor(`!!document.querySelector('.storage-banner')`, '資料頁的容量提醒', 30000);
const text = await evaluate(`document.querySelector('.storage-banner').textContent`);
if (!/超過 50% 的提醒門檻/.test(text) || !/不會自動刪除/.test(text)) throw new Error(`提醒文字不對：${text}`);
step(`資料頁頂端提醒：${text.trim()}`);
await shot('storage-banner.png');

// 2
await send('Page.navigate', { url: `${base}/#/admin/service` });
await waitFor(`!!document.querySelector('[data-storage-section] .storage-volumes tbody tr') && document.querySelector('[data-integrity-verified]') !== null`, '儲存空間區塊', 20000);
const rows = await evaluate(`[...document.querySelectorAll('.storage-volumes tbody tr')].map((r) => r.textContent.replace(/\\s+/g, ' ').trim())`);
if (!rows.some((r) => /DICOM 資料庫/.test(r) && /%/.test(r))) throw new Error(`磁碟列不對：${rows}`);
if (!(await evaluate(`!!document.querySelector('.storage-volumes tr.is-warn')`))) throw new Error('超過門檻的那一列要標出來');
step(`儲存空間：${rows.join(' ｜ ')}`);

// 3
const clickText = (t) => evaluate(`(() => { const b = [...document.querySelectorAll('[data-storage-section] button')].find((x) => x.textContent.trim().startsWith(${JSON.stringify(t)})); b.click(); return true; })()`);
await clickText('全部驗一次');
await waitFor(`(() => { const p = document.querySelector('[data-integrity-verified]'); return p && /已驗過 (\\d+) 個/.exec(p.textContent)?.[1] === /資料庫 (\\d+) 個檔/.exec(p.textContent)?.[1]; })()`, '全部驗過', 30000);
if (!(await evaluate(`!!document.querySelector('[data-storage-section] .ok')`))) throw new Error('全部驗過後應沒有問題');
step(`全部驗一次：${(await evaluate(`document.querySelector('[data-integrity-verified]').textContent`)).trim()}`);

// 4
const { appendFileSync } = await import('node:fs');
appendFileSync(tamper, Buffer.from('x'));
await clickText('全部驗一次');
await waitFor(`!!document.querySelector('.storage-problems tr[data-problem="mismatch"]')`, '問題清單出現「內容被改」', 30000);
step(`改掉 ${tamper.split('/').pop()} → 問題清單：${(await evaluate(`document.querySelector('.storage-problems tbody tr').textContent.replace(/\\s+/g, ' ')`)).slice(0, 120)}`);
await shot('storage-problem.png');
await evaluate(`[...document.querySelectorAll('.storage-problems button')].find((b) => b.textContent.trim() === '重設基準').click(); true`);
await waitFor(`!document.querySelector('.storage-problems') && !!document.querySelector('[data-storage-section] .ok')`, '重設基準後清單清空', 20000);
step('重設基準 → 問題清單清空');

if (errors.length > 0) throw new Error(`頁面例外：${errors.join(' | ')}`);
console.log('全部通過');
process.exit(0);
