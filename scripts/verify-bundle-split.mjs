#!/usr/bin/env node
/**
 * 首包不帶少用的頁面與英文字典 —— headless Chrome ＋ CDP（骨架同 `verify-temporal-compose.mjs`）。
 * **要對正式 build 跑**（`vite preview`；dev server 不分包）：
 *
 *   (cd apps/viewer && npm run build && RTGAIA_API=http://127.0.0.1:8091 npx vite preview --port 5190 --strictPort &)
 *   node scripts/verify-bundle-split.mjs --url http://127.0.0.1:5190/#/library
 *
 *   1. 中文開資料頁 → 沒有下載英文字典、說明、管理、暫存區、封存區、匯出紀錄的那幾包
 *   2. 到說明頁 → 這時才下載 HelpPage 那一包，標題「RT-Gaia 使用手冊」
 *   3. 換英文（localStorage）重新整理說明頁 → 下載英文字典、標題「RT-Gaia user guide」（沒有先閃中文：畫出來就是英文）
 *   4. 到管理頁 → 這時才下載 AdminPage 那一包
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
const url = args.url ?? 'http://127.0.0.1:5183/#/library';
const outDir = args['out-dir'] ?? null;
const port = Number(args.port ?? 9347);
const chrome = args.chrome ?? process.env.CHROME ?? 'google-chrome';
const token = args.token ?? process.env.TOKEN ?? null;
const origin = new URL(url).origin;

const profile = mkdtempSync(join(tmpdir(), 'rtgaia-bundle-split-'));
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
  await shot('bundle-split-failed.png').catch(() => undefined);
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
const initScript = await send('Page.addScriptToEvaluateOnNewDocument', { source: "try { if (!localStorage.getItem('rtgaia.lang')) localStorage.setItem('rtgaia.lang', 'zh-TW'); localStorage.setItem('rtgaia.tour.v1', 'done'); localStorage.setItem('rtgaia.layout.current.v1', '2x2'); localStorage.removeItem('rtgaia.dock.v1'); localStorage.removeItem('rtgaia.layout.trees.v1'); } catch {}" });
if (token) await send('Network.setCookie', { name: 'rtgaia_session', value: token, url: origin, httpOnly: true });

const rowWith = (kind, text) => `[...document.querySelectorAll('.catalog-tree tr[data-kind="${kind}"]')].find((r) => r.textContent.includes(${JSON.stringify(text)}))`;
const rowsWith = (kind, text) => `[...document.querySelectorAll('.catalog-tree tr[data-kind="${kind}"]')].filter((r) => r.textContent.includes(${JSON.stringify(text)}))`;
/** 資料頁：清空選取 → 展開病人 → 展開第一個描述含 `study` 的 study。 */
const openStudy = async (patientId, study, { reload = true } = {}) => {
  if (reload) await send('Page.navigate', { url: `${origin}/#/library` });
  else await evaluate(`[...document.querySelectorAll('button')].find((b) => b.textContent.trim() === '資料庫…').click(); true`);
  await waitFor(`!!${rowWith('patient', patientId)}`, `資料頁有 ${patientId}`, 60000);
  await evaluate(`[...document.querySelectorAll('button')].find((b) => b.textContent.trim() === '清空')?.click(); true`);
  await evaluate(`${rowWith('patient', patientId)}.click(); true`);
  await waitFor(`!!${rowWith('study', study)}`, `${patientId} 的 study「${study}」`);
  await evaluate(`${rowWith('study', study)}.click(); true`);
  await waitFor(`!!document.querySelector('.catalog-tree tr[data-kind="image"], .catalog-tree tr[data-kind="temporal"]')`, `${study} 的影像`);
  await sleep(500);
};
const summary = () => evaluate(`document.querySelector('.selection-summary')?.textContent.trim() ?? ''`);
const openCase = async (needTime = false) => {
  // 勾影像要先抓它的 RT 列才進選取（懶載入）→ 等摘要有主要影像再按開啟
  await waitFor(`document.querySelector('.selection-summary')?.textContent.includes('主要影像')`, '選取有主要影像', 20000);
  await evaluate(`[...document.querySelectorAll('button.primary')].find((b) => b.textContent.trim() === '開啟').click(); true`);
  await waitFor(`location.hash.includes('viewer') && document.querySelectorAll('.viewport-cell canvas').length >= 3${needTime ? " && !!document.querySelector('.time-group')" : ''}`, '病例開起來', 180000);
  await waitFor(`!document.querySelector('.mask-loading')`, '結構載入完', 120000);
  await sleep(1500);
};
const pageText = () => evaluate(`document.body.innerText`);
const structureCount = () => evaluate(`document.querySelectorAll('.structure-list li').length`);
/** 資料面板的「▸ 結構（…）」收合時清單不渲染 → 展開。 */
const expandStructures = () => evaluate(`(() => { const h = [...document.querySelectorAll('button, summary, span, div')].find((e) => e.children.length === 0 && /^▸ 結構（/.test(e.textContent.trim())); h?.click(); return !!h; })()`);


const rows = `[...document.querySelectorAll('.frame-group .image-row')]`;
const caseId = () => evaluate(`fetch('/api/v1/sessions/current').then((r) => r.json()).then((s) => s.caseId)`);
const studyId = () => evaluate(`fetch('/api/v1/sessions/current').then((r) => r.json()).then((s) => s.studyId)`);
/** 某一格 canvas 的指紋（取樣像素和）—— 比較兩張畫面是不是同一張。 */
const canvasSum = (label) => evaluate(`(() => { const c = ${cellSel(label)}?.querySelector('canvas'); const x = c?.getContext('2d'); if (!x) return -1; const d = x.getImageData(0, 0, c.width, c.height).data; let s = 0; for (let i = 0; i < d.length; i += 16) s += d[i]; return s; })()`);
const timeText = () => evaluate(`document.querySelector('.time-group .time-text')?.textContent.trim() ?? null`);
const clickButton = (scope, text) => evaluate(`(() => { const b = [...(${scope}).querySelectorAll('button')].find((x) => x.textContent.trim() === ${JSON.stringify(text)}); if (!b) return false; b.click(); return true; })()`);


const assets = [];
await send('Network.enable');
ws.addEventListener('message', (e) => {
  const m = JSON.parse(String(e.data));
  if (m.method === 'Network.requestWillBeSent' && /\/assets\/[^/]+\.js$/.test(m.params.request.url)) assets.push(m.params.request.url.replace(/^.*\/assets\//, ''));
});
const got = (prefix) => assets.some((a) => a.startsWith(`${prefix}-`));
const LAZY = ['en', 'HelpPage', 'AdminPage', 'TrashPage', 'ArchivePage', 'ExportRecordsPage'];

// 1
await evaluate(`localStorage.setItem('rtgaia.lang', 'zh-TW'); true`).catch(() => undefined);
await send('Page.navigate', { url: `${origin}/#/library` });
await waitFor(`location.hash.includes('library') && document.body.innerText.length > 50`, '資料頁', 60000);
await sleep(1500);
const first = LAZY.filter(got);
if (first.length > 0) throw new Error(`首頁就下載了：${first.join(', ')}（${assets.join(', ')}）`);
if (!got('index') || !got('react')) throw new Error(`首包應該有 index 與 react：${assets.join(', ')}`);
step(`中文資料頁：只下載 ${assets.filter((a) => /^(index|react)-/.test(a)).join('、')}，沒有英文字典與少用的頁面`);

// 2
await evaluate(`location.hash = '#/help'; true`);
await waitFor(`document.querySelector('h1')?.textContent.includes('RT-Gaia 使用手冊')`, '說明頁（中文）', 30000);
if (!got('HelpPage')) throw new Error('到說明頁才該下載 HelpPage');
if (got('en')) throw new Error('中文不該下載英文字典');
step('說明頁：這時才下載 HelpPage、標題是中文');

// 3
assets.length = 0;
await evaluate(`localStorage.setItem('rtgaia.lang', 'en'); true`);
await send('Page.reload');
await waitFor(`document.querySelector('h1')?.textContent.includes('RT-Gaia user guide')`, '說明頁（英文）', 30000);
if (!got('en')) throw new Error(`英文要下載英文字典：${assets.join(', ')}`);
step('換英文重新整理：下載英文字典、標題「RT-Gaia user guide」');

// 4
await evaluate(`location.hash = '#/admin'; true`);
await waitFor(`location.hash.includes('admin')`, '管理頁');
for (let i = 0; i < 40 && !got('AdminPage'); i += 1) await sleep(250);
if (!got('AdminPage')) throw new Error('到管理頁才該下載 AdminPage');
step('管理頁：這時才下載 AdminPage');
await evaluate(`localStorage.setItem('rtgaia.lang', 'zh-TW'); true`);

if (errors.length > 0) throw new Error(`頁面例外：${errors.join(' | ')}`);
console.log('全部通過');
process.exit(0);
